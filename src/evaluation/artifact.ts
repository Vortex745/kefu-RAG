// Ticket 10 Phase D P5 — Baseline comparison + machine-readable artifact writer.
//
// Spec §9 L1560-1562:
//   - Latency and token cost are compared with the checked-in baseline. A
//     release fails when p95 end-to-end latency or average total tokens
//     regress by MORE THAN 20% without an explicitly reviewed baseline update.
//   - Model-judge scores are reported separately from deterministic invariants
//     (L1561) — modelJudgeScores is a SEPARATE aggregateMetrics array, never
//     merged into hardInvariants/qualityMetrics passed/failed booleans.
//   - Each run produces a machine-readable artifact with repository revision,
//     dataset version, provider/model identifiers, aggregate metrics, per-case
//     status and redacted failure evidence (L1562).
//
// The artifact writer consumes the outputs of P3 (hardInvariants) + P4
// (qualityMetrics) + this module's computeBaselineComparison. It does NOT
// compute hard invariants or quality metrics itself — it only assembles them.

import type {
  BaselineComparison,
  CaseResult,
  EvaluationArtifact,
  GoldenSet,
  HardInvariantResult,
  ModelJudgeScore,
  QualityMetricResult,
  RagasArtifactSection,
  RagasShadowArtifactSection,
} from "./types"

const REGRESSION_THRESHOLD = 1.20 // spec L1560: "more than 20%"

/**
 * Compute the p95 latency (nearest-rank method) from CaseResult[].
 *
 * rank = ceil(0.95 * n); p95 = sortedDurations[rank - 1].
 * - n = 0 → 0 (vacuous — no samples to measure)
 * - n = 1 → that single sample
 * - n = 60 → sortedDurations[56] (the 57th value when sorted ascending)
 */
export function p95Latency(results: CaseResult[]): number {
  const n = results.length
  if (n === 0) return 0
  const sorted = [...results.map((r) => r.durationMs)].sort((a, b) => a - b)
  const rank = Math.ceil(0.95 * n) // 1-indexed rank
  return sorted[rank - 1]
}

/**
 * Compute the average token count across CaseResult[].
 * Returns 0 when results is empty.
 */
export function averageTokens(results: CaseResult[]): number {
  const n = results.length
  if (n === 0) return 0
  const total = results.reduce((sum, r) => sum + r.tokenCount, 0)
  return total / n
}

/**
 * Spec L1560: compare current p95 latency + average tokens against a checked-in
 * baseline. A regression flag is set when current > baseline * 1.20 (strictly
 * greater than 20% per spec "more than 20%").
 *
 * Zero baseline is treated as a degenerate case (no regression) — division by
 * zero would otherwise produce NaN. Callers should ensure baseline is non-zero
 * for real release gates.
 */
export function computeBaselineComparison(
  results: CaseResult[],
  baseline: { p95LatencyMs: number; averageTokens: number },
): BaselineComparison {
  const currentP95 = p95Latency(results)
  const currentAvg = averageTokens(results)
  const p95Regression = baseline.p95LatencyMs > 0
    ? currentP95 > baseline.p95LatencyMs * REGRESSION_THRESHOLD
    : false
  const avgRegression = baseline.averageTokens > 0
    ? currentAvg > baseline.averageTokens * REGRESSION_THRESHOLD
    : false
  return {
    p95LatencyMs: currentP95,
    p95LatencyBaselineMs: baseline.p95LatencyMs,
    p95LatencyRegression: p95Regression,
    averageTokens: currentAvg,
    averageTokensBaseline: baseline.averageTokens,
    averageTokensRegression: avgRegression,
  }
}

/**
 * Spec L1562: assemble a machine-readable EvaluationArtifact.
 *
 * Inputs:
 *   - goldenSet: dataset version + per-case fixtures (consumed for version only)
 *   - results: per-case CaseResult[] (becomes perCaseStatus)
 *   - hardInvariants: from P3 evaluateHardInvariants
 *   - qualityMetrics: from P4 evaluateQualityMetrics
 *   - baseline: from computeBaselineComparison
 *   - repositoryRevision: git commit SHA
 *   - providerModelIds: {chat, embedding, evaluator?}
 *   - modelJudgeScores?: optional (spec L1561 — reported separately)
 *   - generatedAt?: optional ISO 8601 timestamp (defaults to new Date().toISOString())
 *
 * Output: EvaluationArtifact with schemaVersion=1, suitable for JSON.stringify.
 */
export function buildArtifact(input: {
  goldenSet: GoldenSet
  results: CaseResult[]
  hardInvariants: HardInvariantResult[]
  qualityMetrics: QualityMetricResult[]
  baseline: BaselineComparison
  repositoryRevision: string
  providerModelIds: { chat: string; embedding: string; evaluator?: string }
  modelJudgeScores?: ModelJudgeScore[]
  /**
   * Ticket 15: optional RAGAS section. When provided, the artifact includes
   * per-case RAGAS outcomes, aggregate values, evaluator model IDs and runtime
   * version info. Structurally separate from hardInvariants/qualityMetrics
   * (criterion #5) — RAGAS results cannot change the passed/failed state of
   * deterministic gates.
   */
  ragas?: RagasArtifactSection
  /**
   * Ticket 16: optional RAGAS shadow baseline section. When provided, the
   * artifact includes the shadow baseline + optional comparison vs a checked-in
   * baseline. Structurally separate from `aggregateMetrics.baseline` (latency/
   * token) and `ragas` (per-case outcomes from T15). NON-BLOCKING (criterion
   * #6) — shadow regressions cannot change deterministic gate pass/fail state.
   */
  ragasShadow?: RagasShadowArtifactSection
  generatedAt?: string
}): EvaluationArtifact {
  const aggregateMetrics: EvaluationArtifact["aggregateMetrics"] = {
    hardInvariants: input.hardInvariants,
    qualityMetrics: input.qualityMetrics,
    baseline: input.baseline,
  }
  if (input.modelJudgeScores !== undefined) {
    aggregateMetrics.modelJudgeScores = input.modelJudgeScores
  }
  const artifact: EvaluationArtifact = {
    schemaVersion: 1,
    repositoryRevision: input.repositoryRevision,
    datasetVersion: input.goldenSet.version,
    providerModelIds: input.providerModelIds,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    aggregateMetrics,
    perCaseStatus: input.results,
  }
  if (input.ragas !== undefined) {
    artifact.ragas = input.ragas
  }
  if (input.ragasShadow !== undefined) {
    artifact.ragasShadow = input.ragasShadow
  }
  return artifact
}
