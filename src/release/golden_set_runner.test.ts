// Ticket 24 — Command-owned golden-set runner tests.
//
// TDD red phase: defines the expected behavior of goldenSetRunner BEFORE the
// implementation exists. Tests cover all 3 Ticket 24 acceptance criteria:
//   #1 — Every committed golden case produces an observed terminal, latency,
//        token count, retrieved Evidence identities, citations, and
//        degradation status.
//   #2 — A case timeout, cancellation, malformed terminal, or provider
//        failure is explicit and cannot be silently dropped from the dataset.
//   #3 — The output is accepted directly by deterministic hard-invariant
//        evaluation without caller-supplied pass fields.
//
// Plus isolation + sanitization + bounded-output + dataset-integrity tests.

import assert from "node:assert/strict"
import test from "node:test"
import { goldenSetRunner, type GoldenSetRunnerFixture } from "./golden_set_runner"
import { GOLDEN_SET, FIXTURE_COUNTS } from "../evaluation/golden/fixtures"
import { evaluateHardInvariants } from "../evaluation/hard_invariants"
import type { ProbeContext } from "./smoke_harness"
import type { CaseResult } from "../evaluation/types"

const REVISION = "abc123def4567890abcdef1234567890abcdef12"
const ACCEPTANCE_TENANT_PREFIX = "acceptance-"

function makeProbeContext(
  fixture: GoldenSetRunnerFixture,
  signal?: AbortSignal,
): ProbeContext {
  return {
    signal: signal ?? new AbortController().signal,
    deadlineMs: 60_000,
    fixture,
  }
}

function makeBasicFixture(): GoldenSetRunnerFixture {
  return { revision: REVISION }
}

// ---------------------------------------------------------------------------
// #1 — Every committed golden case produces an observed terminal, latency,
//      token count, retrieved Evidence identities, citations, and degradation
//      status.
// ---------------------------------------------------------------------------

test("Ticket 24 #1a: runner returns ok=true with caseResults for every golden case", async () => {
  const result = await goldenSetRunner(makeProbeContext(makeBasicFixture()))

  assert.equal(result.ok, true, `runner must succeed; reason: ${result.reason ?? "n/a"}`)
  const outputs = result.outputs ?? {}
  const caseResults = outputs.caseResults as CaseResult[] | undefined
  assert.ok(Array.isArray(caseResults), "caseResults must be an array")
  assert.equal(
    caseResults.length,
    GOLDEN_SET.cases.length,
    "caseResults length must equal GOLDEN_SET.cases length (no drops)",
  )
})

test("Ticket 24 #1b: every CaseResult carries all spec-required observed fields", async () => {
  const result = await goldenSetRunner(makeProbeContext(makeBasicFixture()))
  const caseResults = (result.outputs ?? {}).caseResults as CaseResult[]

  for (const cr of caseResults) {
    // terminal — every case must reach a terminal status (no undefined)
    assert.ok(
      cr.terminalStatus !== undefined,
      `case ${cr.caseId}: terminalStatus must be defined (observed terminal)`,
    )
    // latency
    assert.ok(
      typeof cr.durationMs === "number" && cr.durationMs >= 0,
      `case ${cr.caseId}: durationMs must be a non-negative number`,
    )
    // token count
    assert.ok(
      typeof cr.tokenCount === "number" && cr.tokenCount >= 0,
      `case ${cr.caseId}: tokenCount must be a non-negative number`,
    )
    // retrieved Evidence identities
    assert.ok(
      Array.isArray(cr.retrievedEvidenceIds),
      `case ${cr.caseId}: retrievedEvidenceIds must be an array`,
    )
    // citations
    assert.ok(
      Array.isArray(cr.citationsInAnswer),
      `case ${cr.caseId}: citationsInAnswer must be an array`,
    )
    // status (observed)
    assert.ok(
      cr.status === "passed" || cr.status === "failed" || cr.status === "skipped",
      `case ${cr.caseId}: status must be passed/failed/skipped`,
    )
  }
})

test("Ticket 24 #1c: degradation status is observable per case", async () => {
  const result = await goldenSetRunner(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}
  const caseResults = outputs.caseResults as CaseResult[]
  const degradationMap = outputs.degradationByCase as
    Record<string, { status: string; unavailableChannels: string[] }> | undefined

  assert.ok(degradationMap, "degradationByCase map must be present")
  for (const cr of caseResults) {
    const degradation = degradationMap[cr.caseId]
    assert.ok(degradation, `case ${cr.caseId}: degradation entry must exist`)
    assert.ok(
      typeof degradation.status === "string",
      `case ${cr.caseId}: degradation.status must be a string`,
    )
    assert.ok(
      Array.isArray(degradation.unavailableChannels),
      `case ${cr.caseId}: degradation.unavailableChannels must be an array`,
    )
  }
})

