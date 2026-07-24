// Ticket 10 Phase D P1 — Evaluation types + golden set schema foundation.
//
// Spec references (tickets.md):
//   §9 L1554-1562 — Offline evaluation and release thresholds
//   §10 L1564-1569 — Real dependency release gate
//
// These types are consumed by:
//   - golden/schema.ts (P1) — structural validation of golden set fixtures
//   - hard_invariants.ts (P3) — deterministic release invariants
//   - quality_metrics.ts (P4) — threshold-based quality metrics
//   - artifact.ts (P5) — machine-readable artifact writer
//   - smoke.ts (P6) — real dependency smoke gate
//
// Evaluation runner consumes public Answer run events (AnswerRunEvent) and
// IngestionLifecycle behavior only — it must not call private Planner,
// Searcher or repository methods (spec L1488).

import type { AnswerTerminalStatus } from "../types/answer"
import type { RouterDecision } from "../types/agent"

// ---------------------------------------------------------------------------
// Spec §9 L1556-1557: Golden set
// ---------------------------------------------------------------------------

/**
 * Spec L1556: golden set contains at least 60 versioned cases across 6
 * categories. `REQUIRED_CATEGORY_COUNTS` encodes the minimum counts.
 */
export type GoldenCaseCategory =
  | "direct" // ≥10
  | "simple" // ≥15
  | "complex" // ≥10
  | "ambiguous" // ≥10 (ambiguous/clarification)
  | "insufficient" // ≥10 (insufficient/degraded)
  | "correction" // ≥5

/** Spec L1556: required minimum counts per category (10+15+10+10+10+5 = 60). */
export const REQUIRED_CATEGORY_COUNTS: Record<GoldenCaseCategory, number> = {
  direct: 10,
  simple: 15,
  complex: 10,
  ambiguous: 10,
  insufficient: 10,
  correction: 5,
}

/**
 * Ticket 10 (tool-loop evaluation gates): scenario tags for golden cases that
 * exercise specific tool-loop behaviors. When present, the evaluation framework
 * applies tool-loop-specific invariants and metrics (criterion #1, #2, #5).
 */
export type ToolLoopScenario =
  | "single-tool" // simple route: LLM picks one read-only tool
  | "multi-tool" // complex route: LLM alternates ≥2 different tools
  | "duplicate-call" // complex route: duplicate tool call pressure (criterion #6)
  | "budget-exhaustion" // complex route: iteration or tool-call budget exhausted
  | "cancellation" // user cancellation during tool-loop decision or retrieval
  | "deterministic-fallback" // correction round: 0 loop results → searcher fallback

/**
 * Ticket 10 (criterion #3): the approved read-only retrieval tool set. Any tool
 * registered or executed outside this set is an authorization violation
 * (hard invariant `unauthorized_tool_rejection`).
 */
export const APPROVED_READ_ONLY_TOOLS: readonly string[] = [
  "semantic_lexical_hybrid",
  "graph_navigation",
  "pageindex_hierarchy",
]

/**
 * Spec L1557: each knowledge case declares expected Source identities or
 * acceptable Evidence IDs, required coverage criteria, and whether handoff
 * is acceptable. It does not embed secrets or unrestricted production
 * conversations.
 */
