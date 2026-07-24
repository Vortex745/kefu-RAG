import assert from "node:assert/strict"
import test from "node:test"
import { openDb } from "../ingestion/tracking/db"
import {
  InvalidHandoffTransitionError,
  SqliteHandoffStore,
} from "./handoff_store"
import type { HandoffCreateInput } from "./handoff_store"
import type { HandoffState } from "../types/answer"

function makeInput(overrides: Partial<HandoffCreateInput> = {}): HandoffCreateInput {
  return {
    runId: "run-1",
    tenantId: "tenant-acme",
    subjectId: "subject-1",
    sessionId: "session-1",
    reasonCode: "user_request",
    userRequest: "I need to speak with a human agent",
    conversationSummary: "User asked about refund policy; bot provided generic info; user escalated.",
    evidenceIds: ["ev-1", "ev-2"],
    traceReference: "trace-abc",
    ...overrides,
  }
}

function createStoreWithClock() {
  let clock = new Date("2026-07-18T10:00:00.000Z")
  const store = new SqliteHandoffStore(openDb(":memory:"), () => clock)
  return {
    store,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms)
    },
    now: () => clock,
  }
}

test("Ticket 09 P2: create returns a HandoffCase with all fields populated and status='open'", () => {
  const { store } = createStoreWithClock()
  const input = makeInput()
  const created = store.create(input)
  assert.ok(created, "create must return a HandoffCase (not null) on first call")
  assert.equal(created!.runId, "run-1")
  assert.equal(created!.tenantId, "tenant-acme")
  assert.equal(created!.subjectId, "subject-1")
  assert.equal(created!.sessionId, "session-1")
  assert.equal(created!.reasonCode, "user_request")
  assert.equal(created!.userRequest, "I need to speak with a human agent")
  assert.equal(
    created!.conversationSummary,
    "User asked about refund policy; bot provided generic info; user escalated."
  )
  assert.deepEqual(created!.evidenceIds, ["ev-1", "ev-2"])
  assert.equal(created!.traceReference, "trace-abc")
  assert.equal(created!.status, "open", "newly created case must start in 'open' state")
  assert.ok(created!.id, "id must be generated")
  assert.equal(created!.createdAt, created!.updatedAt, "createdAt and updatedAt match on create")
})

test("Ticket 09 P2: create is idempotent by run_id — second call returns the FIRST case unchanged", () => {
  const { store, advance } = createStoreWithClock()
  const first = store.create(makeInput({ userRequest: "original request" }))
  assert.ok(first)
  const originalId = first!.id
  const originalCreatedAt = first!.createdAt

  advance(5_000)
  // Second create with DIFFERENT input fields but same runId — must return the original case
  const second = store.create(
    makeInput({
      userRequest: "DIFFERENT request that should be ignored",
      reasonCode: "policy_review",
      evidenceIds: ["ev-999"],
    })
  )
  assert.ok(second, "second create must return a case (not null) for same runId + same tenant")
  assert.equal(second!.id, originalId, "idempotent create returns the original case id")
  assert.equal(second!.userRequest, "original request", "original userRequest preserved — not overwritten")
  assert.equal(second!.reasonCode, "user_request", "original reasonCode preserved")
  assert.deepEqual(second!.evidenceIds, ["ev-1", "ev-2"], "original evidenceIds preserved")
  assert.equal(second!.createdAt, originalCreatedAt, "createdAt unchanged on idempotent re-create")
  assert.equal(second!.updatedAt, originalCreatedAt, "updatedAt unchanged on idempotent re-create (no write)")
})

test("Ticket 09 P2: create returns null when run_id already belongs to a different tenant (cross-tenant 404)", () => {
  const { store } = createStoreWithClock()
  const first = store.create(makeInput({ tenantId: "tenant-acme", runId: "run-shared" }))
  assert.ok(first)
  // Tenant B tries to create a handoff for the same run_id (which belongs to tenant A)
  const cross = store.create(
    makeInput({ tenantId: "tenant-b-other", runId: "run-shared", subjectId: "subject-b" })
  )
  assert.equal(cross, null, "cross-tenant create must return null (hide existence per spec L1552)")
  // Verify tenant A can still retrieve their case
  const retrieved = store.getByRunId("run-shared", "tenant-acme")
  assert.ok(retrieved, "original tenant can still retrieve their case")
  assert.equal(retrieved!.tenantId, "tenant-acme")
})

