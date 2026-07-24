// Ticket 18 — Revision-scoped ingestion fixture tests.
//
// TDD red phase: defines the expected behavior of createIngestionFixture()
// BEFORE the implementation exists. Tests cover all 3 acceptance criteria:
//   #1 — Lifecycle states (auto + review) under isolated acceptance identity
//   #2 — Idempotent re-run + failed replacement preserves previous active version
//   #3 — Evidence records isolated resource identifiers (no content/credentials)
//
// Plus isolation + cleanup + revision-prefix-validation tests.

import assert from "node:assert/strict"
import test from "node:test"
import {
  createIngestionFixture,
  deriveTenantId,
  deriveSearchNamespace,
} from "./ingestion_fixture"
import { SqliteCandidateReviewStore } from "../knowledge/candidate_review_store"
import { DocumentRepo } from "../ingestion/tracking/doc_repo"
import type { IngestionStageRunner } from "../ingestion/lifecycle"

const REVISION_A = "abc123def4567890abcdef1234567890abcdef12"
const REVISION_B = "xyz9876543210fedcba0987654321fedcba09876"

// ---------------------------------------------------------------------------
// #1 — Lifecycle states under isolated acceptance identity
// ---------------------------------------------------------------------------

test("Ticket 18 #1a: auto mode — ingest reaches completed + active=true under isolated tenant", async () => {
  const fixture = createIngestionFixture({ revision: REVISION_A })

  try {
    const submission = fixture.ingestBounded({
      title: "Refund Policy",
      content: "Refunds are available within 30 days.",
    })

    assert.equal(submission.status, "pending")
    assert.equal(fixture.tenantId, "acceptance-abc123def456")
    assert.equal(fixture.searchNamespace, "acceptance-abc123def456")
    assert.notEqual(fixture.tenantId, "default", "fixture MUST NOT touch production tenant")

    const result = await fixture.lifecycle.runNext()
    assert.equal(result?.success, true)

    const status = fixture.lifecycle.getStatus(submission.docId)
    assert.equal(status?.documentStatus, "completed")
    assert.equal(status?.documentVersion.active, true)
    assert.equal(status?.documentVersion.version, 1)
  } finally {
    await fixture.cleanup()
  }
})

test("Ticket 18 #1b: review mode — ingest reaches completed + pending_review (NOT yet active)", async () => {
  const fixture = createIngestionFixture({
    revision: REVISION_A,
    activationMode: "review",
  })

  try {
    const submission = fixture.ingestBounded({
      title: "Review Policy",
      content: "Pending human review.",
    })

    const result = await fixture.lifecycle.runNext()
    assert.equal(result?.success, true)

    const status = fixture.lifecycle.getStatus(submission.docId)
    assert.equal(status?.documentStatus, "completed")
    assert.equal(status?.documentVersion.active, false, "review mode MUST NOT auto-activate")

    // Verify the candidate is pending_review via the CandidateReviewStore
    const reviewStore = new SqliteCandidateReviewStore(fixture.db, new DocumentRepo(fixture.db))
    const candidate = reviewStore.getCandidate(submission.docId, fixture.tenantId)
    assert.equal(candidate?.candidateState, "pending_review")
    assert.equal(candidate?.tenantId, fixture.tenantId)
  } finally {
    await fixture.cleanup()
  }
})

test("Ticket 18 #1c: review mode — human approve activates the candidate", async () => {
  const fixture = createIngestionFixture({
    revision: REVISION_A,
    activationMode: "review",
  })

  try {
    const submission = fixture.ingestBounded({
      title: "Approval Flow",
      content: "Awaiting approval.",
    })
    await fixture.lifecycle.runNext()

    const reviewStore = new SqliteCandidateReviewStore(fixture.db, new DocumentRepo(fixture.db))
    const reviewResult = reviewStore.review(
      submission.docId,
      fixture.tenantId,
      "approve",
      "test-approver",
      "looks good",
    )

    assert.ok(reviewResult, "review() must return a result for an existing pending_review doc")
    assert.equal(reviewResult!.candidateState, "approved")
    assert.equal(reviewResult!.activatedAsActive, true)

    const status = fixture.lifecycle.getStatus(submission.docId)
    assert.equal(status?.documentVersion.active, true, "approve MUST activate")
  } finally {
    await fixture.cleanup()
  }
})

