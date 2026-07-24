// Ticket 15 — Project RAGAS into evaluation artifacts: tests.
//
// Spec issue #15 criterion #7: "Artifact/schema tests verify JSON serialization,
// backward compatibility and deterministic-gate precedence."
//
// These tests cover:
//   - Criterion #1: GoldenCase.referenceAnswer validation (optional non-empty string)
//   - Criterion #2: projectCaseToRagasRequest produces versioned bounded request
//   - Criterion #3: 4 metric names recorded exactly (faithfulness, answer_relevancy,
//     context_precision, context_recall)
//   - Criterion #4: per-case outcomes + aggregate values + runtime info
//   - Criterion #5: RAGAS section structurally separate from hardInvariants
//   - Criterion #6: projection excludes drafts, production conversations, raw trace
//   - Criterion #7: JSON serialization, backward compat, deterministic-gate precedence

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  isCaseRagasEligible,
  ragasSkipReason,
  projectCaseToRagasRequest,
  computeRagasAggregate,
  ragasResponseToOutcome,
  skippedRagasOutcome,
} from "./ragas_projection"
import { validateGoldenCase } from "./golden/schema"
import { buildArtifact, computeBaselineComparison } from "./artifact"
import { evaluateHardInvariants } from "./hard_invariants"
import { evaluateQualityMetrics } from "./quality_metrics"
import { GOLDEN_SET } from "./golden/fixtures"
import type {
  AnswerRunOutputs,
  CaseResult,
  EvaluationArtifact,
  GoldenCase,
  RagasArtifactSection,
  RagasCaseOutcome,
  RagasMetricResult,
  RagasRequest,
  RagasResponse,
} from "./types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const here = __dirname
const PROJECTION_SOURCE_PATH = join(here, "ragas_projection.ts")
const ARTIFACT_SOURCE_PATH = join(here, "artifact.ts")

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

