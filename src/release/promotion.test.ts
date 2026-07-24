// Ticket 04 — Promotion contract tests (TDD red phase).
//
// Tests cover all 8 acceptance criteria:
//   1. Schema validation (valid, missing field, wrong type)
//   2. Hash computation + tamper detection
//   3. Promotion rejection conditions (dirty worktree, revision mismatch,
//      profile mismatch, stale/missing evidence, failed gate, missing probe,
//      unverified rollback)
//   4. Empty collection rejection (hard invariants, smoke results)
//   5. Non-deterministic override rejection (RAGAS/Langfuse can't flip failure)
//   6. Promotion-check command only validates (never reruns/mutates)
//   7. Successful local/production fixture tests
//   8. Full suite passes (covered by npm test)

import test from "node:test"
import assert from "node:assert/strict"

import { computeEvidenceHash } from "./runner"
import type {
  GateResult,
  HardInvariantStatus,
  ReleaseRunnerArtifact,
} from "./runner"
import type { HardInvariantResult } from "../evaluation/types"
import type { ProbeRunResult, ProbeName } from "./smoke_harness"

import {
  validateArtifactSchema,
  checkPromotion,
} from "./promotion"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeGateResult(overrides: Partial<GateResult> = {}): GateResult {
  return {
    name: "stub",
    command: "stub",
    args: [],
    exitCode: 0,
    durationMs: 1,
    outputTail: [],
    failureCategory: "none",
    ...overrides,
  }
}

function makeHardInvariantResults(
  count: number = 8,
): HardInvariantResult[] {
  const keys = [
    "terminal_convergence_100",
    "unknown_citation_count_zero",
    "knowledge_completed_zero_refs_zero",
    "unauthorized_evidence_zero",
    "direct_route_completion_without_retrieval_95",
    "cancellation_late_answer_zero",
    "tool_loop_budget_termination",
    "unauthorized_tool_rejection",
  ]
  return keys.slice(0, count).map((key) => ({
    key: key as HardInvariantResult["key"],
    passed: true,
    expected: "100%",
    actual: "60/60",
    failingCaseIds: [],
  }))
}

function makeSmokeResults(count: number = 12): ProbeRunResult[] {
  const names: ProbeName[] = [
    "markitdown",
    "marker",
    "mineru",
    "elasticsearch_vector",
    "elasticsearch_bm25",
    "neo4j",
    "pageindex",
    "review_ingestion",
    "chat_embedding_providers",
    "cancellation",
    "graceful_shutdown",
    "citation_integrity",
    "whole_run_budget",
    "langfuse",
  ]
  return names.slice(0, count).map((name) => ({
    name,
    profile: "production" as const,
    status: "passed" as const,
    durationMs: 100,
    redacted: false,
  }))
}

function makeValidProductionArtifact(
  overrides: Partial<ReleaseRunnerArtifact> = {},
): ReleaseRunnerArtifact {
  const base: ReleaseRunnerArtifact = {
    schemaVersion: 2,
    profile: "production",
    generatedAt: "2026-07-23T10:00:00Z",
    repositoryRevision: "abc123def456",
    gates: [
      makeGateResult({ name: "npm_test" }),
      makeGateResult({ name: "tsc_build" }),
      makeGateResult({ name: "frontend_build" }),
      makeGateResult({ name: "schema_verify" }),
      makeGateResult({ name: "hard_invariants" }),
      makeGateResult({ name: "clean_worktree" }),
      makeGateResult({ name: "smoke_evidence" }),
    ],
    hardInvariantStatus: "passed",
    hardInvariantResults: makeHardInvariantResults(),
    smokeResults: makeSmokeResults(),
    overallPassed: true,
    productionReady: true,
    dirtyWorktree: false,
    evidenceHash: "",
    rollbackEvidence: {
      verified: true,
      revision: "abc123def456",
      steps: ["git checkout abc123def456", "npm test", "git checkout -"],
    },
  }
  base.evidenceHash = computeEvidenceHash(base)
  const artifact = { ...base, ...overrides }
  // Recompute hash after overrides so the hash matches the final artifact
  artifact.evidenceHash = computeEvidenceHash(artifact)
  return artifact
}

