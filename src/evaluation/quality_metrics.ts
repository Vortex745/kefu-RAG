// Ticket 10 Phase D P4 — Quality metrics calculator.
//
// Spec §9 L1559:
//   Quality thresholds are:
//     - retrieval hit@10 at least 85%
//     - expected-source recall at least 80%
//     - required-criteria coverage at least 80%
//     - citation-supported claim rate at least 90%
//     - bounded correction success at least 70% on correction cases
//     - tool-loop fallback rate at least 80% (Ticket 10 criterion #5)
//
// Quality metrics are NOT hard invariants — a failing metric still produces
// an artifact (P5); the release gate is the aggregate pass/fail. Model-judge
// scores (spec L1561) are reported SEPARATELY and cannot override these.
//
// Deterministic proxies:
//   - retrieval_hit_at_10: a case "hits" when at least one retrieved Evidence
//     ID (top-10) is in (expectedSourceIds ∪ acceptableEvidenceIds).
//   - expected_source_recall: per-case recall = |expected ∩ retrieved| / |expected|.
//   - required_criteria_coverage: per-case coverage proxy = min(1, unique
//     citations / criteria count). NLP-based coverage would require a model
//     judge; this deterministic proxy uses citation count diversity.
//   - citation_supported_claim_rate: a case "is supported" when at least one
//     citation is in acceptableEvidenceIds.
//   - correction_success: a correction case "succeeds" when terminalStatus === "completed".
//   - tool_loop_fallback_rate: of cases with expectedFallback=true, the fraction
//     where fallbackUsed=true. Measures whether the deterministic fallback fires
//     when expected (Ticket 10 criterion #5).
//
// Input: GoldenCase[] + CaseResult[]. Output: 6 QualityMetricResult entries.

import type {
  CaseResult,
  GoldenCase,
  QualityMetricKey,
  QualityMetricResult,
} from "./types"
import { QUALITY_THRESHOLDS } from "./types"

const KNOWLEDGE_ROUTE_CATEGORIES = new Set([
  "simple", "complex", "insufficient", "correction",
])

function findGoldenCase(cases: GoldenCase[], caseId: string): GoldenCase | undefined {
  return cases.find((c) => c.id === caseId)
}

/**
 * Spec L1559 metric 1: retrieval hit@10.
 *
 * A knowledge-route case "hits" when at least one of its top-10 retrieved
 * Evidence IDs is in (expectedSourceIds ∪ acceptableEvidenceIds).
 *
 * sampleSize = number of knowledge-route cases (simple/complex/insufficient/correction).
 * Direct and ambiguous cases are excluded — direct bypasses retrieval; ambiguous
 * does not retrieve until resumed.
 */
function evaluateRetrievalHitAt10(
  cases: GoldenCase[],
  results: CaseResult[],
): QualityMetricResult {
  const threshold = QUALITY_THRESHOLDS.retrieval_hit_at_10
  const knowledgeResults: { r: CaseResult; gc: GoldenCase }[] = []
  for (const r of results) {
    const gc = findGoldenCase(cases, r.caseId)
    if (!gc) continue
    if (!KNOWLEDGE_ROUTE_CATEGORIES.has(gc.category)) continue
    knowledgeResults.push({ r, gc })
  }
  const sampleSize = knowledgeResults.length
  if (sampleSize === 0) {
    return { key: "retrieval_hit_at_10", threshold, actual: 1, passed: true, sampleSize: 0 }
  }
  let hits = 0
  for (const { r, gc } of knowledgeResults) {
    const expected = new Set<string>([...gc.expectedSourceIds, ...gc.acceptableEvidenceIds])
    // top-10 retrieval — array order is the ranking
    const top10 = r.retrievedEvidenceIds.slice(0, 10)
    if (top10.some((eid) => expected.has(eid))) hits++
  }
  const actual = hits / sampleSize
  return { key: "retrieval_hit_at_10", threshold, actual, passed: actual >= threshold, sampleSize }
}

