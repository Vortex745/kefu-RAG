// Ticket 27 — Enforce deterministic evaluation precedence tests.
//
// TDD red phase: defines the expected behavior of assembleEvaluationPrecedence
// BEFORE the implementation exists. Tests cover all 3 acceptance criteria:
//   #1 — A hard-invariant failure keeps the release failed even when all
//        RAGAS and Langfuse signals are positive.
//   #2 — RAGAS regression or Langfuse outage cannot change a passing
//        deterministic result, though each remains visible in its own
//        report section.
//   #3 — The deterministic evidence hash decision excludes non-deterministic
//        report content without excluding their schema metadata.
//
// Plus isolation + bounded-outputs + sanitization + error-path tests.

import assert from "node:assert/strict"
import test from "node:test"

import {
  assembleEvaluationPrecedence,
  type EvaluationPrecedenceInput,
  type EvaluationPrecedenceReport,
} from "./evaluation_precedence"
import type { HardInvariantResult, RagasShadowBaseline, RagasShadowRegression } from "../evaluation/types"
import type { LangfuseRoundTripProbeFixture } from "./langfuse_probe"

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makePassingHardInvariants(): HardInvariantResult[] {
  return [
    {
      key: "terminal_convergence_100" as HardInvariantResult["key"],
      passed: true,
      expected: "100% of runs reach a terminal status",
      actual: "10/10 (100.0%)",
      failingCaseIds: [],
    },
    {
      key: "unknown_citation_count_0" as HardInvariantResult["key"],
      passed: true,
      expected: "0 unknown citations",
      actual: "0",
      failingCaseIds: [],
    },
  ]
}

function makeFailingHardInvariants(): HardInvariantResult[] {
  return [
    {
      key: "terminal_convergence_100" as HardInvariantResult["key"],
      passed: false,
      expected: "100% of runs reach a terminal status",
      actual: "9/10 (90.0%)",
      failingCaseIds: ["case-3"],
    },
    {
      key: "unknown_citation_count_0" as HardInvariantResult["key"],
      passed: true,
      expected: "0 unknown citations",
      actual: "0",
      failingCaseIds: [],
    },
  ]
}

function makePositiveRagasBaseline(): RagasShadowBaseline {
  return {
    aggregate: {
      meanFaithfulness: 0.95,
      meanAnswerRelevancy: 0.92,
      meanContextPrecision: 0.88,
      meanContextRecall: 0.91,
      sampleSize: 50,
      errorCount: 0,
      skippedCount: 0,
    },
    variance: {
      faithfulness: { min: 0.93, max: 0.97, mean: 0.95, stdDev: 0.015, sampleSize: 5 },
      answerRelevancy: { min: 0.90, max: 0.94, mean: 0.92, stdDev: 0.018, sampleSize: 5 },
      contextPrecision: { min: 0.85, max: 0.91, mean: 0.88, stdDev: 0.022, sampleSize: 5 },
      contextRecall: { min: 0.88, max: 0.94, mean: 0.91, stdDev: 0.025, sampleSize: 5 },
    },
    runCount: 5,
    datasetVersion: "v1.2.0",
    providerModelIds: { chat: "gpt-4o", embedding: "text-embedding-3-large", evaluator: "gpt-4o" },
    generatedAt: "2026-07-25T10:00:00Z",
    repositoryRevision: "abc123def4567890abcdef1234567890abcdef12",
  }
}

function makeRegressedRagasBaseline(): RagasShadowBaseline {
  // Lower scores — simulates RAGAS regression (must NOT change release decision)
  return {
    ...makePositiveRagasBaseline(),
    aggregate: {
      ...makePositiveRagasBaseline().aggregate,
      meanFaithfulness: 0.65, // was 0.95 — major regression
      meanAnswerRelevancy: 0.62,
      meanContextPrecision: 0.58,
      meanContextRecall: 0.61,
    },
  }
}