export interface GoldenCase {
  /** Versioned case identifier, e.g. "direct-01". Stable across versions. */
  id: string
  /** Case schema version — bumped when expected fields change shape. */
  version: number
  category: GoldenCaseCategory
  /** The user message fed into the Answer run. Bounded, synthetic, no secrets. */
  userMessage: string
  /** Expected Router decision. Direct/ambiguous always set; insufficient may omit. */
  expectedRoute?: RouterDecision
  /**
   * Spec L1557: expected Source identities. May be empty for `direct`
   * (no retrieval) and `ambiguous` (no retrieval until resumed).
   */
  expectedSourceIds: string[]
  /**
   * Spec L1557: acceptable Evidence IDs (alternative to expectedSourceIds).
   * Knowledge routes (simple/complex/insufficient/correction) must declare at
   * least one of expectedSourceIds / acceptableEvidenceIds non-empty.
   */
  acceptableEvidenceIds: string[]
  /** Spec L1557: required coverage criteria the answer must address. */
  requiredCoverageCriteria?: string[]
  /** Spec L1557: whether handoff is acceptable as a terminal status. */
  handoffAcceptable?: boolean
  /** Case rationale / scenario description. Not secrets, not production conversations. */
  notes?: string
  /**
   * Ticket 10 (criterion #1): tags this case as exercising a specific tool-loop
   * behavior. When present, the case is included in tool-loop-specific invariants
   * and quality metrics. When absent, the case is a general (non-tool-loop) case.
   */
  scenario?: ToolLoopScenario
  /**
   * Ticket 10 (criterion #2): expected maximum LLM decision iterations for this
   * case. The hard invariant `tool_loop_budget_termination` verifies the observed
   * `CaseResult.iterationsExecuted` does not exceed this value. When absent, the
   * default ceiling `COMPLEX_LOOP_MAX_ITERATIONS` (3) is used.
   */
  expectedMaxIterations?: number
  /**
   * Ticket 10 (criterion #2): expected maximum retrieval tool calls for this
   * case. The hard invariant `tool_loop_budget_termination` verifies the observed
   * `CaseResult.toolCallCount` does not exceed this value. When absent, the
   * default ceiling `COMPLEX_LOOP_MAX_TOOL_CALLS` (4) is used.
   */
  expectedMaxToolCalls?: number
  /**
   * Ticket 10 (criterion #5): when true, the case expects a deterministic
   * searcher fallback to occur (0 loop results → searcher.search). The quality
   * metric `tool_loop_fallback_rate` uses this to compute the expected-vs-actual
   * fallback rate.
   */
  expectedFallback?: boolean
  /**
   * Ticket 10 (criterion #6): when true, this case uses compressed Context
   * (semantic Evidence-Context compression). Compressed and uncompressed cases
   * must use the same expected Evidence and completion requirements.
   */
  compressed?: boolean
  /**
   * Ticket 15 (criterion #1): bounded reference answer for the subset of
   * golden cases evaluated by RAGAS. When present AND the CaseResult reaches
   * `completed` terminal status, the case is RAGAS-eligible. When absent, the
   * case is skipped for RAGAS evaluation.
   *
   * The reference answer is a committed, bounded, synthetic answer — not a
   * production conversation, not a rejected draft. It grounds the
   * context_recall metric.
   */
  referenceAnswer?: string
}

/** Spec L1556: versioned golden set with at least 60 cases. */
export interface GoldenSet {
  /** Dataset version, e.g. "2026.07". */
  version: string
  cases: GoldenCase[]
}

// ---------------------------------------------------------------------------
// Spec §9 L1558: Hard release invariants (deterministic, non-overridable)
// ---------------------------------------------------------------------------

export type HardInvariantKey =
  | "terminal_convergence_100"
  | "unknown_citation_count_zero"
  | "knowledge_completed_zero_refs_zero"
  | "unauthorized_evidence_zero"
  | "direct_route_completion_without_retrieval_95"
  | "cancellation_late_answer_zero"
  | "tool_loop_budget_termination"
  | "unauthorized_tool_rejection"

export interface HardInvariantResult {
  key: HardInvariantKey
  passed: boolean
  /** Human-readable expected value, e.g. "100% of runs reach a terminal status". */
  expected: string
  /** Human-readable actual value, e.g. "59/60 (98.3%)". */
  actual: string
  /** Case IDs that contributed to the failure (empty when passed). */
  failingCaseIds: string[]
}

// ---------------------------------------------------------------------------
// Spec §9 L1559: Quality thresholds
// ---------------------------------------------------------------------------

export type QualityMetricKey =
  | "retrieval_hit_at_10"
  | "expected_source_recall"
  | "required_criteria_coverage"
  | "citation_supported_claim_rate"
  | "correction_success"
  | "tool_loop_fallback_rate"

/** Spec L1559: minimum thresholds (fractions in [0,1]). */
export const QUALITY_THRESHOLDS: Record<QualityMetricKey, number> = {
  retrieval_hit_at_10: 0.85,
  expected_source_recall: 0.8,
  required_criteria_coverage: 0.8,
  citation_supported_claim_rate: 0.9,
  correction_success: 0.7,
  tool_loop_fallback_rate: 0.8,
}

