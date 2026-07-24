// Ticket 16 — Calibrate the RAGAS shadow baseline: tests.
//
// Spec issue #16 criterion #7: "Tests verify baseline comparison math,
// missing-data behavior, profile semantics and artifact reproducibility."
//
// These tests cover:
//   - Criterion #1: shadow profile runs same cases N times with fixed config
//   - Criterion #2: baseline records aggregate, variance, run count, dataset
//     version, provider model IDs
//   - Criterion #3: current vs checked-in baseline, reported separately from
//     latency/token + deterministic
//   - Criterion #4: shadow regression never overrides deterministic gates
//   - Criterion #5: missing runtime skips locally, production fails
//   - Criterion #6: no blocking threshold (regressions reported, non-blocking)
//   - Criterion #7: baseline math, missing-data, profile semantics, artifact
//     reproducibility

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  runRagasShadowProfile,
  computeRagasShadowVariance,
  computeRagasShadowBaseline,
  compareRagasShadowToBaseline,
  skippedOrFailedShadowResult,
} from "./ragas_shadow"
import { buildArtifact, computeBaselineComparison } from "./artifact"
import { evaluateHardInvariants } from "./hard_invariants"
import { evaluateQualityMetrics } from "./quality_metrics"
import { GOLDEN_SET } from "./golden/fixtures"
import type {
  AnswerRunOutputs,
  CaseResult,
  EvaluationArtifact,
  GoldenCase,
  RagasAggregate,
  RagasEvaluator,
  RagasEvaluateOptions,
  RagasMetricResult,
  RagasRequest,
  RagasResponse,
  RagasRuntimeInfo,
  RagasShadowArtifactSection,
  RagasShadowBaseline,
  RagasShadowCase,
  RagasShadowProfileConfig,
} from "./types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const here = __dirname
const SHADOW_SOURCE_PATH = join(here, "ragas_shadow.ts")
const ARTIFACT_SOURCE_PATH = join(here, "artifact.ts")
const TYPES_SOURCE_PATH = join(here, "types.ts")

function makeGoldenCase(overrides: Partial<GoldenCase> = {}): GoldenCase {
  return {
    id: "simple-01",
    version: 1,
    category: "simple",
    userMessage: "What is the refund policy?",
    expectedRoute: "simple",
    expectedSourceIds: ["src-refund"],
    acceptableEvidenceIds: ["ev-refund-01"],
    requiredCoverageCriteria: ["refund window"],
    referenceAnswer: "Refunds are available within 30 days of purchase.",
    ...overrides,
  }
}

function makeRunOutputs(overrides: Partial<AnswerRunOutputs> = {}): AnswerRunOutputs {
  return {
    caseId: "simple-01",
    approvedAnswer: "You can request a refund within 30 days of purchase via the account page.",
    retrievedContexts: ["Refund policy: 30-day window from purchase date."],
    ...overrides,
  }
}

function makeShadowCase(caseId: string): RagasShadowCase {
  return {
    goldenCase: makeGoldenCase({ id: caseId, referenceAnswer: `Reference answer for ${caseId}.` }),
    runOutputs: makeRunOutputs({ caseId }),
  }
}

function makeEvaluatorModelIdentities() {
  return {
    chat: "gpt-4-0613",
    embedding: "text-embedding-3-small",
    evaluator: "gpt-4-0613",
  }
}

function makeRuntimeInfo(): RagasRuntimeInfo {
  return {
    ragasVersion: "0.2.14",
    pythonVersion: "3.11.6",
    runnerSchemaVersion: 1,
  }
}

function makeMetric(name: string, score: number): RagasMetricResult {
  return { name, score }
}

function makeOkMetrics(scores: { faithfulness?: number; answerRelevancy?: number; contextPrecision?: number; contextRecall?: number } = {}): RagasMetricResult[] {
  return [
    makeMetric("faithfulness", scores.faithfulness ?? 0.9),
    makeMetric("answer_relevancy", scores.answerRelevancy ?? 0.85),
    makeMetric("context_precision", scores.contextPrecision ?? 0.88),
    makeMetric("context_recall", scores.contextRecall ?? 0.82),
  ]
}

function makeOkResponse(caseId: string, scores?: Parameters<typeof makeOkMetrics>[0]): RagasResponse {
  return {
    schemaVersion: 1,
    caseId,
    status: "ok",
    metrics: makeOkMetrics(scores),
    durationMs: 1500,
  }
}

function makeErrorResponse(
  caseId: string,
  kind: "missing_runtime" | "timeout" | "malformed_output" | "evaluator_failure" | "unknown" = "timeout",
  message = "timed out",
): RagasResponse {
  return {
    schemaVersion: 1,
    caseId,
    status: "error",
    durationMs: 100,
    error: { kind, message },
  }
}

function makeAggregate(overrides: Partial<RagasAggregate> = {}): RagasAggregate {
  return {
    meanFaithfulness: 0.9,
    meanAnswerRelevancy: 0.85,
    meanContextPrecision: 0.88,
    meanContextRecall: 0.82,
    sampleSize: 1,
    errorCount: 0,
    skippedCount: 0,
    ...overrides,
  }
}

/**
 * FakeRagasEvaluator — captures all evaluate() requests + returns configurable
 * responses. Records per-call requests so tests can verify runCount * cases
 * invocations + fixed evaluatorModelIdentities across runs (criterion #1).
 */
class FakeRagasEvaluator implements RagasEvaluator {
  readonly requests: RagasRequest[] = []
  private readonly responsesByCaseId: Map<string, RagasResponse[]>
  private readonly defaultResponse: RagasResponse | undefined
  private callIndex = 0