/**
 * Spec L1559 metric 2: expected-source recall.
 *
 * Per-case recall = |expectedSourceIds ∩ retrievedEvidenceIds| / |expectedSourceIds|.
 * Average across cases with non-empty expectedSourceIds.
 *
 * sampleSize = number of cases declaring expectedSourceIds.
 */
function evaluateExpectedSourceRecall(
  cases: GoldenCase[],
  results: CaseResult[],
): QualityMetricResult {
  const threshold = QUALITY_THRESHOLDS.expected_source_recall
  const perCaseRecalls: number[] = []
  for (const r of results) {
    const gc = findGoldenCase(cases, r.caseId)
    if (!gc) continue
    if (gc.expectedSourceIds.length === 0) continue
    const expected = new Set(gc.expectedSourceIds)
    const retrieved = new Set(r.retrievedEvidenceIds)
    let hit = 0
    for (const sid of expected) {
      if (retrieved.has(sid)) hit++
    }
    perCaseRecalls.push(hit / expected.size)
  }
  const sampleSize = perCaseRecalls.length
  if (sampleSize === 0) {
    return { key: "expected_source_recall", threshold, actual: 1, passed: true, sampleSize: 0 }
  }
  const actual = perCaseRecalls.reduce((a, b) => a + b, 0) / sampleSize
  return { key: "expected_source_recall", threshold, actual, passed: actual >= threshold, sampleSize }
}

/**
 * Spec L1559 metric 3: required-criteria coverage.
 *
 * Per-case coverage proxy = min(1, unique citations in answer / requiredCriteria count).
 * This is a deterministic approximation — true coverage measurement would require
 * a model judge (which spec L1561 reports separately as modelJudgeScores).
 *
 * sampleSize = number of cases declaring requiredCoverageCriteria.
 */
function evaluateRequiredCriteriaCoverage(
  cases: GoldenCase[],
  results: CaseResult[],
): QualityMetricResult {
  const threshold = QUALITY_THRESHOLDS.required_criteria_coverage
  const perCaseCoverage: number[] = []
  for (const r of results) {
    const gc = findGoldenCase(cases, r.caseId)
    if (!gc) continue
    if (!gc.requiredCoverageCriteria || gc.requiredCoverageCriteria.length === 0) continue
    const criteriaCount = gc.requiredCoverageCriteria.length
    const uniqueCitations = new Set(r.citationsInAnswer).size
    perCaseCoverage.push(Math.min(1, uniqueCitations / criteriaCount))
  }
  const sampleSize = perCaseCoverage.length
  if (sampleSize === 0) {
    return { key: "required_criteria_coverage", threshold, actual: 1, passed: true, sampleSize: 0 }
  }
  const actual = perCaseCoverage.reduce((a, b) => a + b, 0) / sampleSize
  return { key: "required_criteria_coverage", threshold, actual, passed: actual >= threshold, sampleSize }
}

/**
 * Spec L1559 metric 4: citation-supported claim rate.
 *
 * A case "is supported" when at least one citation in the answer is in
 * acceptableEvidenceIds. The aggregate rate is the fraction of cases with
 * citations that are supported.
 *
 * Cases with zero citationsInAnswer are excluded from the sample (no claims
 * to support). When sampleSize = 0, the metric passes vacuously (actual = 1).
 */
function evaluateCitationSupportedClaimRate(
  cases: GoldenCase[],
  results: CaseResult[],
): QualityMetricResult {
  const threshold = QUALITY_THRESHOLDS.citation_supported_claim_rate
  let supported = 0
  let sampleSize = 0
  for (const r of results) {
    if (r.citationsInAnswer.length === 0) continue
    sampleSize++
    const gc = findGoldenCase(cases, r.caseId)
    if (!gc) continue // unknown case → not supported
    const acceptable = new Set(gc.acceptableEvidenceIds)
    if (r.citationsInAnswer.some((cid) => acceptable.has(cid))) supported++
  }
  if (sampleSize === 0) {
    return { key: "citation_supported_claim_rate", threshold, actual: 1, passed: true, sampleSize: 0 }
  }
  const actual = supported / sampleSize
  return { key: "citation_supported_claim_rate", threshold, actual, passed: actual >= threshold, sampleSize }
}

