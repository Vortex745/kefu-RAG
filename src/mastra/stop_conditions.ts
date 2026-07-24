/**
 * Ticket 14 — Limited rollout stop conditions + rollback action.
 *
 * Implements the stop-condition contract locked by Ticket 07 §6.1 + T14
 * criterion #5:
 *
 *   "Limited rollout stop conditions and rollback actions are exercised
 *    before default cutover"
 *
 * ## What this module does
 *
 *   - Pure function `evaluateStopConditions(input)` — evaluates the 5 stop
 *     conditions (immediate rollback triggers) defined in T07 §6.1 against
 *     the current release evidence.
 *   - Pure function `buildRollbackAction(triggered)` — builds the rollback
 *     action record (git revert + redeploy the accepted release).
 *   - Pure function `shouldRollback(input)` — convenience wrapper that
 *     returns `true` when any stop condition is triggered.
 *
 * ## What this module does NOT do
 *
 *   - Does NOT execute the rollback; the module only computes the decision
 *     and deployment action record.
 *   - Does NOT persist the decision (callers decide logging / persistence)
 *   - Does NOT block on failure thresholds (T07 §6.2 — failure thresholds
 *     are promotion blockers, NOT immediate rollback triggers; this module
 *     only handles stop conditions per T07 §6.1)
 *
 * Boundary (T02 #5): this module MUST NOT import from `src/api/*` or
 * `src/index`. It imports only types from `src/evaluation/types` and
 * `./runtime_mode`.
 */

import type {
  HardInvariantResult,
  SmokeResult,
} from "../evaluation/types"

// ---------------------------------------------------------------------------
// Stop conditions (T07 §6.1 — 5 immediate rollback triggers)
// ---------------------------------------------------------------------------

/**
 * The 5 stop conditions locked by T07 §6.1. Each is an immediate rollback
 * trigger — when ANY is true, the operator must revert and redeploy the
 * accepted pre-contraction release.
 *
 * Stop conditions are distinct from failure thresholds (T07 §6.2 — promotion
 * blockers). Stop conditions trigger DURING a limited/default rollout;
 * failure thresholds block PROMOTION to the next stage.
 *
 * The 5 stop conditions:
 *   1. `hard_invariant_regression` — any deterministic hard invariant failed
 *      (T06 §6 — DETERMINISTIC + NON-OVERRIDABLE)
 *   2. `smoke_gate_failure` — any smoke check failed in the production profile
 *      (T13 §10 — required capabilities must pass)
 *   3. `terminal_convergence_below_100` — terminal convergence < 100%
 *      (hard invariant `terminal_convergence_100` failed)
 *   4. `unknown_citation_above_zero` — unknown citation count > 0
 *      (hard invariant `unknown_citation_count_zero` failed)
 *   5. `unauthorized_evidence_above_zero` — unauthorized evidence count > 0
 *      (hard invariant `unauthorized_evidence_zero` failed)
 *
 * Note: stop conditions #3, #4, #5 are specializations of #1 — they are
 * specific hard invariants that warrant individual stop-condition labels
 * for operator visibility. When any of #3/#4/#5 fire, #1 also fires (the
 * hard invariant regression). The evaluator reports ALL triggered conditions
 * so operators see the full picture.
 */
export type StopConditionKey =
  | "hard_invariant_regression"
  | "smoke_gate_failure"
  | "terminal_convergence_below_100"
  | "unknown_citation_above_zero"
  | "unauthorized_evidence_above_zero"

/**
 * All 5 stop conditions in spec order. Used by `evaluateStopConditions` to
 * produce a stable, reviewable triggered-condition list.
 */
export const STOP_CONDITIONS: readonly StopConditionKey[] = [
  "hard_invariant_regression",
  "smoke_gate_failure",
  "terminal_convergence_below_100",
  "unknown_citation_above_zero",
  "unauthorized_evidence_above_zero",
] as const

