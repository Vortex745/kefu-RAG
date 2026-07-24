// Ticket 10 Phase D P3 — Hard release invariants evaluator.
//
// Spec §9 L1558:
//   Hard release invariants are:
//     - terminal convergence 100%
//     - unknown Citation count 0
//     - knowledge `completed` with zero references 0
//     - unauthorized Evidence count 0
//     - direct-route completion without Retrieval at least 95%
//     - cancellation with late answer count 0
//     - tool loop terminates within declared budgets (Ticket 10 criterion #2)
//     - rejects tools outside approved read-only set (Ticket 10 criterion #3)
//
// These invariants are DETERMINISTIC (spec L1558) and NON-OVERRIDABLE
// (spec L1561 — model-judge scores cannot override deterministic failures).
// The evaluator consumes GoldenCase[] + CaseResult[] only — it must not call
// private Planner, Searcher or repository methods (spec L1488).
//
// Input semantics:
//   - GoldenCase[]: expected source/evidence IDs per case
//   - CaseResult[]: observed terminal status, retrieved evidence, citations
// Output: 8 HardInvariantResult entries, one per invariant.

import type {
  CaseResult,
  GoldenCase,
  HardInvariantResult,
} from "./types"
import { APPROVED_READ_ONLY_TOOLS } from "./types"

/**
 * Categories that must declare expected Source IDs or acceptable Evidence IDs
 * (spec L1557 knowledge route invariant).
 */
const KNOWLEDGE_ROUTE_CATEGORIES = new Set([
  "simple", "complex", "insufficient", "correction",
])

/**
 * Default tool-loop budget ceilings when a GoldenCase omits
 * `expectedMaxIterations` / `expectedMaxToolCalls`. These mirror the runtime
 * constants `COMPLEX_LOOP_MAX_ITERATIONS` (3) and `COMPLEX_LOOP_MAX_TOOL_CALLS`
 * (4) exported from `src/retrieval/complex_loop.ts`. They are inlined here to
 * keep the evaluation module decoupled from retrieval runtime code (dependency
 * hygiene: evaluation must not import from retrieval). If the runtime ceilings
 * ever change, update both locations — a grep for "default ceiling" finds the
 * evaluation-side reference.
 */
const DEFAULT_MAX_ITERATIONS = 3
const DEFAULT_MAX_TOOL_CALLS = 4

function findGoldenCase(cases: GoldenCase[], caseId: string): GoldenCase | undefined {
  return cases.find((c) => c.id === caseId)
}

/**
 * Spec L1558 invariant 1: terminal convergence 100%.
 *
 * Every run must reach a terminal status. A CaseResult without terminalStatus
 * (e.g. still running, or skipped) is a convergence failure.
 */
function evaluateTerminalConvergence(results: CaseResult[]): HardInvariantResult {
  const failing = results.filter((r) => r.terminalStatus === undefined)
  const total = results.length
  const reached = total - failing.length
  const pct = total === 0 ? 100 : (reached / total) * 100
  return {
    key: "terminal_convergence_100",
    passed: failing.length === 0,
    expected: "100% of runs reach a terminal status",
    actual: total === 0
      ? `0/0 (vacuously 100%)`
      : `${reached}/${total} (${pct.toFixed(1)}%)`,
    failingCaseIds: failing.map((r) => r.caseId),
  }
}

/**
 * Spec L1558 invariant 2: unknown Citation count 0.
 *
 * Every citation in the answer must reference a declared acceptable Evidence
 * ID for that case. Citations referencing evidence outside the declared set
 * are "unknown" — the answer is fabricating references.
 */
function evaluateUnknownCitationZero(
  cases: GoldenCase[],
  results: CaseResult[],
): HardInvariantResult {
  const failing: CaseResult[] = []
  for (const r of results) {
    const gc = findGoldenCase(cases, r.caseId)
    if (!gc) {
      failing.push(r)
      continue
    }
    const acceptable = new Set(gc.acceptableEvidenceIds)
    const hasUnknown = r.citationsInAnswer.some((cid) => !acceptable.has(cid))
    if (hasUnknown) failing.push(r)
  }
  return {
    key: "unknown_citation_count_zero",
    passed: failing.length === 0,
    expected: "0 cases with unknown citations",
    actual: `${failing.length} cases with unknown citations`,
    failingCaseIds: failing.map((r) => r.caseId),
  }
}

/**
 * Spec L1558 invariant 3: knowledge `completed` with zero references 0.
 *
 * A knowledge-route case (simple/complex/insufficient/correction) reaching
 * terminal status `completed` MUST include at least one citation in the
 * answer. Reaching `completed` with zero references means the system claimed
 * success without grounding — that is a release-blocking failure.
 *
 * `insufficient_evidence`, `handoff_required` and other non-completed terminal
 * statuses are NOT failures (they correctly declined to answer).
 */
