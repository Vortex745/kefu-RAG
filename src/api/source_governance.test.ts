/**
 * Ticket 11 Phase E P5 (spec §11 L1580-1583): Source governance HTTP API.
 *
 * Three endpoints, all tenant-scoped via res.locals.accessContext:
 *
 *   POST  /api/ingest/:docId/review       — review scope (L1580)
 *   POST  /api/sources/:sourceId/retire   — admin scope (L1581)
 *   GET   /api/sources/:sourceId/status   — admin scope (L1582)
 *
 * Error semantics (spec L1580-1583):
 *   - 400 for invalid decision, missing/empty reason, reason too long
 *   - 403 for missing scope (review or admin)
 *   - 404 for cross-tenant or non-existent IDs (never reveal existence)
 *   - 409 for conflicting review decision (InvalidReviewConflictError)
 *   - 200 for happy path AND idempotent re-call (preserves first call's fields)
 *
 * Actor identity: per types/governance.ts L101-103, the actor field is
 * populated from res.locals.accessContext.subjectId, NOT from the request
 * body — this prevents clients from spoofing reviewer identity.
 */
import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"
import type { Request, Response, NextFunction } from "express"
import { createSourceGovernanceRouter } from "./source_governance"
import { SqliteSourceLifecycleStore } from "../knowledge/source_lifecycle_store"
import { SqliteCandidateReviewStore } from "../knowledge/candidate_review_store"
import { RetirementServiceImpl } from "../knowledge/retirement"
import { DocumentRepo } from "../ingestion/tracking/doc_repo"
import { TaskRepo } from "../ingestion/tracking/task_repo"
import { openDb, type DB } from "../ingestion/tracking/db"
import {
  singleTenantAccessContext,
  type AccessContext,
  type Scope,
} from "../access/context"

const ALL_SCOPES: Scope[] = ["chat", "ingest", "review", "admin"]

interface SetupSourceArgs {
  sourceId: string
  tenantId?: string
  lifecycleState?: "active" | "quarantined" | "retired"
  docId: string
  candidateState?: "pending_review" | "approved" | "rejected"
  reviewedBy?: string | null
  reviewedAt?: string | null
  reviewReason?: string | null
  activeDocId?: string | null
}

function setupSource(db: DB, args: SetupSourceArgs): void {
  const tenantId = args.tenantId ?? "default"
  const createdAt = "2026-07-18T00:00:00.000Z"
  db.prepare(
    `INSERT INTO sources (
      source_id, source_key, source_kind, source_uri, namespace,
      active_doc_id, created_at, updated_at, tenant_id, lifecycle_state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    args.sourceId,
    `key-${args.sourceId}`,
    "file",
    `file:///tmp/${args.sourceId}.txt`,
    "local",
    args.activeDocId ?? null,
    createdAt,
    createdAt,
    tenantId,
    args.lifecycleState ?? "active"
  )
  db.prepare(
    `INSERT INTO documents (
      doc_id, source_id, content_hash, version, activation_order,
      title, source, content, status, created_at, updated_at,
      tenant_id, candidate_state, reviewed_by, reviewed_at, review_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    args.docId,
    args.sourceId,
    `hash-${args.docId}`,
    1,
    1,
    `Doc ${args.docId}`,
    `file:///tmp/${args.sourceId}.txt`,
    `content-${args.docId}`,
    createdAt,
    createdAt,
    tenantId,
    args.candidateState ?? "pending_review",
    args.reviewedBy ?? null,
    args.reviewedAt ?? null,
    args.reviewReason ?? null
  )
}

interface BuildAppOptions {
  middleware?: (req: Request, res: Response, next: NextFunction) => void
}

function buildApp(options: BuildAppOptions = {}) {
  const app = express()
  const db = openDb(":memory:")
  const documentRepo = new DocumentRepo(db)
  const lifecycleStore = new SqliteSourceLifecycleStore(db)
  const candidateReviewStore = new SqliteCandidateReviewStore(db, documentRepo)
  const taskRepo = new TaskRepo(db)
  const retirementService = new RetirementServiceImpl(db, lifecycleStore, taskRepo)
  app.use(express.json())
  if (options.middleware) {
    app.use(options.middleware)
  }
  app.use(
    "/api",
    createSourceGovernanceRouter({
      db,
      candidateReviewStore,
      retirementService,
      lifecycleStore,
    })
  )
  return { app, db, documentRepo, lifecycleStore, candidateReviewStore, retirementService }
}

