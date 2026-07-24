// Ticket 10 Phase D P5 — Baseline comparison + artifact writer tests.
//
// Spec §9 L1560-1562:
//   - Latency and token cost are compared with the checked-in baseline. A
//     release fails when p95 end-to-end latency or average total tokens
//     regress by more than 20% without an explicitly reviewed baseline update.
//   - Each run produces a machine-readable artifact with repository revision,
//     dataset version, provider/model identifiers, aggregate metrics, per-case
//     status and redacted failure evidence.

import test from "node:test"
import assert from "node:assert/strict"

import type {
  CaseResult,
  EvaluationArtifact,
  HardInvariantResult,
  ModelJudgeScore,
  QualityMetricResult,
} from "./types"
import { buildArtifact, computeBaselineComparison, p95Latency, averageTokens } from "./artifact"
import { GOLDEN_SET } from "./golden/fixtures"
import { evaluateHardInvariants } from "./hard_invariants"
import { evaluateQualityMetrics } from "./quality_metrics"

function mkResult(caseId: string, durationMs: number, tokenCount: number, opts: Partial<CaseResult> = {}): CaseResult {
  return {
    caseId,
    status: "passed",
    terminalStatus: "completed",
    retrievedEvidenceIds: [],
    citationsInAnswer: [],
    durationMs,
    tokenCount,
    ...opts,
  }
}

function mkPassingResults(): CaseResult[] {
  return GOLDEN_SET.cases.map((c, i) => {
    if (c.category === "direct") return mkResult(c.id, 100, 50, { routeDecision: "direct" })
    if (c.category === "ambiguous") return mkResult(c.id, 100, 50, { routeDecision: "ambiguous", terminalStatus: "clarification_required" })
    if (c.category === "insufficient") return mkResult(c.id, 200, 100, {
      routeDecision: c.expectedRoute ?? "simple",
      terminalStatus: "insufficient_evidence",
      retrievedEvidenceIds: [...c.expectedSourceIds, ...c.acceptableEvidenceIds],
      citationsInAnswer: [...c.acceptableEvidenceIds],
    })
    const base = mkResult(c.id, 200, 100, {
      routeDecision: c.expectedRoute ?? "simple",
      terminalStatus: "completed",
      retrievedEvidenceIds: [...c.expectedSourceIds, ...c.acceptableEvidenceIds],
      citationsInAnswer: [...c.acceptableEvidenceIds],
    })
    // Ticket 10: tool-loop cases need fallbackUsed to match expectedFallback
    if (c.scenario !== undefined) {
      base.fallbackUsed = c.expectedFallback === true
    }
    return base
  })
}

// ---------------------------------------------------------------------------
// p95Latency + averageTokens helpers
// ---------------------------------------------------------------------------

test("Ticket 10 P5: p95Latency computes nearest-rank p95 of durations", () => {
  // mkPassingResults: 20 cases at 100ms (direct+ambiguous) + 40 cases at 200ms
  // sorted durations = [100×20, 200×40]; rank = ceil(0.95*60) = 57 → sorted[56] = 200
  const results = mkPassingResults()
  assert.equal(p95Latency(results), 200)
})

test("Ticket 10 P5: p95Latency returns 0 for empty results", () => {
  assert.equal(p95Latency([]), 0)
})

test("Ticket 10 P5: p95Latency handles single result", () => {
  assert.equal(p95Latency([mkResult("x", 42, 10)]), 42)
})

test("Ticket 10 P5: p95Latency picks the 95th percentile (60 samples)", () => {
  // 60 cases, durations 1..60 → sorted[ceil(0.95*60)-1] = sorted[56] = 57
  const results: CaseResult[] = Array.from({ length: 60 }, (_, i) =>
    mkResult(`c-${i}`, i + 1, 10),
  )
  assert.equal(p95Latency(results), 57)
})

