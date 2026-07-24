// Ticket 10 Phase D P3 — Hard invariants evaluator tests.
//
// Spec §9 L1558:
//   Hard release invariants are:
//     - terminal convergence 100%
//     - unknown Citation count 0
//     - knowledge `completed` with zero references 0
//     - unauthorized Evidence count 0
//     - direct-route completion without Retrieval at least 95%
//     - cancellation with late answer count 0
//
// These invariants are DETERMINISTIC and NON-OVERRIDABLE (spec L1561 — model-judge
// scores cannot override). Input: GoldenCase[] + CaseResult[]. Output: HardInvariantResult[].

import test from "node:test"
import assert from "node:assert/strict"

import type { CaseResult, GoldenCase } from "./types"
import { APPROVED_READ_ONLY_TOOLS } from "./types"
import { evaluateHardInvariants } from "./hard_invariants"
import { GOLDEN_SET } from "./golden/fixtures"

function mkResult(caseId: string, opts: Partial<CaseResult> = {}): CaseResult {
  return {
    caseId,
    status: "passed",
    terminalStatus: "completed",
    retrievedEvidenceIds: [],
    citationsInAnswer: [],
    durationMs: 100,
    tokenCount: 10,
    ...opts,
  }
}

/**
 * Generate 60+ CaseResults that pass every hard invariant for GOLDEN_SET.
 * - direct cases: completed + 0 retrieval + 0 citations (no retrieval needed)
 * - simple/complex: completed + retrieved ⊆ (sources ∪ evidence) + citations ⊆ evidence
 * - ambiguous: clarification_required + 0 retrieval + 0 citations
 * - insufficient: insufficient_evidence + retrieved ⊆ evidence + citations ⊆ evidence
 * - correction: completed + retrieved ⊆ (sources ∪ evidence) + citations ⊆ evidence
 * - tool-loop cases (scenario present): iterationsExecuted/toolCallCount within
 *   expectedMaxIterations/expectedMaxToolCalls; selectedTools ⊆ APPROVED_READ_ONLY_TOOLS
 */
function mkPassingResults(cases: GoldenCase[]): CaseResult[] {
  return cases.map((c) => {
    if (c.category === "direct") {
      return mkResult(c.id, {
        routeDecision: "direct",
        terminalStatus: "completed",
        retrievedEvidenceIds: [],
        citationsInAnswer: [],
      })
    }
    if (c.category === "ambiguous") {
      return mkResult(c.id, {
        routeDecision: "ambiguous",
        terminalStatus: "clarification_required",
        retrievedEvidenceIds: [],
        citationsInAnswer: [],
      })
    }
    if (c.category === "insufficient") {
      return mkResult(c.id, {
        routeDecision: c.expectedRoute ?? "simple",
        terminalStatus: "insufficient_evidence",
        retrievedEvidenceIds: [...c.acceptableEvidenceIds],
        citationsInAnswer: [...c.acceptableEvidenceIds],
      })
    }
    // simple / complex / correction: completed with citations
    const base = mkResult(c.id, {
      routeDecision: c.expectedRoute ?? "simple",
      terminalStatus: "completed",
      retrievedEvidenceIds: [...c.expectedSourceIds, ...c.acceptableEvidenceIds],
      citationsInAnswer: [...c.acceptableEvidenceIds],
    })
    // Ticket 10: tool-loop cases need budget + tool-selection fields to pass
    // the new invariants `tool_loop_budget_termination` and `unauthorized_tool_rejection`.
    if (c.scenario !== undefined) {
      base.iterationsExecuted = Math.min(c.expectedMaxIterations ?? 3, 1)
      base.toolCallCount = Math.min(c.expectedMaxToolCalls ?? 4, 1)
      base.selectedTools = ["semantic_lexical_hybrid"]
      if (c.expectedFallback === true) {
        base.fallbackUsed = true
        base.complexLoopStopReason = "fallback"
      } else {
        base.fallbackUsed = false
        base.complexLoopStopReason = "complete"
      }
    }
    return base
  })
}

