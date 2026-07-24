import type { DB } from "../ingestion/tracking/db"

/**
 * Ticket 05 P3: A session is bound to one Tenant and subject; conflicting
 * reuse is rejected rather than merged. This module owns the binding lifecycle
 * so that chat/ingestion handlers can verify session identity before running.
 *
 * P3 scope: module + schema + unit tests. Wiring into chat handler and 401/403
 * responses is P4.
 */
export interface SessionBinding {
  sessionId: string
  tenantId: string
  subjectId: string
  createdAt: string
}

export type BindResult =
  | { ok: true; bound: boolean; binding: SessionBinding }
  | { ok: false; conflict: { existing: SessionBinding } }

interface StoredBinding {
  session_id: string
  tenant_id: string
  subject_id: string
  created_at: string
}

function toBinding(row: StoredBinding): SessionBinding {
  return {
    sessionId: row.session_id,
    tenantId: row.tenant_id,
    subjectId: row.subject_id,
    createdAt: row.created_at,
  }
}

export class SqliteSessionBinder {
  constructor(private db: DB) {}

  /**
   * Bind a session to (tenantId, subjectId) on first sight, or verify the
   * existing binding matches. Returns:
   *   - { ok: true, bound: true }  — first bind, new row inserted
   *   - { ok: true, bound: false } — consistent reuse, existing row matches
   *   - { ok: false, conflict }    — session already bound to a different
   *                                  tenant/subject; existing binding preserved
   *
   * better-sqlite3 is synchronous, so SELECT-then-INSERT is race-free within
   * one process. Cross-process races are handled by PRIMARY KEY constraint +
   * the re-read fallback is unnecessary in single-process mode (P4 wiring
   * keeps one process per tenant).
   */
  bindOrCheck(sessionId: string, tenantId: string, subjectId: string): BindResult {
    const row = this.db.prepare(
      `SELECT session_id, tenant_id, subject_id, created_at
       FROM session_bindings
       WHERE session_id = ?`
    ).get(sessionId) as StoredBinding | undefined

    if (!row) {
      const now = new Date().toISOString()
      this.db.prepare(
        `INSERT INTO session_bindings (session_id, tenant_id, subject_id, created_at)
         VALUES (?, ?, ?, ?)`
      ).run(sessionId, tenantId, subjectId, now)
      return {
        ok: true,
        bound: true,
        binding: { sessionId, tenantId, subjectId, createdAt: now },
      }
    }

    const existing = toBinding(row)
    if (row.tenant_id === tenantId && row.subject_id === subjectId) {
      return { ok: true, bound: false, binding: existing }
    }
    return { ok: false, conflict: { existing } }
  }
}
