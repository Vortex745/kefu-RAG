/**
 * Ticket 10 — Conversation Memory adapter for Mastra-powered Answer runs.
 *
 * Implements the T04 section 3 contract: a thin adapter that lets Mastra-
 * powered Answer runs consume and update the existing Conversation Memory
 * model (SqliteConversationStore + HandoffStore) without duplicating
 * persistence, bypassing ACL, or triggering summarization.
 *
 * Decision (T04 section 2.4): Option M2 — retain `SqliteConversationStore`
 * behind a Memory adapter. The adapter is a pure pass-through; it adds no
 * new persistence path. All 8 existing invariants (T04 section 1) are
 * preserved by delegating to the existing hardened store implementations.
 *
 * Boundary contract (T04 section 3 — 5 adapter rules, enforced structurally
 * by Ticket 10 tests):
 *   1. The adapter MUST NOT accept `tenantId` as a free-form tool argument.
 *      `tenantId` is sourced only from the runtime `AccessContext`. The
 *      adapter API uses Mastra's `resourceId` parameter name (which maps 1:1
 *      to `tenantId` per rule 5) — the runner extracts `tenantId` from
 *      `AccessContext` and passes it as `resourceId`.
 *   2. The adapter MUST NOT perform any SQL or call better-sqlite3 directly.
 *      All persistence goes through `ConversationStore` / `HandoffStore`
 *      interfaces.
 *   3. The adapter MUST NOT call `Summarizer.summarize()` — summarization
 *      is the Answer pipeline's responsibility (existing generation.ts call
 *      site). Adapter is persistence-only.
 *   4. The adapter MUST NOT cache `ConversationMemory` across requests —
 *      every `query()` call hits the store (preserves TTL + cross-tenant
 *      freshness).
 *   5. The adapter MUST translate Mastra's `threadId` -> `sessionId` and
 *      `resourceId` -> `tenantId` 1:1. No composite encoding (keeps the
 *      security boundary explicit).
 *
 * Boundary (T01 #6): this module MUST NOT statically import `@mastra/core`.
 * It defines the adapter shape inline (TypeScript structural typing) so the
 * runner can be tested without `@mastra/core`. The adapter is a pure
 * delegator — it does not implement Mastra's runtime `Memory` class; it
 * exposes the same operational surface that Mastra-powered runs need.
 *
 * Dependency direction (T02 #5): this module imports only from
 * `src/answer/conversation_store.ts` + `src/answer/handoff_store.ts`
 * (Repository layer) + `src/mastra/*` (Runtime layer). It MUST NOT import
 * `src/api/*` or `src/index`.
 */

import type {
  ConversationStore,
  ConversationMemory,
  ConversationTurn,
  RollingSummaryRecord,
} from "../answer/conversation_store"
import type { HandoffStore } from "../answer/handoff_store"

/**
 * A single message in the conversation memory, formatted for Mastra-facing
 * consumers. Mirrors the Mastra `MemoryMessage` shape (role + content +
 * createdAt) without taking a static `@mastra/memory` import.
 */
export interface MemoryMessage {
  role: "user" | "assistant"
  content: string
  createdAt: string
}

/**
 * Snapshot of conversation memory for a Tenant-bound session, formatted for
 * Mastra-facing consumers. Produced by {@link MastraMemoryAdapter.query}
 * from the raw `ConversationMemory` returned by the underlying store.
 *
 * - `summary`: rolling summary text (null when no checkpoint exists).
 * - `recentMessages`: at most 6 completed user/assistant pairs (<=12
 *   messages) in chronological order. A trailing unpaired user turn is
 *   dropped by the underlying store.
 * - `totalValidatedTurnCount`: total validated turn count for the session,
 *   exposed so the caller can decide whether to trigger summarization
 *   (T04 section 3: adapter does NOT trigger summarization itself; the
 *   caller — Answer pipeline or future ticket — owns that decision).
 */
export interface ConversationMemorySnapshot {
  summary: string | null
  recentMessages: MemoryMessage[]
  totalValidatedTurnCount: number
}

/**
 * Adapter that lets Mastra-powered Answer runs consume and update the
 * existing Conversation Memory model.
 *
 * Every method takes `threadId` (= sessionId) and `resourceId` (= tenantId)
 * per T04 section 3 rule 5. The runner extracts `tenantId` from the runtime
 * `AccessContext` (T04 section 3 rule 1) and passes it as `resourceId`.
 */
