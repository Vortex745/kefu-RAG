import assert from "node:assert/strict"
import test from "node:test"
import { openDb } from "../ingestion/tracking/db"
import {
  InvalidFeedbackReasonCodeError,
  SqliteFeedbackStore,
} from "./feedback_store"
import type { FeedbackUpsertInput } from "./feedback_store"

function makeInput(overrides: Partial<FeedbackUpsertInput> = {}): FeedbackUpsertInput {
  return {
    runId: "run-1",
    tenantId: "tenant-acme",
    subjectId: "subject-1",
    rating: "down",
    reasonCode: "wrong_answer",
    comment: "The cited source did not support the claim.",
    evidenceIds: ["ev-1", "ev-2"],
    ...overrides,
  }
}

function createStoreWithClock() {
  let clock = new Date("2026-07-18T10:00:00.000Z")
  const store = new SqliteFeedbackStore(openDb(":memory:"), () => clock)
  return {
    store,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms)
    },
    now: () => clock,
  }
}

test("Ticket 09 P3: upsert first call creates a Feedback with all fields populated", () => {
  const { store } = createStoreWithClock()
  const input = makeInput()
  const created = store.upsert(input)
  assert.ok(created.id, "id must be generated")
  assert.equal(created.runId, "run-1")
  assert.equal(created.tenantId, "tenant-acme")
  assert.equal(created.subjectId, "subject-1")
  assert.equal(created.rating, "down")
  assert.equal(created.reasonCode, "wrong_answer")
  assert.equal(created.comment, "The cited source did not support the claim.")
  assert.deepEqual(created.evidenceIds, ["ev-1", "ev-2"])
  assert.ok(created.createdAt, "createdAt must be set")
  assert.equal(created.createdAt, created.updatedAt, "createdAt === updatedAt on first create")
})

test("Ticket 09 P3: upsert resubmission preserves id/createdAt, updates fields, refreshes updatedAt (spec L1548)", () => {
  const { store, advance } = createStoreWithClock()
  const first = store.upsert(makeInput({ comment: "original comment" }))
  assert.ok(first)
  const originalId = first!.id
  const originalCreatedAt = first!.createdAt

  advance(5_000)
  // Resubmit with different fields — must update, not insert new
  const second = store.upsert(
    makeInput({
      rating: "down",
      reasonCode: "incomplete",
      comment: "follow-up: actually it was incomplete",
      evidenceIds: ["ev-3"],
    })
  )
  assert.equal(second.id, originalId, "id preserved on resubmission (no new row)")
  assert.equal(second.createdAt, originalCreatedAt, "createdAt preserved on resubmission")
  assert.notEqual(second.updatedAt, originalCreatedAt, "updatedAt refreshed on resubmission")
  assert.equal(second.reasonCode, "incomplete", "reasonCode updated")
  assert.equal(second.comment, "follow-up: actually it was incomplete", "comment updated")
  assert.deepEqual(second.evidenceIds, ["ev-3"], "evidenceIds updated")
})

test("Ticket 09 P3: upsert down rating requires a reason code — null throws InvalidFeedbackReasonCodeError (spec L1547, L1552)", () => {
  const { store } = createStoreWithClock()
  assert.throws(
    () => store.upsert(makeInput({ rating: "down", reasonCode: null })),
    (err: unknown) => err instanceof InvalidFeedbackReasonCodeError,
    "down rating with null reasonCode must throw (-> HTTP 400)"
  )
})

test("Ticket 09 P3: upsert down rating with invalid reason code throws InvalidFeedbackReasonCodeError", () => {
  const { store } = createStoreWithClock()
  // 'wrong_format' is not in the 6 supported codes
  assert.throws(
    () =>
      store.upsert(
        makeInput({ rating: "down", reasonCode: "wrong_format" as never })
      ),
    (err: unknown) => err instanceof InvalidFeedbackReasonCodeError,
    "down rating with out-of-set reasonCode must throw (-> HTTP 400)"
  )
  // Verify no row was written (validation happens before INSERT)
  assert.equal(
    store.getByRunId("run-1", "tenant-acme", "subject-1"),
    null,
    "no feedback row written when validation throws"
  )
})

test("Ticket 09 P3: upsert up rating with non-null reasonCode throws (strict — spec L1547 calls them 'negative reason codes')", () => {
  const { store } = createStoreWithClock()
  assert.throws(
    () =>
      store.upsert(
        makeInput({ rating: "up", reasonCode: "wrong_answer" })
      ),
    (err: unknown) => err instanceof InvalidFeedbackReasonCodeError,
    "up rating with non-null reasonCode must throw (negative codes only apply to down)"
  )
})

