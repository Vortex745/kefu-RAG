import assert from "node:assert/strict"
import test from "node:test"
import {
  assertPromotionAllowed,
  canPromote,
  canPromoteToDefault,
  canPromoteToLimited,
  PromotionBlockedError,
} from "./promotion_gate"
import type {
  ReleaseVerificationArtifact,
  SmokeProfileResult,
} from "../evaluation/release_verification"

function smoke(
  profile: "local" | "production",
  gatePassed: boolean
): SmokeProfileResult {
  return { profile, results: [], gatePassed }
}

function artifact(
  overrides: Partial<ReleaseVerificationArtifact> = {}
): ReleaseVerificationArtifact {
  return {
    schemaVersion: 1,
    ticket: "T17",
    generatedAt: "2026-07-20T00:00:00.000Z",
    repositoryRevision: "abc123",
    verifiedBy: "test",
    focusedTests: {
      name: "focused",
      total: 10,
      passed: 10,
      failed: 0,
      skipped: 0,
      durationMs: 10,
      exitCode: 0,
    },
    fullRepoTests: {
      name: "full",
      total: 100,
      passed: 100,
      failed: 0,
      skipped: 0,
      durationMs: 100,
      exitCode: 0,
    },
    typeScriptCheck: { exitCode: 0, durationMs: 10, errorCount: 0 },
    builds: [{ name: "main", exitCode: 0, durationMs: 10 }],
    schemaVerification: {
      migrationsApplied: [],
      idempotent: true,
      exitCode: 0,
      tablesVerified: [],
    },
    smokeProfiles: [],
    overallPassed: true,
    ...overrides,
  }
}

test("limited allows a passing artifact without production smoke", () => {
  assert.equal(canPromoteToLimited(artifact()).allowed, true)
})

test("limited blocks any failing smoke profile", () => {
  const decision = canPromoteToLimited(artifact({
    smokeProfiles: [smoke("local", false)],
  }))
  assert.equal(decision.allowed, false)
  assert.match(decision.blockers.join(" "), /local/)
})

test("default requires a passing production smoke profile", () => {
  assert.equal(canPromoteToDefault(artifact()).allowed, false)
  assert.equal(canPromoteToDefault(artifact({
    smokeProfiles: [smoke("production", true)],
  })).allowed, true)
})

test("common verification failures block both remaining modes", () => {
  const failing = artifact({
    focusedTests: {
      ...artifact().focusedTests,
      exitCode: 1,
      failed: 1,
      passed: 9,
    },
  })
  assert.equal(canPromote(failing, "limited").allowed, false)
  assert.equal(canPromote(failing, "default").allowed, false)
})

test("canPromote dispatches only limited and default", () => {
  const passing = artifact({ smokeProfiles: [smoke("production", true)] })
  assert.equal(canPromote(passing, "limited").targetMode, "limited")
  assert.equal(canPromote(passing, "default").targetMode, "default")
})

test("assertPromotionAllowed throws a typed error with blockers", () => {
  assert.throws(
    () => assertPromotionAllowed(artifact(), "default"),
    (error: unknown) => {
      assert.ok(error instanceof PromotionBlockedError)
      assert.equal(error.targetMode, "default")
      assert.ok(error.blockers.length > 0)
      return true
    }
  )
})