export interface QualityMetricResult {
  key: QualityMetricKey
  threshold: number
  actual: number
  passed: boolean
  /** Number of cases the metric was computed over. */
  sampleSize: number
}

// ---------------------------------------------------------------------------
// Spec §9 L1561: Model-judge scores (reported separately, cannot override)
// ---------------------------------------------------------------------------

export interface ModelJudgeScore {
  caseId: string
  /** L1561: fixed evaluator model/configuration recorded in the artifact. */
  evaluatorModel: string
  /** Score in [0,1]. */
  score: number
  rationale?: string
}

// ---------------------------------------------------------------------------
// Spec §9 L1560: Baseline comparison (latency + token cost)
// ---------------------------------------------------------------------------

export interface BaselineComparison {
  p95LatencyMs: number
  p95LatencyBaselineMs: number
  /** True when p95 latency regresses by more than 20% over the baseline. */
  p95LatencyRegression: boolean
  averageTokens: number
  averageTokensBaseline: number
  /** True when average total tokens regress by more than 20% over the baseline. */
  averageTokensRegression: boolean
}

// ---------------------------------------------------------------------------
// Spec §9 L1562: Per-case status + machine-readable artifact
// ---------------------------------------------------------------------------

export type CaseResultStatus = "passed" | "failed" | "skipped"

export interface CaseResult {
  caseId: string
  status: CaseResultStatus
  terminalStatus?: AnswerTerminalStatus
  routeDecision?: RouterDecision
  retrievedEvidenceIds: string[]
  /** Citation IDs found in the approved answer text. */
  citationsInAnswer: string[]
  durationMs: number
  tokenCount: number
  failureReason?: string
  /** Spec L1562: redacted failure evidence — no prompts, no private content. */
  redactedFailureEvidence?: string
  /**
   * Ticket 10 (criterion #2): number of retrieval tool calls actually executed
   * (excludes duplicates). Derived from the public AnswerRunEvent retrieval
   * events with `complexLoop === true` and `duplicate === false`. Present only
   * for cases that entered the tool loop.
   */
  toolCallCount?: number
  /**
   * Ticket 10 (criterion #2): number of LLM decision iterations actually
   * executed. Derived from the route event's `complexLoopIterations`. Present
   * only for cases that entered the tool loop.
   */
  iterationsExecuted?: number
  /**
   * Ticket 10 (criterion #5): true when a deterministic `searcher.search`
   * fallback occurred (correction round with 0 loop results → fallback). Derived
   * from retrieval events with `fallback === true`.
   */
  fallbackUsed?: boolean
  /**
   * Ticket 10 (criterion #3): retrieval tools selected by the LLM during this
   * run (deduplicated). Derived from retrieval events' `selectedTool`. The hard
   * invariant `unauthorized_tool_rejection` verifies every entry is in
   * `APPROVED_READ_ONLY_TOOLS`.
   */
  selectedTools?: string[]
  /**
   * Ticket 10 (criterion #5): why the tool loop terminated. Derived from the
   * route event's `complexLoopStopReason`. Present only for cases that entered
   * the tool loop.
   */
  complexLoopStopReason?: string
}

/** Spec L1562: machine-readable artifact. */
export interface EvaluationArtifact {
  schemaVersion: 1
  /** Git revision (commit SHA) the evaluation ran against. */
  repositoryRevision: string
  /** Golden set version (GoldenSet.version). */
  datasetVersion: string
  providerModelIds: {
    chat: string
    embedding: string
    /** L1561: fixed evaluator model/configuration. */
    evaluator?: string
  }
  /** ISO 8601 timestamp. */
  generatedAt: string
  aggregateMetrics: {
    hardInvariants: HardInvariantResult[]
    qualityMetrics: QualityMetricResult[]
    baseline: BaselineComparison
    /** L1561: reported separately; deterministic failures cannot be overridden. */
    modelJudgeScores?: ModelJudgeScore[]
  }
  perCaseStatus: CaseResult[]
  /**
   * Ticket 15: optional RAGAS section. Structurally separate from
   * hardInvariants/qualityMetrics (criterion #5) — RAGAS results cannot change
   * the passed/failed state of deterministic gates. When absent, the evaluation
   * ran without RAGAS (e.g. Python runtime not configured, no cases with
   * referenceAnswer).
   */
  ragas?: RagasArtifactSection
  /**
   * Ticket 16: optional RAGAS shadow baseline section. Structurally separate
   * from `aggregateMetrics.baseline` (latency/token) and `ragas` (per-case
   * outcomes from T15). Reports the shadow baseline + optional comparison vs a
   * checked-in baseline. NON-BLOCKING (criterion #6) — shadow regressions
   * cannot change `hardInvariants[].passed` or `qualityMetrics[].passed`
   * (criterion #4).
   */
  ragasShadow?: RagasShadowArtifactSection
}