  constructor(options: {
    responsesByCaseId?: Map<string, RagasResponse[]>
    defaultResponse?: RagasResponse
  } = {}) {
    this.responsesByCaseId = options.responsesByCaseId ?? new Map()
    this.defaultResponse = options.defaultResponse
  }

  evaluate(request: RagasRequest, _options?: RagasEvaluateOptions): Promise<RagasResponse> {
    this.requests.push(request)
    // If defaultResponse is set, return it (ignores caseId) — useful for
    // producing the same response across N runs.
    if (this.defaultResponse !== undefined) {
      return Promise.resolve(this.defaultResponse)
    }
    // Otherwise, return the next response for this caseId (round-robin if
    // multiple are registered).
    const responses = this.responsesByCaseId.get(request.caseId)
    if (responses !== undefined && responses.length > 0) {
      const response = responses[this.callIndex % responses.length]
      this.callIndex += 1
      return Promise.resolve(response)
    }
    // Fallback: ok response with default metrics.
    return Promise.resolve(makeOkResponse(request.caseId))
  }
}

function makeProfileConfig(overrides: Partial<RagasShadowProfileConfig> = {}): RagasShadowProfileConfig {
  return {
    profile: "local",
    runCount: 3,
    evaluatorModelIdentities: makeEvaluatorModelIdentities(),
    runtime: makeRuntimeInfo(),
    shadowCases: [makeShadowCase("case-1"), makeShadowCase("case-2")],
    datasetVersion: "2026.07.t10",
    evaluator: undefined,
    repositoryRevision: "abc123",
    ...overrides,
  }
}

function makeShadowBaseline(overrides: Partial<RagasShadowBaseline> = {}): RagasShadowBaseline {
  return {
    aggregate: makeAggregate(),
    variance: {
      faithfulness: { min: 0.88, max: 0.92, mean: 0.9, stdDev: 0.02, sampleSize: 3 },
      answerRelevancy: { min: 0.83, max: 0.87, mean: 0.85, stdDev: 0.02, sampleSize: 3 },
      contextPrecision: { min: 0.86, max: 0.9, mean: 0.88, stdDev: 0.02, sampleSize: 3 },
      contextRecall: { min: 0.8, max: 0.84, mean: 0.82, stdDev: 0.02, sampleSize: 3 },
    },
    runCount: 3,
    datasetVersion: "2026.07.t10",
    providerModelIds: makeEvaluatorModelIdentities(),
    generatedAt: "2026-07-01T00:00:00.000Z",
    repositoryRevision: "abc123",
    ...overrides,
  }
}