test("Ticket 10 P5: averageTokens computes mean of tokenCount", () => {
  const results = mkPassingResults()
  // direct (10) + ambiguous (10) = 20 cases × 50 tokens + 48 knowledge-route cases × 100 tokens = 1000 + 4800 = 5800
  // avg = 5800 / 68 = 85.29...
  // (Ticket 10 added 8 tool-loop cases to knowledge routes: 1 simple + 5 complex + 2 correction)
  const total = 20 * 50 + 48 * 100
  assert.equal(averageTokens(results), total / GOLDEN_SET.cases.length)
})

test("Ticket 10 P5: averageTokens returns 0 for empty results", () => {
  assert.equal(averageTokens([]), 0)
})

// ---------------------------------------------------------------------------
// computeBaselineComparison
// ---------------------------------------------------------------------------

test("Ticket 10 P5: computeBaselineComparison returns no regression when within 20%", () => {
  const results = mkPassingResults()
  // 20 cases at 100ms + 48 cases at 200ms. Sorted: [100×20, 200×48].
  // p95 = sorted[ceil(0.95*68)-1] = sorted[64] = 200 (index 64 falls in the 200ms range)
  // avg tokens: 20×50 + 48×100 = 1000+4800 = 5800, avg = 5800/68 ≈ 85.29
  const baseline = { p95LatencyMs: 200, averageTokens: 85 }
  const out = computeBaselineComparison(results, baseline)
  assert.equal(out.p95LatencyMs, 200)
  assert.equal(out.p95LatencyBaselineMs, 200)
  // 85.29 vs 85 baseline = 0.3% increase, no regression
  assert.equal(out.averageTokensRegression, false)
  assert.equal(out.p95LatencyRegression, false)
})

test("Ticket 10 P5: computeBaselineComparison flags p95 latency regression > 20%", () => {
  // 60 cases at 250ms each → p95 = 250; baseline 200 → 250/200 = 1.25 → > 20% regression
  const results: CaseResult[] = Array.from({ length: 60 }, (_, i) =>
    mkResult(`c-${i}`, 250, 100),
  )
  const out = computeBaselineComparison(results, { p95LatencyMs: 200, averageTokens: 100 })
  assert.equal(out.p95LatencyRegression, true)
  assert.equal(out.averageTokensRegression, false)
})

test("Ticket 10 P5: computeBaselineComparison flags average tokens regression > 20%", () => {
  // 60 cases at 130 tokens each → avg = 130; baseline 100 → 130/100 = 1.30 → > 20% regression
  const results: CaseResult[] = Array.from({ length: 60 }, (_, i) =>
    mkResult(`c-${i}`, 100, 130),
  )
  const out = computeBaselineComparison(results, { p95LatencyMs: 100, averageTokens: 100 })
  assert.equal(out.p95LatencyRegression, false)
  assert.equal(out.averageTokensRegression, true)
})

test("Ticket 10 P5: computeBaselineComparison uses strict > 20% (1.20x is NOT regression)", () => {
  // p95 = 120, baseline 100 → 120/100 = 1.20 → NOT regression (strict >)
  const results: CaseResult[] = Array.from({ length: 60 }, () => mkResult("x", 120, 60))
  const out = computeBaselineComparison(results, { p95LatencyMs: 100, averageTokens: 50 })
  assert.equal(out.p95LatencyRegression, false, "1.20x exactly should NOT be regression (spec says > 20%)")
  assert.equal(out.averageTokensRegression, false, "60/50 = 1.20 exactly should NOT be regression")
})

test("Ticket 10 P5: computeBaselineComparison flags regression when just above 20% (1.21x)", () => {
  const results: CaseResult[] = Array.from({ length: 60 }, () => mkResult("x", 121, 61))
  const out = computeBaselineComparison(results, { p95LatencyMs: 100, averageTokens: 50 })
  assert.equal(out.p95LatencyRegression, true, "121/100 = 1.21 → > 20% → regression")
  assert.equal(out.averageTokensRegression, true, "61/50 = 1.22 → > 20% → regression")
})

