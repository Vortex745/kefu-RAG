// Ticket 17 — Release verification artifact tests (criterion #7).
//
// Spec issue #17 criterion #7:
//   "Focused tests, full repository tests, TypeScript checking, applicable
//    builds, schema verification and optional live smoke profiles are
//    recorded in the final verification artifact"
//
// These tests verify the SHAPE and ASSEMBLY logic of the verification
// artifact. They do NOT run real tests, tsc, or builds — that is the CI
// runner's job. The artifact module is a pure assembler + JSON writer.
//
// Coverage:
//   - All 6 dimensions are present in the artifact (shape)
//   - overallPassed is true when every dimension passes
//   - overallPassed is false when ANY single dimension fails (parametric)
//   - smokeProfiles is optional (empty array does NOT fail overallPassed)
//   - writeReleaseVerification produces valid JSON (round-trip)
//   - schemaVersion is 1 (backward compat with T17 #6 backward compat)
//   - ticket field is the literal "T17" (artifact identity)

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  buildReleaseVerification,
  writeReleaseVerification,
  RELEASE_VERIFICATION_SCHEMA_VERSION,
} from "./release_verification"
import type {
  BuildResult,
  ReleaseVerificationArtifact,
  SchemaVerificationResult,
  SmokeProfileResult,
  TestSuiteResult,
  TypeScriptCheckResult,
} from "./release_verification"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFocusedTests(overrides: Partial<TestSuiteResult> = {}): TestSuiteResult {
  return {
    name: "release_acceptance",
    total: 41,
    passed: 41,
    failed: 0,
    skipped: 0,
    durationMs: 500,
    exitCode: 0,
    ...overrides,
  }
}

function makeFullRepoTests(overrides: Partial<TestSuiteResult> = {}): TestSuiteResult {
  return {
    name: "full-repo",
    total: 1117,
    passed: 1117,
    failed: 0,
    skipped: 0,
    durationMs: 30000,
    exitCode: 0,
    ...overrides,
  }
}

function makeTypeScriptCheck(overrides: Partial<TypeScriptCheckResult> = {}): TypeScriptCheckResult {
  return {
    exitCode: 0,
    durationMs: 5000,
    errorCount: 0,
    ...overrides,
  }
}

function makeBuilds(): BuildResult[] {
  return [
    { name: "npm run build", exitCode: 0, durationMs: 10000, artifactPath: "dist/" },
  ]
}

function makeSchemaVerification(
  overrides: Partial<SchemaVerificationResult> = {},
): SchemaVerificationResult {
  return {
    migrationsApplied: [
      "001_create_handoff_table",
      "002_create_clarification_pending_table",
      "003_create_conversation_table",
    ],
    idempotent: true,
    exitCode: 0,
    tablesVerified: ["handoff", "clarification_pending", "conversation"],
    ...overrides,
  }
}

function makeSmokeProfiles(): SmokeProfileResult[] {
  return [
    {
      profile: "local",
      results: [
        { capability: "markitdown", profile: "local", status: "passed", durationMs: 100 },
        { capability: "chat", profile: "local", status: "passed", durationMs: 200 },
      ],
      gatePassed: true,
    },
  ]
}

function makePassingArtifactInput() {
  return {
    repositoryRevision: "abc123def456",
    generatedAt: "2026-07-19T00:00:00.000Z",
    verifiedBy: "ci-runner",
    focusedTests: makeFocusedTests(),
    fullRepoTests: makeFullRepoTests(),
    typeScriptCheck: makeTypeScriptCheck(),
    builds: makeBuilds(),
    schemaVerification: makeSchemaVerification(),
    smokeProfiles: makeSmokeProfiles(),
  }
}

// ---------------------------------------------------------------------------
// Shape tests
// ---------------------------------------------------------------------------

test("T17 #7: buildReleaseVerification produces artifact with all 6 verification dimensions", () => {
  const artifact = buildReleaseVerification(makePassingArtifactInput())
  assert.equal(artifact.schemaVersion, 1, "schemaVersion is 1")
  assert.equal(artifact.ticket, "T17", "ticket field is literal 'T17'")
  assert.equal(artifact.repositoryRevision, "abc123def456")
  assert.equal(artifact.generatedAt, "2026-07-19T00:00:00.000Z")
  assert.equal(artifact.verifiedBy, "ci-runner")
  // All 6 dimensions present
  assert.ok(artifact.focusedTests, "focusedTests dimension present")
  assert.ok(artifact.fullRepoTests, "fullRepoTests dimension present")
  assert.ok(artifact.typeScriptCheck, "typeScriptCheck dimension present")
  assert.ok(Array.isArray(artifact.builds), "builds dimension present (array)")
  assert.ok(artifact.schemaVerification, "schemaVerification dimension present")
  assert.ok(Array.isArray(artifact.smokeProfiles), "smokeProfiles dimension present (array)")
  // overallPassed is computed
  assert.equal(typeof artifact.overallPassed, "boolean", "overallPassed is a boolean")
})

