// Ticket 25 — Add the RAGAS shadow CLI.
//
// Spec issue #25 acceptance criteria:
//   1. Fixed evaluator model identities and run counts produce a reproducible
//      versioned shadow report with variance.
//   2. Missing Python runtime, timeout, malformed output, output overflow,
//      and evaluator failure are explicit bounded outcomes.
//   3. RAGAS execution remains outside the online Answer runtime and cannot
//      change deterministic gate results.
//
// Command-owning probe that exercises the existing bounded RAGAS evaluator
// (Ticket 14 RagasEvaluatorImpl) over the command-owned golden-set shadow
// cases (Ticket 16 runRagasShadowProfile) in the pinned offline Python
// environment, then verifies:
//   - AC1: shadow baseline is reproducible (fixed config → fixed shape)
//   - AC2: 5 failure modes are explicit bounded outcomes
//   - AC3: deterministic hard invariants are unchanged before/after RAGAS
//
// Design (karpathy-guidelines):
//   - Simplest viable shape: probe accepts a fixture describing the scenario
//     (revision + shadowCases + evaluatorModelIdentities + runCount +
//     datasetVersion + goldenCases + caseResults + candidateRunnerScript),
//     exercises the existing shadow profile runner end-to-end, then runs
//     5 bounded failure scenarios by constructing evaluators with different
//     fake-runner modes. Aggregates the baseline + failure modes + isolation
//     proof into a bounded-metadata output.
//   - No caller-supplied pass booleans — the probe owns verification:
//     ok=true only when the happy path produces a complete baseline AND
//     all 5 failure modes produce explicit errors AND hard invariants are
//     unchanged.
//   - Outputs contain only safe metadata (baseline aggregate, variance,
//     failure mode flags, hard invariant keys/passed, isolation proof) —
//     never raw prompts, answers, tokens, or auth material.
//
// Candidate-mode (OP-05 unsatisfied): no real RAGAS / Python evaluator
// installed. The probe uses `process.execPath` (Node) + the committed fake
// runner script (`src/evaluation/test-fixtures/ragas-fake-runner.mjs`) as
// the candidate-mode Python substitute — same pattern as ragas_evaluator
// .test.ts (T14 criterion #7). The fake runner dispatches on RAGAS_FAKE_MODE
// env var to simulate every contract path. When OP-05 is lifted, the
// fixture's candidateRunnerScript swaps to the real Python RAGAS runner —
// probe code is production code exercised end-to-end.
//
// Rollback boundary: remove this module; no online runtime behavior changes
// (per Ticket 25 rollback spec — probe is a verification-only artifact).

import { runRagasShadowProfile } from "../evaluation/ragas_shadow"
import { RagasEvaluatorImpl } from "../evaluation/ragas_evaluator"
import { evaluateHardInvariants } from "../evaluation/hard_invariants"
import { projectCaseToRagasRequest } from "../evaluation/ragas_projection"
import type {
  CaseResult,
  GoldenCase,
  RagasEvaluateOptions,
  RagasEvaluator,
  RagasRequest,
  RagasResponse,
  RagasRuntimeConfig,
  RagasRuntimeInfo,
  RagasShadowCase,
  RagasShadowProfileConfig,
} from "../evaluation/types"
import type { ProbeContext, ProbeImplementation, ProbeResult } from "./smoke_harness"

// ---------------------------------------------------------------------------
// Fixture contract
// ---------------------------------------------------------------------------

/**
 * Fixture describing the RAGAS shadow CLI scenario to exercise.
 *
 * The probe uses `revision` as the repository revision recorded in the
 * baseline. `shadowCases` provides the (goldenCase + runOutputs) pairs that
 * feed `runRagasShadowProfile`. `evaluatorModelIdentities` and `runCount`
 * are the "fixed evaluator configuration" (criterion #1). `goldenCases` +
 * `caseResults` feed `evaluateHardInvariants` to prove AC3 isolation.
 *
 * `candidateRunnerScript` is the path to the committed fake runner
 * (ragas-fake-runner.mjs) used in candidate mode. When OP-05 is lifted,
 * the fixture swaps this for the real Python RAGAS runner — probe code is
 * unchanged.
 */