test("Ticket 10 P5: computeBaselineComparison handles empty results (p95=0, avg=0)", () => {
  const out = computeBaselineComparison([], { p95LatencyMs: 100, averageTokens: 50 })
  assert.equal(out.p95LatencyMs, 0)
  assert.equal(out.p95LatencyBaselineMs, 100)
  assert.equal(out.averageTokens, 0)
  assert.equal(out.averageTokensBaseline, 50)
  // 0 vs baseline 100/50 — improvement, not regression
  assert.equal(out.p95LatencyRegression, false)
  assert.equal(out.averageTokensRegression, false)
})

test("Ticket 10 P5: computeBaselineComparison handles zero baseline (no division-by-zero)", () => {
  // baseline = 0/0; current = 100/50; 0 baseline is degenerate but should not throw
  const results: CaseResult[] = Array.from({ length: 60 }, () => mkResult("x", 100, 50))
  const out = computeBaselineComparison(results, { p95LatencyMs: 0, averageTokens: 0 })
  assert.equal(out.p95LatencyRegression, false, "zero baseline should not flag regression (degenerate input)")
  assert.equal(out.averageTokensRegression, false)
})

// ---------------------------------------------------------------------------
// buildArtifact
// ---------------------------------------------------------------------------

test("Ticket 10 P5: buildArtifact returns EvaluationArtifact with schemaVersion=1", () => {
  const results = mkPassingResults()
  const hardInvariants = evaluateHardInvariants(GOLDEN_SET.cases, results)
  const qualityMetrics = evaluateQualityMetrics(GOLDEN_SET.cases, results)
  const baseline = computeBaselineComparison(results, { p95LatencyMs: 200, averageTokens: 83 })
  const artifact = buildArtifact({
    goldenSet: GOLDEN_SET,
    results,
    hardInvariants,
    qualityMetrics,
    baseline,
    repositoryRevision: "abc123",
    providerModelIds: { chat: "gpt-4", embedding: "text-embedding-3-small" },
  })
  assert.equal(artifact.schemaVersion, 1)
})

test("Ticket 10 P5: buildArtifact populates repositoryRevision from input", () => {
  const results = mkPassingResults()
  const artifact = buildArtifact({
    goldenSet: GOLDEN_SET,
    results,
    hardInvariants: evaluateHardInvariants(GOLDEN_SET.cases, results),
    qualityMetrics: evaluateQualityMetrics(GOLDEN_SET.cases, results),
    baseline: computeBaselineComparison(results, { p95LatencyMs: 200, averageTokens: 83 }),
    repositoryRevision: "deadbeef",
    providerModelIds: { chat: "gpt-4", embedding: "text-embedding-3-small" },
  })
  assert.equal(artifact.repositoryRevision, "deadbeef")
})

test("Ticket 10 P5: buildArtifact populates datasetVersion from goldenSet.version", () => {
  const results = mkPassingResults()
  const artifact = buildArtifact({
    goldenSet: GOLDEN_SET,
    results,
    hardInvariants: evaluateHardInvariants(GOLDEN_SET.cases, results),
    qualityMetrics: evaluateQualityMetrics(GOLDEN_SET.cases, results),
    baseline: computeBaselineComparison(results, { p95LatencyMs: 200, averageTokens: 83 }),
    repositoryRevision: "abc",
    providerModelIds: { chat: "gpt-4", embedding: "text-embedding-3-small" },
  })
  assert.equal(artifact.datasetVersion, GOLDEN_SET.version)
  assert.equal(artifact.datasetVersion, "2026.07.t10")
})

test("Ticket 10 P5: buildArtifact populates providerModelIds (chat + embedding + optional evaluator)", () => {
  const results = mkPassingResults()
  const baseline = computeBaselineComparison(results, { p95LatencyMs: 200, averageTokens: 83 })
  const hi = evaluateHardInvariants(GOLDEN_SET.cases, results)
  const qm = evaluateQualityMetrics(GOLDEN_SET.cases, results)
  const withoutEvaluator = buildArtifact({
    goldenSet: GOLDEN_SET, results, hardInvariants: hi, qualityMetrics: qm, baseline,
    repositoryRevision: "abc", providerModelIds: { chat: "gpt-4", embedding: "text-embedding-3-small" },
  })
  assert.equal(withoutEvaluator.providerModelIds.chat, "gpt-4")
  assert.equal(withoutEvaluator.providerModelIds.embedding, "text-embedding-3-small")
  assert.equal(withoutEvaluator.providerModelIds.evaluator, undefined)

  const withEvaluator = buildArtifact({
    goldenSet: GOLDEN_SET, results, hardInvariants: hi, qualityMetrics: qm, baseline,
    repositoryRevision: "abc",
    providerModelIds: { chat: "gpt-4", embedding: "text-embedding-3-small", evaluator: "gpt-4o" },
  })
  assert.equal(withEvaluator.providerModelIds.evaluator, "gpt-4o")
})

