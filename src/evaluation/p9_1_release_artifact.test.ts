// P9.1 — Release artifact aggregator tests.
//
// Spec L77: aggregate deterministic hard invariants + build/type/test/schema
// + production smoke + rollback evidence into one auditable artifact; RAGAS
// shadow and Langfuse bypass-only.
//
// Spec L13: RAGAS/Langfuse cannot override deterministic safety gates.
//
// Spec L14: missing production probe → fail or explicitly block, never
// silently skip.
//
// Coverage:
//   #1 Artifact schema — all required fields present
//   #2 Deterministic gates — verification + hard invariants aggregated correctly
//   #3 Blocked items — P5.3/D-002 and P9.2/D-003 explicitly marked
//   #4 Non-deterministic signals — RAGAS/Langfuse bypass-only, cannot override
//   #5 Artifact completeness — all fields non-null, JSON-serializable
//   #6 releaseBlocked vs overallPassed — distinct flags (spec L14)
//   #7 Persistence — writeP91ReleaseArtifact round-trip

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  buildP91ReleaseArtifact,
  writeP91ReleaseArtifact,
  defaultBlockedItems,
  defaultNonDeterministicSignals,
  defaultRollbackEvidence,
  P91_RELEASE_ARTIFACT_SCHEMA_VERSION,
} from "./p9_1_release_artifact"
import type {
  P91ReleaseArtifact,
  BlockedItem,
  NonDeterministicSignal,
  RollbackEvidence,
} from "./p9_1_release_artifact"
import { buildReleaseVerification } from "./release_verification"
import type { ReleaseVerificationArtifact } from "./release_verification"
import type { HardInvariantResult } from "./types"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePassingVerification(): ReleaseVerificationArtifact {
  return buildReleaseVerification({
    repositoryRevision: "abc123def456",
    generatedAt: "2026-07-22T00:00:00.000Z",
    verifiedBy: "ci-runner",
    focusedTests: {
      name: "release_acceptance",
      total: 41,
      passed: 41,
      failed: 0,
      skipped: 0,
      durationMs: 500,
      exitCode: 0,
    },
    fullRepoTests: {
      name: "full-repo",
      total: 1117,
      passed: 1117,
      failed: 0,
      skipped: 0,
      durationMs: 30000,
      exitCode: 0,
    },
    typeScriptCheck: { exitCode: 0, durationMs: 5000, errorCount: 0 },
    builds: [{ name: "npm run build", exitCode: 0, durationMs: 10000, artifactPath: "dist/" }],
    schemaVerification: {
      migrationsApplied: ["001_create_handoff_table"],
      idempotent: true,
      exitCode: 0,
      tablesVerified: ["handoff"],
    },
    smokeProfiles: [],
  })
}

function makePassingHardInvariants(): HardInvariantResult[] {
  const keys: HardInvariantResult["key"][] = [
    "terminal_convergence_100",
    "unknown_citation_count_zero",
    "knowledge_completed_zero_refs_zero",
    "unauthorized_evidence_zero",
    "direct_route_completion_without_retrieval_95",
    "cancellation_late_answer_zero",
    "tool_loop_budget_termination",
    "unauthorized_tool_rejection",
  ]
  return keys.map((key) => ({
    key,
    passed: true,
    expected: "expected value",
    actual: "actual value",
    failingCaseIds: [],
  }))
}

function makeFailingHardInvariant(): HardInvariantResult {
  return {
    key: "unknown_citation_count_zero",
    passed: false,
    expected: "0 cases with unknown citations",
    actual: "1 cases with unknown citations",
    failingCaseIds: ["complex-03"],
  }
}

type P91ArtifactInput = Parameters<typeof buildP91ReleaseArtifact>[0]

function makePassingArtifactInput(): P91ArtifactInput {
  return {
    repositoryRevision: "abc123def456",
    generatedAt: "2026-07-22T00:00:00.000Z",
    verification: makePassingVerification(),
    hardInvariants: makePassingHardInvariants(),
  }
}

// ---------------------------------------------------------------------------
// #1 Artifact schema — all required fields present
// ---------------------------------------------------------------------------