function makeCaseResult(overrides: Partial<CaseResult> = {}): CaseResult {
  return {
    caseId: "simple-01",
    status: "passed",
    terminalStatus: "completed",
    retrievedEvidenceIds: ["ev-refund-01"],
    citationsInAnswer: ["ev-refund-01"],
    durationMs: 200,
    tokenCount: 100,
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

function makeEvaluatorModelIdentities(): RagasRequest["evaluatorModelIdentities"] {
  return {
    chat: "gpt-4-0613",
    embedding: "text-embedding-3-small",
    evaluator: "gpt-4-0613",
  }
}

function makeMetric(name: string, score: number, rationale?: string): RagasMetricResult {
  const m: RagasMetricResult = { name, score }
  if (rationale !== undefined) m.rationale = rationale
  return m
}

function makeOkMetrics(): RagasMetricResult[] {
  return [
    makeMetric("faithfulness", 0.95),
    makeMetric("answer_relevancy", 0.88),
    makeMetric("context_precision", 0.92),
    makeMetric("context_recall", 0.85),
  ]
}

function makeOkOutcome(caseId: string, metrics?: RagasMetricResult[]): RagasCaseOutcome {
  return {
    caseId,
    status: "ok",
    metrics: metrics ?? makeOkMetrics(),
    durationMs: 1500,
  }
}

function makeRagasSection(overrides: Partial<RagasArtifactSection> = {}): RagasArtifactSection {
  return {
    runtime: {
      ragasVersion: "0.2.14",
      pythonVersion: "3.11.6",
      runnerSchemaVersion: 1,
    },
    evaluatorModelIdentities: makeEvaluatorModelIdentities(),
    aggregate: {
      meanFaithfulness: 0.9,
      meanAnswerRelevancy: 0.85,
      meanContextPrecision: 0.88,
      meanContextRecall: 0.82,
      sampleSize: 1,
      errorCount: 0,
      skippedCount: 0,
    },
    perCase: [makeOkOutcome("simple-01")],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Criterion #1: GoldenCase.referenceAnswer validation
// ---------------------------------------------------------------------------

test("T15 #1: validateGoldenCase accepts optional referenceAnswer (non-empty string)", () => {
  const gc = validateGoldenCase({
    id: "simple-01",
    version: 1,
    category: "simple",
    userMessage: "What is the refund policy?",
    expectedSourceIds: ["src-refund"],
    acceptableEvidenceIds: ["ev-refund-01"],
    referenceAnswer: "Refunds are available within 30 days.",
  })
  assert.equal(gc.referenceAnswer, "Refunds are available within 30 days.")
})

test("T15 #1: validateGoldenCase accepts case without referenceAnswer (backward compat)", () => {
  const gc = validateGoldenCase({
    id: "simple-02",
    version: 1,
    category: "simple",
    userMessage: "What is the refund policy?",
    expectedSourceIds: ["src-refund"],
    acceptableEvidenceIds: ["ev-refund-01"],
  })
  assert.equal(gc.referenceAnswer, undefined)
})

test("T15 #1: validateGoldenCase rejects empty string referenceAnswer", () => {
  assert.throws(
    () =>
      validateGoldenCase({
        id: "simple-03",
        version: 1,
        category: "simple",
        userMessage: "What is the refund policy?",
        expectedSourceIds: ["src-refund"],
        acceptableEvidenceIds: ["ev-refund-01"],
        referenceAnswer: "",
      }),
    /referenceAnswer.*non-empty/,
  )
})

test("T15 #1: validateGoldenCase rejects non-string referenceAnswer", () => {
  assert.throws(
    () =>
      validateGoldenCase({
        id: "simple-04",
        version: 1,
        category: "simple",
        userMessage: "What is the refund policy?",
        expectedSourceIds: ["src-refund"],
        acceptableEvidenceIds: ["ev-refund-01"],
        referenceAnswer: 42,
      }),
    /referenceAnswer.*string/,
  )
})

// ---------------------------------------------------------------------------
// Criterion #1, #2: isCaseRagasEligible
// ---------------------------------------------------------------------------

test("T15 #1: isCaseRagasEligible returns true when referenceAnswer present + completed + passed", () => {
  assert.equal(isCaseRagasEligible(makeGoldenCase(), makeCaseResult()), true)
})

test("T15 #1: isCaseRagasEligible returns false when referenceAnswer absent", () => {
  const gc = makeGoldenCase({ referenceAnswer: undefined })
  assert.equal(isCaseRagasEligible(gc, makeCaseResult()), false)
})

test("T15 #1: isCaseRagasEligible returns false when referenceAnswer is empty string", () => {
  const gc = makeGoldenCase({ referenceAnswer: "" })
  assert.equal(isCaseRagasEligible(gc, makeCaseResult()), false)
})

test("T15 #1: isCaseRagasEligible returns false when terminalStatus != completed", () => {
  const result = makeCaseResult({ terminalStatus: "insufficient_evidence" })
  assert.equal(isCaseRagasEligible(makeGoldenCase(), result), false)
})

test("T15 #1: isCaseRagasEligible returns false when case status != passed", () => {
  const result = makeCaseResult({ status: "failed" })
  assert.equal(isCaseRagasEligible(makeGoldenCase(), result), false)
})

test("T15 #1: ragasSkipReason returns undefined when eligible", () => {
  assert.equal(ragasSkipReason(makeGoldenCase(), makeCaseResult()), undefined)
})

test("T15 #1: ragasSkipReason returns 'no referenceAnswer declared' when absent", () => {
  const gc = makeGoldenCase({ referenceAnswer: undefined })
  assert.equal(ragasSkipReason(gc, makeCaseResult()), "no referenceAnswer declared")
})

test("T15 #1: ragasSkipReason returns terminal status reason when non-completed", () => {
  const result = makeCaseResult({ terminalStatus: "insufficient_evidence" })
  assert.match(ragasSkipReason(makeGoldenCase(), result)!, /non-completed terminal status/)
})

test("T15 #1: ragasSkipReason returns case status reason when non-passed", () => {
  const result = makeCaseResult({ status: "skipped" })
  assert.match(ragasSkipReason(makeGoldenCase(), result)!, /non-passed case status/)
})

// ---------------------------------------------------------------------------
// Criterion #2, #6: projectCaseToRagasRequest
// ---------------------------------------------------------------------------

test("T15 #2: projectCaseToRagasRequest produces versioned bounded RagasRequest", () => {
  const gc = makeGoldenCase()
  const runOutputs = makeRunOutputs()
  const identities = makeEvaluatorModelIdentities()
  const request = projectCaseToRagasRequest(gc, runOutputs, identities)
  assert.equal(request.schemaVersion, 1)
  assert.equal(request.caseId, "simple-01")
  assert.equal(request.question, gc.userMessage)
  assert.equal(request.approvedAnswer, runOutputs.approvedAnswer)
  assert.deepEqual(request.retrievedContexts, runOutputs.retrievedContexts)
  assert.equal(request.referenceAnswer, gc.referenceAnswer)
  assert.deepEqual(request.evaluatorModelIdentities, identities)
})

test("T15 #2: projectCaseToRagasRequest uses GoldenCase.userMessage as question (not production conversations)", () => {
  const gc = makeGoldenCase({ userMessage: "Synthetic test question" })
  const request = projectCaseToRagasRequest(gc, makeRunOutputs(), makeEvaluatorModelIdentities())
  assert.equal(request.question, "Synthetic test question")
})

test("T15 #2: projectCaseToRagasRequest uses AnswerRunOutputs.approvedAnswer (not rejected drafts)", () => {
  const runOutputs = makeRunOutputs({ approvedAnswer: "Final approved answer text" })
  const request = projectCaseToRagasRequest(makeGoldenCase(), runOutputs, makeEvaluatorModelIdentities())
  assert.equal(request.approvedAnswer, "Final approved answer text")
})

test("T15 #2: projectCaseToRagasRequest uses AnswerRunOutputs.retrievedContexts (not raw trace payloads)", () => {
  const runOutputs = makeRunOutputs({ retrievedContexts: ["context chunk 1", "context chunk 2"] })
  const request = projectCaseToRagasRequest(makeGoldenCase(), runOutputs, makeEvaluatorModelIdentities())
  assert.deepEqual(request.retrievedContexts, ["context chunk 1", "context chunk 2"])
})

test("T15 #6: projectCaseToRagasRequest signature structurally excludes drafts, production conversations, raw trace", () => {
  // Static source check: the function signature only takes GoldenCase + AnswerRunOutputs + evaluatorModelIdentities.
  // It does NOT accept drafts, production conversations, or raw trace payloads.
  const source = readFileSync(PROJECTION_SOURCE_PATH, "utf8")
  assert.match(source, /export function projectCaseToRagasRequest\(\s*goldenCase: GoldenCase,\s*runOutputs: AnswerRunOutputs,\s*evaluatorModelIdentities: RagasRequest\["evaluatorModelIdentities"\],\s*\): RagasRequest/)
})

test("T15 #6: AnswerRunOutputs interface only carries caseId + approvedAnswer + retrievedContexts (no drafts, no trace)", () => {
  // Static source check: AnswerRunOutputs has exactly 3 fields, all bounded public outputs.
  const typesSource = readFileSync(join(here, "types.ts"), "utf8")
  assert.match(typesSource, /export interface AnswerRunOutputs \{[^}]*caseId: string[^}]*approvedAnswer: string[^}]*retrievedContexts: string\[\][^}]*\}/s)
})