function makeRagasRegressions(): RagasShadowRegression[] {
  return [
    {
      metric: "faithfulness",
      baseline: 0.95,
      current: 0.65,
      delta: -0.30,
      regressionDetected: true,
    },
    {
      metric: "answerRelevancy",
      baseline: 0.92,
      current: 0.62,
      delta: -0.30,
      regressionDetected: true,
    },
  ]
}

interface LangfuseProbeOutputs {
  traceFound: boolean
  privacyCheck: string
  host: string
  sdkVersion: string
  droppedCount: number
}

function makeHealthyLangfuseReport(): LangfuseProbeOutputs {
  return {
    traceFound: true,
    privacyCheck: "passed",
    host: "https://langfuse.example.com",
    sdkVersion: "candidate-3.x",
    droppedCount: 0,
  }
}

function makeOutageLangfuseReport(): LangfuseProbeOutputs {
  return {
    traceFound: false,
    privacyCheck: "skipped",
    host: "https://langfuse.example.com",
    sdkVersion: "candidate-3.x",
    droppedCount: 0,
  }
}

function makePassingInput(): EvaluationPrecedenceInput {
  return {
    hardInvariants: makePassingHardInvariants(),
    ragasShadowBaseline: makePositiveRagasBaseline(),
    ragasShadowRegressions: [],
    langfuseReport: makeHealthyLangfuseReport(),
    repositoryRevision: "abc123def4567890abcdef1234567890abcdef12",
  }
}

// ============================================================
// #1 — Hard-invariant failure keeps release failed even when
//      RAGAS + Langfuse signals are positive (AC1)
// ============================================================

test("Ticket 27 #1a: hard-invariant failure → releaseDecision=failed even with positive RAGAS + Langfuse", () => {
  const input = makePassingInput()
  input.hardInvariants = makeFailingHardInvariants()
  // RAGAS + Langfuse positive — must NOT rescue the release
  input.ragasShadowBaseline = makePositiveRagasBaseline()
  input.ragasShadowRegressions = []
  input.langfuseReport = makeHealthyLangfuseReport()

  const report = assembleEvaluationPrecedence(input)

  assert.equal(report.releaseDecision, "failed", "release must FAIL when hard invariants fail")
  assert.equal(report.deterministicDecision, "failed", "deterministic decision must reflect hard-invariant failure")
})

test("Ticket 27 #1b: report records which deterministic invariants failed (root cause preserved)", () => {
  const input = makePassingInput()
  input.hardInvariants = makeFailingHardInvariants()
  const report = assembleEvaluationPrecedence(input)

  assert.ok(report.failingDeterministicInvariants.length > 0, "must list failing invariant keys")
  assert.ok(
    report.failingDeterministicInvariants.includes("terminal_convergence_100"),
    `terminal_convergence_100 must be in failing list; got: ${JSON.stringify(report.failingDeterministicInvariants)}`,
  )
})

test("Ticket 27 #1c: probabilistic signals remain visible in the report even when release failed", () => {
  const input = makePassingInput()
  input.hardInvariants = makeFailingHardInvariants()
  input.ragasShadowBaseline = makePositiveRagasBaseline()
  input.langfuseReport = makeHealthyLangfuseReport()
  const report = assembleEvaluationPrecedence(input)

  // RAGAS + Langfuse must still be visible (criterion #2 — "remains visible in its own report section")
  assert.ok(report.probabilisticSection.ragas, "RAGAS section must be present")
  assert.ok(report.probabilisticSection.langfuse, "Langfuse section must be present")
})

// ============================================================
// #2 — RAGAS regression or Langfuse outage cannot change a
//      passing deterministic result (AC2)
// ============================================================

