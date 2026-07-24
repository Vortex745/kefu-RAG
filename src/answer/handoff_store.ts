import { randomUUID } from "node:crypto"
import type { DB } from "../ingestion/tracking/db"
import type {
  HandoffCase,
  HandoffReasonCode,
  HandoffState,
} from "../types/answer"

/**
 * Ticket 09 P2 — Handoff and Feedback contracts (Phase C §8).
 *
 * HandoffStore persists Handoff cases with three invariants mandated by
 * spec §8:
 *
 * 1. Idempotent creation by run_id (L1544) — the first create for a given
 *    run_id wins; subsequent creates with different fields return the original
 *    case unchanged. Enforced structurally by `handoff_cases.run_id UNIQUE`
 *    plus `INSERT OR IGNORE`.
 *
 * 2. State machine (L1550) — legal transitions are:
 *      open → claimed → resolved
 *      open → cancelled
 *      claimed → cancelled
 *    All other transitions throw InvalidHandoffTransitionError (→ HTTP 409).
 *
 * 3. Cross-tenant isolation (L1552) — every read/write is scoped by tenant_id.
 *    A case that exists but belongs to a different tenant is indistinguishable
 *    from a non-existent case (returns null → HTTP 404), so the store never
 *    reveals that a cross-tenant resource exists.
 */

export interface HandoffCreateInput {
  runId: string
  tenantId: string
  subjectId: string
  sessionId: string
  reasonCode: HandoffReasonCode
  userRequest: string
  conversationSummary: string
  evidenceIds: string[]
  traceReference: string
}

export interface HandoffStore {
  /**
   * Create a Handoff case or return the existing case for the same run_id.
   * Idempotent by run_id (spec L1544) — the first creation's fields win.
   * Returns null when a case already exists for the run_id but belongs to a
   * different tenant (cross-tenant → 404 per spec L1552, without revealing
   * existence).
   */
  create(input: HandoffCreateInput): HandoffCase | null

  /**
   * Get a Handoff case by case ID, scoped to tenantId. Returns null if the
   * case doesn't exist OR belongs to a different tenant (cross-tenant → 404).
   */
  getById(caseId: string, tenantId: string): HandoffCase | null

  /**
   * Get a Handoff case by run ID, scoped to tenantId. Returns null if the
   * case doesn't exist OR belongs to a different tenant.
   */
  getByRunId(runId: string, tenantId: string): HandoffCase | null

  /**
   * List Handoff cases for a tenant, optionally filtered by status (spec L1550
   * GET /api/handoffs?status=). Always tenant-scoped — never leaks
   * cross-tenant cases. Ordered by created_at DESC (newest first).
   */
  listByTenant(tenantId: string, status?: HandoffState): HandoffCase[]

  /**
   * Update a Handoff case's status via the legal state machine (spec L1550):
   *   open → claimed → resolved
   *   open → cancelled
   *   claimed → cancelled
   * All other transitions throw InvalidHandoffTransitionError (→ 409 per
   * spec L1552). Cross-tenant or missing case returns null (→ 404).
   * Returns the updated case on success.
   */
  updateStatus(
    caseId: string,
    tenantId: string,
    newStatus: HandoffState
  ): HandoffCase | null
}

/**
 * Thrown when an updateStatus call requests a transition that is not in the
 * legal state machine. Carries from/to status so the HTTP handler (P5) can
 * surface them in the 409 response body.
 */
export class InvalidHandoffTransitionError extends Error {
  constructor(
    public readonly fromStatus: HandoffState,
    public readonly toStatus: HandoffState
  ) {
    super(`Invalid handoff transition: ${fromStatus} → ${toStatus}`)
    this.name = "InvalidHandoffTransitionError"
  }
}

/**
 * Legal state transitions per spec L1550:
 *   open → claimed → resolved
 *   open → cancelled
 *   claimed → cancelled
 * `resolved` and `cancelled` are terminal (empty arrays).
 */
const VALID_TRANSITIONS: Record<HandoffState, HandoffState[]> = {
  open: ["claimed", "cancelled"],
  claimed: ["resolved", "cancelled"],
  resolved: [],
  cancelled: [],
}

interface StoredHandoffCase {
  id: string
  run_id: string
  tenant_id: string
  subject_id: string
  session_id: string
  reason_code: HandoffReasonCode
  user_request: string
  conversation_summary: string
  evidence_ids: string // JSON array string
  trace_reference: string
  status: HandoffState
  created_at: string
  updated_at: string
}