test("T17 #7: schemaVersion matches RELEASE_VERIFICATION_SCHEMA_VERSION constant", () => {
  const artifact = buildReleaseVerification(makePassingArtifactInput())
  assert.equal(
    artifact.schemaVersion,
    RELEASE_VERIFICATION_SCHEMA_VERSION,
    "artifact.schemaVersion matches exported constant",
  )
  assert.equal(RELEASE_VERIFICATION_SCHEMA_VERSION, 1, "constant is 1 (backward compat)")
})

// ---------------------------------------------------------------------------
// overallPassed — true when all dimensions pass
// ---------------------------------------------------------------------------

test("T17 #7: overallPassed is true when every dimension passes (smoke gate passed)", () => {
  const artifact = buildReleaseVerification(makePassingArtifactInput())
  assert.equal(artifact.overallPassed, true, "all dimensions pass → overallPassed=true")
})

test("T17 #7: overallPassed is true when smokeProfiles is empty (smoke is optional)", () => {
  // Omit smokeProfiles from input — buildReleaseVerification must default to []
  const { smokeProfiles: _omit, ...inputWithoutSmoke } = makePassingArtifactInput()
  const artifact = buildReleaseVerification(inputWithoutSmoke)
  assert.equal(artifact.smokeProfiles.length, 0, "smokeProfiles defaults to empty array")
  assert.equal(artifact.overallPassed, true, "empty smokeProfiles does NOT fail overallPassed")
})

// ---------------------------------------------------------------------------
// overallPassed — false when ANY single dimension fails (parametric)
// ---------------------------------------------------------------------------

test("T17 #7: overallPassed is false when focusedTests.exitCode != 0", () => {
  const input = makePassingArtifactInput()
  input.focusedTests = makeFocusedTests({ exitCode: 1, failed: 1, passed: 40 })
  const artifact = buildReleaseVerification(input)
  assert.equal(artifact.overallPassed, false, "focused test failure → overallPassed=false")
})

test("T17 #7: overallPassed is false when fullRepoTests.exitCode != 0", () => {
  const input = makePassingArtifactInput()
  input.fullRepoTests = makeFullRepoTests({ exitCode: 1, failed: 1, passed: 1116 })
  const artifact = buildReleaseVerification(input)
  assert.equal(artifact.overallPassed, false, "full-repo test failure → overallPassed=false")
})

test("T17 #7: overallPassed is false when typeScriptCheck.exitCode != 0", () => {
  const input = makePassingArtifactInput()
  input.typeScriptCheck = makeTypeScriptCheck({ exitCode: 1, errorCount: 5 })
  const artifact = buildReleaseVerification(input)
  assert.equal(artifact.overallPassed, false, "tsc failure → overallPassed=false")
})

test("T17 #7: overallPassed is false when any build in builds[] fails", () => {
  const input = makePassingArtifactInput()
  input.builds = [
    { name: "npm run build", exitCode: 0, durationMs: 10000 },
    { name: "npm run bundle", exitCode: 1, durationMs: 5000 },
  ]
  const artifact = buildReleaseVerification(input)
  assert.equal(artifact.overallPassed, false, "build failure → overallPassed=false")
})

test("T17 #7: overallPassed is true (vacuously) when builds[] is empty — caller must enforce non-empty when builds apply", () => {
  // Empty builds[] means `every()` returns true (vacuous) — but criterion #7
  // requires "applicable builds" to be recorded. The artifact treats empty
  // builds as vacuously passing; the CI runner is responsible for ensuring
  // builds[] is non-empty when builds are applicable. This test documents
  // the vacuous-pass behavior.
  const input = makePassingArtifactInput()
  input.builds = []
  const artifact = buildReleaseVerification(input)
  assert.equal(artifact.overallPassed, true, "empty builds[] vacuously passes (caller responsibility)")
})

test("T17 #7: overallPassed is false when schemaVerification.exitCode != 0", () => {
  const input = makePassingArtifactInput()
  input.schemaVerification = makeSchemaVerification({ exitCode: 1 })
  const artifact = buildReleaseVerification(input)
  assert.equal(artifact.overallPassed, false, "schema verification failure → overallPassed=false")
})

test("T17 #7: overallPassed is false when schemaVerification.idempotent is false", () => {
  const input = makePassingArtifactInput()
  input.schemaVerification = makeSchemaVerification({ idempotent: false })
  const artifact = buildReleaseVerification(input)
  assert.equal(artifact.overallPassed, false, "non-idempotent schema → overallPassed=false")
})

