// Ticket 10 Phase D P6 — Real dependency smoke gate.
//
// Spec §10 L1564-1569:
//   - Production readiness requires smoke cases for: MarkItDown, Marker,
//     MinerU, Elasticsearch vector + BM25 retrieval, Neo4j graph provenance,
//     PageIndex lookup, embedding provider, chat provider, cancellation,
//     and graceful shutdown (11 capabilities, spec L1566).
//   - Missing capabilities are allowed for local development but are not
//     accepted as a production release pass. The artifact records skipped
//     capability checks as failures for the production profile (L1567).
//   - Smoke fixtures are bounded, synthetic and committed without private
//     data (L1568). Fixtures + provider calls live in the probe; the runner
//     is fixture-agnostic.
//   - External outages must still produce the documented degraded or
//     insufficient terminal status and preserve trace convergence (L1569) —
//     this property is enforced by the golden set's `insufficient` cases,
//     NOT by this smoke gate. The smoke gate only verifies reachability.
//
// Design: thin runner. Three responsibilities:
//   1. runSmokeCheck — invoke a single probe, enforce profile semantics
//   2. runAllSmokeChecks — invoke all 11 probes in CAPABILITY_ORDER
//   3. smokeGatePassed — aggregate pass/fail decision
//
// The runner does NOT own fixtures or provider calls. Callers inject a
// SmokeProbe per capability. This keeps smoke.ts simple (karpathy #2) and
// lets the caller own fixture + verification logic.

import type {
  EvaluationProfile,
  SmokeCapabilityKey,
  SmokeProbe,
  SmokeProbeBundle,
  SmokeResult,
} from "./types"

/**
 * Spec L1566: canonical capability order. Used by runAllSmokeChecks so the
 * artifact's smoke results array has a stable, reviewable order.
 *
 * T13 (spec issue #13): `langfuse` appended after the original 11
 * capabilities. It is an optional observability capability — local profile
 * skips when Langfuse is not configured; production profile fails when
 * configured but unreachable or incomplete.
 */
export const CAPABILITY_ORDER: readonly SmokeCapabilityKey[] = [
  "markitdown",
  "marker",
  "mineru",
  "elasticsearch_vector",
  "elasticsearch_bm25",
  "neo4j",
  "pageindex",
  "embedding",
  "chat",
  "cancellation",
  "graceful_shutdown",
  "langfuse",
] as const

const DEFAULT_FAIL_REASON = "probe returned ok=false"

/**
 * Spec L1567: run a single smoke capability probe.
 *
 * Profile semantics:
 *   - probe undefined + local → skipped (missing capability allowed)
 *   - probe undefined + production → failed (missing capability NOT allowed)
 *   - probe returns {ok:true} → passed
 *   - probe returns {ok:false, reason?} → failed (reason or default)
 *   - probe throws → failed (reason = error message or String(value))
 *
 * The runner catches all probe errors — a single capability crash must NOT
 * abort the other 10 checks. durationMs is wall-clock from runner entry to
 * result construction (probe timing included).
 */
export async function runSmokeCheck(
  capability: SmokeCapabilityKey,
  profile: EvaluationProfile,
  probe: SmokeProbe | undefined,
): Promise<SmokeResult> {
  const start = Date.now()
  if (probe === undefined) {
    return {
      capability,
      profile,
      status: profile === "production" ? "failed" : "skipped",
      reason:
        profile === "production"
          ? "missing capability probe (production profile requires all 12 probes)"
          : "no probe provided for local profile",
      durationMs: Date.now() - start,
    }
  }
  try {
    const result = await probe()
    const durationMs = Date.now() - start
    if (result.ok) {
      return { capability, profile, status: "passed", durationMs }
    }
    return {
      capability,
      profile,
      status: "failed",
      reason: result.reason ?? DEFAULT_FAIL_REASON,
      durationMs,
    }
  } catch (err) {
    return {
      capability,
      profile,
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    }
  }
}

/**
 * Spec L1566: run all capability probes in CAPABILITY_ORDER (12 entries
 * after T13 added `langfuse`).
 *
 * Each probe is run sequentially (not in parallel) so that a crashing
 * capability does not cascade-fail others, and so the artifact's smoke
 * results have a deterministic order matching CAPABILITY_ORDER.
 *
 * Returns exactly CAPABILITY_ORDER.length SmokeResult entries, one per capability.
 */
export async function runAllSmokeChecks(
  profile: EvaluationProfile,
  probes: SmokeProbeBundle,
): Promise<SmokeResult[]> {
  const results: SmokeResult[] = []
  for (const capability of CAPABILITY_ORDER) {
    const probe = probes[capability]
    results.push(await runSmokeCheck(capability, profile, probe))
  }
  return results
}

/**
 * Spec L1567: aggregate smoke gate decision.
 *
 * Returns true when the smoke gate passes:
 *   - empty results → true (vacuous — caller passed nothing, no failures)
 *   - any failed → false (broken capability)
 *   - production + any skipped → false (missing capability is failure)
 *   - local + skipped (no failures) → true (missing allowed)
 *   - all passed → true
 */
export function smokeGatePassed(results: SmokeResult[]): boolean {
  for (const r of results) {
    if (r.status === "failed") return false
    if (r.profile === "production" && r.status === "skipped") return false
  }
  return true
}