// ---------------------------------------------------------------------------
// Spec §10 L1564-1569: Real dependency smoke gate
// ---------------------------------------------------------------------------

export type SmokeCapabilityKey =
  | "markitdown"
  | "marker"
  | "mineru"
  | "elasticsearch_vector"
  | "elasticsearch_bm25"
  | "neo4j"
  | "pageindex"
  | "embedding"
  | "chat"
  | "cancellation"
  | "graceful_shutdown"
  | "langfuse"

/**
 * Spec L1567: missing capabilities are allowed for local development but are
 * not accepted as a production release pass. The artifact records skipped
 * capability checks as failures for the production profile.
 */
export type EvaluationProfile = "local" | "production"

export type SmokeResultStatus = "passed" | "skipped" | "failed"

export interface SmokeResult {
  capability: SmokeCapabilityKey
  profile: EvaluationProfile
  status: SmokeResultStatus
  /** Reason for skip or failure (undefined when passed). */
  reason?: string
  durationMs: number
}

/**
 * Spec L1568: smoke fixtures are bounded, synthetic and committed without
 * private data. They verify observable outputs and identities. The probe is
 * the caller-supplied function that invokes the real capability with a
 * committed fixture and verifies the observable output.
 */
export interface SmokeProbeResult {
  ok: boolean
  /** Failure reason (used when ok=false). */
  reason?: string
  /** Observable outputs/identities (L1568). */
  outputs?: string[]
}

/**
 * Caller-supplied async probe. The smoke runner does NOT own fixtures or
 * provider calls — it just invokes the probe and records the result.
 */
export type SmokeProbe = () => Promise<SmokeProbeResult>

/**
 * Bundle of optional probes per capability. Undefined probe = capability not
 * configured (skipped on local, failed on production per L1567).
 */
export interface SmokeProbeBundle {
  markitdown?: SmokeProbe
  marker?: SmokeProbe
  mineru?: SmokeProbe
  elasticsearch_vector?: SmokeProbe
  elasticsearch_bm25?: SmokeProbe
  neo4j?: SmokeProbe
  pageindex?: SmokeProbe
  embedding?: SmokeProbe
  chat?: SmokeProbe
  cancellation?: SmokeProbe
  graceful_shutdown?: SmokeProbe
  langfuse?: SmokeProbe
}

// ---------------------------------------------------------------------------
// Ticket 14 — RAGAS offline process evaluator
//
// Spec issue #14: Execute one bounded RAGAS evaluation from the TypeScript
// offline evaluation path through a versioned Python process contract. The
// online Answer path remains independent of Python (criterion #6), and the
// existing deterministic evaluation remains runnable when the optional RAGAS
// runtime is absent (criterion #5 — missing runtime produces skipped/failed).
//
// The RAGAS evaluator is per-case (not a smoke capability). It projects into
// ModelJudgeScore / RagasMetricResult on the artifact — that projection is
// Ticket 15. Ticket 14 only owns the subprocess wrapper + types + tests.
// ---------------------------------------------------------------------------

/**
 * Ticket 14 (criterion #2): versioned bounded JSON request sent to the Python
 * RAGAS evaluator over stdin. All fields are bounded — no unbounded text, no
 * secrets, no raw prompts. The wrapper serializes this as a single JSON line.
 */