test("T17 #7: overallPassed is false when any smoke profile gate failed", () => {
  const input = makePassingArtifactInput()
  input.smokeProfiles = [
    {
      profile: "local",
      results: [
        { capability: "markitdown", profile: "local", status: "failed", reason: "probe crashed", durationMs: 100 },
      ],
      gatePassed: false,
    },
  ]
  const artifact = buildReleaseVerification(input)
  assert.equal(artifact.overallPassed, false, "smoke gate failure → overallPassed=false")
})

test("T17 #7: overallPassed is false when smoke profile gate passed=false even if other profiles pass", () => {
  const input = makePassingArtifactInput()
  input.smokeProfiles = [
    { profile: "local", results: [], gatePassed: true },
    { profile: "production", results: [], gatePassed: false },
  ]
  const artifact = buildReleaseVerification(input)
  assert.equal(
    artifact.overallPassed,
    false,
    "any smoke profile gate failure → overallPassed=false (independent of others)",
  )
})

// ---------------------------------------------------------------------------
// Persistence — writeReleaseVerification
// ---------------------------------------------------------------------------

test("T17 #7: writeReleaseVerification writes valid JSON to disk (round-trip)", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "t17-verify-"))
  try {
    const filePath = join(tmpDir, "verification.json")
    const artifact = buildReleaseVerification(makePassingArtifactInput())
    const writtenJson = writeReleaseVerification(filePath, artifact)
    // File exists and contains the JSON
    const fileContent = readFileSync(filePath, "utf8")
    assert.equal(fileContent, writtenJson + "\n", "file content matches returned JSON + newline")
    // Round-trip: parse back to object
    const parsed = JSON.parse(fileContent) as ReleaseVerificationArtifact
    assert.equal(parsed.schemaVersion, 1, "parsed artifact has schemaVersion=1")
    assert.equal(parsed.ticket, "T17", "parsed artifact has ticket='T17'")
    assert.equal(parsed.overallPassed, true, "parsed artifact has overallPassed=true")
    assert.equal(parsed.focusedTests.total, 41, "parsed artifact preserves focusedTests")
    assert.equal(parsed.fullRepoTests.total, 1117, "parsed artifact preserves fullRepoTests")
    assert.equal(parsed.typeScriptCheck.exitCode, 0, "parsed artifact preserves typeScriptCheck")
    assert.equal(parsed.builds.length, 1, "parsed artifact preserves builds[]")
    assert.equal(parsed.schemaVerification.migrationsApplied.length, 3, "parsed artifact preserves schemaVerification")
    assert.equal(parsed.smokeProfiles.length, 1, "parsed artifact preserves smokeProfiles[]")
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("T17 #7: writeReleaseVerification JSON is pretty-printed (2-space indent)", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "t17-verify-"))
  try {
    const filePath = join(tmpDir, "verification.json")
    const artifact = buildReleaseVerification(makePassingArtifactInput())
    const json = writeReleaseVerification(filePath, artifact)
    // Pretty-printed JSON contains newlines + indentation
    assert.match(json, /\n {2}"schemaVersion"/, "JSON is pretty-printed with 2-space indent")
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("T17 #7: artifact is fully JSON-serializable (no Date, no undefined, no functions)", () => {
  const artifact = buildReleaseVerification(makePassingArtifactInput())
  // JSON.stringify must not throw, must not produce "undefined"
  const json = JSON.stringify(artifact)
  assert.ok(json !== undefined, "artifact is JSON-serializable")
  assert.ok(!json.includes("undefined"), "no 'undefined' literal in serialized JSON")
  // Round-trip preserves structure
  const parsed = JSON.parse(json) as ReleaseVerificationArtifact
  assert.deepEqual(parsed, artifact, "round-trip preserves artifact structure")
})

// ---------------------------------------------------------------------------
// Criterion #7 coverage — all 6 dimensions are independently recorded
// ---------------------------------------------------------------------------

test("T17 #7: criterion #7 coverage — all 6 dimensions recorded (focused/full/tsc/builds/schema/smoke)", () => {
  const artifact = buildReleaseVerification(makePassingArtifactInput())
  // The artifact must record ALL 6 dimensions named in criterion #7:
  //   1. Focused tests
  //   2. Full repository tests
  //   3. TypeScript checking
  //   4. Applicable builds
  //   5. Schema verification
  //   6. Optional live smoke profiles
  const dimensionKeys = Object.keys(artifact).filter(
    (k) =>
      k === "focusedTests" ||
      k === "fullRepoTests" ||
      k === "typeScriptCheck" ||
      k === "builds" ||
      k === "schemaVerification" ||
      k === "smokeProfiles",
  )
  assert.equal(
    dimensionKeys.length,
    6,
    "all 6 criterion #7 dimensions present as top-level fields",
  )
})