test("Ticket 10 P3: evaluateHardInvariants returns exactly 8 HardInvariantResult entries", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  const out = evaluateHardInvariants(GOLDEN_SET.cases, results)
  assert.equal(out.length, 8)
  const keys = out.map((r) => r.key)
  assert.deepEqual(keys, [
    "terminal_convergence_100",
    "unknown_citation_count_zero",
    "knowledge_completed_zero_refs_zero",
    "unauthorized_evidence_zero",
    "direct_route_completion_without_retrieval_95",
    "cancellation_late_answer_zero",
    "tool_loop_budget_termination",
    "unauthorized_tool_rejection",
  ])
})

test("Ticket 10 P3: all 8 invariants pass when golden set has all passing results", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  const out = evaluateHardInvariants(GOLDEN_SET.cases, results)
  for (const r of out) {
    assert.equal(r.passed, true, `${r.key} should pass — actual: ${r.actual}, failing: ${r.failingCaseIds.join(",")}`)
    assert.equal(r.failingCaseIds.length, 0, `${r.key} should have 0 failing case ids`)
  }
})

test("Ticket 10 P3: terminal_convergence_100 fails when a result lacks terminalStatus", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  results[0] = { ...results[0], terminalStatus: undefined }
  const out = evaluateHardInvariants(GOLDEN_SET.cases, results)
  const inv = out.find((r) => r.key === "terminal_convergence_100")!
  assert.equal(inv.passed, false)
  assert.equal(inv.failingCaseIds.length, 1)
  assert.equal(inv.failingCaseIds[0], results[0].caseId)
  // Dynamically compute expected ratio — GOLDEN_SET case count may grow across tickets.
  const total = GOLDEN_SET.cases.length
  const reached = total - 1
  const pct = ((reached / total) * 100).toFixed(1)
  assert.match(inv.actual, new RegExp(`${reached}\\/${total} \\(${pct}%\\)`))
})

test("Ticket 10 P3: terminal_convergence_100 fails when result status=skipped", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  results[5] = { ...results[5], status: "skipped", terminalStatus: undefined }
  const out = evaluateHardInvariants(GOLDEN_SET.cases, results)
  const inv = out.find((r) => r.key === "terminal_convergence_100")!
  assert.equal(inv.passed, false)
  assert.ok(inv.failingCaseIds.includes(results[5].caseId))
})

test("Ticket 10 P3: unknown_citation_count_zero fails when a result has citation outside acceptableEvidenceIds", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  // simple-01 — acceptableEvidenceIds: ["evidence-onboarding-v2-01"]
  // Inject unknown citation.
  results[10] = { ...results[10], citationsInAnswer: ["evidence-onboarding-v2-01", "evidence-unknown-citation"] }
  const out = evaluateHardInvariants(GOLDEN_SET.cases, results)
  const inv = out.find((r) => r.key === "unknown_citation_count_zero")!
  assert.equal(inv.passed, false)
  assert.equal(inv.failingCaseIds.length, 1)
  assert.equal(inv.failingCaseIds[0], "simple-01")
})

test("Ticket 10 P3: unknown_citation_count_zero passes when all citations are in acceptableEvidenceIds", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  const out = evaluateHardInvariants(GOLDEN_SET.cases, results)
  const inv = out.find((r) => r.key === "unknown_citation_count_zero")!
  assert.equal(inv.passed, true)
  assert.equal(inv.failingCaseIds.length, 0)
})

test("Ticket 10 P3: knowledge_completed_zero_refs_zero fails when knowledge case completed with 0 citations", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  // simple-01 — knowledge route, terminalStatus=completed, citationsInAnswer=[]
  results[10] = { ...results[10], terminalStatus: "completed", citationsInAnswer: [] }
  const out = evaluateHardInvariants(GOLDEN_SET.cases, results)
  const inv = out.find((r) => r.key === "knowledge_completed_zero_refs_zero")!
  assert.equal(inv.passed, false)
  assert.ok(inv.failingCaseIds.includes("simple-01"))
})

test("Ticket 10 P3: knowledge_completed_zero_refs_zero does NOT fail when knowledge case terminalStatus is insufficient_evidence", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  // simple-01 — knowledge route but terminalStatus=insufficient_evidence (legitimate)
  results[10] = { ...results[10], terminalStatus: "insufficient_evidence", citationsInAnswer: [] }
  const out = evaluateHardInvariants(GOLDEN_SET.cases, results)
  const inv = out.find((r) => r.key === "knowledge_completed_zero_refs_zero")!
  assert.equal(inv.passed, true, "insufficient_evidence is not 'completed' — invariant should not fire")
})

