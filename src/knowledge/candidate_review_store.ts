import type { DB } from "../ingestion/tracking/db"
import { DocumentRepo } from "../ingestion/tracking/doc_repo"
import type {
  DocumentCandidateState,
  ReviewDecision,
} from "../types/governance"

/**
 * Ticket 11 Phase E P3 (spec §11 L1573-1575, L1580): CandidateReviewStore.
 *
 * Persists Document candidate review decisions with three invariants
 * mandated by spec §11:
 *
 * 1. State machine (L1573, L1575):
 *      pending_review → approved    (approve: activate via DocumentRepo.activate)
 *      pending_review → rejected    (reject: preserve previous active version)
 *    Repeating the same decision on a terminal state is idempotent (no-op,
 *    returns current state — preserves FIRST review's fields, NOT overwrite
 *    with subsequent call's actor/reason). Conflicting decision throws
 *    InvalidReviewConflictError (→ 409 per spec L1580).
 *
 * 2. Activation protection (L1575 "Approval activates the newest eligible
 *    candidate using the existing activation-order protection"):
 *    - On approve, calls DocumentRepo.activate(docId) which uses
 *      activation_order comparison to decide if this doc should become the
 *      active version. Older approved candidates do NOT overwrite newer
 *      active versions — the existing activation-order protection.
 *    - On reject, sources.active_doc_id is NOT changed (preserve previous
 *      active version per spec L1575).
 *
 * 3. Cross-tenant isolation (L1582):
 *    - getCandidate and review are both scoped by tenant_id.
 *    - Cross-tenant or missing document → null (404, never reveals existence).
 *
 * Reference: Ticket 09 SqliteHandoffStore (same Store pattern),
 * Ticket 11 P2 SqliteSourceLifecycleStore (state machine pattern).
 */

export interface CandidateEntry {
  docId: string
  tenantId: string
  sourceId: string | null
  candidateState: DocumentCandidateState
  reviewedBy: string | null
  reviewedAt: string | null
  reviewReason: string | null
  activationOrder: number | null
}

export interface ReviewResult {
  docId: string
  tenantId: string
  candidateState: DocumentCandidateState
  reviewedBy: string
  reviewedAt: string
  reviewReason: string
  /**
   * True if this review call caused sources.active_doc_id to change to this
   * document. False for:
   *   - reject (active version never changes)
   *   - approve of an older candidate (activation-order protection)
   *   - idempotent re-approve (no-op, no DB write)
   *   - approve when source has canonical_source_id (alias source —
   *     DocumentRepo.activate silently no-ops per its WHERE clause)
   */
  activatedAsActive: boolean
}

export interface CandidateReviewStore {
  /**
   * Get a document's candidate state, scoped to tenantId. Returns null if
   * the document doesn't exist OR belongs to a different tenant
   * (cross-tenant → 404 per spec L1582).
   */
  getCandidate(docId: string, tenantId: string): CandidateEntry | null

  /**
   * Apply a review decision (approve/reject) to a document.
   *
   * Idempotent (spec L1580): same decision on already-terminal state is a
   * no-op — preserves FIRST review's fields, returns current state without
   * a DB write.
   *
   * Conflict (spec L1580): conflicting decision on a terminal state throws
   * InvalidReviewConflictError (→ HTTP 409).
   *
   * Returns null if the document doesn't exist OR belongs to a different
   * tenant (cross-tenant → 404 per spec L1582).
   *
   * On approve:
   *   - Set candidate_state='approved', reviewed_by, reviewed_at, review_reason
   *   - Call DocumentRepo.activate(docId) to attempt activation. If this
   *     doc's activation_order > current active_doc_id's activation_order,
   *     sources.active_doc_id is updated; otherwise no-op (activation-order
   *     protection per spec L1575).
   *
   * On reject:
   *   - Set candidate_state='rejected', reviewed_by, reviewed_at, review_reason
   *   - Do NOT change sources.active_doc_id (preserve previous active version
   *     per spec L1575).
   */
  review(
    docId: string,
    tenantId: string,
    decision: ReviewDecision,
    reason: string,
    actor: string
  ): ReviewResult | null
}

/**
 * Thrown when review() requests a conflicting decision on a document that
 * is already in a terminal review state (approved/rejected). Carries the
 * current state and requested decision so the HTTP handler (P5) can surface
 * them in the 409 response body per spec L1580.
 */
export class InvalidReviewConflictError extends Error {
  constructor(
    public readonly docId: string,
    public readonly currentCandidateState: DocumentCandidateState,
    public readonly requestedDecision: ReviewDecision
  ) {
    super(
      `Conflicting review decision: document ${docId} is already ` +
        `${currentCandidateState}, cannot ${requestedDecision}`
    )
    this.name = "InvalidReviewConflictError"
  }
}