// ---------------------------------------------------------------------------
// Criterion #3, #4: computeRagasAggregate — 4 metric names exactly
// ---------------------------------------------------------------------------

test("T15 #3: computeRagasAggregate uses exact RAGAS metric names: faithfulness, answer_relevancy, context_precision, context_recall", () => {
  const outcomes: RagasCaseOutcome[] = [
    makeOkOutcome("case-1", [
      makeMetric("faithfulness", 0.9),
      makeMetric("answer_relevancy", 0.8),
      makeMetric("context_precision", 0.85),
      makeMetric("context_recall", 0.75),
    ]),
    makeOkOutcome("case-2", [
      makeMetric("faithfulness", 0.95),
      makeMetric("answer_relevancy", 0.9),
      makeMetric("context_precision", 0.95),
      makeMetric("context_recall", 0.85),
    ]),
  ]
  const agg = computeRagasAggregate(outcomes)
  assert.equal(agg.meanFaithfulness, (0.9 + 0.95) / 2)
  assert.equal(agg.meanAnswerRelevancy, (0.8 + 0.9) / 2)
  assert.equal(agg.meanContextPrecision, (0.85 + 0.95) / 2)
  assert.equal(agg.meanContextRecall, (0.75 + 0.85) / 2)
  assert.equal(agg.sampleSize, 2)
  assert.equal(agg.errorCount, 0)
  assert.equal(agg.skippedCount, 0)
})