function makeValidLocalArtifact(
  overrides: Partial<ReleaseRunnerArtifact> = {},
): ReleaseRunnerArtifact {
  const base: ReleaseRunnerArtifact = {
    schemaVersion: 2,
    profile: "local",
    generatedAt: "2026-07-23T10:00:00Z",
    repositoryRevision: "abc123def456",
    gates: [
      makeGateResult({ name: "npm_test" }),
      makeGateResult({ name: "tsc_build" }),
      makeGateResult({ name: "frontend_build" }),
      makeGateResult({ name: "schema_verify" }),
      makeGateResult({ name: "hard_invariants", blocked: true }),
      makeGateResult({ name: "git_diff_check" }),
    ],
    hardInvariantStatus: "blocked",
    hardInvariantResults: [],
    smokeResults: [],
    overallPassed: true,
    productionReady: false,
    dirtyWorktree: false,
    evidenceHash: "",
  }
  base.evidenceHash = computeEvidenceHash(base)
  const artifact = { ...base, ...overrides }
  artifact.evidenceHash = computeEvidenceHash(artifact)
  return artifact
}

// ---------------------------------------------------------------------------
// Criterion 1: Schema validation
// ---------------------------------------------------------------------------

test("schema validation: valid production artifact passes", () => {
  const artifact = makeValidProductionArtifact()
  const result = validateArtifactSchema(artifact)
  assert.ok(result.valid, `valid artifact should pass: ${result.errors.join(", ")}`)
  assert.equal(result.errors.length, 0)
})

test("schema validation: valid local artifact passes", () => {
  const artifact = makeValidLocalArtifact()
  const result = validateArtifactSchema(artifact)
  assert.ok(result.valid, `valid local artifact should pass: ${result.errors.join(", ")}`)
})

test("schema validation: missing schemaVersion fails", () => {
  const artifact = makeValidProductionArtifact()
  const bad = { ...artifact } as Record<string, unknown>
  delete bad.schemaVersion
  const result = validateArtifactSchema(bad)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.includes("schemaVersion")))
})

test("schema validation: wrong type for schemaVersion fails", () => {
  const artifact = makeValidProductionArtifact()
  const result = validateArtifactSchema({ ...artifact, schemaVersion: "2" })
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.includes("schemaVersion")))
})

test("schema validation: missing dirtyWorktree fails", () => {
  const artifact = makeValidProductionArtifact()
  const bad = { ...artifact } as Record<string, unknown>
  delete bad.dirtyWorktree
  const result = validateArtifactSchema(bad)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.includes("dirtyWorktree")))
})

test("schema validation: missing evidenceHash fails", () => {
  const artifact = makeValidProductionArtifact()
  const bad = { ...artifact } as Record<string, unknown>
  delete bad.evidenceHash
  const result = validateArtifactSchema(bad)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.includes("evidenceHash")))
})

test("schema validation: missing hardInvariantResults fails", () => {
  const artifact = makeValidProductionArtifact()
  const bad = { ...artifact } as Record<string, unknown>
  delete bad.hardInvariantResults
  const result = validateArtifactSchema(bad)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.includes("hardInvariantResults")))
})

test("schema validation: missing smokeResults fails", () => {
  const artifact = makeValidProductionArtifact()
  const bad = { ...artifact } as Record<string, unknown>
  delete bad.smokeResults
  const result = validateArtifactSchema(bad)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.includes("smokeResults")))
})

test("schema validation: invalid profile value fails", () => {
  const artifact = makeValidProductionArtifact()
  const result = validateArtifactSchema({ ...artifact, profile: "staging" })
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.includes("profile")))
})

// ---------------------------------------------------------------------------
// Criterion 2: Hash computation + tamper detection
// ---------------------------------------------------------------------------

test("hash: same content produces same hash", () => {
  const a1 = makeValidProductionArtifact()
  const a2 = makeValidProductionArtifact()
  assert.equal(
    computeEvidenceHash(a1),
    computeEvidenceHash(a2),
    "identical artifacts produce identical hashes",
  )
})

test("hash: different gate exit code produces different hash", () => {
  const a1 = makeValidProductionArtifact()
  const a2 = makeValidProductionArtifact({
    gates: a1.gates.map((g) =>
      g.name === "npm_test" ? { ...g, exitCode: 1, failureCategory: "non_zero_exit" as const } : g,
    ),
  })
  assert.notEqual(
    computeEvidenceHash(a1),
    computeEvidenceHash(a2),
    "different gate results produce different hashes",
  )
})

test("hash: non-deterministic reports do not affect hash", () => {
  const a1 = makeValidProductionArtifact()
  const a2 = makeValidProductionArtifact({
    nonDeterministicReports: { ragasShadow: { score: 0.95 } },
  })
  assert.equal(
    computeEvidenceHash(a1),
    computeEvidenceHash(a2),
    "non-deterministic reports must not affect evidence hash",
  )
})

