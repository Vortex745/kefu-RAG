// Ticket 25 — Add the RAGAS shadow CLI: tests.
//
// Spec issue #25 acceptance criteria:
//   1. Fixed evaluator model identities and run counts produce a reproducible
//      versioned shadow report with variance.
//   2. Missing Python runtime, timeout, malformed output, output overflow,
//      and evaluator failure are explicit bounded outcomes.
//   3. RAGAS execution remains outside the online Answer runtime and cannot
//      change deterministic gate results.
//
// Candidate mode (OP-05 unsatisfied): no real RAGAS / Python evaluator
// installed. Tests inject `pythonExecutable: process.execPath` (Node) and the
// committed fake runner script (`src/evaluation/test-fixtures/ragas-fake-runner.mjs`)
// as the candidate-mode Python substitute — same pattern as
// ragas_evaluator.test.ts. The fake runner dispatches on RAGAS_FAKE_MODE env
// var to simulate every contract path: happy path (ok), timeout, malformed
// output, output overflow, evaluator failure. When OP-05 is lifted, the
// fixture's runnerScript swaps to the real Python RAGAS runner — probe code
// is production code exercised end-to-end.
//
// These tests cover:
//   - AC1: reproducible versioned shadow report with variance (happy path)
//   - AC2: 5 failure modes are explicit bounded outcomes
//   - AC3: RAGAS execution cannot change deterministic hard invariants
//   - Isolation, sanitization, bounded outputs, cancellation propagation

import test from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"

import { ragasShadowCliProbe } from "./ragas_shadow_cli"
import { evaluateHardInvariants } from "../evaluation/hard_invariants"
import type { ProbeContext } from "./smoke_harness"
import type {
  AnswerRunOutputs,
  CaseResult,
  GoldenCase,
  RagasShadowCase,
} from "../evaluation/types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const here = __dirname
const FAKE_RUNNER_PATH = join(here, "..", "evaluation", "test-fixtures", "ragas-fake-runner.mjs")

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

function makeCaseResult(overrides: Partial<CaseResult> = {}): CaseResult {
  return {
    caseId: "simple-01",
    status: "passed",
    terminalStatus: "completed",
    routeDecision: "simple",
    retrievedEvidenceIds: ["ev-refund-01"],
    citationsInAnswer: ["ev-refund-01"],
    durationMs: 100,
    tokenCount: 50,
    ...overrides,
  }
}

function makeBasicFixture() {
  const goldenCase = makeGoldenCase()
  const runOutputs = makeRunOutputs()
  const shadowCase: RagasShadowCase = { goldenCase, runOutputs }
  const caseResult = makeCaseResult()
  return {
    revision: "abc123def456",
    shadowCases: [shadowCase],
    evaluatorModelIdentities: {
      chat: "gpt-4o",
      embedding: "text-embedding-3-small",
      evaluator: "gpt-4o-mini",
    },
    runCount: 3,
    datasetVersion: "v1.0.0",
    goldenCases: [goldenCase],
    caseResults: [caseResult],
    candidateRunnerScript: FAKE_RUNNER_PATH,
  }
}

function makeProbeContext(fixture: unknown): ProbeContext {
  return {
    signal: new AbortController().signal,
    deadlineMs: 60_000,
    fixture,
  }
}

// ---------------------------------------------------------------------------
// AC1: Fixed evaluator model identities and run counts produce a reproducible
//      versioned shadow report with variance.
// ---------------------------------------------------------------------------

test("Ticket 25 #1a: probe returns ok=true with a shadow report", async () => {
  const result = await ragasShadowCliProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true, `probe must succeed; reason: ${result.reason ?? "n/a"}`)
  const outputs = result.outputs ?? {}
  assert.ok(outputs.shadowReport, "shadowReport must be present")
})

test("Ticket 25 #1b: shadow report has baseline with aggregate + variance + runCount + datasetVersion + providerModelIds + revision", async () => {
  const result = await ragasShadowCliProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true, `probe must succeed; reason: ${result.reason ?? "n/a"}`)
  const outputs = result.outputs ?? {}
  const report = outputs.shadowReport as Record<string, unknown>
  assert.ok(report, "shadowReport must be present")
  assert.ok(report.aggregate, "baseline.aggregate must be present")
  assert.ok(report.variance, "baseline.variance must be present")
  assert.equal(report.runCount, 3, "runCount must match fixture")
  assert.equal(report.datasetVersion, "v1.0.0", "datasetVersion must match fixture")
  assert.ok(report.providerModelIds, "providerModelIds must be present")
  assert.equal(report.repositoryRevision, "abc123def456", "repositoryRevision must match fixture")
})

