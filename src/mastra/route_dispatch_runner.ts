/**
 * Ticket 11 + Ticket 12 — Route dispatch Mastra runner.
 *
 * Composes the T09 direct/ambiguous runner, the T11 simple knowledge runner,
 * and the T12 complex knowledge runner into a single `MastraRunner` that
 * handles ALL four route decisions:
 *
 *   - `simple`    → SimpleKnowledgeMastraRunner (T11 — retrieval → Evidence →
 *                   Context → Draft → Citation check → Critic loop → publish/
 *                   handoff)
 *   - `direct`    → DirectAmbiguousMastraRunner direct path (T09+T10 — stream
 *                   LLM reply, no retrieval/Evidence/Citation)
 *   - `ambiguous` → DirectAmbiguousMastraRunner ambiguous path (T09 —
 *                   clarification_required with pending-clarification persist)
 *   - `complex`   → ComplexKnowledgeMastraRunner (T12 — dual-path retrieval
 *                   via runComplexLoop OR planner.decompose → Evidence →
 *                   Context → Draft → Citation check → Critic loop with
 *                   correction-round budget reuse → publish/handoff). If
 *                   `complexRunner` is NOT wired, RouteNotSupportedError
 *                   reports an incomplete route-owner map.
 *
 * Dispatch prepares conversation context once, makes one authoritative route
 * decision, and invokes exactly one owner runner. The prepared route is passed
 * through `MastraRunnerInput`, so the owner does not repeat contextualization
 * or classification. Pending clarification uses peek-then-ack (P7.3): the
 * dispatcher peeks (non-destructive) before the route decision, then claims
 * (destructive) after the decision for non-ambiguous routes. Ambiguous
 * routes skip the claim — the owner's savePendingClarification atomically
 * replaces the old pending (DELETE+INSERT in one transaction).
 *
 * Boundary: this file is owned by `src/mastra/*` and MUST NOT import `src/api/*`
 * or `src/index` (T02 #5 dependency direction).
 */

import type {
  MastraRunner,
  MastraRunnerInput,
  MastraRunnerOutput,
} from "./chat_event_adapter"
import { RouteNotSupportedError } from "./direct_ambiguous_runner"
import type { Router } from "../retrieval/router/interface"
import type { ConversationStore } from "../answer/conversation_store"
import type { Contextualizer } from "../answer/contextualizer"
import type { AccessContext } from "../access/context"
import type { TokenUsage } from "../types"

/**
 * Dependencies for the route dispatch runner. All sub-runners are pre-built
 * (their own deps — Router, Searcher, Assembler, Validator, Planner,
 * ComplexLoopController, etc. — are injected at construction time by the
 * caller, typically `src/index.ts`).
 */
export interface RouteDispatchRunnerDeps {
  /** Authoritative route classifier. Called exactly once per run. */
  router: Router
  /** T11 simple knowledge route runner (retrieval → Evidence → ... → publish). */
  simpleRunner: MastraRunner
  /** T09 direct + ambiguous route runner (stream reply / clarification). */
  directAmbiguousRunner: MastraRunner
  /**
   * T12 complex knowledge route runner (dual-path retrieval → Evidence → ...
   * → publish). If absent, complex routes fail with RouteNotSupportedError.
   */
  complexRunner?: MastraRunner
  conversationStore?: ConversationStore
  contextualizer?: Contextualizer
  resolveTenantId?: (accessContext: AccessContext) => string
}

function abortError(checkpoint: string): Error {
  const error = new Error(`Answer run cancelled at ${checkpoint}`)
  error.name = "AbortError"
  return error
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError("route dispatch guard"))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError("route dispatch race"))
    signal.addEventListener("abort", onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      }
    )
  })
}

/**
 * Compose the T09 + T11 + T12 runners into a single route-aware MastraRunner.
 * The returned runner prepares conversation context and makes one
 * authoritative route decision before invoking exactly one owner runner.
 */
export function createRouteDispatchRunner(
  deps: RouteDispatchRunnerDeps
): MastraRunner {
  const {
    router,
    simpleRunner,
    directAmbiguousRunner,
    complexRunner,
    conversationStore,
    contextualizer,
    resolveTenantId,
  } = deps
  return async function routeDispatchRunner(
    input: MastraRunnerInput
  ): Promise<MastraRunnerOutput> {
    if (input.signal.aborted) throw abortError("GATE 0 (before route)")

    const tenantId = resolveTenantId
      ? resolveTenantId(input.accessContext)
      : "default"
    let pendingMessage: string | null = null
    if (conversationStore?.peekPendingClarification) {
      pendingMessage = conversationStore.peekPendingClarification(input.sessionId, tenantId)
    }
    const effectiveMessage = pendingMessage
      ? `${pendingMessage} ${input.message}`
      : input.message
    const memory = conversationStore?.loadConversationMemory(
      input.sessionId,
      tenantId
    )
    const recentTurns = memory?.recentTurns ?? []
    const conversationSummary = memory?.summary ?? null

    let contextualizedQuery = effectiveMessage
    let contextualizationFailure: string | undefined
    let contextualizationUsage: TokenUsage | undefined
    let contextualizationDurationMs: number | undefined
    let contextualizationOutcome: "success" | "skipped" | "failed" = "skipped"
    if (contextualizer && recentTurns.length > 0) {
      const startedAt = Date.now()
      try {
        const result = await abortable(
          contextualizer.contextualize(
            effectiveMessage,
            recentTurns,
            conversationSummary
          ),
          input.signal
        )
        contextualizationDurationMs = Date.now() - startedAt
        contextualizationUsage = result.usage
        if (result.query.trim()) {
          contextualizedQuery = result.query
          contextualizationOutcome = "success"
        } else {
          contextualizationFailure = "contextualize returned empty query"
          contextualizationOutcome = "failed"
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error
        contextualizationFailure = error instanceof Error ? error.message : String(error)
        contextualizationDurationMs = Date.now() - startedAt
        contextualizationOutcome = "failed"
      }
    }

    const decision = await abortable(
      router.decide({ text: contextualizedQuery }),
      input.signal
    )
    // P7.3 peek-then-ack: claim (destructive) the pending clarification now
    // that the route decision is authoritative. Non-ambiguous routes claim
    // because the owner (in dispatch mode with preparedRoute set) does not
    // re-peek/claim. Ambiguous routes skip the claim — the owner's
    // savePendingClarification atomically replaces the old pending via
    // DELETE+INSERT, so claiming here would create a lost-update window.
    if (conversationStore && pendingMessage !== null && decision !== "ambiguous") {
      if (conversationStore.claimPendingClarification) {
        conversationStore.claimPendingClarification(input.sessionId, tenantId)
      } else {
        conversationStore.consumePendingClarification(input.sessionId, tenantId)
      }
    }

    const ownerInput: MastraRunnerInput = {
      ...input,
      preparedRoute: {
        decision,
        effectiveMessage,
        contextualizedQuery,
        routeTrace: {
          decision,
          contextualizationOutcome,
          ...(contextualizationFailure ? { contextualizationFailure } : {}),
          ...(contextualizationUsage ? { contextualizationUsage } : {}),
          ...(contextualizationDurationMs != null ? { contextualizationDurationMs } : {}),
        },
      },
    }

    if (decision === "simple") return simpleRunner(ownerInput)
    if (decision === "direct" || decision === "ambiguous") {
      return directAmbiguousRunner(ownerInput)
    }
    if (!complexRunner) throw new RouteNotSupportedError("complex")
    return complexRunner(ownerInput)
  }
}