test("Ticket 09 P2: getById returns case for correct tenant; null for wrong tenant or non-existent", () => {
  const { store } = createStoreWithClock()
  const created = store.create(makeInput({ tenantId: "tenant-acme" }))
  assert.ok(created)

  // Correct tenant retrieves the case
  const found = store.getById(created!.id, "tenant-acme")
  assert.ok(found)
  assert.equal(found!.id, created!.id)

  // Wrong tenant gets null (cross-tenant 404 — does not reveal existence)
  const cross = store.getById(created!.id, "tenant-b-other")
  assert.equal(cross, null, "cross-tenant getById must return null")

  // Non-existent case id returns null
  const missing = store.getById("case-does-not-exist", "tenant-acme")
  assert.equal(missing, null, "non-existent case returns null")
})

test("Ticket 09 P2: getByRunId returns case for correct tenant; null for wrong tenant", () => {
  const { store } = createStoreWithClock()
  store.create(makeInput({ tenantId: "tenant-acme", runId: "run-x" }))

  assert.ok(store.getByRunId("run-x", "tenant-acme"))
  assert.equal(
    store.getByRunId("run-x", "tenant-b-other"),
    null,
    "cross-tenant getByRunId must return null"
  )
  assert.equal(
    store.getByRunId("run-nonexistent", "tenant-acme"),
    null,
    "non-existent run returns null"
  )
})

test("Ticket 09 P2: listByTenant returns tenant-scoped cases, optionally filtered by status", () => {
  const { store, advance } = createStoreWithClock()
  // Seed 3 cases for tenant-acme + 1 case for tenant-b-other
  const c1 = store.create(makeInput({ tenantId: "tenant-acme", runId: "run-a" }))
  advance(1_000)
  const c2 = store.create(makeInput({ tenantId: "tenant-acme", runId: "run-b" }))
  advance(1_000)
  store.create(makeInput({ tenantId: "tenant-acme", runId: "run-c" }))
  advance(1_000)
  store.create(makeInput({ tenantId: "tenant-b-other", runId: "run-d", subjectId: "subject-b" }))

  // listByTenant for tenant-acme returns 3 cases (not 4 — tenant isolation)
  const allAcme = store.listByTenant("tenant-acme")
  assert.equal(allAcme.length, 3, "tenant-acme sees only its own 3 cases")
  assert.ok(allAcme.every((c) => c.tenantId === "tenant-acme"), "no cross-tenant leak")

  // Move c1 to 'claimed' then filter by status
  store.updateStatus(c1!.id, "tenant-acme", "claimed")
  const claimedOnly = store.listByTenant("tenant-acme", "claimed")
  assert.equal(claimedOnly.length, 1, "status filter returns only claimed cases")
  assert.equal(claimedOnly[0].id, c1!.id)

  const openOnly = store.listByTenant("tenant-acme", "open")
  assert.equal(openOnly.length, 2, "open filter returns the 2 still-open cases")
  assert.ok(openOnly.every((c) => c.status === "open"))

  // Tenant B sees only its own case
  const allB = store.listByTenant("tenant-b-other")
  assert.equal(allB.length, 1, "tenant-b sees only its own 1 case")
  assert.equal(allB[0].runId, "run-d")
})

test("Ticket 09 P2: updateStatus accepts legal transitions open→claimed→resolved and open/claimed→cancelled", () => {
  const { store, advance } = createStoreWithClock()

  // Path 1: open → claimed → resolved
  const case1 = store.create(makeInput({ runId: "run-path1" }))
  advance(1_000)
  const claimed = store.updateStatus(case1!.id, "tenant-acme", "claimed")
  assert.ok(claimed)
  assert.equal(claimed!.status, "claimed")
  advance(1_000)
  const resolved = store.updateStatus(case1!.id, "tenant-acme", "resolved")
  assert.ok(resolved)
  assert.equal(resolved!.status, "resolved")

  // Path 2: open → cancelled
  const case2 = store.create(makeInput({ runId: "run-path2" }))
  advance(1_000)
  const cancelled1 = store.updateStatus(case2!.id, "tenant-acme", "cancelled")
  assert.ok(cancelled1)
  assert.equal(cancelled1!.status, "cancelled")

  // Path 3: open → claimed → cancelled
  const case3 = store.create(makeInput({ runId: "run-path3" }))
  advance(1_000)
  store.updateStatus(case3!.id, "tenant-acme", "claimed")
  advance(1_000)
  const cancelled3 = store.updateStatus(case3!.id, "tenant-acme", "cancelled")
  assert.ok(cancelled3)
  assert.equal(cancelled3!.status, "cancelled")
})

