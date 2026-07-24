import assert from "node:assert/strict"
import test from "node:test"
import { openDb, type DB } from "./tracking/db"
import { DocumentRepo } from "./tracking/doc_repo"
import {
  IngestionLifecycle,
  type IngestionStageRunner,
  type StageExecution,
} from "./lifecycle"
import { SqliteCandidateReviewStore } from "../knowledge/candidate_review_store"

/**
 * P6.3 (spec §11 L73, L1574, L1575, L1580): review-mode smoke and replay.
 *
 * Situation A (test-only). P6.1 (accepted via D-016) wired the review/auto
 * state machine into IngestionLifecycle; P6.2 (accepted via D-018) audited
 * all production callers through `createIngestionLifecycle(db)`. P6.3
 * composes a single end-to-end smoke pass that exercises the operator-
 * observable surface of `ACTIVATION_MODE=review`:
 *
 *   ingest → pending_review → approve → approved+active
 *   ingest → pending_review → reject  → rejected (previous active preserved)
 *   rejected → re-ingest (retry)       → new candidate pending_review → approve → active
 *   ingest (in-flight) → cancel        → task.status='cancelled', doc.status='cancelled'
 *   operator inspect (getCandidate)    → reviewed_by / reviewed_at / review_reason audit fields
 *
 * No production code is modified. Every assertion rides the existing seams
 * (IngestionLifecycle.submit/runNext/cancel + CandidateReviewStore.review/
 * getCandidate + DocumentRepo). The `DocumentCandidateState` type still
 * exposes only `pending_review | approved | rejected` — there is no
 * `cancelled`/`abandoned` candidate state; cancel touches the lifecycle
 * `documents.status` column, NOT `candidate_state`, and a cancelled run
 * does NOT enter the review queue (only COMPLETED runs do).
 */

