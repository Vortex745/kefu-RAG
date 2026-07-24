import type { DB } from "../ingestion/tracking/db"

/**
 * @deprecated Ticket 08 P5 (spec §7 L1538): pending clarification is now
 * absorbed into ConversationStore (savePendingClarification /
 * consumePendingClarification) to eliminate the dual session-history. This
 * module is retained for backward-compat reference only; the runtime no
 * longer wires SqliteClarificationStore. Do not add new callers.
 */
export interface PendingClarification {
  sessionId: string
  originalMessage: string
  missingFields: string[]
}

/**
 * @deprecated Ticket 08 P5 — see PendingClarification deprecation note.
 */
export interface ClarificationStore {
  savePending(
    sessionId: string,
    originalMessage: string,
    missingFields: string[]
  ): void
  consumePending(sessionId: string): PendingClarification | null
}

interface StoredPending {
  session_id: string
  original_message: string
  missing_fields_json: string
}

/**
 * @deprecated Ticket 08 P5 — see PendingClarification deprecation note.
 */
export class SqliteClarificationStore implements ClarificationStore {
  constructor(private db: DB) {}

  savePending(
    sessionId: string,
    originalMessage: string,
    missingFields: string[]
  ): void {
    const now = new Date().toISOString()
    this.db.prepare(
      `INSERT INTO clarification_pending (
        session_id, original_message, missing_fields_json, created_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        original_message = excluded.original_message,
        missing_fields_json = excluded.missing_fields_json,
        created_at = excluded.created_at`
    ).run(sessionId, originalMessage, JSON.stringify(missingFields), now)
  }

  consumePending(sessionId: string): PendingClarification | null {
    const row = this.db.prepare(
      `SELECT session_id, original_message, missing_fields_json
       FROM clarification_pending
       WHERE session_id = ?`
    ).get(sessionId) as StoredPending | undefined
    if (!row) return null
    this.db.prepare(
      `DELETE FROM clarification_pending WHERE session_id = ?`
    ).run(sessionId)
    return {
      sessionId: row.session_id,
      originalMessage: row.original_message,
      missingFields: JSON.parse(row.missing_fields_json) as string[],
    }
  }
}
