// Ticket 14 — Stop conditions + rollback action tests.
//
// Verifies the stop-condition contract in `src/mastra/stop_conditions.ts`:
//   - 5 stop conditions (T07 §6.1 immediate rollback triggers)
//   - evaluateStopConditions (top-level dispatch)
//   - shouldRollback (convenience wrapper)
//   - buildRollbackAction (action record builder)
//
// Design (karpathy-guidelines):
//   - Tests are pure — they construct minimal hard invariant + smoke results
//     and verify the evaluation output. No I/O, no side effects.
//   - Each test exercises ONE stop condition's triggered / not-triggered path.
//   - Rollback action tests verify the action record shape + content.

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  evaluateStopConditions,
  shouldRollback,
  buildRollbackAction,
  STOP_CONDITIONS,
  type StopConditionResult,
  type RollbackAction,
} from "./stop_conditions"
import type {
  HardInvariantResult,
  SmokeResult,
  HardInvariantKey,
  SmokeCapabilityKey,
} from "../evaluation/types"

// ---------------------------------------------------------------------------
// Helpers — minimal invariant / smoke result builders
// ---------------------------------------------------------------------------

function makeInvariant(
  key: HardInvariantKey,
  passed: boolean,
  overrides: Partial<HardInvariantResult> = {},
): HardInvariantResult {
  return {
    key,
    passed,
    expected: `expected-${key}`,
    actual: `actual-${key}`,
    failingCaseIds: passed ? [] : ["case-1", "case-2"],
    ...overrides,
  }
}

function makeAllPassingInvariants(): HardInvariantResult[] {
  return [
    makeInvariant("terminal_convergence_100", true),
    makeInvariant("unknown_citation_count_zero", true),
    makeInvariant("knowledge_completed_zero_refs_zero", true),
    makeInvariant("unauthorized_evidence_zero", true),
    makeInvariant("direct_route_completion_without_retrieval_95", true),
    makeInvariant("cancellation_late_answer_zero", true),
    makeInvariant("tool_loop_budget_termination", true),
    makeInvariant("unauthorized_tool_rejection", true),
  ]
}

function makeSmokeResult(
  capability: SmokeCapabilityKey,
  profile: "local" | "production",
  status: "passed" | "failed" | "skipped",
  overrides: Partial<SmokeResult> = {},
): SmokeResult {
  return {
    capability,
    profile,
    status,
    durationMs: 100,
    ...(status === "failed" ? { reason: "probe failed" } : {}),
    ...overrides,
  } as SmokeResult
}

function makeAllPassingSmoke(profile: "local" | "production"): SmokeResult[] {
  const capabilities: SmokeCapabilityKey[] = [
    "markitdown", "marker", "mineru",
    "elasticsearch_vector", "elasticsearch_bm25", "neo4j",
    "pageindex", "embedding", "chat",
    "cancellation", "graceful_shutdown", "langfuse",
  ]
  return capabilities.map((c) => makeSmokeResult(c, profile, "passed"))
}

// ---------------------------------------------------------------------------
// Tests — STOP_CONDITIONS constant
// ---------------------------------------------------------------------------

test("STOP_CONDITIONS has 5 conditions in spec order", () => {
  assert.deepEqual([...STOP_CONDITIONS], [
    "hard_invariant_regression",
    "smoke_gate_failure",
    "terminal_convergence_below_100",
    "unknown_citation_above_zero",
    "unauthorized_evidence_above_zero",
  ])
})

// ---------------------------------------------------------------------------
// Tests — evaluateStopConditions (5 stop conditions)
// ---------------------------------------------------------------------------

test("evaluateStopConditions: all passing → shouldRollback=false", () => {
  const evaluation = evaluateStopConditions({
    hardInvariants: makeAllPassingInvariants(),
    smokeResults: makeAllPassingSmoke("production"),
  })
  assert.equal(evaluation.shouldRollback, false)
  assert.equal(evaluation.triggered.length, 0)
  assert.equal(evaluation.results.length, 5)
  for (const r of evaluation.results) {
    assert.equal(r.triggered, false, `${r.key} should not trigger`)
  }
})