test("P9.1 #1: buildP91ReleaseArtifact produces artifact with all required top-level fields", () => {
  const artifact = buildP91ReleaseArtifact(makePassingArtifactInput())
  assert.equal(artifact.schemaVersion, 1, "schemaVersion is 1")
  assert.equal(artifact.item, "P9.1", "item field is literal 'P9.1'")
  assert.equal(artifact.repositoryRevision, "abc123def456")
  assert.equal(artifact.generatedAt, "2026-07-22T00:00:00.000Z")
  assert.ok(artifact.deterministicGates, "deterministicGates section present")
  assert.ok(Array.isArray(artifact.blockedItems), "blockedItems present (array)")
  assert.ok(Array.isArray(artifact.nonDeterministicSignals), "nonDeterministicSignals present (array)")
  assert.ok(artifact.rollbackEvidence, "rollbackEvidence section present")
  assert.equal(typeof artifact.releaseBlocked, "boolean", "releaseBlocked is a boolean")
})

test("P9.1 #1: schemaVersion matches P91_RELEASE_ARTIFACT_SCHEMA_VERSION constant", () => {
  const artifact = buildP91ReleaseArtifact(makePassingArtifactInput())
  assert.equal(
    artifact.schemaVersion,
    P91_RELEASE_ARTIFACT_SCHEMA_VERSION,
    "artifact.schemaVersion matches exported constant",
  )
  assert.equal(P91_RELEASE_ARTIFACT_SCHEMA_VERSION, 1, "constant is 1")
})

test("P9.1 #1: deterministicGates contains verification + hardInvariants + computed flags", () => {
  const artifact = buildP91ReleaseArtifact(makePassingArtifactInput())
  const dg = artifact.deterministicGates
  assert.ok(dg.verification, "verification (T17) embedded")
  assert.ok(Array.isArray(dg.hardInvariants), "hardInvariants array embedded")
  assert.equal(dg.hardInvariants.length, 8, "all 8 hard invariants present")
  assert.equal(typeof dg.hardInvariantsAllPassed, "boolean", "hardInvariantsAllPassed is boolean")
  assert.equal(typeof dg.overallPassed, "boolean", "overallPassed is boolean")
})

// ---------------------------------------------------------------------------
// #2 Deterministic gates — verification + hard invariants aggregated correctly
// ---------------------------------------------------------------------------

test("P9.1 #2: deterministicGates.overallPassed is true when verification passes AND all hard invariants pass", () => {
  const artifact = buildP91ReleaseArtifact(makePassingArtifactInput())
  assert.equal(artifact.deterministicGates.verification.overallPassed, true, "T17 verification passes")
  assert.equal(artifact.deterministicGates.hardInvariantsAllPassed, true, "all hard invariants pass")
  assert.equal(artifact.deterministicGates.overallPassed, true, "conjunction → overallPassed=true")
})

test("P9.1 #2: deterministicGates.overallPassed is false when any hard invariant fails (even if verification passes)", () => {
  const input = makePassingArtifactInput()
  input.hardInvariants = [...makePassingHardInvariants()]
  input.hardInvariants[1] = makeFailingHardInvariant()
  const artifact = buildP91ReleaseArtifact(input)
  assert.equal(artifact.deterministicGates.verification.overallPassed, true, "T17 verification still passes")
  assert.equal(artifact.deterministicGates.hardInvariantsAllPassed, false, "one hard invariant fails")
  assert.equal(artifact.deterministicGates.overallPassed, false, "hard invariant failure → overallPassed=false")
})

test("P9.1 #2: deterministicGates.overallPassed is false when verification fails (even if all hard invariants pass)", () => {
  const input = makePassingArtifactInput()
  // Build a failing verification: focused test exit code != 0
  input.verification = buildReleaseVerification({
    repositoryRevision: "abc123def456",
    focusedTests: { name: "release_acceptance", total: 41, passed: 40, failed: 1, skipped: 0, durationMs: 500, exitCode: 1 },
    fullRepoTests: { name: "full-repo", total: 1117, passed: 1117, failed: 0, skipped: 0, durationMs: 30000, exitCode: 0 },
    typeScriptCheck: { exitCode: 0, durationMs: 5000, errorCount: 0 },
    builds: [{ name: "npm run build", exitCode: 0, durationMs: 10000 }],
    schemaVerification: { migrationsApplied: ["001"], idempotent: true, exitCode: 0 },
    smokeProfiles: [],
  })
  const artifact = buildP91ReleaseArtifact(input)
  assert.equal(artifact.deterministicGates.verification.overallPassed, false, "T17 verification fails")
  assert.equal(artifact.deterministicGates.hardInvariantsAllPassed, true, "all hard invariants pass")
  assert.equal(artifact.deterministicGates.overallPassed, false, "verification failure → overallPassed=false")
})

