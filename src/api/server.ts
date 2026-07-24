import express from "express"
import cors from "cors"
import type { Server } from "node:http"
import type { RequestHandler } from "express"
import { readFile } from "node:fs/promises"
import { extname, join, resolve } from "node:path"
import type { DB } from "../ingestion/tracking/db"
import { openDb } from "../ingestion/tracking/db"
import { AnswerTraceRepository } from "../answer/trace_repository"
import { loadConfig } from "../config"
import { createProcessRuntime, type ProcessRuntime } from "../runtime/process_runtime"
import { createChatRouter, type AnswerEventsSource } from "./chat"
import ingestRouter, { rawIngestRouter } from "./ingest"
import { createHandoffRouter } from "./handoff"
import { SqliteHandoffStore } from "../answer/handoff_store"
import { createFeedbackRouter } from "./feedback"
import { SqliteFeedbackStore } from "../answer/feedback_store"
import { SqliteSessionBinder } from "../access/session_binder"
import { createAccessMiddleware } from "./access_middleware"
import { DocumentRepo } from "../ingestion/tracking/doc_repo"
import { TaskRepo } from "../ingestion/tracking/task_repo"
import { SqliteSourceLifecycleStore } from "../knowledge/source_lifecycle_store"
import { SqliteCandidateReviewStore } from "../knowledge/candidate_review_store"
import { RetirementServiceImpl } from "../knowledge/retirement"
import { createSourceGovernanceRouter } from "./source_governance"
import { createObservabilityRouter } from "./observability"
import { createStatusRouter } from "./status"

export function createApp(options: {
  db?: DB
  imageAssetPath?: string
  ragasArtifactPath?: string
  accessMiddleware?: RequestHandler
  /**
   * P5.2: Ingestion access middleware. Mounted on /api/ingest routes so the
   * same identity context enforced at the chat gate is also enforced before
   * any ingestion handler runs (closes D-007 debt #3). Only provided in
   * enforced mode; single_tenant mode omits it (ingest handlers ignore
   * res.locals.accessContext, preserving exact pre-P5.2 behavior).
   */
  ingestAccessMiddleware?: RequestHandler
  sessionBinder?: SqliteSessionBinder
  eventsSource: AnswerEventsSource
  // Optional runtime surfaces for the /api/status endpoint.
  // When omitted (e.g. tests), the status route is not mounted.
  processRuntime?: import("../runtime/process_runtime").ProcessRuntime
  config?: import("../config").AppConfig
}) {
  const app = express()
  const db = options.db || openDb()
  const traceRepository = new AnswerTraceRepository(db)
  const handoffStore = new SqliteHandoffStore(db)
  const feedbackStore = new SqliteFeedbackStore(db)
  // Ticket 11 P5: Source governance wiring — DocumentRepo + TaskRepo are
  // shared with the ingestion pipeline (DocumentRepo.activate is reused by
  // CandidateReviewStore; TaskRepo is reused by RetirementService for
  // idempotent cleanup enqueue per spec L1577).
  const documentRepo = new DocumentRepo(db)
  const taskRepo = new TaskRepo(db)
  const sourceLifecycleStore = new SqliteSourceLifecycleStore(db)
  const candidateReviewStore = new SqliteCandidateReviewStore(db, documentRepo)
  const retirementService = new RetirementServiceImpl(db, sourceLifecycleStore, taskRepo)
  const imageAssetPath = resolve(
    options.imageAssetPath ?? process.env.IMAGE_ASSET_PATH ?? "./data/image-assets"
  )
  app.use(cors())
  app.get("/api/assets/:assetPath", async (req, res, next) => {
    const assetPath = String(req.params.assetPath)
    if (!/^[a-f0-9]{64}\.[a-z0-9]{1,10}$/.test(assetPath)) {
      res.sendStatus(404)
      return
    }
    try {
      const bytes = await readFile(join(imageAssetPath, assetPath))
      res.set("Cache-Control", "public, max-age=31536000, immutable")
      res.type(extname(assetPath))
      res.send(bytes)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        res.sendStatus(404)
        return
      }
      next(error)
    }
  })
  // P5.2: mount the ingestion access middleware BEFORE rawIngestRouter +
  // ingestRouter so the identity gate runs for every /api/ingest* route
  // (file, json, url). The middleware reads only the Authorization header,
  // so it is safe before express.json() and before the raw octet-stream
  // body parser. Only mounted when provided (enforced mode); single_tenant
  // omits it, preserving exact pre-P5.2 ingestion behavior.
  if (options.ingestAccessMiddleware) {
    app.use("/api/ingest", options.ingestAccessMiddleware)
  }
  app.use("/api", rawIngestRouter)
  app.use(express.json())
  // Ticket 05 follow-up wiring: mount access middleware (if provided) BEFORE
  // createChatRouter so res.locals.accessContext is populated for the session
  // binder. Only mounted for chat routes — ingest ACL is Ticket 06+ scope.
  if (options.accessMiddleware) {
    app.use("/api/chat", options.accessMiddleware)
    app.use("/api/observability", options.accessMiddleware)
  }
  app.use("/api", createChatRouter(traceRepository, options.eventsSource, options.sessionBinder))
  app.use("/api", createObservabilityRouter({
    ragasArtifactPath: options.ragasArtifactPath,
  }))
  // Ticket 09 P5: mount the Handoff HTTP API (spec §8 L1549-1552).
  // POST /chat/runs/:runId/handoff is covered by the /api/chat access middleware
  // mount above (chat scope) since the path starts with /chat. GET/PATCH /handoffs
  // rely on the in-handler requireReviewOrAdmin check — in single_tenant mode
  // ALL_LOCAL_SCOPES already includes review+admin, so no separate middleware
  // mount is needed. In enforced mode (deferred — IdentityAdapter not yet wired),
  // a future ticket must mount review/admin-scoped access middleware on
  // /api/handoffs to enforce scope before the handler runs.
  app.use("/api", createHandoffRouter(handoffStore))
  // Ticket 09 P6: mount the Feedback HTTP API (spec §8 L1551).
  // PUT /chat/runs/:runId/feedback is covered by the /api/chat access middleware
  // mount above (chat scope) since the path starts with /chat — same as POST
  // /chat/runs/:runId/handoff. No 404 cross-tenant case for PUT (upsert creates
  // if not exists; UNIQUE includes tenant_id+subject_id so each tenant gets its
  // own row). 400 for invalid rating or reason code (InvalidFeedbackReasonCodeError).
  app.use("/api", createFeedbackRouter(feedbackStore))
  // Ticket 11 P5: mount the Source governance HTTP API (spec §11 L1580-1583).
  // Three endpoints:
  //   POST /api/ingest/:docId/review       (review scope — L1580)
  //   POST /api/sources/:sourceId/retire   (admin scope — L1581)
  //   GET  /api/sources/:sourceId/status   (admin scope — L1582)
  // Scope checks are in-handler (requireReviewOrAdmin / requireAdmin) — in
  // single_tenant mode ALL_LOCAL_SCOPES includes both review and admin, so
  // no separate middleware mount is needed. In enforced mode (deferred —
  // IdentityAdapter not yet wired), a future ticket must mount review/admin
  // access middleware before this router.
  app.use(
    "/api",
    createSourceGovernanceRouter({
      db,
      candidateReviewStore,
      retirementService,
      lifecycleStore: sourceLifecycleStore,
    })
  )
  if (options.processRuntime && options.config) {
    const statusRouter = createStatusRouter({
      config: options.config,
      elasticsearch: options.processRuntime.elasticsearch,
      neo4jDriver: options.processRuntime.neo4jDriver,
      chatClient: options.processRuntime.chatClient,
    })
    app.use("/api", statusRouter)
    // The /api/models route is no longer mounted in production — the
    // deployment-configured model is the only model. The source file
    // (src/api/models.ts) is retained for potential future use.
  }
  app.use("/api", ingestRouter)
  return app
}