test("evaluateStopConditions: hard invariant regression triggers #1", () => {
  const invariants = makeAllPassingInvariants()
  // Flip one invariant to failing.
  invariants[0] = makeInvariant("terminal_convergence_100", false)
  const evaluation = evaluateStopConditions({
    hardInvariants: invariants,
    smokeResults: makeAllPassingSmoke("production"),
  })
  assert.equal(evaluation.shouldRollback, true)
  const triggered = evaluation.triggered.map((r) => r.key)
  assert.ok(triggered.includes("hard_invariant_regression"))
})

test("evaluateStopConditions: smoke gate failure triggers #2 (production profile)", () => {
  const smoke = makeAllPassingSmoke("production")
  // Flip one smoke check to failed.
  smoke[0] = makeSmokeResult("markitdown", "production", "failed")
  const evaluation = evaluateStopConditions({
    hardInvariants: makeAllPassingInvariants(),
    smokeResults: smoke,
  })
  assert.equal(evaluation.shouldRollback, true)
  const triggered = evaluation.triggered.map((r) => r.key)
  assert.ok(triggered.includes("smoke_gate_failure"))
})

test("evaluateStopConditions: local profile smoke failures do NOT trigger #2 (productionProfileOnly default)", () => {
  const smoke = makeAllPassingSmoke("local")
  // Flip one local smoke check to failed — should NOT trigger rollback.
  smoke[0] = makeSmokeResult("markitdown", "local", "failed")
  const evaluation = evaluateStopConditions({
    hardInvariants: makeAllPassingInvariants(),
    smokeResults: smoke,
    // productionProfileOnly defaults to true — local failures ignored.
  })
  const smokeResult = evaluation.results.find(
    (r) => r.key === "smoke_gate_failure",
  )
  assert.equal(smokeResult?.triggered, false)
  assert.equal(evaluation.shouldRollback, false)
})

test("evaluateStopConditions: productionProfileOnly=false → local failures trigger #2", () => {
  const smoke = makeAllPassingSmoke("local")
  smoke[0] = makeSmokeResult("markitdown", "local", "failed")
  const evaluation = evaluateStopConditions({
    hardInvariants: makeAllPassingInvariants(),
    smokeResults: smoke,
    productionProfileOnly: false,
  })
  const smokeResult = evaluation.results.find(
    (r) => r.key === "smoke_gate_failure",
  )
  assert.equal(smokeResult?.triggered, true)
  assert.equal(evaluation.shouldRollback, true)
})

test("evaluateStopConditions: terminal convergence < 100% triggers #3", () => {
  const invariants = makeAllPassingInvariants()
  // terminal_convergence_100 set to failing.
  const convIdx = invariants.findIndex(
    (h) => h.key === "terminal_convergence_100",
  )
  invariants[convIdx] = makeInvariant("terminal_convergence_100", false, {
    actual: "59/60 (98.3%)",
  })
  const evaluation = evaluateStopConditions({
    hardInvariants: invariants,
    smokeResults: makeAllPassingSmoke("production"),
  })
  const triggered = evaluation.triggered.map((r) => r.key)
  assert.ok(triggered.includes("terminal_convergence_below_100"))
  assert.ok(triggered.includes("hard_invariant_regression"), "hard invariant regression also fires")
  const termResult = evaluation.results.find(
    (r) => r.key === "terminal_convergence_below_100",
  )
  assert.ok(termResult?.reason.includes("98.3%"))
})

test("evaluateStopConditions: unknown citation > 0 triggers #4", () => {
  const invariants = makeAllPassingInvariants()
  const citIdx = invariants.findIndex(
    (h) => h.key === "unknown_citation_count_zero",
  )
  invariants[citIdx] = makeInvariant("unknown_citation_count_zero", false, {
    actual: "2 cases with unknown citations",
  })
  const evaluation = evaluateStopConditions({
    hardInvariants: invariants,
    smokeResults: makeAllPassingSmoke("production"),
  })
  const triggered = evaluation.triggered.map((r) => r.key)
  assert.ok(triggered.includes("unknown_citation_above_zero"))
})