// ---------------------------------------------------------------------------
// #2 — Idempotent re-run + failed replacement preserves previous active version
// ---------------------------------------------------------------------------

test("Ticket 18 #2a: re-running same revision + same content is idempotent (unchanged)", async () => {
  const fixture = createIngestionFixture({ revision: REVISION_A })

  try {
    const initial = fixture.ingestBounded({
      title: "Policy",
      content: "Refunds are available within 30 days.",
    })
    assert.equal((await fixture.lifecycle.runNext())?.success, true)

    const unchanged = fixture.ingestBounded({
      title: "Renamed Policy",
      content: "Refunds are available within 30 days.",
    })

    assert.equal(unchanged.status, "unchanged")
    assert.equal(unchanged.docId, initial.docId)
    assert.equal(unchanged.taskId, null)
    assert.equal(await fixture.lifecycle.runNext(), null, "no new task to run")
  } finally {
    await fixture.cleanup()
  }
})

test("Ticket 18 #2b: failed replacement preserves previous active version", async () => {
  const failingRunner: IngestionStageRunner = {
    async close() {},
    async run(document, execution) {
      // Replacement content bails before any stage runs — assertComplete()
      // throws with retryable=false, so the task is dead-lettered and the doc
      // is marked "failed" immediately (matches lifecycle.test.ts "a failed
      // replacement remains inspectable" semantics). Original succeeds.
      if (document.content === "replacement content") {
        return
      }
      for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
        await execution.runStage(stage, {}, async () => undefined, () => ({ stage }))
      }
    },
  }

  const fixture = createIngestionFixture({
    revision: REVISION_A,
    stageRunner: failingRunner,
  })

  try {
    // Ingest v1 successfully
    const initial = fixture.ingestBounded({
      title: "Policy",
      content: "original content",
    })
    assert.equal((await fixture.lifecycle.runNext())?.success, true)
    assert.equal(
      fixture.lifecycle.getStatus(initial.docId)?.documentVersion.active,
      true,
      "v1 must be active after success",
    )

    // Ingest v2 — stage runner bails early → v2 fails, v1 stays active
    const replacement = fixture.ingestBounded({
      title: "Policy",
      content: "replacement content",
    })
    assert.equal(replacement.status, "pending")
    assert.equal(replacement.version, 2)
    assert.notEqual(replacement.docId, initial.docId)

    const replacementResult = await fixture.lifecycle.runNext()
    assert.equal(replacementResult?.success, false, "replacement must fail")

    const v1Status = fixture.lifecycle.getStatus(initial.docId)
    const v2Status = fixture.lifecycle.getStatus(replacement.docId)
    assert.equal(v1Status?.documentStatus, "completed")
    assert.equal(v1Status?.documentVersion.active, true, "v1 MUST remain active after v2 failure")
    assert.equal(v2Status?.documentStatus, "failed")
    assert.equal(v2Status?.documentVersion.active, false, "v2 must NOT be active")
  } finally {
    await fixture.cleanup()
  }
})

// ---------------------------------------------------------------------------
// #3 — Evidence records isolated resource identifiers (no content/credentials)
// ---------------------------------------------------------------------------

test("Ticket 18 #3a: evidence() returns isolated resource identifiers", async () => {
  const fixture = createIngestionFixture({ revision: REVISION_A })

  try {
    const submission = fixture.ingestBounded({
      title: "Evidence Test",
      content: "Some bounded synthetic content.",
    })
    await fixture.lifecycle.runNext()

    const evidence = fixture.evidence()
    assert.equal(evidence.tenantId, "acceptance-abc123def456")
    assert.equal(evidence.searchNamespace, "acceptance-abc123def456")
    assert.equal(evidence.revision, REVISION_A)
    assert.equal(evidence.sqlitePath, ":memory:")
    assert.equal(evidence.activationMode, "auto")
    assert.ok(evidence.docIds.includes(submission.docId), "docIds must include the ingested doc")
    assert.ok(evidence.sourceIds.length > 0, "at least one sourceId must be recorded")
    assert.ok(evidence.sourceIds.every((id) => typeof id === "string" && id.length > 0))
    assert.ok(evidence.versions.length > 0)
    const v = evidence.versions.find((entry) => entry.docId === submission.docId)
    assert.ok(v, "versions must include the ingested doc")
    assert.equal(v?.version, 1)
    assert.equal(v?.active, true)
    assert.equal(v?.status, "completed")
    assert.ok(evidence.generatedAt)
  } finally {
    await fixture.cleanup()
  }
})