/**
 * T45: startServer creates a ProcessRuntime that owns shared resources.
 * The runtime is returned so the caller (index.ts) can delegate close()
 * to the shutdown controller (T46).
 *
 * The required `eventsSource` parameter is the single injection point for
 * the Mastra runtime boundary.
 *
 * P5.2: `identityAdapter` is the concrete `IdentityAdapter` built by the
 * composition root (index.ts) from the loaded `OidcConfig`. When provided,
 * the chat access middleware enforces identity + chat scope per request;
 * the ingest access middleware enforces identity + ingest scope. In
 * single_tenant mode the adapter is unused (the middleware short-circuits
 * to `singleTenantAccessContext()`), and no ingest middleware is mounted
 * (preserving exact pre-P5.2 ingestion behavior).
 */
export async function startServer(
  port: number,
  eventsSource: AnswerEventsSource,
  identityAdapter?: import("../access/context").IdentityAdapter
): Promise<{
  server: Server
  processRuntime: ProcessRuntime
}> {
  const config = loadConfig()
  const processRuntime = createProcessRuntime(config)
  // Ticket 05 follow-up wiring + P5.2: in single_tenant mode (default), mount
  // the access middleware and session binder so every chat request gets a
  // deterministic AccessContext and sessionId → (tenantId, subjectId)
  // binding. In enforced mode (P5.2), the identity adapter resolves a
  // per-request AccessContext from the JWT; validateAccessMode() in
  // index.ts main() already confirmed an adapter is wired at startup.
  const accessMiddleware = createAccessMiddleware({
    mode: config.accessMode,
    ...(identityAdapter ? { adapter: identityAdapter } : {}),
    requiredScope: "chat",
  })
  // P5.2: ingestion gate — only mount in enforced mode so single_tenant
  // ingestion behavior is byte-identical to pre-P5.2 (ingest handlers do
  // not read res.locals.accessContext). In enforced mode the adapter
  // resolves identity + ingest scope before any ingestion handler runs
  // (closes D-007 debt #3: no ACL/accessContext check on /ingest/url).
  const ingestAccessMiddleware =
    config.accessMode === "enforced" && identityAdapter
      ? createAccessMiddleware({
          mode: "enforced",
          adapter: identityAdapter,
          requiredScope: "ingest",
        })
      : undefined
  const sessionBinder = new SqliteSessionBinder(processRuntime.db)
  const app = createApp({
    db: processRuntime.db,
    imageAssetPath: config.imageAssetPath,
    accessMiddleware,
    ...(ingestAccessMiddleware ? { ingestAccessMiddleware } : {}),
    sessionBinder,
    eventsSource,
    processRuntime,
    config,
  })
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(port, () => {
      console.log(`[kefu-RAG] API server listening on http://localhost:${port}`)
      resolve(s)
    })
  })
  return { server, processRuntime }
}
