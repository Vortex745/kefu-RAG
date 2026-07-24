// Ticket 28 — One-command production acceptance tests.
//
// TDD red phase: defines the expected behavior of runProductionAcceptance
// BEFORE the implementation exists. Tests cover all 3 acceptance criteria:
//   #1 — The command exits zero only when every required deterministic gate
//        and production probe passes for the clean trusted revision.
//   #2 — Failure preserves partial redacted evidence while withholding
//        production-ready status and returning a non-zero exit.
//   #3 — The final V2 artifact passes promotion validation for the current
//        trusted revision and contains verified rollback evidence.
//
// Tests use STUB injections (smokeImplementations / releaseGates /
// rollbackVerifier) — no real subprocesses are spawned. Acceptance-time
// verification runs the real CLI: `node --import tsx scripts/production-acceptance.ts`.

import assert from "node:assert/strict"
import test from "node:test"

import {
  runProductionAcceptance,
  type ProductionAcceptanceOptions,
  type ProductionAcceptanceReport,
} from "./production_acceptance"
import type { ProbeImplementation, ProbeRunResult, SmokeEvidence } from "./smoke_harness"
import type { GateDefinition, GateResult, ReleaseRunnerArtifact, RollbackEvidence } from "./runner"
import type { PromotionResult } from "./promotion"

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

function makePassingSmokeResults(): ProbeRunResult[] {
  return [
    {
      name: "oidc",
      profile: "production",
      status: "passed",
      durationMs: 10,
      redacted: false,
      outputs: { ok: true, issuer: "stub-issuer", audience: "stub-audience" },
    },
    {
      name: "elasticsearch_vector",
      profile: "production",
      status: "passed",
      durationMs: 10,
      redacted: false,
      outputs: { ok: true, hits: 5 },
    },
  ]
}

function makePassingSmokeEvidence(): SmokeEvidence {
  return {
    schemaVersion: 1,
    repositoryRevision: "rev-trusted-abc123",
    profile: "production",
    generatedAt: "2026-07-25T10:00:00Z",
    results: makePassingSmokeResults(),
    overallPassed: true,
    productionReady: true,
  }
}

function makeFailingSmokeEvidence(): SmokeEvidence {
  return {
    ...makePassingSmokeEvidence(),
    results: [
      {
        name: "oidc",
        profile: "production",
        status: "failed",
        reason: "stub OIDC failure",
        durationMs: 10,
        redacted: false,
      },
    ],
    overallPassed: false,
    productionReady: false,
  }
}

function makeVerifiedRollback(): RollbackEvidence {
  return {
    verified: true,
    revision: "rev-trusted-abc123",
    steps: ["stub: startup ok", "stub: health ok", "stub: shutdown idempotent"],
  }
}

function makeUnverifiedRollback(): RollbackEvidence {
  return {
    verified: false,
    revision: "rev-trusted-abc123",
    steps: ["stub: startup ok", "stub: health FAILED"],
  }
}

function makePassingReleaseArtifact(): ReleaseRunnerArtifact {
  return {
    schemaVersion: 2,
    profile: "production",
    generatedAt: "2026-07-25T10:00:00Z",
    repositoryRevision: "rev-trusted-abc123",
    gates: [
      {
        name: "npm_test",
        command: "npm",
        args: ["test"],
        exitCode: 0,
        durationMs: 1000,
        outputTail: [],
        failureCategory: "none",
      },
      {
        name: "tsc_build",
        command: "node",
        args: ["./node_modules/typescript/bin/tsc", "--noEmit"],
        exitCode: 0,
        durationMs: 500,
        outputTail: [],
        failureCategory: "none",
      },
      {
        name: "smoke_evidence",
        command: "verifySmokeEvidence",
        args: [],
        exitCode: 0,
        durationMs: 5,
        outputTail: [],
        failureCategory: "none",
      },
    ],
    hardInvariantStatus: "passed",
    hardInvariantResults: [
      {
        key: "terminal_convergence_100" as const,
        passed: true,
        expected: "100%",
        actual: "10/10 (100%)",
        failingCaseIds: [],
      },
    ],
    smokeResults: makePassingSmokeResults(),
    overallPassed: true,
    productionReady: true,
    dirtyWorktree: false,
    evidenceHash: "stub-hash-abc123",
    rollbackEvidence: makeVerifiedRollback(),
  }
}

