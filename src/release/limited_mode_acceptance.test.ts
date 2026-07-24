// Ticket 29 — Limited-mode candidate acceptance tests.
//
// TDD red phase: defines the expected behavior of
// runLimitedModeCandidateAcceptance BEFORE the implementation exists.
// Tests cover all 3 acceptance criteria:
//   #1 — Limited mode starts the accepted build, passes health, and reports
//        the expected runtime mode and revision.
//   #2 — Critical identity, retrieval, cancellation, Citation, budget, and
//        shutdown probes pass against the running candidate.
//   #3 — Failure keeps default promotion blocked and leaves sufficient
//        redacted evidence for diagnosis.
//
// Tests use STUB probe implementations — no real external services. The
// limited-mode HTTP server is real (port: 0 = isolated random port).

import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  runLimitedModeCandidateAcceptance,
  CRITICAL_PROBE_NAMES,
  type LimitedModeAcceptanceOptions,
} from "./limited_mode_acceptance"
import type { ProbeImplementation, ProbeName } from "./smoke_harness"

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

/**
 * Stub implementations for ALL 10 critical probes. Each returns ok=true with
 * minimal outputs matching the probe's declared result schema.
 */
function makePassingCriticalProbeImplementations(): Record<string, ProbeImplementation> {
  const impls: Record<string, ProbeImplementation> = {}
  for (const name of CRITICAL_PROBE_NAMES) {
    impls[name] = async () => ({
      ok: true,
      durationMs: 1,
      outputs: { ok: true, name },
    })
  }
  return impls
}

function makePassingOptions(outputDir: string): LimitedModeAcceptanceOptions {
  return {
    repositoryRevision: "rev-trusted-limited-abc",
    outputDir,
    port: 0, // isolated random port
    probeImplementations: makePassingCriticalProbeImplementations(),
    // Bypass real env-var prerequisite checks in tests.
    checkPrerequisites: () => ({ satisfied: true, missing: [] }),
  }
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `t29-${prefix}-`))
}

// ---------------------------------------------------------------------------
// AC1 — Limited mode starts, passes health, reports runtime mode + revision
// ---------------------------------------------------------------------------