function makeShadowSection(overrides: Partial<RagasShadowArtifactSection> = {}): RagasShadowArtifactSection {
  return {
    baseline: makeShadowBaseline(),
    reportedSeparately: true,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Criterion #2: computeRagasShadowVariance — baseline math
// ---------------------------------------------------------------------------

test("T16 #2: computeRagasShadowVariance computes min/max/mean/stdDev across N runs", () => {
  const aggregates = [
    makeAggregate({ meanFaithfulness: 0.9 }),
    makeAggregate({ meanFaithfulness: 0.8 }),
    makeAggregate({ meanFaithfulness: 0.85 }),
  ]
  const variance = computeRagasShadowVariance(aggregates)
  const f = variance.faithfulness
  assert.equal(f.min, 0.8)
  assert.equal(f.max, 0.9)
  assert.equal(f.mean, (0.9 + 0.8 + 0.85) / 3)
  // Sample stdDev with (n-1) denominator:
  // mean = 0.85; diffs = [0.05, -0.05, 0]; squared = [0.0025, 0.0025, 0]; sum = 0.005; /2 = 0.0025; sqrt = 0.05
  assert.ok(Math.abs(f.stdDev - 0.05) < 1e-9, `stdDev=${f.stdDev}, expected 0.05`)
  assert.equal(f.sampleSize, 3)
})

test("T16 #2: computeRagasShadowVariance returns stdDev=0 when n=1 (single run)", () => {
  const aggregates = [makeAggregate({ meanFaithfulness: 0.9 })]
  const variance = computeRagasShadowVariance(aggregates)
  assert.equal(variance.faithfulness.stdDev, 0)
  assert.equal(variance.faithfulness.sampleSize, 1)
})

test("T16 #2: computeRagasShadowVariance on empty aggregates returns all zeros", () => {
  const variance = computeRagasShadowVariance([])
  assert.equal(variance.faithfulness.min, 0)
  assert.equal(variance.faithfulness.max, 0)
  assert.equal(variance.faithfulness.mean, 0)
  assert.equal(variance.faithfulness.stdDev, 0)
  assert.equal(variance.faithfulness.sampleSize, 0)
  assert.equal(variance.answerRelevancy.sampleSize, 0)
  assert.equal(variance.contextPrecision.sampleSize, 0)
  assert.equal(variance.contextRecall.sampleSize, 0)
})

test("T16 #2: computeRagasShadowVariance computes all 4 metrics independently", () => {
  const aggregates = [
    makeAggregate({ meanFaithfulness: 0.9, meanAnswerRelevancy: 0.8, meanContextPrecision: 0.7, meanContextRecall: 0.6 }),
    makeAggregate({ meanFaithfulness: 0.7, meanAnswerRelevancy: 0.6, meanContextPrecision: 0.9, meanContextRecall: 0.4 }),
  ]
  const variance = computeRagasShadowVariance(aggregates)
  assert.equal(variance.faithfulness.min, 0.7)
  assert.equal(variance.faithfulness.max, 0.9)
  assert.equal(variance.answerRelevancy.min, 0.6)
  assert.equal(variance.answerRelevancy.max, 0.8)
  assert.equal(variance.contextPrecision.min, 0.7)
  assert.equal(variance.contextPrecision.max, 0.9)
  assert.equal(variance.contextRecall.min, 0.4)
  assert.equal(variance.contextRecall.max, 0.6)
})

// ---------------------------------------------------------------------------
// Criterion #2: computeRagasShadowBaseline — records all required fields
// ---------------------------------------------------------------------------

test("T16 #2: computeRagasShadowBaseline records aggregate, variance, runCount, datasetVersion, providerModelIds", () => {
  const config = makeProfileConfig({ runCount: 3 })
  const aggregates = [
    makeAggregate({ meanFaithfulness: 0.9, sampleSize: 2 }),
    makeAggregate({ meanFaithfulness: 0.8, sampleSize: 2 }),
    makeAggregate({ meanFaithfulness: 0.85, sampleSize: 2 }),
  ]
  const baseline = computeRagasShadowBaseline(aggregates, config)
  // aggregate = mean of per-run aggregates
  assert.equal(baseline.aggregate.meanFaithfulness, (0.9 + 0.8 + 0.85) / 3)
  // variance
  assert.equal(baseline.variance.faithfulness.min, 0.8)
  assert.equal(baseline.variance.faithfulness.max, 0.9)
  assert.equal(baseline.variance.faithfulness.sampleSize, 3)
  // runCount
  assert.equal(baseline.runCount, 3)
  // datasetVersion
  assert.equal(baseline.datasetVersion, "2026.07.t10")
  // providerModelIds
  assert.deepEqual(baseline.providerModelIds, makeEvaluatorModelIdentities())
  // generatedAt + repositoryRevision
  assert.ok(baseline.generatedAt.length > 0)
  assert.equal(baseline.repositoryRevision, "abc123")
})

test("T16 #2: computeRagasShadowBaseline on empty aggregates returns vacuous baseline", () => {
  const config = makeProfileConfig()
  const baseline = computeRagasShadowBaseline([], config)
  assert.equal(baseline.aggregate.meanFaithfulness, 0)
  assert.equal(baseline.aggregate.sampleSize, 0)
  assert.equal(baseline.variance.faithfulness.sampleSize, 0)
  assert.equal(baseline.runCount, 0)
})

test("T16 #2: computeRagasShadowBaseline representative sampleSize = mean of per-run sampleSizes (rounded)", () => {
  const config = makeProfileConfig()
  // 3 runs with sampleSizes 2, 4, 3 → mean = 3
  const aggregates = [
    makeAggregate({ sampleSize: 2 }),
    makeAggregate({ sampleSize: 4 }),
    makeAggregate({ sampleSize: 3 }),
  ]
  const baseline = computeRagasShadowBaseline(aggregates, config)
  assert.equal(baseline.aggregate.sampleSize, 3)
})

// ---------------------------------------------------------------------------
// Criterion #3: compareRagasShadowToBaseline — comparison math
// ---------------------------------------------------------------------------

test("T16 #3: compareRagasShadowToBaseline detects per-metric regressions (current < baseline)", () => {
  const current = makeAggregate({
    meanFaithfulness: 0.8,        // was 0.9 → regression
    meanAnswerRelevancy: 0.85,    // was 0.85 → no change
    meanContextPrecision: 0.9,    // was 0.88 → improvement
    meanContextRecall: 0.7,       // was 0.82 → regression
  })
  const baseline = makeShadowBaseline({
    aggregate: makeAggregate({
      meanFaithfulness: 0.9,
      meanAnswerRelevancy: 0.85,
      meanContextPrecision: 0.88,
      meanContextRecall: 0.82,
    }),
  })
  const comparison = compareRagasShadowToBaseline(current, baseline)
  assert.equal(comparison.regressions.length, 4)
  const faithfulness = comparison.regressions.find((r) => r.metric === "faithfulness")!
  assert.equal(faithfulness.regressionDetected, true)
  assert.ok(Math.abs(faithfulness.delta - (-0.1)) < 1e-9)
  const answerRelevancy = comparison.regressions.find((r) => r.metric === "answerRelevancy")!
  assert.equal(answerRelevancy.regressionDetected, false)
  assert.ok(Math.abs(answerRelevancy.delta - 0) < 1e-9)
  const contextPrecision = comparison.regressions.find((r) => r.metric === "contextPrecision")!
  assert.equal(contextPrecision.regressionDetected, false)
  assert.ok(Math.abs(contextPrecision.delta - 0.02) < 1e-9)
  const contextRecall = comparison.regressions.find((r) => r.metric === "contextRecall")!
  assert.equal(contextRecall.regressionDetected, true)
  assert.ok(Math.abs(contextRecall.delta - (-0.12)) < 1e-9)
  assert.equal(comparison.regressionDetected, true) // ANY regression
})

test("T16 #3: compareRagasShadowToBaseline regressionDetected=false when no metrics regress", () => {
  const current = makeAggregate({
    meanFaithfulness: 0.95,       // was 0.9 → improvement
    meanAnswerRelevancy: 0.85,    // was 0.85 → no change
    meanContextPrecision: 0.88,   // was 0.88 → no change
    meanContextRecall: 0.9,       // was 0.82 → improvement
  })
  const baseline = makeShadowBaseline({
    aggregate: makeAggregate({
      meanFaithfulness: 0.9,
      meanAnswerRelevancy: 0.85,
      meanContextPrecision: 0.88,
      meanContextRecall: 0.82,
    }),
  })
  const comparison = compareRagasShadowToBaseline(current, baseline)
  assert.equal(comparison.regressionDetected, false)
  assert.equal(comparison.regressions.every((r) => !r.regressionDetected), true)
})

test("T16 #3: compareRagasShadowToBaseline records current + baseline in comparison", () => {
  const current = makeAggregate({ meanFaithfulness: 0.8 })
  const baseline = makeShadowBaseline()
  const comparison = compareRagasShadowToBaseline(current, baseline)
  assert.deepEqual(comparison.current, current)
  assert.deepEqual(comparison.baseline, baseline)
})

// ---------------------------------------------------------------------------
// Criterion #6: no blocking threshold — regressions reported, non-blocking
// ---------------------------------------------------------------------------

test("T16 #6: RagasShadowRegression has NO blocking/threshold field — only regressionDetected (reported)", () => {
  const shadowSource = readFileSync(SHADOW_SOURCE_PATH, "utf8")
  // The shadow runner must NOT introduce a blocking threshold constant.
  // artifact.ts has REGRESSION_THRESHOLD = 1.20 for latency/token; ragas_shadow.ts must NOT.
  assert.ok(
    !/REGRESSION_THRESHOLD\s*=/.test(shadowSource),
    "ragas_shadow.ts must NOT introduce a REGRESSION_THRESHOLD constant (criterion #6 — no blocking threshold)",
  )
  // The regression interface is declared in types.ts — read it from there.
  const typesSource = readFileSync(TYPES_SOURCE_PATH, "utf8")
  const regressionMatch = typesSource.match(/export interface RagasShadowRegression \{[\s\S]*?\n\}/)
  assert.ok(regressionMatch, "RagasShadowRegression interface not found in types.ts")
  assert.ok(!/blocks\s*:/.test(regressionMatch![0]), "RagasShadowRegression must NOT have a 'blocks' field")
  assert.ok(!/blocking\s*:/.test(regressionMatch![0]), "RagasShadowRegression must NOT have a 'blocking' field")
})

test("T16 #6: RagasShadowComparison has NO blocks/blocking field — regressionDetected is reported only", () => {
  // The comparison interface is declared in types.ts — read it from there.
  const typesSource = readFileSync(TYPES_SOURCE_PATH, "utf8")
  const comparisonMatch = typesSource.match(/export interface RagasShadowComparison \{[\s\S]*?\n\}/)
  assert.ok(comparisonMatch, "RagasShadowComparison interface not found in types.ts")
  assert.ok(!/blocks\s*:/.test(comparisonMatch![0]), "RagasShadowComparison must NOT have a 'blocks' field")
  assert.ok(!/blocking\s*:/.test(comparisonMatch![0]), "RagasShadowComparison must NOT have a 'blocking' field")
})

test("T16 #6: smokeGatePassed does NOT consult RAGAS shadow regressions (non-blocking)", () => {
  // Static source check: smoke.ts smokeGatePassed function does not mention ragas or shadow.
  const smokeSource = readFileSync(join(here, "smoke.ts"), "utf8")
  const gateMatch = smokeSource.match(/export function smokeGatePassed[\s\S]*?\n\}/)
  assert.ok(gateMatch, "smokeGatePassed function not found")
  assert.ok(!/ragas/i.test(gateMatch![0]), "smokeGatePassed must NOT consult RAGAS (criterion #6 — non-blocking)")
  assert.ok(!/shadow/i.test(gateMatch![0]), "smokeGatePassed must NOT consult shadow (criterion #6 — non-blocking)")
})

// ---------------------------------------------------------------------------
// Criterion #5: profile semantics — missing runtime skips locally, production fails
// ---------------------------------------------------------------------------

test("T16 #5: local profile + no evaluator → status=skipped", async () => {
  const config = makeProfileConfig({ profile: "local", evaluator: undefined })
  const result = await runRagasShadowProfile(config)
  assert.equal(result.status, "skipped")
  assert.ok(result.reason?.includes("local"))
  assert.equal(result.baseline, undefined)
  assert.equal(result.comparison, undefined)
})

test("T16 #5: production profile + no evaluator → status=failed", async () => {
  const config = makeProfileConfig({ profile: "production", evaluator: undefined })
  const result = await runRagasShadowProfile(config)
  assert.equal(result.status, "failed")
  assert.ok(result.reason?.includes("production"))
  assert.equal(result.baseline, undefined)
})

test("T16 #5: local profile + evaluator → status=passed", async () => {
  const evaluator = new FakeRagasEvaluator({ defaultResponse: makeOkResponse("case-1") })
  const config = makeProfileConfig({ profile: "local", evaluator, runCount: 2 })
  const result = await runRagasShadowProfile(config)
  assert.equal(result.status, "passed")
  assert.ok(result.baseline !== undefined)
})

test("T16 #5: production profile + evaluator → status=passed", async () => {
  const evaluator = new FakeRagasEvaluator({ defaultResponse: makeOkResponse("case-1") })
  const config = makeProfileConfig({ profile: "production", evaluator, runCount: 2 })
  const result = await runRagasShadowProfile(config)
  assert.equal(result.status, "passed")
  assert.ok(result.baseline !== undefined)
})

test("T16 #5: skippedOrFailedShadowResult returns skipped for local", () => {
  const result = skippedOrFailedShadowResult("local", "no evaluator")
  assert.equal(result.status, "skipped")
  assert.equal(result.reason, "no evaluator")
})

test("T16 #5: skippedOrFailedShadowResult returns failed for production", () => {
  const result = skippedOrFailedShadowResult("production", "no evaluator")
  assert.equal(result.status, "failed")
  assert.equal(result.reason, "no evaluator")
})

test("T16 #5: runCount < 1 → status=failed (defensive)", async () => {
  const evaluator = new FakeRagasEvaluator()
  const config = makeProfileConfig({ evaluator, runCount: 0 })
  const result = await runRagasShadowProfile(config)
  assert.equal(result.status, "failed")
  assert.ok(result.reason?.includes("runCount"))
})

// ---------------------------------------------------------------------------
// Criterion #1: shadow profile runs same cases N times with fixed config
// ---------------------------------------------------------------------------

test("T16 #1: runRagasShadowProfile calls evaluator.evaluate runCount * shadowCases.length times", async () => {
  const evaluator = new FakeRagasEvaluator({ defaultResponse: makeOkResponse("any") })
  const shadowCases = [makeShadowCase("case-1"), makeShadowCase("case-2"), makeShadowCase("case-3")]
  const config = makeProfileConfig({ evaluator, runCount: 3, shadowCases })
  await runRagasShadowProfile(config)
  // 3 runs * 3 cases = 9 evaluate() calls
  assert.equal(evaluator.requests.length, 9)
})

test("T16 #1: runRagasShadowProfile uses fixed evaluatorModelIdentities across all runs", async () => {
  const evaluator = new FakeRagasEvaluator({ defaultResponse: makeOkResponse("any") })
  const identities = makeEvaluatorModelIdentities()
  const config = makeProfileConfig({ evaluator, runCount: 3, shadowCases: [makeShadowCase("c1")] })
  config.evaluatorModelIdentities = identities
  await runRagasShadowProfile(config)
  // Every request must carry the same evaluatorModelIdentities
  for (const req of evaluator.requests) {
    assert.deepEqual(req.evaluatorModelIdentities, identities)
  }
})

test("T16 #1: runRagasShadowProfile with runCount=1 produces a valid baseline (single run)", async () => {
  const evaluator = new FakeRagasEvaluator({ defaultResponse: makeOkResponse("case-1") })
  const config = makeProfileConfig({ evaluator, runCount: 1, shadowCases: [makeShadowCase("case-1")] })
  const result = await runRagasShadowProfile(config)
  assert.equal(result.status, "passed")
  assert.equal(result.baseline!.runCount, 1)
  assert.equal(result.baseline!.variance.faithfulness.stdDev, 0) // stdDev=0 when n=1
  assert.equal(result.baseline!.variance.faithfulness.sampleSize, 1)
})

test("T16 #1: runRagasShadowProfile includes optional comparison when checkedInBaseline provided", async () => {
  const evaluator = new FakeRagasEvaluator({ defaultResponse: makeOkResponse("case-1") })
  const checkedIn = makeShadowBaseline()
  const config = makeProfileConfig({
    evaluator,
    runCount: 2,
    shadowCases: [makeShadowCase("case-1")],
    checkedInBaseline: checkedIn,
  })
  const result = await runRagasShadowProfile(config)
  assert.equal(result.status, "passed")
  assert.ok(result.comparison !== undefined)
  assert.deepEqual(result.comparison!.baseline, checkedIn)
})

test("T16 #1: runRagasShadowProfile omits comparison when checkedInBaseline absent", async () => {
  const evaluator = new FakeRagasEvaluator({ defaultResponse: makeOkResponse("case-1") })
  const config = makeProfileConfig({ evaluator, runCount: 2 })
  const result = await runRagasShadowProfile(config)
  assert.equal(result.status, "passed")
  assert.equal(result.comparison, undefined)
})

// ---------------------------------------------------------------------------
// Criterion #1, #2: runRagasShadowProfile computes baseline from per-run aggregates
// ---------------------------------------------------------------------------

test("T16 #1: runRagasShadowProfile records per-run metric variance across N runs", async () => {
  // Use caseId-specific responses with different scores per run to produce variance.
  // FakeRagasEvaluator with responsesByCaseId returns responses round-robin.
  const responsesForCase1 = [
    makeOkResponse("case-1", { faithfulness: 0.9 }),
    makeOkResponse("case-1", { faithfulness: 0.8 }),
    makeOkResponse("case-1", { faithfulness: 0.85 }),
  ]
  const evaluator = new FakeRagasEvaluator({
    responsesByCaseId: new Map([["case-1", responsesForCase1]]),
  })
  const config = makeProfileConfig({
    evaluator,
    runCount: 3,
    shadowCases: [makeShadowCase("case-1")],
  })
  const result = await runRagasShadowProfile(config)
  assert.equal(result.status, "passed")
  const f = result.baseline!.variance.faithfulness
  assert.equal(f.min, 0.8)
  assert.equal(f.max, 0.9)
  assert.equal(f.sampleSize, 3)
})

test("T16 #1: runRagasShadowProfile handles error responses without throwing", async () => {
  // All evaluations return error — baseline should still record (errorCount > 0).
  const evaluator = new FakeRagasEvaluator({ defaultResponse: makeErrorResponse("case-1") })
  const config = makeProfileConfig({
    evaluator,
    runCount: 2,
    shadowCases: [makeShadowCase("case-1")],
  })
  const result = await runRagasShadowProfile(config)
  assert.equal(result.status, "passed") // runner doesn't throw; errors counted
  assert.ok(result.baseline!.aggregate.errorCount > 0)
  assert.equal(result.baseline!.aggregate.sampleSize, 0) // no "ok" outcomes
})

// ---------------------------------------------------------------------------
// Criterion #3, #4, #7: buildArtifact with ragasShadow section
// ---------------------------------------------------------------------------

test("T16 #3: buildArtifact includes ragasShadow section when provided", () => {
  const results: CaseResult[] = []
  const baseline = computeBaselineComparison(results, { p95LatencyMs: 0, averageTokens: 0 })
  const shadowSection = makeShadowSection()
  const artifact = buildArtifact({
    goldenSet: GOLDEN_SET,
    results,
    hardInvariants: evaluateHardInvariants(GOLDEN_SET.cases, results),
    qualityMetrics: evaluateQualityMetrics(GOLDEN_SET.cases, results),
    baseline,
    repositoryRevision: "abc",
    providerModelIds: { chat: "gpt-4", embedding: "text-embedding-3-small" },
    ragasShadow: shadowSection,
  })
  assert.ok(artifact.ragasShadow !== undefined)
  assert.equal(artifact.ragasShadow!.reportedSeparately, true)
  assert.deepEqual(artifact.ragasShadow!.baseline, shadowSection.baseline)
})

test("T16 #3: buildArtifact omits ragasShadow section when not provided (backward compat)", () => {
  const results: CaseResult[] = []
  const baseline = computeBaselineComparison(results, { p95LatencyMs: 0, averageTokens: 0 })
  const artifact = buildArtifact({
    goldenSet: GOLDEN_SET,
    results,
    hardInvariants: evaluateHardInvariants(GOLDEN_SET.cases, results),
    qualityMetrics: evaluateQualityMetrics(GOLDEN_SET.cases, results),
    baseline,
    repositoryRevision: "abc",
    providerModelIds: { chat: "gpt-4", embedding: "text-embedding-3-small" },
  })
  assert.equal(artifact.ragasShadow, undefined)
})

test("T16 #3: ragasShadow is structurally separate from aggregateMetrics.baseline (latency/token)", () => {
  const results: CaseResult[] = []
  const baseline = computeBaselineComparison(results, { p95LatencyMs: 0, averageTokens: 0 })
  const shadowSection = makeShadowSection()
  const artifact = buildArtifact({
    goldenSet: GOLDEN_SET,
    results,
    hardInvariants: evaluateHardInvariants(GOLDEN_SET.cases, results),
    qualityMetrics: evaluateQualityMetrics(GOLDEN_SET.cases, results),
    baseline,
    repositoryRevision: "abc",
    providerModelIds: { chat: "gpt-4", embedding: "text-embedding-3-small" },
    ragasShadow: shadowSection,
  })
  // aggregateMetrics.baseline is the latency/token BaselineComparison
  assert.ok(artifact.aggregateMetrics.baseline !== undefined)
  assert.equal(artifact.aggregateMetrics.baseline.p95LatencyMs, 0)
  // ragasShadow is a separate top-level field, NOT inside aggregateMetrics
  assert.ok(artifact.ragasShadow !== undefined)
  assert.ok(!("ragasShadow" in artifact.aggregateMetrics), "ragasShadow must NOT be inside aggregateMetrics")
})

test("T16 #3: ragasShadow is structurally separate from ragas (per-case T15 section)", () => {
  const results: CaseResult[] = []
  const baseline = computeBaselineComparison(results, { p95LatencyMs: 0, averageTokens: 0 })
  const shadowSection = makeShadowSection()
  const artifact = buildArtifact({
    goldenSet: GOLDEN_SET,
    results,
    hardInvariants: evaluateHardInvariants(GOLDEN_SET.cases, results),
    qualityMetrics: evaluateQualityMetrics(GOLDEN_SET.cases, results),
    baseline,
    repositoryRevision: "abc",
    providerModelIds: { chat: "gpt-4", embedding: "text-embedding-3-small" },
    ragasShadow: shadowSection,
  })
  // Both can coexist as separate top-level fields
  assert.ok(artifact.ragasShadow !== undefined)
  assert.equal(artifact.ragas, undefined) // not provided in this test
  // ragasShadow is NOT nested inside ragas
  assert.ok(!("ragasShadow" in (artifact.ragas ?? {})), "ragasShadow must NOT be inside ragas")
})

// ---------------------------------------------------------------------------
// Criterion #4: shadow regression never overrides deterministic hard-invariant failure
// ---------------------------------------------------------------------------

test("T16 #4: RAGAS shadow section cannot change hardInvariants[].passed (deterministic-gate precedence)", () => {
  const results: CaseResult[] = []
  const baseline = computeBaselineComparison(results, { p95LatencyMs: 0, averageTokens: 0 })
  // Record deterministic hard invariants BEFORE adding shadow section
  const hardInvariantsBefore = evaluateHardInvariants(GOLDEN_SET.cases, results)
  const shadowSection = makeShadowSection({
    comparison: {
      current: makeAggregate({ meanFaithfulness: 0.1 }), // terrible RAGAS scores
      baseline: makeShadowBaseline(),
      regressions: [
        { metric: "faithfulness", current: 0.1, baseline: 0.9, delta: -0.8, regressionDetected: true },
      ],
      regressionDetected: true,
    },
  })
  const artifact = buildArtifact({
    goldenSet: GOLDEN_SET,
    results,
    hardInvariants: hardInvariantsBefore,
    qualityMetrics: evaluateQualityMetrics(GOLDEN_SET.cases, results),
    baseline,
    repositoryRevision: "abc",
    providerModelIds: { chat: "gpt-4", embedding: "text-embedding-3-small" },
    ragasShadow: shadowSection,
  })
  // After adding shadow section with terrible RAGAS scores + regressions,
  // the hard invariants are UNCHANGED (deep equal).
  assert.deepEqual(artifact.aggregateMetrics.hardInvariants, hardInvariantsBefore)
  // The shadow section IS present with regressions, but it cannot mutate gates.
  assert.equal(artifact.ragasShadow!.comparison!.regressionDetected, true)
})

test("T16 #4: RAGAS shadow section cannot change CaseResult.status", () => {
  const results: CaseResult[] = [
    {
      caseId: "case-1",
      status: "failed",
      terminalStatus: "insufficient_evidence",
      retrievedEvidenceIds: [],
      citationsInAnswer: [],
      durationMs: 100,
      tokenCount: 10,
      failureReason: "no evidence",
    },
  ]
  const baseline = computeBaselineComparison(results, { p95LatencyMs: 0, averageTokens: 0 })
  const shadowSection = makeShadowSection()
  const artifact = buildArtifact({
    goldenSet: GOLDEN_SET,
    results,
    hardInvariants: evaluateHardInvariants(GOLDEN_SET.cases, results),
    qualityMetrics: evaluateQualityMetrics(GOLDEN_SET.cases, results),
    baseline,
    repositoryRevision: "abc",
    providerModelIds: { chat: "gpt-4", embedding: "text-embedding-3-small" },
    ragasShadow: shadowSection,
  })
  // CaseResult.status remains "failed" — RAGAS shadow cannot change it
  assert.equal(artifact.perCaseStatus[0].status, "failed")
  // RAGAS shadow section is present but structurally separate
  assert.ok(artifact.ragasShadow !== undefined)
})

test("T16 #4: types.ts source — ragasShadow is top-level field, NOT inside aggregateMetrics", () => {
  const source = readFileSync(TYPES_SOURCE_PATH, "utf8")
  // Extract EvaluationArtifact body
  const artifactMatch = source.match(/export interface EvaluationArtifact \{([\s\S]*?)\n\}/)
  assert.ok(artifactMatch, "EvaluationArtifact interface not found")
  const artifactBody = artifactMatch![1]
  // Extract aggregateMetrics block
  const aggMetricsMatch = artifactBody.match(/aggregateMetrics:\s*\{([\s\S]*?)\n\s*\}/)
  assert.ok(aggMetricsMatch, "aggregateMetrics block not found")
  const aggMetricsBody = aggMetricsMatch![1]
  // ragasShadow must NOT be inside aggregateMetrics block
  assert.ok(!aggMetricsBody.includes("ragasShadow"), "ragasShadow must NOT be inside aggregateMetrics block")
  // ragasShadow must be a top-level field on EvaluationArtifact
  assert.ok(artifactBody.includes("ragasShadow?:"), "ragasShadow must be a top-level field on EvaluationArtifact")
})

test("T16 #4: artifact.ts source — ragasShadow field is a sibling of aggregateMetrics, not nested", () => {
  const source = readFileSync(ARTIFACT_SOURCE_PATH, "utf8")
  // The buildArtifact function must assign artifact.ragasShadow at the top level
  assert.match(source, /artifact\.ragasShadow\s*=\s*input\.ragasShadow/)
  // ragasShadow must NOT be assigned as a property of aggregateMetrics.
  // Use a precise regex (dot directly followed by ragasShadow) to avoid false
  // positives from unrelated `aggregateMetrics.<otherField>` lines that happen
  // to be followed elsewhere in the file by the word `ragasShadow`.
  assert.ok(
    !/aggregateMetrics\.ragasShadow/.test(source),
    "ragasShadow must NOT be assigned inside aggregateMetrics (must be a top-level sibling)",
  )
})

// ---------------------------------------------------------------------------
// Criterion #7: JSON serialization + artifact reproducibility
// ---------------------------------------------------------------------------

test("T16 #7: artifact with ragasShadow section is JSON-serializable (no circular, no undefined leaks)", () => {
  const results: CaseResult[] = []
  const baseline = computeBaselineComparison(results, { p95LatencyMs: 0, averageTokens: 0 })
  const shadowSection = makeShadowSection({
    comparison: {
      current: makeAggregate({ meanFaithfulness: 0.85 }),
      baseline: makeShadowBaseline(),
      regressions: [
        { metric: "faithfulness", current: 0.85, baseline: 0.9, delta: -0.05, regressionDetected: true },
        { metric: "answerRelevancy", current: 0.85, baseline: 0.85, delta: 0, regressionDetected: false },
        { metric: "contextPrecision", current: 0.88, baseline: 0.88, delta: 0, regressionDetected: false },
        { metric: "contextRecall", current: 0.82, baseline: 0.82, delta: 0, regressionDetected: false },
      ],
      regressionDetected: true,
    },
  })
  const artifact = buildArtifact({
    goldenSet: GOLDEN_SET,
    results,
    hardInvariants: evaluateHardInvariants(GOLDEN_SET.cases, results),
    qualityMetrics: evaluateQualityMetrics(GOLDEN_SET.cases, results),
    baseline,
    repositoryRevision: "abc",
    providerModelIds: { chat: "gpt-4", embedding: "text-embedding-3-small" },
    ragasShadow: shadowSection,
  })
  const json = JSON.stringify(artifact)
  assert.ok(json.length > 0)
  const parsed = JSON.parse(json) as EvaluationArtifact
  assert.equal(parsed.schemaVersion, 1)
  assert.ok(parsed.ragasShadow !== undefined)
  assert.equal(parsed.ragasShadow!.reportedSeparately, true)
  assert.equal(parsed.ragasShadow!.baseline.runCount, 3)
  assert.equal(parsed.ragasShadow!.comparison!.regressions.length, 4)
  assert.equal(parsed.ragasShadow!.comparison!.regressions[0].metric, "faithfulness")
  assert.equal(parsed.ragasShadow!.comparison!.regressions[0].regressionDetected, true)
})

test("T16 #7: artifact without ragasShadow section is JSON-serializable (backward compat)", () => {
  const results: CaseResult[] = []
  const baseline = computeBaselineComparison(results, { p95LatencyMs: 0, averageTokens: 0 })
  const artifact = buildArtifact({
    goldenSet: GOLDEN_SET,
    results,
    hardInvariants: evaluateHardInvariants(GOLDEN_SET.cases, results),
    qualityMetrics: evaluateQualityMetrics(GOLDEN_SET.cases, results),
    baseline,
    repositoryRevision: "abc",
    providerModelIds: { chat: "gpt-4", embedding: "text-embedding-3-small" },
  })
  const json = JSON.stringify(artifact)
  const parsed = JSON.parse(json) as EvaluationArtifact
  assert.equal(parsed.schemaVersion, 1)
  assert.equal(parsed.ragasShadow, undefined)
})

test("T16 #7: backward compat — existing artifact (schemaVersion=1) without ragasShadow field still parses", () => {
  // Simulate an old artifact from before T16 — no ragasShadow field
  const oldArtifactJson = JSON.stringify({
    schemaVersion: 1,
    repositoryRevision: "old-commit",
    datasetVersion: "2026.07.t10",
    providerModelIds: { chat: "gpt-4", embedding: "text-embedding-3-small" },
    generatedAt: "2026-07-01T00:00:00.000Z",
    aggregateMetrics: {
      hardInvariants: [],
      qualityMetrics: [],
      baseline: { p95LatencyMs: 0, p95LatencyBaselineMs: 0, p95LatencyRegression: false, averageTokens: 0, averageTokensBaseline: 0, averageTokensRegression: false },
    },
    perCaseStatus: [],
  })
  const parsed = JSON.parse(oldArtifactJson) as EvaluationArtifact
  assert.equal(parsed.schemaVersion, 1)
  assert.equal(parsed.ragasShadow, undefined)
})

test("T16 #7: artifact schemaVersion remains 1 (T16 is additive, no schema bump)", () => {
  const results: CaseResult[] = []
  const baseline = computeBaselineComparison(results, { p95LatencyMs: 0, averageTokens: 0 })
  const shadowSection = makeShadowSection()
  const artifact = buildArtifact({
    goldenSet: GOLDEN_SET,
    results,
    hardInvariants: evaluateHardInvariants(GOLDEN_SET.cases, results),
    qualityMetrics: evaluateQualityMetrics(GOLDEN_SET.cases, results),
    baseline,
    repositoryRevision: "abc",
    providerModelIds: { chat: "gpt-4", embedding: "text-embedding-3-small" },
    ragasShadow: shadowSection,
  })
  assert.equal(artifact.schemaVersion, 1)
})

test("T16 #7: artifact reproducibility — same shadow inputs produce same baseline shape", async () => {
  // Run the same profile twice — both should produce identical baseline shapes
  // (modulo generatedAt timestamp which is non-deterministic).
  const evaluator1 = new FakeRagasEvaluator({ defaultResponse: makeOkResponse("case-1") })
  const evaluator2 = new FakeRagasEvaluator({ defaultResponse: makeOkResponse("case-1") })
  const config1 = makeProfileConfig({ evaluator: evaluator1, runCount: 3, shadowCases: [makeShadowCase("case-1")] })
  const config2 = makeProfileConfig({ evaluator: evaluator2, runCount: 3, shadowCases: [makeShadowCase("case-1")] })
  const result1 = await runRagasShadowProfile(config1)
  const result2 = await runRagasShadowProfile(config2)
  assert.equal(result1.status, result2.status)
  assert.equal(result1.baseline!.runCount, result2.baseline!.runCount)
  assert.equal(result1.baseline!.aggregate.meanFaithfulness, result2.baseline!.aggregate.meanFaithfulness)
  assert.equal(result1.baseline!.variance.faithfulness.min, result2.baseline!.variance.faithfulness.min)
  assert.equal(result1.baseline!.variance.faithfulness.max, result2.baseline!.variance.faithfulness.max)
  assert.equal(result1.baseline!.variance.faithfulness.stdDev, result2.baseline!.variance.faithfulness.stdDev)
  assert.deepEqual(result1.baseline!.providerModelIds, result2.baseline!.providerModelIds)
  assert.equal(result1.baseline!.datasetVersion, result2.baseline!.datasetVersion)
})

// ---------------------------------------------------------------------------
// Criterion #7: missing-data behavior
// ---------------------------------------------------------------------------

test("T16 #7: missing-data — empty shadowCases produces baseline with sampleSize=0 (no throws)", async () => {
  const evaluator = new FakeRagasEvaluator()
  const config = makeProfileConfig({ evaluator, runCount: 2, shadowCases: [] })
  const result = await runRagasShadowProfile(config)
  assert.equal(result.status, "passed")
  // aggregate.sampleSize is the mean per-run sampleSize — each run had 0
  // cases, so the representative aggregate sampleSize is 0.
  assert.equal(result.baseline!.aggregate.sampleSize, 0)
  assert.equal(result.baseline!.aggregate.meanFaithfulness, 0)
  // variance.sampleSize is the NUMBER OF RUNS that contributed to variance
  // (not the number of cases). With runCount=2, two per-run aggregates were
  // produced (each vacuous, all zeros), so variance.sampleSize=2 and the
  // stdDev is 0 (both runs returned identical all-zero aggregates).
  assert.equal(result.baseline!.variance.faithfulness.sampleSize, 2)
  assert.equal(result.baseline!.variance.faithfulness.stdDev, 0)
})

test("T16 #7: missing-data — empty checkedInBaseline comparison handles zero baseline gracefully", () => {
  // Current all-zeros, baseline all-zeros → no regressions detected (0 < 0 is false)
  const current = makeAggregate({
    meanFaithfulness: 0,
    meanAnswerRelevancy: 0,
    meanContextPrecision: 0,
    meanContextRecall: 0,
  })
  const baseline = makeShadowBaseline({
    aggregate: makeAggregate({
      meanFaithfulness: 0,
      meanAnswerRelevancy: 0,
      meanContextPrecision: 0,
      meanContextRecall: 0,
    }),
  })
  const comparison = compareRagasShadowToBaseline(current, baseline)
  assert.equal(comparison.regressionDetected, false)
  assert.equal(comparison.regressions.every((r) => !r.regressionDetected), true)
})