async function listen(app: express.Express) {
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

async function postReview(
  port: number,
  docId: string,
  body: unknown,
  headers: Record<string, string> = {}
) {
  const res = await fetch(`http://127.0.0.1:${port}/api/ingest/${docId}/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null }
}

async function postRetire(
  port: number,
  sourceId: string,
  body: unknown,
  headers: Record<string, string> = {}
) {
  const res = await fetch(`http://127.0.0.1:${port}/api/sources/${sourceId}/retire`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null }
}

async function getStatus(
  port: number,
  sourceId: string,
  headers: Record<string, string> = {}
) {
  const res = await fetch(`http://127.0.0.1:${port}/api/sources/${sourceId}/status`, {
    headers,
  })
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null }
}

/** Multi-tenant middleware: switches tenant by x-test-tenant header. */
function multiTenantMiddleware(req: Request, res: Response, next: NextFunction): void {
  const tenant = (req.headers["x-test-tenant"] as string | undefined) ?? "default"
  res.locals.accessContext = {
    tenantId: tenant,
    subjectId: `user-${tenant}`,
    groups: [],
    scopes: ALL_SCOPES,
  } satisfies AccessContext
  next()
}

/** Restricted-scope middleware: only the given scopes (for 403 tests). */
function scopedMiddleware(scopes: Scope[]): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    res.locals.accessContext = {
      tenantId: "default",
      subjectId: "local",
      groups: [],
      scopes,
    } satisfies AccessContext
    next()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ingest/:docId/review — review scope (spec L1580)
// ─────────────────────────────────────────────────────────────────────────────

test("POST /review: approve pending_review → 200 + ReviewResult with approved state", async () => {
  const { app, db } = buildApp()
  setupSource(db, { sourceId: "src-1", docId: "doc-1", candidateState: "pending_review" })
  const { server, port } = await listen(app)
  try {
    const res = await postReview(port, "doc-1", { decision: "approve", reason: "LGTM" })
    assert.equal(res.status, 200)
    assert.equal(res.json!.candidateState, "approved")
    // Bare-router mode (no middleware) → singleTenantAccessContext.subjectId = "local"
    assert.equal(res.json!.reviewedBy, "local")
    assert.equal(res.json!.reviewReason, "LGTM")
  } finally {
    server.close()
  }
})

test("POST /review: reject pending_review → 200 + ReviewResult with rejected state", async () => {
  const { app, db } = buildApp()
  setupSource(db, { sourceId: "src-2", docId: "doc-2", candidateState: "pending_review" })
  const { server, port } = await listen(app)
  try {
    const res = await postReview(port, "doc-2", { decision: "reject", reason: "stale" })
    assert.equal(res.status, 200)
    assert.equal(res.json!.candidateState, "rejected")
    assert.equal(res.json!.reviewReason, "stale")
  } finally {
    server.close()
  }
})

test("POST /review: actor comes from ctx.subjectId, NOT body.actor (anti-spoofing)", async () => {
  const { app, db } = buildApp({ middleware: multiTenantMiddleware })
  setupSource(db, { sourceId: "src-3", docId: "doc-3", tenantId: "tenant-a", candidateState: "pending_review" })
  const { server, port } = await listen(app)
  try {
    // Body includes a malicious actor field — must be ignored
    const res = await postReview(
      port,
      "doc-3",
      { decision: "approve", reason: "ok", actor: "spoofed-actor" },
      { "x-test-tenant": "tenant-a" }
    )
    assert.equal(res.status, 200)
    assert.equal(res.json!.reviewedBy, "user-tenant-a")  // NOT "spoofed-actor"
  } finally {
    server.close()
  }
})

test("POST /review: idempotent re-approve on approved → 200 (preserves FIRST review's fields)", async () => {
  const { app, db } = buildApp()
  setupSource(db, {
    sourceId: "src-4",
    docId: "doc-4",
    candidateState: "approved",
    reviewedBy: "first@example.com",
    reviewedAt: "2026-07-18T09:00:00.000Z",
    reviewReason: "first review",
  })
  const { server, port } = await listen(app)
  try {
    const res = await postReview(port, "doc-4", { decision: "approve", reason: "second" })
    assert.equal(res.status, 200)
    assert.equal(res.json!.candidateState, "approved")
    assert.equal(res.json!.reviewedBy, "first@example.com")  // preserved
    assert.equal(res.json!.reviewReason, "first review")  // preserved
  } finally {
    server.close()
  }
})

test("POST /review: conflicting decision (approve on rejected) → 409", async () => {
  const { app, db } = buildApp()
  setupSource(db, { sourceId: "src-5", docId: "doc-5", candidateState: "rejected" })
  const { server, port } = await listen(app)
  try {
    const res = await postReview(port, "doc-5", { decision: "approve", reason: "retry" })
    assert.equal(res.status, 409)
    assert.equal(res.json!.error, "conflicting review decision")
    assert.equal(res.json!.currentCandidateState, "rejected")
    assert.equal(res.json!.requestedDecision, "approve")
  } finally {
    server.close()
  }
})

test("POST /review: 400 for invalid decision", async () => {
  const { app, db } = buildApp()
  setupSource(db, { sourceId: "src-6", docId: "doc-6", candidateState: "pending_review" })
  const { server, port } = await listen(app)
  try {
    const res = await postReview(port, "doc-6", { decision: "maybe", reason: "x" })
    assert.equal(res.status, 400)
    assert.equal(res.json!.error, "invalid or missing decision")
  } finally {
    server.close()
  }
})

test("POST /review: 400 for missing reason", async () => {
  const { app, db } = buildApp()
  setupSource(db, { sourceId: "src-7", docId: "doc-7", candidateState: "pending_review" })
  const { server, port } = await listen(app)
  try {
    const res = await postReview(port, "doc-7", { decision: "approve" })
    assert.equal(res.status, 400)
    assert.equal(res.json!.error, "reason must be a non-empty string (max 1000 chars)")
  } finally {
    server.close()
  }
})

test("POST /review: 400 for reason > 1000 chars", async () => {
  const { app, db } = buildApp()
  setupSource(db, { sourceId: "src-8", docId: "doc-8", candidateState: "pending_review" })
  const { server, port } = await listen(app)
  try {
    const res = await postReview(port, "doc-8", { decision: "approve", reason: "x".repeat(1001) })
    assert.equal(res.status, 400)
  } finally {
    server.close()
  }
})

test("POST /review: 404 for non-existent doc", async () => {
  const { app } = buildApp()
  const { server, port } = await listen(app)
  try {
    const res = await postReview(port, "missing-doc", { decision: "approve", reason: "x" })
    assert.equal(res.status, 404)
    assert.equal(res.json!.error, "document not found")
  } finally {
    server.close()
  }
})

test("POST /review: 404 for cross-tenant doc (never reveals existence)", async () => {
  const { app, db } = buildApp({ middleware: multiTenantMiddleware })
  setupSource(db, { sourceId: "src-9", docId: "doc-9", tenantId: "tenant-a", candidateState: "pending_review" })
  const { server, port } = await listen(app)
  try {
    // Doc exists for tenant-a but we ask as tenant-b → 404
    const res = await postReview(
      port,
      "doc-9",
      { decision: "approve", reason: "x" },
      { "x-test-tenant": "tenant-b" }
    )
    assert.equal(res.status, 404)
  } finally {
    server.close()
  }
})

test("POST /review: 403 for missing review scope", async () => {
  const { app, db } = buildApp({ middleware: scopedMiddleware(["chat"]) })  // no review/admin
  setupSource(db, { sourceId: "src-10", docId: "doc-10", candidateState: "pending_review" })
  const { server, port } = await listen(app)
  try {
    const res = await postReview(port, "doc-10", { decision: "approve", reason: "x" })
    assert.equal(res.status, 403)
    assert.equal(res.json!.error, "missing scope: review or admin")
  } finally {
    server.close()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sources/:sourceId/retire — admin scope (spec L1581)
// ─────────────────────────────────────────────────────────────────────────────

test("POST /retire: happy path → 200 + RetirementResult with idempotent=false", async () => {
  const { app, db } = buildApp()
  setupSource(db, { sourceId: "src-r1", docId: "doc-r1", candidateState: "approved" })
  const { server, port } = await listen(app)
  try {
    const res = await postRetire(port, "src-r1", { reason: "legal hold" })
    assert.equal(res.status, 200)
    assert.equal(res.json!.lifecycleState, "retired")
    assert.equal(res.json!.idempotent, false)
    assert.ok((res.json!.tombstoneId as string).length > 0)
    assert.equal(res.json!.enqueuedCleanupTasks, 4)
  } finally {
    server.close()
  }
})

test("POST /retire: idempotent re-call → 200 with idempotent=true + no new tombstone", async () => {
  const { app, db } = buildApp()
  setupSource(db, { sourceId: "src-r2", docId: "doc-r2", candidateState: "approved" })
  const { server, port } = await listen(app)
  try {
    const r1 = await postRetire(port, "src-r2", { reason: "first" })
    assert.equal(r1.status, 200)
    assert.equal(r1.json!.idempotent, false)
    const r2 = await postRetire(port, "src-r2", { reason: "second" })
    assert.equal(r2.status, 200)
    assert.equal(r2.json!.idempotent, true)
    assert.equal(r2.json!.tombstoneId, "")  // no new tombstone
    assert.equal(r2.json!.enqueuedCleanupTasks, 0)  // no new tasks
  } finally {
    server.close()
  }
})

test("POST /retire: 400 for missing reason", async () => {
  const { app, db } = buildApp()
  setupSource(db, { sourceId: "src-r3", docId: "doc-r3", candidateState: "approved" })
  const { server, port } = await listen(app)
  try {
    const res = await postRetire(port, "src-r3", {})
    assert.equal(res.status, 400)
    assert.equal(res.json!.error, "reason must be a non-empty string (max 1000 chars)")
  } finally {
    server.close()
  }
})

test("POST /retire: 404 for non-existent source", async () => {
  const { app } = buildApp()
  const { server, port } = await listen(app)
  try {
    const res = await postRetire(port, "missing-src", { reason: "x" })
    assert.equal(res.status, 404)
    assert.equal(res.json!.error, "source not found")
  } finally {
    server.close()
  }
})

test("POST /retire: 404 for cross-tenant source", async () => {
  const { app, db } = buildApp({ middleware: multiTenantMiddleware })
  setupSource(db, { sourceId: "src-r4", docId: "doc-r4", tenantId: "tenant-a", candidateState: "approved" })
  const { server, port } = await listen(app)
  try {
    const res = await postRetire(
      port,
      "src-r4",
      { reason: "x" },
      { "x-test-tenant": "tenant-b" }
    )
    assert.equal(res.status, 404)
  } finally {
    server.close()
  }
})

test("POST /retire: 403 for missing admin scope (review alone is not enough)", async () => {
  const { app, db } = buildApp({ middleware: scopedMiddleware(["review"]) })  // review but not admin
  setupSource(db, { sourceId: "src-r5", docId: "doc-r5", candidateState: "approved" })
  const { server, port } = await listen(app)
  try {
    const res = await postRetire(port, "src-r5", { reason: "x" })
    assert.equal(res.status, 403)
    assert.equal(res.json!.error, "missing scope: admin")
  } finally {
    server.close()
  }
})

test("POST /retire: actor comes from ctx.subjectId, NOT body (anti-spoofing)", async () => {
  const { app, db } = buildApp({ middleware: multiTenantMiddleware })
  setupSource(db, { sourceId: "src-r6", docId: "doc-r6", tenantId: "tenant-a", candidateState: "approved" })
  const { server, port } = await listen(app)
  try {
    const res = await postRetire(
      port,
      "src-r6",
      { reason: "legal", actor: "spoofed" },
      { "x-test-tenant": "tenant-a" }
    )
    assert.equal(res.status, 200)
    // Verify via DB: tombstone.actor must be "user-tenant-a", not "spoofed"
    const tombstoneRow = db.prepare(
      `SELECT actor FROM source_tombstones WHERE source_id = ?`
    ).get("src-r6") as { actor: string }
    assert.equal(tombstoneRow.actor, "user-tenant-a")
  } finally {
    server.close()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sources/:sourceId/status — admin scope (spec L1582)
// ─────────────────────────────────────────────────────────────────────────────

test("GET /status: happy path — returns full SourceStatusSummary", async () => {
  const { app, db } = buildApp()
  setupSource(db, {
    sourceId: "src-s1",
    docId: "doc-active",
    candidateState: "approved",
    activeDocId: "doc-active",
  })
  // Add a pending_review candidate doc
  db.prepare(
    `INSERT INTO documents (
      doc_id, source_id, content_hash, version, activation_order,
      title, source, content, status, created_at, updated_at,
      tenant_id, candidate_state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, 'pending_review')`
  ).run(
    "doc-pending",
    "src-s1",
    "hash-pending",
    2,
    2,
    "Doc pending",
    "file:///tmp/src-s1.txt",
    "content-pending",
    "2026-07-18T00:00:00.000Z",
    "2026-07-18T00:00:00.000Z",
    "default"
  )
  const { server, port } = await listen(app)
  try {
    const res = await getStatus(port, "src-s1")
    assert.equal(res.status, 200)
    assert.equal(res.json!.sourceId, "src-s1")
    assert.equal(res.json!.tenantId, "default")
    assert.equal(res.json!.lifecycleState, "active")
    assert.equal(res.json!.activeDocId, "doc-active")
    assert.deepEqual(res.json!.candidateDocIds, ["doc-pending"])
    assert.equal(res.json!.lastTombstone, null)
    assert.deepEqual(res.json!.cleanupSummary, { pending: 0, failed: 0, deadLettered: 0 })
  } finally {
    server.close()
  }
})

test("GET /status: includes lastTombstone after retire", async () => {
  const { app, db, retirementService } = buildApp()
  setupSource(db, { sourceId: "src-s2", docId: "doc-s2", candidateState: "approved" })
  retirementService.retire("src-s2", "default", "deprecated", "admin@example.com")
  const { server, port } = await listen(app)
  try {
    const res = await getStatus(port, "src-s2")
    assert.equal(res.status, 200)
    assert.equal(res.json!.lifecycleState, "retired")
    assert.ok(res.json!.lastTombstone)
    const tombstone = res.json!.lastTombstone as {
      reason: string
      actor: string
      retiredVersionIds: string[]
    }
    assert.equal(tombstone.reason, "deprecated")
    assert.equal(tombstone.actor, "admin@example.com")
    assert.deepEqual(tombstone.retiredVersionIds, ["doc-s2"])
    // 4 cleanup tasks enqueued, all pending
    assert.deepEqual(res.json!.cleanupSummary, { pending: 4, failed: 0, deadLettered: 0 })
  } finally {
    server.close()
  }
})

test("GET /status: 404 for non-existent source", async () => {
  const { app } = buildApp()
  const { server, port } = await listen(app)
  try {
    const res = await getStatus(port, "missing-src")
    assert.equal(res.status, 404)
    assert.equal(res.json!.error, "source not found")
  } finally {
    server.close()
  }
})

test("GET /status: 404 for cross-tenant source", async () => {
  const { app, db } = buildApp({ middleware: multiTenantMiddleware })
  setupSource(db, { sourceId: "src-s3", docId: "doc-s3", tenantId: "tenant-a", candidateState: "approved" })
  const { server, port } = await listen(app)
  try {
    const res = await getStatus(port, "src-s3", { "x-test-tenant": "tenant-b" })
    assert.equal(res.status, 404)
  } finally {
    server.close()
  }
})

test("GET /status: 403 for missing admin scope (review alone is not enough)", async () => {
  const { app, db } = buildApp({ middleware: scopedMiddleware(["review"]) })
  setupSource(db, { sourceId: "src-s4", docId: "doc-s4", candidateState: "approved" })
  const { server, port } = await listen(app)
  try {
    const res = await getStatus(port, "src-s4")
    assert.equal(res.status, 403)
    assert.equal(res.json!.error, "missing scope: admin")
  } finally {
    server.close()
  }
})

test("GET /status: includes cleanupSummary with mixed pending + dead-lettered tasks", async () => {
  const { app, db, retirementService } = buildApp()
  setupSource(db, { sourceId: "src-s5", docId: "doc-s5", candidateState: "approved" })
  retirementService.retire("src-s5", "default", "deprecated", "admin")
  // Simulate one task getting dead-lettered
  const taskRow = db.prepare(
    `SELECT id, op FROM task_pending_ops WHERE doc_id = ? AND op = 'cleanup_es'`
  ).get("doc-s5") as { id: number; op: string }
  db.prepare(
    `UPDATE task_pending_ops SET status = 'failed', claimed_at = NULL
     WHERE id = ?`
  ).run(taskRow.id)
  db.prepare(
    `INSERT INTO task_dead_letters
      (task_id, doc_id, op, payload, fail_count, error_message, error_stack, failed_at)
     VALUES (?, ?, ?, '{}', 3, 'ES unreachable', NULL, '2026-07-18T10:00:00.000Z')`
  ).run(taskRow.id, "doc-s5", "cleanup_es")
  // Simulate one task getting completed (should NOT count as pending or failed)
  const completedRow = db.prepare(
    `SELECT id FROM task_pending_ops WHERE doc_id = ? AND op = 'cleanup_neo4j'`
  ).get("doc-s5") as { id: number }
  db.prepare(`UPDATE task_pending_ops SET status = 'completed' WHERE id = ?`).run(completedRow.id)

  const { server, port } = await listen(app)
  try {
    const res = await getStatus(port, "src-s5")
    assert.equal(res.status, 200)
    // Of the 4 cleanup tasks: 1 dead-lettered, 1 completed (not counted), 2 still pending
    assert.deepEqual(res.json!.cleanupSummary, { pending: 2, failed: 0, deadLettered: 1 })
  } finally {
    server.close()
  }
})
