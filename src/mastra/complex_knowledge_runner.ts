/**
 * Ticket 12 — Complex knowledge route Mastra runner.
 *
 * Implements the `MastraRunner` seam (defined in Ticket 05) for the complex
 * knowledge route. Mirrors the T11 simple knowledge runner structure but
 * swaps GATE 1 (retrieval) for a dual-path flow and the correction round
 * for a budget-reuse flow:
 *
 *   GATE 0 route (must be "complex") →
 *   GATE 1 retrieval (dual-path):
 *     - ComplexLoopController wired → `runComplexLoop` (bounded LLM-driven
 *       retrieval-tool loop, ≤3 iterations / ≤4 tool calls, dedup, fallback)
 *     - else Planner wired → `planner.decompose` multi-query flow
 *       (decompose → rewrite → navigate → generateHypothesis per sub-query,
 *        then `searcher.search` per rewritten sub-query)
 *     - else → terminal `provider_error` (cannot run complex route)
 *   → Evidence → Context (+compression) →
 *   GATE 3 answer Draft (LLM stream) → Citation check →
 *   GATE 4 validation loop (≤3 rounds with correction retrieval). Correction
 *     rounds reuse the SAME bounded tool-selection mechanism with budgets
 *     SHARED across the initial run + all correction rounds (T09 §13
 *     correction-round reuse pattern). `priorToolCalls` carries dedup state
 *     so a tool call made in the initial run is not repeated in correction.
 *     Provider failure or budget exhaustion with 0 new results falls back to
 *     deterministic `searcher.search` (criterion #5).
 *   GATE 5/6 publish / handoff.
 *
 * This runner reuses the existing authorized retrieval stack (Searcher with
 * AccessContext), Evidence builder, ContextAssembler, ContextCompressor,
 * Validator, RePlanner, Planner, ComplexLoopController, ConversationStore,
 * Contextualizer, Summarizer, and HandoffStore — it does NOT re-implement
 * their behavior. The only abstraction is `streamAnswerDraft` (the LLM call
 * seam), mirroring the T09/T11 pattern so the runner can be tested without
 * the real @mastra/core Agent.
 *
 * Boundary (T02 #5): this module MUST NOT import `src/api/*` or `src/index`.
 * It depends only on:
 *   - `src/mastra/chat_event_adapter.ts` (MastraRunner seam + types)
 *   - `src/retrieval/router/interface.ts` (Router interface)
 *   - `src/retrieval/search/interface.ts` (Searcher, SearchOptions)
 *   - `src/retrieval/context/interface.ts` (ContextAssembler)
 *   - `src/retrieval/tool_selector.ts` (formatToolInputSummary — for trace)
 *   - `src/retrieval/planner/interface.ts` (Planner interface)
 *   - `src/retrieval/planner/planner.ts` (PlannerError)
 *   - `src/retrieval/complex_loop.ts` (runComplexLoop, ComplexLoopController,
 *     ComplexLoopResult, COMPLEX_LOOP_MAX_ITERATIONS, COMPLEX_LOOP_MAX_TOOL_CALLS,
 *     NormalizedToolCall)
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
 * so the runner can be tested in isolation. T12's production wiring (in
 * `src/index.ts`) constructs a real @mastra/core Agent and adapts its
 * `stream()` output to the `AsyncIterable<string>` signature.
 *
 * Cancellation contract (T12 #6): the runner respects `input.signal.aborted`
 * at every await point via the `abortable()` helper. Mid-stream abort surfaces
 * as AbortError from `streamAnswerDraft` and propagates out of the runner.
 *
 * Trace data aggregation: the runner returns a single MastraRunnerOutput with
 * aggregated trace data for the 4 progress stages (route/retrieval/context/
 * validation). Per-tool-call retrieval events from the complex loop are
 * folded into the final retrievalTrace (complexLoop summary + channel
 * statuses + aggregated result count). T14 owns the shadow-parity audit
 * that compares Mastra vs legacy event streams including per-tool-call
 * retrieval events.
 *
 * Helper duplication note: the helpers below (abortError, abortable,
 * abortableStream, diversifySelect, uniqueResults, normalizeGapQuery,
 * summarizeConversationForHandoff, saveValidatedTurnPair, triggerSummarization)
 * are duplicated from `src/mastra/simple_knowledge_runner.ts`. This is
 * intentional: T11 and T12 are sibling runners, and keeping them
 * self-contained avoids coupling between sibling modules. The helpers are
 * stable utility code (no expected changes); if duplication becomes a
 * maintenance burden, T13+ may extract them to a shared `_runner_helpers.ts`
 * module. See Karpathy guideline #3 (Surgical Changes).
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
import { formatToolInputSummary } from "../retrieval/tool_selector"
import type { Planner, DecomposeResult } from "../retrieval/planner/interface"
import { PlannerError } from "../retrieval/planner/planner"
import {
  runComplexLoop,
  COMPLEX_LOOP_MAX_ITERATIONS,
  COMPLEX_LOOP_MAX_TOOL_CALLS,
  type ComplexLoopController,
  type ComplexLoopResult,
  type NormalizedToolCall,
} from "../retrieval/complex_loop"
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
  RouteSubQuery,
  ContextTraceData,
  ValidationTraceData,
  TokenUsage,
} from "../types"

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * Streamed LLM answer draft for the complex knowledge route. Receives the
 * full AgentMessage[] (system prompt + user-with-context) and returns an
 * async iterable of token strings, mirroring `model.stream()` in legacy
 * `src/answer/generation.ts`. Same signature as T11's seam.
 */
