// Ticket 17 — Release verification artifact (criterion #7).
//
// Spec issue #17 criterion #7:
//   "Focused tests, full repository tests, TypeScript checking, applicable
//    builds, schema verification and optional live smoke profiles are
//    recorded in the final verification artifact"
//
// This module assembles + persists the FINAL verification artifact for a T61
// release. It is intentionally THIN: callers supply the raw verification
// results (test counts, tsc exit code, build outcomes, smoke results). The
// module does NOT execute tests, run tsc, or invoke builds — that is the
// caller's responsibility (CI runner, dev script, etc.).
//
// Design notes (karpathy-guidelines):
//   - Simplest viable shape: one flat artifact, six top-level sections.
//   - No side effects in buildReleaseVerification (pure assembly).
//   - writeReleaseVerification is the only side-effect (file write).
//   - JSON-serializable output — no Date objects, no undefined fields.

import { writeFileSync } from "node:fs"

import type { SmokeResult, EvaluationProfile } from "./types"

// ---------------------------------------------------------------------------
// Verification dimensions (criterion #7 — six required sections)
// ---------------------------------------------------------------------------

/**
 * Result of a single test suite invocation (focused or full-repo).
 * Captured by the caller from `node --test` stdout.
 */
export interface TestSuiteResult {
  /** Suite name, e.g. "release_acceptance" or "full-repo". */
  name: string
  total: number
  passed: number
  failed: number
  skipped: number
  durationMs: number
  /** Process exit code (0 = success). */
  exitCode: number
}

/**
 * Result of `tsc --noEmit` (or equivalent type-check invocation).
 */
export interface TypeScriptCheckResult {
  exitCode: number
  durationMs: number
  /** Optional error count (0 when exitCode is 0). */
  errorCount?: number
}

/**
 * Result of a single build invocation (e.g. `npm run build`).
 */
export interface BuildResult {
  name: string
  exitCode: number
  durationMs: number
  /** Optional artifact path or build summary. */
  artifactPath?: string
}

/**
 * Result of schema verification (idempotent migrations + table existence).
 */
export interface SchemaVerificationResult {
  /** List of migration names applied (or verified present). */
  migrationsApplied: string[]
  /** True when all migrations are idempotent (CREATE TABLE IF NOT EXISTS pattern). */
  idempotent: boolean
  exitCode: number
  /** Optional list of tables verified present. */
  tablesVerified?: string[]
}

/**
 * Result of a smoke profile run (local or production).
 */
export interface SmokeProfileResult {
  profile: EvaluationProfile
  results: SmokeResult[]
  gatePassed: boolean
}

// ---------------------------------------------------------------------------
// Final verification artifact
// ---------------------------------------------------------------------------

export const RELEASE_VERIFICATION_SCHEMA_VERSION = 1 as const

/**
 * Final T17 release verification artifact. Captures all six verification
 * dimensions required by criterion #7. JSON-serializable.
 */
export interface ReleaseVerificationArtifact {
  schemaVersion: typeof RELEASE_VERIFICATION_SCHEMA_VERSION
  /** Ticket identifier — always "T17" for this artifact type. */
  ticket: "T17"
  /** ISO 8601 timestamp the artifact was assembled. */
  generatedAt: string
  /** Git commit SHA the verification ran against. */
  repositoryRevision: string
  /** Optional operator / CI runner name. */
  verifiedBy?: string

  // Criterion #7 six dimensions — ALL required (non-optional)
  focusedTests: TestSuiteResult
  fullRepoTests: TestSuiteResult
  typeScriptCheck: TypeScriptCheckResult
  builds: BuildResult[]
  schemaVerification: SchemaVerificationResult
  /**
   * Optional live smoke profiles. Empty array when no smoke profiles were
   * run (criterion #7 says "optional live smoke profiles"). Local profile
   * smoke results are typical for dev verification; production profile is
   * required for production release.
   */
  smokeProfiles: SmokeProfileResult[]

  /**
   * Overall pass/fail decision. True when:
   *   - focusedTests.exitCode === 0 AND
   *   - fullRepoTests.exitCode === 0 AND
   *   - typeScriptCheck.exitCode === 0 AND
   *   - every build in builds[] has exitCode === 0 AND
   *   - schemaVerification.exitCode === 0 AND schemaVerification.idempotent === true AND
   *   - every smoke profile in smokeProfiles[] has gatePassed === true
   *
   * Smoke profiles are optional: empty smokeProfiles[] does NOT fail the
   * overall decision (criterion #7 wording: "optional live smoke profiles").
   */
  overallPassed: boolean
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Assemble a ReleaseVerificationArtifact from caller-supplied verification
 * results. Pure function — no side effects, no I/O.
 *
 * The caller is responsible for:
 *   - Running focused + full-repo test suites and capturing exit codes / counts
 *   - Running `tsc --noEmit` and capturing the exit code
 *   - Running applicable builds and capturing per-build exit codes
 *   - Verifying schema migrations are idempotent + applied
 *   - Optionally running smoke profiles (local or production)
 *
 * This function computes `overallPassed` from the supplied dimensions.
 */
export function buildReleaseVerification(input: {
  repositoryRevision: string
  generatedAt?: string
  verifiedBy?: string
  focusedTests: TestSuiteResult
  fullRepoTests: TestSuiteResult
  typeScriptCheck: TypeScriptCheckResult
  builds: BuildResult[]
  schemaVerification: SchemaVerificationResult
  smokeProfiles?: SmokeProfileResult[]
}): ReleaseVerificationArtifact {
  const smokeProfiles = input.smokeProfiles ?? []
  const overallPassed =
    input.focusedTests.exitCode === 0 &&
    input.fullRepoTests.exitCode === 0 &&
    input.typeScriptCheck.exitCode === 0 &&
    input.builds.every((b) => b.exitCode === 0) &&
    input.schemaVerification.exitCode === 0 &&
    input.schemaVerification.idempotent === true &&
    smokeProfiles.every((p) => p.gatePassed === true)
  return {
    schemaVersion: RELEASE_VERIFICATION_SCHEMA_VERSION,
    ticket: "T17",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    repositoryRevision: input.repositoryRevision,
    verifiedBy: input.verifiedBy,
    focusedTests: input.focusedTests,
    fullRepoTests: input.fullRepoTests,
    typeScriptCheck: input.typeScriptCheck,
    builds: input.builds,
    schemaVerification: input.schemaVerification,
    smokeProfiles,
    overallPassed,
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Write a ReleaseVerificationArtifact to disk as JSON.
 *
 * Side effect: writes (or overwrites) the file at `filePath`. The JSON is
 * pretty-printed with 2-space indent for human review (criterion #7 says
 * the artifact is "recorded" — readable JSON is part of recording).
 *
 * Returns the serialized JSON string (so callers can hash it, log it, or
 * embed it in another artifact without re-serializing).
 */
export function writeReleaseVerification(
  filePath: string,
  artifact: ReleaseVerificationArtifact,
): string {
  const json = JSON.stringify(artifact, null, 2)
  writeFileSync(filePath, json + "\n", "utf8")
  return json
}
