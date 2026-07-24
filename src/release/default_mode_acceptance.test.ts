// Ticket 30 — Default-mode promotion acceptance tests.
//
// TDD red phase: defines the expected behavior of
// runDefaultModePromotionAcceptance BEFORE the implementation exists.
// Tests cover all 3 acceptance criteria:
//   #1 — Default mode starts only with the exact V2 artifact and revision
//        that passed limited acceptance.
//   #2 — Missing, stale, local-profile, tampered, or failing artifacts are
//        rejected before runtime resources are created.
//   #3 — Critical production smoke and graceful shutdown pass in default
//        mode with exactly one terminal per Answer run.
//
// Tests use STUB probe implementations + STUB runAnswerOnce — no real
// external services or LLM calls.

import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  runDefaultModePromotionAcceptance,
  validateV2Artifact,
  type DefaultModeAcceptanceOptions,
  type DefaultModeAcceptanceReport,
} from "./default_mode_acceptance"
import type { ProbeImplementation } from "./smoke_harness"
import type { ReleaseRunnerArtifact } from "./runner"

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

function makeValidV2Artifact(revision = "rev-trusted-default-abc"): ReleaseRunnerArtifact {
  return {
    schemaVersion: 2,
    profile: "production",
    generatedAt: "2026-07-25T10:00:00Z",
    repositoryRevision: revision,
    gates: [
      {
        name: "npm_test",
        command: "npm",
        args: ["test"],
        exitCode: 0,
        durationMs: 100,
        outputTail: [],
        failureCategory: "none",
        blocked: false,
      },
    ],
    hardInvariantStatus: { passed: true, failingKeys: [] },
    hardInvariantResults: [
      { key: "k1", passed: true, expected: "1", actual: "1", failingCaseIds: [] },
    ],
    smokeResults: [],
    overallPassed: true,
    productionReady: true,
    dirtyWorktree: false,
    evidenceHash: "", // recomputed below
    rollbackEvidence: {
      verified: true,
      revision,
      steps: ["stub: rollback verified"],
    },
  } as unknown as ReleaseRunnerArtifact
}

/**
 * Build a V2 artifact with a CORRECT evidenceHash recomputed from the
 * canonical sections (so tamper-detection passes).
 */
function makeValidV2ArtifactWithHash(revision = "rev-trusted-default-abc"): ReleaseRunnerArtifact {
  const artifact = makeValidV2Artifact(revision)
  // Use the real computeEvidenceHash to compute a valid hash — we re-import
  // it lazily so the test does not depend on the import path at module top.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { computeEvidenceHash } = require("./runner") as typeof import("./runner")
  return { ...artifact, evidenceHash: computeEvidenceHash(artifact) }
}

function makePassingCriticalProbeImplementations(): Record<string, ProbeImplementation> {
  const names = [
    "oidc",
    "elasticsearch_vector",
    "elasticsearch_bm25",
    "neo4j",
    "pageindex",
    "review_ingestion",
    "cancellation",
    "citation_integrity",
    "whole_run_budget",
    "graceful_shutdown",
  ]
  const impls: Record<string, ProbeImplementation> = {}
  for (const name of names) {
    impls[name] = async () => ({
      ok: true,
      durationMs: 1,
      outputs: { ok: true, name },
    })
  }
  return impls
}

function makePassingOptions(outputDir: string): DefaultModeAcceptanceOptions {
  return {
    repositoryRevision: "rev-trusted-default-abc",
    outputDir,
    v2Artifact: makeValidV2ArtifactWithHash("rev-trusted-default-abc"),
    probeImplementations: makePassingCriticalProbeImplementations(),
    checkPrerequisites: () => ({ satisfied: true, missing: [] }),
    runAnswerOnce: async () => ({ terminalCount: 1, ok: true }),
    port: 0,
  }
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `t30-${prefix}-`))
}

// ---------------------------------------------------------------------------
// Pure function: validateV2Artifact
// ---------------------------------------------------------------------------

test("Ticket 30 #V1: validateV2Artifact accepts a valid V2 production artifact", () => {
  const artifact = makeValidV2ArtifactWithHash("rev-abc")
  const result = validateV2Artifact(artifact, { expectedRevision: "rev-abc" })
  assert.equal(result.valid, true, `must be valid; reason: ${result.reason}`)
  assert.equal(result.reason, undefined)
})

test("Ticket 30 #V2: validateV2Artifact rejects null/undefined artifact (missing)", () => {
  const result = validateV2Artifact(null as unknown as ReleaseRunnerArtifact, {
    expectedRevision: "rev-abc",
  })
  assert.equal(result.valid, false)
  assert.equal(result.reason, "missing")
})