test("evaluateStopConditions: unauthorized evidence > 0 triggers #5", () => {
  const invariants = makeAllPassingInvariants()
  const unauthIdx = invariants.findIndex(
    (h) => h.key === "unauthorized_evidence_zero",
  )
  invariants[unauthIdx] = makeInvariant("unauthorized_evidence_zero", false, {
    actual: "1 cases with unauthorized evidence",
  })
  const evaluation = evaluateStopConditions({
    hardInvariants: invariants,
    smokeResults: makeAllPassingSmoke("production"),
  })
  const triggered = evaluation.triggered.map((r) => r.key)
  assert.ok(triggered.includes("unauthorized_evidence_above_zero"))
})

test("evaluateStopConditions: all 5 stop conditions trigger simultaneously", () => {
  const invariants = makeAllPassingInvariants()
  // Flip all three specialized invariants.
  const convIdx = invariants.findIndex((h) => h.key === "terminal_convergence_100")
  invariants[convIdx] = makeInvariant("terminal_convergence_100", false)
  const citIdx = invariants.findIndex((h) => h.key === "unknown_citation_count_zero")
  invariants[citIdx] = makeInvariant("unknown_citation_count_zero", false)
  const unauthIdx = invariants.findIndex((h) => h.key === "unauthorized_evidence_zero")
  invariants[unauthIdx] = makeInvariant("unauthorized_evidence_zero", false)
  // Plus a smoke failure.
  const smoke = makeAllPassingSmoke("production")
  smoke[0] = makeSmokeResult("markitdown", "production", "failed")
  const evaluation = evaluateStopConditions({
    hardInvariants: invariants,
    smokeResults: smoke,
  })
  assert.equal(evaluation.triggered.length, 5)
  assert.equal(evaluation.shouldRollback, true)
})

test("evaluateStopConditions: missing invariant in results → not triggered", () => {
  // Provide hardInvariants WITHOUT terminal_convergence_100 — the
  // specialized stop condition should report "not present" (not triggered).
  const invariants = makeAllPassingInvariants().filter(
    (h) => h.key !== "terminal_convergence_100",
  )
  const evaluation = evaluateStopConditions({
    hardInvariants: invariants,
    smokeResults: makeAllPassingSmoke("production"),
  })
  const termResult = evaluation.results.find(
    (r) => r.key === "terminal_convergence_below_100",
  )
  assert.equal(termResult?.triggered, false)
  assert.ok(termResult?.reason.includes("not present"))
})

test("evaluateStopConditions: no inputs → no triggers", () => {
  const evaluation = evaluateStopConditions({})
  assert.equal(evaluation.shouldRollback, false)
  assert.equal(evaluation.triggered.length, 0)
  for (const r of evaluation.results) {
    assert.equal(r.triggered, false)
    assert.ok(r.reason.includes("no"))
  }
})

// ---------------------------------------------------------------------------
// Tests — shouldRollback (convenience wrapper)
// ---------------------------------------------------------------------------

test("shouldRollback: returns true when any stop condition triggers", () => {
  const invariants = makeAllPassingInvariants()
  invariants[0] = makeInvariant("terminal_convergence_100", false)
  assert.equal(
    shouldRollback({
      hardInvariants: invariants,
      smokeResults: makeAllPassingSmoke("production"),
    }),
    true,
  )
})

test("shouldRollback: returns false when all stop conditions pass", () => {
  assert.equal(
    shouldRollback({
      hardInvariants: makeAllPassingInvariants(),
      smokeResults: makeAllPassingSmoke("production"),
    }),
    false,
  )
})

// ---------------------------------------------------------------------------
// Tests — buildRollbackAction
// ---------------------------------------------------------------------------

test("buildRollbackAction: defaults to the pre-contraction release", () => {
  const triggered: StopConditionResult[] = [
    {
      key: "hard_invariant_regression",
      triggered: true,
      reason: "1/8 hard invariants failed",
      evidence: ["terminal_convergence_100"],
    },
  ]
  const action = buildRollbackAction(triggered)
  assert.equal(action.strategy, "git_revert_redeploy")
  assert.equal(action.releaseRef, "pre-mastra-contraction")
  assert.deepEqual(action.triggeredConditions, ["hard_invariant_regression"])
  assert.ok(action.reason.includes("hard_invariant_regression"))
  assert.ok(action.reason.includes("1/8 hard invariants failed"))
  assert.ok(action.timestamp.length > 0)  // ISO 8601 timestamp
})

