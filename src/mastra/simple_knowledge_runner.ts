/**
 * Ticket 11 — Simple knowledge route Mastra runner.
 *
 * Implements the `MastraRunner` seam (defined in Ticket 05) for the simple
 * knowledge route: retrieval → Evidence → Context → answer Draft → Citation
 * check → Critic validation loop (≤3 rounds with correction retrieval) →
 * publish / handoff.
 *
 * This runner reuses the existing authorized retrieval stack (Searcher with
 * AccessContext), Evidence builder, ContextAssembler, ContextCompressor,
 * Validator, RePlanner, ToolSelector, ConversationStore, Contextualizer,
 * Summarizer, and HandoffStore — it does NOT re-implement their behavior.
 * The only abstraction is `streamAnswerDraft` (the LLM call seam), mirroring
 * the T09 `streamDirectReply` pattern so the runner can be tested without the
 * real @mastra/core Agent.
 *
 * Boundary (T02 #5): this module MUST NOT import `src/api/*` or `src/index`.
 * It depends only on:
 *   - `src/mastra/chat_event_adapter.ts` (MastraRunner seam + types)
 *   - `src/retrieval/router/interface.ts` (Router interface)
 *   - `src/retrieval/search/interface.ts` (Searcher, SearchOptions)
 *   - `src/retrieval/context/interface.ts` (ContextAssembler)
 *   - `src/retrieval/tool_selector.ts` (ToolSelector, RetrievalToolName)
 *   - `src/critic/validator/interface.ts` (Validator)
 *   - `src/critic/replanner/interface.ts` (RePlanner)
 *   - `src/answer/conversation_store.ts` (ConversationStore)
 *   - `src/answer/contextualizer.ts` (Contextualizer)
 *   - `src/answer/context_compressor.ts` (ContextCompressor)
 *   - `src/answer/summarizer.ts` (Summarizer)
 *   - `src/answer/handoff_store.ts` (HandoffStore)
 *   - `src/answer/evidence.ts` (buildEvidence, citationIdsByChunk, referencesForReply)
 *   - `src/access/context.ts` (AccessContext)
 *   - `src/types` (AgentMessage, AnswerRunResult, Evidence, Query, RetrievalResult, ...)
 *
 * @mastra/core decoupling: the LLM stream is injected via `streamAnswerDraft`
 * so the runner can be tested in isolation. T11's production wiring (in
 * `src/index.ts`) constructs a real @mastra/core Agent and adapts its
 * `stream()` output to the `AsyncIterable<string>` signature.
 *
 * Cancellation contract (T11 #5): the runner respects `input.signal.aborted`
 * at every await point via the `abortable()` helper. Mid-stream abort surfaces
 * as AbortError from `streamAnswerDraft` and propagates out of the runner.
 *
 * Trace data aggregation: the runner returns a single MastraRunnerOutput with
 * aggregated trace data for the 4 progress stages (route/retrieval/context/
 * validation). The T05 chat_event_adapter emits the 6 AnswerRunEvent types
 * using this trace data; intermediate events within the runner (e.g. multiple
 * retrieval rounds) are folded into the final trace. T14 owns the
 * shadow-parity audit that compares Mastra vs legacy event streams.
 */

import type {
  MastraRunner,
  MastraRunnerInput,
  MastraRunnerOutput,
} from "./chat_event_adapter"
import type { Router } from "../retrieval/router/interface"
import type {
  Searcher,
  SearchOptions,
} from "../retrieval/search/interface"
import { SYSTEM_PROMPT } from "./system_prompt"
import type { ContextAssembler } from "../retrieval/context/interface"
import type {
  ToolSelector,
  RetrievalToolName,
} from "../retrieval/tool_selector"
import {
  formatToolInputSummary,
  toolToSearchOptions,
} from "../retrieval/tool_selector"
import type { Validator } from "../critic/validator/interface"
import type { RePlanner } from "../critic/replanner/interface"
import type { ConversationStore, ConversationTurn } from "../answer/conversation_store"
import type { Contextualizer } from "../answer/contextualizer"
import type { ContextCompressor } from "../answer/context_compressor"
import type { Summarizer } from "../answer/summarizer"
import type { HandoffStore } from "../answer/handoff_store"
import {
  buildEvidence,
  citationIdsByChunk,
  referencesForReply,
} from "../answer/evidence"
import type { AccessContext } from "../access/context"
import type {
  AgentMessage,
  AnswerDegradation,
  AnswerDegradationReason,
  AnswerRunResult,
  Evidence,
  Query,
  RetrievalResult,
  RetrievalTraceData,
  RouteTraceData,
  ContextTraceData,
  ValidationTraceData,
  TokenUsage,
} from "../types"

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * Streamed LLM answer draft for the simple knowledge route. Receives the
 * full AgentMessage[] (system prompt + user-with-context) and returns an
 * async iterable of token strings, mirroring `model.stream()` in legacy
 * `src/answer/generation.ts`.
 *
 * The runner iterates this to collect tokens for `MastraRunnerOutput.tokens`
 * + `reply`. Mid-stream abort MUST surface as an AbortError thrown from the
 * iterable (the runner does not install its own abort listener on the stream
 * — the iterable is expected to honor the signal, matching the T09 pattern).
 */