function evaluateKnowledgeCompletedZeroRefsZero(
  cases: GoldenCase[],
  results: CaseResult[],
): HardInvariantResult {
  const failing: CaseResult[] = []
  for (const r of results) {
    const gc = findGoldenCase(cases, r.caseId)
    if (!gc) continue
    if (!KNOWLEDGE_ROUTE_CATEGORIES.has(gc.category)) continue
    if (r.terminalStatus === "completed" && r.citationsInAnswer.length === 0) {
      failing.push(r)
    }
  }
  return {
    key: "knowledge_completed_zero_refs_zero",
    passed: failing.length === 0,
    expected: "0 knowledge-route cases completed with zero references",
    actual: `${failing.length} knowledge-route cases completed with zero references`,
    failingCaseIds: failing.map((r) => r.caseId),
  }
}

/**
 * Spec L1558 invariant 4: unauthorized Evidence count 0.
 *
 * Every retrieved Evidence ID must be in the case's declared expected Source
 * IDs ∪ acceptable Evidence IDs. Retrieving evidence outside this set is an
 * authorization violation — the system retrieved something the case did not
 * declare as expected or acceptable.
 *
 * CaseResult referencing a case id absent from GoldenCase[] is also a failure
 * (the result cannot be matched to any expected source set).
 */
function evaluateUnauthorizedEvidenceZero(
  cases: GoldenCase[],
  results: CaseResult[],
): HardInvariantResult {
  const failing: CaseResult[] = []
  for (const r of results) {
    const gc = findGoldenCase(cases, r.caseId)
    if (!gc) {
      failing.push(r)
      continue
    }
    const authorized = new Set<string>([...gc.expectedSourceIds, ...gc.acceptableEvidenceIds])
    const hasUnauthorized = r.retrievedEvidenceIds.some((eid) => !authorized.has(eid))
    if (hasUnauthorized) failing.push(r)
  }
  return {
    key: "unauthorized_evidence_zero",
    passed: failing.length === 0,
    expected: "0 cases with unauthorized evidence",
    actual: `${failing.length} cases with unauthorized evidence`,
    failingCaseIds: failing.map((r) => r.caseId),
  }
}

/**
 * Spec L1558 invariant 5: direct-route completion without Retrieval >= 95%.
 *
 * A direct-route case (Router decision = "direct") must complete without
 * invoking Retrieval. The threshold is 95% — at most 1 in 20 direct cases may
 * have non-empty retrievedEvidenceIds.
 *
 * Cases are identified as direct-route by either routeDecision === "direct"
 * (observed at runtime) or the GoldenCase category === "direct" (declared in
 * the fixture). The 95% threshold uses `>=` per spec L1558 "at least 95%".
 */
function evaluateDirectRouteCompletionWithoutRetrieval95(
  cases: GoldenCase[],
  results: CaseResult[],
): HardInvariantResult {
  const directResults: CaseResult[] = []
  for (const r of results) {
    if (r.routeDecision === "direct") {
      directResults.push(r)
      continue
    }
    const gc = findGoldenCase(cases, r.caseId)
    if (gc?.category === "direct") directResults.push(r)
  }
  const total = directResults.length
  const passedWithoutRetrieval = directResults.filter((r) => r.retrievedEvidenceIds.length === 0).length
  const ratio = total === 0 ? 1 : passedWithoutRetrieval / total
  const failing = directResults.filter((r) => r.retrievedEvidenceIds.length > 0)
  return {
    key: "direct_route_completion_without_retrieval_95",
    passed: ratio >= 0.95,
    expected: ">= 95% direct-route cases completed without retrieval",
    actual: total === 0
      ? `0/0 (vacuously 100%)`
      : `${passedWithoutRetrieval}/${total} (${(ratio * 100).toFixed(1)}%)`,
    failingCaseIds: failing.map((r) => r.caseId),
  }
}

/**
 * Spec L1558 invariant 6: cancellation with late answer count 0.
 *
 * A cancelled run MUST NOT emit citations in the answer. Non-empty
 * citationsInAnswer on a cancelled run means the answer was generated after
 * cancellation was requested — a late-answer bug.
 */
function evaluateCancellationLateAnswerZero(results: CaseResult[]): HardInvariantResult {
  const failing = results.filter(
    (r) => r.terminalStatus === "cancelled" && r.citationsInAnswer.length > 0,
  )
  return {
    key: "cancellation_late_answer_zero",
    passed: failing.length === 0,
    expected: "0 cancellations with late answer",
    actual: `${failing.length} cancellations with late answer`,
    failingCaseIds: failing.map((r) => r.caseId),
  }
}