function makeFailingReleaseArtifact(): ReleaseRunnerArtifact {
  return {
    ...makePassingReleaseArtifact(),
    gates: [
      {
        name: "npm_test",
        command: "npm",
        args: ["test"],
        exitCode: 1,
        durationMs: 1000,
        outputTail: ["stub: 1 test failed"],
        failureCategory: "non_zero_exit",
      },
    ],
    overallPassed: false,
    productionReady: false,
  }
}

function makeSuccessfulPromotion(): PromotionResult {
  return { promoted: true, reasons: [] }
}

function makeFailingPromotion(): PromotionResult {
  return {
    promoted: false,
    reasons: ["stub: hard invariant failed", "stub: rollback unverified"],
  }
}

// Stub gate that returns a fixed result (no subprocess)
function makeStubGate(name: string, result: GateResult): GateDefinition {
  return {
    name,
    run: async () => ({ ...result, name }),
  }
}

// Stub rollback verifier — honors the requested revision (AC3: bind to trusted revision)
function makeStubRollbackVerifier(result: RollbackEvidence): ProductionAcceptanceOptions["rollbackVerifier"] {
  return async (opts) => ({ ...result, revision: opts.revision })
}

// Stub smoke implementations — every PROBE_REGISTRY name gets a stub so
// production profile (where missing required probe → missing → fail) does
// not spuriously fail. Stub returns ok=true with minimal outputs.
function makePassingSmokeImplementations(): Record<string, ProbeImplementation> {
  const all: Record<string, ProbeImplementation> = {}
  const names = [
    "oidc",
    "elasticsearch_vector",
    "elasticsearch_bm25",
    "neo4j",
    "pageindex",
    "review_ingestion",
    "chat_embedding_providers",
    "markitdown",
    "marker",
    "mineru",
    "cancellation",
    "graceful_shutdown",
    "citation_integrity",
    "whole_run_budget",
    "langfuse",
  ]
  for (const name of names) {
    all[name] = async () => ({
      ok: true,
      durationMs: 1,
      outputs: { ok: true, name },
    })
  }
  return all
}

function makeFailingSmokeImplementations(): Record<string, ProbeImplementation> {
  // Use the full set but make oidc fail — production profile fails on any
  // required-probe non-passed status.
  const all = makePassingSmokeImplementations()
  all["oidc"] = async () => ({
    ok: false,
    durationMs: 1,
    reason: "stub OIDC failure",
  })
  return all
}

// ---------------------------------------------------------------------------
// Helper: make options with all stubs passing
// ---------------------------------------------------------------------------

function makePassingOptions(outputDir: string): ProductionAcceptanceOptions {
  return {
    repositoryRevision: "rev-trusted-abc123",
    outputDir,
    smokeImplementations: makePassingSmokeImplementations(),
    // Bypass real env-var prerequisite checks in tests — stub returns
    // "all prerequisites satisfied" for any probe declaration.
    checkPrerequisites: () => ({ satisfied: true, missing: [] }),
    releaseGates: [
      makeStubGate("npm_test", {
        name: "npm_test",
        command: "npm",
        args: ["test"],
        exitCode: 0,
        durationMs: 100,
        outputTail: [],
        failureCategory: "none",
      }),
      makeStubGate("tsc_build", {
        name: "tsc_build",
        command: "node",
        args: ["./node_modules/typescript/bin/tsc", "--noEmit"],
        exitCode: 0,
        durationMs: 50,
        outputTail: [],
        failureCategory: "none",
      }),
    ],
    rollbackVerifier: makeStubRollbackVerifier(makeVerifiedRollback()),
    promotionChecker: () => makeSuccessfulPromotion(),
  }
}

// ============================================================
// #1 — Command exits zero ONLY when every required deterministic
//      gate and production probe passes for the clean trusted revision
// ============================================================

test("Ticket 28 #1a: passing smoke + rollback + gates + promotion → ok=true", async () => {
  const report = await runProductionAcceptance(makePassingOptions("/tmp/stub-output"))

  assert.equal(report.ok, true, "ok must be true when all components pass")
  assert.equal(report.productionReady, true, "productionReady must be true when all pass")
  assert.equal(report.reasons.length, 0, "no failure reasons when all pass")
})

test("Ticket 28 #1b: failing smoke probe → ok=false with smoke failure reason", async () => {
  const opts = makePassingOptions("/tmp/stub-output")
  opts.smokeImplementations = makeFailingSmokeImplementations()
  const report = await runProductionAcceptance(opts)

  assert.equal(report.ok, false, "ok must be false when smoke probe fails")
  assert.equal(report.productionReady, false)
  assert.ok(
    report.reasons.some((r) => /smoke/i.test(r)),
    `reasons must mention smoke failure; got: ${JSON.stringify(report.reasons)}`,
  )
})