/**
 * Result of evaluating one stop condition.
 *
 * - `key`: which stop condition was evaluated
 * - `triggered`: true when this stop condition fired (immediate rollback
 *   required)
 * - `reason`: human-readable description of why it fired (or "not triggered"
 *   when `triggered === false`)
 * - `evidence`: optional supporting evidence (e.g. failing hard invariant
 *   keys, failing smoke capabilities)
 */
export interface StopConditionResult {
  key: StopConditionKey
  triggered: boolean
  reason: string
  evidence?: string[]
}

/**
 * Input to `evaluateStopConditions`. All fields are optional — the evaluator
 * skips any condition whose input is absent (treats it as "not triggered"
 * with a "no input provided" reason).
 *
 * - `hardInvariants`: results from `evaluateHardInvariants` (T10 P3). Used
 *   by stop conditions #1, #3, #4, #5.
 * - `smokeResults`: results from `runAllSmokeChecks` (T10 P6 / T13). Used
 *   by stop condition #2.
 * - `productionProfileOnly`: when true, only smoke results with
 *   `profile === "production"` are considered for stop condition #2.
 *   Default: true (T07 §6.1 — production smoke failures trigger rollback;
 *   local profile failures are dev-time signals, not rollback triggers).
 */
export interface StopConditionInput {
  hardInvariants?: HardInvariantResult[]
  smokeResults?: SmokeResult[]
  productionProfileOnly?: boolean
}

/**
 * Overall stop-condition evaluation result.
 *
 * - `triggered`: list of triggered stop conditions (empty when none fired)
 * - `shouldRollback`: true when ANY stop condition triggered (immediate
 *   rollback required per T07 §6.1)
 * - `results`: one `StopConditionResult` per stop condition, in spec order
 *   (STOP_CONDITIONS)
 *
 * The result is JSON-serializable so operators can persist it as part of the
 * rollback decision audit log.
 */
export interface StopConditionEvaluation {
  triggered: StopConditionResult[]
  shouldRollback: boolean
  results: StopConditionResult[]
}

// ---------------------------------------------------------------------------
// Individual stop condition evaluators (pure)
// ---------------------------------------------------------------------------

/**
 * Stop condition #1: hard invariant regression.
 *
 * Triggered when ANY hard invariant has `passed === false`. Hard invariants
 * are DETERMINISTIC + NON-OVERRIDABLE (T06 §6) — a single failure is a
 * release-blocking regression that requires immediate rollback.
 *
 * Returns the list of failing hard invariant keys as evidence.
 */
function evaluateHardInvariantRegression(
  hardInvariants: HardInvariantResult[] | undefined,
): StopConditionResult {
  if (hardInvariants === undefined) {
    return {
      key: "hard_invariant_regression",
      triggered: false,
      reason: "no hard invariant results provided",
    }
  }
  const failing = hardInvariants.filter((h) => !h.passed)
  return {
    key: "hard_invariant_regression",
    triggered: failing.length > 0,
    reason:
      failing.length === 0
        ? `all ${hardInvariants.length} hard invariants passed`
        : `${failing.length}/${hardInvariants.length} hard invariants failed`,
    evidence: failing.map((h) => h.key),
  }
}

/**
 * Stop condition #2: smoke gate failure.
 *
 * Triggered when ANY smoke check has `status === "failed"` in the production
 * profile. Local profile failures are dev-time signals, not rollback
 * triggers (controlled by `productionProfileOnly` — default true).
 *
 * Per T13 §10 + T07 §4.1: production profile requires all 12 capabilities
 * to pass; a single failure is a release-blocking regression.
 *
 * Returns the list of failing smoke capabilities as evidence.
 */
function evaluateSmokeGateFailure(
  smokeResults: SmokeResult[] | undefined,
  productionProfileOnly: boolean,
): StopConditionResult {
  if (smokeResults === undefined) {
    return {
      key: "smoke_gate_failure",
      triggered: false,
      reason: "no smoke results provided",
    }
  }
  const filtered = productionProfileOnly
    ? smokeResults.filter((r) => r.profile === "production")
    : smokeResults
  const failing = filtered.filter((r) => r.status === "failed")
  return {
    key: "smoke_gate_failure",
    triggered: failing.length > 0,
    reason:
      failing.length === 0
        ? `all ${filtered.length} smoke checks passed`
        : `${failing.length}/${filtered.length} smoke checks failed`,
    evidence: failing.map((r) => `${r.capability} (${r.profile})`),
  }
}