test("Ticket 30 #V3: validateV2Artifact rejects stale revision (mismatch)", () => {
  const artifact = makeValidV2ArtifactWithHash("rev-old")
  const result = validateV2Artifact(artifact, { expectedRevision: "rev-new" })
  assert.equal(result.valid, false)
  assert.equal(result.reason, "stale")
})

test("Ticket 30 #V4: validateV2Artifact rejects local-profile artifact", () => {
  const artifact = makeValidV2ArtifactWithHash("rev-abc")
  // Force profile to local after hash computation
  const tampered = { ...artifact, profile: "local" as const }
  const result = validateV2Artifact(tampered, { expectedRevision: "rev-abc" })
  assert.equal(result.valid, false)
  assert.equal(result.reason, "local-profile")
})

test("Ticket 30 #V5: validateV2Artifact rejects tampered artifact (hash mismatch)", () => {
  const artifact = makeValidV2ArtifactWithHash("rev-abc")
  // Mutate a canonical section AFTER hash computation → hash mismatch
  const tampered = {
    ...artifact,
    gates: [
      ...artifact.gates,
      {
        name: "extra_gate",
        command: "echo",
        args: ["tampered"],
        exitCode: 0,
        durationMs: 1,
        outputTail: [],
        failureCategory: "none",
        blocked: false,
      },
    ],
  } as ReleaseRunnerArtifact
  const result = validateV2Artifact(tampered, { expectedRevision: "rev-abc" })
  assert.equal(result.valid, false)
  assert.equal(result.reason, "tampered")
})

test("Ticket 30 #V6: validateV2Artifact rejects failing artifact (overallPassed=false)", () => {
  const artifact = makeValidV2ArtifactWithHash("rev-abc")
  // Set overallPassed=false and recompute hash so this is "failing" not "tampered"
  const failing = { ...artifact, overallPassed: false }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { computeEvidenceHash } = require("./runner") as typeof import("./runner")
  failing.evidenceHash = computeEvidenceHash(failing)
  const result = validateV2Artifact(failing, { expectedRevision: "rev-abc" })
  assert.equal(result.valid, false)
  assert.equal(result.reason, "failing")
})

// ---------------------------------------------------------------------------
// AC1 — Default mode starts only with exact V2 artifact + revision
// ---------------------------------------------------------------------------