interface StoredCandidate {
  doc_id: string
  tenant_id: string
  source_id: string | null
  candidate_state: string
  reviewed_by: string | null
  reviewed_at: string | null
  review_reason: string | null
  activation_order: number | null
}

function rowToEntry(row: StoredCandidate): CandidateEntry {
  return {
    docId: row.doc_id,
    tenantId: row.tenant_id,
    sourceId: row.source_id,
    candidateState: row.candidate_state as DocumentCandidateState,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    reviewReason: row.review_reason,
    activationOrder: row.activation_order,
  }
}

/**
 * Map a DocumentCandidateState to the terminal decision that produced it.
 * Used to check idempotency: if current state is "approved" and decision is
 * "approve", it's idempotent; if decision is "reject", it's a conflict.
 */
const STATE_TO_DECISION: Record<"approved" | "rejected", ReviewDecision> = {
  approved: "approve",
  rejected: "reject",
}

export class SqliteCandidateReviewStore implements CandidateReviewStore {
  constructor(
    private db: DB,
    private documentRepo: DocumentRepo,
    private now: () => Date = () => new Date()
  ) {}

  getCandidate(docId: string, tenantId: string): CandidateEntry | null {
    const row = this.db.prepare(
      `SELECT doc_id, tenant_id, source_id, candidate_state,
              reviewed_by, reviewed_at, review_reason, activation_order
       FROM documents WHERE doc_id = ? AND tenant_id = ?`
    ).get(docId, tenantId) as StoredCandidate | undefined
    return row ? rowToEntry(row) : null
  }

  review(
    docId: string,
    tenantId: string,
    decision: ReviewDecision,
    reason: string,
    actor: string
  ): ReviewResult | null {
    const existing = this.db.prepare(
      `SELECT doc_id, tenant_id, source_id, candidate_state,
              reviewed_by, reviewed_at, review_reason, activation_order
       FROM documents WHERE doc_id = ? AND tenant_id = ?`
    ).get(docId, tenantId) as StoredCandidate | undefined
    if (!existing) return null

    const currentState = existing.candidate_state as DocumentCandidateState

    // Terminal state handling: idempotent or conflict
    if (currentState === "approved" || currentState === "rejected") {
      const priorDecision = STATE_TO_DECISION[currentState]
      if (priorDecision === decision) {
        // Idempotent: return current state, preserve first review's fields
        return {
          docId: existing.doc_id,
          tenantId: existing.tenant_id,
          candidateState: currentState,
          reviewedBy: existing.reviewed_by ?? "",
          reviewedAt: existing.reviewed_at ?? "",
          reviewReason: existing.review_reason ?? "",
          activatedAsActive: false,
        }
      }
      // Conflict: throw (→ 409 per spec L1580)
      throw new InvalidReviewConflictError(docId, currentState, decision)
    }

    // currentState === "pending_review" — perform the action
    const reviewedAt = this.now().toISOString()
    const newCandidateState: DocumentCandidateState =
      decision === "approve" ? "approved" : "rejected"

    this.db.prepare(
      `UPDATE documents
       SET candidate_state = ?, reviewed_by = ?, reviewed_at = ?, review_reason = ?,
           updated_at = ?
       WHERE doc_id = ? AND tenant_id = ?`
    ).run(
      newCandidateState,
      actor,
      reviewedAt,
      reason,
      reviewedAt,
      docId,
      tenantId
    )

    // On approve: attempt activation via DocumentRepo.activate (uses
    // existing activation-order protection per spec L1575). This is a
    // conditional UPDATE — only changes active_doc_id if this doc's
    // activation_order is higher than the current active.
    let activatedAsActive = false
    if (decision === "approve" && existing.source_id) {
      const beforeActive = this.getActiveDocId(existing.source_id)
      this.documentRepo.activate(docId)
      const afterActive = this.getActiveDocId(existing.source_id)
      activatedAsActive = afterActive === docId && beforeActive !== docId
    }

    return {
      docId,
      tenantId,
      candidateState: newCandidateState,
      reviewedBy: actor,
      reviewedAt,
      reviewReason: reason,
      activatedAsActive,
    }
  }

  private getActiveDocId(sourceId: string): string | null {
    const row = this.db.prepare(
      `SELECT active_doc_id FROM sources WHERE source_id = ?`
    ).get(sourceId) as { active_doc_id: string | null } | undefined
    return row?.active_doc_id ?? null
  }
}