test("T15 #4: computeRagasAggregate counts error + skipped outcomes separately", () => {
  const outcomes: RagasCaseOutcome[] = [
    makeOkOutcome("case-1"),
    { caseId: "case-2", status: "error", durationMs: 100, error: { kind: "timeout", message: "timed out" } },
    { caseId: "case-3", status: "skipped", skippedReason: "no referenceAnswer" },
  ]
  const agg = computeRagasAggregate(outcomes)
  assert.equal(agg.sampleSize, 1)
  assert.equal(agg.errorCount, 1)
  assert.equal(agg.skippedCount, 1)
})

test("T15 #4: computeRagasAggregate returns 0 means when no ok outcomes", () => {
  const outcomes: RagasCaseOutcome[] = [
    { caseId: "case-1", status: "skipped", skippedReason: "no referenceAnswer" },
  ]
  const agg = computeRagasAggregate(outcomes)
  assert.equal(agg.meanFaithfulness, 0)
  assert.equal(agg.meanAnswerRelevancy, 0)
  assert.equal(agg.meanContextPrecision, 0)
  assert.equal(agg.meanContextRecall, 0)
  assert.equal(agg.sampleSize, 0)
  assert.equal(agg.skippedCount, 1)
})

test("T15 #4: computeRagasAggregate handles ok outcome with missing metric (contributes to sampleSize only)", () => {
  const outcomes: RagasCaseOutcome[] = [
    makeOkOutcome("case-1", [
      makeMetric("faithfulness", 0.9),
      // answer_relevancy, context_precision, context_recall missing
    ]),
    makeOkOutcome("case-2", makeOkMetrics()),
  ]
  const agg = computeRagasAggregate(outcomes)
  // meanFaithfulness averages both cases (0.9 + 0.95) / 2
  assert.equal(agg.meanFaithfulness, (0.9 + 0.95) / 2)
  // meanAnswerRelevancy only has case-2's 0.88
  assert.equal(agg.meanAnswerRelevancy, 0.88)
  assert.equal(agg.sampleSize, 2)
})

test("T15 #4: computeRagasAggregate on empty outcomes returns all zeros", () => {
  const agg = computeRagasAggregate([])
  assert.equal(agg.meanFaithfulness, 0)
  assert.equal(agg.meanAnswerRelevancy, 0)
  assert.equal(agg.meanContextPrecision, 0)
  assert.equal(agg.meanContextRecall, 0)
  assert.equal(agg.sampleSize, 0)
  assert.equal(agg.errorCount, 0)
  assert.equal(agg.skippedCount, 0)
})

// ---------------------------------------------------------------------------
// Criterion #4: ragasResponseToOutcome + skippedRagasOutcome
// ---------------------------------------------------------------------------

test("T15 #4: ragasResponseToOutcome converts ok response to ok outcome with metrics + durationMs", () => {
  const response: RagasResponse = {
    schemaVersion: 1,
    caseId: "case-1",
    status: "ok",
    metrics: makeOkMetrics(),
    durationMs: 1500,
  }
  const outcome = ragasResponseToOutcome(response)
  assert.equal(outcome.caseId, "case-1")
  assert.equal(outcome.status, "ok")
  assert.deepEqual(outcome.metrics, makeOkMetrics())
  assert.equal(outcome.durationMs, 1500)
  assert.equal(outcome.error, undefined)
  assert.equal(outcome.skippedReason, undefined)
})

test("T15 #4: ragasResponseToOutcome converts error response to error outcome with error + durationMs", () => {
  const response: RagasResponse = {
    schemaVersion: 1,
    caseId: "case-2",
    status: "error",
    durationMs: 500,
    error: { kind: "timeout", message: "evaluator timed out" },
  }
  const outcome = ragasResponseToOutcome(response)
  assert.equal(outcome.caseId, "case-2")
  assert.equal(outcome.status, "error")
  assert.equal(outcome.durationMs, 500)
  assert.deepEqual(outcome.error, { kind: "timeout", message: "evaluator timed out" })
  assert.equal(outcome.metrics, undefined)
})