/**
 * Stop condition #3: terminal convergence below 100%.
 *
 * Triggered when the `terminal_convergence_100` hard invariant failed.
 * This is a specialization of stop condition #1 — surfaced as a distinct
 * stop condition for operator visibility (terminal convergence < 100%
 * means some runs did not reach a terminal status — a severe regression).
 */
function evaluateTerminalConvergenceBelow100(
  hardInvariants: HardInvariantResult[] | undefined,
): StopConditionResult {
  if (hardInvariants === undefined) {
    return {
      key: "terminal_convergence_below_100",
      triggered: false,
      reason: "no hard invariant results provided",
    }
  }
  const conv = hardInvariants.find(
    (h) => h.key === "terminal_convergence_100",
  )
  if (conv === undefined) {
    return {
      key: "terminal_convergence_below_100",
      triggered: false,
      reason: "terminal_convergence_100 invariant not present in results",
    }
  }
  return {
    key: "terminal_convergence_below_100",
    triggered: !conv.passed,
    reason: conv.passed
      ? `terminal convergence at 100% (${conv.actual})`
      : `terminal convergence below 100% (${conv.actual})`,
    evidence: conv.passed ? undefined : conv.failingCaseIds,
  }
}

/**
 * Stop condition #4: unknown citation above zero.
 *
 * Triggered when the `unknown_citation_count_zero` hard invariant failed.
 * Unknown citations mean the answer fabricated references — a severe
 * regression that requires immediate rollback.
 */
function evaluateUnknownCitationAboveZero(
  hardInvariants: HardInvariantResult[] | undefined,
): StopConditionResult {
  if (hardInvariants === undefined) {
    return {
      key: "unknown_citation_above_zero",
      triggered: false,
      reason: "no hard invariant results provided",
    }
  }
  const cit = hardInvariants.find(
    (h) => h.key === "unknown_citation_count_zero",
  )
  if (cit === undefined) {
    return {
      key: "unknown_citation_above_zero",
      triggered: false,
      reason: "unknown_citation_count_zero invariant not present in results",
    }
  }
  return {
    key: "unknown_citation_above_zero",
    triggered: !cit.passed,
    reason: cit.passed
      ? `unknown citation count is zero (${cit.actual})`
      : `unknown citation count above zero (${cit.actual})`,
    evidence: cit.passed ? undefined : cit.failingCaseIds,
  }
}

/**
 * Stop condition #5: unauthorized evidence above zero.
 *
 * Triggered when the `unauthorized_evidence_zero` hard invariant failed.
 * Unauthorized evidence means the system retrieved evidence outside the
 * declared expected/acceptable set — an authorization violation that
 * requires immediate rollback.
 */
function evaluateUnauthorizedEvidenceAboveZero(
  hardInvariants: HardInvariantResult[] | undefined,
): StopConditionResult {
  if (hardInvariants === undefined) {
    return {
      key: "unauthorized_evidence_above_zero",
      triggered: false,
      reason: "no hard invariant results provided",
    }
  }
  const unauth = hardInvariants.find(
    (h) => h.key === "unauthorized_evidence_zero",
  )
  if (unauth === undefined) {
    return {
      key: "unauthorized_evidence_above_zero",
      triggered: false,
      reason: "unauthorized_evidence_zero invariant not present in results",
    }
  }
  return {
    key: "unauthorized_evidence_above_zero",
    triggered: !unauth.passed,
    reason: unauth.passed
      ? `unauthorized evidence count is zero (${unauth.actual})`
      : `unauthorized evidence count above zero (${unauth.actual})`,
    evidence: unauth.passed ? undefined : unauth.failingCaseIds,
  }
}

// ---------------------------------------------------------------------------
// Top-level evaluator (pure)
// ---------------------------------------------------------------------------