export type KnowledgeAnswerDraftStream = (
  messages: AgentMessage[],
  signal: AbortSignal
) => AsyncIterable<string>

/**
 * Resolve tenantId from AccessContext. The runner needs tenantId for
 * ConversationStore operations (load memory, save validated turns, consume
 * pending clarification, handoff). Extracted as a dependency so the runner
 * doesn't hardcode AccessContext field assumptions (single-tenant vs enforced
 * mode). Mirrors the T09 pattern.
 */
export type TenantIdResolver = (accessContext: AccessContext) => string

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Error thrown when the route decision is not "simple". T11 owns only the
 * simple knowledge route; direct/ambiguous routes are owned by T09 and
 * complex route is owned by T12. The T08 runtime boundary catches this
 * error and falls back to the legacy orchestrator (T09 #5 route-level
 * fallback without data conversion).
 *
 * Note: T09's `RouteNotSupportedError` throws for both "simple" and
 * "complex". T11's `RouteNotSimpleError` is a distinct error so the T11
 * runner can be composed with the T09 runner in a route-dispatch layer
 * (T11 Step 3) without ambiguity. The dispatch layer routes "simple" to
 * this runner and lets T09's RouteNotSupportedError handle the rest.
 */
export class RouteNotSimpleError extends Error {
  constructor(public readonly decision: "direct" | "ambiguous" | "complex") {
    super(
      `Route "${decision}" is not supported by SimpleKnowledgeMastraRunner (T11). ` +
      `Supported route: simple. The route-dispatch layer should have routed this ` +
      `decision to the T09 DirectAmbiguousMastraRunner (direct/ambiguous) or the ` +
      `legacy orchestrator (complex, until T12).`
    )
    this.name = "RouteNotSimpleError"
  }
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface SimpleKnowledgeMastraRunnerDeps {
  /** Legacy Router — called once per run to get the route decision (GATE 0). */
  router: Router
  /** Factory for the authorized Searcher (called once per run, may be called again for correction retrieval). */
  createSearcher: () => Searcher
  /** Legacy ContextAssembler — builds bounded Context from selected RetrievalResults. */
  assembler: ContextAssembler
  /** Legacy Validator (Critic) — checks answer coverage against context. */
  validator: Validator
  /** Legacy RePlanner — produces gap queries when validation fails. */
  replanner: RePlanner
  /** Streamed LLM answer draft (abstracts @mastra/core Agent). */
  streamAnswerDraft: KnowledgeAnswerDraftStream
  /**
   * Ticket 07 (spec §12): LLM-backed single-round retrieval tool selector.
   * Optional — when absent, the default Searcher channels run (backward
   * compat with pre-Ticket 07 callers).
   */
  toolSelector?: ToolSelector
  /**
   * Ticket 61/04: LLM-backed Evidence-Context compressor. Optional — when
   * absent, the deterministic assembler output is used as-is.
   */
  compressor?: ContextCompressor
  /**
   * ConversationStore for memory loading, pending-clarification consumption,
   * validated turn persistence, and rolling-summary triggers. Optional for
   * single_turn backward compat.
   */
  conversationStore?: ConversationStore
  /**
   * Ticket 08 P3: rewrites a follow-up into a standalone query using
   * recentTurns before Router classification. Optional — omitting yields
   * single_turn backward compat.
   */
  contextualizer?: Contextualizer
  /**
   * Ticket 61/02: LLM-backed rolling-summary provider. Optional — when
   * absent, no summarization is triggered.
   */
  summarizer?: Summarizer
  /**
   * Ticket 09 P4: HandoffStore persistence. When present AND accessContext
   * is available, correction exhaustion (gap queries exhausted OR 3 rounds
   * exhausted without approval) terminates the run with `handoff_required`
   * instead of `insufficient_evidence`. Absent → single_tenant backward
   * compat (no handoff).
   */
  handoffStore?: HandoffStore
  /**
   * Resolve tenantId from AccessContext. Required when conversationStore or
   * handoffStore is wired.
   */
  resolveTenantId?: TenantIdResolver
  /**
   * Clock for `createdAt` timestamps on saved validated turns. Injected for
   * testability; defaults to `() => new Date()` in production.
   */
  now?: () => Date
}

// ---------------------------------------------------------------------------
// Helpers (mirrors of legacy generation.ts internals)
// ---------------------------------------------------------------------------

const INSUFFICIENT_RETRIEVAL_MESSAGE = "检索服务暂时不可用，无法生成可靠回答。"
const INSUFFICIENT_EVIDENCE_MESSAGE = "未找到相关证据，无法生成可靠回答。"

function abortError(checkpoint: string): Error {
  const error = new Error(`Answer run cancelled at ${checkpoint}`)
  error.name = "AbortError"
  return error
}

function checkAbort(signal: AbortSignal, checkpoint: string): void {
  if (signal.aborted) throw abortError(checkpoint)
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError("abortable guard"))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError("abortable race"))
    signal.addEventListener("abort", onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener("abort", onAbort)
        reject(err)
      }
    )
  })
}