test("Ticket 10 P3: knowledge_completed_zero_refs_zero does NOT fail for direct cases (no retrieval)", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  // direct-01 — terminalStatus=completed + citationsInAnswer=[] is fine (direct has no retrieval)
  // Already the case in passing results.
  const out = evaluateHardInvariants(GOLDEN_SET.cases, results)
  const inv = out.find((r) => r.key === "knowledge_completed_zero_refs_zero")!
  assert.equal(inv.passed, true)
})

test("Ticket 10 P3: unauthorized_evidence_zero fails when a result retrieved evidence outside expected/acceptable", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  // simple-01 — expectedSourceIds: ["source-onboarding-v2"], acceptableEvidenceIds: ["evidence-onboarding-v2-01"]
  results[10] = { ...results[10], retrievedEvidenceIds: ["source-onboarding-v2", "evidence-unauthorized"] }
  const out = evaluateHardInvariants(GOLDEN_SET.cases, results)
  const inv = out.find((r) => r.key === "unauthorized_evidence_zero")!
  assert.equal(inv.passed, false)
  assert.ok(inv.failingCaseIds.includes("simple-01"))
})

test("Ticket 10 P3: unauthorized_evidence_zero fails when result case is not found in GoldenCase[]", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  results.push(mkResult("unknown-case-xx", { terminalStatus: "completed", retrievedEvidenceIds: ["evidence-x"] }))
  const out = evaluateHardInvariants(GOLDEN_SET.cases, results)
  const inv = out.find((r) => r.key === "unauthorized_evidence_zero")!
  assert.equal(inv.passed, false)
  assert.ok(inv.failingCaseIds.includes("unknown-case-xx"))
})

test("Ticket 10 P3: direct_route_completion_without_retrieval_95 passes when 0/10 direct cases have retrieval (100%)", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  const out = evaluateHardInvariants(GOLDEN_SET.cases, results)
  const inv = out.find((r) => r.key === "direct_route_completion_without_retrieval_95")!
  assert.equal(inv.passed, true)
  assert.match(inv.actual, /10\/10 \(100\.0%\)/)
})

test("Ticket 10 P3: direct_route_completion_without_retrieval_95 passes at 95% threshold (19/20)", () => {
  // 10 direct cases is not enough to test the 95% boundary cleanly (1 failure = 90% fails).
  // Replicate direct cases to 20 with 1 failure = 19/20 = 95% passes.
  const directCases = GOLDEN_SET.cases.filter((c) => c.category === "direct")
  const doubledDirect: GoldenCase[] = [
    ...directCases,
    ...directCases.map((c) => ({ ...c, id: c.id + "-dup" })),
  ]
  const results: CaseResult[] = mkPassingResults(doubledDirect)
  results[0] = { ...results[0], retrievedEvidenceIds: ["evidence-anything"] }
  const out = evaluateHardInvariants(doubledDirect, results)
  const inv = out.find((r) => r.key === "direct_route_completion_without_retrieval_95")!
  assert.equal(inv.passed, true, "19/20 = 95% should pass at >= 95% threshold")
  assert.match(inv.actual, /19\/20 \(95\.0%\)/)
})

test("Ticket 10 P3: direct_route_completion_without_retrieval_95 fails when below 95% threshold", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  // 10 direct cases — 1 failure = 9/10 = 90% < 95% → fails
  results[0] = { ...results[0], retrievedEvidenceIds: ["evidence-anything"] }
  const out = evaluateHardInvariants(GOLDEN_SET.cases, results)
  const inv = out.find((r) => r.key === "direct_route_completion_without_retrieval_95")!
  assert.equal(inv.passed, false)
  assert.match(inv.actual, /9\/10 \(90\.0%\)/)
  assert.ok(inv.failingCaseIds.includes("direct-01"))
})

