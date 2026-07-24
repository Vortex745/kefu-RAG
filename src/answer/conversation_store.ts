import type { DB } from "../ingestion/tracking/db"

/**
 * Ticket 08 P1 — Server-side Conversation context (Phase B §7).
 *
 * A validated turn is a user or assistant message that reached a terminal
 * `completed` status. Failed, cancelled, policy-blocked and rejected Draft
 * content is NOT persisted here — callers must only invoke saveValidatedTurn
 * after the run reaches `completed`.
 *
 * Turns are stored per Tenant-bound session. loadRecentTurns enforces both
 * sessionId and tenantId filters so cross-tenant or cross-session reads
 * always return empty.
 *
 * Ticket 08 P5 (spec §7 L1538): pending clarifications are absorbed into
 * the same Conversation state via a `kind` discriminator column. Validated
 * turns (`kind='validated'`) feed contextualization; pending clarifications
 * (`kind='pending_clarification'`) are transient and excluded from
 * loadRecentTurns so they never leak into the contextualizer input.
 */
export interface ConversationTurn {
  sessionId: string
  tenantId: string
  role: "user" | "assistant"
  content: string
  runId: string
  createdAt: string
}

/**
 * Ticket 61 / 01 (spec §2 L1740): durable rolling summary record — one per
 * Tenant-bound session. `summarizedThroughTurnId` references the highest
 * `conversation_turns.id` folded into the summary; `schemaVersion` supports
 * forward-compatible summary format evolution (current = 1).
 */
export interface RollingSummaryRecord {
  sessionId: string
  tenantId: string
  summary: string
  summarizedThroughTurnId: number
  schemaVersion: number
  createdAt: string
  updatedAt: string
}

/**
 * Ticket 61 / 01 (spec §2 L1741): conversation memory assembled for
 * contextualization. `summary` is null when no rolling summary has been
 * checkpointed yet. `recentTurns` contains at most the latest six completed
 * user/assistant pairs (≤12 validated turns) in chronological order.
 *
 * Ticket 61 / 02: `totalValidatedTurnCount` and `oldestRecentTurnId` are
 * exposed so the caller can decide whether to advance the rolling summary
 * checkpoint after a turn completes. The caller computes
 * `newCheckpoint = oldestRecentTurnId - 1` and triggers summarization when
 * `totalValidatedTurnCount > 12 && newCheckpoint > (summarizedThroughTurnId ?? 0)`.
 */
export interface ConversationMemory {
  summary: string | null
  summarizedThroughTurnId: number | null
  schemaVersion: number | null
  recentTurns: ConversationTurn[]
  /**
   * Total validated turn count for the (sessionId, tenantId) boundary. Used
   * by the caller to detect "history exceeds the recent-pair window" (spec
   * §2 L1744). Pending-clarification rows are NOT counted.
   */
  totalValidatedTurnCount: number
  /**
   * Internal `conversation_turns.id` of the oldest turn in `recentTurns`,
   * or null when `recentTurns` is empty. The caller uses this to compute the
   * next summarization checkpoint: `newCheckpoint = oldestRecentTurnId - 1`.
   */
  oldestRecentTurnId: number | null
}