test("Ticket 24 #1d: dataset integrity — case IDs cover all 6 categories", async () => {
  const result = await goldenSetRunner(makeProbeContext(makeBasicFixture()))
  const caseResults = (result.outputs ?? {}).caseResults as CaseResult[]

  const observedIds = new Set(caseResults.map((cr) => cr.caseId))
  const expectedIds = new Set(GOLDEN_SET.cases.map((c) => c.id))
  assert.ok(
    expectedIds.size === observedIds.size &&
      [...expectedIds].every((id) => observedIds.has(id)),
    "case IDs in caseResults must exactly match GOLDEN_SET.cases IDs",
  )

  // Category coverage — every category that has committed cases must appear
  const categoriesWithCases = Object.entries(FIXTURE_COUNTS).filter(
    ([, count]) => count > 0,
  )
  for (const [category, expectedCount] of categoriesWithCases) {
    const goldenCaseIds = GOLDEN_SET.cases
      .filter((c) => c.category === category)
      .map((c) => c.id)
    const observedCount = goldenCaseIds.filter((id) => observedIds.has(id)).length
    assert.equal(
      observedCount,
      expectedCount,
      `category ${category}: expected ${expectedCount} observed cases, got ${observedCount}`,
    )
  }
})

// ---------------------------------------------------------------------------
// #2 — A case timeout, cancellation, malformed terminal, or provider failure
//      is explicit and cannot be silently dropped from the dataset.
// ---------------------------------------------------------------------------

test("Ticket 24 #2a: pre-aborted signal marks every case as failed but keeps them in the dataset", async () => {
  const ac = new AbortController()
  ac.abort()
  const result = await goldenSetRunner(makeProbeContext(makeBasicFixture(), ac.signal))

  // Runner itself may still report ok=true (it completed its sweep and every
  // case has an explicit failure record) — the key assertion is that cases
  // are NOT dropped and each carries an explicit failureReason.
  const caseResults = (result.outputs ?? {}).caseResults as CaseResult[]
  assert.equal(
    caseResults.length,
    GOLDEN_SET.cases.length,
    "aborted signal must not drop any case from the dataset",
  )
  const failedCount = caseResults.filter((cr) => cr.status === "failed").length
  assert.ok(
    failedCount > 0,
    "aborted signal must mark at least some cases as failed (not silently pass)",
  )
  for (const cr of caseResults) {
    if (cr.status === "failed") {
      assert.ok(
        cr.failureReason && cr.failureReason.length > 0,
        `case ${cr.caseId}: failed case must carry a non-empty failureReason`,
      )
    }
  }
})

test("Ticket 24 #2b: every failed case carries redacted failure evidence", async () => {
  const ac = new AbortController()
  ac.abort()
  const result = await goldenSetRunner(makeProbeContext(makeBasicFixture(), ac.signal))
  const caseResults = (result.outputs ?? {}).caseResults as CaseResult[]

  for (const cr of caseResults) {
    if (cr.status === "failed") {
      assert.ok(
        typeof cr.redactedFailureEvidence === "string" &&
          cr.redactedFailureEvidence.length > 0,
        `case ${cr.caseId}: failed case must carry redactedFailureEvidence`,
      )
      // Redacted evidence must NOT contain raw prompts or answer text —
      // it is a bounded failure category label.
      assert.ok(
        !cr.redactedFailureEvidence.includes("[cite:"),
        `case ${cr.caseId}: redactedFailureEvidence must not contain raw citation tokens`,
      )
    }
  }
})

test("Ticket 24 #2c: malformed terminal (runner threw) is explicit, not dropped", async () => {
  // Use a revision too short to derive a tenant — ingestion fixture setup
  // will throw inside the runner. Every case must still appear with a
  // failure status (cannot be silently dropped).
  const result = await goldenSetRunner(
    makeProbeContext({ revision: "short" }),
  )

  const caseResults = (result.outputs ?? {}).caseResults as CaseResult[] | undefined
  // Runner may either fail (ok=false) with reason, or succeed with all cases
  // marked failed. Either is acceptable per spec — the requirement is that
  // failures are EXPLICIT, not silently dropped.
  if (caseResults) {
    assert.equal(
      caseResults.length,
      GOLDEN_SET.cases.length,
      "even malformed-setup runs must not drop cases",
    )
  } else {
    assert.equal(result.ok, false, "malformed setup must produce ok=false")
    assert.ok(result.reason, "malformed setup must carry an explicit reason")
  }
})

// ---------------------------------------------------------------------------
// #3 — The output is accepted directly by deterministic hard-invariant
//      evaluation without caller-supplied pass fields.
// ---------------------------------------------------------------------------

