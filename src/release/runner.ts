// Ticket 03 — Command-owning release runner.
//
// Spec issue #03: The runner executes verification processes itself and
// captures auditable results instead of accepting caller-supplied success
// booleans. This module is the SINGLE owner of subprocess execution for
// release verification gates.
//
// Design (karpathy-guidelines):
//   - Simplest viable shape: runGate spawns one subprocess; runReleaseVerification
//     orchestrates gates and assembles an artifact.
//   - No manufactured pass: start_failed, timeout, cancelled, malformed_input
//     are real failures that always produce overallPassed=false.
//   - Local mode may record blocked live evidence (failureCategory="none" +
//     blocked=true); production mode treats missing evidence as malformed_input.
//   - The artifact is JSON-serializable with no Date objects or undefined fields.
//
// The existing pure assembler (src/evaluation/release_verification.ts) remains
// usable for tests — this module does NOT modify it (rollback criterion).

import { spawn, execSync } from "node:child_process"
import { writeFileSync, readFileSync } from "node:fs"
import { createHash } from "node:crypto"

import { evaluateHardInvariants } from "../evaluation/hard_invariants"
import {
  validateSmokeEvidence,
  computeOverallPassed,
  type ProbeRunResult,
  type SmokeEvidence,
} from "./smoke_harness"
import type {
  CaseResult,
  EvaluationProfile,
  GoldenCase,
  HardInvariantResult,
} from "../evaluation/types"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FailureCategory =
  | "none"
  | "non_zero_exit"
  | "start_failed"
  | "timeout"
  | "cancelled"
  | "malformed_input"
  | "partial_completion"

export interface GateResult {
  name: string
  command: string
  args: string[]
  exitCode?: number
  durationMs: number
  outputTail: string[]
  failureCategory: FailureCategory
  failureReason?: string
  blocked?: boolean
  /** Structured evidence (e.g. HardInvariantResult[] or SmokeResult[]). */
  evidence?: unknown
}

export interface GateRunOptions {
  signal?: AbortSignal
  outputTailLines: number
  evaluationInputPath?: string
  smokeEvidencePath?: string
  /** The release profile being verified — used by smoke_evidence gate to bind evidence.profile. */
  releaseProfile?: EvaluationProfile
  /** The expected repository revision — used by smoke_evidence gate to bind evidence.repositoryRevision. */
  expectedRevision?: string
}

export interface GateDefinition {
  name: string
  run: (options: GateRunOptions) => Promise<GateResult>
}

export type HardInvariantStatus =
  | "not_run"
  | "passed"
  | "failed"
  | "blocked"
  | "malformed"

export interface RollbackEvidence {
  verified: boolean
  revision: string
  steps: string[]
}

export interface NonDeterministicReports {
  ragasShadow?: unknown
  langfuse?: unknown
}

export interface ReleaseRunnerArtifact {
  schemaVersion: 2
  profile: EvaluationProfile
  generatedAt: string
  repositoryRevision: string
  gates: GateResult[]
  hardInvariantStatus: HardInvariantStatus
  hardInvariantResults: HardInvariantResult[]
  smokeResults: ProbeRunResult[]
  overallPassed: boolean
  productionReady: boolean
  dirtyWorktree: boolean
  evidenceHash: string
  rollbackEvidence?: RollbackEvidence
  nonDeterministicReports?: NonDeterministicReports
}

interface RunGateOptions {
  name: string
  command: string
  args: string[]
  timeoutMs: number
  outputTailLines: number
  signal?: AbortSignal
  cwd?: string
  shell?: boolean
}

// ---------------------------------------------------------------------------
// runGate — the core subprocess executor
// ---------------------------------------------------------------------------