export interface ConversationStore {
  saveValidatedTurn(turn: ConversationTurn): void
  loadRecentTurns(
    sessionId: string,
    tenantId: string,
    limit: number
  ): ConversationTurn[]
  /**
   * Ticket 08 P5 (spec §7 L1538): persist a pending clarification for the
   * given Tenant-bound session, replacing any prior pending clarification
   * for the same (sessionId, tenantId). At most one pending row may exist
   * per session+tenant — multiple saves overwrite.
   */
  savePendingClarification(
    sessionId: string,
    tenantId: string,
    originalMessage: string
  ): void
  /** Read the current pending clarification without deleting it. Route
   * dispatch uses this to classify once before the selected owner consumes. */
  peekPendingClarification?(
    sessionId: string,
    tenantId: string
  ): string | null
  /** Atomically read and delete the current pending clarification. */
  claimPendingClarification?(
    sessionId: string,
    tenantId: string
  ): string | null
  /**
   * Ticket 08 P5 (spec §7 L1538): consume (read-and-delete) the pending
   * clarification for the given Tenant-bound session. Returns the original
   * message or null when no pending clarification exists. Destructive — a
   * second call returns null.
   */
  consumePendingClarification(
    sessionId: string,
    tenantId: string
  ): string | null
  /**
   * Ticket 08 P6 (spec §7 L1535): delete ALL turns (validated + pending
   * clarification) AND their rolling summaries for sessions whose most
   * recent activity (MAX(created_at)) predates the cutoff. Session-level
   * TTL — a session with any turn newer than the cutoff is preserved in
   * full (no row-level TTL). Returns the number of deleted turn rows.
   * Rolling summary deletions are NOT counted in the return value.
   * answer_run_events trace history is NOT touched.
   */
  deleteInactiveBefore(cutoffIso: string): number
  /**
   * Ticket 61 / 01 (spec §2 L1740, L1743): persist (or advance) the rolling
   * summary checkpoint for a Tenant-bound session. Idempotent — reprocessing
   * the same `summarizedThroughTurnId` is a no-op (existing record preserved,
   * `updatedAt` unchanged). A strictly greater `summarizedThroughTurnId`
   * advances the checkpoint (summary text + checkpoint + `updatedAt` updated).
   * A strictly smaller `summarizedThroughTurnId` throws — the checkpoint can
   * only advance forward, never regress.
   */
  saveRollingSummary(
    sessionId: string,
    tenantId: string,
    summary: string,
    summarizedThroughTurnId: number,
    schemaVersion: number
  ): void
  /**
   * Ticket 61 / 01 (spec §2 L1740): read the rolling summary checkpoint for
   * a Tenant-bound session. Returns null when no summary exists or when the
   * (sessionId, tenantId) boundary conflicts with the stored record (cross-
   * tenant / cross-session isolation).
   */
  getRollingSummary(
    sessionId: string,
    tenantId: string
  ): RollingSummaryRecord | null
  /**
   * Ticket 61 / 01 (spec §2 L1741): load conversation memory = rolling
   * summary (if present) + at most the latest six completed user/assistant
   * pairs (≤12 validated turns) in chronological order. A trailing unpaired
   * user turn (user sent a message but no validated assistant reply yet) is
   * excluded — only completed pairs are returned. Cross-tenant or cross-
   * session reads return empty `recentTurns` and null `summary`.
   */
  loadConversationMemory(
    sessionId: string,
    tenantId: string
  ): ConversationMemory
  /**
   * Ticket 61 / 02 (spec §2 L1744): load the validated turns with internal
   * `id` strictly greater than `fromIdExclusive` AND less than or equal to
   * `toIdInclusive`, in chronological (id-ascending) order. Used by the
   * Answer run pipeline to fetch the older validated turns that must be
   * folded into the rolling summary when the recent-pair window overflows.
   *
   * Returns an empty array when no turns match (caller treats this as "no
   * summarization work"). Cross-tenant or cross-session reads return empty.
   */
  loadOlderTurnsForSummarization(
    sessionId: string,
    tenantId: string,
    fromIdExclusive: number,
    toIdInclusive: number
  ): ConversationTurn[]
}

interface StoredTurn {
  id: number
  session_id: string
  tenant_id: string
  role: "user" | "assistant"
  content: string
  run_id: string
  created_at: string
}

export class SqliteConversationStore implements ConversationStore {
  constructor(private db: DB) {}

  saveValidatedTurn(turn: ConversationTurn): void {
    this.db.prepare(
      `INSERT INTO conversation_turns (
        session_id, tenant_id, role, content, run_id, created_at, kind
      ) VALUES (?, ?, ?, ?, ?, ?, 'validated')`
    ).run(
      turn.sessionId,
      turn.tenantId,
      turn.role,
      turn.content,
      turn.runId,
      turn.createdAt
    )
  }