/**
 * Evaluate all 5 stop conditions against the current release evidence.
 *
 * Pure function — no side effects, no I/O. The same inputs always produce
 * the same outputs.
 *
 * Returns a `StopConditionEvaluation` with one `StopConditionResult` per
 * stop condition, in spec order (STOP_CONDITIONS). The `shouldRollback`
 * flag is true when ANY condition triggered (immediate rollback required
 * per T07 §6.1).
 *
 * @example
 *   const hardInvariants = evaluateHardInvariants(goldenCases, caseResults)
 *   const smokeResults = await runAllSmokeChecks("production", probes)
 *   const evaluation = evaluateStopConditions({ hardInvariants, smokeResults })
 *   if (evaluation.shouldRollback) {
 *     const action = buildRollbackAction(evaluation.triggered)
 *     await executeRollback(action)  // operator reverts + redeploys
 *   }
 */
export function evaluateStopConditions(
  input: StopConditionInput,
): StopConditionEvaluation {
  const productionProfileOnly = input.productionProfileOnly ?? true
  const results: StopConditionResult[] = [
    evaluateHardInvariantRegression(input.hardInvariants),
    evaluateSmokeGateFailure(input.smokeResults, productionProfileOnly),
    evaluateTerminalConvergenceBelow100(input.hardInvariants),
    evaluateUnknownCitationAboveZero(input.hardInvariants),
    evaluateUnauthorizedEvidenceAboveZero(input.hardInvariants),
  ]
  const triggered = results.filter((r) => r.triggered)
  return {
    triggered,
    shouldRollback: triggered.length > 0,
    results,
  }
}

/**
 * Convenience wrapper — returns `true` when any stop condition triggered.
 * Useful for short-circuiting rollback decisions without inspecting the
 * full evaluation.
 */
export function shouldRollback(input: StopConditionInput): boolean {
  return evaluateStopConditions(input).shouldRollback
}

// ---------------------------------------------------------------------------
// Rollback action (pure)
// ---------------------------------------------------------------------------

/**
 * Rollback action record. Built by `buildRollbackAction` when a stop
 * condition triggers.
 *
 * - `strategy`: the deployment rollback strategy
 * - `releaseRef`: the accepted pre-contraction release to restore
 * - `triggeredConditions`: list of stop conditions that fired
 * - `reason`: human-readable summary of why rollback is required
 * - `timestamp`: ISO 8601 timestamp the action was built
 *
 * The action is JSON-serializable — operators can persist it as part of
 * the rollback audit log (T07 §2.2 — "Every mode flip is recorded in the
 * application log with timestamp, operator identity, previous mode, new
 * mode").
 */
export interface RollbackAction {
  strategy: "git_revert_redeploy"
  releaseRef: string
  triggeredConditions: StopConditionKey[]
  reason: string
  timestamp: string
}

/**
 * Build a rollback action record from triggered stop conditions.
 *
 * Pure function — no side effects, no I/O. The action is a record of WHAT
 * to do; operators execute and audit the revert + redeploy operation.
 *
 * @example
 *   const evaluation = evaluateStopConditions({ hardInvariants, smokeResults })
 *   if (evaluation.shouldRollback) {
 *     const action = buildRollbackAction(evaluation.triggered)
 *     logger.error("rollback required", action)
 *     await auditLog.record(action)
 *     await deployment.revertAndRedeploy(action.releaseRef)
 *   }
 */
export function buildRollbackAction(
  triggered: StopConditionResult[],
  options?: { releaseRef?: string; timestamp?: string },
): RollbackAction {
  const releaseRef = options?.releaseRef ?? "pre-mastra-contraction"
  const timestamp = options?.timestamp ?? new Date().toISOString()
  const triggeredConditions = triggered.map((r) => r.key)
  const reasonParts = triggered.map(
    (r) => `${r.key}: ${r.reason}`,
  )
  return {
    strategy: "git_revert_redeploy",
    releaseRef,
    triggeredConditions,
    reason: reasonParts.join("; "),
    timestamp,
  }
}

// ---------------------------------------------------------------------------
// Type re-exports for callers
// ---------------------------------------------------------------------------

export type { HardInvariantResult, SmokeResult }
