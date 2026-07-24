// Ticket 15 — Project RAGAS into evaluation artifacts.
//
// Spec issue #15: Extend versioned golden cases and the existing
// machine-readable evaluation artifact so RAGAS faithfulness, answer
// relevancy, context precision and context recall are reported per case and
// in aggregate without changing deterministic release invariants.
//
// This module owns the projection from public Answer-run outputs to the
// versioned bounded RagasRequest (criteria #2, #6), the eligibility check
// (criterion #1 — only cases with a committed bounded referenceAnswer are
// evaluated), and the aggregate computation (criterion #3, #4 — 4 metric
// names recorded exactly, aggregate values across per-case outcomes).
//
// RAGAS results are structurally separate from hard invariants and quality
// metrics (criterion #5) — this module produces RagasCaseOutcome +
// RagasAggregate that flow into the artifact's separate `ragas?` section,
// never into hardInvariants/qualityMetrics.

import type {
  AnswerRunOutputs,
  CaseResult,
  GoldenCase,
  RagasAggregate,
  RagasCaseOutcome,
  RagasRequest,
  RagasResponse,
} from "./types"

/**
 * Ticket 15 (criterion #1, #2): determine whether a case is eligible for
 * RAGAS evaluation. A case is eligible when ALL of:
 *   1. GoldenCase.referenceAnswer is a non-empty string (criterion #1 — only
 *      cases with a committed bounded reference answer are evaluated)
 *   2. CaseResult.terminalStatus === "completed" (only completed runs have an
 *      approved answer to evaluate)
 *   3. CaseResult.status === "passed" (failed/skipped runs don't have a valid
 *      approved answer)
 *
 * When any condition fails, the case is skipped for RAGAS with a reason
 * explaining which condition was not met.
 */
export function isCaseRagasEligible(goldenCase: GoldenCase, result: CaseResult): boolean {
  if (!goldenCase.referenceAnswer || goldenCase.referenceAnswer.length === 0) return false
  if (result.terminalStatus !== "completed") return false
  if (result.status !== "passed") return false
  return true
}

/**
 * Ticket 15 (criterion #1, #2): determine the skip reason for a non-eligible
 * case. Returns undefined when the case IS eligible. The reason is a stable,
 * machine-readable string suitable for the artifact's `skippedReason` field.
 */
export function ragasSkipReason(goldenCase: GoldenCase, result: CaseResult): string | undefined {
  if (!goldenCase.referenceAnswer || goldenCase.referenceAnswer.length === 0) {
    return "no referenceAnswer declared"
  }
  if (result.terminalStatus !== "completed") {
    return `non-completed terminal status: ${result.terminalStatus ?? "undefined"}`
  }
  if (result.status !== "passed") {
    return `non-passed case status: ${result.status}`
  }
  return undefined
}

/**
 * Ticket 15 (criterion #2, #6): project a GoldenCase + AnswerRunOutputs into a
 * versioned bounded RagasRequest. This function structurally enforces
 * criterion #6 — it only has access to:
 *   - GoldenCase.userMessage (the synthetic question, NOT production conversations)
 *   - GoldenCase.referenceAnswer (the committed bounded reference, NOT drafts)
 *   - AnswerRunOutputs.approvedAnswer (the final approved answer, NOT rejected drafts)
 *   - AnswerRunOutputs.retrievedContexts (the context chunks, NOT raw trace payloads)
 *   - evaluatorModelIdentities (the evaluator model IDs)
 *
 * It does NOT have access to:
 *   - rejected drafts (criterion #6)
 *   - unrestricted production conversations (criterion #6)
 *   - raw trace payloads (criterion #6)
 *
 * The function signature itself is the structural guarantee — callers cannot
 * pass drafts, production conversations, or raw trace payloads because the
 * parameter types don't accept them.
 *
 * Precondition: isCaseRagasEligible(goldenCase, result) must be true. The
 * caller is responsible for eligibility checking; this function assumes the
 * case is eligible and produces the RagasRequest.
 */
export function projectCaseToRagasRequest(
  goldenCase: GoldenCase,
  runOutputs: AnswerRunOutputs,
  evaluatorModelIdentities: RagasRequest["evaluatorModelIdentities"],
): RagasRequest {
  return {
    schemaVersion: 1,
    caseId: goldenCase.id,
    question: goldenCase.userMessage,
    approvedAnswer: runOutputs.approvedAnswer,
    retrievedContexts: runOutputs.retrievedContexts,
    referenceAnswer: goldenCase.referenceAnswer,
    evaluatorModelIdentities,
  }
}

/**
 * Ticket 15 (criterion #3, #4): compute aggregate RAGAS values across a set of
 * per-case outcomes. The 4 metric names match the RAGAS convention exactly
 * (criterion #3): faithfulness, answer_relevancy, context_precision,
 * context_recall.
 *
 * Outcomes with status="error" or "skipped" are excluded from the mean but
 * counted in errorCount/skippedCount. Outcomes with status="ok" but missing
 * a specific metric contribute to sampleSize but not to that metric's mean
 * (the metric is treated as absent for that case).
 *
 * When sampleSize=0 (no "ok" outcomes), all means are 0 — the aggregate is
 * vacuously empty, not an error.
 */
export function computeRagasAggregate(outcomes: RagasCaseOutcome[]): RagasAggregate {
  const okOutcomes = outcomes.filter((o) => o.status === "ok" && o.metrics !== undefined)
  const errorCount = outcomes.filter((o) => o.status === "error").length
  const skippedCount = outcomes.filter((o) => o.status === "skipped").length

  const findMetricScore = (outcome: RagasCaseOutcome, name: string): number | undefined => {
    const m = outcome.metrics?.find((metric) => metric.name === name)
    return m?.score
  }

  const mean = (name: string): number => {
    const scores = okOutcomes
      .map((o) => findMetricScore(o, name))
      .filter((s): s is number => s !== undefined)
    if (scores.length === 0) return 0
    return scores.reduce((a, b) => a + b, 0) / scores.length
  }

  return {
    meanFaithfulness: mean("faithfulness"),
    meanAnswerRelevancy: mean("answer_relevancy"),
    meanContextPrecision: mean("context_precision"),
    meanContextRecall: mean("context_recall"),
    sampleSize: okOutcomes.length,
    errorCount,
    skippedCount,
  }
}

/**
 * Ticket 15 (criterion #4): convert a RagasResponse (from the T14 evaluator)
 * into a RagasCaseOutcome (for the artifact). This is a pure projection —
 * no side effects. The outcome's status mirrors the response's status:
 *   - response.status="ok" → outcome.status="ok" with metrics + durationMs
 *   - response.status="error" → outcome.status="error" with error + durationMs
 */
export function ragasResponseToOutcome(response: RagasResponse): RagasCaseOutcome {
  if (response.status === "ok") {
    return {
      caseId: response.caseId,
      status: "ok",
      metrics: response.metrics,
      durationMs: response.durationMs,
    }
  }
  return {
    caseId: response.caseId,
    status: "error",
    durationMs: response.durationMs,
    error: response.error,
  }
}

/**
 * Ticket 15 (criterion #4): create a skipped RagasCaseOutcome with a reason.
 * Used when a case is not RAGAS-eligible (no referenceAnswer, non-completed
 * terminal status, or non-passed case status).
 */
export function skippedRagasOutcome(caseId: string, reason: string): RagasCaseOutcome {
  return {
    caseId,
    status: "skipped",
    skippedReason: reason,
  }
}