test("Ticket 10 P5: buildArtifact generatedAt is ISO 8601 (or overridden)", () => {
  const results = mkPassingResults()
  const baseline = computeBaselineComparison(results, { p95LatencyMs: 200, averageTokens: 83 })
  const hi = evaluateHardInvariants(GOLDEN_SET.cases, results)
  const qm = evaluateQualityMetrics(GOLDEN_SET.cases, results)
  // Default = current ISO timestamp
  const auto = buildArtifact({
    goldenSet: GOLDEN_SET, results, hardInvariants: hi, qualityMetrics: qm, baseline,
    repositoryRevision: "abc", providerModelIds: { chat: "gpt-4", embedding: "text-embedding-3-small" },
  })
  assert.match(auto.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)

  // Override with explicit timestamp
  const overridden = buildArtifact({
    goldenSet: GOLDEN_SET, results, hardInvariants: hi, qualityMetrics: qm, baseline,
    repositoryRevision: "abc", providerModelIds: { chat: "gpt-4", embedding: "text-embedding-3-small" },
    generatedAt: "2026-07-18T00:00:00.000Z",
  })
  assert.equal(overridden.generatedAt, "2026-07-18T00:00:00.000Z")
})

test("Ticket 10 P5: buildArtifact aggregateMetrics contains hardInvariants + qualityMetrics + baseline", () => {
  const results = mkPassingResults()
  const baseline = computeBaselineComparison(results, { p95LatencyMs: 200, averageTokens: 83 })
  const hi = evaluateHardInvariants(GOLDEN_SET.cases, results)
  const qm = evaluateQualityMetrics(GOLDEN_SET.cases, results)
  const artifact = buildArtifact({
    goldenSet: GOLDEN_SET, results, hardInvariants: hi, qualityMetrics: qm, baseline,
    repositoryRevision: "abc", providerModelIds: { chat: "gpt-4", embedding: "text-embedding-3-small" },
  })
  assert.equal(artifact.aggregateMetrics.hardInvariants, hi)
  assert.equal(artifact.aggregateMetrics.hardInvariants.length, 8)
  assert.equal(artifact.aggregateMetrics.qualityMetrics, qm)
  assert.equal(artifact.aggregateMetrics.qualityMetrics.length, 6)
  assert.equal(artifact.aggregateMetrics.baseline, baseline)
})

test("Ticket 10 P5: buildArtifact aggregateMetrics.modelJudgeScores omitted when undefined", () => {
  const results = mkPassingResults()
  const baseline = computeBaselineComparison(results, { p95LatencyMs: 200, averageTokens: 83 })
  const artifact = buildArtifact({
    goldenSet: GOLDEN_SET, results,
    hardInvariants: evaluateHardInvariants(GOLDEN_SET.cases, results),
    qualityMetrics: evaluateQualityMetrics(GOLDEN_SET.cases, results),
    baseline,
    repositoryRevision: "abc", providerModelIds: { chat: "gpt-4", embedding: "text-embedding-3-small" },
  })
  assert.equal(artifact.aggregateMetrics.modelJudgeScores, undefined)
})

