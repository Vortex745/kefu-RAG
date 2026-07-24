// Ticket 02 — Startup promotion gate tests (V2 ReleaseRunnerArtifact).
//
// These tests verify the Mastra startup gate behavior:
//   - limited startup: no artifact required (always available)
//   - default startup: requires a persisted passing V2 production artifact
//   - default startup: rejects V1, malformed, and failed artifacts
//   - composition root: freezes mode before runtime resources
//
// Ticket 02 update: fixture switched from T17 ReleaseVerificationArtifact
// (schemaVersion=1) to V2 ReleaseRunnerArtifact (schemaVersion=2). The
// startup gate now validates via validateArtifactSchema + checkPromotion.

import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { computeEvidenceHash } from "../release/runner"
import type {
  GateResult,
  HardInvariantStatus,
  ReleaseRunnerArtifact,
} from "../release/runner"
import type { HardInvariantResult } from "../evaluation/types"
import type { ProbeRunResult, ProbeName } from "../release/smoke_harness"

import {
  MASTRA_PROMOTION_ARTIFACT_ENV,
  assertRuntimeModeStartupAllowed,
} from "./promotion_gate"

// ---------------------------------------------------------------------------
// V2 ReleaseRunnerArtifact fixture (Ticket 02)
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

function makeHardInvariantResults(): HardInvariantResult[] {
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
  return keys.map((key) => ({
    key: key as HardInvariantResult["key"],
    passed: true,
    expected: "100%",
    actual: "60/60",
    failingCaseIds: [],
  }))
}

function makeSmokeResults(): ProbeRunResult[] {
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
  return names.map((name) => ({
    name,
    profile: "production" as const,
    status: "passed" as const,
    durationMs: 100,
    redacted: false,
  }))
}

/**
 * Build a V2 ReleaseRunnerArtifact for startup tests.
 * `passing=true` produces a valid production-ready artifact.
 * `passing=false` produces an artifact with a failed gate (overallPassed=false).
 */
function v2Artifact(passing: boolean): ReleaseRunnerArtifact {
  const base: ReleaseRunnerArtifact = {
    schemaVersion: 2,
    profile: "production",
    generatedAt: "2026-07-24T00:00:00.000Z",
    repositoryRevision: "abc123def456",
    gates: passing
      ? [
          makeGateResult({ name: "npm_test" }),
          makeGateResult({ name: "tsc_build" }),
          makeGateResult({ name: "frontend_build" }),
          makeGateResult({ name: "schema_verify" }),
          makeGateResult({ name: "hard_invariants" }),
          makeGateResult({ name: "clean_worktree" }),
          makeGateResult({ name: "smoke_evidence" }),
        ]
      : [
          makeGateResult({ name: "npm_test", exitCode: 1, failureCategory: "non_zero_exit" }),
          makeGateResult({ name: "tsc_build" }),
          makeGateResult({ name: "frontend_build" }),
          makeGateResult({ name: "schema_verify" }),
          makeGateResult({ name: "hard_invariants" }),
          makeGateResult({ name: "clean_worktree" }),
          makeGateResult({ name: "smoke_evidence" }),
        ],
    hardInvariantStatus: "passed" as HardInvariantStatus,
    hardInvariantResults: makeHardInvariantResults(),
    smokeResults: makeSmokeResults(),
    overallPassed: passing,
    productionReady: passing,
    dirtyWorktree: false,
    evidenceHash: "",
    rollbackEvidence: {
      verified: true,
      revision: "abc123def456",
      steps: ["git checkout abc123def456", "npm test", "git checkout -"],
    },
  }
  base.evidenceHash = computeEvidenceHash(base)
  return base
}

// ---------------------------------------------------------------------------
// P1 regressions (preserved from T17 era, now using V2 artifacts)
// ---------------------------------------------------------------------------

test("P1 regression: limited startup does not require a promotion artifact", () => {
  assert.doesNotThrow(() => assertRuntimeModeStartupAllowed("limited", undefined))
})

test("P1 regression: default startup fails closed without a persisted artifact", () => {
  assert.throws(
    () => assertRuntimeModeStartupAllowed("default", undefined),
    new RegExp(MASTRA_PROMOTION_ARTIFACT_ENV)
  )
})

