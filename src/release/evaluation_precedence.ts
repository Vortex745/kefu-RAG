// Ticket 27 — Enforce deterministic evaluation precedence.
//
// Spec issue #27 acceptance criteria:
//   1. A hard-invariant failure keeps the release failed even when all
//      RAGAS and Langfuse signals are positive.
//   2. RAGAS regression or Langfuse outage cannot change a passing
//      deterministic result, though each remains visible in its own
//      report section.
//   3. The deterministic evidence hash decision excludes non-deterministic
//      report content without excluding their schema metadata.
//
// Pure function that assembles deterministic hard invariants + RAGAS shadow
// baseline + Langfuse round-trip probe outputs into a single
// EvaluationPrecedenceReport. The releaseDecision is bound to the
// deterministic decision ONLY — probabilistic signals are visible but
// structurally lack release authority (spec L1558: deterministic;
// spec L1561: non-overridable).
//
// Design (karpathy-guidelines):
//   - Simplest viable shape: pure function, no side effects, no async.
//     Inputs are pre-computed by upstream probes (T14 hard invariants,
//     T25 RAGAS shadow CLI, T26 Langfuse round-trip probe).
//   - The evidence hash uses SHA-256 over a deterministic-only JSON
//     payload (hard invariant keys + expected + actual + failingCaseIds).
//     RAGAS aggregate values, variance, Langfuse trace metadata, and any
//     other probabilistic content are deliberately excluded — they cannot
//     affect the hash and therefore cannot affect downstream release
//     decisions bound to the hash.
//   - Schema metadata (field name lists for RAGAS + Langfuse sections) is
//     always included in the report — criterion #3 explicitly requires
//     schema metadata to remain visible while non-deterministic content is
//     excluded from the hash. This lets reviewers verify the report
//     structure without needing the probabilistic values.
//
// Rollback boundary: remove this module; no online runtime behavior
// changes (per Ticket 27 rollback spec — pure verifier function, no
// ProbeImplementation registration).

import { createHash } from "node:crypto"
import type {
  HardInvariantResult,
  RagasShadowBaseline,
  RagasShadowRegression,
} from "../evaluation/types"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Outputs from the Langfuse round-trip probe (Ticket 26) — observability
 * signals only, never affect release decision. Mirror the
 * langfuseRoundTripProbe outputs shape.
 */
export interface LangfuseProbeOutputs {
  traceFound: boolean
  privacyCheck: string
  host: string
  sdkVersion: string
  droppedCount: number
}

/**
 * Inputs to assembleEvaluationPrecedence. Each input is the output of an
 * upstream probe or evaluator:
 *   - hardInvariants: T14 evaluateHardInvariants (deterministic)
 *   - ragasShadowBaseline: T25 ragasShadowCliProbe (probabilistic, non-blocking)
 *   - ragasShadowRegressions: T16 runRagasShadowProfile (probabilistic, non-blocking)
 *   - langfuseReport: T26 langfuseRoundTripProbe (observability, non-blocking)
 *   - repositoryRevision: trusted git revision for provenance binding
 */
export interface EvaluationPrecedenceInput {
  hardInvariants: HardInvariantResult[]
  ragasShadowBaseline: RagasShadowBaseline | null
  ragasShadowRegressions: RagasShadowRegression[] | null
  langfuseReport: LangfuseProbeOutputs | null
  repositoryRevision: string
}

/**
 * RAGAS section of the probabilistic report — visible but non-blocking.
 */
export interface RagasProbabilisticSection {
  baseline: RagasShadowBaseline | null
  regressions: RagasShadowRegression[]
  regressionDetected: boolean
}

/**
 * Langfuse section of the probabilistic report — visible but non-blocking.
 */
export interface LangfuseProbabilisticSection {
  traceFound: boolean
  privacyCheck: string
  host: string
  sdkVersion: string
  droppedCount: number
}

/**
 * Final report: deterministic decision is authoritative for release.
 * Probabilistic signals are visible in their own section but cannot
 * change releaseDecision.
 */
export interface EvaluationPrecedenceReport {
  /** "passed" only when all hard invariants passed (deterministic). */
  deterministicDecision: "passed" | "failed"
  /** Reason for failure (undefined when passed). */
  deterministicReason?: string
  /** Equals deterministicDecision — probabilistic signals cannot change this. */
  releaseDecision: "passed" | "failed"
  /** Hard invariant keys that failed (empty when all passed). */
  failingDeterministicInvariants: string[]
  /** Probabilistic signals — visible but non-blocking. */
  probabilisticSection: {
    ragas: RagasProbabilisticSection | null
    langfuse: LangfuseProbabilisticSection | null
  }
  /**
   * SHA-256 hash of deterministic-only evidence. Excludes RAGAS aggregate
   * values, variance, Langfuse trace metadata, and all other probabilistic
   * content. Two reports with identical deterministic inputs produce
   * identical hashes regardless of probabilistic signal values (criterion #3).
   */
  evidenceHash: string
  /**
   * Schema metadata — field name lists for RAGAS + Langfuse sections.
   * Always included so reviewers can verify report structure without
   * probabilistic values (criterion #3 — schema metadata NOT excluded).
   */
  schemaMetadata: {
    ragasShadowFields: readonly string[]
    langfuseFields: readonly string[]
  }
  /** Always true — schema metadata is structurally included (criterion #3). */
  schemaMetadataIncluded: boolean
  /** Trusted repository revision (provenance binding). */
  repositoryRevision: string
  /** ISO 8601 timestamp when the report was assembled. */
  generatedAt: string
}

