// Ticket 04 — Release artifact promotion contract.
//
// Makes release artifacts schema-validated, tamper-evident, revision/profile-bound,
// and fail-closed for production promotion.
//
// Design (karpathy-guidelines):
//   - validateArtifactSchema: structural validation + hash verification (tamper detection)
//   - checkPromotion: semantic validation for production promotion (fail-closed)
//   - Non-deterministic reports (RAGAS/Langfuse) are structurally separate and
//     cannot flip a deterministic failure to pass.
//   - checkPromotion only validates an existing artifact — it never reruns or
//     mutates production systems.

import { computeEvidenceHash } from "./runner"
import type {
  ReleaseRunnerArtifact,
  GateResult,
  HardInvariantStatus,
} from "./runner"
import type { EvaluationProfile } from "../evaluation/types"

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

export interface SchemaValidationResult {
  valid: boolean
  errors: string[]
}

const VALID_PROFILES: readonly EvaluationProfile[] = ["local", "production"]

const VALID_HARD_INVARIANT_STATUSES: readonly HardInvariantStatus[] = [
  "not_run",
  "passed",
  "failed",
  "blocked",
  "malformed",
]

const VALID_FAILURE_CATEGORIES = [
  "none",
  "non_zero_exit",
  "start_failed",
  "timeout",
  "cancelled",
  "malformed_input",
  "partial_completion",
]

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
}

function isGateResultArray(value: unknown): value is GateResult[] {
  if (!Array.isArray(value)) return false
  return value.every((g) => {
    if (!isObject(g)) return false
    return (
      typeof g.name === "string" &&
      typeof g.command === "string" &&
      Array.isArray(g.args) &&
      typeof g.durationMs === "number" &&
      Array.isArray(g.outputTail) &&
      typeof g.failureCategory === "string" &&
      VALID_FAILURE_CATEGORIES.includes(g.failureCategory)
    )
  })
}

/**
 * Validate the artifact schema: required fields, types, and evidence hash.
 * Returns { valid: true, errors: [] } when the artifact is structurally
 * correct and its evidenceHash matches the computed hash.
 */
export function validateArtifactSchema(
  artifact: unknown,
): SchemaValidationResult {
  const errors: string[] = []

  if (!isObject(artifact)) {
    return { valid: false, errors: ["artifact must be an object"] }
  }

  // Required scalar fields
  // Ticket 02: V2 is the canonical release artifact schema. V1 is rejected
  // at schema validation — V1 artifacts remain readable via JSON.parse for
  // diagnostics but cannot pass schema validation or authorize promotion.
  if (typeof artifact.schemaVersion !== "number" || artifact.schemaVersion !== 2) {
    errors.push("schemaVersion must be 2 (number) — V1 is diagnostic-only and cannot be promoted")
  }
  if (typeof artifact.profile !== "string" || !VALID_PROFILES.includes(artifact.profile as EvaluationProfile)) {
    errors.push("profile must be 'local' or 'production'")
  }
  if (typeof artifact.generatedAt !== "string") {
    errors.push("generatedAt must be a string")
  }
  if (typeof artifact.repositoryRevision !== "string") {
    errors.push("repositoryRevision must be a string")
  }
  if (typeof artifact.hardInvariantStatus !== "string" || !VALID_HARD_INVARIANT_STATUSES.includes(artifact.hardInvariantStatus as HardInvariantStatus)) {
    errors.push("hardInvariantStatus must be one of: not_run, passed, failed, blocked, malformed")
  }
  if (typeof artifact.overallPassed !== "boolean") {
    errors.push("overallPassed must be a boolean")
  }
  if (typeof artifact.productionReady !== "boolean") {
    errors.push("productionReady must be a boolean")
  }
  if (typeof artifact.dirtyWorktree !== "boolean") {
    errors.push("dirtyWorktree must be a boolean")
  }
  if (typeof artifact.evidenceHash !== "string" || (artifact.evidenceHash as string).length === 0) {
    errors.push("evidenceHash must be a non-empty string")
  }

  // Required array fields
  if (!isGateResultArray(artifact.gates)) {
    errors.push("gates must be an array of GateResult objects")
  }
  if (!Array.isArray(artifact.hardInvariantResults)) {
    errors.push("hardInvariantResults must be an array")
  }
  if (!Array.isArray(artifact.smokeResults)) {
    errors.push("smokeResults must be an array")
  }

  // Optional rollback evidence
  if (artifact.rollbackEvidence !== undefined) {
    if (
      !isObject(artifact.rollbackEvidence) ||
      typeof artifact.rollbackEvidence.verified !== "boolean" ||
      typeof artifact.rollbackEvidence.revision !== "string" ||
      !isStringArray(artifact.rollbackEvidence.steps)
    ) {
      errors.push("rollbackEvidence must have { verified: boolean, revision: string, steps: string[] }")
    }
  }

  // Evidence hash verification (tamper detection)
  // Only verify if all structural checks passed
  if (errors.length === 0 && typeof artifact.evidenceHash === "string") {
    const artifactForHash: Omit<ReleaseRunnerArtifact, "evidenceHash" | "nonDeterministicReports"> = {
      schemaVersion: artifact.schemaVersion as 2,
      profile: artifact.profile as EvaluationProfile,
      generatedAt: artifact.generatedAt as string,
      repositoryRevision: artifact.repositoryRevision as string,
      gates: artifact.gates as GateResult[],
      hardInvariantStatus: artifact.hardInvariantStatus as HardInvariantStatus,
      hardInvariantResults: artifact.hardInvariantResults as ReleaseRunnerArtifact["hardInvariantResults"],
      smokeResults: artifact.smokeResults as ReleaseRunnerArtifact["smokeResults"],
      overallPassed: artifact.overallPassed as boolean,
      productionReady: artifact.productionReady as boolean,
      dirtyWorktree: artifact.dirtyWorktree as boolean,
      rollbackEvidence: artifact.rollbackEvidence as ReleaseRunnerArtifact["rollbackEvidence"],
    }
    const computedHash = computeEvidenceHash(artifactForHash)
    if (computedHash !== artifact.evidenceHash) {
      errors.push(
        `evidenceHash mismatch: stored hash does not match computed hash (evidence may be tampered or stale)`,
      )
    }
  }

  return { valid: errors.length === 0, errors }
}