test("hash: tampered artifact (stale hash) is rejected by schema validation", () => {
  const artifact = makeValidProductionArtifact()
  // Tamper: change a gate result but keep the old hash
  const tampered: ReleaseRunnerArtifact = {
    ...artifact,
    gates: artifact.gates.map((g) =>
      g.name === "npm_test" ? { ...g, exitCode: 1, failureCategory: "non_zero_exit" as const } : g,
    ),
  }
  // evidenceHash is still the old hash (from the untampered artifact)
  const result = validateArtifactSchema(tampered)
  assert.equal(result.valid, false)
  assert.ok(
    result.errors.some((e) => e.includes("evidenceHash") || e.includes("hash") || e.includes("tamper")),
    `should detect hash mismatch: ${result.errors.join(", ")}`,
  )
})

// ---------------------------------------------------------------------------
// Criterion 3: Promotion rejection conditions
// ---------------------------------------------------------------------------

test("promotion: dirty worktree → rejected", () => {
  const artifact = makeValidProductionArtifact({ dirtyWorktree: true })
  const result = checkPromotion(artifact, { expectedRevision: "abc123def456" })
  assert.equal(result.promoted, false)
  assert.ok(
    result.reasons.some((r) => r.includes("dirty") || r.includes("worktree")),
    `should reject dirty worktree: ${result.reasons.join(", ")}`,
  )
})

test("promotion: revision mismatch → rejected", () => {
  const artifact = makeValidProductionArtifact({ repositoryRevision: "abc123" })
  // Need to recompute hash because revision changed
  artifact.evidenceHash = computeEvidenceHash(artifact)
  const result = checkPromotion(artifact, { expectedRevision: "different789" })
  assert.equal(result.promoted, false)
  assert.ok(
    result.reasons.some((r) => r.includes("revision") || r.includes("mismatch")),
    `should reject revision mismatch: ${result.reasons.join(", ")}`,
  )
})

test("promotion: profile mismatch (local promoted as production) → rejected", () => {
  const artifact = makeValidLocalArtifact()
  const result = checkPromotion(artifact, { expectedRevision: "abc123def456" })
  assert.equal(result.promoted, false)
  assert.ok(
    result.reasons.some((r) => r.includes("profile")),
    `should reject local profile for production promotion: ${result.reasons.join(", ")}`,
  )
})

test("promotion: failed deterministic gate → rejected", () => {
  const artifact = makeValidProductionArtifact({
    gates: [
      makeGateResult({ name: "npm_test", exitCode: 1, failureCategory: "non_zero_exit" }),
      ...makeValidProductionArtifact().gates.slice(1),
    ],
    overallPassed: false,
  })
  artifact.evidenceHash = computeEvidenceHash(artifact)
  const result = checkPromotion(artifact, { expectedRevision: "abc123def456" })
  assert.equal(result.promoted, false)
  assert.ok(
    result.reasons.some((r) => r.includes("gate") || r.includes("failed") || r.includes("deterministic")),
    `should reject failed gate: ${result.reasons.join(", ")}`,
  )
})

test("promotion: missing required probe (no smoke_evidence gate) → rejected", () => {
  const artifact = makeValidProductionArtifact({
    gates: makeValidProductionArtifact().gates.filter((g) => g.name !== "smoke_evidence"),
  })
  artifact.evidenceHash = computeEvidenceHash(artifact)
  const result = checkPromotion(artifact, { expectedRevision: "abc123def456" })
  assert.equal(result.promoted, false)
  assert.ok(
    result.reasons.some((r) => r.includes("probe") || r.includes("smoke") || r.includes("missing")),
    `should reject missing smoke_evidence probe: ${result.reasons.join(", ")}`,
  )
})

test("promotion: unverified rollback evidence → rejected", () => {
  const artifact = makeValidProductionArtifact({
    rollbackEvidence: {
      verified: false,
      revision: "abc123def456",
      steps: ["attempted but failed"],
    },
  })
  artifact.evidenceHash = computeEvidenceHash(artifact)
  const result = checkPromotion(artifact, { expectedRevision: "abc123def456" })
  assert.equal(result.promoted, false)
  assert.ok(
    result.reasons.some((r) => r.includes("rollback") || r.includes("unverified")),
    `should reject unverified rollback: ${result.reasons.join(", ")}`,
  )
})