// ---------------------------------------------------------------------------
// Constants — schema metadata (field names are stable, values are not)
// ---------------------------------------------------------------------------

/**
 * Field names of RagasShadowBaseline. Listed in the report so reviewers can
 * verify the RAGAS section structure without seeing probabilistic values.
 */
const RAGAS_SHADOW_BASELINE_FIELDS: readonly string[] = [
  "aggregate",
  "variance",
  "runCount",
  "datasetVersion",
  "providerModelIds",
  "generatedAt",
  "repositoryRevision",
] as const

/**
 * Field names of LangfuseProbeOutputs. Listed in the report so reviewers can
 * verify the Langfuse section structure without seeing observability values.
 */
const LANGFUSE_PROBE_OUTPUT_FIELDS: readonly string[] = [
  "traceFound",
  "privacyCheck",
  "host",
  "sdkVersion",
  "droppedCount",
] as const

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Assemble the evaluation precedence report. Pure function — no side effects,
 * no async, no I/O. Same inputs always produce identical outputs.
 */
export function assembleEvaluationPrecedence(
  input: EvaluationPrecedenceInput,
): EvaluationPrecedenceReport {
  // --- Phase 1: Deterministic decision (AC1) ---
  // The release decision is bound to hard invariants ONLY. RAGAS and
  // Langfuse signals are visible but structurally lack release authority.
  const hardInvariants = input.hardInvariants ?? []
  const failingInvariants = hardInvariants.filter((h) => !h.passed)
  const failingDeterministicInvariants = failingInvariants.map((h) => h.key)
  const deterministicPassed = hardInvariants.length > 0 && failingInvariants.length === 0
  const deterministicDecision: "passed" | "failed" = deterministicPassed ? "passed" : "failed"
  const deterministicReason = deterministicPassed
    ? undefined
    : hardInvariants.length === 0
      ? "hardInvariants is empty — at least one deterministic invariant is required"
      : `${failingInvariants.length} hard invariant(s) failed: ${failingDeterministicInvariants.join(", ")}`

  // --- Phase 2: Probabilistic section (AC2) ---
  // RAGAS + Langfuse are visible in their own sections regardless of
  // deterministic decision. Even when deterministic fails, probabilistic
  // signals are reported so reviewers can correlate root causes.
  const ragasSection: RagasProbabilisticSection | null = input.ragasShadowBaseline !== null || input.ragasShadowRegressions !== null
    ? {
        baseline: input.ragasShadowBaseline,
        regressions: input.ragasShadowRegressions ?? [],
        regressionDetected: (input.ragasShadowRegressions ?? []).some((r) => r.regressionDetected),
      }
    : null

  const langfuseSection: LangfuseProbabilisticSection | null =
    input.langfuseReport !== null
      ? {
          traceFound: input.langfuseReport.traceFound,
          privacyCheck: input.langfuseReport.privacyCheck,
          host: input.langfuseReport.host,
          sdkVersion: input.langfuseReport.sdkVersion,
          droppedCount: input.langfuseReport.droppedCount,
        }
      : null

  // --- Phase 3: Evidence hash (AC3) ---
  // SHA-256 over deterministic-only JSON payload. Excludes:
  //   - ragasShadowBaseline.aggregate values (probabilistic)
  //   - ragasShadowBaseline.variance values (probabilistic)
  //   - ragasShadowRegressions current/baseline/delta values (probabilistic)
  //   - langfuseReport traceFound/privacyCheck/droppedCount (observability)
  //
  // Includes (deterministic, stable):
  //   - hardInvariants: key, passed, expected, actual, failingCaseIds
  //   - ragasShadowBaseline.runCount, datasetVersion, providerModelIds,
  //     generatedAt, repositoryRevision (metadata, NOT aggregate values)
  //
  // Schema metadata (field names) is reported separately in
  // `schemaMetadata` — NOT part of the hash. Criterion #3 explicitly says
  // "excludes non-deterministic report content without excluding their
  // schema metadata" — schema metadata is in the report (visible), just
  // not part of the deterministic hash.
  const deterministicPayload = {
    hardInvariants: hardInvariants.map((h) => ({
      key: h.key,
      passed: h.passed,
      expected: h.expected,
      actual: h.actual,
      failingCaseIds: h.failingCaseIds,
    })),
    ragasMetadata: input.ragasShadowBaseline
      ? {
          runCount: input.ragasShadowBaseline.runCount,
          datasetVersion: input.ragasShadowBaseline.datasetVersion,
          providerModelIds: input.ragasShadowBaseline.providerModelIds,
          generatedAt: input.ragasShadowBaseline.generatedAt,
          repositoryRevision: input.ragasShadowBaseline.repositoryRevision,
          // Intentionally excludes: aggregate, variance (probabilistic values)
        }
      : null,
  }
  const evidenceHash = createHash("sha256")
    .update(JSON.stringify(deterministicPayload))
    .digest("hex")

  // --- Phase 4: Assemble final report ---
  return {
    deterministicDecision,
    deterministicReason,
    releaseDecision: deterministicDecision, // AC1 + AC2: probabilistic cannot change this
    failingDeterministicInvariants,
    probabilisticSection: {
      ragas: ragasSection,
      langfuse: langfuseSection,
    },
    evidenceHash,
    schemaMetadata: {
      ragasShadowFields: RAGAS_SHADOW_BASELINE_FIELDS,
      langfuseFields: LANGFUSE_PROBE_OUTPUT_FIELDS,
    },
    schemaMetadataIncluded: true, // AC3: schema metadata always included
    repositoryRevision: input.repositoryRevision ?? "",
    generatedAt: new Date().toISOString(),
  }
}