  loadRecentTurns(
    sessionId: string,
    tenantId: string,
    limit: number
  ): ConversationTurn[] {
    const rows = this.db.prepare(
      `SELECT session_id, tenant_id, role, content, run_id, created_at
       FROM conversation_turns
       WHERE session_id = ? AND tenant_id = ? AND kind = 'validated'
       ORDER BY id DESC
       LIMIT ?`
    ).all(sessionId, tenantId, limit) as StoredTurn[]
    // ORDER BY id DESC returns newest first; reverse to chronological order
    // (oldest first) so callers can feed the array directly into a model
    // prompt as conversation history.
    return rows.reverse().map((row) => ({
      sessionId: row.session_id,
      tenantId: row.tenant_id,
      role: row.role,
      content: row.content,
      runId: row.run_id,
      createdAt: row.created_at,
    }))
  }

  savePendingClarification(
    sessionId: string,
    tenantId: string,
    originalMessage: string
  ): void {
    // At most one pending row per (sessionId, tenantId) — delete any prior
    // pending before inserting. Wrapped in a transaction so a crash between
    // DELETE and INSERT cannot leave the session without its latest pending.
    const now = new Date().toISOString()
    const tx = this.db.transaction(() => {
      this.db.prepare(
        `DELETE FROM conversation_turns
         WHERE session_id = ? AND tenant_id = ? AND kind = 'pending_clarification'`
      ).run(sessionId, tenantId)
      this.db.prepare(
        `INSERT INTO conversation_turns (
          session_id, tenant_id, role, content, run_id, created_at, kind
        ) VALUES (?, ?, 'user', ?, ?, ?, 'pending_clarification')`
      ).run(sessionId, tenantId, originalMessage, `pending:${now}`, now)
    })
    tx()
  }

  peekPendingClarification(
    sessionId: string,
    tenantId: string
  ): string | null {
    const row = this.db.prepare(
      `SELECT content
       FROM conversation_turns
       WHERE session_id = ? AND tenant_id = ? AND kind = 'pending_clarification'
       ORDER BY id DESC
       LIMIT 1`
    ).get(sessionId, tenantId) as { content: string } | undefined
    return row?.content ?? null
  }

  consumePendingClarification(
    sessionId: string,
    tenantId: string
  ): string | null {
    return this.claimPendingClarification(sessionId, tenantId)
  }

  claimPendingClarification(
    sessionId: string,
    tenantId: string
  ): string | null {
    const row = this.db.prepare(
      `DELETE FROM conversation_turns
       WHERE id = (
         SELECT id
         FROM conversation_turns
         WHERE session_id = ? AND tenant_id = ? AND kind = 'pending_clarification'
         ORDER BY id DESC
         LIMIT 1
       )
       RETURNING content`
    ).get(sessionId, tenantId) as { content: string } | undefined
    return row?.content ?? null
  }

  deleteInactiveBefore(cutoffIso: string): number {
    // Session-level TTL: delete ALL turns for sessions whose MAX(created_at)
    // predates the cutoff. A session with any turn newer than the cutoff is
    // preserved in full (no row-level TTL). The subquery groups by session_id
    // (tenant-agnostic — a session_id is globally unique per P1 isolation).
    //
    // Ticket 61 / 01 (spec §2 L1747): rolling summaries for the same inactive
    // sessions are deleted in the SAME transaction so turns and summary are
    // removed together. The return value counts ONLY turn rows (preserves
    // the existing P6 contract — callers asserting on turn counts are
    // unaffected). Summary deletions are a side effect, not counted.
    const tx = this.db.transaction(() => {
      const inactiveSessions = this.db.prepare(
        `SELECT DISTINCT session_id
         FROM conversation_turns
         GROUP BY session_id
         HAVING MAX(created_at) < ?`
      ).all(cutoffIso) as Array<{ session_id: string }>
      if (inactiveSessions.length === 0) return 0
      const sessionIds = inactiveSessions.map((row) => row.session_id)
      const placeholders = sessionIds.map(() => "?").join(",")
      const turnsResult = this.db.prepare(
        `DELETE FROM conversation_turns WHERE session_id IN (${placeholders})`
      ).run(...sessionIds)
      this.db.prepare(
        `DELETE FROM conversation_rolling_summaries WHERE session_id IN (${placeholders})`
      ).run(...sessionIds)
      return turnsResult.changes
    })
    return tx()
  }