export interface RagasRequest {
  /** Schema version — bumped when the request shape changes. */
  schemaVersion: 1
  /** Case ID for correlation with CaseResult. */
  caseId: string
  /** The user question fed into the Answer run. Bounded, synthetic, no secrets. */
  question: string
  /** The approved Answer text. Bounded — no raw prompts, no private content. */
  approvedAnswer: string
  /** Retrieved Context chunks passed to the Answer model. Bounded array. */
  retrievedContexts: string[]
  /** Optional reference answer for grounding metrics (context_recall). */
  referenceAnswer?: string
  /** Evaluator model identities (spec L1561 — fixed evaluator configuration). */
  evaluatorModelIdentities: {
    chat: string
    embedding: string
    /** Optional RAGAS evaluator LLM override (defaults to chat model). */
    evaluator?: string
  }
}

/**
 * Ticket 14 (criterion #3): versioned JSON result returned by the Python
 * RAGAS evaluator over stdout. Includes metric values, duration, and safe
 * error information. The wrapper parses this from the final stdout line.
 */
export interface RagasResponse {
  /** Schema version — must match RagasRequest.schemaVersion. */
  schemaVersion: 1
  /** Case ID for correlation. */
  caseId: string
  /** "ok" when metrics are present; "error" when the evaluator failed. */
  status: "ok" | "error"
  /** Metric values when status="ok". Undefined when status="error". */
  metrics?: RagasMetricResult[]
  /** Wall-clock duration in milliseconds. Always present. */
  durationMs: number
  /**
   * Safe error information when status="error". The kind is machine-readable;
   * the message is human-readable but contains no secrets, no raw prompts.
   */
  error?: {
    kind: "missing_runtime" | "timeout" | "malformed_output" | "evaluator_failure" | "unknown"
    message: string
  }
}

/**
 * Ticket 14 (criterion #3): one RAGAS metric value. Names follow the RAGAS
 * convention: faithfulness, answer_relevancy, context_precision, context_recall.
 * Scores are in [0,1].
 */
export interface RagasMetricResult {
  name: string
  score: number
  /** Optional safe rationale — no secrets, no raw prompts. */
  rationale?: string
}

/**
 * Ticket 14 (criterion #6): the RagasEvaluator runs as a bounded subprocess
 * and does NOT touch the online chat runtime. The online Answer path remains
 * independent of Python — this interface lives in `src/evaluation/` and is
 * only invoked from the offline evaluation runner.
 */
export interface RagasEvaluator {
  /**
   * Evaluate one case through the bounded Python subprocess. Returns a
   * versioned response with metrics, duration, and safe error info.
   * Never throws — all errors are captured in RagasResponse.status="error".
   */
  evaluate(request: RagasRequest, options?: RagasEvaluateOptions): Promise<RagasResponse>
}

/**
 * Bounded execution options for the RAGAS subprocess. Defaults enforce
 * criterion #4 — bounded input, output, timeout, and stderr handling.
 */
export interface RagasEvaluateOptions {
  /** Bounded timeout in milliseconds (default 30000). */
  timeoutMs?: number
  /** Bounded max stdout bytes (default 1_000_000 = ~1MB). */
  maxOutputBytes?: number
  /** Bounded max stderr bytes (default 100_000 = ~100KB). */
  maxStderrBytes?: number
  /** Abort signal for cancellation. */
  signal?: AbortSignal
}

/**
 * Ticket 14 (criterion #1): pinned Python runtime configuration. The evaluator
 * environment must pin compatible Python, RAGAS, and supporting dependency
 * versions (see `ragas_requirements.txt`). Production wiring injects a real
 * Python executable + the committed `ragas_runner.py` script.
 */
export interface RagasRuntimeConfig {
  /** Path to the Python executable (e.g. "python3" or a venv path). */
  pythonExecutable: string
  /** Path to the RAGAS runner script (e.g. "src/evaluation/ragas_runner.py"). */
  runnerScript: string
  /** Optional env vars (e.g. OPENAI_API_KEY for the RAGAS evaluator LLM). */
  env?: Record<string, string>
}

// ---------------------------------------------------------------------------
// Ticket 15 — Project RAGAS into evaluation artifacts
//
// Spec issue #15: Extend versioned golden cases and the existing
// machine-readable evaluation artifact so RAGAS faithfulness, answer
// relevancy, context precision and context recall are reported per case and
// in aggregate without changing deterministic release invariants.
//
// RAGAS results are structurally separate from hard invariants and quality
// metrics (criterion #5) — they live in a separate `ragas?` section on the
// artifact and cannot change the passed/failed state of deterministic gates.
// ---------------------------------------------------------------------------

