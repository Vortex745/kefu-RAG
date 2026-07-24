import "dotenv/config"
import { createAnswerRuntime } from "./answer/runtime"
import { startConversationGc } from "./answer/conversation_gc"
import { SqliteConversationStore } from "./answer/conversation_store"
import { loadConfig } from "./config"
import { validateAccessMode, type IdentityAdapter } from "./access/context"
import {
  loadOidcConfig,
  JoseIdentityAdapter,
} from "./identity"
import { startServer } from "./api"
import { startWorker } from "./api/worker"
import { closeDriver } from "./graph"
import { createShutdownController, installSignalHandlers } from "./shutdown"
import { createMastraRuntimeBoundary } from "./mastra/runtime_boundary"
import { createMastraChatEventAdapter } from "./mastra/chat_event_adapter"
import { createDirectAmbiguousMastraRunner } from "./mastra/direct_ambiguous_runner"
import { createSimpleKnowledgeMastraRunner } from "./mastra/simple_knowledge_runner"
import { createComplexKnowledgeMastraRunner } from "./mastra/complex_knowledge_runner"
import { createRouteDispatchRunner } from "./mastra/route_dispatch_runner"
import { createMastraWorkflowRunner } from "./mastra/workflow_runner"
import { createDirectReplyStream } from "./mastra/direct_reply_stream"
import { createMastraMemoryAdapter } from "./mastra/memory_adapter"
import { readMastraRuntimeMode } from "./mastra/runtime_mode"
import {
  MASTRA_PROMOTION_ARTIFACT_ENV,
  assertRuntimeModeStartupAllowed,
} from "./mastra/promotion_gate"
import { RouterImpl } from "./retrieval/router/router"
import { RuntimeSearchOperations, SearcherImpl } from "./retrieval/search/searcher"
import { ContextAssemblerImpl } from "./retrieval/context/assembler"
import { ValidatorImpl } from "./critic/validator/validator"
import { RePlannerImpl } from "./critic/replanner/replanner"
import { PlannerImpl } from "./retrieval/planner/planner"
import { ComplexLoopControllerImpl } from "./retrieval/complex_loop"
import { OpenAIAnswerModel, type AnswerRunObserver } from "./answer/generation"
import { ContextualizerImpl } from "./answer/contextualizer"
import { SummarizerImpl } from "./answer/summarizer"
import { ContextCompressorImpl } from "./answer/context_compressor"
import { SqliteHandoffStore } from "./answer/handoff_store"
import { langfuseObserver, NoopLangfuseExporter } from "./answer/langfuse_exporter"
import { PageIndexRepository } from "./ingestion/tracking/page_index_repo"
import { ActiveVersionRepository } from "./ingestion/tracking/active_version_repo"
import type { AccessContext } from "./access/context"
import type { AgentMessage } from "./types"
import {
  createModelCostEstimator,
  type RunResourceBudgetOptions,
} from "./runtime/run_context"

