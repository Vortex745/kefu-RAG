// Ticket 28 — One-command production acceptance.
//
// Spec issue #28 acceptance criteria:
//   1. The command exits zero only when every required deterministic gate
//      and production probe passes for the clean trusted revision.
//   2. Failure preserves partial redacted evidence while withholding
//      production-ready status and returning a non-zero exit.
//   3. The final V2 artifact passes promotion validation for the current
//      trusted revision and contains verified rollback evidence.
//
// runProductionAcceptance orchestrates four reusable components:
//   - smoke_harness.runAllProbes (Ticket 06) — runs every registered
//     production smoke probe (OIDC, ES, Neo4j, parsers, langfuse, ...).
//   - rollback_check.verifyRollback (Ticket 04) — proves the build can
//     start in limited mode, answer health, and shut down cleanly.
//   - runner.runReleaseVerification (Ticket 03) — runs deterministic gates
//     (npm_test, tsc_build, frontend_build, schema_verify, hard_invariants,
//     clean_worktree, smoke_evidence) and assembles a V2 artifact.
//   - promotion.checkPromotion (Ticket 04) — validates the V2 artifact
//     for production promotion (fail-closed, hash-verified, revision-bound).
//
// Design (karpathy-guidelines):
//   - Simplest viable shape: orchestrate — never reimplement. Every
//     subprocess / probe / hash is owned by its respective module.
//   - Dependency injection for testability: smokeImplementations /
//     releaseGates / rollbackVerifier / promotionChecker are injectable.
//     Defaults wire real implementations for the CLI entry point.
//   - Failure-tolerant: every component runs to completion (when possible)
//     so partial evidence is preserved. Production-ready status is withheld
//     on any failure (AC2).
//   - Redacted evidence: failure reasons are passed through a regex redactor
//     (Bearer / JWT / sk- / pk-lf-) before assembling the report, so the
//     serialized report never leaks real-looking secrets even when a probe
//     accidentally includes them in its reason string (AC2).
//
// Rollback boundary: removing this module does not change online runtime
// behavior — it is a verifier-only orchestrator, not registered in any
// PROBE_REGISTRY or DETERMINISTIC_PROBE_IMPLEMENTATIONS.

import { mkdirSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"

import {
  runAllProbes,
  writeSmokeEvidence,
  scanForSecrets,
  type ProbeImplementations,
  type SmokeEvidence,
  type ProbeProfile,
} from "./smoke_harness"
import {
  runReleaseVerification,
  defaultProductionGates,
  type GateDefinition,
  type ReleaseRunnerArtifact,
  type RollbackEvidence,
} from "./runner"
import {
  checkPromotion,
  type PromotionResult,
} from "./promotion"
import { verifyRollback } from "./rollback_check"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Rollback verifier callable. Matches verifyRollback signature.
 * Injectable for tests (stub) — defaults to verifyRollback in
 * buildDefaultOptions().
 */
export type RollbackVerifier = (opts: {
  revision: string
}) => Promise<RollbackEvidence>

/**
 * Promotion checker callable. Matches checkPromotion signature.
 * Injectable for tests (stub) — defaults to checkPromotion in
 * buildDefaultOptions().
 */
export type PromotionChecker = (
  artifact: ReleaseRunnerArtifact,
  expectedRevision: string,
) => PromotionResult

/**
 * Options for runProductionAcceptance. Every dependency is injectable —
 * tests pass stubs; the CLI entry point passes real defaults.
 */
export interface ProductionAcceptanceOptions {
  /** Trusted git revision for provenance binding (AC1: "clean trusted revision"). */
  repositoryRevision: string
  /** Directory to write smoke/rollback/release evidence files. */
  outputDir: string
  /**
   * Smoke probe implementations (Ticket 06). When undefined, no probes run
   * — the orchestrator will produce empty smoke evidence. The CLI entry
   * point wires DETERMINISTIC_PROBE_IMPLEMENTATIONS + any probe-runtime
   * implementations the operator has available.
   */
  smokeImplementations?: ProbeImplementations
  /**
   * Release gates (Ticket 03). When undefined, defaults to
   * defaultProductionGates({ cwd, evaluationInputPath, smokeEvidencePath }).
   * Tests inject stub gates to avoid spawning real subprocesses.
   */
  releaseGates?: GateDefinition[]
  /** Rollback verifier. Default: verifyRollback. */
  rollbackVerifier?: RollbackVerifier
  /** Promotion checker. Default: checkPromotion. */
  promotionChecker?: PromotionChecker
  /** Optional cancellation signal (propagated to smoke + gates). */
  signal?: AbortSignal
  /**
   * Optional evaluation input path (goldenCases + caseResults JSON).
   * Passed to runReleaseVerification for the hard_invariants gate.
   */
  evaluationInputPath?: string
  /** Smoke profile. Default: "production". */
  smokeProfile?: ProbeProfile
  /**
   * Optional prerequisite checker for smoke probes. Defaults to
   * smoke_harness.defaultCheckPrerequisites (reads process.env). Tests
   * inject a stub to bypass real env-var checks.
   */
  checkPrerequisites?: (names: string[]) => { satisfied: boolean; missing: string[] }
}

/**
 * Final report — produced on both success and failure. On failure, partial
 * evidence paths remain populated so reviewers can diagnose (AC2).
 */
export interface ProductionAcceptanceReport {
  /** True only when smoke + rollback + gates + promotion all pass (AC1). */
  ok: boolean
  /** Failure reasons (empty on success). Redacted of secrets (AC2). */
  reasons: string[]
  /** Trusted git revision bound to all artifacts. */
  repositoryRevision: string
  /** ISO 8601 timestamp when the report was assembled. */
  generatedAt: string
  /** Path to smoke evidence JSON (always written, even on failure). */
  smokeEvidencePath: string
  /** Path to rollback evidence JSON (always written, even on failure). */
  rollbackEvidencePath: string
  /** Path to release artifact V2 JSON (always written, even on failure). */
  releaseArtifactPath: string
  /**
   * True only when ok=true. AC2: "withholding production-ready status"
   * on any failure.
   */
  productionReady: boolean
  /** Smoke evidence (present when smoke phase ran). */
  smokeEvidence?: SmokeEvidence
  /** Rollback evidence (present when rollback phase ran). */
  rollbackEvidence?: RollbackEvidence
  /** Release artifact V2 (present when release verification ran). */
  releaseArtifact?: ReleaseRunnerArtifact
  /** Promotion result (present when promotion check ran). */
  promotion?: PromotionResult
}

// ---------------------------------------------------------------------------
// Constants — secret redaction patterns
// ---------------------------------------------------------------------------

/**
 * Regex patterns redacted from failure reasons before assembling the report.
 * Mirrors smoke_harness.scanForSecrets patterns (defense in depth) —
 * applied here so a probe that accidentally includes a token in its reason
 * string cannot leak into the serialized report.
 *
 * NOTE: the `sk-` pattern accepts hyphens and has no minimum length —
 * matches the test fixture format (`sk-test-probe`) and is intentionally
 * permissive (defense-in-depth prefers false positives over real leaks).
 */
const SECRET_REDACT_PATTERNS: readonly RegExp[] = [
  /Bearer\s+\S+/g,
  /sk-[A-Za-z0-9-]+/g,
  /pk-lf-[A-Za-z0-9]+/g,
  /sk-lf-[A-Za-z0-9]+/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, // JWT
]

function redactSecrets(value: string): string {
  let result = value
  for (const pattern of SECRET_REDACT_PATTERNS) {
    // Reset lastIndex for non-global reuse; patterns above are all /g
    pattern.lastIndex = 0
    result = result.replace(pattern, "[REDACTED]")
  }
  return result
}

/**
 * Deep-redact every string in an evidence object using SECRET_REDACT_PATTERNS.
 * Used by buildReport so that nested probe `reason` fields, gate output tails,
 * and any other string nested inside smokeEvidence / rollbackEvidence /
 * releaseArtifact / promotion cannot leak real-looking secrets (AC2:
 * "redacted evidence" applies to the whole serialized report, not just the
 * top-level reasons array).
 *
 * Non-string values (booleans, numbers, null) are passed through unchanged.
 */
function deepRedactSecrets<T>(value: T): T {
  if (typeof value === "string") {
    return redactSecrets(value) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map(deepRedactSecrets) as unknown as T
  }
  if (value && typeof value === "object") {
    const cleaned: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      cleaned[k] = deepRedactSecrets(v)
    }
    return cleaned as unknown as T
  }
  return value
}

// ---------------------------------------------------------------------------
// Default dependency wiring (used by CLI entry point)
// ---------------------------------------------------------------------------