/**
 * Ticket 15 (criterion #2): public Answer-run outputs consumed by the RAGAS
 * projection. This interface carries ONLY the fields RAGAS needs — it
 * structurally excludes rejected drafts, unrestricted production conversations
 * and raw trace payloads (criterion #6).
 *
 * The approvedAnswer is the FINAL approved answer text (not a draft). The
 * retrievedContexts are the actual context chunks passed to the Answer model
 * (not raw trace payloads, not Evidence IDs alone).
 */
export interface AnswerRunOutputs {
  /** Case ID for correlation with GoldenCase + CaseResult. */
  caseId: string
  /** The approved Answer text (final, non-draft). Bounded — no raw prompts. */
  approvedAnswer: string
  /** Retrieved Context chunks passed to the Answer model. Bounded array. */
  retrievedContexts: string[]
}

/**
 * Ticket 15 (criterion #4): per-case RAGAS outcome recorded in the artifact.
 * Status "ok" carries metrics; "error" carries error info; "skipped" carries
 * a reason. The outcome is structurally separate from CaseResult — it does
 * NOT change CaseResult.status (criterion #5).
 */
export interface RagasCaseOutcome {
  caseId: string
  status: "ok" | "error" | "skipped"
  /** Metric values when status="ok". Undefined when status="error" or "skipped". */
  metrics?: RagasMetricResult[]
  /** Wall-clock duration in milliseconds. Present when status="ok" or "error". */
  durationMs?: number
  /** Safe error info when status="error". */
  error?: { kind: string; message: string }
  /** Skipped reason when status="skipped" (e.g. "no referenceAnswer", "non-completed terminal status"). */
  skippedReason?: string
}

/**
 * Ticket 15 (criterion #3, #4): aggregate RAGAS values across all "ok"
 * outcomes. Each metric is the mean score across the sample. The 4 metric
 * names match the RAGAS convention exactly (criterion #3): faithfulness,
 * answer_relevancy, context_precision, context_recall.
 */
export interface RagasAggregate {
  /** Mean faithfulness score across "ok" outcomes, in [0,1]. */
  meanFaithfulness: number
  /** Mean answer_relevancy score, in [0,1]. */
  meanAnswerRelevancy: number
  /** Mean context_precision score, in [0,1]. */
  meanContextPrecision: number
  /** Mean context_recall score, in [0,1]. */
  meanContextRecall: number
  /** Number of "ok" outcomes the aggregate was computed over. */
  sampleSize: number
  /** Number of "error" outcomes. */
  errorCount: number
  /** Number of "skipped" outcomes. */
  skippedCount: number
}

/**
 * Ticket 15 (criterion #4): RAGAS runtime version info. Records the pinned
 * RAGAS version, Python version and runner schema version so artifact
 * consumers can reproduce the evaluation.
 */
export interface RagasRuntimeInfo {
  /** RAGAS package version (from ragas_requirements.txt), e.g. "0.2.14". */
  ragasVersion: string
  /** Python runtime version, e.g. "3.11.6". */
  pythonVersion: string
  /** Runner script schema version (from ragas_runner.py SCHEMA_VERSION). */
  runnerSchemaVersion: number
}

/**
 * Ticket 15 (criterion #4, #5): the RAGAS section of the evaluation artifact.
 * Structurally separate from hardInvariants/qualityMetrics (criterion #5) —
 * RAGAS results cannot change the passed/failed state of deterministic gates.
 *
 * The section records:
 *   - runtime version info (criterion #4 — runtime version)
 *   - evaluator model identities (criterion #4 — evaluator model IDs)
 *   - embedding model ID (criterion #4 — embedding model ID, via
 *     evaluatorModelIdentities.embedding)
 *   - aggregate values (criterion #4 — aggregate values)
 *   - per-case outcomes with skipped/failed reasons (criterion #4)
 */