// ---------------------------------------------------------------------------
// Promotion checker
// ---------------------------------------------------------------------------

export interface PromotionResult {
  promoted: boolean
  reasons: string[]
}

export interface PromotionOptions {
  expectedRevision: string
}

/**
 * Check whether an artifact can be promoted to production.
 *
 * Fail-closed: any unverified condition blocks promotion.
 * Non-deterministic reports (RAGAS/Langfuse) cannot flip a failure to pass.
 *
 * This function only validates — it never reruns or mutates production systems.
 */
export function checkPromotion(
  artifact: ReleaseRunnerArtifact,
  options: PromotionOptions,
): PromotionResult {
  const reasons: string[] = []

  // 1. Schema validation (includes hash/tamper check)
  const schemaResult = validateArtifactSchema(artifact)
  if (!schemaResult.valid) {
    return {
      promoted: false,
      reasons: schemaResult.errors,
    }
  }

  // 2. Profile must be production
  if (artifact.profile !== "production") {
    reasons.push(`profile mismatch: expected 'production', got '${artifact.profile}'`)
  }

  // 3. Revision must match expected
  if (artifact.repositoryRevision !== options.expectedRevision) {
    reasons.push(
      `revision mismatch: artifact has '${artifact.repositoryRevision}', expected '${options.expectedRevision}'`,
    )
  }

  // 4. Worktree must be clean
  if (artifact.dirtyWorktree) {
    reasons.push("dirty worktree: artifact was generated with uncommitted changes")
  }

  // 5. All deterministic gates must pass
  const failedGates = artifact.gates.filter(
    (g) => g.failureCategory !== "none",
  )
  if (failedGates.length > 0) {
    reasons.push(
      `failed deterministic gate(s): ${failedGates.map((g) => g.name).join(", ")}`,
    )
  }

  // 6. Hard invariant status must be "passed"
  if (artifact.hardInvariantStatus !== "passed") {
    reasons.push(
      `hard invariant status is '${artifact.hardInvariantStatus}' (expected 'passed')`,
    )
  }

  // 7. Hard invariant collection must not be empty
  if (artifact.hardInvariantResults.length === 0) {
    reasons.push("empty hard-invariant collection: cannot promote with no invariant results")
  }

  // 8. Smoke results must not be empty
  if (artifact.smokeResults.length === 0) {
    reasons.push("empty smoke collection: cannot promote with no smoke evidence")
  }

  // 9. Required probe: smoke_evidence gate must be present
  const hasSmokeGate = artifact.gates.some((g) => g.name === "smoke_evidence")
  if (!hasSmokeGate) {
    reasons.push("missing required probe: smoke_evidence gate not found in artifact")
  }

  // 10. Rollback evidence must be present and verified
  if (!artifact.rollbackEvidence) {
    reasons.push("missing rollback evidence: production promotion requires verified rollback evidence")
  } else if (!artifact.rollbackEvidence.verified) {
    reasons.push("unverified rollback evidence: rollback was attempted but not verified")
  }

  return {
    promoted: reasons.length === 0,
    reasons,
  }
}