test("buildRollbackAction: accepts an explicit release reference", () => {
  const triggered: StopConditionResult[] = [
    {
      key: "smoke_gate_failure",
      triggered: true,
      reason: "1/12 smoke checks failed",
      evidence: ["markitdown (production)"],
    },
  ]
  const action = buildRollbackAction(triggered, { releaseRef: "release-2026-07-19" })
  assert.equal(action.releaseRef, "release-2026-07-19")
})

test("buildRollbackAction: multiple triggered conditions joined with '; '", () => {
  const triggered: StopConditionResult[] = [
    { key: "hard_invariant_regression", triggered: true, reason: "fail A" },
    { key: "smoke_gate_failure", triggered: true, reason: "fail B" },
    { key: "terminal_convergence_below_100", triggered: true, reason: "fail C" },
  ]
  const action = buildRollbackAction(triggered)
  assert.equal(action.triggeredConditions.length, 3)
  assert.ok(action.reason.includes("fail A"))
  assert.ok(action.reason.includes("fail B"))
  assert.ok(action.reason.includes("fail C"))
  // Reason parts joined with "; "
  assert.ok(action.reason.includes("; "))
})

test("buildRollbackAction: empty triggered list → empty action", () => {
  const action = buildRollbackAction([])
  assert.equal(action.releaseRef, "pre-mastra-contraction")
  assert.deepEqual(action.triggeredConditions, [])
  assert.equal(action.reason, "")
})

test("buildRollbackAction: explicit timestamp override", () => {
  const action = buildRollbackAction([], { timestamp: "2026-01-01T00:00:00.000Z" })
  assert.equal(action.timestamp, "2026-01-01T00:00:00.000Z")
})

test("buildRollbackAction: action is JSON-serializable (audit log ready)", () => {
  const triggered: StopConditionResult[] = [
    {
      key: "unauthorized_evidence_above_zero",
      triggered: true,
      reason: "1 cases with unauthorized evidence",
      evidence: ["case-42"],
    },
  ]
  const action = buildRollbackAction(triggered)
  // Should not throw on JSON.stringify.
  const json = JSON.stringify(action)
  const parsed = JSON.parse(json) as RollbackAction
  assert.equal(parsed.strategy, "git_revert_redeploy")
  assert.equal(parsed.releaseRef, "pre-mastra-contraction")
  assert.deepEqual(parsed.triggeredConditions, ["unauthorized_evidence_above_zero"])
})

// ---------------------------------------------------------------------------
// Tests — full evaluation + rollback action integration
// ---------------------------------------------------------------------------

test("integration: stop condition triggers → build rollback action with full context", () => {
  const invariants = makeAllPassingInvariants()
  const unauthIdx = invariants.findIndex(
    (h) => h.key === "unauthorized_evidence_zero",
  )
  invariants[unauthIdx] = makeInvariant("unauthorized_evidence_zero", false, {
    actual: "3 cases with unauthorized evidence",
    failingCaseIds: ["case-1", "case-2", "case-3"],
  })

  const evaluation = evaluateStopConditions({
    hardInvariants: invariants,
    smokeResults: makeAllPassingSmoke("production"),
  })

  assert.equal(evaluation.shouldRollback, true)
  const action = buildRollbackAction(evaluation.triggered)
  assert.equal(action.strategy, "git_revert_redeploy")
  assert.equal(action.releaseRef, "pre-mastra-contraction")
  // Both hard_invariant_regression and unauthorized_evidence_above_zero
  // should fire (the latter is a specialization of the former).
  assert.ok(action.triggeredConditions.includes("hard_invariant_regression"))
  assert.ok(action.triggeredConditions.includes("unauthorized_evidence_above_zero"))
  assert.ok(action.reason.includes("3 cases with unauthorized evidence"))
})