export interface MastraMemoryAdapter {
  /**
   * Load conversation memory for a Tenant-bound session.
   *
   * Maps Mastra's `query({ threadId, resourceId })` to
   * `ConversationStore.loadConversationMemory(sessionId=threadId,
   * tenantId=resourceId)`. The returned `ConversationMemory` is reformatted
   * as a `ConversationMemorySnapshot` (Mastra-facing shape).
   *
   * T10 acceptance criterion #5: if the underlying store throws, the adapter
   * degrades to an empty snapshot (no summary, no recent messages, zero
   * count). The run MUST NOT fail because memory load failed — the Mastra
   * Agent proceeds without context, matching the legacy safe-degradation
   * pattern (T04 section 1 invariant 7: summarizer safe-degradation).
   *
   * T04 section 3 rule 4: every call hits the store — no caching.
   */
  query(threadId: string, resourceId: string): ConversationMemorySnapshot

  /**
   * Save a validated turn after a run reaches `completed`.
   *
   * Maps Mastra's `add({ threadId, resourceId, message })` to
   * `ConversationStore.saveValidatedTurn(...)`. Per T04 section 3, this is
   * ONLY called after the run reaches `completed` (existing invariant:
   * failed / cancelled / pending content is NOT saved). The caller (runner)
   * is responsible for guarding this call on terminal status.
   *
   * T04 section 3: typically called twice per completed direct-route run —
   * once for the user message, once for the assistant reply. Each call
   * persists one row in `conversation_turns` with `kind='validated'`.
   */
  addValidatedTurn(args: {
    threadId: string
    resourceId: string
    role: "user" | "assistant"
    content: string
    runId: string
    createdAt: string
  }): void

  /**
   * Persist (or advance) the rolling summary checkpoint.
   *
   * Pass-through to `ConversationStore.saveRollingSummary`. Idempotent
   * (same checkpoint = no-op), monotonic forward-only (regression throws),
   * schema-versioned. The adapter does NOT call the summarizer — the
   * caller supplies the summary text (T04 section 3 rule 3).
   */
  saveRollingSummary(args: {
    threadId: string
    resourceId: string
    summary: string
    summarizedThroughTurnId: number
    schemaVersion: number
  }): void

  /**
   * Read the rolling summary checkpoint. Pass-through to
   * `ConversationStore.getRollingSummary`. Returns null when no summary
   * exists or when the (sessionId, tenantId) boundary conflicts with the
   * stored record (cross-tenant / cross-session isolation).
   */
  getRollingSummary(threadId: string, resourceId: string): RollingSummaryRecord | null

  /**
   * Handoff store delegate. T10 acceptance criterion #4: "Handoff uses the
   * same bounded memory projection as Answer contextualization." The adapter
   * delegates all 5 HandoffStore methods unchanged — no state-machine
   * re-implementation, no cross-tenant leak.
   *
   * Direct + ambiguous routes (T09) do NOT use Handoff; T12 (complex route)
   * will use Handoff via this delegate. The field is optional so direct/
   * ambiguous runner wiring (T10) can omit it without forcing a HandoffStore
   * dependency at construction time.
   */
  handoff?: HandoffStore
}

/**
 * Create a MastraMemoryAdapter that delegates to the existing repository
 * stores.
 *
 * @param deps.conversationStore Required — the persistence backend for
 *   conversation turns, pending clarifications, rolling summaries, and
 *   conversation memory assembly.
 * @param deps.handoffStore Optional — the persistence backend for Handoff
 *   cases. Direct + ambiguous routes don't use Handoff; T12 (complex route)
 *   will wire this.
 */