test("Ticket 10 P5: buildArtifact aggregateMetrics.modelJudgeScores included when provided", () => {
  const results = mkPassingResults()
  const baseline = computeBaselineComparison(results, { p95LatencyMs: 200, averageTokens: 83 })
  const judgeScores: ModelJudgeScore[] = [
    { caseId: "simple-01", evaluatorModel: "gpt-4o", score: 0.92, rationale: "well-grounded" },
    { caseId: "complex-01", evaluatorModel: "gpt-4o", score: 0.85 },
  ]
  const artifact = buildArtifact({
    goldenSet: GOLDEN_SET, results,
    hardInvariants: evaluateHardInvariants(GOLDEN_SET.cases, results),
    qualityMetrics: evaluateQualityMetrics(GOLDEN_SET.cases, results),
    baseline,
    repositoryRevision: "abc",
    providerModelIds: { chat: "gpt-4", embedding: "text-embedding-3-small", evaluator: "gpt-4o" },
    modelJudgeScores: judgeScores,
  })
  assert.equal(artifact.aggregateMetrics.modelJudgeScores, judgeScores)
  assert.equal(artifact.aggregateMetrics.modelJudgeScores!.length, 2)
})

test("Ticket 10 P5: buildArtifact perCaseStatus equals input results array (same reference)", () => {
  const results = mkPassingResults()
  const baseline = computeBaselineComparison(results, { p95LatencyMs: 200, averageTokens: 83 })
  const artifact = buildArtifact({
    goldenSet: GOLDEN_SET, results,
    hardInvariants: evaluateHardInvariants(GOLDEN_SET.cases, results),
    qualityMetrics: evaluateQualityMetrics(GOLDEN_SET.cases, results),
    baseline,
    repositoryRevision: "abc", providerModelIds: { chat: "gpt-4", embedding: "text-embedding-3-small" },
  })
  assert.equal(artifact.perCaseStatus, results)
  assert.equal(artifact.perCaseStatus.length, GOLDEN_SET.cases.length)
})

test("Ticket 10 P5: buildArtifact is JSON-serializable (no functions / no undefined leaks)", () => {
  const results = mkPassingResults()
  const baseline = computeBaselineComparison(results, { p95LatencyMs: 200, averageTokens: 83 })
  const artifact = buildArtifact({
    goldenSet: GOLDEN_SET, results,
    hardInvariants: evaluateHardInvariants(GOLDEN_SET.cases, results),
    qualityMetrics: evaluateQualityMetrics(GOLDEN_SET.cases, results),
    baseline,
    repositoryRevision: "abc", providerModelIds: { chat: "gpt-4", embedding: "text-embedding-3-small" },
    modelJudgeScores: [{ caseId: "simple-01", evaluatorModel: "gpt-4o", score: 0.9 }],
  })
  // JSON.stringify must succeed without throwing (no circular, no undefined leaks in arrays)
  const json = JSON.stringify(artifact)
  assert.ok(json.length > 0)
  const parsed = JSON.parse(json) as EvaluationArtifact
  assert.equal(parsed.schemaVersion, 1)
  assert.equal(parsed.repositoryRevision, "abc")
  assert.equal(parsed.aggregateMetrics.hardInvariants.length, 8)
  assert.equal(parsed.aggregateMetrics.qualityMetrics.length, 6)
  assert.equal(parsed.aggregateMetrics.modelJudgeScores!.length, 1)
  assert.equal(parsed.perCaseStatus.length, GOLDEN_SET.cases.length)
})

test("Ticket 10 P5: buildArtifact with empty results + empty baseline still produces valid artifact", () => {
  const results: CaseResult[] = []
  const baseline = computeBaselineComparison(results, { p95LatencyMs: 0, averageTokens: 0 })
  const artifact = buildArtifact({
    goldenSet: GOLDEN_SET, results,
    hardInvariants: evaluateHardInvariants(GOLDEN_SET.cases, results),
    qualityMetrics: evaluateQualityMetrics(GOLDEN_SET.cases, results),
    baseline,
    repositoryRevision: "empty",
    providerModelIds: { chat: "gpt-4", embedding: "text-embedding-3-small" },
  })
  assert.equal(artifact.perCaseStatus.length, 0)
  assert.equal(artifact.aggregateMetrics.hardInvariants.length, 8)
  assert.equal(artifact.aggregateMetrics.qualityMetrics.length, 6)
  assert.equal(artifact.aggregateMetrics.baseline.p95LatencyMs, 0)
})
