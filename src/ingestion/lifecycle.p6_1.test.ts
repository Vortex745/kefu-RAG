import assert from "node:assert/strict"
import test from "node:test"
import { openDb, type DB } from "./tracking"
import { DocumentRepo } from "./tracking/doc_repo"
import {
  IngestionLifecycle,
  type IngestionStageRunner,
  type StageExecution,
} from "./lifecycle"
import { SqliteCandidateReviewStore } from "../knowledge/candidate_review_store"

/**
 * P6.1 (spec §11 L73, L1574, L1575): review/auto state machine.
 *
 * IngestionLifecycle owns terminal activation. Under `ACTIVATION_MODE=review`,
 * completed candidates are marked `pending_review` and do NOT become the
 * active version until human approval via `CandidateReviewStore.review()`.
 * HTTP, worker, pipeline, and repository do NOT implement implicit success
 * transfer. Under `ACTIVATION_MODE=auto` (default), existing behavior is
 * preserved — activate immediately on completion.
 *
 * State machine (spec L1573-1575):
 *   [ingestion completes] → pending_review (review mode) | approved+active (auto mode)
 *   pending_review → approved    (approve: activate via DocumentRepo.activate)
 *   pending_review → rejected    (reject: preserve previous active version)
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

function failingRunner(error: Error): IngestionStageRunner {
  return {
    close: async () => {},
    async run(_document, _execution): Promise<void> {
      throw error
    },
  }
}

interface CandidateRow {
  candidate_state: string
  reviewed_by: string | null
}

function readCandidateState(db: DB, docId: string): string {
  const row = db.prepare(
    `SELECT candidate_state, reviewed_by FROM documents WHERE doc_id = ?`
  ).get(docId) as CandidateRow | undefined
  return row?.candidate_state ?? "<missing>"
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("P6.1 auto mode (default): completed doc activates immediately with default approved candidate_state", async () => {
  const db = openDb(":memory:")
  const lifecycle = new IngestionLifecycle(db, noopRunner(), () => new Date(), "auto")

  try {
    const submitted = lifecycle.submit({
      title: "Auto policy",
      content: "auto mode content",
      source: "policy:auto",
    })
    const result = await lifecycle.runNext()

    assert.equal(result?.success, true)
    assert.equal(readCandidateState(db, submitted.docId), "approved")
    const status = lifecycle.getStatus(submitted.docId)
    assert.equal(status?.documentStatus, "completed")
    assert.equal(status?.documentVersion.active, true)
  } finally {
    db.close()
  }
})

test("P6.1 review mode: completed doc is marked pending_review and does NOT activate", async () => {
  const db = openDb(":memory:")
  const lifecycle = new IngestionLifecycle(db, noopRunner(), () => new Date(), "review")

  try {
    const submitted = lifecycle.submit({
      title: "Review policy",
      content: "review mode content",
      source: "policy:review",
    })
    const result = await lifecycle.runNext()

    assert.equal(result?.success, true)
    assert.equal(
      readCandidateState(db, submitted.docId),
      "pending_review",
      "review mode must mark completed candidate as pending_review (not approved)"
    )
    const status = lifecycle.getStatus(submitted.docId)
    assert.equal(status?.documentStatus, "completed")
    assert.equal(
      status?.documentVersion.active,
      false,
      "review mode must NOT activate the unreviewed version"
    )
  } finally {
    db.close()
  }
})

test("P6.1 review mode: previous active version is preserved when a new version completes", async () => {
  const db = openDb(":memory:")
  try {
    // Start in auto mode to establish an initial active v1, then switch to
    // review mode for v2 — this mirrors the real upgrade path where an
    // operator enables review mode after content already exists.
    const autoLifecycle = new IngestionLifecycle(db, noopRunner(), () => new Date(), "auto")
    const initial = autoLifecycle.submit({
      title: "Policy",
      content: "version one",
      source: "policy:review-preserve",
    })
    await autoLifecycle.runNext()
    const initialActive = autoLifecycle.getStatus(initial.docId)?.documentVersion.active
    assert.equal(initialActive, true, "precondition: v1 active under auto mode")

    const reviewLifecycle = new IngestionLifecycle(db, noopRunner(), () => new Date(), "review")
    const replacement = reviewLifecycle.submit({
      title: "Policy",
      content: "version two",
      source: "policy:review-preserve",
    })
    await reviewLifecycle.runNext()

    assert.equal(
      readCandidateState(db, replacement.docId),
      "pending_review",
      "v2 must be pending_review under review mode"
    )
    assert.equal(
      reviewLifecycle.getStatus(replacement.docId)?.documentVersion.active,
      false,
      "v2 must NOT be active under review mode"
    )
    assert.equal(
      reviewLifecycle.getStatus(initial.docId)?.documentVersion.active,
      true,
      "v1 must remain active after v2 completes under review mode"
    )
    assert.equal(
      readCandidateState(db, initial.docId),
      "approved",
      "v1 candidate_state must remain approved (review mode only marks NEW completions)"
    )
  } finally {
    db.close()
  }
})

test("P6.1 review mode: approve via CandidateReviewStore activates the pending_review doc", async () => {
  const db = openDb(":memory:")
  const lifecycle = new IngestionLifecycle(db, noopRunner(), () => new Date(), "review")
  const documentRepo = new DocumentRepo(db)
  const reviewStore = new SqliteCandidateReviewStore(db, documentRepo)

  try {
    const submitted = lifecycle.submit({
      title: "Approve flow",
      content: "approve after review",
      source: "policy:approve",
    })
    await lifecycle.runNext()

    assert.equal(readCandidateState(db, submitted.docId), "pending_review")
    assert.equal(lifecycle.getStatus(submitted.docId)?.documentVersion.active, false)

    // TenantId 'default' is the single-tenant default set by DocumentRepo.insert
    // when the source row's tenant_id is 'default' (SCHEMA DEFAULT).
    const result = reviewStore.review(
      submitted.docId,
      "default",
      "approve",
      "LGTM",
      "reviewer-1"
    )

    assert.equal(result?.candidateState, "approved")
    assert.equal(result?.activatedAsActive, true)
    assert.equal(readCandidateState(db, submitted.docId), "approved")
    assert.equal(
      lifecycle.getStatus(submitted.docId)?.documentVersion.active,
      true,
      "approve must activate the previously pending_review doc"
    )
  } finally {
    db.close()
  }
})

test("P6.1 review mode: reject via CandidateReviewStore does NOT activate and preserves previous active", async () => {
  const db = openDb(":memory:")
  // Establish v1 as active under auto mode first.
  const autoLifecycle = new IngestionLifecycle(db, noopRunner(), () => new Date(), "auto")
  const initial = autoLifecycle.submit({
    title: "Policy",
    content: "version one",
    source: "policy:reject",
  })
  await autoLifecycle.runNext()

  const reviewLifecycle = new IngestionLifecycle(db, noopRunner(), () => new Date(), "review")
  const documentRepo = new DocumentRepo(db)
  const reviewStore = new SqliteCandidateReviewStore(db, documentRepo)

  try {
    const replacement = reviewLifecycle.submit({
      title: "Policy",
      content: "version two",
      source: "policy:reject",
    })
    await reviewLifecycle.runNext()

    assert.equal(readCandidateState(db, replacement.docId), "pending_review")
    assert.equal(reviewLifecycle.getStatus(replacement.docId)?.documentVersion.active, false)

    const result = reviewStore.review(
      replacement.docId,
      "default",
      "reject",
      "Bad content",
      "reviewer-1"
    )

    assert.equal(result?.candidateState, "rejected")
    assert.equal(result?.activatedAsActive, false)
    assert.equal(readCandidateState(db, replacement.docId), "rejected")
    assert.equal(
      reviewLifecycle.getStatus(replacement.docId)?.documentVersion.active,
      false,
      "reject must NOT activate the rejected doc"
    )
    assert.equal(
      reviewLifecycle.getStatus(initial.docId)?.documentVersion.active,
      true,
      "reject must preserve the previous active version"
    )
  } finally {
    db.close()
  }
})

test("P6.1 backward compat: IngestionLifecycle without activationMode defaults to auto (activates on completion)", async () => {
  const db = openDb(":memory:")
  // No fourth argument — matches every pre-P6.1 caller in the codebase.
  const lifecycle = new IngestionLifecycle(db, noopRunner())

  try {
    const submitted = lifecycle.submit({
      title: "Backward compat",
      content: "default mode content",
      source: "policy:compat",
    })
    const result = await lifecycle.runNext()

    assert.equal(result?.success, true)
    assert.equal(
      readCandidateState(db, submitted.docId),
      "approved",
      "default mode preserves pre-P6.1 behavior (approved, not pending_review)"
    )
    assert.equal(
      lifecycle.getStatus(submitted.docId)?.documentVersion.active,
      true,
      "default mode preserves pre-P6.1 behavior (activates immediately)"
    )
  } finally {
    db.close()
  }
})

test("P6.1 review mode: failed ingestion does NOT mark pending_review (only completed runs gate)", async () => {
  const db = openDb(":memory:")
  const lifecycle = new IngestionLifecycle(db, failingRunner(new Error("boom")), () => new Date(), "review")

  try {
    const submitted = lifecycle.submit({
      title: "Failing",
      content: "will fail",
      source: "policy:fail",
    })
    const result = await lifecycle.runNext()

    assert.equal(result?.success, false)
    assert.equal(result?.error, "boom")
    // candidate_state must remain the schema default 'approved' — review mode
    // only marks COMPLETED candidates as pending_review. A failed candidate
    // does not enter the review queue.
    assert.equal(
      readCandidateState(db, submitted.docId),
      "approved",
      "failed ingestion must not enter pending_review (only completed runs gate)"
    )
    assert.equal(
      lifecycle.getStatus(submitted.docId)?.documentVersion.active,
      false,
      "failed ingestion must not activate"
    )
  } finally {
    db.close()
  }
})

test("P6.1 review mode: cancelled ingestion does NOT mark pending_review", async () => {
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
  const lifecycle = new IngestionLifecycle(db, runner, () => new Date(), "review")

  try {
    const submitted = lifecycle.submit({
      title: "Cancellable",
      content: "will cancel",
      source: "policy:cancel",
    })
    const running = lifecycle.runNext()
    await chunkStarted.promise

    // Cancel while the runner is parked inside the chunk stage. The
    // cancellation wins the race and the run terminates as cancelled —
    // candidate_state must remain the schema default 'approved', NOT
    // pending_review. Only COMPLETED runs enter the review queue.
    const cancelResult = lifecycle.cancel(submitted.docId)
    assert.equal(cancelResult?.changed, true)
    assert.equal(cancelResult?.status, "cancelled")

    releaseChunk.resolve()
    const result = await running

    assert.equal(result?.success, false)
    assert.equal(result?.cancelled, true)
    assert.equal(
      readCandidateState(db, submitted.docId),
      "approved",
      "cancelled ingestion must not enter pending_review"
    )
    assert.equal(
      lifecycle.getStatus(submitted.docId)?.documentVersion.active,
      false,
      "cancelled ingestion must not activate"
    )
  } finally {
    db.close()
  }
})

test("P6.1 蓝军: no implicit activation path bypasses the lifecycle under review mode", () => {
  // Static contract check: IngestionLifecycle.runNext() is the ONLY place
  // in the production code that calls DocumentRepo.activate() on the
  // completion path. CandidateReviewStore.review() is the ONLY legitimate
  // approve-activates path. No HTTP/worker/pipeline/repository code path
  // implements implicit success transfer (spec L73).
  //
  // This test asserts the invariant by reading the lifecycle module source
  // and confirming the activate call is gated on activationMode. It is a
  // defense-in-depth check against future regressions that might re-add
  // an unconditional activate.
  const fs = require("node:fs")
  const path = require("node:path")
  const lifecycleSource = fs.readFileSync(
    path.join(__dirname, "lifecycle.ts"),
    "utf8"
  )

  // The activate call must be inside a conditional branch on activationMode.
  assert.match(
    lifecycleSource,
    /activationMode === "review"[\s\S]*?markPendingReview[\s\S]*?else[\s\S]*?activate/,
    "runNext() must gate activate() on activationMode (review → markPendingReview; else → activate)"
  )

  // The activate call must NOT appear unconditionally after updateStatus
  // (i.e., the pre-P6.1 pattern is gone).
  const updateStatusBlock = lifecycleSource.match(
    /updateStatus\([^)]+, "completed"\)([\s\S]*?)\}\)\(\)/
  )
  assert.ok(updateStatusBlock, "found updateStatus('completed') transaction block")
  assert.ok(
    !/^\s*this\.docRepo\.activate\(/.test(updateStatusBlock[1].trim()),
    "activate() must NOT be called unconditionally after updateStatus('completed')"
  )
})