export type KnowledgeAnswerDraftStream = (
  messages: AgentMessage[],
  signal: AbortSignal
) => AsyncIterable<string>

/**
 * Resolve tenantId from AccessContext. Same semantics as T11's resolver.
 */
export type TenantIdResolver = (accessContext: AccessContext) => string

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Error thrown when the route decision is not "complex". T12 owns only the
 * complex knowledge route; direct/ambiguous routes are owned by T09 and
 * simple route is owned by T11. The route-dispatch layer (T11 Step 3,
 * extended by T12 Step 3) catches this error and routes direct/ambiguous/
 * simple to their respective runners.
 *
 * Note: T09's `RouteNotSupportedError` throws for "complex". T11's
 * `RouteNotSimpleError` throws for "direct"/"ambiguous"/"complex". T12's
 * `RouteNotComplexError` throws for "direct"/"ambiguous"/"simple". The
 * three errors are distinct so the dispatch layer can compose all three
 * runners without ambiguity.
 */
export class RouteNotComplexError extends Error {
  constructor(public readonly decision: "direct" | "ambiguous" | "simple") {
    super(
      `Route "${decision}" is not supported by ComplexKnowledgeMastraRunner (T12). ` +
      `Supported route: complex. The route-dispatch layer should have routed this ` +
      `decision to the T09 DirectAmbiguousMastraRunner (direct/ambiguous) or the ` +
      `T11 SimpleKnowledgeMastraRunner (simple).`
    )
    this.name = "RouteNotComplexError"
  }
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface ComplexKnowledgeMastraRunnerDeps {
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
   * Legacy Planner — used for the multi-query fallback path when
   * `complexLoopController` is absent. When both are absent, the runner
   * cannot run the complex route and terminates with `provider_error`.
   * Optional for backward compat with callers that only wire the loop.
   */
  planner?: Planner
  /**
   * Ticket 08 — LLM-backed bounded retrieval loop controller. When present,
   * `runComplexLoop` runs instead of `planner.decompose`. When absent, the
   * runner falls back to the legacy multi-query planner flow.
   */
  complexLoopController?: ComplexLoopController
  /**
   * Ticket 61/04: LLM-backed Evidence-Context compressor. Optional — when
   * absent, the deterministic assembler output is used as-is. Also used as
   * the loop's observation compressor (when complexLoopController is wired).
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
   * recentTurns before Router classification. Optional.
   */
  contextualizer?: Contextualizer
  /**
   * Ticket 61/02: LLM-backed rolling-summary provider. Optional.
   */
  summarizer?: Summarizer
  /**
   * Ticket 09 P4: HandoffStore persistence. When present AND accessContext
   * is available, correction exhaustion terminates with `handoff_required`
   * instead of `insufficient_evidence`.
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
// Helpers (mirrors of T11 + legacy generation.ts internals)
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
 * Create a MastraRunner that handles the complex knowledge route.
 *
 * Throws `RouteNotComplexError` for direct/ambiguous/simple routes so the
 * route-dispatch layer (T11 Step 3, extended by T12 Step 3) can route them
 * to their respective runners. T12 owns only the complex route.
 *
 * Dual-path retrieval (GATE 1):
 *   - `complexLoopController` wired → `runComplexLoop` (bounded LLM loop)
 *   - else `planner` wired → `planner.decompose` multi-query flow
 *   - else → terminal `provider_error` (cannot run complex route)
 *
 * Correction round (T09 §13 reuse):
 *   - Initial run used complex loop AND controller still wired →
 *     `runComplexLoop` with reduced budgets + prior tool calls
 *   - Else → legacy single `searcher.search(gapQuery)` per gap query
 */
export function createComplexKnowledgeMastraRunner(
  deps: ComplexKnowledgeMastraRunnerDeps
): MastraRunner {
  const {
    router,
    createSearcher,
    assembler,
    validator,
    replanner,
    streamAnswerDraft,
    planner,
    complexLoopController,
    compressor,
    conversationStore,
    contextualizer,
    summarizer,
    handoffStore,
    resolveTenantId,
  } = deps
  const clock = deps.now ?? (() => new Date())

  return async function complexKnowledgeMastraRunner(
    input: MastraRunnerInput
  ): Promise<MastraRunnerOutput> {
    // T12 #6 cancellation checkpoint 1: before Router call (pre-route abort).
    if (input.signal.aborted) {
      throw abortError("GATE 0 (before route)")
    }

    const { signal, accessContext, sessionId, runId } = input
    const tenantId = resolveTenantId ? resolveTenantId(accessContext) : "default"
    const preparedRoute = input.preparedRoute

    // -------------------------------------------------------------------------
    // Memory loading + pending clarification consumption (mirrors T11 +
    // legacy generation.ts L437-L458).
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
    // Contextualization (mirrors T11 + legacy generation.ts L472-L502).
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

    if (decision !== "complex") {
      // T12 owns only the complex route. Throw RouteNotComplexError so the
      // route-dispatch layer can route direct/ambiguous to the T09 runner
      // and simple to the T11 runner.
      throw new RouteNotComplexError(decision)
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
    // GATE 1: retrieval (dual-path — complex loop OR planner.decompose).
    // -------------------------------------------------------------------------
    const searcher = createSearcher()
    const unavailableChannels = new Set<RetrievalResult["source"]>()
    let retrievalAttempted = false
    let retrievalAvailable = false
    const resultGroups: RetrievalResult[][] = []
    let coverageCriteria: string[] | undefined
    let complexLoopResult: ComplexLoopResult | undefined
    let complexLoopDurationMs: number | undefined
    let plannerModelCalls: number | undefined
    let plannerTokens: number | undefined
    let subQueryTrace: RouteSubQuery[] | undefined
    let plannerQueryCount: number | undefined
    const buildRouteTrace = (): RouteTraceData => ({
      ...(preparedRoute?.routeTrace ?? {}),
      decision: "complex",
      ...(complexLoopResult
        ? {
            complexLoopStopReason: complexLoopResult.stopReason,
            complexLoopIterations: complexLoopResult.iterationsExecuted,
            complexLoopToolCalls: complexLoopResult.toolCallsExecuted,
          }
        : {}),
      ...(plannerQueryCount !== undefined ? { queryCount: plannerQueryCount } : {}),
      ...(subQueryTrace ? { subQueries: subQueryTrace } : {}),
      ...(plannerModelCalls !== undefined ? { modelCalls: plannerModelCalls } : {}),
      ...(plannerTokens !== undefined ? { tokens: plannerTokens } : {}),
      ...(contextualizationOutcome ? { contextualizationOutcome } : {}),
      ...(contextualizationFailure ? { contextualizationFailure } : {}),
      ...(contextualizationUsage ? { contextualizationUsage } : {}),
      ...(contextualizationDurationMs != null ? { contextualizationDurationMs } : {}),
    })

    retrievalAttempted = true

    if (complexLoopController) {
      // ---------------------------------------------------------------------
      // Path A: bounded LLM-driven complex retrieval loop (T08 spec §13).
      // ---------------------------------------------------------------------
      const loopStartedAt = Date.now()
      // Adapter: bridge the loop's compressor interface (which expects
      // RetrievalResult[]) to the legacy ContextCompressor (which expects
      // Evidence[]) by building Evidence on-the-fly. Mirrors legacy L743-L756.
      const loopCompressor = compressor
        ? {
            compress: async (
              results: RetrievalResult[],
              query: string,
              budget: { maxContextTokens: number },
              sig?: AbortSignal
            ) => {
              const ev = buildEvidence(results)
              return compressor.compress(ev, query, budget, sig)
            },
          }
        : undefined
      try {
        complexLoopResult = await abortable(
          runComplexLoop(
            {
              controller: complexLoopController,
              searcher,
              assembler,
              ...(loopCompressor ? { compressor: loopCompressor } : {}),
            },
            {
              query: contextualizedQuery,
              ...(accessContext ? { accessContext } : {}),
              signal,
            }
          ),
          signal
        )
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err
        // Non-Abort loop error → terminal provider_error (mirrors legacy L773-780).
        return {
          reply: `Complex loop failed: ${err instanceof Error ? err.message : String(err)}`,
          status: "provider_error",
          references: [],
          degradation: {
            status: "insufficient",
            unavailableChannels: [...unavailableChannels],
          },
          tokens: [],
          routeTrace: buildRouteTrace(),
          retrievalTrace: {},
          contextTrace: {},
          validationTrace: {},
        }
      }
      complexLoopDurationMs = Date.now() - loopStartedAt

      // Populate retrieval tracking from loop result. The loop already
      // deduplicated results by chunk ID (criterion #4), so this is a
      // single group.
      retrievalAvailable = complexLoopResult.results.length > 0
      resultGroups.push(complexLoopResult.results)
      complexLoopResult.toolCalls.forEach((call) => {
        call.unavailableChannels.forEach((ch) => unavailableChannels.add(ch))
      })

      // T08: provider-failure means the searcher backend threw a non-Abort
      // error mid-loop. Terminate with provider_error (mirrors legacy L865).
      if (complexLoopResult.stopReason === "provider-failure") {
        return {
          reply: "Complex loop terminated: provider failure",
          status: "provider_error",
          references: [],
          degradation: {
            status: "insufficient",
            unavailableChannels: [...unavailableChannels],
          },
          tokens: [],
          routeTrace: buildRouteTrace(),
          retrievalTrace: {
            complexLoop: true,
            resultCount: complexLoopResult.results.length,
            selectedEvidenceIds: [],
            ...(unavailableChannels.size > 0
              ? { degradedReasons: [...unavailableChannels].map((ch) => `${ch} unavailable`) }
              : {}),
          },
          contextTrace: {},
          validationTrace: {},
        }
      }
    } else if (planner) {
      // ---------------------------------------------------------------------
      // Path B: legacy planner.decompose multi-query flow (backward compat
      // when complexLoopController is absent). Mirrors legacy L870-L953.
      // ---------------------------------------------------------------------
      let decomposeResult: DecomposeResult
      try {
        decomposeResult = await abortable(
          planner.decompose({ text: contextualizedQuery }),
          signal
        )
      } catch (err) {
        if (err instanceof PlannerError) {
          return {
            reply: `Planning failed: ${err.message}`,
            status: "provider_error",
            references: [],
            degradation: {
              status: "insufficient",
              unavailableChannels: [...unavailableChannels],
            },
            tokens: [],
            routeTrace: buildRouteTrace(),
            retrievalTrace: {},
            contextTrace: {},
            validationTrace: {},
          }
        }
        throw err
      }

      subQueryTrace = []
      const rewrittenQueries: Query[] = []
      const complexOptions: SearchOptions[] = []
      plannerModelCalls = 1
      plannerTokens = decomposeResult.usage?.totalTokens ?? 0
      for (const subQuery of decomposeResult.queries) {
        const rewriteResult = await abortable(planner.rewrite(subQuery), signal)
        plannerModelCalls += 1
        plannerTokens += rewriteResult.usage?.totalTokens ?? 0
        const rewrittenQuery = rewriteResult.query
        let seeds: string[] = []
        try {
          seeds = await abortable(planner.navigate(rewrittenQuery), signal)
          plannerModelCalls += 1
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") throw err
        }
        let hypothesis: string | undefined
        try {
          const hypothesisResult = await abortable(
            planner.generateHypothesis(rewrittenQuery),
            signal
          )
          plannerModelCalls += 1
          plannerTokens += hypothesisResult.usage?.totalTokens ?? 0
          hypothesis = hypothesisResult.text
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") throw err
        }
        subQueryTrace.push({
          original: subQuery.text,
          rewritten: rewrittenQuery.text,
          ...(subQuery.coverageCriteria
            ? { coverageCriteria: subQuery.coverageCriteria }
            : {}),
        })
        rewrittenQueries.push(rewrittenQuery)
        const options: SearchOptions = {}
        if (hypothesis && hypothesis.trim() && hypothesis !== rewrittenQuery.text) {
          options.hypothesis = hypothesis
        }
        if (seeds.length > 0) {
          options.graphSeeds = seeds
        }
        complexOptions.push(options)
      }
      plannerQueryCount = rewrittenQueries.length

      // Execute retrieval per rewritten sub-query.
      for (let i = 0; i < rewrittenQueries.length; i += 1) {
        const outcome = await abortable(
          searcher.search(rewrittenQueries[i], {
            ...complexOptions[i],
            accessContext,
            signal,
          }),
          signal
        )
        outcome.unavailableChannels.forEach((ch) => unavailableChannels.add(ch))
        if (outcome.status !== "insufficient") retrievalAvailable = true
        resultGroups.push(outcome.results)
      }

      // Collect coverage criteria from all sub-queries.
      const collectedCriteria = decomposeResult.queries
        .flatMap((q) => q.coverageCriteria ?? [])
      if (collectedCriteria.length > 0) {
        coverageCriteria = collectedCriteria
      }
    } else {
      // ---------------------------------------------------------------------
      // No planner AND no complexLoopController — cannot run complex route.
      // Terminal provider_error (mirrors the "missing dependency" case).
      // ---------------------------------------------------------------------
      return {
        reply: "Complex route requires either planner or complexLoopController",
        status: "provider_error",
        references: [],
        degradation: {
          status: "insufficient",
          unavailableChannels: [...unavailableChannels],
        },
        tokens: [],
        routeTrace: buildRouteTrace(),
        retrievalTrace: {},
        contextTrace: {},
        validationTrace: {},
      }
    }

    // -------------------------------------------------------------------------
    // Build the initial retrieval trace data (aggregated; final state).
    // -------------------------------------------------------------------------
    const channelStatuses = Object.fromEntries(
      (["vector", "bm25", "graph"] as const).map((channel) => [
        channel,
        unavailableChannels.has(channel) ? "unavailable" : "completed",
      ])
    )
    let retrievalTrace: RetrievalTraceData = {
      channelStatuses,
      resultCount: resultGroups.flat().length,
      selectedEvidenceIds: [],
      ...(unavailableChannels.size > 0
        ? { degradedReasons: [...unavailableChannels].map((ch) => `${ch} unavailable`) }
        : {}),
      ...(complexLoopResult
        ? {
            complexLoop: true,
            ...(complexLoopResult.toolCalls[0]?.tool
              ? { selectedTool: complexLoopResult.toolCalls[0].tool }
              : {}),
            ...(complexLoopResult.toolCalls[0]?.args
              ? {
                  toolInputSummary: formatToolInputSummary({
                    tool: complexLoopResult.toolCalls[0].tool,
                    args: complexLoopResult.toolCalls[0].args,
                  }),
                }
              : {}),
          }
        : {}),
    }

    // Insufficient retrieval check (T12 #7: terminal insufficient_retrieval).
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
    // Evidence building (T12 #4: rebuild from accumulated authorized Evidence).
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

    // Empty Evidence check (T12 #7: cannot complete without usable Evidence).
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
    // GATE 2: context assembly (T12 #4: bounded Context representation).
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
    // Optional compression (Ticket 61/04). Mirrors T11.
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
    // GATE 3: answer draft (LLM stream). Mirrors T11.
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

    // Citation check (T12 #5: unknown Citations rejected before publication).
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
    //
    // Dual-path correction (T09 §13 correction-round reuse):
    //   - Initial run used complex loop AND controller still wired →
    //     `runComplexLoop` with reduced budgets + prior tool calls
    //   - Else → legacy single `searcher.search(gapQuery)` per gap query
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

    // Shared budgets for correction-round reuse (T09 §13). Only populated
    // when the initial run used the complex loop AND the controller is
    // still available for correction. Mirrors legacy L1239-L1256.
    let sharedRemainingIterations: number | undefined
    let sharedRemainingToolCalls: number | undefined
    let sharedPriorToolCalls: NormalizedToolCall[] | undefined
    if (complexLoopResult && complexLoopController) {
      sharedRemainingIterations = Math.max(
        0,
        COMPLEX_LOOP_MAX_ITERATIONS - complexLoopResult.iterationsExecuted
      )
      sharedRemainingToolCalls = Math.max(
        0,
        COMPLEX_LOOP_MAX_TOOL_CALLS - complexLoopResult.toolCallsExecuted
      )
      sharedPriorToolCalls = complexLoopResult.toolCalls.map((c) => ({
        tool: c.tool,
        argsKey: c.argsKey,
      }))
    }

    for (let round = 0; round < 3; round += 1) {
      const verdict = await abortable(
        validator.validate(
          fullAnswer,
          [
            { role: "user", content: effectiveMessage },
            { role: "system", content: context },
          ],
          coverageCriteria,
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
        // Gap queries exhausted → handoff_required (if enabled) or
        // insufficient_evidence. Mirrors T11 + legacy L1313-L1346.
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

      // Correction retrieval: dual-path per gap query.
      let anyNewResults = false
      let correctionInsufficient = false
      for (const gapQuery of gapQueries) {
        if (
          complexLoopController &&
          sharedRemainingIterations !== undefined &&
          sharedRemainingToolCalls !== undefined &&
          sharedPriorToolCalls
        ) {
          // ---------------------------------------------------------------
          // Path A: complex loop reuse with shared budgets + prior tool
          // calls (T09 §13 correction-round reuse). Mirrors legacy
          // L1358-L1579.
          // ---------------------------------------------------------------
          const loopCompressor = compressor
            ? {
                compress: async (
                  results: RetrievalResult[],
                  q: string,
                  budget: { maxContextTokens: number },
                  sig?: AbortSignal
                ) => {
                  const ev = buildEvidence(results)
                  return compressor.compress(ev, q, budget, sig)
                },
              }
            : undefined
          let correctionLoopResult: ComplexLoopResult
          try {
            correctionLoopResult = await abortable(
              runComplexLoop(
                {
                  controller: complexLoopController,
                  searcher,
                  assembler,
                  ...(loopCompressor ? { compressor: loopCompressor } : {}),
                },
                {
                  query: gapQuery.text,
                  ...(accessContext ? { accessContext } : {}),
                  signal,
                  remainingIterations: sharedRemainingIterations,
                  remainingToolCalls: sharedRemainingToolCalls,
                  priorToolCalls: sharedPriorToolCalls,
                }
              ),
              signal
            )
          } catch (err) {
            if (err instanceof Error && err.name === "AbortError") throw err
            // Non-Abort loop error → deterministic fallback (criterion #5).
            // Mirrors legacy L1400-L1410.
            correctionLoopResult = {
              results: [],
              toolCalls: [],
              stopReason: "provider-failure",
              iterationsExecuted: 0,
              toolCallsExecuted: 0,
              finalObservation: "",
            }
          }

          // Update shared budgets for subsequent correction rounds
          // (criterion #2). Skip when the loop call threw (sentinel).
          // Mirrors legacy L1434-L1453.
          if (
            correctionLoopResult.iterationsExecuted > 0 ||
            correctionLoopResult.toolCallsExecuted > 0
          ) {
            sharedRemainingIterations = Math.max(
              0,
              sharedRemainingIterations - correctionLoopResult.iterationsExecuted
            )
            sharedRemainingToolCalls = Math.max(
              0,
              sharedRemainingToolCalls - correctionLoopResult.toolCallsExecuted
            )
            sharedPriorToolCalls = [
              ...sharedPriorToolCalls,
              ...correctionLoopResult.toolCalls.map((c) => ({
                tool: c.tool,
                argsKey: c.argsKey,
              })),
            ]
          }

          // Criterion #5: loop produced 0 new results + non-evidence-
          // sufficient → fall back to deterministic `searcher.search`.
          // Mirrors legacy L1514-L1572.
          const needsDeterministicFallback =
            correctionLoopResult.results.length === 0 &&
            correctionLoopResult.stopReason !== "evidence-sufficient"
          if (needsDeterministicFallback) {
            const fallbackOutcome = await abortable(
              searcher.search(gapQuery, { accessContext, signal }),
              signal
            )
            fallbackOutcome.unavailableChannels.forEach((ch) =>
              unavailableChannels.add(ch)
            )
            if (fallbackOutcome.status === "insufficient") {
              correctionInsufficient = true
              break
            }
            if (fallbackOutcome.results.length === 0) continue
            accumulatedResults.push(...fallbackOutcome.results)
            anyNewResults = true
          } else {
            // Loop produced results (or declared evidence-sufficient with 0
            // new results — treat as no new evidence for this gap query).
            if (correctionLoopResult.results.length === 0) continue
            accumulatedResults.push(...correctionLoopResult.results)
            anyNewResults = true
          }
        } else {
          // ---------------------------------------------------------------
          // Path B: legacy single searcher.search per gap query. Mirrors
          // T11 correction retrieval + legacy L1580-L1648.
          // ---------------------------------------------------------------
          const correctionOutcome = await abortable(
            searcher.search(gapQuery, { accessContext, signal }),
            signal
          )
          correctionOutcome.unavailableChannels.forEach((ch) =>
            unavailableChannels.add(ch)
          )
          if (correctionOutcome.status === "insufficient") {
            correctionInsufficient = true
            break
          }
          if (correctionOutcome.results.length === 0) continue
          accumulatedResults.push(...correctionOutcome.results)
          anyNewResults = true
        }
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
        // No new evidence from any gap query → exhausted. Mirrors T11.
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

      // Rebuild Evidence + Context from accumulated results, then
      // regenerate draft. Mirrors T11.
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
      // Citation check on regenerated draft (T12 #5).
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
    // GATE 5/6: publish or handoff. Mirrors T11.
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
      // Terminal non-completed path: do NOT save validated turns (T10 #2).
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

    // Approved: final citation check (T12 #5: at least one valid Citation).
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

    // Save validated turns + trigger summarization (T10 #2: only completed).
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