test("P9.1 #2: hardInvariantsAllPassed is false when hardInvariants array is empty (no vacuous pass)", () => {
  const input = makePassingArtifactInput()
  input.hardInvariants = []
  const artifact = buildP91ReleaseArtifact(input)
  assert.equal(artifact.deterministicGates.hardInvariantsAllPassed, false, "empty hardInvariants → not all passed (no vacuous pass)")
  assert.equal(artifact.deterministicGates.overallPassed, false, "empty hardInvariants → overallPassed=false")
})

// ---------------------------------------------------------------------------
// #3 Blocked items — P5.3/D-002 and P9.2/D-003 explicitly marked
// ---------------------------------------------------------------------------

test("P9.1 #3: defaultBlockedItems includes P5.3 (D-002) and P9.2 (D-003)", () => {
  const blocked = defaultBlockedItems()
  const ids = blocked.map((b) => b.itemId)
  assert.ok(ids.includes("P5.3"), "P5.3 (OIDC) is in default blocked items")
  assert.ok(ids.includes("P9.2"), "P9.2 (ES+Neo4j) is in default blocked items")
  const d002 = blocked.find((b) => b.itemId === "P5.3")
  assert.equal(d002?.directiveId, "D-002", "P5.3 blocked by D-002")
  assert.equal(d002?.blocksProductionRelease, true, "P5.3 blocks production release")
  const d003 = blocked.find((b) => b.itemId === "P9.2")
  assert.equal(d003?.directiveId, "D-003", "P9.2 blocked by D-003")
  assert.equal(d003?.blocksProductionRelease, true, "P9.2 blocks production release")
})

test("P9.1 #3: blockedItems are attached by default (not silently skipped) — spec L14", () => {
  const artifact = buildP91ReleaseArtifact(makePassingArtifactInput())
  assert.ok(artifact.blockedItems.length >= 2, "blockedItems non-empty (explicit, not silent skip)")
  const reasons = artifact.blockedItems.map((b) => b.reason)
  assert.ok(reasons.every((r) => r.length > 0), "every blocked item has a reason")
})

test("P9.1 #3: caller can supply custom blockedItems", () => {
  const custom: BlockedItem[] = [
    { itemId: "P5.3", directiveId: "D-002", reason: "custom reason", blocksProductionRelease: true },
  ]
  const artifact = buildP91ReleaseArtifact({ ...makePassingArtifactInput(), blockedItems: custom })
  assert.equal(artifact.blockedItems.length, 1, "custom blockedItems override default")
  assert.equal(artifact.blockedItems[0].reason, "custom reason")
})

// ---------------------------------------------------------------------------
// #4 Non-deterministic signals — RAGAS/Langfuse bypass-only, cannot override
// ---------------------------------------------------------------------------

test("P9.1 #4: defaultNonDeterministicSignals includes ragas_shadow and langfuse", () => {
  const signals = defaultNonDeterministicSignals()
  const names = signals.map((s) => s.name)
  assert.ok(names.includes("ragas_shadow"), "ragas_shadow is a non-deterministic signal")
  assert.ok(names.includes("langfuse"), "langfuse is a non-deterministic signal")
  for (const s of signals) {
    assert.equal(s.role, "bypass_only", `${s.name} role is bypass_only`)
    assert.equal(s.canOverrideDeterministicGates, false, `${s.name} cannot override deterministic gates (spec L13)`)
  }
})

test("P9.1 #4: nonDeterministicSignals do NOT affect deterministicGates.overallPassed (spec L13)", () => {
  // Even with non-deterministic signals present, a deterministic failure stays a failure
  const input = makePassingArtifactInput()
  input.hardInvariants = [...makePassingHardInvariants()]
  input.hardInvariants[0] = { ...input.hardInvariants[0], passed: false }
  const artifact = buildP91ReleaseArtifact(input)
  assert.ok(artifact.nonDeterministicSignals.length >= 2, "non-deterministic signals present")
  assert.equal(artifact.deterministicGates.overallPassed, false, "deterministic failure is NOT overridden by non-deterministic signals")
})

test("P9.1 #4: nonDeterministicSignals are structurally separate from deterministicGates", () => {
  const artifact = buildP91ReleaseArtifact(makePassingArtifactInput())
  const dgKeys = Object.keys(artifact.deterministicGates)
  assert.ok(!dgKeys.includes("nonDeterministicSignals"), "nonDeterministicSignals NOT nested in deterministicGates")
  assert.ok(!dgKeys.includes("ragas_shadow"), "ragas_shadow NOT in deterministicGates")
  assert.ok(!dgKeys.includes("langfuse"), "langfuse NOT in deterministicGates")
})

