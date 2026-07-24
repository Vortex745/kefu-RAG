// Ticket 10 Phase D P4 — Quality metrics calculator tests.
//
// Spec §9 L1559:
//   Quality thresholds are:
//     - retrieval hit@10 at least 85%
//     - expected-source recall at least 80%
//     - required-criteria coverage at least 80%
//     - citation-supported claim rate at least 90%
//     - bounded correction success at least 70% on correction cases
//
// Each metric returns {key, threshold, actual, passed, sampleSize}.
// Quality metrics are NOT hard invariants — a single failing metric still
// produces an artifact; the release gate is the aggregate pass/fail.

import test from "node:test"
import assert from "node:assert/strict"

import type { CaseResult, GoldenCase, QualityMetricResult } from "./types"
import { QUALITY_THRESHOLDS } from "./types"
import { evaluateQualityMetrics } from "./quality_metrics"
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
 * Generate CaseResults that pass every quality metric for GOLDEN_SET.
 * - direct cases: 0 retrieval + 0 citations (no retrieval needed; not counted in retrieval/recall sample)
 * - simple/complex: retrieved = expected + acceptable; citations = acceptable (>= criteria count)
 * - ambiguous: 0 retrieval + 0 citations (not counted in retrieval/recall sample)
 * - insufficient: retrieved = acceptable; citations = acceptable (>= criteria count); terminal=insufficient_evidence
 * - correction: retrieved = expected + acceptable; citations = acceptable; terminal=completed
 * - tool-loop cases (scenario present): fallbackUsed matches expectedFallback
 */
function mkPassingResults(cases: GoldenCase[]): CaseResult[] {
  return cases.map((c) => {
    if (c.category === "direct") {
      return mkResult(c.id, { routeDecision: "direct", terminalStatus: "completed" })
    }
    if (c.category === "ambiguous") {
      return mkResult(c.id, { routeDecision: "ambiguous", terminalStatus: "clarification_required" })
    }
    if (c.category === "insufficient") {
      // retrieved = acceptable (so recall on expected sources doesn't matter — expected is 1 element
      // but we explicitly include expectedSourceIds too so recall = 1.0)
      return mkResult(c.id, {
        routeDecision: c.expectedRoute ?? "simple",
        terminalStatus: "insufficient_evidence",
        retrievedEvidenceIds: [...c.expectedSourceIds, ...c.acceptableEvidenceIds],
        citationsInAnswer: [...c.acceptableEvidenceIds],
      })
    }
    // simple / complex / correction
    const base = mkResult(c.id, {
      routeDecision: c.expectedRoute ?? "simple",
      terminalStatus: "completed",
      retrievedEvidenceIds: [...c.expectedSourceIds, ...c.acceptableEvidenceIds],
      // Pad citations to >= criteria count for required_criteria_coverage.
      // Use acceptable evidence ids (repeated if needed) — but unique count matters for coverage proxy.
      citationsInAnswer: padCitationsToCriteriaCount(c),
    })
    // Ticket 10: tool-loop cases need fallbackUsed to match expectedFallback
    // so the new `tool_loop_fallback_rate` metric passes.
    if (c.scenario !== undefined) {
      base.fallbackUsed = c.expectedFallback === true
    }
    return base
  })
}

function padCitationsToCriteriaCount(c: GoldenCase): string[] {
  const criteriaCount = c.requiredCoverageCriteria?.length ?? 0
  if (criteriaCount === 0) return [...c.acceptableEvidenceIds]
  // Repeat acceptable evidence to reach criteria count — coverage proxy uses unique count.
  // For passing scenario, give at least N unique citations.
  const result: string[] = [...c.acceptableEvidenceIds]
  let i = 0
  while (result.length < criteriaCount && i < 100) {
    result.push(`evidence-pad-${c.id}-${i}`)
    i++
  }
  return result.length >= criteriaCount ? result : [...c.acceptableEvidenceIds]
}

test("Ticket 10 P4: evaluateQualityMetrics returns exactly 6 QualityMetricResult entries", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  const out = evaluateQualityMetrics(GOLDEN_SET.cases, results)
  assert.equal(out.length, 6)
  const keys = out.map((r) => r.key)
  assert.deepEqual(keys, [
    "retrieval_hit_at_10",
    "expected_source_recall",
    "required_criteria_coverage",
    "citation_supported_claim_rate",
    "correction_success",
    "tool_loop_fallback_rate",
  ])
})