test("T15 #4: skippedRagasOutcome creates skipped outcome with caseId + reason", () => {
  const outcome = skippedRagasOutcome("case-3", "no referenceAnswer declared")
  assert.equal(outcome.caseId, "case-3")
  assert.equal(outcome.status, "skipped")
  assert.equal(outcome.skippedReason, "no referenceAnswer declared")
  assert.equal(outcome.metrics, undefined)
  assert.equal(outcome.error, undefined)
  assert.equal(outcome.durationMs, undefined)
})

// ---------------------------------------------------------------------------
// Criterion #5, #7: buildArtifact with RAGAS section — structural separation
// ---------------------------------------------------------------------------

test("T15 #5: buildArtifact includes ragas section when provided", () => {
  const results: CaseResult[] = []
  const baseline = computeBaselineComparison(results, { p95LatencyMs: 0, averageTokens: 0 })
  const ragasSection = makeRagasSection()
  const artifact = buildArtifact({
    goldenSet: GOLDEN_SET,
    results,
    hardInvariants: evaluateHardInvariants(GOLDEN_SET.cases, results),
    qualityMetrics: evaluateQualityMetrics(GOLDEN_SET.cases, results),
    baseline,
    repositoryRevision: "abc",
    providerModelIds: { chat: "gpt-4", embedding: "text-embedding-3-small" },
    ragas: ragasSection,
  })
  assert.equal(artifact.ragas, ragasSection)
  assert.equal(artifact.ragas!.runtime.ragasVersion, "0.2.14")
  assert.equal(artifact.ragas!.perCase.length, 1)
})

test("T15 #5: buildArtifact omits ragas section when not provided (backward compat)", () => {
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
  assert.equal(artifact.ragas, undefined)
})

test("T15 #5: RAGAS section is structurally separate from aggregateMetrics (criterion #5)", () => {
  const results: CaseResult[] = []
  const baseline = computeBaselineComparison(results, { p95LatencyMs: 0, averageTokens: 0 })
  const hi = evaluateHardInvariants(GOLDEN_SET.cases, results)
  const qm = evaluateQualityMetrics(GOLDEN_SET.cases, results)
  const ragasSection = makeRagasSection()
  const artifact = buildArtifact({
    goldenSet: GOLDEN_SET,
    results,
    hardInvariants: hi,
    qualityMetrics: qm,
    baseline,
    repositoryRevision: "abc",
    providerModelIds: { chat: "gpt-4", embedding: "text-embedding-3-small" },
    ragas: ragasSection,
  })
  // RAGAS section is a sibling of aggregateMetrics, NOT nested inside it
  assert.ok(artifact.ragas)
  assert.equal(artifact.aggregateMetrics.hardInvariants, hi)
  assert.equal(artifact.aggregateMetrics.qualityMetrics, qm)
  // RAGAS section does NOT appear inside aggregateMetrics
  assert.equal((artifact.aggregateMetrics as Record<string, unknown>).ragas, undefined)
})