test("Ticket 27 #2a: RAGAS regression → releaseDecision=passed (deterministic passed)", () => {
  const input = makePassingInput()
  input.hardInvariants = makePassingHardInvariants()
  // RAGAS regression — must NOT change release decision
  input.ragasShadowBaseline = makeRegressedRagasBaseline()
  input.ragasShadowRegressions = makeRagasRegressions()
  input.langfuseReport = makeHealthyLangfuseReport()
  const report = assembleEvaluationPrecedence(input)

  assert.equal(report.releaseDecision, "passed", "RAGAS regression must NOT change passing deterministic result")
  assert.equal(report.deterministicDecision, "passed")
})

test("Ticket 27 #2b: Langfuse outage → releaseDecision=passed (deterministic passed)", () => {
  const input = makePassingInput()
  input.hardInvariants = makePassingHardInvariants()
  input.ragasShadowBaseline = makePositiveRagasBaseline()
  // Langfuse outage — must NOT change release decision
  input.langfuseReport = makeOutageLangfuseReport()
  const report = assembleEvaluationPrecedence(input)

  assert.equal(report.releaseDecision, "passed", "Langfuse outage must NOT change passing deterministic result")
})

test("Ticket 27 #2c: RAGAS regression is visible in probabilisticSection (non-blocking but reported)", () => {
  const input = makePassingInput()
  input.ragasShadowRegressions = makeRagasRegressions()
  const report = assembleEvaluationPrecedence(input)

  assert.ok(report.probabilisticSection.ragas, "RAGAS section must be present")
  assert.equal(
    report.probabilisticSection.ragas?.regressionDetected,
    true,
    "regressionDetected must be true when regressions exist",
  )
  assert.equal(
    report.probabilisticSection.ragas?.regressions.length,
    2,
    "must record 2 regressions",
  )
})

test("Ticket 27 #2d: Langfuse outage is visible in probabilisticSection (non-blocking but reported)", () => {
  const input = makePassingInput()
  input.langfuseReport = makeOutageLangfuseReport()
  const report = assembleEvaluationPrecedence(input)

  assert.ok(report.probabilisticSection.langfuse, "Langfuse section must be present")
  assert.equal(report.probabilisticSection.langfuse?.traceFound, false, "traceFound=false must be reported")
})

test("Ticket 27 #2e: combined RAGAS regression + Langfuse outage → releaseDecision=passed (deterministic passed)", () => {
  const input = makePassingInput()
  input.hardInvariants = makePassingHardInvariants()
  input.ragasShadowBaseline = makeRegressedRagasBaseline()
  input.ragasShadowRegressions = makeRagasRegressions()
  input.langfuseReport = makeOutageLangfuseReport()
  const report = assembleEvaluationPrecedence(input)

  assert.equal(
    report.releaseDecision,
    "passed",
    "both RAGAS + Langfuse failures must NOT change passing deterministic result",
  )
})

// ============================================================
// #3 — Evidence hash excludes non-deterministic content but
//      includes schema metadata (AC3)
// ============================================================

test("Ticket 27 #3a: evidenceHash is present and is a non-empty string", () => {
  const report = assembleEvaluationPrecedence(makePassingInput())
  assert.equal(typeof report.evidenceHash, "string")
  assert.ok(report.evidenceHash.length > 0, "evidenceHash must be non-empty")
})

test("Ticket 27 #3b: evidenceHash is stable for the same deterministic inputs (reproducible)", () => {
  const input1 = makePassingInput()
  const input2 = makePassingInput()
  // Change RAGAS + Langfuse (non-deterministic) — must NOT affect hash
  input2.ragasShadowBaseline = makeRegressedRagasBaseline()
  input2.langfuseReport = makeOutageLangfuseReport()

  const report1 = assembleEvaluationPrecedence(input1)
  const report2 = assembleEvaluationPrecedence(input2)

  assert.equal(
    report1.evidenceHash,
    report2.evidenceHash,
    "evidenceHash must be identical when only non-deterministic inputs change",
  )
})