test("Ticket 25 #1c: variance records per-metric min/max/mean/stdDev/sampleSize for all 4 metrics", async () => {
  const result = await ragasShadowCliProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true, `probe must succeed; reason: ${result.reason ?? "n/a"}`)
  const outputs = result.outputs ?? {}
  const report = outputs.shadowReport as Record<string, unknown>
  const variance = report.variance as Record<string, unknown>
  const expectedMetrics = ["faithfulness", "answerRelevancy", "contextPrecision", "contextRecall"]
  for (const metric of expectedMetrics) {
    assert.ok(metric in variance, `variance must include ${metric}`)
    const mv = variance[metric] as Record<string, unknown>
    assert.ok("min" in mv, `${metric}.min must be present`)
    assert.ok("max" in mv, `${metric}.max must be present`)
    assert.ok("mean" in mv, `${metric}.mean must be present`)
    assert.ok("stdDev" in mv, `${metric}.stdDev must be present`)
    assert.ok("sampleSize" in mv, `${metric}.sampleSize must be present`)
    assert.equal(mv.sampleSize, 3, `${metric}.sampleSize must equal runCount`)
  }
})

test("Ticket 25 #1d: shadow report records fixed evaluatorModelIdentities (chat + embedding + evaluator)", async () => {
  const result = await ragasShadowCliProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true, `probe must succeed; reason: ${result.reason ?? "n/a"}`)
  const outputs = result.outputs ?? {}
  const report = outputs.shadowReport as Record<string, unknown>
  const providerModelIds = report.providerModelIds as Record<string, string>
  assert.equal(providerModelIds.chat, "gpt-4o")
  assert.equal(providerModelIds.embedding, "text-embedding-3-small")
  assert.equal(providerModelIds.evaluator, "gpt-4o-mini")
})

test("Ticket 25 #1e: same config produces same baseline shape (reproducibility)", async () => {
  const fixture = makeBasicFixture()
  const result1 = await ragasShadowCliProbe(makeProbeContext(fixture))
  const result2 = await ragasShadowCliProbe(makeProbeContext(fixture))
  assert.equal(result1.ok, true)
  assert.equal(result2.ok, true)
  const report1 = (result1.outputs ?? {}).shadowReport as Record<string, unknown>
  const report2 = (result2.outputs ?? {}).shadowReport as Record<string, unknown>
  assert.equal(report1.runCount, report2.runCount, "runCount must be reproducible")
  assert.equal(report1.datasetVersion, report2.datasetVersion, "datasetVersion must be reproducible")
  assert.deepEqual(report1.providerModelIds, report2.providerModelIds, "providerModelIds must be reproducible")
  assert.equal(report1.repositoryRevision, report2.repositoryRevision, "revision must be reproducible")
})

// ---------------------------------------------------------------------------
// AC2: Missing Python runtime, timeout, malformed output, output overflow,
//      and evaluator failure are explicit bounded outcomes.
// ---------------------------------------------------------------------------

test("Ticket 25 #2a: all 5 failure modes are explicit and recorded", async () => {
  const result = await ragasShadowCliProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true, `probe must succeed; reason: ${result.reason ?? "n/a"}`)
  const outputs = result.outputs ?? {}
  const failureModes = outputs.failureModes as Record<string, string>
  const expectedModes = ["missingRuntime", "timeout", "malformed", "outputOverflow", "evaluatorFailure"]
  for (const mode of expectedModes) {
    assert.ok(mode in failureModes, `failureModes must include ${mode}`)
    assert.equal(
      failureModes[mode],
      "passed",
      `${mode} must produce explicit failure (status="passed" means failure was observed and explicit)`,
    )
  }
})

