// Ticket 13 — Live Langfuse smoke profile.
//
// Spec issue #13:
//   - Add an optional real-service acceptance probe proving that a configured
//     Answer run reaches Langfuse with its core and agentic spans.
//   - Local development may skip the probe, while a production profile that
//     explicitly requires Langfuse must fail when export is unavailable or
//     incomplete.
//
// Design (karpathy #2 — simplicity first): the probe is a SmokeProbe that
// fits the existing 12-capability smoke framework. The factory returns
// `undefined` when Langfuse config is absent OR when the client does not
// support `fetchTrace` — the existing runner then skips on local profile and
// fails on production profile. When config is present + client supports
// read-back, the factory returns a real probe that:
//   1. Triggers a bounded synthetic Answer run via caller-supplied callback.
//   2. Polls `client.fetchTrace(runId)` within a bounded timeout.
//   3. Verifies the trace snapshot has the expected spans + generation +
//      terminal metadata (criterion #2).
//   4. Verifies the privacy marker is NOT present in the serialized trace
//      (criterion #3 — raw retrieved passage must not leak).
//   5. Records host identity, SDK version and runId in outputs (criterion #7).
//
// The probe does NOT own the synthetic fixture — the caller's `triggerRun`
// owns it. The probe only owns the verification logic. This keeps the probe
// decoupled from Answer orchestration internals (karpathy #3 — surgical).

import type {
  LangfuseClient,
  LangfuseConfig,
  LangfuseTraceSnapshot,
} from "../answer/langfuse_exporter"
import type { SmokeProbe, SmokeProbeResult } from "./types"

/**
 * Options for the Langfuse smoke probe. All timing fields have safe defaults
 * so callers can construct the probe with minimal configuration.
 */
export interface LangfuseSmokeProbeOptions {
  /**
   * Triggers a bounded synthetic Answer run and returns its runId. The
   * caller owns the fixture — typically a knowledge-route query that
   * exercises route → retrieval → generation → validation → terminal.
   * The synthetic retrieved passage MUST contain `privacyMarker` so the
   * probe can verify it does NOT leak into the trace.
   */
  triggerRun: () => Promise<string>
  /**
   * Langfuse client with `fetchTrace` for read-back verification. If the
   * client does not expose `fetchTrace`, the factory returns `undefined`
   * (the probe cannot verify trace reachability without read-back).
   */
  client: LangfuseClient
  /**
   * Privacy marker that MUST appear in the synthetic retrieved passage but
   * MUST NOT appear anywhere in the serialized trace snapshot. If found in
   * the trace, the probe fails with a privacy violation (criterion #3).
   */
  privacyMarker: string
  /** Total bounded timeout for the poll loop in ms (default 2000). */
  timeoutMs?: number
  /** Delay between poll attempts in ms (default 500). */
  pollIntervalMs?: number
  /** Max poll attempts (default 5). Bounds total poll duration. */
  pollAttempts?: number
  /** SDK version recorded in outputs (default "unknown"). */
  sdkVersion?: string
  /**
   * Required span names in the trace (default ["route", "retrieval",
   * "validation"]). The caller can override based on their fixture's route.
   * "retrieval" covers both vector/BM25 retrieval and tool-loop observations
   * since tool decisions are part of retrieval/context events in the
   * current implementation.
   */
  expectedSpans?: readonly string[]
}

/**
 * Default Langfuse cloud host. Used when `config.baseUrl` is absent — the
 * real `langfuse` npm package defaults to this.
 */
const DEFAULT_LANGFUSE_HOST = "https://cloud.langfuse.com"

/**
 * Default required span names. Exercises the full Answer pipeline:
 * route → retrieval → validation. The synthetic fixture should use a
 * knowledge-route query so all three stages emit events.
 */
const DEFAULT_EXPECTED_SPANS: readonly string[] = ["route", "retrieval", "validation"]

/**
 * T13 (spec issue #13): factory for the Langfuse smoke probe.
 *
 * Returns `undefined` when:
 *   - `config` is absent or empty (no publicKey AND no secretKey) — local
 *     profile skips, production profile fails (criterion #4, #5)
 *   - `client.fetchTrace` is not a function — the probe cannot verify trace
 *     reachability without read-back; treated as "capability not configured"
 *
 * Returns a real `SmokeProbe` when config is present + client supports
 * read-back. The probe submits a synthetic run, polls for the trace, and
 * verifies contents + privacy within a bounded timeout.
 */
