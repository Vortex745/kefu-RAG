import { randomUUID } from "node:crypto"
import type { DB } from "../ingestion/tracking/db"
import type {
  Feedback,
  FeedbackRating,
  FeedbackReasonCode,
} from "../types/answer"

/**
 * Ticket 09 P3 — Handoff and Feedback contracts (Phase C §8).
 *
 * FeedbackStore persists subject Feedback for Answer runs with three
 * invariants mandated by spec §8:
 *
 * 1. One current Feedback per (tenant, subject, run) (L1548) — enforced
 *    structurally by `feedback.UNIQUE(tenant_id, subject_id, run_id)` plus
 *    SQLite native `INSERT ... ON CONFLICT DO UPDATE`. Resubmission updates
 *    the existing row in place: `id` and `created_at` are preserved, all
 *    submitted fields are overwritten, `updated_at` is refreshed.
 *
 * 2. Reason code validation (L1547, L1552 "Invalid reason codes → 400"):
 *    The 6 reason codes are explicitly called "negative reason codes" in the
 *    spec, so they apply only to `down` ratings. Strict validation:
 *      - rating='down' → reasonCode MUST be one of the 6 codes (required)
 *      - rating='up'   → reasonCode MUST be null (positive feedback has no
 *        negative reason)
 *    Violations throw InvalidFeedbackReasonCodeError (→ HTTP 400). This
 *    matches the schema comment in db.ts: "reason_code is nullable (null for
 *    'up' ratings; required for 'down')".
 *
 * 3. Cross-tenant isolation (L1552) — every read is scoped by tenant_id (and
 *    subject_id for getByRunId). Cross-tenant or cross-subject reads return
 *    null (→ 404) without revealing that a record exists. The UNIQUE key
 *    includes tenant_id, so upsert can never collide across tenants.
 *
 * Spec L1548 also states "Feedback never mutates the historical Answer run
 * events." This store touches ONLY the `feedback` table — it never writes to
 * `answer_run_events`. Enforcement is structural: no SQL in this module
 * references answer_run_events.
 */

export interface FeedbackUpsertInput {
  runId: string
  tenantId: string
  subjectId: string
  rating: FeedbackRating
  reasonCode: FeedbackReasonCode | null
  comment: string | null
  evidenceIds: string[]
}

export interface FeedbackStore {
  /**
   * Upsert Feedback for the (tenant, subject, run) triple. Spec L1548:
   * one current Feedback per triple; resubmission updates. Always returns
   * the stored record after insert/update (never null — upsert always
   * succeeds once validation passes).
   *
   * Throws InvalidFeedbackReasonCodeError (→ HTTP 400) when reasonCode
   * validation fails.
   */
  upsert(input: FeedbackUpsertInput): Feedback

  /**
   * Get the current Feedback for the (run, tenant, subject) triple.
   * Returns null if no feedback exists OR the triple belongs to a different
   * tenant/subject (cross-tenant/cross-subject → 404 per spec L1552).
   */
  getByRunId(
    runId: string,
    tenantId: string,
    subjectId: string
  ): Feedback | null

  /**
   * List Feedback for a tenant, optionally filtered by subjectId and/or
   * rating. Always tenant-scoped — never leaks cross-tenant records.
   * Ordered by updated_at DESC (most recently updated first).
   */
  listByTenant(
    tenantId: string,
    options?: { subjectId?: string; rating?: FeedbackRating }
  ): Feedback[]
}

/**
 * Thrown when upsert is called with a reasonCode that violates the strict
 * validation rules (L1547 + L1552 → HTTP 400). Carries rating + reasonCode
 * so the HTTP handler (P6) can surface them in the 400 response body.
 */
export class InvalidFeedbackReasonCodeError extends Error {
  constructor(
    public readonly rating: FeedbackRating,
    public readonly reasonCode: FeedbackReasonCode | null
  ) {
    super(
      `Invalid reason code for rating='${rating}': ${reasonCode ?? "null"}`
    )
    this.name = "InvalidFeedbackReasonCodeError"
  }
}

/**
 * Spec L1547: the 6 supported negative reason codes. Apply only to `down`.
 */
const VALID_REASON_CODES: ReadonlySet<FeedbackReasonCode> = new Set([
  "wrong_answer",
  "wrong_citation",
  "incomplete",
  "stale_knowledge",
  "unwanted_handoff",
  "other",
])