test("T15 #5: RAGAS results cannot change hard invariant pass/fail state (deterministic-gate precedence)", () => {
  // Build an artifact where hard invariants FAIL, but RAGAS section has all ok outcomes.
  // The artifact must still report the hard invariant failures — RAGAS cannot override them.
  const results: CaseResult[] = [
    {
      caseId: "failing-case",
      status: "failed",
      terminalStatus: "completed",
      retrievedEvidenceIds: [],
      citationsInAnswer: [],
      durationMs: 100,
      tokenCount: 50,
      // This triggers knowledge_completed_zero_refs_zero (completed with zero citations)
    },
  ]
  // Create a golden case matching the failing case to make hard invariants evaluate
  const failingGoldenCase: GoldenCase = {
    id: "failing-case",
    version: 1,
    category: "simple",
    userMessage: "Test question",
    expectedSourceIds: ["src-1"],
    acceptableEvidenceIds: ["ev-1"],
    referenceAnswer: "Test reference answer",
  }
  const hi = evaluateHardInvariants([failingGoldenCase], results)
  const knowledgeInvariant = hi.find((h) => h.key === "knowledge_completed_zero_refs_zero")!
  assert.equal(knowledgeInvariant.passed, false, "hard invariant should fail (zero citations on completed knowledge case)")

  // Now add a RAGAS section with all ok outcomes (high scores)
  const ragasSection = makeRagasSection({
    perCase: [makeOkOutcome("failing-case")],
    aggregate: {
      meanFaithfulness: 1.0,
      meanAnswerRelevancy: 1.0,
      meanContextPrecision: 1.0,
      meanContextRecall: 1.0,
      sampleSize: 1,
      errorCount: 0,
      skippedCount: 0,
    },
  })
  const baseline = computeBaselineComparison(results, { p95LatencyMs: 0, averageTokens: 0 })
  const artifact = buildArtifact({
    goldenSet: GOLDEN_SET,
    results,
    hardInvariants: hi,
    qualityMetrics: evaluateQualityMetrics([failingGoldenCase], results),
    baseline,
    repositoryRevision: "abc",
    providerModelIds: { chat: "gpt-4", embedding: "text-embedding-3-small" },
    ragas: ragasSection,
  })
  // The hard invariant MUST still be failed — RAGAS cannot change it
  const artifactKnowledgeInvariant = artifact.aggregateMetrics.hardInvariants.find(
    (h) => h.key === "knowledge_completed_zero_refs_zero",
  )!
  assert.equal(artifactKnowledgeInvariant.passed, false, "RAGAS results must NOT change hard invariant pass/fail state")
  // RAGAS section is present with high scores, but it's separate
  assert.equal(artifact.ragas!.aggregate.meanFaithfulness, 1.0)
})

test("T15 #5: RAGAS results cannot change CaseResult.status (deterministic-gate precedence)", () => {
  // A CaseResult with status="failed" must remain "failed" even when RAGAS gives it high scores
  const results: CaseResult[] = [
    {
      caseId: "failed-case",
      status: "failed",
      terminalStatus: "completed",
      retrievedEvidenceIds: [],
      citationsInAnswer: [],
      durationMs: 100,
      tokenCount: 50,
      failureReason: "hard invariant violation",
    },
  ]
  const ragasSection = makeRagasSection({
    perCase: [makeOkOutcome("failed-case")],
  })
  const baseline = computeBaselineComparison(results, { p95LatencyMs: 0, averageTokens: 0 })
  const artifact = buildArtifact({
    goldenSet: GOLDEN_SET,
    results,
    hardInvariants: evaluateHardInvariants(GOLDEN_SET.cases, results),
    qualityMetrics: evaluateQualityMetrics(GOLDEN_SET.cases, results),
    baseline,
    repositoryRevision: "abc",
    providerModelIds: { chat: "gpt-4", embedding: "text-embedding-3-small" },
    ragas: ragasSection,
  })
  // CaseResult.status remains "failed" — RAGAS cannot change it
  assert.equal(artifact.perCaseStatus[0].status, "failed")
  // RAGAS section records the ok outcome, but it's structurally separate
  assert.equal(artifact.ragas!.perCase[0].status, "ok")
})

// ---------------------------------------------------------------------------
// Criterion #7: JSON serialization + backward compatibility
// ---------------------------------------------------------------------------

