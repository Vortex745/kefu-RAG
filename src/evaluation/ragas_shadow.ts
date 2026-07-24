// Ticket 16 — Calibrate the RAGAS shadow baseline.
//
// Spec issue #16: Establish a reproducible, non-blocking RAGAS baseline by
// running the committed evaluation set repeatedly with fixed evaluator
// configuration. Report score variance and regressions in shadow mode
// WITHOUT allowing first-run model metrics to block a release.
//
// This module owns:
//   - runRagasShadowProfile (criteria #1, #5) — runs N repeated evaluations
//     across the committed shadow cases with fixed config; profile semantics
//     mirror smoke.ts (local skips when evaluator missing, production fails)
//   - computeRagasShadowVariance (criterion #2) — per-metric min/max/mean/stdDev
//     across N runs
//   - computeRagasShadowBaseline (criterion #2) — assembles the baseline record
//     (aggregate + variance + run count + dataset version + provider model IDs)
//   - compareRagasShadowToBaseline (criterion #3) — current vs checked-in
//     baseline, per-metric regressions REPORTED but NON-BLOCKING (criterion #6)
//
// Shadow-mode RAGAS results are structurally separate from deterministic
// hard invariants (criterion #4) — they live in `EvaluationArtifact.ragasShadow`
// (a top-level sibling of `aggregateMetrics`), never inside `hardInvariants[]`
// or `qualityMetrics[]`. The release gate does NOT consult shadow regressions.

import type {
  EvaluationProfile,
  RagasAggregate,
  RagasCaseOutcome,
  RagasShadowBaseline,
  RagasShadowComparison,
  RagasShadowProfileConfig,
  RagasShadowRegression,
  RagasShadowResult,
  RagasShadowVariance,
  RagasMetricVariance,
} from "./types"
import {
  computeRagasAggregate,
  projectCaseToRagasRequest,
  ragasResponseToOutcome,
  skippedRagasOutcome,
} from "./ragas_projection"

/**
 * T16 criterion #2: compute per-metric variance (min/max/mean/stdDev) across
 * N shadow runs. Each input is one run's RagasAggregate (mean across all
 * cases for that run). The output records how each metric varied across the
 * N runs.
 *
 * Sample standard deviation uses the (n-1) denominator (Bessel's correction),
 * matching common statistical practice for small samples. When n=1, stdDev=0
 * (no variance with a single sample).
 *
 * When aggregates is empty, all metrics return min=0, max=0, mean=0, stdDev=0,
 * sampleSize=0 — a vacuous baseline (no runs contributed).
 */
export function computeRagasShadowVariance(aggregates: RagasAggregate[]): RagasShadowVariance {
  const metricVariance = (selector: (a: RagasAggregate) => number): RagasMetricVariance => {
    const values = aggregates.map(selector)
    const n = values.length
    if (n === 0) {
      return { min: 0, max: 0, mean: 0, stdDev: 0, sampleSize: 0 }
    }
    const min = Math.min(...values)
    const max = Math.max(...values)
    const mean = values.reduce((sum, v) => sum + v, 0) / n
    if (n === 1) {
      return { min, max, mean, stdDev: 0, sampleSize: 1 }
    }
    const sumSquaredDiff = values.reduce((sum, v) => sum + (v - mean) ** 2, 0)
    const stdDev = Math.sqrt(sumSquaredDiff / (n - 1))
    return { min, max, mean, stdDev, sampleSize: n }
  }

  return {
    faithfulness: metricVariance((a) => a.meanFaithfulness),
    answerRelevancy: metricVariance((a) => a.meanAnswerRelevancy),
    contextPrecision: metricVariance((a) => a.meanContextPrecision),
    contextRecall: metricVariance((a) => a.meanContextRecall),
  }
}

/**
 * T16 criterion #2: assemble a shadow baseline from N per-run aggregates.
 * The baseline records:
 *   - aggregate: mean of per-run aggregates (the representative aggregate)
 *   - variance: per-metric variance across the N runs
 *   - runCount: N (number of repeated runs)
 *   - datasetVersion: from config
 *   - providerModelIds: from config (fixed across runs, criterion #1)
 *   - generatedAt: current ISO timestamp
 *   - repositoryRevision: from config
 *
 * When aggregates is empty, the baseline records a vacuous aggregate (all
 * zeros) + vacuous variance. Callers should ensure runCount >= 1 for real
 * baselines.
 */