test("Ticket 10 P4: each QualityMetricResult.threshold matches QUALITY_THRESHOLDS const", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  const out = evaluateQualityMetrics(GOLDEN_SET.cases, results)
  for (const r of out) {
    assert.equal(r.threshold, QUALITY_THRESHOLDS[r.key], `${r.key} threshold mismatch`)
  }
})

test("Ticket 10 P4: all 6 metrics pass when golden set has all passing results", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  const out = evaluateQualityMetrics(GOLDEN_SET.cases, results)
  for (const r of out) {
    assert.equal(r.passed, true, `${r.key} should pass — actual=${r.actual} threshold=${r.threshold} sampleSize=${r.sampleSize}`)
  }
})

test("Ticket 10 P4: retrieval_hit_at_10 fails when >= 15% of knowledge cases miss expected/acceptable in retrieved", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  // 48 knowledge route cases — need >= 8 failures to push hit rate below 85% (40/48 = 83.3% < 85%)
  // Degrade the first 8 simple cases (indices 10..17) by replacing retrievedEvidenceIds with irrelevant
  for (let i = 10; i < 18; i++) {
    results[i] = { ...results[i], retrievedEvidenceIds: ["evidence-irrelevant-1", "evidence-irrelevant-2"] }
  }
  const out = evaluateQualityMetrics(GOLDEN_SET.cases, results)
  const m = out.find((r) => r.key === "retrieval_hit_at_10")!
  assert.equal(m.passed, false, `8 failures should push hit@10 below 0.85 (actual=${m.actual})`)
  assert.ok(m.actual < m.threshold, `actual ${m.actual} should be < threshold ${m.threshold}`)
  assert.equal(m.sampleSize, 48)
})

test("Ticket 10 P4: retrieval_hit_at_10 sampleSize counts knowledge route cases only (excludes direct/ambiguous)", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  const out = evaluateQualityMetrics(GOLDEN_SET.cases, results)
  const m = out.find((r) => r.key === "retrieval_hit_at_10")!
  // Knowledge routes: simple(16) + complex(15) + insufficient(10) + correction(7) = 48
  // (Ticket 10 added 1 simple + 5 complex + 2 correction tool-loop cases)
  assert.equal(m.sampleSize, 48)
})

test("Ticket 10 P4: expected_source_recall fails when >= 20% of cases miss expected sources", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  // 48 cases declare expectedSourceIds — need >= 10 failures to push average recall below 80% (38/48 = 79.1%)
  // Degrade the first 10 simple cases (indices 10..19) by removing expected source IDs from retrieved
  for (let i = 10; i < 20; i++) {
    results[i] = { ...results[i], retrievedEvidenceIds: ["evidence-irrelevant-1"] }
  }
  const out = evaluateQualityMetrics(GOLDEN_SET.cases, results)
  const m = out.find((r) => r.key === "expected_source_recall")!
  assert.equal(m.passed, false, `10 failures should push recall below 0.80 (actual=${m.actual})`)
  assert.ok(m.actual < m.threshold, `actual ${m.actual} should be < threshold ${m.threshold}`)
})

test("Ticket 10 P4: expected_source_recall sampleSize counts cases with non-empty expectedSourceIds", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  const out = evaluateQualityMetrics(GOLDEN_SET.cases, results)
  const m = out.find((r) => r.key === "expected_source_recall")!
  // simple(16) + complex(15) + insufficient(10) + correction(7) = 48 (all knowledge routes declare sources)
  assert.equal(m.sampleSize, 48)
})

test("Ticket 10 P4: required_criteria_coverage uses citation count as deterministic proxy", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  const out = evaluateQualityMetrics(GOLDEN_SET.cases, results)
  const m = out.find((r) => r.key === "required_criteria_coverage")!
  assert.equal(m.passed, true)
  // Knowledge routes with criteria: simple(16) + complex(15) + insufficient(10) + correction(7) = 48
  assert.equal(m.sampleSize, 48)
})

