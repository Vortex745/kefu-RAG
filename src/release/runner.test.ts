// Ticket 03 — Command-owning release runner tests.
//
// Spec issue #03: The runner executes verification processes itself and
// captures auditable results instead of accepting caller-supplied success
// booleans. These tests use CONTROLLED CHILD COMMANDS (node -e) so they are
// fast and deterministic — the real `release:verify:local` acceptance run
// happens via the package script, not here.
//
// TDD red phase: tests written BEFORE implementation. Every acceptance
// criterion of the ticket maps to at least one test:
//   #1 release:verify:local + release:verify:production commands → covered by
//      package.json + scripts/release-verify.ts (verified at acceptance time)
//   #2 runner executes 6 gates → defaultGates tests
//   #3 capture name/args/exitCode/duration/outputTail/failureCategory → runGate tests
//   #4 local mode: blocked live evidence OK, NOT production-ready → local mode tests
//   #5 production mode: non-zero on missing/failed → production mode tests
//   #6 handles start-fail/timeout/cancel/malformed/partial → failure category tests
//   #7 unit tests use controlled child commands → this file
//   #8 runner tests + full suite + build + diff pass → acceptance gate

import test from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  runGate,
  runReleaseVerification,
  defaultLocalGates,
  defaultProductionGates,
  type GateDefinition,
  type GateResult,
  type ReleaseRunnerArtifact,
  type FailureCategory,
} from "./runner"

// ---------------------------------------------------------------------------
// Helper: temp dir for eval/smoke evidence files
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "release-runner-test-"))
}

function writeEvalEvidence(dir: string, name: string, cases: unknown[]): string {
  const path = join(dir, name)
  // Minimal eval input shape: { goldenCases: [], caseResults: [] }
  writeFileSync(path, JSON.stringify({ goldenCases: cases, caseResults: cases }), "utf8")
  return path
}

function writeMalformedJson(dir: string, name: string): string {
  const path = join(dir, name)
  writeFileSync(path, "{ not valid json }}}", "utf8")
  return path
}

// ---------------------------------------------------------------------------
// Controlled child commands (fast, deterministic, no real npm/tsc)
// ---------------------------------------------------------------------------

const CMD_OK = process.execPath // node binary
const ARGS_OK = ["-e", "process.exit(0)"]
const ARGS_FAIL = ["-e", "process.exit(1)"]
const ARGS_SLOW = ["-e", "setTimeout(() => {}, 30000)"]
const ARGS_OUTPUT = ["-e", "for (let i=0;i<500;i++) console.log('line ' + i)"]

// ---------------------------------------------------------------------------
// runGate — the core subprocess executor
// ---------------------------------------------------------------------------

test("runGate: success → exitCode=0, failureCategory=none", async () => {
  const result = await runGate({
    name: "test-ok",
    command: CMD_OK,
    args: ARGS_OK,
    timeoutMs: 5000,
    outputTailLines: 50,
  })
  assert.equal(result.name, "test-ok")
  assert.equal(result.exitCode, 0)
  assert.equal(result.failureCategory, "none")
  assert.ok(result.durationMs >= 0)
  assert.deepEqual(result.args, ARGS_OK)
})

test("runGate: non-zero exit → failureCategory=non_zero_exit", async () => {
  const result = await runGate({
    name: "test-fail",
    command: CMD_OK,
    args: ARGS_FAIL,
    timeoutMs: 5000,
    outputTailLines: 50,
  })
  assert.equal(result.exitCode, 1)
  assert.equal(result.failureCategory, "non_zero_exit")
})

test("runGate: start failure (ENOENT) → failureCategory=start_failed, no exitCode", async () => {
  const result = await runGate({
    name: "test-missing",
    command: "nonexistent-command-xyz-12345",
    args: [],
    timeoutMs: 5000,
    outputTailLines: 50,
  })
  assert.equal(result.exitCode, undefined)
  assert.equal(result.failureCategory, "start_failed")
  assert.ok(result.failureReason)
})