test("Ticket 09 P2: updateStatus throws InvalidHandoffTransitionError for illegal transitions", () => {
  const { store, advance } = createStoreWithClock()

  // open → resolved is illegal (must go through claimed first)
  const openCase = store.create(makeInput({ runId: "run-illegal-1" }))
  assert.throws(
    () => store.updateStatus(openCase!.id, "tenant-acme", "resolved"),
    (err: unknown) => err instanceof InvalidHandoffTransitionError,
    "open → resolved must throw (must go through claimed first)"
  )

  // resolved is terminal — any transition from resolved is illegal
  const resolvedCase = store.create(makeInput({ runId: "run-illegal-2" }))
  advance(1_000)
  store.updateStatus(resolvedCase!.id, "tenant-acme", "claimed")
  advance(1_000)
  store.updateStatus(resolvedCase!.id, "tenant-acme", "resolved")
  advance(1_000)
  for (const target of ["open", "claimed", "cancelled", "resolved"] as HandoffState[]) {
    assert.throws(
      () => store.updateStatus(resolvedCase!.id, "tenant-acme", target),
      (err: unknown) => err instanceof InvalidHandoffTransitionError,
      `resolved → ${target} must throw (terminal state)`
    )
  }

  // cancelled is terminal — any transition from cancelled is illegal
  const cancelledCase = store.create(makeInput({ runId: "run-illegal-3" }))
  advance(1_000)
  store.updateStatus(cancelledCase!.id, "tenant-acme", "cancelled")
  advance(1_000)
  for (const target of ["open", "claimed", "resolved", "cancelled"] as HandoffState[]) {
    assert.throws(
      () => store.updateStatus(cancelledCase!.id, "tenant-acme", target),
      (err: unknown) => err instanceof InvalidHandoffTransitionError,
      `cancelled → ${target} must throw (terminal state)`
    )
  }

  // claimed → open is illegal (cannot reopen a claimed case)
  const claimedCase = store.create(makeInput({ runId: "run-illegal-4" }))
  advance(1_000)
  store.updateStatus(claimedCase!.id, "tenant-acme", "claimed")
  advance(1_000)
  assert.throws(
    () => store.updateStatus(claimedCase!.id, "tenant-acme", "open"),
    (err: unknown) => err instanceof InvalidHandoffTransitionError,
    "claimed → open must throw (cannot reopen)"
  )
})

test("Ticket 09 P2: updateStatus returns null for cross-tenant or non-existent case (404, not 409)", () => {
  const { store } = createStoreWithClock()
  const created = store.create(makeInput({ tenantId: "tenant-acme" }))

  // Cross-tenant: case exists but belongs to different tenant → null (404), NOT throw
  const cross = store.updateStatus(created!.id, "tenant-b-other", "claimed")
  assert.equal(cross, null, "cross-tenant updateStatus returns null (404), does not throw 409")

  // Non-existent case → null (404)
  const missing = store.updateStatus("case-does-not-exist", "tenant-acme", "claimed")
  assert.equal(missing, null, "non-existent case updateStatus returns null (404)")
})

test("Ticket 09 P2: InvalidHandoffTransitionError carries from/to status for 409 response payload", () => {
  const { store } = createStoreWithClock()
  const created = store.create(makeInput({ runId: "run-err-fields" }))
  try {
    store.updateStatus(created!.id, "tenant-acme", "resolved")
    assert.fail("should have thrown")
  } catch (err) {
    assert.ok(err instanceof InvalidHandoffTransitionError)
    const e = err as InvalidHandoffTransitionError
    assert.equal(e.fromStatus, "open")
    assert.equal(e.toStatus, "resolved")
    assert.equal(e.name, "InvalidHandoffTransitionError")
  }
})