test("Ticket 09 P3: upsert up rating with null reasonCode succeeds (positive feedback has no reason)", () => {
  const { store } = createStoreWithClock()
  const created = store.upsert(
    makeInput({
      rating: "up",
      reasonCode: null,
      comment: null,
    })
  )
  assert.equal(created.rating, "up")
  assert.equal(created.reasonCode, null)
  assert.equal(created.comment, null)
})

test("Ticket 09 P3: upsert allows different subjects to rate the same run independently (multi-subject per run)", () => {
  const { store, advance } = createStoreWithClock()
  const a = store.upsert(
    makeInput({ subjectId: "subject-a", rating: "up", reasonCode: null })
  )
  advance(1_000)
  const b = store.upsert(
    makeInput({ subjectId: "subject-b", rating: "down", reasonCode: "other" })
  )
  assert.notEqual(a.id, b.id, "different subjects get distinct feedback rows")
  assert.equal(store.getByRunId("run-1", "tenant-acme", "subject-a")?.rating, "up")
  assert.equal(store.getByRunId("run-1", "tenant-acme", "subject-b")?.rating, "down")
})

test("Ticket 09 P3: getByRunId returns null for cross-tenant / non-existent / cross-subject (spec L1552 404)", () => {
  const { store } = createStoreWithClock()
  store.upsert(makeInput({ tenantId: "tenant-acme", subjectId: "subject-1", runId: "run-x" }))

  // Correct tuple retrieves
  assert.ok(store.getByRunId("run-x", "tenant-acme", "subject-1"))

  // Cross-tenant returns null (does not reveal existence)
  assert.equal(
    store.getByRunId("run-x", "tenant-b-other", "subject-1"),
    null,
    "cross-tenant getByRunId returns null (404)"
  )

  // Cross-subject returns null (different subject = different feedback record)
  assert.equal(
    store.getByRunId("run-x", "tenant-acme", "subject-2"),
    null,
    "cross-subject getByRunId returns null (404)"
  )

  // Non-existent run returns null
  assert.equal(
    store.getByRunId("run-nonexistent", "tenant-acme", "subject-1"),
    null,
    "non-existent run returns null"
  )
})

test("Ticket 09 P3: listByTenant returns tenant-scoped feedback, optionally filtered by subjectId and rating", () => {
  const { store, advance } = createStoreWithClock()
  // Seed: 2 for tenant-acme + 1 for tenant-b-other
  store.upsert(makeInput({ tenantId: "tenant-acme", subjectId: "s1", runId: "r1", rating: "up", reasonCode: null }))
  advance(1_000)
  store.upsert(makeInput({ tenantId: "tenant-acme", subjectId: "s2", runId: "r2", rating: "down", reasonCode: "other" }))
  advance(1_000)
  store.upsert(makeInput({ tenantId: "tenant-b-other", subjectId: "s3", runId: "r3", rating: "up", reasonCode: null }))

  // listByTenant for tenant-acme returns 2 (not 3 — tenant isolation)
  const allAcme = store.listByTenant("tenant-acme")
  assert.equal(allAcme.length, 2, "tenant-acme sees only its own 2 feedback records")
  assert.ok(allAcme.every((f) => f.tenantId === "tenant-acme"), "no cross-tenant leak")

  // Filter by subjectId
  const s1Only = store.listByTenant("tenant-acme", { subjectId: "s1" })
  assert.equal(s1Only.length, 1)
  assert.equal(s1Only[0].subjectId, "s1")

  // Filter by rating
  const upOnly = store.listByTenant("tenant-acme", { rating: "up" })
  assert.equal(upOnly.length, 1)
  assert.equal(upOnly[0].rating, "up")

  // Combined filter
  const combined = store.listByTenant("tenant-acme", { subjectId: "s2", rating: "down" })
  assert.equal(combined.length, 1)
  assert.equal(combined[0].subjectId, "s2")
  assert.equal(combined[0].rating, "down")

  // Tenant B sees only its own
  assert.equal(store.listByTenant("tenant-b-other").length, 1)
})

test("Ticket 09 P3: InvalidFeedbackReasonCodeError carries rating + reasonCode for HTTP 400 response payload (spec L1552)", () => {
  const { store } = createStoreWithClock()
  try {
    store.upsert(makeInput({ rating: "down", reasonCode: null }))
    assert.fail("should have thrown")
  } catch (err) {
    assert.ok(err instanceof InvalidFeedbackReasonCodeError)
    const e = err as InvalidFeedbackReasonCodeError
    assert.equal(e.rating, "down")
    assert.equal(e.reasonCode, null)
    assert.equal(e.name, "InvalidFeedbackReasonCodeError")
  }
})