test("Ticket 10 P3: cancellation_late_answer_zero fails when a cancelled case has citations", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  // direct-01 cancelled but with citations in answer (late answer after cancel)
  results[0] = { ...results[0], terminalStatus: "cancelled", citationsInAnswer: ["evidence-onboarding-v2-01"] }
  const out = evaluateHardInvariants(GOLDEN_SET.cases, results)
  const inv = out.find((r) => r.key === "cancellation_late_answer_zero")!
  assert.equal(inv.passed, false)
  assert.ok(inv.failingCaseIds.includes("direct-01"))
})

test("Ticket 10 P3: cancellation_late_answer_zero passes when cancelled case has no citations", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  results[0] = { ...results[0], terminalStatus: "cancelled", citationsInAnswer: [] }
  const out = evaluateHardInvariants(GOLDEN_SET.cases, results)
  const inv = out.find((r) => r.key === "cancellation_late_answer_zero")!
  assert.equal(inv.passed, true)
})

test("Ticket 10 P3: empty results array passes all invariants vacuously", () => {
  const out = evaluateHardInvariants(GOLDEN_SET.cases, [])
  for (const r of out) {
    assert.equal(r.passed, true, `${r.key} should pass vacuously when results=[]`)
  }
})

test("Ticket 10 P3: HardInvariantResult.actual is a human-readable string (not just a number)", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  const out = evaluateHardInvariants(GOLDEN_SET.cases, results)
  for (const r of out) {
    assert.equal(typeof r.actual, "string")
    assert.ok(r.actual.length > 0, `${r.key} actual should be non-empty`)
    assert.equal(typeof r.expected, "string")
    assert.ok(r.expected.length > 0, `${r.key} expected should be non-empty`)
  }
})

// ---------------------------------------------------------------------------
// Ticket 10 P3 — Hard invariant 7: tool_loop_budget_termination
//
// Spec §9 L1558 (Ticket 10 criterion #2): the tool loop must terminate within
// declared budgets. For each CaseResult that entered the tool loop (has
// iterationsExecuted or toolCallCount), the observed count must not exceed the
// GoldenCase's expectedMaxIterations / expectedMaxToolCalls (defaulting to
// COMPLEX_LOOP_MAX_ITERATIONS=3 / COMPLEX_LOOP_MAX_TOOL_CALLS=4 when absent).
// Cases that never entered the tool loop are excluded (vacuously pass).
// ---------------------------------------------------------------------------

test("Ticket 10 P3: tool_loop_budget_termination passes when all tool-loop cases stay within budgets", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  const out = evaluateHardInvariants(GOLDEN_SET.cases, results)
  const inv = out.find((r) => r.key === "tool_loop_budget_termination")!
  assert.equal(inv.passed, true, `expected pass — actual: ${inv.actual}, failing: ${inv.failingCaseIds.join(",")}`)
  assert.equal(inv.failingCaseIds.length, 0)
})

test("Ticket 10 P3: tool_loop_budget_termination fails when a case exceeds expectedMaxIterations", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  // simple-tool-01 — expectedMaxIterations=1; bump iterationsExecuted to 5
  const idx = results.findIndex((r) => r.caseId === "simple-tool-01")
  assert.ok(idx >= 0, "simple-tool-01 must exist in GOLDEN_SET")
  results[idx] = { ...results[idx], iterationsExecuted: 5, toolCallCount: 1 }
  const out = evaluateHardInvariants(GOLDEN_SET.cases, results)
  const inv = out.find((r) => r.key === "tool_loop_budget_termination")!
  assert.equal(inv.passed, false)
  assert.ok(inv.failingCaseIds.includes("simple-tool-01"), `failingCaseIds should include simple-tool-01 — got: ${inv.failingCaseIds.join(",")}`)
})

test("Ticket 10 P3: tool_loop_budget_termination fails when a case exceeds expectedMaxToolCalls", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  // complex-tool-02 — expectedMaxToolCalls=2; bump toolCallCount to 4
  const idx = results.findIndex((r) => r.caseId === "complex-tool-02")
  assert.ok(idx >= 0, "complex-tool-02 must exist in GOLDEN_SET")
  results[idx] = { ...results[idx], iterationsExecuted: 1, toolCallCount: 4 }
  const out = evaluateHardInvariants(GOLDEN_SET.cases, results)
  const inv = out.find((r) => r.key === "tool_loop_budget_termination")!
  assert.equal(inv.passed, false)
  assert.ok(inv.failingCaseIds.includes("complex-tool-02"))
})