  // Ticket 61 / 01 (spec §2 L1740-1748): rolling summary checkpoint +
  // conversation memory assembly. See interface docs for the full contract.
  saveRollingSummary(
    sessionId: string,
    tenantId: string,
    summary: string,
    summarizedThroughTurnId: number,
    schemaVersion: number
  ): void {
    const now = new Date().toISOString()
    const tx = this.db.transaction(() => {
      const existing = this.db.prepare(
        `SELECT summarized_through_turn_id, summary, created_at, updated_at
         FROM conversation_rolling_summaries
         WHERE session_id = ? AND tenant_id = ?`
      ).get(sessionId, tenantId) as {
        summarized_through_turn_id: number
        summary: string
        created_at: string
        updated_at: string
      } | undefined
      if (!existing) {
        this.db.prepare(
          `INSERT INTO conversation_rolling_summaries (
            session_id, tenant_id, summary, summarized_through_turn_id,
            schema_version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          sessionId, tenantId, summary, summarizedThroughTurnId,
          schemaVersion, now, now
        )
        return
      }
      // Idempotent: same checkpoint → no-op. Spec §2 L1743: "Reprocessing
      // the same validated turn range must not change the checkpoint or
      // duplicate facts." Existing record preserved (including updatedAt).
      if (existing.summarized_through_turn_id === summarizedThroughTurnId) {
        return
      }
      // Regression: strictly smaller checkpoint → throw. Spec §2 L1743:
      // checkpoint can only advance forward. The transaction rolls back so
      // the existing record is preserved unchanged.
      if (existing.summarized_through_turn_id > summarizedThroughTurnId) {
        throw new Error(
          `saveRollingSummary: checkpoint regression rejected (existing=${existing.summarized_through_turn_id}, requested=${summarizedThroughTurnId}) for session=${sessionId} tenant=${tenantId}`
        )
      }
      // Advance: strictly greater checkpoint → UPDATE summary + checkpoint +
      // schemaVersion + updatedAt. createdAt is preserved.
      this.db.prepare(
        `UPDATE conversation_rolling_summaries
         SET summary = ?, summarized_through_turn_id = ?, schema_version = ?, updated_at = ?
         WHERE session_id = ? AND tenant_id = ?`
      ).run(summary, summarizedThroughTurnId, schemaVersion, now, sessionId, tenantId)
    })
    tx()
  }

  getRollingSummary(
    sessionId: string,
    tenantId: string
  ): RollingSummaryRecord | null {
    const row = this.db.prepare(
      `SELECT session_id, tenant_id, summary, summarized_through_turn_id,
        schema_version, created_at, updated_at
       FROM conversation_rolling_summaries
       WHERE session_id = ? AND tenant_id = ?`
    ).get(sessionId, tenantId) as {
      session_id: string
      tenant_id: string
      summary: string
      summarized_through_turn_id: number
      schema_version: number
      created_at: string
      updated_at: string
    } | undefined
    if (!row) return null
    return {
      sessionId: row.session_id,
      tenantId: row.tenant_id,
      summary: row.summary,
      summarizedThroughTurnId: row.summarized_through_turn_id,
      schemaVersion: row.schema_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  loadConversationMemory(
    sessionId: string,
    tenantId: string
  ): ConversationMemory {
    // Spec §2 L1741: "Conversation memory is assembled as one older-history
    // summary plus the most recent six completed user/assistant pairs verbatim."
    // Spec §2 L1742: caller maintains the disjoint invariant (turns preceding
    // the recent window are summarized; recent window turns are NOT filtered
    // by summarizedThroughTurnId here — that would double-count or hide turns
    // if the caller lagged behind on summarization).
    const summary = this.getRollingSummary(sessionId, tenantId)
    // LIMIT 13 = 6 pairs (12 turns) + 1 potential trailing unpaired user.
    // Taking 13 lets us detect & drop a trailing user before slicing to 12.
    const rows = this.db.prepare(
      `SELECT id, session_id, tenant_id, role, content, run_id, created_at
       FROM conversation_turns
       WHERE session_id = ? AND tenant_id = ? AND kind = 'validated'
       ORDER BY id DESC
       LIMIT 13`
    ).all(sessionId, tenantId) as StoredTurn[]
    // ORDER BY id DESC returns newest first; reverse to chronological (oldest
    // first among the recent 13) so callers can feed the array directly into
    // a model prompt as conversation history.
    const chronological = rows.reverse()
    // Drop trailing unpaired user turn (user sent a message but no validated
    // assistant reply yet). Only completed user/assistant pairs are returned.
    if (
      chronological.length > 0 &&
      chronological[chronological.length - 1].role === "user"
    ) {
      chronological.pop()
    }
    // Cap at 12 turns (6 pairs). If we loaded 13 (none trailing), the oldest
    // — which may be an unpaired assistant whose user precedes the window —
    // is naturally dropped by the slice.
    const capped = chronological.length > 12
      ? chronological.slice(-12)
      : chronological
    const recentTurns = capped.map((row) => ({
      sessionId: row.session_id,
      tenantId: row.tenant_id,
      role: row.role,
      content: row.content,
      runId: row.run_id,
      createdAt: row.created_at,
    }))
    // Ticket 61 / 02: total validated turn count drives the caller's
    // "history exceeds the recent-pair window" check (spec §2 L1744). A
    // separate COUNT(*) query is cheaper than re-loading all turns just to
    // count them. Pending-clarification rows are NOT counted.
    const countRow = this.db.prepare(
      `SELECT COUNT(*) AS n
       FROM conversation_turns
       WHERE session_id = ? AND tenant_id = ? AND kind = 'validated'`
    ).get(sessionId, tenantId) as { n: number }
    const totalValidatedTurnCount = countRow.n
    // `capped[0].id` is the oldest turn id in the recent window (after the
    // trailing-user drop and slice-to-12). Null when the session has no
    // validated turns.
    const oldestRecentTurnId = capped.length > 0 ? capped[0].id : null
    return {
      summary: summary?.summary ?? null,
      summarizedThroughTurnId: summary?.summarizedThroughTurnId ?? null,
      schemaVersion: summary?.schemaVersion ?? null,
      recentTurns,
      totalValidatedTurnCount,
      oldestRecentTurnId,
    }
  }

  loadOlderTurnsForSummarization(
    sessionId: string,
    tenantId: string,
    fromIdExclusive: number,
    toIdInclusive: number
  ): ConversationTurn[] {
    // Spec §2 L1744: the caller passes `fromIdExclusive = summarizedThroughTurnId ?? 0`
    // and `toIdInclusive = oldestRecentTurnId - 1` to fetch the validated
    // turns that must be folded into the rolling summary. Returns ascending
    // by id so the summarizer receives them in chronological order.
    if (toIdInclusive <= fromIdExclusive) return []
    const rows = this.db.prepare(
      `SELECT id, session_id, tenant_id, role, content, run_id, created_at
       FROM conversation_turns
       WHERE session_id = ? AND tenant_id = ? AND kind = 'validated'
         AND id > ? AND id <= ?
       ORDER BY id ASC`
    ).all(sessionId, tenantId, fromIdExclusive, toIdInclusive) as StoredTurn[]
    return rows.map((row) => ({
      sessionId: row.session_id,
      tenantId: row.tenant_id,
      role: row.role,
      content: row.content,
      runId: row.run_id,
      createdAt: row.created_at,
    }))
  }
}