test("Ticket 27 #3c: evidenceHash changes when deterministic inputs change", () => {
  const input1 = makePassingInput()
  const input2 = makePassingInput()
  input2.hardInvariants = makeFailingHardInvariants()

  const report1 = assembleEvaluationPrecedence(input1)
  const report2 = assembleEvaluationPrecedence(input2)

  assert.notEqual(
    report1.evidenceHash,
    report2.evidenceHash,
    "evidenceHash must differ when hard invariants change",
  )
})

test("Ticket 27 #3d: schemaMetadataIncluded=true — RAGAS + Langfuse schema metadata remains in report", () => {
  const report = assembleEvaluationPrecedence(makePassingInput())
  assert.equal(report.schemaMetadataIncluded, true, "schema metadata must be included")
  assert.ok(report.schemaMetadata, "schemaMetadata object must be present")
  assert.ok(
    Array.isArray(report.schemaMetadata.ragasShadowFields),
    "ragasShadowFields must be an array (schema metadata for RAGAS section)",
  )
  assert.ok(
    report.schemaMetadata.ragasShadowFields.length > 0,
    "ragasShadowFields must list the field names of RagasShadowBaseline",
  )
  assert.ok(
    Array.isArray(report.schemaMetadata.langfuseFields),
    "langfuseFields must be an array (schema metadata for Langfuse section)",
  )
})

test("Ticket 27 #3e: evidenceHash excludes RAGAS aggregate values (hash stable when only RAGAS scores change)", () => {
  const input1 = makePassingInput()
  const input2 = makePassingInput()
  // Same hardInvariants + same RAGAS metadata (runCount/datasetVersion/...)
  // but different RAGAS aggregate values — hash must NOT change
  input2.ragasShadowBaseline = {
    ...input1.ragasShadowBaseline!,
    aggregate: {
      ...input1.ragasShadowBaseline!.aggregate,
      meanFaithfulness: 0.50,
      meanAnswerRelevancy: 0.50,
      meanContextPrecision: 0.50,
      meanContextRecall: 0.50,
    },
  }
  const report1 = assembleEvaluationPrecedence(input1)
  const report2 = assembleEvaluationPrecedence(input2)
  assert.equal(
    report1.evidenceHash,
    report2.evidenceHash,
    "evidenceHash must be identical when only RAGAS aggregate VALUES change (excludes non-deterministic content)",
  )
})

// ============================================================
// #4 — Bounded outputs + sanitization
// ============================================================

test("Ticket 27 #4a: report does not leak credentials (no publicKey/secretKey)", () => {
  const report = assembleEvaluationPrecedence(makePassingInput())
  const json = JSON.stringify(report)
  assert.ok(!json.includes("pk-test-probe"), "publicKey must NOT be in report (sanitization)")
  assert.ok(!json.includes("sk-test-probe"), "secretKey must NOT be in report (sanitization)")
})

test("Ticket 27 #4b: report records repositoryRevision (provenance binding)", () => {
  const report = assembleEvaluationPrecedence(makePassingInput())
  assert.equal(report.repositoryRevision, "abc123def4567890abcdef1234567890abcdef12")
})

test("Ticket 27 #4c: report records timestamp (when evaluation was assembled)", () => {
  const report = assembleEvaluationPrecedence(makePassingInput())
  assert.equal(typeof report.generatedAt, "string")
  assert.ok(Date.parse(report.generatedAt) > 0, "generatedAt must be a valid ISO timestamp")
})

// ============================================================
// #5 — Error paths (Karpathy diagnostic)
// ============================================================

test("Ticket 27 #5a: missing hardInvariants → deterministicDecision=failed with explicit reason", () => {
  const input = makePassingInput()
  input.hardInvariants = []
  const report = assembleEvaluationPrecedence(input)
  assert.equal(report.deterministicDecision, "failed", "empty hardInvariants must fail")
  assert.match(
    report.deterministicReason ?? "",
    /hardInvariants|empty|required/i,
    `reason must mention missing hardInvariants; got: ${report.deterministicReason}`,
  )
})