export function createLangfuseSmokeProbe(
  config: LangfuseConfig | undefined,
  options: LangfuseSmokeProbeOptions,
): SmokeProbe | undefined {
  // Criterion #4: missing credentials → probe undefined → runner skips on
  // local, fails on production. We treat "empty config" the same as
  // "absent config" so callers can pass `undefined` from optional env vars.
  if (!config || (!config.publicKey && !config.secretKey)) {
    return undefined
  }
  // If the client doesn't support read-back, we can't verify trace
  // reachability. Treat as "capability not configured" — same skip/fail
  // semantics as missing config.
  if (typeof options.client.fetchTrace !== "function") {
    return undefined
  }

  const timeoutMs = options.timeoutMs ?? 2000
  const pollIntervalMs = options.pollIntervalMs ?? 500
  const pollAttempts = options.pollAttempts ?? 5
  const sdkVersion = options.sdkVersion ?? "unknown"
  const host = config.baseUrl ?? DEFAULT_LANGFUSE_HOST
  const expectedSpans = options.expectedSpans ?? DEFAULT_EXPECTED_SPANS
  const fetchTrace = options.client.fetchTrace

  return async (): Promise<SmokeProbeResult> => {
    const start = Date.now()
    // Criterion #7: outputs record host identity + SDK version (no secrets).
    // runId is appended after triggerRun succeeds.
    const baseOutputs = [host, sdkVersion]

    let runId: string
    try {
      runId = await options.triggerRun()
    } catch (err) {
      return {
        ok: false,
        reason: `triggerRun failed: ${err instanceof Error ? err.message : String(err)}`,
        outputs: baseOutputs,
      }
    }

    // Criterion #1 + #6: bounded poll loop. The trace may not be queryable
    // immediately due to eventual consistency. Poll up to `pollAttempts`
    // times with `pollIntervalMs` delay, bounded by `timeoutMs` total.
    const deadline = start + timeoutMs
    let attempts = 0
    let lastError: unknown
    let snapshot: LangfuseTraceSnapshot | undefined
    while (attempts < pollAttempts && Date.now() < deadline) {
      attempts++
      try {
        snapshot = await fetchTrace.call(options.client, runId)
        if (snapshot) break
      } catch (err) {
        // Criterion #6: service errors are recorded but do not hang the
        // probe — keep polling within the bounded timeout.
        lastError = err
      }
      // Sleep before next attempt, but only if we haven't hit the deadline
      // or the attempt cap.
      if (attempts < pollAttempts && Date.now() + pollIntervalMs < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs))
      }
    }

    const outputs = [...baseOutputs, runId]

    if (!snapshot) {
      // Criterion #5: configured but unreachable (fetchTrace threw every
      // time) OR trace not yet queryable (fetchTrace returned undefined
      // within timeout). Both are failures for production profile.
      const errPart = lastError instanceof Error
        ? `; last error: ${lastError.message}`
        : lastError !== undefined
          ? `; last error: ${String(lastError)}`
          : ""
      return {
        ok: false,
        reason: `trace ${runId} not queryable within ${timeoutMs}ms (${attempts} attempts${errPart})`,
        outputs,
      }
    }

    // Criterion #2 + #3: verify trace contents + privacy.
    const verification = verifyTraceSnapshot(snapshot, runId, expectedSpans, options.privacyMarker)
    if (!verification.ok) {
      return {
        ok: false,
        reason: verification.reason,
        outputs,
      }
    }

    return { ok: true, outputs }
  }
}

/**
 * Verify the fetched trace snapshot satisfies criterion #2 (expected
 * observations correlated to run ID) and criterion #3 (privacy — no raw
 * passage marker in the trace).
 *
 * Returns `{ok: true}` when all checks pass, or `{ok: false, reason}` with
 * a specific failure description. Reasons never include secrets (only
 * runId, span names and the privacy marker label).
 */
function verifyTraceSnapshot(
  snapshot: LangfuseTraceSnapshot,
  expectedRunId: string,
  expectedSpans: readonly string[],
  privacyMarker: string,
): { ok: true } | { ok: false; reason: string } {
  // Criterion #2: correlation — trace ID must match the expected run ID.
  if (snapshot.id !== expectedRunId) {
    return {
      ok: false,
      reason: `trace id mismatch: expected ${expectedRunId}, got ${snapshot.id}`,
    }
  }

  const spanNames = new Set(snapshot.spans.map((s) => s.name))

  // Criterion #2: required spans present.
  const missing = expectedSpans.filter((name) => !spanNames.has(name))
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `trace missing required spans: ${missing.join(", ")} (present: ${[...spanNames].join(", ") || "none"})`,
    }
  }

  // Criterion #2: generation (answer) required.
  if (snapshot.generations.length === 0) {
    return {
      ok: false,
      reason: `trace missing generation (answer observation)`,
    }
  }

  // Criterion #2: terminal metadata required (trace finalized with done event).
  if (!snapshot.metadata || !("terminalStatus" in snapshot.metadata)) {
    return {
      ok: false,
      reason: `trace missing terminal metadata (terminalStatus field absent)`,
    }
  }

  // Criterion #3: privacy — the raw passage marker MUST NOT appear anywhere
  // in the serialized trace. If found, the exporter leaked raw retrieved
  // content, violating the privacy defaults (T11 criterion #6).
  if (privacyMarker) {
    const serialized = JSON.stringify(snapshot)
    if (serialized.includes(privacyMarker)) {
      return {
        ok: false,
        reason: `privacy violation: raw passage marker '${privacyMarker}' found in trace (raw retrieved content leaked)`,
      }
    }
  }

  return { ok: true }
}