/**
 * Ticket 10 criterion #2 — Spec L1558 invariant 7: tool loop terminates within
 * declared budgets.
 *
 * For each CaseResult that entered the tool loop (has `iterationsExecuted` or
 * `toolCallCount` defined), the observed count must not exceed the
 * GoldenCase's `expectedMaxIterations` / `expectedMaxToolCalls`. When the
 * GoldenCase omits these fields, the default ceilings
 * `DEFAULT_MAX_ITERATIONS` (3) / `DEFAULT_MAX_TOOL_CALLS` (4) apply — mirroring
 * the runtime constants in `src/retrieval/complex_loop.ts`.
 *
 * Cases that never entered the tool loop (no `iterationsExecuted` AND no
 * `toolCallCount`) are excluded — the invariant passes vacuously for them.
 * CaseResult referencing a case id absent from GoldenCase[] uses the defaults.
 */
function evaluateToolLoopBudgetTermination(
  cases: GoldenCase[],
  results: CaseResult[],
): HardInvariantResult {
  const failing: CaseResult[] = []
  let totalChecked = 0
  for (const r of results) {
    const hasIterations = r.iterationsExecuted !== undefined
    const hasToolCalls = r.toolCallCount !== undefined
    if (!hasIterations && !hasToolCalls) continue // vacuously pass — never entered tool loop
    totalChecked++
    const gc = findGoldenCase(cases, r.caseId)
    const maxIter = gc?.expectedMaxIterations ?? DEFAULT_MAX_ITERATIONS
    const maxCalls = gc?.expectedMaxToolCalls ?? DEFAULT_MAX_TOOL_CALLS
    if (hasIterations && r.iterationsExecuted! > maxIter) {
      failing.push(r)
      continue
    }
    if (hasToolCalls && r.toolCallCount! > maxCalls) {
      failing.push(r)
      continue
    }
  }
  return {
    key: "tool_loop_budget_termination",
    passed: failing.length === 0,
    expected: `0 tool-loop cases exceeding declared budgets (default ${DEFAULT_MAX_ITERATIONS} iterations / ${DEFAULT_MAX_TOOL_CALLS} tool calls)`,
    actual: totalChecked === 0
      ? `0 tool-loop cases checked (vacuously pass)`
      : `${failing.length}/${totalChecked} tool-loop cases exceeded budgets`,
    failingCaseIds: failing.map((r) => r.caseId),
  }
}

/**
 * Ticket 10 criterion #3 — Spec L1558 invariant 8: rejects tools outside the
 * approved read-only set.
 *
 * For each CaseResult with `selectedTools` defined, every tool in the list
 * must be in `APPROVED_READ_ONLY_TOOLS`. Any tool outside this set is an
 * authorization violation — the LLM selected a tool the system did not
 * whitelist for read-only retrieval. Cases without `selectedTools` are
 * excluded (vacuously pass).
 */
function evaluateUnauthorizedToolRejection(results: CaseResult[]): HardInvariantResult {
  const approved = new Set<string>(APPROVED_READ_ONLY_TOOLS)
  const failing: CaseResult[] = []
  let totalChecked = 0
  for (const r of results) {
    if (r.selectedTools === undefined) continue // vacuously pass — no tool selection recorded
    totalChecked++
    const hasUnauthorized = r.selectedTools.some((tool) => !approved.has(tool))
    if (hasUnauthorized) failing.push(r)
  }
  return {
    key: "unauthorized_tool_rejection",
    passed: failing.length === 0,
    expected: `0 cases selecting tools outside APPROVED_READ_ONLY_TOOLS (${APPROVED_READ_ONLY_TOOLS.join(", ")})`,
    actual: totalChecked === 0
      ? `0 cases with selectedTools (vacuously pass)`
      : `${failing.length}/${totalChecked} cases selected unauthorized tools`,
    failingCaseIds: failing.map((r) => r.caseId),
  }
}

/**
 * Evaluate all 8 hard release invariants against a GoldenCase[] + CaseResult[].
 * Returns one HardInvariantResult per invariant, in spec L1558 order.
 *
 * Deterministic — no side effects, no I/O. The same inputs always produce the
 * same outputs. Model-judge scores (P5 artifact) cannot override these.
 */
export function evaluateHardInvariants(
  cases: GoldenCase[],
  results: CaseResult[],
): HardInvariantResult[] {
  return [
    evaluateTerminalConvergence(results),
    evaluateUnknownCitationZero(cases, results),
    evaluateKnowledgeCompletedZeroRefsZero(cases, results),
    evaluateUnauthorizedEvidenceZero(cases, results),
    evaluateDirectRouteCompletionWithoutRetrieval95(cases, results),
    evaluateCancellationLateAnswerZero(results),
    evaluateToolLoopBudgetTermination(cases, results),
    evaluateUnauthorizedToolRejection(results),
  ]
}