test("Ticket 25 #2b: failure errors are bounded strings (<= 512 chars)", async () => {
  const result = await ragasShadowCliProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true, `probe must succeed; reason: ${result.reason ?? "n/a"}`)
  const outputs = result.outputs ?? {}
  const failureErrors = outputs.failureErrors as Record<string, string>
  const expectedModes = ["missingRuntime", "timeout", "malformed", "outputOverflow", "evaluatorFailure"]
  for (const mode of expectedModes) {
    assert.ok(mode in failureErrors, `failureErrors must include ${mode}`)
    assert.ok(failureErrors[mode].length > 0, `${mode} error must be non-empty`)
    assert.ok(failureErrors[mode].length <= 512, `${mode} error must be bounded <= 512 chars`)
  }
})

test("Ticket 25 #2c: missingRuntime failure mentions unavailable or not found", async () => {
  const result = await ragasShadowCliProbe(makeProbeContext(makeBasicFixture()))
  const failureErrors = (result.outputs ?? {}).failureErrors as Record<string, string>
  assert.match(failureErrors.missingRuntime, /unavailable|ENOENT|not found|no such file/i)
})

test("Ticket 25 #2d: timeout failure mentions timeout", async () => {
  const result = await ragasShadowCliProbe(makeProbeContext(makeBasicFixture()))
  const failureErrors = (result.outputs ?? {}).failureErrors as Record<string, string>
  assert.match(failureErrors.timeout, /timed out|timeout|timeoutMs/i)
})

test("Ticket 25 #2e: malformed failure mentions malformed or invalid", async () => {
  const result = await ragasShadowCliProbe(makeProbeContext(makeBasicFixture()))
  const failureErrors = (result.outputs ?? {}).failureErrors as Record<string, string>
  assert.match(failureErrors.malformed, /malformed|invalid|parse|json/i)
})

test("Ticket 25 #2f: outputOverflow failure mentions exceeded or overflow or limit", async () => {
  const result = await ragasShadowCliProbe(makeProbeContext(makeBasicFixture()))
  const failureErrors = (result.outputs ?? {}).failureErrors as Record<string, string>
  assert.match(failureErrors.outputOverflow, /exceed|overflow|limit|quota/i)
})

test("Ticket 25 #2g: evaluatorFailure failure mentions failure or exit or non-zero", async () => {
  const result = await ragasShadowCliProbe(makeProbeContext(makeBasicFixture()))
  const failureErrors = (result.outputs ?? {}).failureErrors as Record<string, string>
  assert.match(failureErrors.evaluatorFailure, /failure|exit|non-zero|crash/i)
})

// ---------------------------------------------------------------------------
// AC3: RAGAS execution remains outside the online Answer runtime and cannot
//      change deterministic gate results.
// ---------------------------------------------------------------------------

test("Ticket 25 #3a: probe outputs include hardInvariantsBefore and hardInvariantsAfter arrays", async () => {
  const result = await ragasShadowCliProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true, `probe must succeed; reason: ${result.reason ?? "n/a"}`)
  const outputs = result.outputs ?? {}
  assert.ok(Array.isArray(outputs.hardInvariantsBefore), "hardInvariantsBefore must be an array")
  assert.ok(Array.isArray(outputs.hardInvariantsAfter), "hardInvariantsAfter must be an array")
  assert.ok(
    (outputs.hardInvariantsBefore as unknown[]).length > 0,
    "hardInvariantsBefore must be non-empty (8 invariants)",
  )
  assert.equal(
    (outputs.hardInvariantsBefore as unknown[]).length,
    (outputs.hardInvariantsAfter as unknown[]).length,
    "hardInvariantsBefore and hardInvariantsAfter must have same length",
  )
})

test("Ticket 25 #3b: hardInvariantsBefore and hardInvariantsAfter are deepEqual (RAGAS cannot change deterministic gates)", async () => {
  const result = await ragasShadowCliProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true, `probe must succeed; reason: ${result.reason ?? "n/a"}`)
  const outputs = result.outputs ?? {}
  const before = outputs.hardInvariantsBefore as Array<{ key: string; passed: boolean }>
  const after = outputs.hardInvariantsAfter as Array<{ key: string; passed: boolean }>
  assert.deepEqual(after, before, "RAGAS execution must not change deterministic hard invariants")
})