async function* abortableStream<T>(
  stream: AsyncIterable<T>,
  signal: AbortSignal
): AsyncGenerator<T> {
  const iterator = stream[Symbol.asyncIterator]()
  try {
    while (true) {
      const next = await abortable(iterator.next(), signal)
      if (next.done) return
      yield next.value
    }
  } finally {
    if (signal.aborted && iterator.return) void iterator.return()
  }
}

function diversifySelect(
  groups: RetrievalResult[][],
  limit: number
): RetrievalResult[] {
  const seen = new Set<string>()
  const selected: RetrievalResult[] = []
  const queues = groups.map((g) => [...g])
  let added = true
  while (selected.length < limit && added) {
    added = false
    for (const queue of queues) {
      while (queue.length > 0) {
        const result = queue.shift()!
        const key = `${result.chunk.documentId}\0${result.chunk.id}`
        if (seen.has(key)) continue
        seen.add(key)
        selected.push(result)
        added = true
        break
      }
    }
  }
  return selected
}

function uniqueResults(results: RetrievalResult[]): RetrievalResult[] {
  const seen = new Set<string>()
  const unique: RetrievalResult[] = []
  for (const result of results) {
    const key = `${result.chunk.documentId}\0${result.chunk.id}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(result)
  }
  return unique
}

function normalizeGapQuery(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ")
}

function summarizeConversationForHandoff(
  turns: ConversationTurn[],
  summary?: string | null
): string {
  const parts: string[] = []
  if (summary) parts.push(`[较早摘要] ${summary}`)
  parts.push(turns.map((t) => `${t.role}: ${t.content}`).join("\n"))
  return parts.join("\n")
}

function saveValidatedTurnPair(
  conversationStore: ConversationStore,
  sessionId: string,
  tenantId: string,
  runId: string,
  userMessage: string,
  assistantReply: string,
  clock: () => Date
): void {
  const now = clock().toISOString()
  conversationStore.saveValidatedTurn({
    sessionId, tenantId, role: "user",
    content: userMessage, runId, createdAt: now,
  })
  conversationStore.saveValidatedTurn({
    sessionId, tenantId, role: "assistant",
    content: assistantReply, runId, createdAt: now,
  })
}

interface SummarizationOutcome {
  usage?: TokenUsage
  durationMs?: number
  checkpoint?: number
  outcome: "success" | "skipped" | "failed"
}

async function triggerSummarization(
  conversationStore: ConversationStore,
  summarizer: Summarizer | undefined,
  sessionId: string,
  tenantId: string,
  signal: AbortSignal
): Promise<SummarizationOutcome> {
  if (!summarizer) return { outcome: "skipped" }
  const start = Date.now()
  try {
    const memory = conversationStore.loadConversationMemory(sessionId, tenantId)
    if (memory.totalValidatedTurnCount <= 12) return { outcome: "skipped" }
    if (memory.oldestRecentTurnId === null) return { outcome: "skipped" }
    const newCheckpoint = memory.oldestRecentTurnId - 1
    const previousCheckpoint = memory.summarizedThroughTurnId ?? 0
    if (newCheckpoint <= previousCheckpoint) return { outcome: "skipped" }
    const olderTurns = conversationStore.loadOlderTurnsForSummarization(
      sessionId, tenantId, previousCheckpoint, newCheckpoint
    )
    if (olderTurns.length === 0 && memory.summary) return { outcome: "skipped" }
    const result = await summarizer.summarize(olderTurns, memory.summary, signal)
    if (signal.aborted || !result.summary) {
      return { outcome: "failed", durationMs: Date.now() - start }
    }
    conversationStore.saveRollingSummary(
      sessionId, tenantId, result.summary, newCheckpoint, 1
    )
    return {
      outcome: "success",
      usage: result.usage,
      durationMs: Date.now() - start,
      checkpoint: newCheckpoint,
    }
  } catch {
    return { outcome: "failed", durationMs: Date.now() - start }
  }
}

// ---------------------------------------------------------------------------
// Runner factory
// ---------------------------------------------------------------------------

/**
 * Create a MastraRunner that handles the simple knowledge route.
 *
 * Throws `RouteNotSimpleError` for direct/ambiguous/complex routes so the
 * route-dispatch layer (T11 Step 3) can route them appropriately. T11 owns
 * only the simple route; direct/ambiguous are owned by T09 and complex is
 * owned by T12.
 */
export function createSimpleKnowledgeMastraRunner(
  deps: SimpleKnowledgeMastraRunnerDeps
): MastraRunner {
  const {
    router,
    createSearcher,
    assembler,
    validator,
    replanner,
    streamAnswerDraft,
    toolSelector,
    compressor,
    conversationStore,
    contextualizer,
    summarizer,
    handoffStore,
    resolveTenantId,
  } = deps
  const clock = deps.now ?? (() => new Date())

  return async function simpleKnowledgeMastraRunner(
    input: MastraRunnerInput
  ): Promise<MastraRunnerOutput> {
    // T11 #5 cancellation checkpoint 1: before Router call (pre-route abort).
    if (input.signal.aborted) {
      throw abortError("GATE 0 (before route)")
    }

    const { signal, accessContext, sessionId, runId } = input
    const tenantId = resolveTenantId ? resolveTenantId(accessContext) : "default"
    const preparedRoute = input.preparedRoute

    // -------------------------------------------------------------------------
    // Memory loading + pending clarification consumption (mirrors legacy
    // generation.ts L437-L458).
    // -------------------------------------------------------------------------
    let effectiveMessage = preparedRoute?.effectiveMessage ?? input.message
    let recentTurns: ConversationTurn[] = []
    let conversationSummary: string | null = null
    if (conversationStore) {
      if (!preparedRoute) {
        const pendingMessage = conversationStore.peekPendingClarification?.(
          sessionId,
          tenantId
        )
        if (pendingMessage) {
          effectiveMessage = `${pendingMessage} ${input.message}`
        }
      }
      const memory = conversationStore.loadConversationMemory(sessionId, tenantId)
      recentTurns = memory?.recentTurns ?? []
      conversationSummary = memory?.summary ?? null
    }

    // -------------------------------------------------------------------------
    // Contextualization (mirrors legacy generation.ts L472-L502). Rewrites the
    // follow-up into a standalone query using recentTurns before Router
    // classification. Failures degrade to effectiveMessage (safe); AbortError
    // propagates.
    // -------------------------------------------------------------------------
    let contextualizedQuery = preparedRoute?.contextualizedQuery ?? effectiveMessage
    let contextualizationFailure = preparedRoute?.routeTrace.contextualizationFailure
    let contextualizationUsage = preparedRoute?.routeTrace.contextualizationUsage
    let contextualizationDurationMs = preparedRoute?.routeTrace.contextualizationDurationMs
    let contextualizationOutcome = preparedRoute?.routeTrace.contextualizationOutcome
    if (!preparedRoute && contextualizer && recentTurns.length > 0) {
      const ctxStart = Date.now()
      try {
        const result = await abortable(
          contextualizer.contextualize(
            effectiveMessage,
            recentTurns,
            conversationSummary
          ),
          signal
        )
        contextualizationDurationMs = Date.now() - ctxStart
        contextualizationUsage = result.usage
        if (result.query.trim()) {
          contextualizedQuery = result.query
          contextualizationOutcome = "success"
        } else {
          contextualizationFailure = "contextualize returned empty query"
          contextualizationOutcome = "failed"
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err
        contextualizationFailure = err instanceof Error ? err.message : String(err)
        contextualizationDurationMs = Date.now() - ctxStart
        contextualizationOutcome = "failed"
      }
    } else if (!preparedRoute) {
      contextualizationOutcome = "skipped"
    }

    // -------------------------------------------------------------------------
    // GATE 0: route decision (T03 §2.3 hybrid topology — deterministic gate).
    // -------------------------------------------------------------------------
    const decision = preparedRoute?.decision ?? await abortable(
      router.decide({ text: contextualizedQuery }),
      signal
    )

    if (decision !== "simple") {
      // T11 owns only the simple route. Throw RouteNotSimpleError so the
      // route-dispatch layer can route direct/ambiguous to the T09 runner
      // and complex to the legacy orchestrator (until T12).
      throw new RouteNotSimpleError(decision)
    }

    // Destructive state change belongs to the selected route owner only.
    if (conversationStore && !preparedRoute) {
      checkAbort(signal, "GATE 0 (before pending clarification consume)")
      if (conversationStore.claimPendingClarification) {
        conversationStore.claimPendingClarification(sessionId, tenantId)
      } else {
        conversationStore.consumePendingClarification(sessionId, tenantId)
      }
    }

    // -------------------------------------------------------------------------
    // Tool selection (Ticket 07, optional). Ask the LLM which read-only
    // retrieval tool best fits the standalone query, then map the selection
    // to SearchOptions.channels.
    // -------------------------------------------------------------------------
    let selectedTool: RetrievalToolName | undefined
    let toolInputSummary: string | undefined
    let toolFallbackReason: string | undefined
    let perQueryOptions: SearchOptions = {}
    const buildRouteTrace = (): RouteTraceData => ({
      ...(preparedRoute?.routeTrace ?? {}),
      decision: "simple",
      ...(selectedTool ? { selectedTool } : {}),
      ...(toolFallbackReason ? { toolFallbackReason } : {}),
      ...(contextualizationOutcome ? { contextualizationOutcome } : {}),
      ...(contextualizationFailure ? { contextualizationFailure } : {}),
      ...(contextualizationUsage ? { contextualizationUsage } : {}),
      ...(contextualizationDurationMs != null ? { contextualizationDurationMs } : {}),
    })
    if (toolSelector) {
      const toolResult = await abortable(
        toolSelector.selectTool({ text: contextualizedQuery }, signal),
        signal
      )
      selectedTool = toolResult.selection.tool
      toolInputSummary = formatToolInputSummary(toolResult.selection)
      toolFallbackReason = toolResult.fallbackReason
      perQueryOptions = { ...perQueryOptions, ...toolToSearchOptions(toolResult.selection) }
    }

    // -------------------------------------------------------------------------
    // GATE 1: retrieval (single query for simple route).
    // -------------------------------------------------------------------------
    const searcher = createSearcher()
    const query: Query = { text: contextualizedQuery }
    const unavailableChannels = new Set<RetrievalResult["source"]>()
    let retrievalAttempted = false
    let retrievalAvailable = false
    const resultGroups: RetrievalResult[][] = []

    retrievalAttempted = true
    const outcome = await abortable(
      searcher.search(query, { ...perQueryOptions, accessContext, signal }),
      signal
    )
    outcome.unavailableChannels.forEach((channel) => unavailableChannels.add(channel))
    if (outcome.status !== "insufficient") retrievalAvailable = true
    resultGroups.push(outcome.results)

    // Build the initial retrieval trace data (aggregated; final state).
    const channelStatuses = Object.fromEntries(
      (["vector", "bm25", "graph"] as const).map((channel) => [
        channel,
        outcome.unavailableChannels.includes(channel) ? "unavailable" : "completed",
      ])
    )
    let retrievalTrace: RetrievalTraceData = {
      channelStatuses,
      resultCount: outcome.results.length,
      selectedEvidenceIds: [],
      degradedReasons: outcome.unavailableChannels.map((channel) =>
        `${channel} unavailable`
      ),
      ...(selectedTool ? { selectedTool } : {}),
      ...(toolInputSummary ? { toolInputSummary } : {}),
      ...(toolFallbackReason ? { toolFallbackReason } : {}),
      ...(outcome.unselectedChannels && outcome.unselectedChannels.length > 0
        ? { unselectedChannels: outcome.unselectedChannels }
        : {}),
    }

    // Insufficient retrieval check (T11 #5: terminal insufficient_retrieval).
    if (retrievalAttempted && !retrievalAvailable) {
      return {
        reply: INSUFFICIENT_RETRIEVAL_MESSAGE,
        status: "insufficient_retrieval",
        references: [],
        degradation: {
          status: "insufficient",
          unavailableChannels: [...unavailableChannels],
        },
        tokens: [INSUFFICIENT_RETRIEVAL_MESSAGE],
        routeTrace: buildRouteTrace(),
        retrievalTrace,
        contextTrace: {},
        validationTrace: {},
      }
    }

    // -------------------------------------------------------------------------
    // Evidence building (T11 #2: stable Evidence identities).
    // -------------------------------------------------------------------------
    const allResults = resultGroups.flat()
    const selectedResults = diversifySelect(resultGroups, 10)
    const selectedKeys = new Set(selectedResults.map(({ chunk }) =>
      `${chunk.documentId}\0${chunk.id}`
    ))
    const accumulatedResults = allResults.filter(({ chunk }) =>
      selectedKeys.has(`${chunk.documentId}\0${chunk.id}`)
    )
    let evidence: Evidence[] = buildEvidence(accumulatedResults)
    retrievalTrace = {
      ...retrievalTrace,
      selectedEvidenceIds: evidence.map(({ id }) => id),
    }

    // Empty Evidence check (T11 #3: cannot complete without usable Evidence).
    if (evidence.length === 0) {
      const evidenceReason: AnswerDegradationReason =
        allResults.length === 0 ? "no_results" : "no_context_evidence"
      return {
        reply: INSUFFICIENT_EVIDENCE_MESSAGE,
        status: "insufficient_evidence",
        references: [],
        degradation: {
          status: "insufficient",
          unavailableChannels: [...unavailableChannels],
          reason: evidenceReason,
        },
        tokens: [INSUFFICIENT_EVIDENCE_MESSAGE],
        routeTrace: buildRouteTrace(),
        retrievalTrace,
        contextTrace: {},
        validationTrace: {},
      }
    }

    // -------------------------------------------------------------------------
    // GATE 2: context assembly (T11 #2: bounded Context representation).
    // -------------------------------------------------------------------------
    let context = await abortable(
      assembler.assemble(selectedResults, citationIdsByChunk(evidence)),
      signal
    )
    let contextTrace: ContextTraceData = {
      evidenceCount: evidence.length,
      contextLength: context.length,
      compressionRan: false,
    }
    // Optional compression (Ticket 61/04).
    if (compressor) {
      try {
        const result = await abortable(
          compressor.compress(
            evidence,
            effectiveMessage,
            { maxContextTokens: 6_000 },
            signal
          ),
          signal
        )
        if (result) {
          context = result.context
          contextTrace = {
            evidenceCount: evidence.length,
            contextLength: context.length,
            compressionRan: true,
            compressionInputTokens: result.inputTokens,
            compressionOutputTokens: result.outputTokens,
            compressionRetainedEvidenceIds: result.retainedEvidenceIds,
            compressionDroppedEvidenceIds: result.droppedEvidenceIds,
            ...(result.usage ? { compressionUsage: result.usage } : {}),
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err
        // non-Abort error: swallow, use deterministic context (criterion #5 fallback)
      }
    }

    // -------------------------------------------------------------------------
    // GATE 3: answer draft (LLM stream). Draft tokens are withheld until the
    // Critic approves (T03 §5 single-shot; the runner does NOT publish tokens
    // directly — the adapter publishes them from MastraRunnerOutput.tokens).
    // -------------------------------------------------------------------------
    const initialMessages: AgentMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `${context}\n\n用户问题：${effectiveMessage}` },
    ]
    const initialTokens: string[] = []
    for await (const token of abortableStream(
      streamAnswerDraft(initialMessages, signal),
      signal
    )) {
      initialTokens.push(token)
    }
    const initialAnswer = initialTokens.join("")

    // Citation check (T11 #4: unknown Citations rejected before publication).
    try {
      referencesForReply(initialAnswer, evidence)
    } catch {
      return {
        reply: "",
        status: "invalid_citation",
        references: [],
        degradation: {
          status: "insufficient",
          unavailableChannels: [...unavailableChannels],
          reason: "no_cited_claims",
        },
        tokens: [],
        routeTrace: buildRouteTrace(),
        retrievalTrace,
        contextTrace,
        validationTrace: {},
      }
    }
    let fullAnswer = initialAnswer
    let draftTokens: string[] = [...initialTokens]
    let validationTrace: ValidationTraceData = {}

    // -------------------------------------------------------------------------
    // GATE 4: validation loop (≤3 rounds, with correction retrieval).
    // -------------------------------------------------------------------------
    const seenGapQueries = new Set<string>()
    let approved = false
    let terminalStatus: AnswerRunResult["status"] | null = null
    let terminalReply = ""
    let terminalReferences: AnswerRunResult["references"] = []
    let terminalDegradation: AnswerDegradation = {
      status: unavailableChannels.size > 0 ? "partial" : "none",
      unavailableChannels: [...unavailableChannels],
    }

    for (let round = 0; round < 3; round += 1) {
      const verdict = await abortable(
        validator.validate(
          fullAnswer,
          [
            { role: "user", content: effectiveMessage },
            { role: "system", content: context },
          ],
          undefined,
          signal
        ),
        signal
      )
      validationTrace = { round: round + 1, passed: verdict.passed }

      if (verdict.passed) {
        approved = true
        break
      }

      // Replan: produce gap queries for correction retrieval.
      const rawGapQueries = await abortable(replanner.replan(verdict), signal)
      const gapQueries = rawGapQueries.filter((q) => {
        const normalized = normalizeGapQuery(q.text)
        if (seenGapQueries.has(normalized)) return false
        seenGapQueries.add(normalized)
        return true
      })

      if (gapQueries.length === 0) {
        // Gap queries exhausted → handoff_required (if enabled) or insufficient_evidence.
        if (handoffStore && resolveTenantId) {
          checkAbort(signal, "GATE 6 (before handoff persistence)")
          handoffStore.create({
            runId,
            tenantId,
            subjectId: accessContext.subjectId,
            sessionId,
            reasonCode: "insufficient_evidence",
            userRequest: effectiveMessage,
            conversationSummary: summarizeConversationForHandoff(
              recentTurns,
              conversationSummary
            ),
            evidenceIds: evidence.map(({ id }) => id),
            traceReference: runId,
          })
          terminalStatus = "handoff_required"
          terminalReply = fullAnswer
          terminalReferences = referencesForReply(fullAnswer, evidence)
          terminalDegradation = {
            status: unavailableChannels.size > 0 ? "partial" : "none",
            unavailableChannels: [...unavailableChannels],
            reason: "coverage_not_met",
          }
        } else {
          terminalStatus = "insufficient_evidence"
          terminalReply = fullAnswer
          terminalReferences = referencesForReply(fullAnswer, evidence)
          terminalDegradation = {
            status: unavailableChannels.size > 0 ? "partial" : "none",
            unavailableChannels: [...unavailableChannels],
            reason: "coverage_not_met",
          }
        }
        break
      }

      // Correction retrieval: run searcher.search for each gap query.
      let anyNewResults = false
      let correctionInsufficient = false
      for (const gapQuery of gapQueries) {
        const correctionOutcome = await abortable(
          searcher.search(gapQuery, { accessContext, signal }),
          signal
        )
        correctionOutcome.unavailableChannels.forEach((channel) =>
          unavailableChannels.add(channel)
        )
        if (correctionOutcome.status === "insufficient") {
          correctionInsufficient = true
          break
        }
        if (correctionOutcome.results.length === 0) continue
        accumulatedResults.push(...correctionOutcome.results)
        anyNewResults = true
      }

      if (correctionInsufficient) {
        terminalStatus = "insufficient_retrieval"
        terminalReply = fullAnswer + INSUFFICIENT_RETRIEVAL_MESSAGE
        terminalReferences = referencesForReply(fullAnswer, evidence)
        terminalDegradation = {
          status: "insufficient",
          unavailableChannels: [...unavailableChannels],
        }
        break
      }

      if (!anyNewResults) {
        // No new evidence from any gap query → exhausted.
        if (handoffStore && resolveTenantId) {
          checkAbort(signal, "GATE 6 (before handoff persistence)")
          handoffStore.create({
            runId,
            tenantId,
            subjectId: accessContext.subjectId,
            sessionId,
            reasonCode: "insufficient_evidence",
            userRequest: effectiveMessage,
            conversationSummary: summarizeConversationForHandoff(
              recentTurns,
              conversationSummary
            ),
            evidenceIds: evidence.map(({ id }) => id),
            traceReference: runId,
          })
          terminalStatus = "handoff_required"
          terminalReply = fullAnswer
          terminalReferences = referencesForReply(fullAnswer, evidence)
          terminalDegradation = {
            status: unavailableChannels.size > 0 ? "partial" : "none",
            unavailableChannels: [...unavailableChannels],
            reason: "coverage_not_met",
          }
        } else {
          terminalStatus = "insufficient_evidence"
          terminalReply = fullAnswer
          terminalReferences = referencesForReply(fullAnswer, evidence)
          terminalDegradation = {
            status: unavailableChannels.size > 0 ? "partial" : "none",
            unavailableChannels: [...unavailableChannels],
            reason: "coverage_not_met",
          }
        }
        break
      }

      // Rebuild Evidence + Context from accumulated results, then regenerate draft.
      evidence = buildEvidence(accumulatedResults)
      context = await abortable(
        assembler.assemble(uniqueResults(accumulatedResults), citationIdsByChunk(evidence)),
        signal
      )
      // Optional compression for correction round.
      if (compressor) {
        try {
          const result = await abortable(
            compressor.compress(
              evidence,
              effectiveMessage,
              { maxContextTokens: 6_000 },
              signal
            ),
            signal
          )
          if (result) {
            context = result.context
            contextTrace = {
              evidenceCount: evidence.length,
              contextLength: context.length,
              compressionRan: true,
              compressionInputTokens: result.inputTokens,
              compressionOutputTokens: result.outputTokens,
              compressionRetainedEvidenceIds: result.retainedEvidenceIds,
              compressionDroppedEvidenceIds: result.droppedEvidenceIds,
              ...(result.usage ? { compressionUsage: result.usage } : {}),
            }
          } else {
            contextTrace = {
              evidenceCount: evidence.length,
              contextLength: context.length,
              compressionRan: false,
            }
          }
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") throw err
          // non-Abort error: swallow, use deterministic context
        }
      } else {
        contextTrace = {
          evidenceCount: evidence.length,
          contextLength: context.length,
          compressionRan: false,
        }
      }

      // Regenerate draft from the rebuilt context.
      const regenMessages: AgentMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `${context}\n\n用户问题：${effectiveMessage}` },
      ]
      const regenTokens: string[] = []
      for await (const token of abortableStream(
        streamAnswerDraft(regenMessages, signal),
        signal
      )) {
        regenTokens.push(token)
      }
      const regenAnswer = regenTokens.join("")
      // Citation check on regenerated draft (T11 #4).
      try {
        referencesForReply(regenAnswer, evidence)
      } catch {
        terminalStatus = "invalid_citation"
        terminalReply = fullAnswer
        terminalReferences = referencesForReply(fullAnswer, evidence)
        terminalDegradation = {
          status: "insufficient",
          unavailableChannels: [...unavailableChannels],
          reason: "no_cited_claims",
        }
        break
      }
      fullAnswer = regenAnswer
      draftTokens = [...regenTokens]
    }

    // -------------------------------------------------------------------------
    // GATE 5/6: publish or handoff.
    // -------------------------------------------------------------------------
    if (!approved && terminalStatus === null) {
      // 3 rounds expired without approval and without gap-query exhaustion.
      if (handoffStore && resolveTenantId) {
        checkAbort(signal, "GATE 6 (before handoff persistence)")
        handoffStore.create({
          runId,
          tenantId,
          subjectId: accessContext.subjectId,
          sessionId,
          reasonCode: "insufficient_evidence",
          userRequest: effectiveMessage,
          conversationSummary: summarizeConversationForHandoff(
            recentTurns,
            conversationSummary
          ),
          evidenceIds: evidence.map(({ id }) => id),
          traceReference: runId,
        })
        terminalStatus = "handoff_required"
        terminalReply = fullAnswer
        terminalReferences = referencesForReply(fullAnswer, evidence)
        terminalDegradation = {
          status: unavailableChannels.size > 0 ? "partial" : "none",
          unavailableChannels: [...unavailableChannels],
          reason: "coverage_not_met",
        }
      } else {
        terminalStatus = "insufficient_evidence"
        terminalReply = fullAnswer
        terminalReferences = referencesForReply(fullAnswer, evidence)
        terminalDegradation = {
          status: unavailableChannels.size > 0 ? "partial" : "none",
          unavailableChannels: [...unavailableChannels],
          reason: "coverage_not_met",
        }
      }
    }

    if (!approved) {
      // Terminal non-completed path: do NOT save validated turns (T10 #2 invariant).
      return {
        reply: terminalReply,
        status: terminalStatus!,
        references: terminalReferences,
        degradation: terminalDegradation,
        tokens: [],
        routeTrace: buildRouteTrace(),
        retrievalTrace,
        contextTrace,
        validationTrace,
      }
    }

    // Approved: final citation check (T11 #3: at least one valid Citation).
    const finalReferences = referencesForReply(fullAnswer, evidence)
    if (finalReferences.length === 0) {
      return {
        reply: fullAnswer,
        status: "insufficient_evidence",
        references: finalReferences,
        degradation: {
          status: "insufficient",
          unavailableChannels: [...unavailableChannels],
          reason: "no_cited_claims",
        },
        tokens: [],
        routeTrace: buildRouteTrace(),
        retrievalTrace,
        contextTrace,
        validationTrace,
      }
    }

    // Save validated turns + trigger summarization (T10 #2: only completed turns).
    let summarization: SummarizationOutcome = { outcome: "skipped" }
    if (conversationStore) {
      checkAbort(signal, "GATE 5 (before validated turn persistence)")
      saveValidatedTurnPair(
        conversationStore,
        sessionId,
        tenantId,
        runId,
        effectiveMessage,
        fullAnswer,
        clock
      )
      summarization = await triggerSummarization(
        conversationStore,
        summarizer,
        sessionId,
        tenantId,
        signal
      )
    }

    return {
      reply: fullAnswer,
      status: "completed",
      references: finalReferences,
      degradation: {
        status: unavailableChannels.size > 0 ? "partial" : "none",
        unavailableChannels: [...unavailableChannels],
      },
      tokens: draftTokens,
      routeTrace: buildRouteTrace(),
      retrievalTrace,
      contextTrace,
      validationTrace,
      summarizationOutcome: summarization.outcome,
      summarizationUsage: summarization.usage,
      summarizationDurationMs: summarization.durationMs,
      summarizationCheckpoint: summarization.checkpoint,
    }
  }
}