test("T15 #7: artifact with RAGAS section is JSON-serializable (no circular, no undefined leaks)", () => {
  const results: CaseResult[] = []
  const baseline = computeBaselineComparison(results, { p95LatencyMs: 0, averageTokens: 0 })
  const perCase: RagasCaseOutcome[] = [
    makeOkOutcome("case-1"),
    { caseId: "case-2", status: "error", durationMs: 100, error: { kind: "timeout", message: "timed out" } },
    skippedRagasOutcome("case-3", "no referenceAnswer declared"),
  ]
  const ragasSection = makeRagasSection({
    perCase,
    aggregate: computeRagasAggregate(perCase),
  })
  const artifact = buildArtifact({
    goldenSet: GOLDEN_SET,
    results,
    hardInvariants: evaluateHardInvariants(GOLDEN_SET.cases, results),
    qualityMetrics: evaluateQualityMetrics(GOLDEN_SET.cases, results),
    baseline,
    repositoryRevision: "abc",
    providerModelIds: { chat: "gpt-4", embedding: "text-embedding-3-small", evaluator: "gpt-4o" },
    ragas: ragasSection,
  })
  const json = JSON.stringify(artifact)
  assert.ok(json.length > 0)
  const parsed = JSON.parse(json) as EvaluationArtifact
  assert.equal(parsed.schemaVersion, 1)
  assert.equal(parsed.ragas!.runtime.ragasVersion, "0.2.14")
  assert.equal(parsed.ragas!.runtime.runnerSchemaVersion, 1)
  assert.equal(parsed.ragas!.perCase.length, 3)
  assert.equal(parsed.ragas!.perCase[0].status, "ok")
  assert.equal(parsed.ragas!.perCase[0].metrics!.length, 4)
  assert.equal(parsed.ragas!.perCase[1].status, "error")
  assert.equal(parsed.ragas!.perCase[1].error!.kind, "timeout")
  assert.equal(parsed.ragas!.perCase[2].status, "skipped")
  assert.equal(parsed.ragas!.perCase[2].skippedReason, "no referenceAnswer declared")
  assert.equal(parsed.ragas!.aggregate.sampleSize, 1)
  assert.equal(parsed.ragas!.aggregate.errorCount, 1)
  assert.equal(parsed.ragas!.aggregate.skippedCount, 1)
})

test("T15 #7: artifact without RAGAS section is JSON-serializable (backward compat)", () => {
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
  assert.equal(parsed.ragas, undefined)
  assert.equal(parsed.aggregateMetrics.hardInvariants.length, 8)
  assert.equal(parsed.aggregateMetrics.qualityMetrics.length, 6)
})

test("T15 #7: backward compat — existing artifact (schemaVersion=1) without ragas field still parses", () => {
  // Simulate an old artifact from before T15 — no ragas field
  const oldArtifactJson = JSON.stringify({
    schemaVersion: 1,
    repositoryRevision: "old-commit",
    datasetVersion: "2026.07.t10",
    providerModelIds: { chat: "gpt-4", embedding: "text-embedding-3-small" },
    generatedAt: "2026-07-01T00:00:00.000Z",
    aggregateMetrics: {
      hardInvariants: [],
      qualityMetrics: [],
      baseline: {
        p95LatencyMs: 0,
        p95LatencyBaselineMs: 0,
        p95LatencyRegression: false,
        averageTokens: 0,
        averageTokensBaseline: 0,
        averageTokensRegression: false,
      },
    },
    perCaseStatus: [],
  })
  const parsed = JSON.parse(oldArtifactJson) as EvaluationArtifact
  assert.equal(parsed.schemaVersion, 1)
  assert.equal(parsed.ragas, undefined)
  assert.equal(parsed.perCaseStatus.length, 0)
})

test("T15 #7: artifact schemaVersion remains 1 (T15 is additive, no schema bump)", () => {
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
    ragas: makeRagasSection(),
  })
  assert.equal(artifact.schemaVersion, 1)
})

// ---------------------------------------------------------------------------
// Criterion #4: RAGAS section records evaluator model IDs + embedding model ID + runtime version
// ---------------------------------------------------------------------------

test("T15 #4: RAGAS section records evaluator model IDs (chat, embedding, evaluator)", () => {
  const ragasSection = makeRagasSection({
    evaluatorModelIdentities: {
      chat: "gpt-4-0613",
      embedding: "text-embedding-3-small",
      evaluator: "gpt-4-0613",
    },
  })
  assert.equal(ragasSection.evaluatorModelIdentities.chat, "gpt-4-0613")
  assert.equal(ragasSection.evaluatorModelIdentities.embedding, "text-embedding-3-small")
  assert.equal(ragasSection.evaluatorModelIdentities.evaluator, "gpt-4-0613")
})