// ---------------------------------------------------------------------------
// #5 Artifact completeness — all fields non-null, JSON-serializable
// ---------------------------------------------------------------------------

test("P9.1 #5: artifact is fully JSON-serializable (no Date, no undefined, no functions)", () => {
  const artifact = buildP91ReleaseArtifact(makePassingArtifactInput())
  const json = JSON.stringify(artifact)
  assert.ok(json !== undefined, "artifact is JSON-serializable")
  assert.ok(!json.includes("undefined"), "no 'undefined' literal in serialized JSON")
  const parsed = JSON.parse(json) as P91ReleaseArtifact
  assert.deepEqual(parsed, artifact, "round-trip preserves artifact structure")
})

test("P9.1 #5: rollbackEvidence has rollbackCommand and verified flag", () => {
  const artifact = buildP91ReleaseArtifact(makePassingArtifactInput())
  assert.ok(artifact.rollbackEvidence.rollbackCommand.length > 0, "rollbackCommand is non-empty")
  assert.equal(typeof artifact.rollbackEvidence.verified, "boolean", "verified is boolean")
})

test("P9.1 #5: defaultRollbackEvidence references P9.1 aggregator files", () => {
  const rb = defaultRollbackEvidence()
  assert.match(rb.rollbackCommand, /p9_1_release_artifact\.ts/, "rollback targets the aggregator module")
  assert.match(rb.rollbackCommand, /p9_1_release_artifact\.test\.ts/, "rollback targets the test file")
  assert.equal(rb.verified, true, "rollback path is verified")
})

// ---------------------------------------------------------------------------
// #6 releaseBlocked vs overallPassed — distinct flags (spec L14)
// ---------------------------------------------------------------------------

test("P9.1 #6: releaseBlocked is true when blockedItems is non-empty (default)", () => {
  const artifact = buildP91ReleaseArtifact(makePassingArtifactInput())
  assert.equal(artifact.blockedItems.length > 0, true, "default blockedItems non-empty")
  assert.equal(artifact.releaseBlocked, true, "releaseBlocked=true when operator prerequisites pending")
  // Deterministic gates can still pass independently
  assert.equal(artifact.deterministicGates.overallPassed, true, "deterministic gates pass independent of releaseBlocked")
})

test("P9.1 #6: releaseBlocked is false when blockedItems is empty (all prerequisites resolved)", () => {
  const artifact = buildP91ReleaseArtifact({ ...makePassingArtifactInput(), blockedItems: [] })
  assert.equal(artifact.blockedItems.length, 0, "no blocked items")
  assert.equal(artifact.releaseBlocked, false, "releaseBlocked=false when no operator prerequisites pending")
})

test("P9.1 #6: releaseBlocked and deterministicGates.overallPassed are independent flags", () => {
  // Case A: deterministic pass + release blocked (operator prerequisites pending)
  const a = buildP91ReleaseArtifact(makePassingArtifactInput())
  assert.equal(a.deterministicGates.overallPassed, true)
  assert.equal(a.releaseBlocked, true)
  // Case B: deterministic fail + release blocked
  const bInput = makePassingArtifactInput()
  bInput.hardInvariants = [makeFailingHardInvariant()]
  const b = buildP91ReleaseArtifact(bInput)
  assert.equal(b.deterministicGates.overallPassed, false)
  assert.equal(b.releaseBlocked, true)
  // Case C: deterministic pass + release not blocked
  const c = buildP91ReleaseArtifact({ ...makePassingArtifactInput(), blockedItems: [] })
  assert.equal(c.deterministicGates.overallPassed, true)
  assert.equal(c.releaseBlocked, false)
})

// ---------------------------------------------------------------------------
// #7 Persistence — writeP91ReleaseArtifact round-trip
// ---------------------------------------------------------------------------