test("Ticket 29 #1a: ok=true when server starts + health passes + all critical probes pass", async () => {
  const dir = makeTempDir("1a")
  try {
    const report = await runLimitedModeCandidateAcceptance(makePassingOptions(dir))
    assert.equal(report.ok, true, `must be ok; reasons: ${JSON.stringify(report.reasons)}`)
    assert.equal(report.reasons.length, 0, "no failure reasons on success")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Ticket 29 #1b: runtimeMode='limited' + revision matches trusted revision", async () => {
  const dir = makeTempDir("1b")
  try {
    const opts = makePassingOptions(dir)
    opts.repositoryRevision = "rev-trusted-mode-xyz"
    const report = await runLimitedModeCandidateAcceptance(opts)
    assert.equal(report.runtimeMode, "limited", "runtimeMode must be 'limited'")
    assert.equal(
      report.repositoryRevision,
      "rev-trusted-mode-xyz",
      "revision must match trusted input",
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Ticket 29 #1c: healthOk=true when health endpoint returns ok", async () => {
  const dir = makeTempDir("1c")
  try {
    const report = await runLimitedModeCandidateAcceptance(makePassingOptions(dir))
    assert.equal(report.healthOk, true, "healthOk must be true on happy path")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Ticket 29 #1d: ok=false when health check fails (server not reachable)", async () => {
  const dir = makeTempDir("1d")
  try {
    const opts = makePassingOptions(dir)
    // Inject a startServer stub that returns a non-functional candidate
    // (port that nothing listens on) to force health failure.
    opts.startServer = async () => ({
      port: 1, // privileged port nothing listens on
      revision: opts.repositoryRevision,
      mode: "limited",
      shutdown: async () => {},
    })
    const report = await runLimitedModeCandidateAcceptance(opts)
    assert.equal(report.ok, false, "must fail when health endpoint unreachable")
    assert.equal(report.healthOk, false, "healthOk must be false on failure")
    assert.ok(
      report.reasons.some((r) => /health/i.test(r)),
      `reasons must mention health; got: ${JSON.stringify(report.reasons)}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// AC2 — Critical probes pass against running candidate
// ---------------------------------------------------------------------------

test("Ticket 29 #2a: all 10 critical probes are run (no missing)", async () => {
  const dir = makeTempDir("2a")
  try {
    const report = await runLimitedModeCandidateAcceptance(makePassingOptions(dir))
    const probeNames = report.probeResults.map((r) => r.name)
    for (const expected of CRITICAL_PROBE_NAMES) {
      assert.ok(
        probeNames.includes(expected),
        `must run critical probe '${expected}'; got: ${JSON.stringify(probeNames)}`,
      )
    }
    assert.equal(
      report.probeResults.length,
      CRITICAL_PROBE_NAMES.length,
      `must run exactly ${CRITICAL_PROBE_NAMES.length} critical probes`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Ticket 29 #2b: ok=false when a critical probe fails (oidc)", async () => {
  const dir = makeTempDir("2b")
  try {
    const opts = makePassingOptions(dir)
    opts.probeImplementations = {
      ...makePassingCriticalProbeImplementations(),
      oidc: async () => ({
        ok: false,
        durationMs: 5,
        reason: "stub OIDC failure",
      }),
    }
    const report = await runLimitedModeCandidateAcceptance(opts)
    assert.equal(report.ok, false, "must fail when a critical probe fails")
    assert.ok(
      report.reasons.some((r) => /oidc/i.test(r)),
      `reasons must mention oidc failure; got: ${JSON.stringify(report.reasons)}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Ticket 29 #2c: non-critical probes are NOT run (chat_embedding, parsers, langfuse)", async () => {
  const dir = makeTempDir("2c")
  try {
    const report = await runLimitedModeCandidateAcceptance(makePassingOptions(dir))
    const probeNames = report.probeResults.map((r) => r.name)
    const nonCritical: ProbeName[] = [
      "chat_embedding_providers",
      "markitdown",
      "marker",
      "mineru",
      "langfuse",
    ]
    for (const name of nonCritical) {
      assert.ok(
        !probeNames.includes(name),
        `non-critical probe '${name}' must NOT be run; got: ${JSON.stringify(probeNames)}`,
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Ticket 29 #2d: probeResults in report include status + name + durationMs", async () => {
  const dir = makeTempDir("2d")
  try {
    const report = await runLimitedModeCandidateAcceptance(makePassingOptions(dir))
    assert.ok(report.probeResults.length > 0, "must have probe results")
    for (const r of report.probeResults) {
      assert.equal(typeof r.name, "string", "name must be string")
      assert.ok(
        ["passed", "failed", "skipped", "timeout", "missing", "cancelled"].includes(r.status),
        `status must be valid; got: ${r.status}`,
      )
      assert.equal(typeof r.durationMs, "number", "durationMs must be number")
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// AC3 — Failure keeps default promotion blocked + redacted evidence
// ---------------------------------------------------------------------------

test("Ticket 29 #3a: promotionBlocked=true when ok=false (withhold promotion)", async () => {
  const dir = makeTempDir("3a")
  try {
    const opts = makePassingOptions(dir)
    opts.probeImplementations = {
      ...makePassingCriticalProbeImplementations(),
      cancellation: async () => ({ ok: false, durationMs: 1, reason: "stub cancel fail" }),
    }
    const report = await runLimitedModeCandidateAcceptance(opts)
    assert.equal(report.ok, false, "must fail when a critical probe fails")
    assert.equal(
      report.promotionBlocked,
      true,
      "promotionBlocked must be true when ok=false (AC3)",
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Ticket 29 #3b: promotionBlocked=false when ok=true (promotion allowed)", async () => {
  const dir = makeTempDir("3b")
  try {
    const report = await runLimitedModeCandidateAcceptance(makePassingOptions(dir))
    assert.equal(report.ok, true, "must pass on happy path")
    assert.equal(
      report.promotionBlocked,
      false,
      "promotionBlocked must be false when ok=true (AC3)",
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Ticket 29 #3c: failure reasons are non-empty strings", async () => {
  const dir = makeTempDir("3c")
  try {
    const opts = makePassingOptions(dir)
    opts.probeImplementations = {
      ...makePassingCriticalProbeImplementations(),
      citation_integrity: async () => ({
        ok: false,
        durationMs: 1,
        reason: "stub citation failure",
      }),
    }
    const report = await runLimitedModeCandidateAcceptance(opts)
    assert.ok(report.reasons.length > 0, "must have failure reasons")
    for (const reason of report.reasons) {
      assert.equal(typeof reason, "string", "reason must be string")
      assert.ok(reason.length > 0, "reason must be non-empty")
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Ticket 29 #3d: redacted evidence — no secrets in serialized report", async () => {
  const dir = makeTempDir("3d")
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
    const report = await runLimitedModeCandidateAcceptance(opts)
    const json = JSON.stringify(report)
    // AC3: redacted evidence — must not contain real-looking secrets
    assert.ok(!json.includes("sk-test-probe"), "must not leak sk- API key prefixes")
    assert.ok(!json.includes("Bearer eyJabc.def.ghi"), "must not leak Bearer JWT tokens")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Ticket 29 #3e: smoke evidence + limited-mode evidence paths written", async () => {
  const dir = makeTempDir("3e")
  try {
    const report = await runLimitedModeCandidateAcceptance(makePassingOptions(dir))
    assert.equal(typeof report.smokeEvidencePath, "string")
    assert.equal(typeof report.limitedModeEvidencePath, "string")
    // Files must exist and contain valid JSON
    const smokeJson = readFileSync(report.smokeEvidencePath, "utf8")
    const smoke = JSON.parse(smokeJson)
    assert.ok(smoke.results, "smoke evidence must have results")
    const limitedJson = readFileSync(report.limitedModeEvidencePath, "utf8")
    const limited = JSON.parse(limitedJson)
    assert.equal(limited.runtimeMode, "limited", "limited-mode evidence must record mode")
    assert.equal(limited.repositoryRevision, "rev-trusted-limited-abc")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

test("Ticket 29 #4a: pre-aborted signal → ok=false with abort reason", async () => {
  const dir = makeTempDir("4a")
  try {
    const opts = makePassingOptions(dir)
    const controller = new AbortController()
    controller.abort()
    opts.signal = controller.signal
    const report = await runLimitedModeCandidateAcceptance(opts)
    assert.equal(report.ok, false, "must fail when signal pre-aborted")
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

test("Ticket 29 #5a: server is shut down after verification (shutdownCompletedAt recorded)", async () => {
  const dir = makeTempDir("5a")
  try {
    const report = await runLimitedModeCandidateAcceptance(makePassingOptions(dir))
    assert.ok(
      report.shutdownCompletedAt,
      "shutdownCompletedAt must be recorded after verification",
    )
    assert.equal(typeof report.shutdownCompletedAt, "string")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Ticket 29 #5b: server is shut down even on failure", async () => {
  const dir = makeTempDir("5b")
  try {
    const opts = makePassingOptions(dir)
    opts.probeImplementations = {
      ...makePassingCriticalProbeImplementations(),
      graceful_shutdown: async () => ({ ok: false, durationMs: 1, reason: "stub fail" }),
    }
    const report = await runLimitedModeCandidateAcceptance(opts)
    assert.equal(report.ok, false, "must fail")
    assert.ok(
      report.shutdownCompletedAt,
      "shutdown must still complete on failure (no leaked server)",
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Ticket 29 #5c: startedAt recorded as ISO 8601 string", async () => {
  const dir = makeTempDir("5c")
  try {
    const report = await runLimitedModeCandidateAcceptance(makePassingOptions(dir))
    assert.equal(typeof report.startedAt, "string")
    assert.ok(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(report.startedAt),
      "startedAt must be ISO 8601",
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