export function computeRagasShadowBaseline(
  aggregates: RagasAggregate[],
  config: RagasShadowProfileConfig,
): RagasShadowBaseline {
  const variance = computeRagasShadowVariance(aggregates)
  // Representative aggregate = mean of per-run aggregates per metric.
  // When aggregates is empty, all fields are 0.
  const n = aggregates.length
  const meanOf = (selector: (a: RagasAggregate) => number): number =>
    n === 0 ? 0 : aggregates.reduce((sum, a) => sum + selector(a), 0) / n
  const totalSampleSize = n === 0 ? 0 : aggregates.reduce((sum, a) => sum + a.sampleSize, 0)
  const totalErrorCount = n === 0 ? 0 : aggregates.reduce((sum, a) => sum + a.errorCount, 0)
  const totalSkippedCount = n === 0 ? 0 : aggregates.reduce((sum, a) => sum + a.skippedCount, 0)

  const aggregate: RagasAggregate = {
    meanFaithfulness: meanOf((a) => a.meanFaithfulness),
    meanAnswerRelevancy: meanOf((a) => a.meanAnswerRelevancy),
    meanContextPrecision: meanOf((a) => a.meanContextPrecision),
    meanContextRecall: meanOf((a) => a.meanContextRecall),
    // sampleSize per run = cases contributing to that run's means; the
    // representative sampleSize = mean across runs (rounded to avoid float noise).
    sampleSize: n === 0 ? 0 : Math.round(totalSampleSize / n),
    errorCount: n === 0 ? 0 : Math.round(totalErrorCount / n),
    skippedCount: n === 0 ? 0 : Math.round(totalSkippedCount / n),
  }

  return {
    aggregate,
    variance,
    runCount: n,
    datasetVersion: config.datasetVersion,
    providerModelIds: config.evaluatorModelIdentities,
    generatedAt: new Date().toISOString(),
    repositoryRevision: config.repositoryRevision,
  }
}

/**
 * T16 criterion #3: compare a current run's aggregate against a checked-in
 * baseline. Returns per-metric regressions (current < baseline = regression)
 * plus an aggregate `regressionDetected` flag.
 *
 * IMPORTANT (criterion #6): the regression flags are REPORTED but NON-BLOCKING.
 * No blocking threshold is introduced — callers can inspect regressions but
 * the release gate does NOT consult them. A follow-up decision will accept
 * measured variance + provider cost before introducing any blocking threshold.
 *
 * IMPORTANT (criterion #4): this comparison CANNOT override or waive a
 * deterministic hard-invariant failure. The comparison lives in
 * `EvaluationArtifact.ragasShadow.comparison`, structurally separate from
 * `aggregateMetrics.hardInvariants[]` and `aggregateMetrics.qualityMetrics[]`.
 */
export function compareRagasShadowToBaseline(
  current: RagasAggregate,
  baseline: RagasShadowBaseline,
): RagasShadowComparison {
  const metricRegressions: Array<{
    metric: RagasShadowRegression["metric"]
    current: number
    baseline: number
  }> = [
    { metric: "faithfulness", current: current.meanFaithfulness, baseline: baseline.aggregate.meanFaithfulness },
    { metric: "answerRelevancy", current: current.meanAnswerRelevancy, baseline: baseline.aggregate.meanAnswerRelevancy },
    { metric: "contextPrecision", current: current.meanContextPrecision, baseline: baseline.aggregate.meanContextPrecision },
    { metric: "contextRecall", current: current.meanContextRecall, baseline: baseline.aggregate.meanContextRecall },
  ]

  const regressions: RagasShadowRegression[] = metricRegressions.map((m) => {
    const delta = m.current - m.baseline
    return {
      metric: m.metric,
      current: m.current,
      baseline: m.baseline,
      delta,
      // current < baseline = regression (lower score = worse)
      regressionDetected: m.current < m.baseline,
    }
  })

  return {
    current,
    baseline,
    regressions,
    regressionDetected: regressions.some((r) => r.regressionDetected),
  }
}