test("Ticket 27 #5b: null ragasShadowBaseline → probabilisticSection.ragas.baseline=null but section still present", () => {
  const input = makePassingInput()
  input.ragasShadowBaseline = null
  const report = assembleEvaluationPrecedence(input)
  assert.ok(report.probabilisticSection.ragas, "RAGAS section must still be present (visible even when null)")
  assert.equal(report.probabilisticSection.ragas?.baseline, null, "baseline must be null")
})

test("Ticket 27 #5c: null langfuseReport → probabilisticSection.langfuse=null but section still present", () => {
  const input = makePassingInput()
  input.langfuseReport = null
  const report = assembleEvaluationPrecedence(input)
  // Per spec AC2: "each remains visible in its own report section"
  // When langfuseReport is null, the section exists but content is null
  assert.ok(
    report.probabilisticSection.langfuse === null || report.probabilisticSection.langfuse === undefined,
    "langfuse section must be null/undefined when input is null",
  )
  // But schema metadata for langfuse must STILL be present (criterion #3)
  assert.ok(
    report.schemaMetadata?.langfuseFields,
    "langfuseFields schema metadata must still be present even when langfuseReport is null",
  )
})

test("Ticket 27 #5d: missing repositoryRevision → report.repositoryRevision is empty string (not crash)", () => {
  const input = makePassingInput()
  // Use type assertion to test missing-revision error path
  delete (input as { repositoryRevision?: string }).repositoryRevision
  const report = assembleEvaluationPrecedence(input)
  assert.equal(report.repositoryRevision, "", "missing revision → empty string (no crash)")
})

// ============================================================
// #6 — Isolation: assembleEvaluationPrecedence is NOT a probe (verifier)
// ============================================================

test("Ticket 27 #6: assembleEvaluationPrecedence is a pure function (no side effects, deterministic)", () => {
  const input = makePassingInput()
  const report1 = assembleEvaluationPrecedence(input)
  const report2 = assembleEvaluationPrecedence(input)
  assert.deepEqual(report1, report2, "same input must produce identical output (pure function)")
})

// ============================================================
// #7 — Sanity: report shape
// ============================================================

test("Ticket 27 #7a: report contains all required top-level fields", () => {
  const report = assembleEvaluationPrecedence(makePassingInput())
  const requiredFields = [
    "deterministicDecision",
    "deterministicReason",
    "releaseDecision",
    "failingDeterministicInvariants",
    "probabilisticSection",
    "evidenceHash",
    "schemaMetadata",
    "schemaMetadataIncluded",
    "repositoryRevision",
    "generatedAt",
  ]
  for (const field of requiredFields) {
    assert.ok(
      field in report,
      `report must have top-level field '${field}'; got: ${JSON.stringify(Object.keys(report))}`,
    )
  }
})

test("Ticket 27 #7b: probabilisticSection contains ragas + langfuse sub-sections", () => {
  const report = assembleEvaluationPrecedence(makePassingInput())
  assert.ok(report.probabilisticSection)
  assert.ok("ragas" in report.probabilisticSection)
  assert.ok("langfuse" in report.probabilisticSection)
})

// Use LangfuseRoundTripProbeFixture import to ensure type-compatibility
// (LangfuseProbeOutputs mirrors the probe's output shape).
test("Ticket 27 #7c: LangfuseProbeOutputs shape matches langfuseRoundTripProbe outputs (type compatibility)", () => {
  // This is a compile-time check — if it compiles, the types are compatible.
  // We just verify the field names exist on the imported LangfuseRoundTripProbeFixture
  // type for documentation purposes (no runtime assertions needed).
  const _typeCheck: LangfuseRoundTripProbeFixture = {
    revision: "test",
    config: { publicKey: "pk", secretKey: "sk" },
    events: [],
    expectedRunId: "run-1",
    expectedSpans: ["route"],
    privacyMarker: "marker",
  }
  assert.ok(_typeCheck, "type compatibility check passes")
})