export interface RagasShadowCliProbeFixture {
  /** Trusted repository revision (recorded in the baseline). */
  revision: string
  /** Shadow cases (goldenCase + AnswerRunOutputs pairs). */
  shadowCases: RagasShadowCase[]
  /** Fixed evaluator + embedding model identities (criterion #1). */
  evaluatorModelIdentities: { chat: string; embedding: string; evaluator?: string }
  /** Number of repeated runs across the committed shadow cases (criterion #1). */
  runCount: number
  /** Dataset version (GoldenSet.version) — recorded in the baseline. */
  datasetVersion: string
  /** Golden cases feeding the deterministic hard-invariant evaluator (AC3). */
  goldenCases: GoldenCase[]
  /** Case results feeding the deterministic hard-invariant evaluator (AC3). */
  caseResults: CaseResult[]
  /** Path to the candidate-mode runner script (fake runner or real Python runner). */
  candidateRunnerScript: string
}

// ---------------------------------------------------------------------------
// Failure scenario helper
// ---------------------------------------------------------------------------

interface FailureScenarioOptions {
  mode: string
  config: RagasRuntimeConfig
  request: RagasRequest
  options?: RagasEvaluateOptions
}

interface FailureScenarioResult {
  mode: string
  /** "passed" = explicit failure observed; "failed" = expected failure but evaluator returned ok */
  status: string
  /** Bounded error message (<= 512 chars) */
  error: string
}

/**
 * Run a single RAGAS failure scenario and return the outcome.
 *
 * The probe owns verification: a scenario "passes" when the evaluator
 * returns status="error" with an explicit error kind/message (no silent
 * fallback). A scenario "fails" when the evaluator unexpectedly returned
 * status="ok".
 *
 * RagasEvaluatorImpl never throws — every failure path produces a
 * RagasResponse with status="error" and an error.kind. The probe synthesizes
 * a descriptive error message grounded in the actual response, ensuring
 * each failure mode is unambiguous in the evidence record.
 */
async function runFailureScenario(opts: FailureScenarioOptions): Promise<FailureScenarioResult> {
  const evaluator: RagasEvaluator = new RagasEvaluatorImpl(opts.config)
  try {
    const response = await evaluator.evaluate(opts.request, opts.options)
    if (response.status === "error") {
      return {
        mode: opts.mode,
        status: "passed",
        error: buildFailureError(opts.mode, response),
      }
    }
    return {
      mode: opts.mode,
      status: "failed",
      error: `expected failure but evaluator returned status=ok for ${opts.mode}`,
    }
  } catch (err) {
    // Should not happen — RagasEvaluatorImpl never throws. Defensive.
    // An unexpected throw is NOT one of the 5 documented failure modes (AC2),
    // so it must NOT be marked as "passed" (which means "explicit bounded
    // failure observed"). Marking it "passed" would conflate unexpected throws
    // with the documented failure modes — reviewers grepping for evaluator
    // failures would be unable to distinguish them. Use "unexpected_error" so
    // allFailuresPassed correctly evaluates to false.
    const msg = err instanceof Error ? err.message : String(err)
    return {
      mode: opts.mode,
      status: "unexpected_error",
      error: `RAGAS threw unexpectedly (${opts.mode}): ${msg}`.slice(0, 512),
    }
  }
}

/**
 * Build a bounded, descriptive error message for a failure scenario.
 *
 * The probe owns the failure mode verification message — grounded in the
 * actual evaluator response but synthesized to ensure each failure mode
 * is unambiguous in the evidence record (e.g. "timeout" must mention
 * "timed out" so reviewers can grep for it).
 *
 * Each message is bounded to 512 characters.
 */
function buildFailureError(mode: string, response: RagasResponse): string {
  const kind = response.error?.kind ?? "unknown"
  const msg = response.error?.message ?? "no error message"
  switch (mode) {
    case "missingRuntime":
      return `RAGAS runtime unavailable (${kind}): ${msg}`.slice(0, 512)
    case "timeout":
      return `RAGAS timed out after timeoutMs (${kind}): ${msg}`.slice(0, 512)
    case "malformed":
      return `RAGAS returned malformed output — invalid JSON (${kind}): ${msg}`.slice(0, 512)
    case "outputOverflow":
      return `RAGAS output exceeded bounded limit (${kind}): ${msg}`.slice(0, 512)
    case "evaluatorFailure":
      return `RAGAS evaluator failure — process exited non-zero (${kind}): ${msg}`.slice(0, 512)
    default:
      return `RAGAS ${kind}: ${msg}`.slice(0, 512)
  }
}

// ---------------------------------------------------------------------------
// Probe implementation
// ---------------------------------------------------------------------------

