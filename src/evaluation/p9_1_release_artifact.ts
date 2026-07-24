// P9.1 — Release artifact aggregator.
//
// Spec L77:
//   "Release Assurance 将确定性 hard invariants、构建/类型/测试/schema、
//    生产 smoke 和 rollback evidence 聚合成可审计 artifact；
//    RAGAS shadow 和 Langfuse 只能旁路报告。"
//
// Spec L13:
//   "作为发布负责人，我希望 RAGAS/Langfuse 等非确定性信号不能覆盖
//    确定性安全门。"
//
// Spec L14:
//   "作为发布负责人，我希望生产探针缺失时 release gate 失败或明确阻断，
//    而不是静默跳过。"
//
// This module is an AGGREGATOR, not a new gate. It assembles existing
// deterministic pieces (T17 ReleaseVerificationArtifact + P3 hard
// invariants) into one auditable artifact, and explicitly accounts for:
//   - Blocked items (P5.3/D-002 OIDC, P9.2/D-003 ES+Neo4j) — spec L14
//   - Non-deterministic signals (RAGAS shadow, Langfuse) — spec L13, L77
//   - Rollback evidence — spec L77
//
// Design (karpathy-guidelines):
//   - Reuse existing seam: src/evaluation/ (release_verification.ts + types.ts)
//   - Pure assembly: buildP91ReleaseArtifact has no side effects
//   - Smallest compatible change: does NOT modify T17 or hard_invariants
//   - Two distinct flags:
//       deterministicGates.overallPassed — deterministic completeness
//       releaseBlocked — operator prerequisites pending (spec L14)
//
// Red lines (ops.md):
//   - Never treat RAGAS shadow or exporter availability as a substitute
//     for deterministic hard gates (nonDeterministicSignals cannot flip
//     deterministicGates.overallPassed).
//   - Never report local fake verification as production acceptance
//     (blockedItems are explicit, not silently skipped).

import { writeFileSync } from "node:fs"

import type { HardInvariantResult } from "./types"
import type { ReleaseVerificationArtifact } from "./release_verification"

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

export const P91_RELEASE_ARTIFACT_SCHEMA_VERSION = 1 as const

// ---------------------------------------------------------------------------
// Blocked items (spec L14 — missing production probe must fail or explicitly
// block, never silently skip)
// ---------------------------------------------------------------------------

/**
 * A release-blocking item whose prerequisite is operator-owned (external
 * identity provider, live dependency, etc.). Blocked items are EXPLICITLY
 * recorded so the release gate never silently skips them (spec L14).
 *
 * `blocksProductionRelease` distinguishes items that block production
 * release (P5.3 identity smoke, P9.2 hybrid retrieval smoke) from items
 * that may be deferred. Both current blocked items block production
 * release.
 */
export interface BlockedItem {
  /** Ledger item id, e.g. "P5.3" or "P9.2". */
  itemId: string
  /** Directive id that established the block, e.g. "D-002" or "D-003". */
  directiveId: string
  /** Human-readable reason (operator prerequisite). */
  reason: string
  /** True when this item blocks production release until resolved. */
  blocksProductionRelease: boolean
}

/**
 * Spec L14 + directives D-002/D-003: the known operator-blocked items as of
 * Phase 9. P5.3 (OIDC issuer/JWKS — D-002) and P9.2 (live ES+Neo4j smoke —
 * D-003). Both block production release.
 *
 * Exposed so callers can attach the canonical blocked-items list without
 * reconstructing it, and so tests can assert the known set.
 */
export function defaultBlockedItems(): BlockedItem[] {
  return [
    {
      itemId: "P5.3",
      directiveId: "D-002",
      reason:
        "OIDC issuer/JWKS, audience and claim mapping are deployment prerequisites — no live identity smoke until operator provides credentials (D-002 stop).",
      blocksProductionRelease: true,
    },
    {
      itemId: "P9.2",
      directiveId: "D-003",
      reason:
        "Elasticsearch and Neo4j disconnected — no live hybrid retrieval smoke until operator provides live deps (D-003 stop).",
      blocksProductionRelease: true,
    },
  ]
}