test("promotion: missing rollback evidence → rejected", () => {
  const artifact = makeValidProductionArtifact()
  delete artifact.rollbackEvidence
  artifact.evidenceHash = computeEvidenceHash(artifact)
  const result = checkPromotion(artifact, { expectedRevision: "abc123def456" })
  assert.equal(result.promoted, false)
  assert.ok(
    result.reasons.some((r) => r.includes("rollback")),
    `should reject missing rollback evidence: ${result.reasons.join(", ")}`,
  )
})

test("promotion: stale/missing evidence (hash mismatch) → rejected", () => {
  const artifact = makeValidProductionArtifact()
  // Tamper: change a field that affects the hash but don't update the hash
  const tampered: ReleaseRunnerArtifact = {
    ...artifact,
    overallPassed: false,
    productionReady: false,
  }
  // evidenceHash is still from the original (overallPassed=true) artifact
  const result = checkPromotion(tampered, { expectedRevision: "abc123def456" })
  assert.equal(result.promoted, false)
  assert.ok(
    result.reasons.some((r) => r.includes("hash") || r.includes("tamper") || r.includes("evidence")),
    `should reject tampered evidence: ${result.reasons.join(", ")}`,
  )
})

// ---------------------------------------------------------------------------
// Criterion 4: Empty collection rejection
// ---------------------------------------------------------------------------

test("promotion: empty hard-invariant collection → rejected (not vacuous success)", () => {
  const artifact = makeValidProductionArtifact({
    hardInvariantResults: [],
    hardInvariantStatus: "not_run" as HardInvariantStatus,
  })
  artifact.evidenceHash = computeEvidenceHash(artifact)
  const result = checkPromotion(artifact, { expectedRevision: "abc123def456" })
  assert.equal(result.promoted, false)
  assert.ok(
    result.reasons.some((r) => r.includes("hard") || r.includes("invariant") || r.includes("empty")),
    `should reject empty hard invariants: ${result.reasons.join(", ")}`,
  )
})

test("promotion: empty smoke collection → rejected (not vacuous success)", () => {
  const artifact = makeValidProductionArtifact({
    smokeResults: [],
  })
  artifact.evidenceHash = computeEvidenceHash(artifact)
  const result = checkPromotion(artifact, { expectedRevision: "abc123def456" })
  assert.equal(result.promoted, false)
  assert.ok(
    result.reasons.some((r) => r.includes("smoke") || r.includes("empty")),
    `should reject empty smoke results: ${result.reasons.join(", ")}`,
  )
})

// ---------------------------------------------------------------------------
// Criterion 5: Non-deterministic override rejection
// ---------------------------------------------------------------------------

test("promotion: RAGAS present but deterministic gate failed → still rejected", () => {
  const artifact = makeValidProductionArtifact({
    gates: [
      makeGateResult({ name: "npm_test", exitCode: 1, failureCategory: "non_zero_exit" }),
      ...makeValidProductionArtifact().gates.slice(1),
    ],
    overallPassed: false,
    productionReady: false,
    nonDeterministicReports: {
      ragasShadow: { score: 0.99, summary: "excellent" },
    },
  })
  artifact.evidenceHash = computeEvidenceHash(artifact)
  const result = checkPromotion(artifact, { expectedRevision: "abc123def456" })
  assert.equal(result.promoted, false, "RAGAS cannot flip a deterministic failure to pass")
  assert.ok(
    result.reasons.some((r) => r.includes("gate") || r.includes("failed") || r.includes("deterministic")),
    `should still reject despite RAGAS: ${result.reasons.join(", ")}`,
  )
})

test("promotion: Langfuse present but hard invariant failed → still rejected", () => {
  const artifact = makeValidProductionArtifact({
    hardInvariantStatus: "failed" as HardInvariantStatus,
    hardInvariantResults: makeHardInvariantResults().map((r, i) =>
      i === 0 ? { ...r, passed: false, failingCaseIds: ["case-1"] } : r,
    ),
    overallPassed: false,
    nonDeterministicReports: {
      langfuse: { traces: 100, sessions: 50 },
    },
  })
  artifact.evidenceHash = computeEvidenceHash(artifact)
  const result = checkPromotion(artifact, { expectedRevision: "abc123def456" })
  assert.equal(result.promoted, false, "Langfuse cannot flip a hard invariant failure to pass")
})