test("T15 #4: RAGAS section records runtime version (ragasVersion, pythonVersion, runnerSchemaVersion)", () => {
  const ragasSection = makeRagasSection({
    runtime: {
      ragasVersion: "0.2.14",
      pythonVersion: "3.11.6",
      runnerSchemaVersion: 1,
    },
  })
  assert.equal(ragasSection.runtime.ragasVersion, "0.2.14")
  assert.equal(ragasSection.runtime.pythonVersion, "3.11.6")
  assert.equal(ragasSection.runtime.runnerSchemaVersion, 1)
})

test("T15 #4: RAGAS section records embedding model ID via evaluatorModelIdentities.embedding", () => {
  const ragasSection = makeRagasSection()
  // Criterion #4 requires "embedding model ID" — it lives in evaluatorModelIdentities.embedding
  assert.equal(typeof ragasSection.evaluatorModelIdentities.embedding, "string")
  assert.ok(ragasSection.evaluatorModelIdentities.embedding.length > 0)
})

test("T15 #4: RAGAS section records skipped/failed reasons per case", () => {
  const outcomes: RagasCaseOutcome[] = [
    makeOkOutcome("case-1"),
    { caseId: "case-2", status: "error", durationMs: 100, error: { kind: "evaluator_failure", message: "ragas import failed" } },
    skippedRagasOutcome("case-3", "no referenceAnswer declared"),
    skippedRagasOutcome("case-4", "non-completed terminal status: insufficient_evidence"),
  ]
  const ragasSection = makeRagasSection({ perCase: outcomes })
  assert.equal(ragasSection.perCase[0].status, "ok")
  assert.equal(ragasSection.perCase[1].status, "error")
  assert.equal(ragasSection.perCase[1].error!.kind, "evaluator_failure")
  assert.equal(ragasSection.perCase[1].error!.message, "ragas import failed")
  assert.equal(ragasSection.perCase[2].status, "skipped")
  assert.equal(ragasSection.perCase[2].skippedReason, "no referenceAnswer declared")
  assert.equal(ragasSection.perCase[3].status, "skipped")
  assert.match(ragasSection.perCase[3].skippedReason!, /non-completed terminal status/)
})

// ---------------------------------------------------------------------------
// Criterion #5: static source checks for structural separation
// ---------------------------------------------------------------------------

test("T15 #5: artifact.ts source — ragas field is a sibling of aggregateMetrics, not nested", () => {
  const source = readFileSync(ARTIFACT_SOURCE_PATH, "utf8")
  // The artifact object literal must have both aggregateMetrics and ragas as top-level keys
  assert.match(source, /const artifact: EvaluationArtifact = \{[^}]*aggregateMetrics,[^}]*perCaseStatus: input\.results,/)
  assert.match(source, /if \(input\.ragas !== undefined\) \{[^}]*artifact\.ragas = input\.ragas/)
})

test("T15 #5: types.ts source — EvaluationArtifact.ragas is optional and separate from aggregateMetrics", () => {
  const source = readFileSync(join(here, "types.ts"), "utf8")
  // ragas? must be a top-level field on EvaluationArtifact, NOT inside aggregateMetrics.
  // Use [\s\S]* to handle nested braces in providerModelIds/aggregateMetrics.
  assert.match(source, /export interface EvaluationArtifact \{[\s\S]*aggregateMetrics:[\s\S]*perCaseStatus: CaseResult\[\][\s\S]*ragas\?: RagasArtifactSection/s)
  // Verify ragas? is NOT inside the aggregateMetrics block (structural separation)
  const artifactMatch = source.match(/export interface EvaluationArtifact \{([\s\S]*?)\n\}/)
  assert.ok(artifactMatch, "EvaluationArtifact interface not found")
  const artifactBody = artifactMatch![1]
  const aggMetricsMatch = artifactBody.match(/aggregateMetrics:\s*\{([\s\S]*?)\n\s*\}/)
  assert.ok(aggMetricsMatch, "aggregateMetrics block not found")
  const aggMetricsBody = aggMetricsMatch![1]
  assert.ok(!aggMetricsBody.includes("ragas"), "ragas must NOT be inside aggregateMetrics block")
  assert.ok(artifactBody.includes("ragas?:"), "ragas must be a top-level field on EvaluationArtifact")
})