export interface RagasArtifactSection {
  /** Runtime version info (criterion #4 — runtime version). */
  runtime: RagasRuntimeInfo
  /**
   * Evaluator model identities (criterion #4 — evaluator model IDs +
   * embedding model ID). The embedding field satisfies the "embedding model
   * ID" requirement.
   */
  evaluatorModelIdentities: {
    chat: string
    embedding: string
    evaluator?: string
  }
  /** Aggregate values across all per-case outcomes (criterion #4). */
  aggregate: RagasAggregate
  /** Per-case RAGAS outcomes with skipped/failed reasons (criterion #4). */
  perCase: RagasCaseOutcome[]
}

// ---------------------------------------------------------------------------
// Ticket 16 — Calibrate the RAGAS shadow baseline
//
// Spec issue #16: Establish a reproducible, non-blocking RAGAS baseline by
// running the committed evaluation set repeatedly with fixed evaluator
// configuration. Report score variance and regressions in shadow mode
// WITHOUT allowing first-run model metrics to block a release.
//
// Shadow-mode RAGAS results are structurally separate from:
//   - deterministic hard invariants (criterion #4 — cannot override/waive)
//   - latency/token baseline (criterion #3 — reported separately)
//   - per-case RAGAS outcomes from T15 (different concern: baseline vs live)
// ---------------------------------------------------------------------------

/**
 * T16 criterion #2: per-metric variance across N shadow runs. Each metric
 * (faithfulness, answer_relevancy, context_precision, context_recall) records
 * min/max/mean/stdDev across the N repeated runs. sampleSize equals the
 * baseline's runCount (criterion #2 — "run count").
 */
export interface RagasMetricVariance {
  /** Minimum observed value across N runs, in [0,1]. */
  min: number
  /** Maximum observed value across N runs, in [0,1]. */
  max: number
  /** Mean of observed values across N runs. */
  mean: number
  /** Sample standard deviation across N runs (0 when N=1). */
  stdDev: number
  /** Number of runs contributing to this variance (equals baseline runCount). */
  sampleSize: number
}

/**
 * T16 criterion #2: per-metric variance for all 4 RAGAS metrics. The 4 metric
 * names match the RAGAS convention exactly (mirrors RagasAggregate).
 */
export interface RagasShadowVariance {
  faithfulness: RagasMetricVariance
  answerRelevancy: RagasMetricVariance
  contextPrecision: RagasMetricVariance
  contextRecall: RagasMetricVariance
}

/**
 * T16 criterion #2: the checked-in (or freshly recorded) shadow baseline.
 * Records aggregate metric values, per-metric variance, run count, dataset
 * version and provider model identities — everything needed to reproduce the
 * baseline and compare future runs against it.
 */
export interface RagasShadowBaseline {
  /** Aggregate metric values across all runs + cases (mean of per-run aggregates). */
  aggregate: RagasAggregate
  /** Per-metric variance across N runs (criterion #2 — "per-metric variance"). */
  variance: RagasShadowVariance
  /** Number of repeated runs used to compute the baseline (criterion #2 — "run count"). */
  runCount: number
  /** Dataset version (GoldenSet.version) the baseline was recorded against (criterion #2). */
  datasetVersion: string
  /** Provider model identities used for all runs — fixed across runs (criterion #1, #2). */
  providerModelIds: { chat: string; embedding: string; evaluator?: string }
  /** ISO 8601 timestamp when the baseline was recorded. */
  generatedAt: string
  /** Git revision the baseline was recorded against. */
  repositoryRevision: string
}

/**
 * T16 criterion #3: per-metric regression between current run and baseline.
 * A metric "regresses" when current < baseline (lower score = worse). The
 * regression is REPORTED but NON-BLOCKING (criterion #6 — no blocking
 * threshold is introduced until a follow-up decision accepts variance + cost).
 */
export interface RagasShadowRegression {
  /** Metric name (matches RagasAggregate field names). */
  metric: "faithfulness" | "answerRelevancy" | "contextPrecision" | "contextRecall"
  /** Current run's value for this metric. */
  current: number
  /** Baseline value for this metric. */
  baseline: number
  /** Absolute delta (current - baseline). Negative = regression, positive = improvement. */
  delta: number
  /**
   * True when current < baseline (regression). Reported but NON-BLOCKING
   * (criterion #6). The release gate does NOT consult this flag.
   */
  regressionDetected: boolean
}

/**
 * T16 criterion #3: comparison between current run and checked-in baseline.
 * Reported SEPARATELY from latency/token regressions (aggregateMetrics.baseline)
 * and deterministic quality metrics (aggregateMetrics.qualityMetrics).
 */