export function createMastraMemoryAdapter(deps: {
  conversationStore: ConversationStore
  handoffStore?: HandoffStore
}): MastraMemoryAdapter {
  const { conversationStore, handoffStore } = deps

  return {
    query(threadId: string, resourceId: string): ConversationMemorySnapshot {
      // T04 section 3 rule 5: threadId -> sessionId, resourceId -> tenantId,
      // 1:1, no composite encoding.
      const sessionId = threadId
      const tenantId = resourceId
      // T04 section 3 rule 4: no caching — every call hits the store.
      // T10 #5 safe-degradation: store error -> empty snapshot, never throws.
      let memory: ConversationMemory
      try {
        memory = conversationStore.loadConversationMemory(sessionId, tenantId)
      } catch {
        return {
          summary: null,
          recentMessages: [],
          totalValidatedTurnCount: 0,
        }
      }
      return formatMemorySnapshot(memory)
    },

    addValidatedTurn(args: {
      threadId: string
      resourceId: string
      role: "user" | "assistant"
      content: string
      runId: string
      createdAt: string
    }): void {
      const turn: ConversationTurn = {
        sessionId: args.threadId,
        tenantId: args.resourceId,
        role: args.role,
        content: args.content,
        runId: args.runId,
        createdAt: args.createdAt,
      }
      conversationStore.saveValidatedTurn(turn)
    },

    saveRollingSummary(args: {
      threadId: string
      resourceId: string
      summary: string
      summarizedThroughTurnId: number
      schemaVersion: number
    }): void {
      conversationStore.saveRollingSummary(
        args.threadId,
        args.resourceId,
        args.summary,
        args.summarizedThroughTurnId,
        args.schemaVersion
      )
    },

    getRollingSummary(threadId: string, resourceId: string): RollingSummaryRecord | null {
      return conversationStore.getRollingSummary(threadId, resourceId)
    },

    // T10 #4: Handoff delegate — pass-through, no re-implementation.
    // Optional so direct/ambiguous runner wiring can omit it.
    ...(handoffStore ? { handoff: handoffStore } : {}),
  }
}

/**
 * Format a raw `ConversationMemory` (repository shape) as a
 * `ConversationMemorySnapshot` (Mastra-facing shape).
 *
 * - `summary` is passed through verbatim (null when no checkpoint exists).
 * - `recentTurns` (ConversationTurn[]) is mapped to `recentMessages`
 *   (MemoryMessage[]) — only `role`, `content`, and `createdAt` are kept;
 *   `sessionId`, `tenantId`, and `runId` are NOT surfaced to Mastra-facing
 *   consumers (they are persistence-internal fields).
 * - `totalValidatedTurnCount` is passed through verbatim.
 *
 * `summarizedThroughTurnId`, `schemaVersion`, and `oldestRecentTurnId` are
 * NOT surfaced — they are caller-internal fields used by the Answer pipeline
 * to decide when to advance the rolling summary checkpoint. The adapter
 * does NOT trigger summarization (T04 section 3 rule 3).
 */
function formatMemorySnapshot(memory: ConversationMemory): ConversationMemorySnapshot {
  return {
    summary: memory.summary,
    recentMessages: memory.recentTurns.map((turn) => ({
      role: turn.role,
      content: turn.content,
      createdAt: turn.createdAt,
    })),
    totalValidatedTurnCount: memory.totalValidatedTurnCount,
  }
}

/**
 * Format a conversation memory snapshot as a context prefix for an LLM
 * prompt. Used by the DirectAmbiguousMastraRunner (T10) to prepend memory
 * context to the user's message before calling `streamDirectReply`.
 *
 * Format (mirrors legacy `generation.ts` contextualizer output):
 *   - When `summary` is non-null: a "Summary of earlier conversation:" line
 *     followed by the summary text.
 *   - When `recentMessages` is non-empty: a "Recent conversation:" line
 *     followed by one "role: content" line per message.
 *   - When both are empty: returns the empty string (no context prefix).
 *
 * The runner prepends this to the user's message with a blank-line separator
 * so the LLM sees: `[memory context]\n\n[user message]`. This matches the
 * legacy generation.ts pattern of building context from memory and passing
 * it as part of the prompt.
 *
 * Exported so Ticket 10 tests can verify the format directly.
 */
export function formatMemoryAsContext(snapshot: ConversationMemorySnapshot): string {
  const parts: string[] = []
  if (snapshot.summary !== null && snapshot.summary.length > 0) {
    parts.push(`Summary of earlier conversation:\n${snapshot.summary}`)
  }
  if (snapshot.recentMessages.length > 0) {
    const lines = snapshot.recentMessages.map(
      (msg) => `${msg.role}: ${msg.content}`
    )
    parts.push(`Recent conversation:\n${lines.join("\n")}`)
  }
  if (parts.length === 0) return ""
  return parts.join("\n\n")
}