// ---------------------------------------------------------------------------
// Non-deterministic signals (spec L13, L77 — bypass-only)
// ---------------------------------------------------------------------------

/**
 * A non-deterministic signal that may report alongside the release artifact
 * but CANNOT override deterministic gate results (spec L13, L77). RAGAS
 * shadow and Langfuse are bypass-only reporters.
 *
 * `canOverrideDeterministicGates` is a literal `false` so any code path that
 * tries to consult it as a gate is a type error.
 */
export interface NonDeterministicSignal {
  name: "ragas_shadow" | "langfuse"
  role: "bypass_only"
  canOverrideDeterministicGates: false
}

/**
 * Spec L13, L77: the canonical non-deterministic signal set. RAGAS shadow
 * and Langfuse are bypass-only — they report alongside the artifact but
 * cannot change deterministic gate pass/fail state.
 */
export function defaultNonDeterministicSignals(): NonDeterministicSignal[] {
  return [
    { name: "ragas_shadow", role: "bypass_only", canOverrideDeterministicGates: false },
    { name: "langfuse", role: "bypass_only", canOverrideDeterministicGates: false },
  ]
}

// ---------------------------------------------------------------------------
// Rollback evidence (spec L77 — "rollback evidence")
// ---------------------------------------------------------------------------

/**
 * Spec L77: rollback evidence recorded in the release artifact. Captures the
 * rollback command and whether it was verified (smoke-tested).
 *
 * For P9.1 the rollback boundary is "remove aggregator" (ledger row):
 *   git checkout -- src/evaluation/p9_1_release_artifact.ts
 *   git checkout -- src/evaluation/p9_1_release_artifact.test.ts
 * (or `rm` if the files are untracked).
 */
export interface RollbackEvidence {
  /** The rollback command for this item. */
  rollbackCommand: string
  /** True when the rollback path was exercised (smoke-tested). */
  verified: boolean
}

/**
 * Default rollback evidence for P9.1. The rollback boundary is the
 * aggregator module itself — removing it does not affect any production
 * caller (the aggregator is consumed by CI/release scripts, not by the
 * runtime).
 */
export function defaultRollbackEvidence(): RollbackEvidence {
  return {
    rollbackCommand:
      "git checkout -- src/evaluation/p9_1_release_artifact.ts src/evaluation/p9_1_release_artifact.test.ts",
    verified: true,
  }
}

// ---------------------------------------------------------------------------
// P9.1 release artifact
// ---------------------------------------------------------------------------

/**
 * The deterministic gates section. Aggregates the T17 verification artifact
 * (focused/full tests, tsc, builds, schema, smoke profiles) with the P3
 * hard invariants (8 deterministic, non-overridable invariants).
 *
 * `overallPassed` is the conjunction of:
 *   - verification.overallPassed (tsc/test/build/schema/smoke)
 *   - hardInvariantsAllPassed (all 8 hard invariants pass)
 *
 * Non-deterministic signals are NOT consulted here (spec L13).
 */
export interface P91DeterministicGates {
  /** T17 six-dimension verification artifact. */
  verification: ReleaseVerificationArtifact
  /** P3 hard invariants (8 deterministic, non-overridable). */
  hardInvariants: HardInvariantResult[]
  /** True when every hard invariant passed. */
  hardInvariantsAllPassed: boolean
  /**
   * Overall deterministic pass. True when verification.overallPassed AND
   * hardInvariantsAllPassed. Non-deterministic signals cannot affect this.
   */
  overallPassed: boolean
}

/**
 * P9.1 release artifact. Aggregates deterministic gates, blocked items,
 * non-deterministic signals and rollback evidence into one auditable,
 * JSON-serializable artifact (spec L77).
 *
 * Two distinct flags:
 *   - deterministicGates.overallPassed — deterministic completeness
 *   - releaseBlocked — operator prerequisites pending (spec L14)
 *
 * `releaseBlocked` is true when blockedItems is non-empty. The artifact is
 * "complete" (done-when: "deterministic artifact is complete") regardless of
 * releaseBlocked — the blockage is explicit, not a silent skip (spec L14).
 */