test("Ticket 10 P3: tool_loop_budget_termination uses default ceilings (3/4) when GoldenCase omits expectedMax*", () => {
  // Build a synthetic case with scenario but no expectedMaxIterations/expectedMaxToolCalls.
  const syntheticCase: GoldenCase = {
    id: "synthetic-tool-99",
    version: 1,
    category: "complex",
    userMessage: "synthetic tool-loop case without explicit budgets",
    expectedSourceIds: ["source-x"],
    acceptableEvidenceIds: ["evidence-x"],
    scenario: "multi-tool",
  }
  const results: CaseResult[] = [
    mkResult("synthetic-tool-99", {
      routeDecision: "complex",
      terminalStatus: "completed",
      retrievedEvidenceIds: ["source-x", "evidence-x"],
      citationsInAnswer: ["evidence-x"],
      iterationsExecuted: 3, // exactly default ceiling (3) — should pass
      toolCallCount: 4, // exactly default ceiling (4) — should pass
      selectedTools: ["semantic_lexical_hybrid"],
    }),
  ]
  const out = evaluateHardInvariants([syntheticCase], results)
  const inv = out.find((r) => r.key === "tool_loop_budget_termination")!
  assert.equal(inv.passed, true, `3 iterations / 4 tool calls == default ceilings — should pass. actual: ${inv.actual}`)
})

test("Ticket 10 P3: tool_loop_budget_termination fails at default ceiling + 1 when GoldenCase omits expectedMax*", () => {
  const syntheticCase: GoldenCase = {
    id: "synthetic-tool-99",
    version: 1,
    category: "complex",
    userMessage: "synthetic tool-loop case without explicit budgets",
    expectedSourceIds: ["source-x"],
    acceptableEvidenceIds: ["evidence-x"],
    scenario: "multi-tool",
  }
  const results: CaseResult[] = [
    mkResult("synthetic-tool-99", {
      routeDecision: "complex",
      terminalStatus: "completed",
      retrievedEvidenceIds: ["source-x", "evidence-x"],
      citationsInAnswer: ["evidence-x"],
      iterationsExecuted: 4, // default ceiling (3) + 1 — should fail
      toolCallCount: 4,
      selectedTools: ["semantic_lexical_hybrid"],
    }),
  ]
  const out = evaluateHardInvariants([syntheticCase], results)
  const inv = out.find((r) => r.key === "tool_loop_budget_termination")!
  assert.equal(inv.passed, false)
  assert.ok(inv.failingCaseIds.includes("synthetic-tool-99"))
})

test("Ticket 10 P3: tool_loop_budget_termination passes vacuously when no case entered the tool loop", () => {
  // mkPassingResults for non-tool-loop cases has no iterationsExecuted/toolCallCount.
  // Filter GOLDEN_SET to only non-tool-loop cases.
  const nonToolLoopCases = GOLDEN_SET.cases.filter((c) => c.scenario === undefined)
  const results = mkPassingResults(nonToolLoopCases)
  // Strip any accidental tool-loop fields (defensive — mkPassingResults only adds them for scenario cases).
  for (const r of results) {
    delete r.iterationsExecuted
    delete r.toolCallCount
    delete r.selectedTools
    delete r.fallbackUsed
    delete r.complexLoopStopReason
  }
  const out = evaluateHardInvariants(nonToolLoopCases, results)
  const inv = out.find((r) => r.key === "tool_loop_budget_termination")!
  assert.equal(inv.passed, true, `no tool-loop cases — should pass vacuously. actual: ${inv.actual}`)
  assert.equal(inv.failingCaseIds.length, 0)
})

// ---------------------------------------------------------------------------
// Ticket 10 P3 — Hard invariant 8: unauthorized_tool_rejection
//
// Spec §9 L1558 (Ticket 10 criterion #3): every retrieval tool selected by the
// LLM during the tool loop must be in APPROVED_READ_ONLY_TOOLS. Any tool
// outside this set is an authorization violation (release-blocking). Cases
// without selectedTools are excluded (vacuously pass).
// ---------------------------------------------------------------------------