/**
 * Spec L1559 metric 5: bounded correction success.
 *
 * A correction case "succeeds" when its terminalStatus === "completed".
 * The 70% threshold applies only to correction cases.
 *
 * sampleSize = number of correction cases.
 */
function evaluateCorrectionSuccess(
  cases: GoldenCase[],
  results: CaseResult[],
): QualityMetricResult {
  const threshold = QUALITY_THRESHOLDS.correction_success
  const correctionResults: CaseResult[] = []
  for (const r of results) {
    const gc = findGoldenCase(cases, r.caseId)
    if (!gc) continue
    if (gc.category !== "correction") continue
    correctionResults.push(r)
  }
  const sampleSize = correctionResults.length
  if (sampleSize === 0) {
    return { key: "correction_success", threshold, actual: 1, passed: true, sampleSize: 0 }
  }
  const successes = correctionResults.filter((r) => r.terminalStatus === "completed").length
  const actual = successes / sampleSize
  return { key: "correction_success", threshold, actual, passed: actual >= threshold, sampleSize }
}

/**
 * Ticket 10 criterion #5 — Spec L1559 metric 6: tool-loop fallback rate.
 *
 * Of cases with `expectedFallback === true`, the fraction where
 * `fallbackUsed === true`. Measures whether the deterministic searcher
 * fallback fires when expected (correction round with 0 loop results).
 *
 * Threshold 0.8 — at least 80% of expected-fallback cases must realize the
 * fallback. When sampleSize = 0 (no expected-fallback cases), the metric
 * passes vacuously (actual = 1).
 *
 * sampleSize = number of GoldenCases with `expectedFallback === true`.
 */
function evaluateToolLoopFallbackRate(
  cases: GoldenCase[],
  results: CaseResult[],
): QualityMetricResult {
  const threshold = QUALITY_THRESHOLDS.tool_loop_fallback_rate
  const expectedFallbackCaseIds = new Set(
    cases.filter((c) => c.expectedFallback === true).map((c) => c.id),
  )
  const sampleResults = results.filter((r) => expectedFallbackCaseIds.has(r.caseId))
  const sampleSize = sampleResults.length
  if (sampleSize === 0) {
    return { key: "tool_loop_fallback_rate", threshold, actual: 1, passed: true, sampleSize: 0 }
  }
  const fired = sampleResults.filter((r) => r.fallbackUsed === true).length
  const actual = fired / sampleSize
  return { key: "tool_loop_fallback_rate", threshold, actual, passed: actual >= threshold, sampleSize }
}

/**
 * Evaluate all 6 quality metrics against a GoldenCase[] + CaseResult[].
 * Returns one QualityMetricResult per metric, in spec L1559 order.
 *
 * Deterministic — no side effects, no I/O. Same inputs always produce the
 * same outputs. Each metric independently reports pass/fail against its
 * threshold; aggregate pass/fail is decided by the caller (P5 artifact writer).
 */
export function evaluateQualityMetrics(
  cases: GoldenCase[],
  results: CaseResult[],
): QualityMetricResult[] {
  return [
    evaluateRetrievalHitAt10(cases, results),
    evaluateExpectedSourceRecall(cases, results),
    evaluateRequiredCriteriaCoverage(cases, results),
    evaluateCitationSupportedClaimRate(cases, results),
    evaluateCorrectionSuccess(cases, results),
    evaluateToolLoopFallbackRate(cases, results),
  ]
}
