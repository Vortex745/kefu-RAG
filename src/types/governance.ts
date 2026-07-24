// Ticket 11 Phase E (spec §11 L1571-1583): Source governance lifecycle types.
//
// These types model the Source lifecycle (active → quarantined → retired) and
// Document candidate review (pending_review → approved | rejected) introduced
// by ACTIVATION_MODE=review. They are pure additive — no existing types are
// rewritten (spec L1573 "without rewriting immutable version identity").

/**
 * Spec L1573: Source lifecycle states.
 * - `active`: default compatibility behavior — Source is queryable.
 * - `quarantined`: intermediate state for investigation — still exists in
 *   the repository but is excluded from query results pending review.
 * - `retired`: terminal state — Source is hidden from active visibility and
 *   external cleanup has been enqueued. Spec L1593: a retired Source cannot
 *   be reactivated automatically.
 *
 * Legal transitions:
 *   active → quarantined
 *   active → retired
 *   quarantined → retired
 *   (retired is terminal — no outgoing transitions)
 */
export type SourceLifecycleState = "active" | "quarantined" | "retired"

/**
 * Spec L1573: Document candidate states.
 * - `pending_review`: only set when ACTIVATION_MODE=review (spec L1574);
 *   a completed candidate awaiting human approval before activation.
 * - `approved`: default for legacy and auto-mode rows — the candidate is
 *   eligible to be the active version.
 * - `rejected`: human reviewer rejected the candidate; actor, reason and
 *   timestamp are recorded while preserving the previous active version
 *   (spec L1575).
 */
export type DocumentCandidateState = "pending_review" | "approved" | "rejected"

/**
 * Spec L1574: ACTIVATION_MODE controls whether completed ingestion candidates
 * become active immediately (`auto`, default) or require explicit review
 * (`review`). Auto is the default compatibility behavior — existing flows
 * behave unchanged.
 */
export type ActivationMode = "auto" | "review"

/**
 * Spec L1578: Tombstones retain Source identity, retired version IDs, reason,
 * actor and timestamps. Physical content deletion follows retention policy
 * and does not reuse old IDs. Tombstones are append-only audit records — once
 * created, they are never modified or deleted; subsequent retirements of the
 * same Source create new tombstone rows.
 *
 * Note: source identity components (source_key, source_kind, source_uri,
 * namespace) are NOT copied into the tombstone — the sources row is the
 * source of truth and is preserved (with lifecycle_state='retired') for
 * audit. The tombstone only records the retirement event itself.
 */
export interface SourceTombstone {
  tombstoneId: string
  sourceId: string
  tenantId: string
  retiredVersionIds: string[]
  reason: string
  actor: string
  retiredAt: string
  createdAt: string
}

/**
 * Spec L1582: GET /api/sources/:sourceId/status returns Tenant-bound Source
 * lifecycle, active/candidate version identities and cleanup/dead-letter
 * summary without exposing raw content.
 *
 * `cleanupSummary` aggregates counts from task_pending_ops and
 * task_dead_letters for cleanup tasks (op IN cleanup_es, cleanup_neo4j,
 * cleanup_pageindex, cleanup_images) targeting this Source's documents.
 */
export interface SourceStatusSummary {
  sourceId: string
  tenantId: string
  lifecycleState: SourceLifecycleState
  activeDocId: string | null
  candidateDocIds: string[]
  lastTombstone: SourceTombstone | null
  cleanupSummary: {
    pending: number
    failed: number
    deadLettered: number
  }
}

/**
 * Spec L1580: POST /api/ingest/:docId/review accepts approve or reject plus
 * a bounded reason. Repeating the same decision is idempotent; a conflicting
 * decision returns 409.
 */
export type ReviewDecision = "approve" | "reject"

/**
 * Spec L1580: Review request body — decision, bounded reason, actor (subject
 * ID from AccessContext). The actor field is populated by the HTTP layer from
 * res.locals.accessContext.subjectId, NOT from the request body — this prevents
 * clients from spoofing reviewer identity.
 */
export interface ReviewRequest {
  decision: ReviewDecision
  reason: string
  actor: string
}