test("structural separation: non-deterministic reports are separate from gates", () => {
  const artifact = makeValidProductionArtifact({
    nonDeterministicReports: {
      ragasShadow: { score: 0.95 },
      langfuse: { traces: 42 },
    },
  })
  // The artifact's gates should NOT contain RAGAS or Langfuse as gates
  const gateNames = artifact.gates.map((g) => g.name)
  assert.ok(!gateNames.includes("ragas"), "RAGAS must not be a gate")
  assert.ok(!gateNames.includes("langfuse"), "Langfuse must not be a gate")
  // nonDeterministicReports is a separate structural section
  assert.ok(artifact.nonDeterministicReports, "nonDeterministicReports exists as separate section")
})

// ---------------------------------------------------------------------------
// Criterion 7: Successful local/production fixtures
// ---------------------------------------------------------------------------

test("promotion: valid production artifact with all conditions met → promoted", () => {
  const artifact = makeValidProductionArtifact()
  const result = checkPromotion(artifact, { expectedRevision: "abc123def456" })
  assert.equal(result.promoted, true, `should promote valid artifact: ${result.reasons.join(", ")}`)
  assert.equal(result.reasons.length, 0)
})

test("promotion: local artifact passes schema validation but is NOT promoted", () => {
  const artifact = makeValidLocalArtifact()
  const schemaResult = validateArtifactSchema(artifact)
  assert.ok(schemaResult.valid, "local artifact should pass schema validation")
  const promoResult = checkPromotion(artifact, { expectedRevision: "abc123def456" })
  assert.equal(promoResult.promoted, false, "local artifact should not be promoted to production")
  assert.ok(
    promoResult.reasons.some((r) => r.includes("profile")),
    `should reject local profile: ${promoResult.reasons.join(", ")}`,
  )
})

// ---------------------------------------------------------------------------
// Criterion 6: Promotion-check command only validates (never reruns/mutates)
// ---------------------------------------------------------------------------

test("promotion: checkPromotion does not modify the input artifact", () => {
  const artifact = makeValidProductionArtifact()
  const originalJson = JSON.stringify(artifact)
  checkPromotion(artifact, { expectedRevision: "abc123def456" })
  assert.equal(
    JSON.stringify(artifact),
    originalJson,
    "checkPromotion must not mutate the input artifact",
  )
})

test("promotion: checkPromotion on artifact with extra fields still works (forward-compatible)", () => {
  const artifact = makeValidProductionArtifact()
  const withExtra = { ...artifact, futureField: "value" }
  const result = checkPromotion(withExtra, { expectedRevision: "abc123def456" })
  // Should still promote — extra fields are ignored
  assert.equal(result.promoted, true, "extra fields should not block promotion")
})

// ---------------------------------------------------------------------------
// Ticket 02 — V2 canonical release artifact schema
// ---------------------------------------------------------------------------

test("Ticket 02: V1 artifact (schemaVersion=1) fails schema validation", () => {
  const v2 = makeValidProductionArtifact()
  const v1 = { ...v2, schemaVersion: 1 as const }
  const result = validateArtifactSchema(v1)
  assert.equal(result.valid, false, "V1 artifact must not pass schema validation")
  assert.ok(
    result.errors.some((e) => e.includes("schemaVersion") && e.includes("V1")),
    `should explicitly reject V1 as diagnostic-only: ${result.errors.join(", ")}`,
  )
})

test("Ticket 02: V1 artifact is rejected for production promotion", () => {
  const v2 = makeValidProductionArtifact()
  const v1 = { ...v2, schemaVersion: 1 as const } as unknown as ReleaseRunnerArtifact
  const result = checkPromotion(v1, { expectedRevision: "abc123def456" })
  assert.equal(result.promoted, false, "V1 must never be promoted to production")
  assert.ok(
    result.reasons.some((r) => r.includes("schemaVersion") || r.includes("V1") || r.includes("diagnostic")),
    `should reject V1 for production: ${result.reasons.join(", ")}`,
  )
})

test("Ticket 02: V2 valid artifact passes schema and hash validation", () => {
  const artifact = makeValidProductionArtifact()
  assert.equal(artifact.schemaVersion, 2, "fixture must produce V2")
  const schemaResult = validateArtifactSchema(artifact)
  assert.ok(schemaResult.valid, `V2 should pass schema: ${schemaResult.errors.join(", ")}`)
  assert.equal(schemaResult.errors.length, 0)
})

test("Ticket 02: V2 local artifact passes schema validation", () => {
  const artifact = makeValidLocalArtifact()
  assert.equal(artifact.schemaVersion, 2)
  const result = validateArtifactSchema(artifact)
  assert.ok(result.valid, `V2 local should pass schema: ${result.errors.join(", ")}`)
})