test("Ticket 25 #3c: probe outputs include isolationProof=true", async () => {
  const result = await ragasShadowCliProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true, `probe must succeed; reason: ${result.reason ?? "n/a"}`)
  const outputs = result.outputs ?? {}
  assert.equal(outputs.isolationProof, true, "isolationProof must be true when hard invariants are unchanged")
})

test("Ticket 25 #3d: probe independently verifies hard invariants match evaluateHardInvariants output", async () => {
  const fixtureData = makeBasicFixture()
  const result = await ragasShadowCliProbe(makeProbeContext(fixtureData))
  assert.equal(result.ok, true, `probe must succeed; reason: ${result.reason ?? "n/a"}`)
  const outputs = result.outputs ?? {}
  const before = outputs.hardInvariantsBefore as Array<{ key: string; passed: boolean }>
  // Independently compute hard invariants and verify they match the probe's output
  const expected = evaluateHardInvariants(fixtureData.goldenCases, fixtureData.caseResults)
  assert.equal(before.length, expected.length, "probe must record all 8 hard invariants")
  assert.deepEqual(
    before.map((r) => ({ key: r.key, passed: r.passed })),
    expected.map((r) => ({ key: r.key, passed: r.passed })),
    "probe's hardInvariantsBefore must match independent evaluateHardInvariants computation",
  )
})

// ---------------------------------------------------------------------------
// Bounded outputs + sanitization
// ---------------------------------------------------------------------------

test("Ticket 25 #4: probe returns durationMs", async () => {
  const result = await ragasShadowCliProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true, `probe must succeed; reason: ${result.reason ?? "n/a"}`)
  assert.equal(typeof result.durationMs, "number")
  assert.ok(result.durationMs >= 0)
})

test("Ticket 25 #5a: probe fails when fixture is missing", async () => {
  const result = await ragasShadowCliProbe(makeProbeContext(undefined))
  assert.equal(result.ok, false)
  assert.match(result.reason ?? "", /missing fixture/i)
})

test("Ticket 25 #5b: probe fails when revision is missing", async () => {
  const fixture = makeBasicFixture()
  fixture.revision = ""
  const result = await ragasShadowCliProbe(makeProbeContext(fixture))
  assert.equal(result.ok, false)
  assert.match(result.reason ?? "", /revision/i)
})

test("Ticket 25 #5c: probe fails when shadowCases is empty", async () => {
  const fixture = makeBasicFixture()
  fixture.shadowCases = []
  const result = await ragasShadowCliProbe(makeProbeContext(fixture))
  assert.equal(result.ok, false)
  assert.match(result.reason ?? "", /shadowCases/i)
})

test("Ticket 25 #6: outputs contain no prompts, answers, tokens, or credentials", async () => {
  const result = await ragasShadowCliProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true, `probe must succeed; reason: ${result.reason ?? "n/a"}`)
  const serialized = JSON.stringify(result.outputs ?? {})
  // Sanitization: no raw prompts, answers, tokens, credentials
  assert.ok(!serialized.includes("Refunds are available"), "outputs must not contain reference answer text")
  assert.ok(!serialized.includes("You can request a refund"), "outputs must not contain approved answer text")
  assert.ok(!serialized.includes("Refund policy: 30-day"), "outputs must not contain retrieved context text")
  assert.ok(!serialized.toLowerCase().includes("apikey"), "outputs must not contain apiKey")
  assert.ok(!serialized.toLowerCase().includes("authorization"), "outputs must not contain authorization")
  assert.ok(!serialized.toLowerCase().includes("bearer"), "outputs must not contain Bearer")
  assert.ok(!serialized.toLowerCase().includes("sk-"), "outputs must not contain API key prefixes (sk-)")
})

test("Ticket 25 #7: outputs carry bounded metadata only (no raw metrics arrays, no case-level payloads)", async () => {
  const result = await ragasShadowCliProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true, `probe must succeed; reason: ${result.reason ?? "n/a"}`)
  const outputs = result.outputs ?? {}
  // Safe metadata fields
  assert.ok("shadowReport" in outputs, "shadowReport must be present")
  assert.ok("failureModes" in outputs, "failureModes must be present")
  assert.ok("failureErrors" in outputs, "failureErrors must be present")
  assert.ok("hardInvariantsBefore" in outputs, "hardInvariantsBefore must be present")
  assert.ok("hardInvariantsAfter" in outputs, "hardInvariantsAfter must be present")
  assert.ok("isolationProof" in outputs, "isolationProof must be present")
  assert.ok("revision" in outputs, "revision must be present")
  assert.ok("runCount" in outputs, "runCount must be present")
})