/**
 * Validate reasonCode against the strict rules (spec L1547 + L1552 + db.ts
 * schema comment). Throws InvalidFeedbackReasonCodeError on violation.
 */
function validateReasonCode(
  rating: FeedbackRating,
  reasonCode: FeedbackReasonCode | null
): void {
  if (rating === "down") {
    if (reasonCode === null || !VALID_REASON_CODES.has(reasonCode)) {
      throw new InvalidFeedbackReasonCodeError(rating, reasonCode)
    }
  } else {
    // rating === "up" — positive feedback has no negative reason code
    if (reasonCode !== null) {
      throw new InvalidFeedbackReasonCodeError(rating, reasonCode)
    }
  }
}

interface StoredFeedback {
  id: string
  run_id: string
  tenant_id: string
  subject_id: string
  rating: FeedbackRating
  reason_code: FeedbackReasonCode | null
  comment: string | null
  evidence_ids: string // JSON array string
  created_at: string
  updated_at: string
}

function rowToFeedback(row: StoredFeedback): Feedback {
  return {
    id: row.id,
    runId: row.run_id,
    tenantId: row.tenant_id,
    subjectId: row.subject_id,
    rating: row.rating,
    reasonCode: row.reason_code,
    comment: row.comment,
    evidenceIds: JSON.parse(row.evidence_ids),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class SqliteFeedbackStore implements FeedbackStore {
  constructor(
    private db: DB,
    private now: () => Date = () => new Date()
  ) {}

  upsert(input: FeedbackUpsertInput): Feedback {
    // Validate BEFORE touching the DB so a rejected upsert leaves no row
    // (test: 'no feedback row written when validation throws').
    validateReasonCode(input.rating, input.reasonCode)

    const now = this.now().toISOString()
    const evidenceIdsJson = JSON.stringify(input.evidenceIds)

    // SQLite native UPSERT on UNIQUE(tenant_id, subject_id, run_id).
    // Spec L1548: "resubmission updates it" — ON CONFLICT DO UPDATE preserves
    // id + created_at (they are omitted from the SET clause) and overwrites
    // the submitted fields. updated_at is refreshed from the excluded row.
    this.db
      .prepare(
        `INSERT INTO feedback (
          id, run_id, tenant_id, subject_id, rating, reason_code,
          comment, evidence_ids, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, subject_id, run_id) DO UPDATE SET
          rating = excluded.rating,
          reason_code = excluded.reason_code,
          comment = excluded.comment,
          evidence_ids = excluded.evidence_ids,
          updated_at = excluded.updated_at`
      )
      .run(
        randomUUID(),
        input.runId,
        input.tenantId,
        input.subjectId,
        input.rating,
        input.reasonCode,
        input.comment,
        evidenceIdsJson,
        now,
        now
      )

    // Read back the persisted row so we return the actual stored values
    // (id + created_at are preserved by the UPSERT; we don't synthesize them).
    const row = this.db
      .prepare(
        `SELECT * FROM feedback WHERE tenant_id = ? AND subject_id = ? AND run_id = ?`
      )
      .get(input.tenantId, input.subjectId, input.runId) as
      | StoredFeedback
      | undefined
    // upsert always leaves a row; the non-null assertion is structural
    return rowToFeedback(row!)
  }

  getByRunId(
    runId: string,
    tenantId: string,
    subjectId: string
  ): Feedback | null {
    const row = this.db
      .prepare(
        `SELECT * FROM feedback
         WHERE run_id = ? AND tenant_id = ? AND subject_id = ?`
      )
      .get(runId, tenantId, subjectId) as StoredFeedback | undefined
    return row ? rowToFeedback(row) : null
  }

  listByTenant(
    tenantId: string,
    options?: { subjectId?: string; rating?: FeedbackRating }
  ): Feedback[] {
    // Build the WHERE clause dynamically based on which filters are present.
    // All conditions are AND-ed; tenant_id is always applied (tenant scope).
    const conditions: string[] = ["tenant_id = ?"]
    const params: (string | FeedbackRating)[] = [tenantId]
    if (options?.subjectId) {
      conditions.push("subject_id = ?")
      params.push(options.subjectId)
    }
    if (options?.rating) {
      conditions.push("rating = ?")
      params.push(options.rating)
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM feedback WHERE ${conditions.join(" AND ")}
         ORDER BY updated_at DESC`
      )
      .all(...params) as StoredFeedback[]
    return rows.map(rowToFeedback)
  }
}