test("P9.1 #7: writeP91ReleaseArtifact writes valid JSON to disk (round-trip)", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "p91-artifact-"))
  try {
    const filePath = join(tmpDir, "p91_release.json")
    const artifact = buildP91ReleaseArtifact(makePassingArtifactInput())
    const writtenJson = writeP91ReleaseArtifact(filePath, artifact)
    const fileContent = readFileSync(filePath, "utf8")
    assert.equal(fileContent, writtenJson + "\n", "file content matches returned JSON + newline")
    const parsed = JSON.parse(fileContent) as P91ReleaseArtifact
    assert.equal(parsed.schemaVersion, 1, "parsed artifact has schemaVersion=1")
    assert.equal(parsed.item, "P9.1", "parsed artifact has item='P9.1'")
    assert.equal(parsed.deterministicGates.overallPassed, true, "parsed artifact preserves deterministicGates.overallPassed")
    assert.equal(parsed.releaseBlocked, true, "parsed artifact preserves releaseBlocked")
    assert.equal(parsed.blockedItems.length, 2, "parsed artifact preserves blockedItems")
    assert.equal(parsed.nonDeterministicSignals.length, 2, "parsed artifact preserves nonDeterministicSignals")
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("P9.1 #7: writeP91ReleaseArtifact JSON is pretty-printed (2-space indent)", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "p91-artifact-"))
  try {
    const filePath = join(tmpDir, "p91_release.json")
    const artifact = buildP91ReleaseArtifact(makePassingArtifactInput())
    const json = writeP91ReleaseArtifact(filePath, artifact)
    assert.match(json, /\n {2}"schemaVersion"/, "JSON is pretty-printed with 2-space indent")
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 蓝军 self-check — spec L13/L14/L77 red lines
// ---------------------------------------------------------------------------

test("P9.1 蓝军 #1: RAGAS shadow is NOT in deterministicGates (spec L13 — cannot override)", () => {
  const artifact = buildP91ReleaseArtifact(makePassingArtifactInput())
  const dgJson = JSON.stringify(artifact.deterministicGates)
  assert.ok(!dgJson.includes("ragas_shadow"), "ragas_shadow NOT present in deterministicGates")
  assert.ok(!dgJson.includes("langfuse"), "langfuse NOT present in deterministicGates")
})

test("P9.1 蓝军 #2: blockedItems are explicit, not silently skipped (spec L14)", () => {
  const artifact = buildP91ReleaseArtifact(makePassingArtifactInput())
  // Every blocked item must have itemId + directiveId + reason + blocksProductionRelease
  for (const b of artifact.blockedItems) {
    assert.ok(b.itemId.length > 0, `blocked item has itemId: ${b.itemId}`)
    assert.ok(b.directiveId.length > 0, `blocked item ${b.itemId} has directiveId`)
    assert.ok(b.reason.length > 0, `blocked item ${b.itemId} has reason`)
    assert.equal(typeof b.blocksProductionRelease, "boolean", `blocked item ${b.itemId} has blocksProductionRelease boolean`)
  }
  assert.equal(artifact.releaseBlocked, true, "releaseBlocked reflects the blockage (not silent)")
})

test("P9.1 蓝军 #3: artifact contains all 4 aggregation dimensions (spec L77)", () => {
  const artifact = buildP91ReleaseArtifact(makePassingArtifactInput())
  // spec L77: "确定性 hard invariants、构建/类型/测试/schema、生产 smoke 和 rollback evidence"
  assert.ok(artifact.deterministicGates.hardInvariants.length > 0, "hard invariants aggregated")
  assert.ok(artifact.deterministicGates.verification, "build/type/test/schema/smoke aggregated (T17)")
  assert.ok(artifact.rollbackEvidence, "rollback evidence aggregated")
  // blocked items + non-deterministic signals are the P9.1-specific additions
  assert.ok(artifact.blockedItems.length > 0, "blocked items explicitly accounted")
  assert.ok(artifact.nonDeterministicSignals.length > 0, "non-deterministic signals explicitly marked bypass-only")
})

test("P9.1 蓝军 #4: rollbackEvidence.rollbackCommand targets only P9.1 files (no production code revert)", () => {
  const artifact = buildP91ReleaseArtifact(makePassingArtifactInput())
  const cmd = artifact.rollbackEvidence.rollbackCommand
  assert.ok(!cmd.includes("release_verification.ts"), "rollback does NOT touch T17 module")
  assert.ok(!cmd.includes("hard_invariants.ts"), "rollback does NOT touch hard invariants module")
  assert.ok(!cmd.includes("artifact.ts\n"), "rollback does NOT touch EvaluationArtifact module")
})

test("P9.1 蓝军 #5: deterministic failure cannot be masked by adding non-deterministic signals (spec L13)", () => {
  const input = makePassingArtifactInput()
  input.hardInvariants = [makeFailingHardInvariant()]
  // Add many non-deterministic signals — they must NOT flip the deterministic failure
  input.nonDeterministicSignals = [
    { name: "ragas_shadow", role: "bypass_only", canOverrideDeterministicGates: false },
    { name: "langfuse", role: "bypass_only", canOverrideDeterministicGates: false },
  ]
  const artifact = buildP91ReleaseArtifact(input)
  assert.equal(artifact.deterministicGates.overallPassed, false, "deterministic failure stays failure regardless of non-deterministic signals")
})