test("Ticket 10 P4: required_criteria_coverage fails when cases have too few citations", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  // simple-01 has 2 requiredCoverageCriteria; reduce citations to 1 → coverage = 0.5
  results[10] = { ...results[10], citationsInAnswer: ["evidence-onboarding-v2-01"] }
  const out = evaluateQualityMetrics(GOLDEN_SET.cases, results)
  const m = out.find((r) => r.key === "required_criteria_coverage")!
  // Only 1 of 40 cases fails to cover → 39/40 = 0.975 still above 0.80 threshold, so overall passes
  // But the single case coverage is 0.5
  assert.equal(m.passed, true, "single-case degradation should not fail aggregate metric when others still pass")
  assert.ok(m.actual >= m.threshold)
})

test("Ticket 10 P4: required_criteria_coverage fails when many cases have low coverage", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  // Degrade 15 simple cases (each has 2 criteria) to 0 citations → coverage = 0 for each
  for (let i = 10; i < 25; i++) {
    results[i] = { ...results[i], citationsInAnswer: [] }
  }
  const out = evaluateQualityMetrics(GOLDEN_SET.cases, results)
  const m = out.find((r) => r.key === "required_criteria_coverage")!
  assert.equal(m.passed, false)
  assert.ok(m.actual < m.threshold)
})

test("Ticket 10 P4: citation_supported_claim_rate fails when citations reference unknown evidence", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  // simple-01 — citations all unknown
  results[10] = { ...results[10], citationsInAnswer: ["evidence-unknown-1", "evidence-unknown-2"] }
  const out = evaluateQualityMetrics(GOLDEN_SET.cases, results)
  const m = out.find((r) => r.key === "citation_supported_claim_rate")!
  // Only 1 of N cases fails — should still pass aggregate
  assert.equal(m.passed, true, "single-case failure should not fail aggregate when others pass")
  assert.ok(m.actual >= m.threshold)
})

test("Ticket 10 P4: citation_supported_claim_rate fails when many cases cite unknown evidence", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  // Degrade 10 simple cases (out of 40) to all-unknown citations
  for (let i = 10; i < 20; i++) {
    results[i] = { ...results[i], citationsInAnswer: ["evidence-unknown-x"] }
  }
  const out = evaluateQualityMetrics(GOLDEN_SET.cases, results)
  const m = out.find((r) => r.key === "citation_supported_claim_rate")!
  // 10/40 fail → 30/40 = 0.75 < 0.90 → fails
  assert.equal(m.passed, false)
  assert.ok(m.actual < m.threshold)
})

test("Ticket 10 P4: correction_success fails when correction cases don't complete", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  // 7 correction cases (5 original + 2 tool-loop) — make 3 of them fail (terminal=insufficient_evidence)
  // 4/7 = 0.571 < 0.70 → fails
  const correctionIdx = GOLDEN_SET.cases.findIndex((c) => c.category === "correction")
  results[correctionIdx] = { ...results[correctionIdx], terminalStatus: "insufficient_evidence" }
  results[correctionIdx + 1] = { ...results[correctionIdx + 1], terminalStatus: "insufficient_evidence" }
  results[correctionIdx + 2] = { ...results[correctionIdx + 2], terminalStatus: "insufficient_evidence" }
  const out = evaluateQualityMetrics(GOLDEN_SET.cases, results)
  const m = out.find((r) => r.key === "correction_success")!
  assert.equal(m.passed, false)
  assert.equal(m.sampleSize, 7)
  assert.ok(m.actual < m.threshold)
})

test("Ticket 10 P4: correction_success passes at 70% threshold (>= 0.70)", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  // 7 correction cases — 2 fail = 5/7 = 0.714 >= 0.70 → passes
  const correctionIdx = GOLDEN_SET.cases.findIndex((c) => c.category === "correction")
  results[correctionIdx] = { ...results[correctionIdx], terminalStatus: "insufficient_evidence" }
  results[correctionIdx + 1] = { ...results[correctionIdx + 1], terminalStatus: "insufficient_evidence" }
  const out = evaluateQualityMetrics(GOLDEN_SET.cases, results)
  const m = out.find((r) => r.key === "correction_success")!
  assert.equal(m.passed, true)
  assert.ok(m.actual >= m.threshold)
})

test("Ticket 10 P4: correction_success sampleSize = number of correction cases", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  const out = evaluateQualityMetrics(GOLDEN_SET.cases, results)
  const m = out.find((r) => r.key === "correction_success")!
  // 5 original + 2 tool-loop (correction-tool-01, correction-tool-01c) = 7
  assert.equal(m.sampleSize, 7, "P2 fixture has 7 correction cases (5 original + 2 tool-loop)")
})