function rowToCase(row: StoredHandoffCase): HandoffCase {
  return {
    id: row.id,
    runId: row.run_id,
    tenantId: row.tenant_id,
    subjectId: row.subject_id,
    sessionId: row.session_id,
    reasonCode: row.reason_code,
    userRequest: row.user_request,
    conversationSummary: row.conversation_summary,
    evidenceIds: JSON.parse(row.evidence_ids),
    traceReference: row.trace_reference,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class SqliteHandoffStore implements HandoffStore {
  constructor(
    private db: DB,
    private now: () => Date = () => new Date()
  ) {}

  create(input: HandoffCreateInput): HandoffCase | null {
    const now = this.now().toISOString()
    const id = randomUUID()
    const evidenceIdsJson = JSON.stringify(input.evidenceIds)
    // INSERT OR IGNORE: if a case already exists for this run_id (UNIQUE
    // constraint), the INSERT is silently skipped — idempotent create per
    // spec L1544. The first creation's fields win; subsequent creates with
    // different input are no-ops.
    this.db.prepare(
      `INSERT OR IGNORE INTO handoff_cases (
        id, run_id, tenant_id, subject_id, session_id, reason_code,
        user_request, conversation_summary, evidence_ids, trace_reference,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
    ).run(
      id,
      input.runId,
      input.tenantId,
      input.subjectId,
      input.sessionId,
      input.reasonCode,
      input.userRequest,
      input.conversationSummary,
      evidenceIdsJson,
      input.traceReference,
      now,
      now
    )
    // SELECT by run_id AND tenant_id: if the existing case belongs to a
    // different tenant (cross-tenant conflict on run_id UNIQUE), this returns
    // null — hiding the existence of the other tenant's case per spec L1552.
    const row = this.db.prepare(
      `SELECT * FROM handoff_cases WHERE run_id = ? AND tenant_id = ?`
    ).get(input.runId, input.tenantId) as StoredHandoffCase | undefined
    return row ? rowToCase(row) : null
  }

  getById(caseId: string, tenantId: string): HandoffCase | null {
    const row = this.db.prepare(
      `SELECT * FROM handoff_cases WHERE id = ? AND tenant_id = ?`
    ).get(caseId, tenantId) as StoredHandoffCase | undefined
    return row ? rowToCase(row) : null
  }

  getByRunId(runId: string, tenantId: string): HandoffCase | null {
    const row = this.db.prepare(
      `SELECT * FROM handoff_cases WHERE run_id = ? AND tenant_id = ?`
    ).get(runId, tenantId) as StoredHandoffCase | undefined
    return row ? rowToCase(row) : null
  }

  listByTenant(tenantId: string, status?: HandoffState): HandoffCase[] {
    const rows = status
      ? (this.db.prepare(
          `SELECT * FROM handoff_cases WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC`
        ).all(tenantId, status) as StoredHandoffCase[])
      : (this.db.prepare(
          `SELECT * FROM handoff_cases WHERE tenant_id = ? ORDER BY created_at DESC`
        ).all(tenantId) as StoredHandoffCase[])
    return rows.map(rowToCase)
  }

  updateStatus(
    caseId: string,
    tenantId: string,
    newStatus: HandoffState
  ): HandoffCase | null {
    // SELECT first to verify the case exists AND belongs to this tenant.
    // Cross-tenant or missing → null (404), NOT throw — spec L1552 distinguishes
    // 404 (not found / cross-tenant) from 409 (invalid transition).
    const existing = this.db.prepare(
      `SELECT * FROM handoff_cases WHERE id = ? AND tenant_id = ?`
    ).get(caseId, tenantId) as StoredHandoffCase | undefined
    if (!existing) return null

    const currentStatus = existing.status as HandoffState
    if (!VALID_TRANSITIONS[currentStatus].includes(newStatus)) {
      throw new InvalidHandoffTransitionError(currentStatus, newStatus)
    }

    const updatedAt = this.now().toISOString()
    this.db.prepare(
      `UPDATE handoff_cases SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`
    ).run(newStatus, updatedAt, caseId, tenantId)
    return rowToCase({
      ...existing,
      status: newStatus,
      updated_at: updatedAt,
    })
  }
}