test("Ticket 30 #1a: ok=true with valid V2 artifact + matching revision + all probes + 1 terminal", async () => {
  const dir = makeTempDir("1a")
  try {
    const report = await runDefaultModePromotionAcceptance(makePassingOptions(dir))
    assert.equal(report.ok, true, `must be ok; reasons: ${JSON.stringify(report.reasons)}`)
    assert.equal(report.reasons.length, 0, "no failure reasons on success")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Ticket 30 #1b: runtimeMode='default' + revision matches trusted revision", async () => {
  const dir = makeTempDir("1b")
  try {
    const opts = makePassingOptions(dir)
    opts.repositoryRevision = "rev-trusted-mode-xyz"
    opts.v2Artifact = makeValidV2ArtifactWithHash("rev-trusted-mode-xyz")
    const report = await runDefaultModePromotionAcceptance(opts)
    assert.equal(report.runtimeMode, "default", "runtimeMode must be 'default'")
    assert.equal(report.repositoryRevision, "rev-trusted-mode-xyz")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Ticket 30 #1c: artifactValidated=true on happy path", async () => {
  const dir = makeTempDir("1c")
  try {
    const report = await runDefaultModePromotionAcceptance(makePassingOptions(dir))
    assert.equal(report.artifactValidated, true, "artifactValidated must be true on happy path")
    assert.equal(report.artifactRejectionReason, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// AC2 — Rejected artifacts (before runtime resources created)
// ---------------------------------------------------------------------------

test("Ticket 30 #2a: missing artifact → rejected, no probes run, no server started", async () => {
  const dir = makeTempDir("2a")
  try {
    const opts = makePassingOptions(dir)
    opts.v2Artifact = undefined as unknown as ReleaseRunnerArtifact
    const report = await runDefaultModePromotionAcceptance(opts)
    assert.equal(report.ok, false, "must fail when artifact missing")
    assert.equal(report.artifactValidated, false)
    assert.equal(report.artifactRejectionReason, "missing")
    assert.equal(report.probeResults.length, 0, "no probes must run on rejection")
    assert.equal(report.terminalCount, 0, "no Answer run on rejection")
    assert.equal(report.shutdownCompletedAt, undefined, "no server started on rejection")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Ticket 30 #2b: stale artifact (wrong revision) → rejected", async () => {
  const dir = makeTempDir("2b")
  try {
    const opts = makePassingOptions(dir)
    opts.repositoryRevision = "rev-new"
    opts.v2Artifact = makeValidV2ArtifactWithHash("rev-old")
    const report = await runDefaultModePromotionAcceptance(opts)
    assert.equal(report.ok, false)
    assert.equal(report.artifactRejectionReason, "stale")
    assert.equal(report.probeResults.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Ticket 30 #2c: local-profile artifact → rejected", async () => {
  const dir = makeTempDir("2c")
  try {
    const opts = makePassingOptions(dir)
    opts.v2Artifact = { ...makeValidV2ArtifactWithHash("rev-trusted-default-abc"), profile: "local" as const }
    const report = await runDefaultModePromotionAcceptance(opts)
    assert.equal(report.ok, false)
    assert.equal(report.artifactRejectionReason, "local-profile")
    assert.equal(report.probeResults.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Ticket 30 #2d: tampered artifact (hash mismatch) → rejected", async () => {
  const dir = makeTempDir("2d")
  try {
    const opts = makePassingOptions(dir)
    const artifact = makeValidV2ArtifactWithHash("rev-trusted-default-abc")
    // Mutate gates after hash computation → tampered
    opts.v2Artifact = {
      ...artifact,
      gates: [
        ...artifact.gates,
        {
          name: "extra",
          command: "echo",
          args: ["tampered"],
          exitCode: 0,
          durationMs: 1,
          outputTail: [],
          failureCategory: "none",
          blocked: false,
        },
      ],
    } as ReleaseRunnerArtifact
    const report = await runDefaultModePromotionAcceptance(opts)
    assert.equal(report.ok, false)
    assert.equal(report.artifactRejectionReason, "tampered")
    assert.equal(report.probeResults.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Ticket 30 #2e: failing artifact (overallPassed=false) → rejected", async () => {
  const dir = makeTempDir("2e")
  try {
    const opts = makePassingOptions(dir)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { computeEvidenceHash } = require("./runner") as typeof import("./runner")
    const artifact = makeValidV2ArtifactWithHash("rev-trusted-default-abc")
    const failing = { ...artifact, overallPassed: false }
    failing.evidenceHash = computeEvidenceHash(failing)
    opts.v2Artifact = failing as ReleaseRunnerArtifact
    const report = await runDefaultModePromotionAcceptance(opts)
    assert.equal(report.ok, false)
    assert.equal(report.artifactRejectionReason, "failing")
    assert.equal(report.probeResults.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// AC3 — Critical production smoke + graceful shutdown + 1 terminal per Answer
// ---------------------------------------------------------------------------

test("Ticket 30 #3a: ok=false when a critical probe fails", async () => {
  const dir = makeTempDir("3a")
  try {
    const opts = makePassingOptions(dir)
    opts.probeImplementations = {
      ...makePassingCriticalProbeImplementations(),
      oidc: async () => ({ ok: false, durationMs: 1, reason: "stub oidc fail" }),
    }
    const report = await runDefaultModePromotionAcceptance(opts)
    assert.equal(report.ok, false, "must fail when a critical probe fails")
    assert.ok(
      report.reasons.some((r) => /oidc/i.test(r)),
      `reasons must mention oidc; got: ${JSON.stringify(report.reasons)}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Ticket 30 #3b: ok=false when terminalCount=0 (no terminal)", async () => {
  const dir = makeTempDir("3b")
  try {
    const opts = makePassingOptions(dir)
    opts.runAnswerOnce = async () => ({ terminalCount: 0, ok: true })
    const report = await runDefaultModePromotionAcceptance(opts)
    assert.equal(report.ok, false, "must fail when terminalCount=0")
    assert.equal(report.terminalCount, 0)
    assert.ok(
      report.reasons.some((r) => /terminal/i.test(r)),
      `reasons must mention terminal; got: ${JSON.stringify(report.reasons)}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Ticket 30 #3c: ok=false when terminalCount=2 (multiple terminals)", async () => {
  const dir = makeTempDir("3c")
  try {
    const opts = makePassingOptions(dir)
    opts.runAnswerOnce = async () => ({ terminalCount: 2, ok: true })
    const report = await runDefaultModePromotionAcceptance(opts)
    assert.equal(report.ok, false, "must fail when terminalCount=2")
    assert.equal(report.terminalCount, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Ticket 30 #3d: ok=false when Answer run itself fails (ok=false)", async () => {
  const dir = makeTempDir("3d")
  try {
    const opts = makePassingOptions(dir)
    opts.runAnswerOnce = async () => ({
      terminalCount: 1,
      ok: false,
      reason: "stub answer failure",
    })
    const report = await runDefaultModePromotionAcceptance(opts)
    assert.equal(report.ok, false, "must fail when Answer run fails")
    assert.ok(
      report.reasons.some((r) => /answer/i.test(r)),
      `reasons must mention Answer; got: ${JSON.stringify(report.reasons)}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Ticket 30 #3e: terminalCount=1 recorded on happy path", async () => {
  const dir = makeTempDir("3e")
  try {
    const report = await runDefaultModePromotionAcceptance(makePassingOptions(dir))
    assert.equal(report.terminalCount, 1, "terminalCount must be 1 on happy path (AC3)")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Failure handling — promotion blocked + redacted evidence + paths written
// ---------------------------------------------------------------------------

test("Ticket 30 #4a: promotionBlocked=true when ok=false (withhold promotion)", async () => {
  const dir = makeTempDir("4a")
  try {
    const opts = makePassingOptions(dir)
    opts.probeImplementations = {
      ...makePassingCriticalProbeImplementations(),
      cancellation: async () => ({ ok: false, durationMs: 1, reason: "stub fail" }),
    }
    const report = await runDefaultModePromotionAcceptance(opts)
    assert.equal(report.ok, false)
    assert.equal(report.promotionBlocked, true, "promotionBlocked must be true when ok=false")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Ticket 30 #4b: promotionBlocked=false when ok=true", async () => {
  const dir = makeTempDir("4b")
  try {
    const report = await runDefaultModePromotionAcceptance(makePassingOptions(dir))
    assert.equal(report.ok, true)
    assert.equal(report.promotionBlocked, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Ticket 30 #4c: redacted evidence — no secrets in serialized report", async () => {
  const dir = makeTempDir("4c")
  try {
    const opts = makePassingOptions(dir)
    opts.probeImplementations = {
      ...makePassingCriticalProbeImplementations(),
      oidc: async () => ({
        ok: false,
        durationMs: 5,
        reason: "stub failure with secret-looking token: Bearer eyJabc.def.ghi sk-test-probe",
      }),
    }
    const report = await runDefaultModePromotionAcceptance(opts)
    const json = JSON.stringify(report)
    assert.ok(!json.includes("sk-test-probe"), "must not leak sk- API key prefixes")
    assert.ok(!json.includes("Bearer eyJabc.def.ghi"), "must not leak Bearer JWT tokens")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Ticket 30 #4d: default-mode evidence path written with valid JSON", async () => {
  const dir = makeTempDir("4d")
  try {
    const report = await runDefaultModePromotionAcceptance(makePassingOptions(dir))
    assert.equal(typeof report.defaultModeEvidencePath, "string")
    const json = readFileSync(report.defaultModeEvidencePath, "utf8")
    const parsed = JSON.parse(json)
    assert.equal(parsed.runtimeMode, "default")
    assert.equal(parsed.repositoryRevision, "rev-trusted-default-abc")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

test("Ticket 30 #5a: pre-aborted signal → ok=false with abort reason", async () => {
  const dir = makeTempDir("5a")
  try {
    const opts = makePassingOptions(dir)
    const controller = new AbortController()
    controller.abort()
    opts.signal = controller.signal
    const report = await runDefaultModePromotionAcceptance(opts)
    assert.equal(report.ok, false)
    assert.ok(
      report.reasons.some((r) => /abort|cancel/i.test(r)),
      `reasons must mention abort; got: ${JSON.stringify(report.reasons)}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

test("Ticket 30 #6a: server shuts down after verification", async () => {
  const dir = makeTempDir("6a")
  try {
    const report = await runDefaultModePromotionAcceptance(makePassingOptions(dir))
    assert.ok(report.shutdownCompletedAt, "shutdownCompletedAt must be recorded")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Ticket 30 #6b: server shuts down even on probe failure", async () => {
  const dir = makeTempDir("6b")
  try {
    const opts = makePassingOptions(dir)
    opts.probeImplementations = {
      ...makePassingCriticalProbeImplementations(),
      graceful_shutdown: async () => ({ ok: false, durationMs: 1, reason: "stub fail" }),
    }
    const report = await runDefaultModePromotionAcceptance(opts)
    assert.equal(report.ok, false)
    assert.ok(report.shutdownCompletedAt, "shutdown must still complete on failure")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