test("Ticket 10 P3: unauthorized_tool_rejection passes when all selectedTools are in APPROVED_READ_ONLY_TOOLS", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  const out = evaluateHardInvariants(GOLDEN_SET.cases, results)
  const inv = out.find((r) => r.key === "unauthorized_tool_rejection")!
  assert.equal(inv.passed, true, `expected pass — actual: ${inv.actual}, failing: ${inv.failingCaseIds.join(",")}`)
  assert.equal(inv.failingCaseIds.length, 0)
})

test("Ticket 10 P3: unauthorized_tool_rejection fails when a case selects a tool outside APPROVED_READ_ONLY_TOOLS", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  // complex-tool-01 — inject an unauthorized write tool
  const idx = results.findIndex((r) => r.caseId === "complex-tool-01")
  assert.ok(idx >= 0, "complex-tool-01 must exist in GOLDEN_SET")
  results[idx] = {
    ...results[idx],
    selectedTools: ["semantic_lexical_hybrid", "evil_write_tool"],
  }
  const out = evaluateHardInvariants(GOLDEN_SET.cases, results)
  const inv = out.find((r) => r.key === "unauthorized_tool_rejection")!
  assert.equal(inv.passed, false)
  assert.ok(inv.failingCaseIds.includes("complex-tool-01"), `failingCaseIds should include complex-tool-01 — got: ${inv.failingCaseIds.join(",")}`)
})

test("Ticket 10 P3: unauthorized_tool_rejection fails for any tool not in the approved set", () => {
  // Verify each approved tool passes, and one outside fails.
  const cases: GoldenCase[] = [
    {
      id: "tool-approved-01",
      version: 1,
      category: "complex",
      userMessage: "approved tool only",
      expectedSourceIds: ["source-x"],
      acceptableEvidenceIds: ["evidence-x"],
      scenario: "multi-tool",
    },
    {
      id: "tool-unauthorized-01",
      version: 1,
      category: "complex",
      userMessage: "unauthorized tool",
      expectedSourceIds: ["source-x"],
      acceptableEvidenceIds: ["evidence-x"],
      scenario: "multi-tool",
    },
  ]
  const results: CaseResult[] = [
    mkResult("tool-approved-01", {
      routeDecision: "complex",
      terminalStatus: "completed",
      retrievedEvidenceIds: ["source-x", "evidence-x"],
      citationsInAnswer: ["evidence-x"],
      iterationsExecuted: 1,
      toolCallCount: 1,
      selectedTools: [...APPROVED_READ_ONLY_TOOLS], // all approved
    }),
    mkResult("tool-unauthorized-01", {
      routeDecision: "complex",
      terminalStatus: "completed",
      retrievedEvidenceIds: ["source-x", "evidence-x"],
      citationsInAnswer: ["evidence-x"],
      iterationsExecuted: 1,
      toolCallCount: 1,
      selectedTools: ["semantic_lexical_hybrid", "sql_delete"], // sql_delete not approved
    }),
  ]
  const out = evaluateHardInvariants(cases, results)
  const inv = out.find((r) => r.key === "unauthorized_tool_rejection")!
  assert.equal(inv.passed, false)
  assert.ok(inv.failingCaseIds.includes("tool-unauthorized-01"))
  assert.ok(!inv.failingCaseIds.includes("tool-approved-01"))
})

test("Ticket 10 P3: unauthorized_tool_rejection passes vacuously when no case has selectedTools", () => {
  const nonToolLoopCases = GOLDEN_SET.cases.filter((c) => c.scenario === undefined)
  const results = mkPassingResults(nonToolLoopCases)
  for (const r of results) {
    delete r.selectedTools
    delete r.iterationsExecuted
    delete r.toolCallCount
    delete r.fallbackUsed
    delete r.complexLoopStopReason
  }
  const out = evaluateHardInvariants(nonToolLoopCases, results)
  const inv = out.find((r) => r.key === "unauthorized_tool_rejection")!
  assert.equal(inv.passed, true, `no selectedTools — should pass vacuously. actual: ${inv.actual}`)
  assert.equal(inv.failingCaseIds.length, 0)
})