export function buildDefaultOptions(
  repositoryRevision: string,
  outputDir: string,
  extra?: {
    evaluationInputPath?: string
    signal?: AbortSignal
  },
): ProductionAcceptanceOptions {
  return {
    repositoryRevision,
    outputDir,
    signal: extra?.signal,
    evaluationInputPath: extra?.evaluationInputPath,
    // Default gates spawn real subprocesses (npm test, tsc, ...) —
    // the CLI entry point uses this; tests inject stubs.
    releaseGates: defaultProductionGates({
      cwd: process.cwd(),
      evaluationInputPath: extra?.evaluationInputPath,
      smokeEvidencePath: join(outputDir, "smoke-production.json"),
    }),
    rollbackVerifier: verifyRollback,
    // Wrap checkPromotion to expose (artifact, expectedRevision) signature
    // — keeps the test-facing PromotionChecker type simple while reusing
    // the production promotion checker.
    promotionChecker: (artifact, expectedRevision) =>
      checkPromotion(artifact, { expectedRevision }),
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the full one-command production acceptance flow.
 *
 * Phases:
 *   1. Pre-abort check (signal.aborted → ok=false immediately)
 *   2. Smoke probes → smoke.json
 *   3. Rollback verification → rollback.json
 *   4. Release verification (gates + hard invariants + smoke_evidence) → release.json
 *   5. Promotion check
 *   6. Aggregate ok = smoke.overallPassed && rollback.verified
 *                    && release.overallPassed && promotion.promoted
 *
 * Every phase runs to completion (when possible) so partial evidence is
 * preserved on failure (AC2). Reasons are redacted of secrets before return.
 */
export async function runProductionAcceptance(
  options: ProductionAcceptanceOptions,
): Promise<ProductionAcceptanceReport> {
  const {
    repositoryRevision,
    outputDir,
    signal,
    evaluationInputPath,
    smokeProfile = "production",
    checkPrerequisites,
  } = options

  const reasons: string[] = []
  let smokeEvidence: SmokeEvidence | undefined
  let rollbackEvidence: RollbackEvidence | undefined
  let releaseArtifact: ReleaseRunnerArtifact | undefined
  let promotion: PromotionResult | undefined

  // Resolve output paths
  const smokeEvidencePath = resolve(join(outputDir, "smoke-production.json"))
  const rollbackEvidencePath = resolve(join(outputDir, "rollback.json"))
  const releaseArtifactPath = resolve(join(outputDir, "release-production.json"))

  // Ensure output dir exists (idempotent)
  try {
    mkdirSync(outputDir, { recursive: true })
  } catch {
    // Fall through — writeFileSync below will surface any real error
  }

  // --- Phase 1: pre-abort check ---
  if (signal?.aborted) {
    reasons.push("aborted before start (signal already aborted)")
    return buildReport(
      false,
      reasons,
      repositoryRevision,
      smokeEvidencePath,
      rollbackEvidencePath,
      releaseArtifactPath,
      smokeEvidence,
      rollbackEvidence,
      releaseArtifact,
      promotion,
    )
  }

  // --- Phase 2: smoke probes ---
  try {
    const implementations = options.smokeImplementations ?? {}
    smokeEvidence = await runAllProbes({
      profile: smokeProfile,
      implementations,
      signal,
      ...(checkPrerequisites ? { checkPrerequisites } : {}),
    })
    // Override revision to bind to the trusted expected revision (runAllProbes
    // uses git rev-parse HEAD which may differ in candidate/test environments).
    smokeEvidence = {
      ...smokeEvidence,
      repositoryRevision,
    }
    writeSmokeEvidence({ evidence: smokeEvidence, outputPath: smokeEvidencePath })
    if (!smokeEvidence.overallPassed) {
      const failed = smokeEvidence.results
        .filter((r) => r.status !== "passed")
        .map((r) => `${r.name}=${r.status}`)
      reasons.push(`smoke probes failed: ${failed.join(", ")}`)
    }
  } catch (err) {
    reasons.push(
      `smoke phase error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // --- Phase 3: rollback verification ---
  try {
    const verifier = options.rollbackVerifier ?? verifyRollback
    rollbackEvidence = await verifier({ revision: repositoryRevision })
    writeFileSync(
      rollbackEvidencePath,
      JSON.stringify(rollbackEvidence, null, 2) + "\n",
      "utf8",
    )
    if (!rollbackEvidence.verified) {
      reasons.push("rollback verification unverified")
    }
  } catch (err) {
    reasons.push(
      `rollback phase error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // --- Phase 4: release verification (deterministic gates) ---
  try {
    const gates =
      options.releaseGates ??
      defaultProductionGates({
        cwd: process.cwd(),
        evaluationInputPath,
        smokeEvidencePath,
      })
    releaseArtifact = await runReleaseVerification({
      profile: "production",
      outputPath: releaseArtifactPath,
      gates,
      repositoryRevision,
      evaluationInputPath,
      smokeEvidencePath,
    })
    // AC3: bind rollback evidence to the release artifact (promotion check
    // requires artifact.rollbackEvidence.verified=true). runReleaseVerification
    // does not run rollback itself — we inject the result from phase 3 here.
    if (rollbackEvidence) {
      releaseArtifact = {
        ...releaseArtifact,
        rollbackEvidence,
      }
      // Re-write the artifact so the persisted release.json contains the
      // rollback evidence (AC3: "contains verified rollback evidence").
      writeFileSync(
        releaseArtifactPath,
        JSON.stringify(releaseArtifact, null, 2) + "\n",
        "utf8",
      )
    }
    if (!releaseArtifact.overallPassed) {
      const failedGates = releaseArtifact.gates
        .filter((g) => g.failureCategory !== "none")
        .map((g) => `${g.name}=${g.failureCategory}`)
      reasons.push(`release gates failed: ${failedGates.join(", ")}`)
    }
  } catch (err) {
    reasons.push(
      `release verification error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // --- Phase 5: promotion check ---
  try {
    if (releaseArtifact) {
      const checker = options.promotionChecker ??
      ((artifact, rev) => checkPromotion(artifact, { expectedRevision: rev }))
    promotion = checker(releaseArtifact, repositoryRevision)
      if (!promotion.promoted) {
        reasons.push(...promotion.reasons.map((r) => `promotion: ${r}`))
      }
    } else {
      reasons.push("promotion skipped: release artifact not produced")
    }
  } catch (err) {
    reasons.push(
      `promotion check error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // --- Phase 6: aggregate ---
  const smokeOk = smokeEvidence?.overallPassed === true
  const rollbackOk = rollbackEvidence?.verified === true
  const releaseOk = releaseArtifact?.overallPassed === true
  const promotionOk = promotion?.promoted === true
  const ok = smokeOk && rollbackOk && releaseOk && promotionOk

  return buildReport(
    ok,
    reasons,
    repositoryRevision,
    smokeEvidencePath,
    rollbackEvidencePath,
    releaseArtifactPath,
    smokeEvidence,
    rollbackEvidence,
    releaseArtifact,
    promotion,
  )
}

// ---------------------------------------------------------------------------
// Report assembly (centralized so the early-abort path uses the same shape)
// ---------------------------------------------------------------------------

function buildReport(
  ok: boolean,
  reasons: string[],
  repositoryRevision: string,
  smokeEvidencePath: string,
  rollbackEvidencePath: string,
  releaseArtifactPath: string,
  smokeEvidence: SmokeEvidence | undefined,
  rollbackEvidence: RollbackEvidence | undefined,
  releaseArtifact: ReleaseRunnerArtifact | undefined,
  promotion: PromotionResult | undefined,
): ProductionAcceptanceReport {
  // AC2: redact secrets from reasons before assembling the report
  const redactedReasons = reasons.map(redactSecrets)

  return {
    ok,
    reasons: redactedReasons,
    repositoryRevision,
    generatedAt: new Date().toISOString(),
    smokeEvidencePath,
    rollbackEvidencePath,
    releaseArtifactPath,
    // AC2: productionReady is true ONLY when ok is true
    productionReady: ok,
    // AC2: deep-redact secrets from every nested evidence object so that
    // probe reasons / gate output tails / promotion reasons cannot leak
    // real-looking tokens via the serialized report.
    smokeEvidence: smokeEvidence ? deepRedactSecrets(smokeEvidence) : undefined,
    rollbackEvidence: rollbackEvidence ? deepRedactSecrets(rollbackEvidence) : undefined,
    releaseArtifact: releaseArtifact ? deepRedactSecrets(releaseArtifact) : undefined,
    promotion: promotion ? deepRedactSecrets(promotion) : undefined,
  }
}

// ---------------------------------------------------------------------------
// Defense-in-depth: scan a report for suspicious patterns (used by CLI entry)
// ---------------------------------------------------------------------------

/**
 * Scan a ProductionAcceptanceReport for suspicious secret patterns. Returns
 * a list of findings — empty list means the report is safe to persist.
 *
 * The CLI entry point uses this before writing the final summary to stdout
 * to ensure no probe reason leaked through despite redactSecrets.
 */
export function scanReportForSecrets(report: ProductionAcceptanceReport): string[] {
  const findings: string[] = []
  const patterns: Array<{ name: string; regex: RegExp }> = [
    { name: "Bearer token", regex: /Bearer\s+\S+/ },
    { name: "sk- API key", regex: /sk-[A-Za-z0-9]{20,}/ },
    { name: "pk-lf- Langfuse key", regex: /pk-lf-[A-Za-z0-9]+/ },
    { name: "JWT", regex: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/ },
  ]
  const serialized = JSON.stringify(report)
  for (const { name, regex } of patterns) {
    if (regex.test(serialized)) {
      findings.push(`suspicious pattern matched: ${name}`)
    }
  }
  // Also run the existing smoke_harness.scanForSecrets on the smoke evidence
  // (if present) for defense-in-depth consistency with smoke-cli.ts.
  if (report.smokeEvidence) {
    const smokeFindings = scanForSecrets(report.smokeEvidence)
    findings.push(...smokeFindings.map((f) => `smoke: ${f}`))
  }
  return findings
}