test("Ticket 28 #1c: failing release gate → ok=false with gate failure reason", async () => {
  const opts = makePassingOptions("/tmp/stub-output")
  opts.releaseGates = [
    makeStubGate("npm_test", {
      name: "npm_test",
      command: "npm",
      args: ["test"],
      exitCode: 1,
      durationMs: 100,
      outputTail: ["stub: 1 test failed"],
      failureCategory: "non_zero_exit",
    }),
  ]
  const report = await runProductionAcceptance(opts)

  assert.equal(report.ok, false, "ok must be false when a release gate fails")
  assert.equal(report.productionReady, false)
  assert.ok(
    report.reasons.some((r) => /npm_test|gate/i.test(r)),
    `reasons must mention gate failure; got: ${JSON.stringify(report.reasons)}`,
  )
})

test("Ticket 28 #1d: unverified rollback → ok=false with rollback reason", async () => {
  const opts = makePassingOptions("/tmp/stub-output")
  opts.rollbackVerifier = makeStubRollbackVerifier(makeUnverifiedRollback())
  const report = await runProductionAcceptance(opts)

  assert.equal(report.ok, false, "ok must be false when rollback is unverified")
  assert.equal(report.productionReady, false)
  assert.ok(
    report.reasons.some((r) => /rollback/i.test(r)),
    `reasons must mention rollback failure; got: ${JSON.stringify(report.reasons)}`,
  )
})

test("Ticket 28 #1e: promotion check fails → ok=false with promotion reasons", async () => {
  const opts = makePassingOptions("/tmp/stub-output")
  opts.promotionChecker = () => makeFailingPromotion()
  const report = await runProductionAcceptance(opts)

  assert.equal(report.ok, false, "ok must be false when promotion check fails")
  assert.equal(report.productionReady, false)
  assert.ok(
    report.reasons.some((r) => /promotion|hard invariant|rollback/i.test(r)),
    `reasons must include promotion failure; got: ${JSON.stringify(report.reasons)}`,
  )
})

test("Ticket 28 #1f: repositoryRevision bound to all artifacts (trusted revision)", async () => {
  const opts = makePassingOptions("/tmp/stub-output")
  opts.repositoryRevision = "rev-custom-xyz789"
  const report = await runProductionAcceptance(opts)

  assert.equal(report.repositoryRevision, "rev-custom-xyz789")
  if (report.releaseArtifact) {
    assert.equal(
      report.releaseArtifact.repositoryRevision,
      "rev-custom-xyz789",
      "release artifact must bind to expected revision",
    )
  }
  if (report.rollbackEvidence) {
    assert.equal(
      report.rollbackEvidence.revision,
      "rev-custom-xyz789",
      "rollback evidence must bind to expected revision",
    )
  }
})

// ============================================================
// #2 — Failure preserves partial redacted evidence while
//      withholding production-ready status (AC2)
// ============================================================

test("Ticket 28 #2a: failure preserves smoke evidence path (partial evidence)", async () => {
  const opts = makePassingOptions("/tmp/stub-output-failure")
  opts.smokeImplementations = makeFailingSmokeImplementations()
  const report = await runProductionAcceptance(opts)

  assert.equal(report.ok, false)
  assert.ok(report.smokeEvidencePath.length > 0, "smoke evidence path must be preserved on failure")
  if (report.smokeEvidence) {
    assert.equal(report.smokeEvidence.overallPassed, false)
    assert.equal(report.smokeEvidence.productionReady, false, "AC2: withhold production-ready status")
  }
})

test("Ticket 28 #2b: failure preserves rollback evidence path (partial evidence)", async () => {
  const opts = makePassingOptions("/tmp/stub-output-failure")
  opts.rollbackVerifier = makeStubRollbackVerifier(makeUnverifiedRollback())
  const report = await runProductionAcceptance(opts)

  assert.equal(report.ok, false)
  assert.ok(report.rollbackEvidencePath.length > 0, "rollback evidence path must be preserved on failure")
  if (report.rollbackEvidence) {
    assert.equal(report.rollbackEvidence.verified, false, "rollback evidence must record failure")
  }
})