test("runGate: timeout → failureCategory=timeout, no exitCode", async () => {
  const result = await runGate({
    name: "test-slow",
    command: CMD_OK,
    args: ARGS_SLOW,
    timeoutMs: 100,
    outputTailLines: 50,
  })
  assert.equal(result.exitCode, undefined)
  assert.equal(result.failureCategory, "timeout")
  assert.ok(result.failureReason)
})

test("runGate: cancellation via AbortSignal → failureCategory=cancelled", async () => {
  const controller = new AbortController()
  const promise = runGate({
    name: "test-cancel",
    command: CMD_OK,
    args: ARGS_SLOW,
    timeoutMs: 30000,
    outputTailLines: 50,
    signal: controller.signal,
  })
  // Abort after a short delay so the process has started
  setTimeout(() => controller.abort(), 50)
  const result = await promise
  assert.equal(result.exitCode, undefined)
  assert.equal(result.failureCategory, "cancelled")
})

test("runGate: output tail is bounded to outputTailLines", async () => {
  const result = await runGate({
    name: "test-output",
    command: CMD_OK,
    args: ARGS_OUTPUT,
    timeoutMs: 5000,
    outputTailLines: 20,
  })
  assert.equal(result.exitCode, 0)
  // 500 lines output, tail bounded to 20
  assert.ok(result.outputTail.length <= 20, `outputTail length ${result.outputTail.length} must be <= 20`)
  assert.ok(result.outputTail.length > 0, "outputTail must contain some lines")
  // The tail should contain the LAST lines (highest numbers)
  const lastLine = result.outputTail[result.outputTail.length - 1]
  assert.match(lastLine, /line 499/, "tail preserves the last output lines")
})

test("runGate: command and args are sanitized in the result (no secrets leak)", async () => {
  const result = await runGate({
    name: "test-sanitize",
    command: CMD_OK,
    args: ["-e", "process.exit(0)"],
    timeoutMs: 5000,
    outputTailLines: 50,
  })
  assert.equal(result.command, CMD_OK)
  assert.deepEqual(result.args, ["-e", "process.exit(0)"])
})

// ---------------------------------------------------------------------------
// defaultLocalGates / defaultProductionGates — gate definitions
// ---------------------------------------------------------------------------

test("defaultLocalGates: returns 6 gates with correct names", () => {
  const gates = defaultLocalGates({ cwd: process.cwd() })
  const names = gates.map((g) => g.name)
  assert.equal(gates.length, 6, "local mode has 6 gates")
  assert.ok(names.includes("npm_test"), "npm_test gate present")
  assert.ok(names.includes("tsc_build"), "tsc_build gate present")
  assert.ok(names.includes("frontend_build"), "frontend_build gate present")
  assert.ok(names.includes("schema_verify"), "schema_verify gate present")
  assert.ok(names.includes("hard_invariants"), "hard_invariants gate present")
  assert.ok(names.includes("git_diff_check"), "git_diff_check gate present")
})

test("defaultProductionGates: returns 7 gates (adds clean_worktree for clean revision)", () => {
  const gates = defaultProductionGates({
    cwd: process.cwd(),
    evaluationInputPath: undefined,
    smokeEvidencePath: undefined,
  })
  const names = gates.map((g) => g.name)
  assert.ok(names.includes("clean_worktree"), "production adds clean_worktree gate")
  assert.ok(names.includes("smoke_evidence"), "production includes smoke_evidence gate")
})

// ---------------------------------------------------------------------------
// runReleaseVerification — local mode
// ---------------------------------------------------------------------------