export interface RagasShadowComparison {
  /** Current run's aggregate values. */
  current: RagasAggregate
  /** The checked-in baseline. */
  baseline: RagasShadowBaseline
  /** Per-metric regressions (reported, NON-BLOCKING per criterion #6). */
  regressions: RagasShadowRegression[]
  /**
   * True when ANY regression detected. Reported but NON-BLOCKING.
   * The release gate does NOT consult this flag (criterion #4, #6).
   */
  regressionDetected: boolean
}

/**
 * T16 criterion #3: the shadow section of the evaluation artifact.
 * Structurally separate from:
 *   - aggregateMetrics.baseline (latency/token regression from existing buildArtifact)
 *   - aggregateMetrics.qualityMetrics (deterministic quality metrics)
 *   - ragas (per-case RAGAS outcomes from T15)
 *
 * RAGAS shadow results cannot change the passed/failed state of deterministic
 * gates (criterion #4) — they live in a separate top-level field.
 */
export interface RagasShadowArtifactSection {
  /** The baseline recorded from this shadow run (criterion #2). */
  baseline: RagasShadowBaseline
  /** Optional comparison vs a checked-in baseline (criterion #3). */
  comparison?: RagasShadowComparison
  /**
   * Structural flag: RAGAS shadow results are reported SEPARATELY from
   * latency/token regressions and deterministic quality metrics (criterion #3).
   * Always true — present so artifact consumers can assert separation.
   */
  reportedSeparately: true
}

/**
 * T16 criterion #1: a case prepared for shadow evaluation. The caller prepares
 * these by filtering the committed golden set for cases with a non-empty
 * referenceAnswer AND a committed AnswerRunOutputs (approved answer +
 * retrieved contexts). The shadow runner consumes this list and runs RAGAS
 * N times across all prepared cases.
 */
export interface RagasShadowCase {
  /** The committed golden case (must have non-empty referenceAnswer). */
  goldenCase: GoldenCase
  /** The committed Answer-run outputs (approved answer + retrieved contexts). */
  runOutputs: AnswerRunOutputs
}

/**
 * T16 criterion #1, #5: shadow profile configuration. Encodes "fixed evaluator
 * and embedding configuration" (criterion #1) + profile semantics (criterion #5).
 */
export interface RagasShadowProfileConfig {
  /** Evaluation profile — local skips when evaluator missing, production fails (criterion #5). */
  profile: EvaluationProfile
  /** Number of repeated runs across the committed shadow cases (criterion #1 — "multiple times"). */
  runCount: number
  /** Fixed evaluator + embedding model identities (criterion #1 — "fixed evaluator and embedding configuration"). */
  evaluatorModelIdentities: { chat: string; embedding: string; evaluator?: string }
  /** Fixed runtime version info (criterion #1). */
  runtime: RagasRuntimeInfo
  /** The committed shadow cases (golden case + AnswerRunOutputs pairs). */
  shadowCases: RagasShadowCase[]
  /** Dataset version (GoldenSet.version) — recorded in the baseline. */
  datasetVersion: string
  /** The RAGAS evaluator (undefined = runtime not configured → skip/fail per profile). */
  evaluator?: RagasEvaluator
  /** Optional checked-in baseline for comparison (criterion #3). */
  checkedInBaseline?: RagasShadowBaseline
  /** Git revision (for baseline recording). */
  repositoryRevision: string
}

/**
 * T16 criterion #5: shadow run result with profile semantics.
 * status="skipped" → local profile + no evaluator (criterion #5).
 * status="failed" → production profile + no evaluator, OR run errors.
 * status="passed" → ran successfully, baseline (and optional comparison) present.
 */
export interface RagasShadowResult {
  /** Profile-dependent status (criterion #5). */
  status: "passed" | "skipped" | "failed"
  /** Reason for skip/fail (undefined when passed). */
  reason?: string
  /** The new baseline recorded from this run (present when status="passed"). */
  baseline?: RagasShadowBaseline
  /** Comparison vs checked-in baseline (present when status="passed" AND checkedInBaseline was provided). */
  comparison?: RagasShadowComparison
}
