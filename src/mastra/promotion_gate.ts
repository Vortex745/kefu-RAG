import { readFileSync } from "node:fs"
import type {
  ReleaseVerificationArtifact,
} from "../evaluation/release_verification"
import type { MastraRuntimeMode } from "./runtime_mode"
import { validateArtifactSchema, checkPromotion } from "../release/promotion"
import type { ReleaseRunnerArtifact } from "../release/runner"

export const MASTRA_PROMOTION_ARTIFACT_ENV = "MASTRA_PROMOTION_ARTIFACT"

export interface PromotionDecision {
  allowed: boolean
  blockers: string[]
  targetMode: MastraRuntimeMode
}

function checkCommon(artifact: ReleaseVerificationArtifact): string[] {
  const blockers: string[] = []
  if (!artifact.overallPassed) {
    blockers.push("artifact.overallPassed === false")
  }
  if (artifact.focusedTests.exitCode !== 0) {
    blockers.push(`focusedTests failed: exitCode=${artifact.focusedTests.exitCode}`)
  }
  if (artifact.fullRepoTests.exitCode !== 0) {
    blockers.push(`fullRepoTests failed: exitCode=${artifact.fullRepoTests.exitCode}`)
  }
  if (artifact.typeScriptCheck.exitCode !== 0) {
    blockers.push(`typeScriptCheck failed: exitCode=${artifact.typeScriptCheck.exitCode}`)
  }
  for (const build of artifact.builds) {
    if (build.exitCode !== 0) {
      blockers.push(`build "${build.name}" failed: exitCode=${build.exitCode}`)
    }
  }
  if (artifact.schemaVerification.exitCode !== 0) {
    blockers.push(
      `schemaVerification failed: exitCode=${artifact.schemaVerification.exitCode}`
    )
  }
  if (!artifact.schemaVerification.idempotent) {
    blockers.push("schemaVerification.idempotent === false")
  }
  return blockers
}

function checkSmokeProfiles(
  artifact: ReleaseVerificationArtifact,
  requireProduction: boolean
): string[] {
  const blockers = artifact.smokeProfiles
    .filter((profile) => !profile.gatePassed)
    .map((profile) => `smoke profile "${profile.profile}" failed gate`)
  if (
    requireProduction &&
    !artifact.smokeProfiles.some((profile) => profile.profile === "production")
  ) {
    blockers.push("smoke profiles missing production profile")
  }
  return blockers
}

export function canPromoteToLimited(
  artifact: ReleaseVerificationArtifact
): PromotionDecision {
  const blockers = [
    ...checkCommon(artifact),
    ...checkSmokeProfiles(artifact, false),
  ]
  return {
    allowed: blockers.length === 0,
    blockers,
    targetMode: "limited",
  }
}

export function canPromoteToDefault(
  artifact: ReleaseVerificationArtifact
): PromotionDecision {
  const blockers = [
    ...checkCommon(artifact),
    ...checkSmokeProfiles(artifact, true),
  ]
  return {
    allowed: blockers.length === 0,
    blockers,
    targetMode: "default",
  }
}

export function canPromote(
  artifact: ReleaseVerificationArtifact,
  targetMode: MastraRuntimeMode
): PromotionDecision {
  return targetMode === "limited"
    ? canPromoteToLimited(artifact)
    : canPromoteToDefault(artifact)
}

export class PromotionBlockedError extends Error {
  readonly blockers: string[]
  readonly targetMode: MastraRuntimeMode

  constructor(decision: PromotionDecision) {
    super(
      `Promotion to ${decision.targetMode} blocked: ` +
      decision.blockers.join("; ")
    )
    this.name = "PromotionBlockedError"
    this.blockers = decision.blockers
    this.targetMode = decision.targetMode
  }
}

export function assertPromotionAllowed(
  artifact: ReleaseVerificationArtifact,
  targetMode: MastraRuntimeMode
): void {
  const decision = canPromote(artifact, targetMode)
  if (!decision.allowed) throw new PromotionBlockedError(decision)
}

export function assertRuntimeModeStartupAllowed(
  mode: MastraRuntimeMode,
  artifactPath: string | undefined
): void {
  if (mode === "limited") return
  if (!artifactPath?.trim()) {
    throw new Error(
      `Runtime mode "default" requires ${MASTRA_PROMOTION_ARTIFACT_ENV} ` +
      "to point to a persisted passing release verification artifact"
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(artifactPath, "utf8"))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Invalid promotion artifact at "${artifactPath}": ${message}`,
      { cause: error }
    )
  }

  // Ticket 02: validate as V2 ReleaseRunnerArtifact. V1 artifacts (schemaVersion=1)
  // and malformed artifacts are rejected at schema validation. This makes default
  // startup fail-closed for V1, malformed, and any non-V2 shape. Limited startup
  // remains available without an artifact (returned early above).
  const schemaResult = validateArtifactSchema(parsed)
  if (!schemaResult.valid) {
    throw new Error(
      `Invalid promotion artifact at "${artifactPath}": ${schemaResult.errors.join("; ")}`,
    )
  }

  const artifact = parsed as ReleaseRunnerArtifact
  const promoResult = checkPromotion(artifact, {
    expectedRevision: artifact.repositoryRevision,
  })
  if (!promoResult.promoted) {
    throw new Error(
      `Promotion to ${mode} blocked: ${promoResult.reasons.join("; ")}`,
    )
  }
}

export type { ReleaseVerificationArtifact }