async function main() {
  const cfg = loadConfig()
  console.log("[kefu-RAG] Config loaded", { esNode: cfg.esNode, neo4jUri: cfg.neo4jUri })

  // Ticket 05: build the OIDC config + concrete IdentityAdapter from the
  // environment. In single_tenant mode loadOidcConfig returns a noop config
  // and the adapter is never constructed (the middleware short-circuits to
  // singleTenantAccessContext). In enforced mode the JoseIdentityAdapter
  // uses jose's jwtVerify + createRemoteJWKS for standards-based signature,
  // issuer, audience, algorithm, expiry, and not-before validation in one
  // trust boundary. Remote JWKS caching, cooldown, and key rotation are
  // handled by jose internally — no manual cache warming needed.
  const oidcConfig = loadOidcConfig(process.env, cfg.accessMode)
  let identityAdapter: IdentityAdapter | undefined
  if (cfg.accessMode === "enforced") {
    identityAdapter = new JoseIdentityAdapter({ config: oidcConfig })
  }

  // Ticket 05 P4 + P5.2: startup fail-closed gate. Enforced mode without a
  // wired identity adapter throws — main() rejects, top-level .catch() exits
  // with code 1, no server, no worker. With the P5.2 adapter wired, enforced
  // mode passes the startup gate; the runtime fail-closed still lives in
  // createAccessMiddleware (enforced + adapter.resolve()=null → 401).
  validateAccessMode({ accessMode: cfg.accessMode, ...(identityAdapter ? { adapter: identityAdapter } : {}) })

  const runtimeMode = readMastraRuntimeMode()
  assertRuntimeModeStartupAllowed(
    runtimeMode,
    process.env[MASTRA_PROMOTION_ARTIFACT_ENV]
  )

  // createAnswerRuntime owns shared SQLite, ES, Neo4j and OpenAI adapters.
  const answerRuntime = createAnswerRuntime(cfg)

  // Ticket 09: wire the real Mastra runner for direct + ambiguous routes.
  // The runner is composed of:
  //   - RouterImpl (domain Router — T03 §2.3 deterministic GATE 0)
  //   - createDirectReplyStream (real Mastra core Agent — ESM-only devDep)
  //   - createDirectAmbiguousMastraRunner (T09 route-aware runner)
  //   - createMastraChatEventAdapter (T05 adapter — 6-stage event emission)
  //
  // The boundary's `eventsSource` is the single injection point passed to
  // `startServer` (T07 §3.4 single-publisher invariant). `close()` is a no-op
  // in T09 — the Mastra core Agent has no explicit cleanup hook (the
  // underlying OpenAI client is closed by ProcessRuntime.close()).
  const { chatClient, embeddingClient, elasticsearch, db } = answerRuntime.processRuntime
  const router = new RouterImpl(chatClient, cfg.openaiChatModel)
  const conversationStore = new SqliteConversationStore(db)
  const resolveTenantId = (accessContext: AccessContext) => accessContext.tenantId
  const streamDirectReply = await createDirectReplyStream({
    model: cfg.openaiChatModel,
    apiKey: cfg.openaiApiKey,
    ...(cfg.openaiBaseUrl ? { baseURL: cfg.openaiBaseUrl } : {}),
  })
  // Ticket 10 — Conversation Memory adapter. Pure pass-through to the
  // existing ConversationStore (T04 section 3 contract). The runner uses
  // this to load memory before streaming (prepend context prefix) and to
  // save validated turns after the direct route completes. Ambiguous route
  // does NOT use the adapter (clarification is not a completed turn).
  const memoryAdapter = createMastraMemoryAdapter({ conversationStore })
  const summarizer = new SummarizerImpl(chatClient, cfg.openaiChatModel)

  // Ticket 09 — direct + ambiguous route runner. HandoffStore is NOT wired
  // here — direct + ambiguous routes don't use Handoff; T12 (complex route)
  // will wire it when it migrates.
  const directAmbiguousRunner = createDirectAmbiguousMastraRunner({
    router,
    streamDirectReply,
    conversationStore,
    resolveTenantId,
    memoryAdapter,
    summarizer,
  })

  // The Mastra runners reuse the existing retrieval, validation, memory,
  // handoff, and summarization components from the composition root.
  const searchOperations = new RuntimeSearchOperations({
    es: elasticsearch,
    chatClient,
    embeddingClient,
    chatModel: cfg.openaiChatModel,
    embeddingModel: cfg.embeddingModel,
    pageIndexRepo: new PageIndexRepository(db),
    activeVersionRepo: new ActiveVersionRepository(db),
  })
  const answerModel = new OpenAIAnswerModel(chatClient, cfg.openaiChatModel)
  const contextualizer = new ContextualizerImpl(chatClient, cfg.openaiChatModel)
  const simpleRunner = createSimpleKnowledgeMastraRunner({
    router,
    createSearcher: () => new SearcherImpl(searchOperations),
    assembler: new ContextAssemblerImpl(),
    validator: new ValidatorImpl(chatClient, cfg.openaiChatModel),
    replanner: new RePlannerImpl(),
    streamAnswerDraft: (messages: AgentMessage[], signal: AbortSignal) =>
      answerModel.stream(messages, signal),
    conversationStore,
    contextualizer,
    summarizer,
    compressor: new ContextCompressorImpl(chatClient, cfg.openaiChatModel),
    handoffStore: new SqliteHandoffStore(db),
    resolveTenantId,
  })

  // Ticket 12 — complex knowledge route runner. Mirrors the T11 simple
  // runner construction pattern: reuses the SAME domain retrieval/Evidence/
  // Context/Citation/Critic/correction/Handoff/Summarizer components, plus
  // the T08 ComplexLoopController (bounded LLM-driven retrieval-tool loop,
  // <=3 iterations / <=4 tool calls) and the domain Planner (multi-query
  // decomposition fallback when complexLoopController is absent at runtime).
  // The runner's dual-path GATE 1 prefers runComplexLoop (T08 §13) and
  // falls back to planner.decompose — both paths produce Evidence that
  // flows through the same Context → Draft → Citation → Critic loop.
  // T09 §13 correction-round reuse: the correction round reuses
  // runComplexLoop with shared budgets + priorToolCalls (dedup state).
  const complexLoopController = new ComplexLoopControllerImpl(
    chatClient,
    cfg.openaiChatModel
  )
  const planner = new PlannerImpl(chatClient, cfg.openaiChatModel)
  const complexRunner = createComplexKnowledgeMastraRunner({
    router,
    createSearcher: () => new SearcherImpl(searchOperations),
    assembler: new ContextAssemblerImpl(),
    validator: new ValidatorImpl(chatClient, cfg.openaiChatModel),
    replanner: new RePlannerImpl(),
    streamAnswerDraft: (messages: AgentMessage[], signal: AbortSignal) =>
      answerModel.stream(messages, signal),
    planner,
    complexLoopController,
    conversationStore,
    contextualizer,
    summarizer,
    compressor: new ContextCompressorImpl(chatClient, cfg.openaiChatModel),
    handoffStore: new SqliteHandoffStore(db),
    resolveTenantId,
  })

  // Ticket 11 + Ticket 12 — route dispatch runner composes T09 + T11 + T12
  // into a single route-aware MastraRunner. simple → simpleRunner;
  // direct/ambiguous → directAmbiguousRunner; complex → complexRunner
  // (T12, in-process). Dispatch owns conversation preparation and the single
  // authoritative route decision, then invokes exactly one route owner.
  const dispatchRunner = createRouteDispatchRunner({
    router,
    simpleRunner,
    directAmbiguousRunner,
    complexRunner,
    conversationStore,
    contextualizer,
    resolveTenantId,
  })
  const runner = await createMastraWorkflowRunner(dispatchRunner)

  // The adapter calls each observer before yielding. Observer order matches
  // T06 §5.3: traceRepository (hard) then langfuseObserver (soft).
  // The langfuseObserver is only attached when Langfuse export is Real
  // (not Noop) — keeps the observer list minimal when Langfuse is disabled
  // (T06 §4.3 Noop default).
  const mastraObservers: AnswerRunObserver[] = []
  if (!(answerRuntime.langfuseExporter instanceof NoopLangfuseExporter)) {
    mastraObservers.push(langfuseObserver(answerRuntime.langfuseExporter))
  }
  const resourceBudgetLimits = {
    ...(cfg.answerRunMaxModelCalls !== undefined
      ? { maxModelCalls: cfg.answerRunMaxModelCalls }
      : {}),
    ...(cfg.answerRunMaxTokens !== undefined
      ? { maxTokens: cfg.answerRunMaxTokens }
      : {}),
    ...(cfg.answerRunMaxCostMicros !== undefined
      ? { maxCostMicros: cfg.answerRunMaxCostMicros }
      : {}),
  }
  const resourceBudget: RunResourceBudgetOptions | undefined =
    Object.keys(resourceBudgetLimits).length > 0 || cfg.answerRunModelPricing
      ? {
          ...(Object.keys(resourceBudgetLimits).length > 0
            ? { limits: resourceBudgetLimits }
            : {}),
          ...(cfg.answerRunModelPricing
            ? { estimateCostMicros: createModelCostEstimator(cfg.answerRunModelPricing) }
            : {}),
        }
      : undefined
  const mastraSource = createMastraChatEventAdapter({
    runner,
    traceObserver: answerRuntime.traceRepository,
    observers: mastraObservers,
    resourceBudget,
  })
  console.log("[kefu-RAG] Mastra runner wired — direct + ambiguous + simple + complex knowledge routes enabled with Conversation Memory + Handoff + Observer fanout")

  const mastraBoundary = createMastraRuntimeBoundary({
    mastraSource,
    modeReader: () => runtimeMode,
  })

  const { server, processRuntime } = await startServer(
    3001,
    mastraBoundary.eventsSource,
    identityAdapter
  )
  const worker = startWorker({ db: processRuntime.db })

  // Ticket 08 P6 (spec §7 L1535): conversation GC — scheduled job that purges
  // sessions inactive for >conversationTtlDays. Uses the SAME db as the answer
  // ConversationStore (answerRuntime.processRuntime.db) so it cleans exactly
  // the data the answer pipeline reads/writes. Eager sweep fires on next tick;
  // periodic sweeps follow every conversationGcIntervalMs.
  const conversationGc = startConversationGc({
    store: new SqliteConversationStore(answerRuntime.processRuntime.db),
    ttlDays: cfg.conversationTtlDays,
    intervalMs: cfg.conversationGcIntervalMs,
  })

  // T46: Shutdown delegates resource close to ProcessRuntime.close() which
  // owns SQLite, ES, Neo4j lifetimes. worker.stop() and server.close()
  // remain separate because they own process-level handles (timer, socket).
  // conversationGc.stop() clears the GC interval timer before the db closes.
  // Both the Answer runtime's and the server's ProcessRuntime are closed.
  const shutdownController = createShutdownController({
    worker,
    conversationGc,
    server,
    runtime: {
      close: async () => {
        // T12 (spec issue #12 criterion #6): flush pending Langfuse events
        // BEFORE closing ProcessRuntime resources. The exporter's close() is
        // idempotent (criterion #7) and does not close shared Answer/retrieval
        // resources — only Langfuse-specific state is flushed.
        await answerRuntime.langfuseExporter.close()
        await processRuntime.close()
        await answerRuntime.processRuntime.close()
        // Close the Mastra runtime boundary after ProcessRuntime so in-flight
        // streams have already been cancelled by the upstream close cascade.
        await mastraBoundary.close()
      },
    },
    // P8.2 (Debt #3 fix): close the legacy graph Neo4j driver singleton.
    // graph/index.ts holds a module-level _driver created lazily by
    // createDriver() (used by the ingestion pipeline via Neo4jStore.getDriver()).
    // Before P8.2 this dep was absent — the driver pool leaked on every server
    // shutdown. closeDriver() is idempotent (guards on _driver null) and is a
    // SEPARATE Driver instance from ProcessRuntime.neo4jDriver (closed above in
    // runtime.close). Shutdown order: runtime (ProcessRuntime's Neo4j) → driver
    // (graph singleton) → db. This is the single authoritative close path.
    driver: { close: closeDriver },
  })
  installSignalHandlers(shutdownController)
}

main().catch((err) => {
  console.error("[kefu-RAG] Startup failed:", err)
  process.exit(1)
})