export function runGate(options: RunGateOptions): Promise<GateResult> {
  return new Promise<GateResult>((resolve) => {
    const start = Date.now()
    const {
      name,
      command,
      args,
      timeoutMs,
      outputTailLines,
      signal,
      cwd,
      shell,
    } = options

    let outputBuffer = ""
    let settled = false
    let child: ReturnType<typeof spawn> | null = null
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null

    const settle = (result: {
      failureCategory: FailureCategory
      exitCode?: number
      failureReason?: string
      blocked?: boolean
    }): void => {
      if (settled) return
      settled = true
      if (timeoutHandle !== null) clearTimeout(timeoutHandle)
      if (child !== null && !child.killed) {
        try {
          child.kill("SIGKILL")
        } catch {
          // Process may have already exited
        }
      }
      const allLines = outputBuffer.split("\n")
      if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
        allLines.pop()
      }
      const tail = allLines.slice(-outputTailLines)
      resolve({
        name,
        command,
        args,
        exitCode: result.exitCode,
        durationMs: Date.now() - start,
        outputTail: tail,
        failureCategory: result.failureCategory,
        failureReason: result.failureReason,
        blocked: result.blocked,
      })
    }

    try {
      child = spawn(command, args, {
        cwd,
        shell: shell ?? false,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (err) {
      settle({
        failureCategory: "start_failed",
        failureReason: err instanceof Error ? err.message : String(err),
      })
      return
    }

    child.stdout?.on("data", (data: Buffer) => {
      outputBuffer += data.toString("utf8")
    })
    child.stderr?.on("data", (data: Buffer) => {
      outputBuffer += data.toString("utf8")
    })

    child.on("error", (err: NodeJS.ErrnoException) => {
      settle({
        failureCategory: "start_failed",
        failureReason: err.message,
      })
    })

    child.on("close", (code: number | null) => {
      if (settled) return
      if (code === 0) {
        settle({ failureCategory: "none", exitCode: 0 })
      } else {
        settle({
          failureCategory: "non_zero_exit",
          exitCode: code ?? undefined,
        })
      }
    })

    timeoutHandle = setTimeout(() => {
      settle({
        failureCategory: "timeout",
        failureReason: `exceeded ${timeoutMs}ms`,
      })
    }, timeoutMs)

    if (signal) {
      if (signal.aborted) {
        settle({
          failureCategory: "cancelled",
          failureReason: "aborted before start",
        })
      } else {
        signal.addEventListener(
          "abort",
          () => {
            settle({
              failureCategory: "cancelled",
              failureReason: "aborted by signal",
            })
          },
          { once: true },
        )
      }
    }
  })
}

// ---------------------------------------------------------------------------
// Gate factories
// ---------------------------------------------------------------------------

function makeSubprocessGate(
  name: string,
  command: string,
  args: string[],
  timeoutMs: number,
  cwd: string,
  shell?: boolean,
): GateDefinition {
  return {
    name,
    run: async (opts: GateRunOptions): Promise<GateResult> => {
      return runGate({
        name,
        command,
        args,
        timeoutMs,
        outputTailLines: opts.outputTailLines,
        signal: opts.signal,
        cwd,
        shell,
      })
    },
  }
}

function makeHardInvariantsGate(
  profile: EvaluationProfile,
): GateDefinition {
  return {
    name: "hard_invariants",
    run: async (opts: GateRunOptions): Promise<GateResult> => {
      const command = "evaluateHardInvariants"
      const baseResult = {
        name: "hard_invariants" as const,
        command,
        args: [] as string[],
        durationMs: 0,
        outputTail: [] as string[],
      }

      if (!opts.evaluationInputPath) {
        if (profile === "local") {
          return {
            ...baseResult,
            exitCode: 0,
            failureCategory: "none",
            failureReason:
              "blocked: no evaluation input provided (local mode allows this)",
            blocked: true,
          }
        }
        return {
          ...baseResult,
          exitCode: undefined,
          failureCategory: "malformed_input",
          failureReason: "missing evaluation input (production mode requires it)",
        }
      }

      try {
        const raw = readFileSync(opts.evaluationInputPath, "utf8")
        const parsed = JSON.parse(raw) as {
          goldenCases?: GoldenCase[]
          caseResults?: CaseResult[]
        }
        const goldenCases = parsed.goldenCases ?? []
        const caseResults = parsed.caseResults ?? []
        const results = evaluateHardInvariants(goldenCases, caseResults)
        const failed = results.filter((r) => !r.passed)
        const allPassed = failed.length === 0
        return {
          ...baseResult,
          args: [opts.evaluationInputPath],
          exitCode: allPassed ? 0 : 1,
          failureCategory: allPassed ? "none" : "non_zero_exit",
          failureReason: allPassed
            ? undefined
            : `${failed.length} invariants failed: ${failed.map((r) => r.key).join(", ")}`,
          outputTail: results.map(
            (r) => `${r.key}: ${r.passed ? "PASS" : "FAIL"} (${r.actual})`,
          ),
          evidence: results,
        }
      } catch (err) {
        return {
          ...baseResult,
          args: [opts.evaluationInputPath],
          exitCode: undefined,
          failureCategory: "malformed_input",
          failureReason: err instanceof Error ? err.message : String(err),
        }
      }
    },
  }
}

function makeCleanWorktreeGate(cwd: string): GateDefinition {
  return {
    name: "clean_worktree",
    run: async (opts: GateRunOptions): Promise<GateResult> => {
      const result = await runGate({
        name: "clean_worktree",
        command: "git",
        args: ["status", "--porcelain"],
        timeoutMs: 10_000,
        outputTailLines: opts.outputTailLines,
        signal: opts.signal,
        cwd,
      })
      if (result.exitCode === 0 && result.outputTail.length > 0) {
        return {
          ...result,
          exitCode: 1,
          failureCategory: "non_zero_exit",
          failureReason: "worktree is not clean (uncommitted changes)",
        }
      }
      return result
    },
  }
}

export function makeSmokeEvidenceGate(): GateDefinition {
  return {
    name: "smoke_evidence",
    run: async (opts: GateRunOptions): Promise<GateResult> => {
      const command = "verifySmokeEvidence"
      const baseResult = {
        name: "smoke_evidence" as const,
        command,
        durationMs: 0,
        outputTail: [] as string[],
      }

      if (!opts.smokeEvidencePath) {
        return {
          ...baseResult,
          args: [],
          exitCode: undefined,
          failureCategory: "malformed_input",
          failureReason: "missing smoke evidence (production mode requires it)",
        }
      }

      try {
        const raw = readFileSync(opts.smokeEvidencePath, "utf8")
        const parsed: unknown = JSON.parse(raw)

        // Ticket 03: validate via SmokeEvidence schema (not legacy loose cast).
        const validation = validateSmokeEvidence(parsed)
        if (!validation.valid) {
          return {
            ...baseResult,
            args: [opts.smokeEvidencePath],
            exitCode: undefined,
            failureCategory: "malformed_input",
            failureReason: `invalid smoke evidence: ${validation.errors.join("; ")}`,
          }
        }

        const evidence = parsed as SmokeEvidence

        // Ticket 03: bind smoke profile to release profile.
        if (opts.releaseProfile && evidence.profile !== opts.releaseProfile) {
          return {
            ...baseResult,
            args: [opts.smokeEvidencePath],
            exitCode: undefined,
            failureCategory: "malformed_input",
            failureReason: `smoke evidence profile "${evidence.profile}" does not match release profile "${opts.releaseProfile}"`,
          }
        }

        // Ticket 03: bind smoke revision to release revision.
        if (
          opts.expectedRevision &&
          evidence.repositoryRevision !== opts.expectedRevision
        ) {
          return {
            ...baseResult,
            args: [opts.smokeEvidencePath],
            exitCode: undefined,
            failureCategory: "malformed_input",
            failureReason: `smoke evidence revision "${evidence.repositoryRevision}" does not match expected revision "${opts.expectedRevision}"`,
          }
        }

        // Ticket 03: computeOverallPassed applies required/optional semantics
        // (optional absence does not flip a deterministic failure to pass).
        const gatePassed = computeOverallPassed(evidence.results, evidence.profile)
        const failedCount = evidence.results.filter((r) => r.status !== "passed").length
        return {
          ...baseResult,
          args: [opts.smokeEvidencePath],
          exitCode: gatePassed ? 0 : 1,
          failureCategory: gatePassed ? "none" : "non_zero_exit",
          failureReason: gatePassed
            ? undefined
            : `${failedCount} probes did not pass`,
          outputTail: evidence.results.map((r) => `${r.name}: ${r.status}`),
          evidence: evidence.results,
        }
      } catch (err) {
        return {
          ...baseResult,
          args: [opts.smokeEvidencePath],
          exitCode: undefined,
          failureCategory: "malformed_input",
          failureReason: err instanceof Error ? err.message : String(err),
        }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Default gate sets
// ---------------------------------------------------------------------------

const NPM_TEST_TIMEOUT_MS = 600_000
const BUILD_TIMEOUT_MS = 120_000
const SCHEMA_TIMEOUT_MS = 30_000
const GIT_TIMEOUT_MS = 10_000

export function defaultLocalGates(options: { cwd: string }): GateDefinition[] {
  const { cwd } = options
  return [
    makeSubprocessGate("npm_test", "npm", ["test"], NPM_TEST_TIMEOUT_MS, cwd, true),
    makeSubprocessGate(
      "tsc_build",
      process.execPath,
      ["./node_modules/typescript/bin/tsc", "--noEmit"],
      BUILD_TIMEOUT_MS,
      cwd,
    ),
    makeSubprocessGate(
      "frontend_build",
      "npm",
      ["run", "build:frontend"],
      BUILD_TIMEOUT_MS,
      cwd,
      true,
    ),
    makeSubprocessGate(
      "schema_verify",
      process.execPath,
      ["--import", "tsx", "scripts/verify-schema.ts"],
      SCHEMA_TIMEOUT_MS,
      cwd,
    ),
    makeHardInvariantsGate("local"),
    makeSubprocessGate("git_diff_check", "git", ["diff", "--check"], GIT_TIMEOUT_MS, cwd),
  ]
}

export function defaultProductionGates(options: {
  cwd: string
  evaluationInputPath?: string
  smokeEvidencePath?: string
}): GateDefinition[] {
  const { cwd } = options
  return [
    makeSubprocessGate("npm_test", "npm", ["test"], NPM_TEST_TIMEOUT_MS, cwd, true),
    makeSubprocessGate(
      "tsc_build",
      process.execPath,
      ["./node_modules/typescript/bin/tsc", "--noEmit"],
      BUILD_TIMEOUT_MS,
      cwd,
    ),
    makeSubprocessGate(
      "frontend_build",
      "npm",
      ["run", "build:frontend"],
      BUILD_TIMEOUT_MS,
      cwd,
      true,
    ),
    makeSubprocessGate(
      "schema_verify",
      process.execPath,
      ["--import", "tsx", "scripts/verify-schema.ts"],
      SCHEMA_TIMEOUT_MS,
      cwd,
    ),
    makeHardInvariantsGate("production"),
    makeCleanWorktreeGate(cwd),
    makeSmokeEvidenceGate(),
  ]
}

// ---------------------------------------------------------------------------
// runReleaseVerification — orchestrate gates and assemble artifact
// ---------------------------------------------------------------------------

function getGitRevision(): string {
  try {
    return execSync("git rev-parse HEAD", {
      encoding: "utf8",
      timeout: 5_000,
    }).trim()
  } catch {
    return "unknown"
  }
}

function isWorktreeDirty(): boolean {
  try {
    const output = execSync("git status --porcelain", {
      encoding: "utf8",
      timeout: 5_000,
    }).trim()
    return output.length > 0
  } catch {
    return true
  }
}

/**
 * Ticket 04: Compute SHA-256 hash of canonical evidence sections.
 * Covers: gates, hardInvariantStatus, hardInvariantResults, smokeResults,
 * rollbackEvidence, overallPassed. Excludes nonDeterministicReports
 * (they can change without invalidating deterministic evidence).
 */
export function computeEvidenceHash(
  artifact: Omit<ReleaseRunnerArtifact, "evidenceHash" | "nonDeterministicReports">,
): string {
  const canonical = JSON.stringify({
    schemaVersion: artifact.schemaVersion,
    profile: artifact.profile,
    repositoryRevision: artifact.repositoryRevision,
    gates: artifact.gates.map((g) => ({
      name: g.name,
      command: g.command,
      args: g.args,
      exitCode: g.exitCode,
      failureCategory: g.failureCategory,
      blocked: g.blocked,
    })),
    hardInvariantStatus: artifact.hardInvariantStatus,
    hardInvariantResults: artifact.hardInvariantResults,
    smokeResults: artifact.smokeResults,
    overallPassed: artifact.overallPassed,
    dirtyWorktree: artifact.dirtyWorktree,
    rollbackEvidence: artifact.rollbackEvidence ?? null,
  })
  return createHash("sha256").update(canonical).digest("hex")
}

/**
 * Extract HardInvariantResult[] from the hard_invariants gate's evidence field.
 */
function extractHardInvariantResults(
  gates: GateResult[],
): HardInvariantResult[] {
  const hi = gates.find((g) => g.name === "hard_invariants")
  if (!hi || !hi.evidence) return []
  return hi.evidence as HardInvariantResult[]
}

/**
 * Extract ProbeRunResult[] from the smoke_evidence gate's evidence field.
 * Ticket 03: aligned with SmokeEvidence.results (ProbeRunResult[]) — not legacy SmokeResult[].
 */
function extractSmokeResults(gates: GateResult[]): ProbeRunResult[] {
  const smoke = gates.find((g) => g.name === "smoke_evidence")
  if (!smoke || !smoke.evidence) return []
  return smoke.evidence as ProbeRunResult[]
}

function deriveHardInvariantStatus(
  gates: GateResult[],
): HardInvariantStatus {
  const hi = gates.find((g) => g.name === "hard_invariants")
  if (!hi) return "not_run"
  if (hi.blocked === true) return "blocked"
  if (hi.failureCategory === "malformed_input") return "malformed"
  if (hi.failureCategory === "none" && hi.exitCode === 0) return "passed"
  return "failed"
}

export async function runReleaseVerification(options: {
  profile: EvaluationProfile
  outputPath: string
  gates?: GateDefinition[]
  repositoryRevision?: string
  evaluationInputPath?: string
  smokeEvidencePath?: string
}): Promise<ReleaseRunnerArtifact> {
  const {
    profile,
    outputPath,
    evaluationInputPath,
    smokeEvidencePath,
  } = options

  // Ticket 03: compute revision before running gates so the smoke_evidence gate
  // can bind evidence.repositoryRevision to the release artifact's revision.
  const repositoryRevision = options.repositoryRevision ?? getGitRevision()

  const gates =
    options.gates ??
    (profile === "production"
      ? defaultProductionGates({
          cwd: process.cwd(),
          evaluationInputPath,
          smokeEvidencePath,
        })
      : defaultLocalGates({ cwd: process.cwd() }))

  const gateResults: GateResult[] = []
  for (const gate of gates) {
    const result = await gate.run({
      signal: undefined,
      outputTailLines: 50,
      evaluationInputPath,
      smokeEvidencePath,
      releaseProfile: profile,
      expectedRevision: repositoryRevision,
    })
    gateResults.push(result)
  }

  const hardInvariantStatus = deriveHardInvariantStatus(gateResults)
  const hardInvariantResults = extractHardInvariantResults(gateResults)
  const smokeResults = extractSmokeResults(gateResults)
  const overallPassed = gateResults.every(
    (g) => g.failureCategory === "none",
  )
  const productionReady = profile === "production" && overallPassed
  const dirtyWorktree = isWorktreeDirty()

  const artifact: ReleaseRunnerArtifact = {
    schemaVersion: 2,
    profile,
    generatedAt: new Date().toISOString(),
    repositoryRevision,
    gates: gateResults,
    hardInvariantStatus,
    hardInvariantResults,
    smokeResults,
    overallPassed,
    productionReady,
    dirtyWorktree,
    evidenceHash: "", // computed below after assembly
  }

  artifact.evidenceHash = computeEvidenceHash(artifact)

  writeFileSync(outputPath, JSON.stringify(artifact, null, 2) + "\n", "utf8")

  return artifact
}