function noopRunner(): IngestionStageRunner {
  return {
    close: async () => {},
    async run(_document, execution: StageExecution): Promise<void> {
      for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
        await execution.runStage(stage, {}, async () => undefined, () => ({ stage }))
      }
    },
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

interface CandidateAuditRow {
  candidate_state: string
  reviewed_by: string | null
  reviewed_at: string | null
  review_reason: string | null
}

function readCandidateAudit(db: DB, docId: string): CandidateAuditRow {
  const row = db.prepare(
    `SELECT candidate_state, reviewed_by, reviewed_at, review_reason
     FROM documents WHERE doc_id = ?`
  ).get(docId) as CandidateAuditRow | undefined
  return row ?? {
    candidate_state: "<missing>",
    reviewed_by: null,
    reviewed_at: null,
    review_reason: null,
  }
}

interface DocStatusRow {
  status: string
}

function readDocStatus(db: DB, docId: string): string {
  const row = db.prepare(
    `SELECT status FROM documents WHERE doc_id = ?`
  ).get(docId) as DocStatusRow | undefined
  return row?.status ?? "<missing>"
}

interface ActiveDocRow {
  active_doc_id: string | null
}

function readActiveDocId(db: DB, sourceId: string): string | null {
  const row = db.prepare(
    `SELECT active_doc_id FROM sources WHERE source_id = ?`
  ).get(sourceId) as ActiveDocRow | undefined
  return row?.active_doc_id ?? null
}

interface TaskRow {
  id: number
  status: string
}

function readTaskByDoc(db: DB, docId: string): TaskRow | null {
  const row = db.prepare(
    `SELECT id, status FROM task_pending_ops WHERE doc_id = ?`
  ).get(docId) as TaskRow | undefined
  return row ?? null
}

/**
 * End-to-end smoke: ingest → pending_review → approve → active, then
 * reject a second version, then re-ingest (retry) a third version which
 * re-enters pending_review and is approved to become the new active.
 *
 * This single test exercises approve / reject / retry (re-ingest) paths
 * plus operator inspect (getCandidate) on every step. Keeping it as one
 * test makes the operator replay sequence observable end-to-end.
 */
test("P6.3 review-mode smoke: approve → reject → retry (re-ingest) → approve, operator inspects audit each step", async () => {
  const db = openDb(":memory:")
  // Fixed clock so audit timestamps are deterministic and assertable.
  let clock = new Date("2026-07-22T08:00:00.000Z")
  const lifecycle = new IngestionLifecycle(
    db,
    noopRunner(),
    () => clock,
    "review"
  )
  const documentRepo = new DocumentRepo(db)
  const reviewStore = new SqliteCandidateReviewStore(db, documentRepo, () => clock)
  const sourceKey = "policy:p6_3_smoke"

  try {
    // ---- Step 1: ingest v1 → pending_review (review mode) ----
    const v1 = lifecycle.submit({
      title: "Policy v1",
      content: "version one",
      source: sourceKey,
    })
    const r1 = await lifecycle.runNext()
    assert.equal(r1?.success, true)

    const v1AuditBefore = readCandidateAudit(db, v1.docId)
    assert.equal(
      v1AuditBefore.candidate_state,
      "pending_review",
      "review mode must mark completed v1 as pending_review (not approved)"
    )
    assert.equal(v1AuditBefore.reviewed_by, null)
    assert.equal(v1AuditBefore.reviewed_at, null)
    assert.equal(v1AuditBefore.review_reason, null)
    assert.equal(
      lifecycle.getStatus(v1.docId)?.documentVersion.active,
      false,
      "pending_review candidate must NOT be active"
    )

    // Operator inspect via CandidateReviewStore.getCandidate — replay surface.
    const v1Candidate = reviewStore.getCandidate(v1.docId, "default")
    assert.ok(v1Candidate, "operator getCandidate must return entry for pending_review doc")
    assert.equal(v1Candidate!.candidateState, "pending_review")
    assert.equal(v1Candidate!.reviewedBy, null)
    assert.equal(v1Candidate!.reviewedAt, null)
    assert.equal(v1Candidate!.reviewReason, null)

    // ---- Step 2: approve v1 → approved + active + audit fields ----
    clock = new Date("2026-07-22T09:00:00.000Z")
    const approveResult = reviewStore.review(
      v1.docId,
      "default",
      "approve",
      "LGTM — initial release",
      "reviewer-alice"
    )
    assert.equal(approveResult?.candidateState, "approved")
    assert.equal(approveResult?.activatedAsActive, true)
    assert.equal(approveResult?.reviewedBy, "reviewer-alice")
    assert.equal(approveResult?.reviewedAt, "2026-07-22T09:00:00.000Z")
    assert.equal(approveResult?.reviewReason, "LGTM — initial release")

    const v1AuditAfter = readCandidateAudit(db, v1.docId)
    assert.equal(v1AuditAfter.candidate_state, "approved")
    assert.equal(v1AuditAfter.reviewed_by, "reviewer-alice")
    assert.equal(v1AuditAfter.reviewed_at, "2026-07-22T09:00:00.000Z")
    assert.equal(v1AuditAfter.review_reason, "LGTM — initial release")
    assert.equal(
      lifecycle.getStatus(v1.docId)?.documentVersion.active,
      true,
      "approved v1 must be the active version"
    )

    // Operator replay: getCandidate now returns audit fields.
    const v1CandidateAfter = reviewStore.getCandidate(v1.docId, "default")
    assert.equal(v1CandidateAfter!.candidateState, "approved")
    assert.equal(v1CandidateAfter!.reviewedBy, "reviewer-alice")
    assert.equal(v1CandidateAfter!.reviewedAt, "2026-07-22T09:00:00.000Z")
    assert.equal(v1CandidateAfter!.reviewReason, "LGTM — initial release")

    // ---- Step 3: ingest v2 (same source) → pending_review, v1 still active ----
    clock = new Date("2026-07-22T10:00:00.000Z")
    const v2 = lifecycle.submit({
      title: "Policy v2",
      content: "version two — bad update",
      source: sourceKey,
    })
    const r2 = await lifecycle.runNext()
    assert.equal(r2?.success, true)
    assert.equal(readCandidateAudit(db, v2.docId).candidate_state, "pending_review")
    assert.equal(
      lifecycle.getStatus(v2.docId)?.documentVersion.active,
      false,
      "v2 pending_review must NOT be active"
    )
    assert.equal(
      lifecycle.getStatus(v1.docId)?.documentVersion.active,
      true,
      "v1 must remain active while v2 awaits review"
    )

    // ---- Step 4: reject v2 → rejected + audit fields, v1 still active ----
    clock = new Date("2026-07-22T11:00:00.000Z")
    const rejectResult = reviewStore.review(
      v2.docId,
      "default",
      "reject",
      "Bad update — factual errors",
      "reviewer-bob"
    )
    assert.equal(rejectResult?.candidateState, "rejected")
    assert.equal(rejectResult?.activatedAsActive, false)
    assert.equal(rejectResult?.reviewedBy, "reviewer-bob")
    assert.equal(rejectResult?.reviewedAt, "2026-07-22T11:00:00.000Z")
    assert.equal(rejectResult?.reviewReason, "Bad update — factual errors")

    const v2AuditAfter = readCandidateAudit(db, v2.docId)
    assert.equal(v2AuditAfter.candidate_state, "rejected")
    assert.equal(v2AuditAfter.reviewed_by, "reviewer-bob")
    assert.equal(v2AuditAfter.reviewed_at, "2026-07-22T11:00:00.000Z")
    assert.equal(v2AuditAfter.review_reason, "Bad update — factual errors")
    assert.equal(
      lifecycle.getStatus(v2.docId)?.documentVersion.active,
      false,
      "rejected v2 must NOT be active"
    )
    assert.equal(
      lifecycle.getStatus(v1.docId)?.documentVersion.active,
      true,
      "reject must preserve the previous active version (v1)"
    )

    // ---- Step 5: retry = re-ingest v3 (same source, new content) ----
    // Spec L1573-1575 + P6.3 task: rejected candidates can be retried by
    // re-ingesting the source. The new candidate enters pending_review
    // under review mode, NOT auto-activates. This is the "retry" path —
    // there is no separate retry() method; re-submit is the seam.
    clock = new Date("2026-07-22T12:00:00.000Z")
    const v3 = lifecycle.submit({
      title: "Policy v3",
      content: "version three — corrected",
      source: sourceKey,
    })
    const r3 = await lifecycle.runNext()
    assert.equal(r3?.success, true)
    assert.equal(
      readCandidateAudit(db, v3.docId).candidate_state,
      "pending_review",
      "retry (re-ingest) under review mode must produce a new pending_review candidate"
    )
    assert.equal(
      lifecycle.getStatus(v3.docId)?.documentVersion.active,
      false,
      "v3 pending_review must NOT be active"
    )
    assert.equal(
      lifecycle.getStatus(v1.docId)?.documentVersion.active,
      true,
      "v1 must remain active while v3 awaits review"
    )
    // v2 stays rejected — retry creates a NEW candidate; it does not
    // mutate the rejected v2 row.
    assert.equal(
      readCandidateAudit(db, v2.docId).candidate_state,
      "rejected",
      "retry must NOT mutate the rejected v2 row"
    )

    // ---- Step 6: approve v3 → approved + becomes active (activation_order newer) ----
    clock = new Date("2026-07-22T13:00:00.000Z")
    const approveV3 = reviewStore.review(
      v3.docId,
      "default",
      "approve",
      "Corrected — LGTM",
      "reviewer-alice"
    )
    assert.equal(approveV3?.candidateState, "approved")
    assert.equal(approveV3?.activatedAsActive, true)
    assert.equal(
      lifecycle.getStatus(v3.docId)?.documentVersion.active,
      true,
      "approved v3 must be the new active version (newer activation_order)"
    )
    assert.equal(
      lifecycle.getStatus(v1.docId)?.documentVersion.active,
      false,
      "v1 must step down when v3 is approved+activated"
    )
    assert.equal(
      readCandidateAudit(db, v3.docId).candidate_state,
      "approved"
    )
    assert.equal(
      readCandidateAudit(db, v3.docId).reviewed_by,
      "reviewer-alice"
    )

    // ---- Operator replay surface: getSourceStatusSummary-style audit ----
    // The operator can inspect the full audit trail for any candidate by
    // calling getCandidate(docId, tenantId) at any time. This is the
    // replay/inspect seam — no separate "history" API is needed.
    const v1Final = reviewStore.getCandidate(v1.docId, "default")
    const v2Final = reviewStore.getCandidate(v2.docId, "default")
    const v3Final = reviewStore.getCandidate(v3.docId, "default")
    assert.equal(v1Final!.candidateState, "approved")
    assert.equal(v1Final!.reviewedBy, "reviewer-alice")
    assert.equal(v1Final!.reviewReason, "LGTM — initial release")
    assert.equal(v2Final!.candidateState, "rejected")
    assert.equal(v2Final!.reviewedBy, "reviewer-bob")
    assert.equal(v2Final!.reviewReason, "Bad update — factual errors")
    assert.equal(v3Final!.candidateState, "approved")
    assert.equal(v3Final!.reviewedBy, "reviewer-alice")
    assert.equal(v3Final!.reviewReason, "Corrected — LGTM")

    // Cross-tenant isolation on replay (spec L1582): operator in tenant-b
    // cannot inspect tenant-default's candidates.
    assert.equal(
      reviewStore.getCandidate(v1.docId, "tenant-b"),
      null,
      "operator in tenant-b must NOT see tenant-default's candidate (404)"
    )
  } finally {
    db.close()
  }
})

/**
 * Cancel path: under review mode, cancelling an IN-FLIGHT ingestion task
 * terminates the run before completion. Because `markPendingReview` is
 * only called on the COMPLETED path, a cancelled run's candidate_state
 * remains the schema default `'approved'` (NOT pending_review, NOT a new
 * cancelled/abandoned state). The document's lifecycle status is
 * `'cancelled'`. This is the cancel half of approve/reject/retry/cancel.
 */
test("P6.3 review-mode cancel: in-flight cancellation does NOT enter pending_review; doc status='cancelled'", async () => {
  const db = openDb(":memory:")
  const chunkStarted = deferred()
  const releaseChunk = deferred()
  const runner: IngestionStageRunner = {
    close: async () => {},
    async run(_document, execution): Promise<void> {
      await execution.runStage(
        "chunk",
        {},
        async () => {
          chunkStarted.resolve()
          await releaseChunk.promise
        },
        () => ({ stage: "chunk" })
      )
    },
  }
  const clock = new Date("2026-07-22T08:00:00.000Z")
  const lifecycle = new IngestionLifecycle(db, runner, () => clock, "review")
  const documentRepo = new DocumentRepo(db)
  const reviewStore = new SqliteCandidateReviewStore(db, documentRepo, () => clock)

  try {
    const submitted = lifecycle.submit({
      title: "Cancellable",
      content: "will cancel before completion",
      source: "policy:p6_3_cancel",
    })
    const running = lifecycle.runNext()
    await chunkStarted.promise

    // Cancel while parked inside the chunk stage — the cancellation wins
    // the race and the run terminates as cancelled.
    const cancelResult = lifecycle.cancel(submitted.docId)
    assert.equal(cancelResult?.changed, true)
    assert.equal(cancelResult?.status, "cancelled")

    releaseChunk.resolve()
    const result = await running

    assert.equal(result?.success, false)
    assert.equal(result?.cancelled, true)

    // candidate_state must remain the schema default 'approved' — cancel
    // does NOT call markPendingReview (only the COMPLETED branch does).
    // There is NO 'cancelled' or 'abandoned' candidate_state — the
    // DocumentCandidateState type has only pending_review|approved|rejected.
    const audit = readCandidateAudit(db, submitted.docId)
    assert.equal(
      audit.candidate_state,
      "approved",
      "cancelled run must NOT enter pending_review (only completed runs gate); candidate_state stays schema default 'approved'"
    )
    assert.equal(audit.reviewed_by, null)
    assert.equal(audit.reviewed_at, null)
    assert.equal(audit.review_reason, null)

    // The lifecycle `documents.status` (separate column from candidate_state)
    // IS marked 'cancelled' — this is the terminal lifecycle outcome.
    assert.equal(
      readDocStatus(db, submitted.docId),
      "cancelled",
      "cancelled run's documents.status must be 'cancelled'"
    )

    // The task is also terminal-cancelled — operator can inspect.
    const task = readTaskByDoc(db, submitted.docId)
    // Task row may have been removed from task_pending_ops on terminal
    // cancellation; either outcome (null or status='cancelled') is
    // acceptable. The authoritative signal is documents.status above.
    if (task) {
      assert.equal(
        task.status,
        "cancelled",
        "if task row remains, its status must be 'cancelled'"
      )
    }

    // Operator inspect (replay) — getCandidate returns the unreviewed
    // default state. The cancel did not produce an audit trail because
    // no review decision was made.
    const candidate = reviewStore.getCandidate(submitted.docId, "default")
    assert.ok(candidate)
    assert.equal(candidate!.candidateState, "approved")
    assert.equal(candidate!.reviewedBy, null)
    assert.equal(candidate!.reviewedAt, null)
    assert.equal(candidate!.reviewReason, null)
    assert.equal(
      lifecycle.getStatus(submitted.docId)?.documentVersion.active,
      false,
      "cancelled run must NOT be active"
    )
  } finally {
    db.close()
  }
})

/**
 * Replay invariant: operator can re-inspect a candidate's audit fields
 * at any time, and re-issuing the SAME review decision is idempotent
 * (preserves FIRST review's fields — spec L1580). This guards the
 * replay surface against accidental audit-trail overwrite.
 */
test("P6.3 replay invariant: re-approve is idempotent and preserves FIRST reviewer's audit fields", async () => {
  const db = openDb(":memory:")
  const clock1 = new Date("2026-07-22T08:00:00.000Z")
  const lifecycle = new IngestionLifecycle(db, noopRunner(), () => clock1, "review")
  const documentRepo = new DocumentRepo(db)
  const reviewStore = new SqliteCandidateReviewStore(db, documentRepo, () => clock1)

  try {
    const submitted = lifecycle.submit({
      title: "Replay",
      content: "replay content",
      source: "policy:p6_3_replay",
    })
    await lifecycle.runNext()
    assert.equal(
      readCandidateAudit(db, submitted.docId).candidate_state,
      "pending_review"
    )

    // First approve — establishes the audit trail.
    const first = reviewStore.review(
      submitted.docId,
      "default",
      "approve",
      "first review — LGTM",
      "reviewer-first"
    )
    assert.equal(first?.candidateState, "approved")
    assert.equal(first?.reviewedBy, "reviewer-first")
    assert.equal(first?.reviewReason, "first review — LGTM")

    // Second approve by a different reviewer — idempotent: must preserve
    // FIRST review's fields, NOT overwrite with second reviewer's.
    const clock2 = new Date("2026-07-22T10:00:00.000Z")
    const second = new SqliteCandidateReviewStore(db, documentRepo, () => clock2).review(
      submitted.docId,
      "default",
      "approve",
      "second review — also LGTM",
      "reviewer-second"
    )
    assert.equal(second?.candidateState, "approved")
    assert.equal(second?.activatedAsActive, false, "idempotent re-approve must NOT re-activate")
    // audit fields are the FIRST review's, NOT the second's.
    assert.equal(second?.reviewedBy, "reviewer-first")
    assert.equal(second?.reviewedAt, "2026-07-22T08:00:00.000Z")
    assert.equal(second?.reviewReason, "first review — LGTM")

    // Operator replay: getCandidate returns FIRST review's audit fields.
    const candidate = reviewStore.getCandidate(submitted.docId, "default")
    assert.equal(candidate!.candidateState, "approved")
    assert.equal(candidate!.reviewedBy, "reviewer-first")
    assert.equal(candidate!.reviewedAt, "2026-07-22T08:00:00.000Z")
    assert.equal(candidate!.reviewReason, "first review — LGTM")
  } finally {
    db.close()
  }
})

/**
 * Defense-in-depth static contract: P6.3 must not require any new
 * production method. The existing seams (IngestionLifecycle.cancel +
 * CandidateReviewStore.review + getCandidate + lifecycle.submit) cover
 * approve/reject/retry/cancel/inspect. This test reads the production
 * source and asserts NO new method was added for P6.3 — preventing
 * future drift where a P6.3 "retry()" or "cancelCandidate()" method
 * might sneak into the review store.
 */
test("P6.3 蓝军 static contract: no new CandidateReviewStore methods for retry/cancel — existing seams suffice", () => {
  const fs = require("node:fs")
  const path = require("node:path")
  const storeSource = fs.readFileSync(
    path.join(__dirname, "..", "knowledge", "candidate_review_store.ts"),
    "utf8"
  )

  // The CandidateReviewStore interface must expose only getCandidate and
  // review — no retry, cancel, abandon, or replay methods. Retry is
  // implemented by re-ingesting via IngestionLifecycle.submit (a new
  // candidate enters pending_review). Cancel is implemented by
  // IngestionLifecycle.cancel (operates on task + lifecycle status, NOT
  // candidate_state). Replay/inspect is implemented by getCandidate.
  assert.ok(
    /getCandidate\(docId:\s*string,\s*tenantId:\s*string\)/.test(storeSource),
    "CandidateReviewStore must expose getCandidate(docId, tenantId) for operator inspect/replay"
  )
  assert.ok(
    /review\(\s*docId:\s*string,\s*tenantId:\s*string,\s*decision:\s*ReviewDecision/.test(storeSource),
    "CandidateReviewStore must expose review(docId, tenantId, decision, ...) for approve/reject"
  )

  // Explicit-deny: no retry/cancel/abandon method on the review store.
  // These are NOT part of the candidate state machine — the type
  // DocumentCandidateState has only pending_review|approved|rejected.
  assert.doesNotMatch(
    storeSource,
    /\b(retry|cancel|abandon|replay)\s*\(/,
    "CandidateReviewStore must NOT expose retry/cancel/abandon/replay methods — existing seams suffice"
  )

  // Lifecycle source: cancel() must exist on IngestionLifecycle (the
  // cancel seam for the in-flight run path).
  const lifecycleSource = fs.readFileSync(
    path.join(__dirname, "lifecycle.ts"),
    "utf8"
  )
  assert.ok(
    /cancel\(docId:\s*string\)/.test(lifecycleSource),
    "IngestionLifecycle.cancel(docId) must exist (cancel seam for in-flight runs)"
  )

  // DocumentCandidateState type must remain the P6.1-accepted 3-state
  // machine — P6.3 does NOT add cancelled/abandoned. This guards against
  // a future regression that might widen the type.
  const governanceSource = fs.readFileSync(
    path.join(__dirname, "..", "types", "governance.ts"),
    "utf8"
  )
  assert.ok(
    /DocumentCandidateState\s*=\s*"pending_review"\s*\|\s*"approved"\s*\|\s*"rejected"/.test(
      governanceSource
    ),
    "DocumentCandidateState must remain pending_review|approved|rejected (no cancelled/abandoned)"
  )
})

/**
 * Defense-in-depth: under review mode, the active_doc_id column on
 * sources is mutated ONLY via DocumentRepo.activate (called from
 * lifecycle.ts auto branch — NOT reachable under review mode — OR from
 * candidate_review_store.ts approve path). This is the P6.2 invariant
 * (D-018) restated for the P6.3 smoke surface. The previous smoke test
 * already verifies v1→v3 active transitions; this test asserts the
 * invariant statically so a future regression that adds an implicit
 * activation path is caught.
 */
test("P6.3 蓝军 static contract: review-mode active_doc_id mutation only via approve path", () => {
  const fs = require("node:fs")
  const path = require("node:path")
  const lifecycleSource = fs.readFileSync(
    path.join(__dirname, "lifecycle.ts"),
    "utf8"
  )

  // The activate() call in lifecycle.ts is inside the `else` branch of
  // `activationMode === "review"` — i.e., it only fires under auto mode.
  // Under review mode, markPendingReview fires instead. This was
  // asserted in P6.1; we re-assert it here for the P6.3 smoke surface.
  assert.match(
    lifecycleSource,
    /activationMode === "review"[\s\S]*?markPendingReview[\s\S]*?else[\s\S]*?activate/,
    "lifecycle.runNext() must gate activate() on activationMode (review → markPendingReview; else → activate)"
  )

  // doc_repo.markPendingReview must NOT touch active_doc_id — only
  // candidate_state and updated_at. This is the P6.1 contract.
  const docRepoSource = fs.readFileSync(
    path.join(__dirname, "tracking", "doc_repo.ts"),
    "utf8"
  )
  const markPendingReviewBlock = docRepoSource.match(
    /markPendingReview\(docId:\s*string\):\s*void\s*\{([\s\S]*?)\}\s*\}/
  )
  assert.ok(markPendingReviewBlock, "found markPendingReview method body")
  assert.ok(
    !/active_doc_id/.test(markPendingReviewBlock[1]),
    "markPendingReview must NOT touch active_doc_id (only candidate_state + updated_at)"
  )
  assert.ok(
    /candidate_state\s*=\s*'pending_review'/.test(markPendingReviewBlock[1]),
    "markPendingReview must set candidate_state='pending_review'"
  )
})