test("P1 regression: default startup rejects malformed or failed artifacts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mastra-promotion-"))
  try {
    const malformedPath = path.join(dir, "malformed.json")
    writeFileSync(malformedPath, "not json", "utf8")
    assert.throws(
      () => assertRuntimeModeStartupAllowed("default", malformedPath),
      /invalid promotion artifact/i
    )

    const failedPath = path.join(dir, "failed.json")
    writeFileSync(failedPath, JSON.stringify(v2Artifact(false)), "utf8")
    assert.throws(
      () => assertRuntimeModeStartupAllowed("default", failedPath),
      /Promotion to default blocked/
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("P1 regression: default startup accepts a persisted passing production artifact", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mastra-promotion-"))
  try {
    const artifactPath = path.join(dir, "passing.json")
    writeFileSync(artifactPath, JSON.stringify(v2Artifact(true)), "utf8")
    assert.doesNotThrow(() => assertRuntimeModeStartupAllowed("default", artifactPath))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Ticket 02 — V2 schema acceptance + V1/malformed rejection
// ---------------------------------------------------------------------------

test("Ticket 02: default startup rejects V1 artifact (schemaVersion=1)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mastra-promotion-v1-"))
  try {
    const v1Path = path.join(dir, "v1.json")
    // Construct a V1 artifact by downgrading schemaVersion of a valid V2
    const v2 = v2Artifact(true)
    const v1 = { ...v2, schemaVersion: 1 as const }
    writeFileSync(v1Path, JSON.stringify(v1), "utf8")
    assert.throws(
      () => assertRuntimeModeStartupAllowed("default", v1Path),
      /invalid promotion artifact/i,
      "V1 artifact must be rejected by default startup"
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Ticket 02: default startup rejects malformed JSON", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mastra-promotion-malformed-"))
  try {
    const malformedPath = path.join(dir, "malformed.json")
    writeFileSync(malformedPath, "{ not valid json }}}", "utf8")
    assert.throws(
      () => assertRuntimeModeStartupAllowed("default", malformedPath),
      /invalid promotion artifact/i,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Ticket 02: default startup rejects non-V2 shape (T17 ReleaseVerificationArtifact)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mastra-promotion-t17-"))
  try {
    const t17Path = path.join(dir, "t17.json")
    // A T17 artifact has a completely different shape (focusedTests, smokeProfiles, etc.)
    // It must be rejected because it is not a V2 ReleaseRunnerArtifact.
    const t17 = {
      schemaVersion: 1,
      ticket: "T17",
      generatedAt: "2026-07-20T00:00:00.000Z",
      repositoryRevision: "abc123",
      focusedTests: { name: "focused", total: 1, passed: 1, failed: 0, skipped: 0, durationMs: 1, exitCode: 0 },
      fullRepoTests: { name: "full", total: 1, passed: 1, failed: 0, skipped: 0, durationMs: 1, exitCode: 0 },
      typeScriptCheck: { exitCode: 0, durationMs: 1, errorCount: 0 },
      builds: [{ name: "build", exitCode: 0, durationMs: 1 }],
      schemaVerification: { exitCode: 0, idempotent: true, migrationsApplied: [] },
      smokeProfiles: [{ profile: "production", results: [], gatePassed: true }],
      overallPassed: true,
    }
    writeFileSync(t17Path, JSON.stringify(t17), "utf8")
    assert.throws(
      () => assertRuntimeModeStartupAllowed("default", t17Path),
      /invalid promotion artifact/i,
      "T17-shaped artifact must be rejected (not a V2 ReleaseRunnerArtifact)"
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Ticket 02: limited startup remains available without any artifact", () => {
  // Limited mode must never require an artifact — this is the application-level
  // recovery path that must always be available.
  assert.doesNotThrow(() => assertRuntimeModeStartupAllowed("limited", undefined))
  assert.doesNotThrow(() => assertRuntimeModeStartupAllowed("limited", "/nonexistent/path.json"))
})

// ---------------------------------------------------------------------------
// P1 regression: composition root ordering (unchanged by Ticket 02)
// ---------------------------------------------------------------------------

test("P1 regression: composition root freezes the accepted mode before runtime resources", () => {
  const source = readFileSync(path.join(__dirname, "..", "index.ts"), "utf8")
  const readModeAt = source.indexOf("const runtimeMode = readMastraRuntimeMode()")
  const startupGateAt = source.indexOf("assertRuntimeModeStartupAllowed(")
  const runtimeAt = source.indexOf("const answerRuntime = createAnswerRuntime(cfg)")

  assert.ok(readModeAt >= 0, "startup must read the runtime mode once")
  assert.ok(startupGateAt > readModeAt, "startup gate must use the accepted mode")
  assert.ok(runtimeAt > startupGateAt, "promotion gate must run before runtime resources")
  assert.match(
    source,
    /createMastraRuntimeBoundary\(\{[\s\S]*?modeReader: \(\) => runtimeMode/,
    "request dispatch must use the frozen startup mode"
  )
})