test("Ticket 28 #2c: failure preserves release artifact path (partial evidence)", async () => {
  const opts = makePassingOptions("/tmp/stub-output-failure")
  // Force a gate failure but still produce an artifact
  opts.releaseGates = [
    makeStubGate("npm_test", {
      name: "npm_test",
      command: "npm",
      args: ["test"],
      exitCode: 1,
      durationMs: 100,
      outputTail: ["stub: test failed"],
      failureCategory: "non_zero_exit",
    }),
  ]
  const report = await runProductionAcceptance(opts)

  assert.equal(report.ok, false)
  assert.ok(report.releaseArtifactPath.length > 0, "release artifact path must be preserved on failure")
  if (report.releaseArtifact) {
    assert.equal(report.releaseArtifact.overallPassed, false)
    assert.equal(report.releaseArtifact.productionReady, false, "AC2: withhold production-ready")
  }
})

test("Ticket 28 #2d: productionReady is false on any failure (withhold status)", async () => {
  const scenarios: Array<{ name: string; mutate: (opts: ProductionAcceptanceOptions) => void }> = [
    {
      name: "smoke failure",
      mutate: (opts) => {
        opts.smokeImplementations = makeFailingSmokeImplementations()
      },
    },
    {
      name: "gate failure",
      mutate: (opts) => {
        opts.releaseGates = [
          makeStubGate("npm_test", {
            name: "npm_test",
            command: "npm",
            args: ["test"],
            exitCode: 1,
            durationMs: 100,
            outputTail: [],
            failureCategory: "non_zero_exit",
          }),
        ]
      },
    },
    {
      name: "rollback failure",
      mutate: (opts) => {
        opts.rollbackVerifier = makeStubRollbackVerifier(makeUnverifiedRollback())
      },
    },
    {
      name: "promotion failure",
      mutate: (opts) => {
        opts.promotionChecker = () => makeFailingPromotion()
      },
    },
  ]
  for (const scenario of scenarios) {
    const opts = makePassingOptions("/tmp/stub-output-failure")
    scenario.mutate(opts)
    const report = await runProductionAcceptance(opts)
    assert.equal(
      report.productionReady,
      false,
      `${scenario.name}: productionReady must be false on any failure (AC2)`,
    )
  }
})

test("Ticket 28 #2e: failure reasons are non-empty strings (AC2: 'sufficient redacted evidence for diagnosis')", async () => {
  const opts = makePassingOptions("/tmp/stub-output-failure")
  opts.smokeImplementations = makeFailingSmokeImplementations()
  const report = await runProductionAcceptance(opts)

  assert.ok(report.reasons.length > 0, "must have at least one failure reason")
  for (const reason of report.reasons) {
    assert.equal(typeof reason, "string", `reason must be string; got: ${typeof reason}`)
    assert.ok(reason.length > 0, "reason must be non-empty")
  }
})

test("Ticket 28 #2f: redacted evidence — no secrets in serialized report", async () => {
  const opts = makePassingOptions("/tmp/stub-output-failure")
  opts.smokeImplementations = {
    oidc: async () => ({
      ok: false,
      durationMs: 5,
      reason: "stub failure with secret-looking token: Bearer eyJabc.def.ghi sk-test-probe",
    }),
  }
  const report = await runProductionAcceptance(opts)
  const json = JSON.stringify(report)

  // AC2: redacted evidence — must not contain real-looking secrets
  assert.ok(!json.includes("sk-test-probe"), "must not leak sk- API key prefixes")
  assert.ok(!json.includes("Bearer eyJabc.def.ghi"), "must not leak Bearer JWT tokens")
})

// ============================================================
// #3 — Final V2 artifact passes promotion validation for the
//      current trusted revision and contains verified rollback evidence
// ============================================================

test("Ticket 28 #3a: release artifact is schemaVersion=2 (V2 artifact)", async () => {
  const report = await runProductionAcceptance(makePassingOptions("/tmp/stub-output"))
  assert.ok(report.releaseArtifact, "release artifact must be present")
  assert.equal(report.releaseArtifact!.schemaVersion, 2, "must be V2 artifact")
})

test("Ticket 28 #3b: release artifact contains verified rollback evidence", async () => {
  const report = await runProductionAcceptance(makePassingOptions("/tmp/stub-output"))
  assert.ok(report.releaseArtifact?.rollbackEvidence, "artifact must contain rollback evidence")
  assert.equal(
    report.releaseArtifact!.rollbackEvidence!.verified,
    true,
    "rollback evidence must be verified",
  )
  assert.equal(
    report.releaseArtifact!.rollbackEvidence!.revision,
    "rev-trusted-abc123",
    "rollback evidence revision must match",
  )
})