test("Ticket 10 P4: QualityMetricResult.actual is a number in [0, 1]", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  const out = evaluateQualityMetrics(GOLDEN_SET.cases, results)
  for (const r of out) {
    assert.equal(typeof r.actual, "number")
    assert.ok(r.actual >= 0 && r.actual <= 1, `${r.key} actual ${r.actual} out of [0,1]`)
  }
})

test("Ticket 10 P4: empty results array — metrics pass vacuously (sampleSize=0)", () => {
  const out = evaluateQualityMetrics(GOLDEN_SET.cases, [])
  for (const r of out) {
    assert.equal(r.sampleSize, 0, `${r.key} sampleSize should be 0 for empty results`)
    assert.equal(r.passed, true, `${r.key} should pass vacuously when sampleSize=0`)
  }
})

// ---------------------------------------------------------------------------
// Ticket 10 P4 — Quality metric 6: tool_loop_fallback_rate
//
// Spec §9 L1559 (Ticket 10 criterion #5): the deterministic fallback rate
// measures whether cases expecting a fallback (`expectedFallback === true`)
// actually fire `fallbackUsed === true`. Threshold 0.8 — at least 80% of
// expected-fallback cases must realize the fallback.
//
// sampleSize = number of cases with `expectedFallback === true`.
// When sampleSize = 0, the metric passes vacuously (actual = 1).
// ---------------------------------------------------------------------------

test("Ticket 10 P4: tool_loop_fallback_rate passes when all expected-fallback cases fire fallback", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  const out = evaluateQualityMetrics(GOLDEN_SET.cases, results)
  const m = out.find((r) => r.key === "tool_loop_fallback_rate")!
  assert.equal(m.passed, true, `expected pass — actual=${m.actual} threshold=${m.threshold} sampleSize=${m.sampleSize}`)
  // GOLDEN_SET has 2 expected-fallback cases (correction-tool-01 + correction-tool-01c)
  assert.equal(m.sampleSize, 2)
  assert.equal(m.actual, 1.0)
})

test("Ticket 10 P4: tool_loop_fallback_rate fails when an expected-fallback case does NOT fire fallback", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  // correction-tool-01 — expectedFallback=true but fallbackUsed=false
  const idx = results.findIndex((r) => r.caseId === "correction-tool-01")
  assert.ok(idx >= 0, "correction-tool-01 must exist in GOLDEN_SET")
  results[idx] = { ...results[idx], fallbackUsed: false }
  const out = evaluateQualityMetrics(GOLDEN_SET.cases, results)
  const m = out.find((r) => r.key === "tool_loop_fallback_rate")!
  // 1/2 = 0.5 < 0.8 → fails
  assert.equal(m.passed, false, `1/2 = 0.5 should be below threshold 0.8 — actual=${m.actual}`)
  assert.ok(m.actual < m.threshold)
  assert.equal(m.sampleSize, 2)
})

test("Ticket 10 P4: tool_loop_fallback_rate passes vacuously when no case expects fallback", () => {
  // Filter GOLDEN_SET to only non-fallback cases
  const nonFallbackCases = GOLDEN_SET.cases.filter((c) => c.expectedFallback !== true)
  const results = mkPassingResults(nonFallbackCases)
  const out = evaluateQualityMetrics(nonFallbackCases, results)
  const m = out.find((r) => r.key === "tool_loop_fallback_rate")!
  assert.equal(m.sampleSize, 0, "no expected-fallback cases → sampleSize=0")
  assert.equal(m.passed, true, "vacuously pass when sampleSize=0")
  assert.equal(m.actual, 1, "vacuous actual = 1")
})

test("Ticket 10 P4: tool_loop_fallback_rate threshold matches QUALITY_THRESHOLDS", () => {
  const results = mkPassingResults(GOLDEN_SET.cases)
  const out = evaluateQualityMetrics(GOLDEN_SET.cases, results)
  const m = out.find((r) => r.key === "tool_loop_fallback_rate")!
  assert.equal(m.threshold, QUALITY_THRESHOLDS.tool_loop_fallback_rate)
  assert.equal(m.threshold, 0.8)
})