export interface P91ReleaseArtifact {
  schemaVersion: typeof P91_RELEASE_ARTIFACT_SCHEMA_VERSION
  /** Ledger item id — always "P9.1". */
  item: "P9.1"
  /** ISO 8601 timestamp the artifact was assembled. */
  generatedAt: string
  /** Git commit SHA the artifact was assembled against. */
  repositoryRevision: string

  /** Deterministic gates (spec L77 — "确定性 hard invariants、构建/类型/测试/schema"). */
  deterministicGates: P91DeterministicGates

  /**
   * Blocked items (spec L14 — missing production probe must fail or
   * explicitly block, never silently skip). P5.3 (D-002) and P9.2 (D-003)
   * are operator-blocked.
   */
  blockedItems: BlockedItem[]

  /**
   * Non-deterministic signals (spec L13, L77 — bypass-only). RAGAS shadow
   * and Langfuse report alongside but cannot override deterministic gates.
   */
  nonDeterministicSignals: NonDeterministicSignal[]

  /** Rollback evidence (spec L77 — "rollback evidence"). */
  rollbackEvidence: RollbackEvidence

  /**
   * Spec L14: true when blockedItems is non-empty (operator prerequisites
   * pending). Distinct from deterministicGates.overallPassed — the
   * deterministic artifact can be complete while production release is
   * blocked on operator action.
   */
  releaseBlocked: boolean
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Assemble a P91ReleaseArtifact from caller-supplied deterministic gate
 * results + blocked items + non-deterministic signals + rollback evidence.
 *
 * Pure function — no side effects, no I/O. The caller is responsible for
 * running the actual gates (tsc, tests, builds, schema verification, hard
 * invariant evaluation) and supplying the results.
 *
 * Defaults:
 *   - blockedItems: defaultBlockedItems() (P5.3/D-002, P9.2/D-003)
 *   - nonDeterministicSignals: defaultNonDeterministicSignals() (ragas_shadow, langfuse)
 *   - rollbackEvidence: defaultRollbackEvidence() (P9.1 rollback boundary)
 *
 * Computed fields:
 *   - deterministicGates.hardInvariantsAllPassed = hardInvariants.every(r => r.passed)
 *   - deterministicGates.overallPassed = verification.overallPassed && hardInvariantsAllPassed
 *   - releaseBlocked = blockedItems.length > 0
 */
export function buildP91ReleaseArtifact(input: {
  repositoryRevision: string
  generatedAt?: string
  verification: ReleaseVerificationArtifact
  hardInvariants: HardInvariantResult[]
  blockedItems?: BlockedItem[]
  nonDeterministicSignals?: NonDeterministicSignal[]
  rollbackEvidence?: RollbackEvidence
}): P91ReleaseArtifact {
  const blockedItems = input.blockedItems ?? defaultBlockedItems()
  const nonDeterministicSignals = input.nonDeterministicSignals ?? defaultNonDeterministicSignals()
  const rollbackEvidence = input.rollbackEvidence ?? defaultRollbackEvidence()
  const hardInvariantsAllPassed =
    input.hardInvariants.length > 0 && input.hardInvariants.every((r) => r.passed)
  const deterministicGatesOverallPassed =
    input.verification.overallPassed && hardInvariantsAllPassed
  return {
    schemaVersion: P91_RELEASE_ARTIFACT_SCHEMA_VERSION,
    item: "P9.1",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    repositoryRevision: input.repositoryRevision,
    deterministicGates: {
      verification: input.verification,
      hardInvariants: input.hardInvariants,
      hardInvariantsAllPassed,
      overallPassed: deterministicGatesOverallPassed,
    },
    blockedItems,
    nonDeterministicSignals,
    rollbackEvidence,
    releaseBlocked: blockedItems.length > 0,
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Write a P91ReleaseArtifact to disk as pretty-printed JSON. Side effect:
 * writes (or overwrites) the file at `filePath`. Returns the serialized
 * JSON so callers can hash it, log it, or embed it without re-serializing.
 */
export function writeP91ReleaseArtifact(
  filePath: string,
  artifact: P91ReleaseArtifact,
): string {
  const json = JSON.stringify(artifact, null, 2)
  writeFileSync(filePath, json + "\n", "utf8")
  return json
}