test("Ticket 25 #8: probe handles pre-aborted signal gracefully", async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await ragasShadowCliProbe({
    signal: controller.signal,
    deadlineMs: 60_000,
    fixture: makeBasicFixture(),
  })
  assert.equal(result.ok, false)
  assert.match(result.reason ?? "", /abort/i)
})

// ---------------------------------------------------------------------------
// Candidate-mode specifics
// ---------------------------------------------------------------------------

test("Ticket 25 #9: probe records candidateMode=true when using fake runner (OP-05 unsatisfied)", async () => {
  const result = await ragasShadowCliProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true, `probe must succeed; reason: ${result.reason ?? "n/a"}`)
  const outputs = result.outputs ?? {}
  assert.equal(outputs.candidateMode, true, "probe must record candidateMode=true when using fake runner")
})

test("Ticket 25 #10: custom fixture revision produces different shadow report revision", async () => {
  const fixture1 = makeBasicFixture()
  const fixture2 = makeBasicFixture()
  fixture2.revision = "xyz987654321"
  const result1 = await ragasShadowCliProbe(makeProbeContext(fixture1))
  const result2 = await ragasShadowCliProbe(makeProbeContext(fixture2))
  assert.equal(result1.ok, true)
  assert.equal(result2.ok, true)
  const report1 = (result1.outputs ?? {}).shadowReport as Record<string, unknown>
  const report2 = (result2.outputs ?? {}).shadowReport as Record<string, unknown>
  assert.notEqual(report1.repositoryRevision, report2.repositoryRevision, "revisions must differ")
  assert.equal(report2.repositoryRevision, "xyz987654321")
})

// ---------------------------------------------------------------------------
// Error-path correctness (code-review findings)
// ---------------------------------------------------------------------------

test("Ticket 25 #11: shadow-profile failure path sets isolationProof=false (proof was not performed)", async () => {
  // Trigger shadow-profile failure: runCount=0 makes runRagasShadowProfile
  // return status="failed" with reason "runCount must be >= 1". This reaches
  // the error path where the probe returns early WITHOUT computing
  // hardInvariantsAfter. isolationProof must be false (proof not performed),
  // and hardInvariantsAfter must NOT alias hardInvariantsBefore.
  const fixture = makeBasicFixture()
  fixture.runCount = 0
  const result = await ragasShadowCliProbe(makeProbeContext(fixture))
  assert.equal(result.ok, false, "probe must fail when runCount=0")
  const outputs = result.outputs ?? {}
  assert.equal(
    outputs.isolationProof,
    false,
    "isolationProof must be false when RAGAS did not complete — proof was not performed (not vacuously true)",
  )
  // hardInvariantsAfter must NOT alias hardInvariantsBefore in error paths.
  // If they were the same reference, reviewers couldn't distinguish "computed
  // and matched" from "never computed". Use undefined to signal "not computed".
  assert.equal(
    outputs.hardInvariantsAfter,
    undefined,
    "hardInvariantsAfter must be undefined (not aliased to hardInvariantsBefore) when after-RAGAS computation never ran",
  )
  // hardInvariantsBefore should still be present (computed before shadow profile)
  assert.ok(
    Array.isArray(outputs.hardInvariantsBefore),
    "hardInvariantsBefore must still be present (computed before shadow profile execution)",
  )
})

test("Ticket 25 #12: shadow-profile failure path does not claim shadowReport present", async () => {
  // Same trigger as #11 — verifies the error path returns shadowReport=null
  // rather than leaking a partial/bogus baseline.
  const fixture = makeBasicFixture()
  fixture.runCount = 0
  const result = await ragasShadowCliProbe(makeProbeContext(fixture))
  assert.equal(result.ok, false)
  const outputs = result.outputs ?? {}
  assert.equal(outputs.shadowReport, null, "shadowReport must be null when shadow profile failed")
  assert.equal(outputs.candidateMode, true, "candidateMode must still be recorded in error paths")
})