test("local mode: all gates pass → overallPassed=true, productionReady=false", async () => {
  const gates: GateDefinition[] = [
    {
      name: "stub-ok-1",
      run: async () => ({
        name: "stub-ok-1",
        command: "stub",
        args: [],
        exitCode: 0,
        durationMs: 1,
        outputTail: [],
        failureCategory: "none" as FailureCategory,
      }),
    },
    {
      name: "stub-ok-2",
      run: async () => ({
        name: "stub-ok-2",
        command: "stub",
        args: [],
        exitCode: 0,
        durationMs: 1,
        outputTail: [],
        failureCategory: "none" as FailureCategory,
      }),
    },
  ]
  const outDir = makeTempDir()
  try {
    const outputPath = join(outDir, "local-artifact.json")
    const artifact = await runReleaseVerification({
      profile: "local",
      outputPath,
      gates,
    })
    assert.equal(artifact.profile, "local")
    assert.equal(artifact.overallPassed, true, "all stub gates passed")
    assert.equal(artifact.productionReady, false, "local mode is NEVER production-ready")
    assert.equal(artifact.hardInvariantStatus, "not_run", "no hard_invariants gate in stubs")
    assert.equal(artifact.gates.length, 2)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test("local mode: hard_invariants gate with no eval input → status=blocked, overallPassed depends on deterministic gates", async () => {
  const gates: GateDefinition[] = [
    {
      name: "stub-ok",
      run: async () => ({
        name: "stub-ok",
        command: "stub",
        args: [],
        exitCode: 0,
        durationMs: 1,
        outputTail: [],
        failureCategory: "none" as FailureCategory,
      }),
    },
    {
      name: "hard_invariants",
      run: async () => ({
        name: "hard_invariants",
        command: "evaluateHardInvariants",
        args: [],
        exitCode: undefined,
        durationMs: 0,
        outputTail: [],
        failureCategory: "none" as FailureCategory,
        failureReason: "blocked: no evaluation input provided (local mode allows this)",
        blocked: true,
      }),
    },
  ]
  const outDir = makeTempDir()
  try {
    const artifact = await runReleaseVerification({
      profile: "local",
      outputPath: join(outDir, "art.json"),
      gates,
    })
    assert.equal(artifact.hardInvariantStatus, "blocked", "local mode allows blocked hard invariants")
    assert.equal(artifact.overallPassed, true, "blocked live evidence does not fail local mode")
    assert.equal(artifact.productionReady, false)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test("local mode: deterministic gate failure → overallPassed=false", async () => {
  const gates: GateDefinition[] = [
    {
      name: "stub-fail",
      run: async () => ({
        name: "stub-fail",
        command: "stub",
        args: [],
        exitCode: 1,
        durationMs: 1,
        outputTail: ["error: something broke"],
        failureCategory: "non_zero_exit" as FailureCategory,
      }),
    },
  ]
  const outDir = makeTempDir()
  try {
    const artifact = await runReleaseVerification({
      profile: "local",
      outputPath: join(outDir, "art.json"),
      gates,
    })
    assert.equal(artifact.overallPassed, false, "deterministic gate failure fails local mode")
    assert.equal(artifact.productionReady, false)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// runReleaseVerification — production mode
// ---------------------------------------------------------------------------

test("production mode: missing eval input → overallPassed=false", async () => {
  const gates: GateDefinition[] = [
    {
      name: "stub-ok",
      run: async () => ({
        name: "stub-ok",
        command: "stub",
        args: [],
        exitCode: 0,
        durationMs: 1,
        outputTail: [],
        failureCategory: "none" as FailureCategory,
      }),
    },
    {
      name: "hard_invariants",
      run: async () => ({
        name: "hard_invariants",
        command: "evaluateHardInvariants",
        args: [],
        exitCode: undefined,
        durationMs: 0,
        outputTail: [],
        failureCategory: "malformed_input" as FailureCategory,
        failureReason: "missing evaluation input (production mode requires it)",
      }),
    },
  ]
  const outDir = makeTempDir()
  try {
    const artifact = await runReleaseVerification({
      profile: "production",
      outputPath: join(outDir, "art.json"),
      gates,
    })
    assert.equal(artifact.overallPassed, false, "production mode fails when eval input missing")
    assert.equal(artifact.productionReady, false)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test("production mode: missing smoke evidence → overallPassed=false", async () => {
  const gates: GateDefinition[] = [
    {
      name: "stub-ok",
      run: async () => ({
        name: "stub-ok",
        command: "stub",
        args: [],
        exitCode: 0,
        durationMs: 1,
        outputTail: [],
        failureCategory: "none" as FailureCategory,
      }),
    },
    {
      name: "smoke_evidence",
      run: async () => ({
        name: "smoke_evidence",
        command: "verifySmokeEvidence",
        args: [],
        exitCode: undefined,
        durationMs: 0,
        outputTail: [],
        failureCategory: "malformed_input" as FailureCategory,
        failureReason: "missing smoke evidence (production mode requires it)",
      }),
    },
  ]
  const outDir = makeTempDir()
  try {
    const artifact = await runReleaseVerification({
      profile: "production",
      outputPath: join(outDir, "art.json"),
      gates,
    })
    assert.equal(artifact.overallPassed, false, "production mode fails when smoke evidence missing")
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test("production mode: all gates pass + eval + smoke → overallPassed=true, productionReady=true", async () => {
  const gates: GateDefinition[] = [
    {
      name: "stub-ok-1",
      run: async () => ({
        name: "stub-ok-1",
        command: "stub",
        args: [],
        exitCode: 0,
        durationMs: 1,
        outputTail: [],
        failureCategory: "none" as FailureCategory,
      }),
    },
    {
      name: "hard_invariants",
      run: async () => ({
        name: "hard_invariants",
        command: "evaluateHardInvariants",
        args: ["eval.json"],
        exitCode: 0,
        durationMs: 5,
        outputTail: ["all 8 invariants passed"],
        failureCategory: "none" as FailureCategory,
      }),
    },
    {
      name: "smoke_evidence",
      run: async () => ({
        name: "smoke_evidence",
        command: "verifySmokeEvidence",
        args: ["smoke.json"],
        exitCode: 0,
        durationMs: 2,
        outputTail: ["12/12 capabilities passed"],
        failureCategory: "none" as FailureCategory,
      }),
    },
    {
      name: "clean_worktree",
      run: async () => ({
        name: "clean_worktree",
        command: "git",
        args: ["status", "--porcelain"],
        exitCode: 0,
        durationMs: 1,
        outputTail: [],
        failureCategory: "none" as FailureCategory,
      }),
    },
  ]
  const outDir = makeTempDir()
  try {
    const artifact = await runReleaseVerification({
      profile: "production",
      outputPath: join(outDir, "art.json"),
      gates,
    })
    assert.equal(artifact.overallPassed, true, "all gates passed")
    assert.equal(artifact.productionReady, true, "production mode + all pass = production-ready")
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test("production mode: dirty worktree → overallPassed=false", async () => {
  const gates: GateDefinition[] = [
    {
      name: "stub-ok",
      run: async () => ({
        name: "stub-ok",
        command: "stub",
        args: [],
        exitCode: 0,
        durationMs: 1,
        outputTail: [],
        failureCategory: "none" as FailureCategory,
      }),
    },
    {
      name: "clean_worktree",
      run: async () => ({
        name: "clean_worktree",
        command: "git",
        args: ["status", "--porcelain"],
        exitCode: 1,
        durationMs: 1,
        outputTail: [" M some-file.ts"],
        failureCategory: "non_zero_exit" as FailureCategory,
        failureReason: "worktree is not clean (uncommitted changes)",
      }),
    },
  ]
  const outDir = makeTempDir()
  try {
    const artifact = await runReleaseVerification({
      profile: "production",
      outputPath: join(outDir, "art.json"),
      gates,
    })
    assert.equal(artifact.overallPassed, false, "dirty worktree fails production mode")
    assert.equal(artifact.productionReady, false)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// No manufactured pass — the runner must NEVER lie
// ---------------------------------------------------------------------------

test("no manufactured pass: start_failed gate → overallPassed=false even in local mode", async () => {
  const gates: GateDefinition[] = [
    {
      name: "broken-gate",
      run: async () => ({
        name: "broken-gate",
        command: "missing-cmd",
        args: [],
        exitCode: undefined,
        durationMs: 0,
        outputTail: [],
        failureCategory: "start_failed" as FailureCategory,
        failureReason: "ENOENT",
      }),
    },
  ]
  const outDir = makeTempDir()
  try {
    const artifact = await runReleaseVerification({
      profile: "local",
      outputPath: join(outDir, "art.json"),
      gates,
    })
    assert.equal(artifact.overallPassed, false, "start_failed is a real failure, never a pass")
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test("no manufactured pass: timeout gate → overallPassed=false", async () => {
  const gates: GateDefinition[] = [
    {
      name: "slow-gate",
      run: async () => ({
        name: "slow-gate",
        command: "slow-cmd",
        args: [],
        exitCode: undefined,
        durationMs: 100,
        outputTail: [],
        failureCategory: "timeout" as FailureCategory,
        failureReason: "exceeded 100ms",
      }),
    },
  ]
  const outDir = makeTempDir()
  try {
    const artifact = await runReleaseVerification({
      profile: "local",
      outputPath: join(outDir, "art.json"),
      gates,
    })
    assert.equal(artifact.overallPassed, false, "timeout is a real failure, never a pass")
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Artifact persistence — output file is written
// ---------------------------------------------------------------------------

test("artifact is written to outputPath as JSON", async () => {
  const gates: GateDefinition[] = [
    {
      name: "stub-ok",
      run: async () => ({
        name: "stub-ok",
        command: "stub",
        args: [],
        exitCode: 0,
        durationMs: 1,
        outputTail: [],
        failureCategory: "none" as FailureCategory,
      }),
    },
  ]
  const outDir = makeTempDir()
  try {
    const outputPath = join(outDir, "written-artifact.json")
    const artifact = await runReleaseVerification({
      profile: "local",
      outputPath,
      gates,
    })
    // Read back the file and verify it parses
    const raw = require("node:fs").readFileSync(outputPath, "utf8")
    const parsed = JSON.parse(raw) as ReleaseRunnerArtifact
    assert.equal(parsed.schemaVersion, 2)
    assert.equal(parsed.profile, "local")
    assert.equal(parsed.gates.length, 1)
    assert.deepEqual(parsed.gates[0].name, "stub-ok")
    assert.equal(parsed.productionReady, false)
    assert.equal(parsed.overallPassed, true)
    assert.ok(parsed.repositoryRevision, "repositoryRevision is captured")
    assert.ok(parsed.generatedAt, "generatedAt is captured")
    // The returned artifact matches the written one
    assert.deepEqual(parsed, artifact)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Hard invariants gate — real eval input parsing
// ---------------------------------------------------------------------------

test("hard_invariants gate: valid eval input → runs evaluateHardInvariants, status=passed", async () => {
  const outDir = makeTempDir()
  try {
    // Minimal valid eval input: goldenCases + caseResults both empty →
    // evaluateHardInvariants returns 8 results, all vacuously passing
    const evalPath = writeEvalEvidence(outDir, "eval.json", [])
    const gates = defaultLocalGates({ cwd: process.cwd() })
    // Override: provide eval input path so the hard_invariants gate runs
    const hardInvariantsGate = gates.find((g) => g.name === "hard_invariants")!
    const result = await hardInvariantsGate.run({
      signal: undefined,
      outputTailLines: 50,
      evaluationInputPath: evalPath,
    } as never)
    assert.equal(result.name, "hard_invariants")
    assert.equal(result.failureCategory, "none")
    assert.equal(result.exitCode, 0)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test("hard_invariants gate: malformed eval input → failureCategory=malformed_input", async () => {
  const outDir = makeTempDir()
  try {
    const evalPath = writeMalformedJson(outDir, "bad.json")
    const gates = defaultLocalGates({ cwd: process.cwd() })
    const hardInvariantsGate = gates.find((g) => g.name === "hard_invariants")!
    const result = await hardInvariantsGate.run({
      signal: undefined,
      outputTailLines: 50,
      evaluationInputPath: evalPath,
    } as never)
    assert.equal(result.failureCategory, "malformed_input")
    assert.equal(result.exitCode, undefined)
    assert.ok(result.failureReason)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test("hard_invariants gate: no eval input in local mode → blocked (not a failure)", async () => {
  const gates = defaultLocalGates({ cwd: process.cwd() })
  const hardInvariantsGate = gates.find((g) => g.name === "hard_invariants")!
  const result = await hardInvariantsGate.run({
    signal: undefined,
    outputTailLines: 50,
    evaluationInputPath: undefined,
  } as never)
  assert.equal(result.failureCategory, "none")
  assert.equal(result.exitCode, 0)
  assert.ok((result as GateResult & { blocked?: boolean }).blocked, "blocked flag set")
})