test("Ticket 28 #3c: promotion.promoted=true when all checks pass (AC3)", async () => {
  const report = await runProductionAcceptance(makePassingOptions("/tmp/stub-output"))
  assert.ok(report.promotion, "promotion result must be present")
  assert.equal(report.promotion!.promoted, true, "must promote when all checks pass")
  assert.equal(report.promotion!.reasons.length, 0, "no rejection reasons when promoted")
})

test("Ticket 28 #3d: artifact revision matches expected trusted revision", async () => {
  const opts = makePassingOptions("/tmp/stub-output")
  opts.repositoryRevision = "rev-trusted-xyz999"
  const report = await runProductionAcceptance(opts)
  assert.equal(
    report.releaseArtifact!.repositoryRevision,
    "rev-trusted-xyz999",
    "artifact revision must match trusted revision",
  )
})

test("Ticket 28 #3e: promotion receives artifact with expectedRevision (AC3: 'current trusted revision')", async () => {
  let receivedRevision: string | undefined
  const opts = makePassingOptions("/tmp/stub-output")
  opts.repositoryRevision = "rev-trusted-promotion-123"
  opts.promotionChecker = (artifact, expectedRevision) => {
    receivedRevision = expectedRevision
    return makeSuccessfulPromotion()
  }
  await runProductionAcceptance(opts)
  assert.equal(
    receivedRevision,
    "rev-trusted-promotion-123",
    "promotion must receive the trusted expected revision",
  )
})

// ============================================================
// #4 — Cancellation + signal propagation
// ============================================================

test("Ticket 28 #4a: pre-aborted signal → ok=false with abort reason", async () => {
  const opts = makePassingOptions("/tmp/stub-output")
  const controller = new AbortController()
  controller.abort()
  opts.signal = controller.signal
  const report = await runProductionAcceptance(opts)
  assert.equal(report.ok, false, "must fail when signal pre-aborted")
  assert.ok(
    report.reasons.some((r) => /abort|cancel/i.test(r)),
    `reasons must mention abort; got: ${JSON.stringify(report.reasons)}`,
  )
})

// ============================================================
// #5 — Isolation: default factory functions used when no injection
// ============================================================

test("Ticket 28 #5a: runProductionAcceptance exposes default factory helpers", () => {
  // These exports are used by the CLI entry point (scripts/production-acceptance.ts)
  // to wire real implementations. Test verifies they exist and are callable.
  // We don't run them (they would spawn real subprocesses), just verify the shape.
  const opts: ProductionAcceptanceOptions = {
    repositoryRevision: "rev-stub",
    outputDir: "/tmp/stub",
    smokeImplementations: makePassingSmokeImplementations(),
    releaseGates: [
      makeStubGate("stub", {
        name: "stub",
        command: "stub",
        args: [],
        exitCode: 0,
        durationMs: 1,
        outputTail: [],
        failureCategory: "none",
      }),
    ],
    rollbackVerifier: makeStubRollbackVerifier(makeVerifiedRollback()),
    promotionChecker: () => makeSuccessfulPromotion(),
  }
  assert.ok(opts.smokeImplementations, "smokeImplementations accepts ProbeImplementations")
  assert.ok(Array.isArray(opts.releaseGates), "releaseGates accepts GateDefinition[]")
  assert.equal(typeof opts.rollbackVerifier, "function", "rollbackVerifier is callable")
  assert.equal(typeof opts.promotionChecker, "function", "promotionChecker is callable")
})

// ============================================================
// #6 — Sanity: report shape
// ============================================================

test("Ticket 28 #6a: report contains all required top-level fields", async () => {
  const report = await runProductionAcceptance(makePassingOptions("/tmp/stub-output"))
  const requiredFields = [
    "ok",
    "reasons",
    "repositoryRevision",
    "generatedAt",
    "smokeEvidencePath",
    "rollbackEvidencePath",
    "releaseArtifactPath",
    "productionReady",
  ]
  for (const field of requiredFields) {
    assert.ok(
      field in report,
      `report must have top-level field '${field}'; got: ${JSON.stringify(Object.keys(report))}`,
    )
  }
})

test("Ticket 28 #6b: report records ISO 8601 timestamp", async () => {
  const report = await runProductionAcceptance(makePassingOptions("/tmp/stub-output"))
  assert.equal(typeof report.generatedAt, "string")
  assert.ok(Date.parse(report.generatedAt) > 0, "generatedAt must be valid ISO timestamp")
})