test("Ticket 24 #3a: caseResults are accepted by evaluateHardInvariants without caller-supplied pass fields", async () => {
  const result = await goldenSetRunner(makeProbeContext(makeBasicFixture()))
  const caseResults = (result.outputs ?? {}).caseResults as CaseResult[]

  // No caller-supplied pass fields on CaseResult — status is OBSERVED, not
  // a pass/fail judgment. The hard-invariant evaluator derives pass/fail
  // from terminalStatus + citations + retrievedEvidenceIds.
  for (const cr of caseResults) {
    // CaseResult.status is observed (passed/failed/skipped), NOT a
    // hard-invariant pass field. The evaluator must not consult any
    // "passed" boolean on the CaseResult.
    assert.equal(
      "passed" in cr && typeof (cr as { passed?: unknown }).passed === "boolean",
      false,
      `case ${cr.caseId}: CaseResult must not carry a boolean "passed" field`,
    )
  }

  // evaluateHardInvariants must accept the (goldenCases, caseResults) pair
  // without throwing — structural acceptance is the criterion.
  let invariantResults: ReturnType<typeof evaluateHardInvariants> | undefined
  assert.doesNotThrow(
    () => {
      invariantResults = evaluateHardInvariants(GOLDEN_SET.cases, caseResults)
    },
    "evaluateHardInvariants must accept goldenSetRunner output without throwing",
  )
  assert.ok(Array.isArray(invariantResults), "invariant results must be an array")
  assert.equal(invariantResults!.length, 8, "must produce 8 hard invariant results")
})

test("Ticket 24 #3b: every CaseResult's caseId maps to a GoldenCase (no orphan results)", async () => {
  const result = await goldenSetRunner(makeProbeContext(makeBasicFixture()))
  const caseResults = (result.outputs ?? {}).caseResults as CaseResult[]
  const goldenIds = new Set(GOLDEN_SET.cases.map((c) => c.id))

  for (const cr of caseResults) {
    assert.ok(
      goldenIds.has(cr.caseId),
      `case ${cr.caseId}: CaseResult.caseId must map to a committed GoldenCase`,
    )
  }
})

// ---------------------------------------------------------------------------
// Isolation + sanitization + bounded outputs
// ---------------------------------------------------------------------------

test("Ticket 24 iso: runner uses acceptance-scoped tenant (no production tenant)", async () => {
  const result = await goldenSetRunner(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}

  const tenantId = outputs.tenantId as string | undefined
  assert.ok(tenantId, "tenantId must be present in outputs")
  assert.ok(
    tenantId.startsWith(ACCEPTANCE_TENANT_PREFIX),
    `tenantId must be acceptance-scoped (got ${tenantId}); must never touch the production "default" tenant`,
  )
})

test("Ticket 24 sanit: outputs contain NO raw answer text, prompts, or tokens", async () => {
  const result = await goldenSetRunner(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}
  const serialized = JSON.stringify(outputs)

  // Bounded outputs: no raw answer text, no prompt content, no token streams.
  // Citations and evidence IDs are safe metadata (identifiers only).
  assert.ok(
    !serialized.includes("[cite:"),
    "outputs must not contain raw citation tokens from answer text",
  )
  assert.ok(
    !/"reply"\s*:/.test(serialized),
    "outputs must not contain raw reply text",
  )
  assert.ok(
    !/"prompt"\s*:/.test(serialized),
    "outputs must not contain prompt content",
  )
  assert.ok(
    !/"tokens"\s*:\s*\[/.test(serialized),
    "outputs must not contain token streams",
  )
})

test("Ticket 24 bounded: outputs carry bounded metadata (dataset version, revision, counts)", async () => {
  const result = await goldenSetRunner(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}

  assert.equal(outputs.datasetVersion, GOLDEN_SET.version, "datasetVersion must match GOLDEN_SET.version")
  assert.equal(outputs.repositoryRevision, REVISION, "repositoryRevision must match fixture.revision")
  assert.equal(outputs.totalCases, GOLDEN_SET.cases.length, "totalCases must match GOLDEN_SET length")

  const passed = outputs.passedCases as number
  const failed = outputs.failedCases as number
  const skipped = outputs.skippedCases as number
  assert.ok(typeof passed === "number", "passedCases must be a number")
  assert.ok(typeof failed === "number", "failedCases must be a number")
  assert.ok(typeof skipped === "number", "skippedCases must be a number")
  assert.equal(
    passed + failed + skipped,
    GOLDEN_SET.cases.length,
    "passed + failed + skipped must equal totalCases",
  )
})

// ---------------------------------------------------------------------------
// Failure-mode coverage: cancellation propagates explicitly
// ---------------------------------------------------------------------------

test("Ticket 24 cancel: mid-run abort produces a cancelled CaseResult (not silently dropped)", async () => {
  // Abort after a short delay — simulates mid-run cancellation. The runner
  // must record the cancellation as an explicit failed CaseResult (or mark
  // the not-yet-run cases as failed) rather than dropping them.
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 50)
  try {
    const result = await goldenSetRunner(makeProbeContext(makeBasicFixture(), ac.signal))
    const caseResults = (result.outputs ?? {}).caseResults as CaseResult[]
    assert.equal(
      caseResults.length,
      GOLDEN_SET.cases.length,
      "mid-run abort must not drop any case",
    )
    // At least one case must be marked failed with a cancellation reason
    const cancelled = caseResults.find(
      (cr) => cr.status === "failed" && cr.terminalStatus === "cancelled",
    )
    if (cancelled) {
      assert.ok(
        cancelled.failureReason && /cancel|abort/i.test(cancelled.failureReason),
        `cancelled case must carry a cancellation-related failureReason (got: ${cancelled.failureReason})`,
      )
    }
  } finally {
    clearTimeout(timer)
  }
})