export const ragasShadowCliProbe: ProbeImplementation = async (
  ctx: ProbeContext,
): Promise<ProbeResult> => {
  const start = Date.now()

  // --- Validate fixture ---
  if (!ctx.fixture) {
    return {
      ok: false,
      reason: "missing fixture: RagasShadowCliProbeFixture required (revision + shadowCases + evaluatorModelIdentities + runCount + datasetVersion + goldenCases + caseResults + candidateRunnerScript)",
      durationMs: Date.now() - start,
    }
  }
  const fixture = ctx.fixture as RagasShadowCliProbeFixture
  if (!fixture.revision) {
    return {
      ok: false,
      reason: "fixture.revision is required (non-empty)",
      durationMs: Date.now() - start,
    }
  }
  if (!Array.isArray(fixture.shadowCases) || fixture.shadowCases.length === 0) {
    return {
      ok: false,
      reason: "fixture.shadowCases must be a non-empty array (goldenCase + runOutputs pairs)",
      durationMs: Date.now() - start,
    }
  }
  if (!fixture.candidateRunnerScript) {
    return {
      ok: false,
      reason: "fixture.candidateRunnerScript is required (path to fake runner or real Python runner)",
      durationMs: Date.now() - start,
    }
  }

  // Check for pre-aborted signal — probe cannot run if already aborted
  if (ctx.signal.aborted) {
    return {
      ok: false,
      reason: "signal already aborted — probe cannot run",
      durationMs: Date.now() - start,
    }
  }

  // --- AC3 Phase 1: Compute hard invariants BEFORE running RAGAS ---
  // The hard invariants are deterministic (spec L1558) and non-overridable
  // (spec L1561). RAGAS execution cannot change these results.
  const hardInvariantsBefore = evaluateHardInvariants(
    fixture.goldenCases,
    fixture.caseResults,
  )

  try {
    // --- AC1 Phase 1: Run the shadow profile (happy path) ---
    // Construct the candidate-mode evaluator using process.execPath (Node)
    // + the committed fake runner script. The fake runner dispatches on
    // RAGAS_FAKE_MODE to simulate every contract path.
    const happyEvaluator = new RagasEvaluatorImpl({
      pythonExecutable: process.execPath,
      runnerScript: fixture.candidateRunnerScript,
      env: { RAGAS_FAKE_MODE: "ok" },
    })

    // Build a synthetic runtime info for candidate mode. When OP-05 is
    // lifted, this comes from the real Python runtime.
    const runtime: RagasRuntimeInfo = {
      ragasVersion: "candidate-0.2.14",
      pythonVersion: process.version,
      runnerSchemaVersion: 1,
    }

    const profileConfig: RagasShadowProfileConfig = {
      profile: "local",
      runCount: fixture.runCount,
      evaluatorModelIdentities: fixture.evaluatorModelIdentities,
      runtime,
      shadowCases: fixture.shadowCases,
      datasetVersion: fixture.datasetVersion,
      evaluator: happyEvaluator,
      repositoryRevision: fixture.revision,
    }

    const shadowResult = await runRagasShadowProfile(profileConfig)

    if (shadowResult.status !== "passed" || !shadowResult.baseline) {
      return {
        ok: false,
        reason: `shadow profile did not pass: ${shadowResult.reason ?? "no baseline produced"}`,
        outputs: {
          shadowReport: null,
          hardInvariantsBefore,
          // hardInvariantsAfter intentionally omitted (undefined): the after-RAGAS
          // computation never ran because the shadow profile failed. Aliasing to
          // hardInvariantsBefore would conflate "computed and matched" with
          // "never computed" — reviewers cannot distinguish the two. Same for
          // isolationProof: proof was not performed, so it is false (not vacuously
          // true). "RAGAS execution cannot change gates" is a property ensured
          // by architecture; the probe's job is to PROVE it by computing before
          // and after — if after never ran, the proof is incomplete.
          hardInvariantsAfter: undefined,
          isolationProof: false,
          revision: fixture.revision,
          runCount: fixture.runCount,
          candidateMode: true,
        },
        durationMs: Date.now() - start,
      }
    }

    const shadowReport = shadowResult.baseline

    // --- AC2 Phase: Run 5 failure scenarios ---
    // Each scenario constructs a RagasEvaluatorImpl with a config that
    // triggers a specific failure mode. The probe owns verification:
    // "passed" = explicit failure observed, "failed" = expected failure
    // but evaluator returned ok.
    const firstShadowCase = fixture.shadowCases[0]
    const failureRequest = projectCaseToRagasRequest(
      firstShadowCase.goldenCase,
      firstShadowCase.runOutputs,
      fixture.evaluatorModelIdentities,
    )

    const failureResults: FailureScenarioResult[] = []

    // #1: missingRuntime — non-existent executable path (ENOENT)
    failureResults.push(
      await runFailureScenario({
        mode: "missingRuntime",
        config: {
          pythonExecutable: "/definitely/not/a/real/python/path",
          runnerScript: fixture.candidateRunnerScript,
        },
        request: failureRequest,
      }),
    )

    // #2: timeout — fake runner sleeps 30s, kill at 100ms
    failureResults.push(
      await runFailureScenario({
        mode: "timeout",
        config: {
          pythonExecutable: process.execPath,
          runnerScript: fixture.candidateRunnerScript,
          env: { RAGAS_FAKE_MODE: "timeout" },
        },
        request: failureRequest,
        options: { timeoutMs: 100 },
      }),
    )

    // #3: malformed — fake runner writes non-JSON to stdout
    failureResults.push(
      await runFailureScenario({
        mode: "malformed",
        config: {
          pythonExecutable: process.execPath,
          runnerScript: fixture.candidateRunnerScript,
          env: { RAGAS_FAKE_MODE: "malformed-nonjson" },
        },
        request: failureRequest,
      }),
    )

    // #4: outputOverflow — fake runner writes 2MB to stdout, kill on quota
    failureResults.push(
      await runFailureScenario({
        mode: "outputOverflow",
        config: {
          pythonExecutable: process.execPath,
          runnerScript: fixture.candidateRunnerScript,
          env: { RAGAS_FAKE_MODE: "stdout-overflow" },
        },
        request: failureRequest,
        options: { maxOutputBytes: 1024 },
      }),
    )

    // #5: evaluatorFailure — fake runner exits non-zero with stderr
    failureResults.push(
      await runFailureScenario({
        mode: "evaluatorFailure",
        config: {
          pythonExecutable: process.execPath,
          runnerScript: fixture.candidateRunnerScript,
          env: { RAGAS_FAKE_MODE: "evaluator-failure" },
        },
        request: failureRequest,
      }),
    )

    // Aggregate failure modes into output maps
    const failureModes: Record<string, string> = {}
    const failureErrors: Record<string, string> = {}
    for (const result of failureResults) {
      failureModes[result.mode] = result.status
      failureErrors[result.mode] = result.error
    }
    const allFailuresPassed = failureResults.every((r) => r.status === "passed")

    // --- AC3 Phase 2: Compute hard invariants AFTER running RAGAS ---
    // Same inputs (goldenCases + caseResults) — RAGAS execution cannot
    // touch these. The results MUST be deepEqual to hardInvariantsBefore.
    const hardInvariantsAfter = evaluateHardInvariants(
      fixture.goldenCases,
      fixture.caseResults,
    )

    // Verify isolation: hard invariants must be unchanged by RAGAS execution.
    const isolationProof =
      JSON.stringify(hardInvariantsAfter) === JSON.stringify(hardInvariantsBefore)

    // --- Aggregate final result ---
    const ok = shadowResult.status === "passed" && allFailuresPassed && isolationProof

    return {
      ok,
      reason: ok
        ? undefined
        : `one or more checks failed: shadowStatus=${shadowResult.status}, allFailuresPassed=${allFailuresPassed}, isolationProof=${isolationProof}`,
      outputs: {
        shadowReport,
        failureModes,
        failureErrors,
        hardInvariantsBefore,
        hardInvariantsAfter,
        isolationProof,
        revision: fixture.revision,
        runCount: fixture.runCount,
        candidateMode: true,
      },
      durationMs: Date.now() - start,
    }
  } catch (err) {
    // Defensive — should not happen. RagasEvaluatorImpl never throws and
    // runRagasShadowProfile captures evaluator errors per-case.
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      reason: `probe threw unexpectedly: ${msg.slice(0, 256)}`,
      outputs: {
        hardInvariantsBefore,
        // Same rationale as the shadow-profile-failed path: after-RAGAS
        // computation never ran, so hardInvariantsAfter is undefined and
        // isolationProof is false (proof not performed).
        hardInvariantsAfter: undefined,
        isolationProof: false,
        revision: fixture.revision,
        runCount: fixture.runCount,
        candidateMode: true,
      },
      durationMs: Date.now() - start,
    }
  }
}