test("Ticket 18 #3b: evidence() contains NO source content, rawContent, credentials, or auth material", async () => {
  const fixture = createIngestionFixture({ revision: REVISION_A })

  try {
    fixture.ingestBounded({
      title: "Secret Scan Test",
      content: "SENSITIVE: this content must NEVER appear in evidence.",
    })
    await fixture.lifecycle.runNext()

    const evidence = fixture.evidence()
    const serialized = JSON.stringify(evidence)

    const forbidden = [
      "SENSITIVE",
      "this content must NEVER appear in evidence",
      "content",
      "rawContent",
      "raw_content",
      "credential",
      "password",
      "api_key",
      "apiKey",
      "authorization",
      "Bearer",
      "token",
      "eyJ",
    ]
    for (const bad of forbidden) {
      assert.ok(
        !serialized.includes(bad),
        `evidence MUST NOT contain "${bad}" — found in: ${serialized}`,
      )
    }
  } finally {
    await fixture.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Isolation + cleanup + revision-prefix validation
// ---------------------------------------------------------------------------

test("Ticket 18 #4: different revisions produce different tenantIds and searchNamespaces", () => {
  const tenantA = deriveTenantId(REVISION_A)
  const tenantB = deriveTenantId(REVISION_B)
  assert.notEqual(tenantA, tenantB, "different revisions MUST isolate to different tenants")
  assert.ok(tenantA.startsWith("acceptance-"))
  assert.ok(tenantB.startsWith("acceptance-"))
  assert.notEqual(tenantA, "default", "fixture tenant MUST NOT be the production default")

  const nsA = deriveSearchNamespace(REVISION_A)
  const nsB = deriveSearchNamespace(REVISION_B)
  assert.notEqual(nsA, nsB, "different revisions MUST isolate to different namespaces")
})

test("Ticket 18 #5: cleanup() closes the lifecycle and database — subsequent operations fail", async () => {
  const fixture = createIngestionFixture({ revision: REVISION_A })
  fixture.ingestBounded({
    title: "Cleanup Test",
    content: "Will be cleaned up.",
  })

  await fixture.cleanup()

  // After cleanup, calling submit() must throw — db is closed.
  assert.throws(() => {
    fixture.lifecycle.submit({ title: "x", content: "y" })
  }, /database|closed|cannot/i)
})

test("Ticket 18 #6: deriveTenantId rejects revisions that are too short", () => {
  assert.throws(() => deriveTenantId(""), /revision.*required/i)
  assert.throws(() => deriveTenantId("ab"), /too short/i)
  assert.throws(() => deriveTenantId("   "), /too short/i)
})

test("Ticket 18 #7: deriveTenantId sanitizes non-alphanumeric characters", () => {
  // Revision-like string with special chars should be sanitized to alphanumeric prefix
  const tenantId = deriveTenantId("abc123!@#def456")
  assert.equal(tenantId, "acceptance-abc123def456")
})

test("Ticket 18 #8: createIngestionFixture rejects missing revision", () => {
  assert.throws(
    () => createIngestionFixture({ revision: "" }),
    /revision.*required/i,
  )
})

test("Ticket 18 #9: ingestBounded rejects missing title or content", async () => {
  const fixture = createIngestionFixture({ revision: REVISION_A })
  try {
    assert.throws(() =>
      fixture.ingestBounded({ title: "", content: "x" }),
    /title.*content.*required/i)
    assert.throws(() =>
      fixture.ingestBounded({ title: "x", content: "" }),
    /title.*content.*required/i)
  } finally {
    await fixture.cleanup()
  }
})

test("Ticket 18 #10: fixture with custom stageRunner exercises the real lifecycle path", async () => {
  let runCount = 0
  const customRunner: IngestionStageRunner = {
    async close() {},
    async run(_document, execution) {
      runCount += 1
      for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
        await execution.runStage(stage, {}, async () => undefined, () => ({ stage, custom: true }))
      }
    },
  }

  const fixture = createIngestionFixture({
    revision: REVISION_A,
    stageRunner: customRunner,
  })

  try {
    fixture.ingestBounded({ title: "Custom Runner", content: "test" })
    await fixture.lifecycle.runNext()
    assert.equal(runCount, 1, "custom runner must be invoked exactly once")
  } finally {
    await fixture.cleanup()
  }
})