/**
 * T16 criterion #1, #5: run the shadow profile.
 *
 * Behavior:
 *   1. Profile semantics (criterion #5):
 *      - evaluator undefined + local → status="skipped"
 *      - evaluator undefined + production → status="failed"
 *      - evaluator defined → proceed to step 2
 *   2. Run the committed shadow cases `runCount` times (criterion #1) with
 *      fixed evaluator + embedding configuration. Each run produces one
 *      RagasAggregate (mean across all cases for that run).
 *   3. Compute the baseline (criterion #2) from the N per-run aggregates.
 *   4. If checkedInBaseline provided, compute comparison (criterion #3).
 *   5. Return RagasShadowResult with status="passed" + baseline + optional
 *      comparison.
 *
 * The runner NEVER throws — run errors are captured per-case as "error"
 * outcomes (via ragasResponseToOutcome) and counted in the aggregate's
 * errorCount. A production profile with a crashing evaluator still returns
 * status="passed" with a baseline recording the errors; callers can inspect
 * `baseline.aggregate.errorCount` to detect runaway failures.
 *
 * Precondition: config.runCount >= 1. A runCount of 0 returns status="failed"
 * with reason "runCount must be >= 1".
 */
export async function runRagasShadowProfile(
  config: RagasShadowProfileConfig,
): Promise<RagasShadowResult> {
  // Criterion #5: profile semantics — missing evaluator.
  if (config.evaluator === undefined) {
    if (config.profile === "local") {
      return {
        status: "skipped",
        reason: "no RAGAS evaluator configured for local profile (criterion #5)",
      }
    }
    return {
      status: "failed",
      reason: "production profile requires RAGAS evaluator but none configured (criterion #5)",
    }
  }

  // Defensive: runCount must be >= 1 for a meaningful baseline.
  if (config.runCount < 1) {
    return {
      status: "failed",
      reason: `runCount must be >= 1 (got ${config.runCount})`,
    }
  }

  // Criterion #1: run the committed shadow cases N times with fixed config.
  const perRunAggregates: RagasAggregate[] = []
  for (let runIndex = 0; runIndex < config.runCount; runIndex++) {
    const outcomes: RagasCaseOutcome[] = []
    for (const shadowCase of config.shadowCases) {
      const { goldenCase, runOutputs } = shadowCase
      // Project to RagasRequest (T15 — pure, structurally excludes drafts/trace).
      const request = projectCaseToRagasRequest(
        goldenCase,
        runOutputs,
        config.evaluatorModelIdentities,
      )
      // Run RAGAS via T14 evaluator (never throws — returns RagasResponse).
      const response = await config.evaluator.evaluate(request)
      // Convert to outcome (T15 — ok/error, never skipped here since we
      // already filtered to RAGAS-eligible cases).
      outcomes.push(ragasResponseToOutcome(response))
    }
    perRunAggregates.push(computeRagasAggregate(outcomes))
  }

  // Criterion #2: compute the baseline.
  const baseline = computeRagasShadowBaseline(perRunAggregates, config)

  // Criterion #3: optional comparison vs checked-in baseline.
  const comparison =
    config.checkedInBaseline !== undefined
      ? compareRagasShadowToBaseline(baseline.aggregate, config.checkedInBaseline)
      : undefined

  return {
    status: "passed",
    baseline,
    comparison,
  }
}

/**
 * T16 criterion #5: helper to build a "no shadow" result for callers that
 * want to record a skipped/failed shadow run in the artifact without running
 * the full profile. Mirrors the smoke.ts pattern where missing probes produce
 * a SmokeResult with status="skipped" or "failed".
 *
 * Useful when the caller already knows the evaluator is missing and wants to
 * short-circuit without constructing a full RagasShadowProfileConfig.
 */
export function skippedOrFailedShadowResult(
  profile: EvaluationProfile,
  reason: string,
): RagasShadowResult {
  if (profile === "local") {
    return { status: "skipped", reason }
  }
  return { status: "failed", reason }
}
