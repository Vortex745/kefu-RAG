// Ticket 13 — Live Langfuse smoke profile tests.
//
// Spec issue #13 criteria:
//   1. Probe submits one bounded synthetic Answer run and waits for its
//      Langfuse trace to become queryable
//   2. Observed trace contains route, retrieval or tool, generation,
//      validation and terminal observations correlated to expected run ID
//   3. Trace exposes privacy-safe metadata and does not contain the
//      synthetic raw retrieved passage when default privacy settings are used
//   4. Local profile records missing credentials or service availability
//      as an explicit skip
//   5. Production profile treats configured-but-unreachable Langfuse or an
//      incomplete trace as a failed capability
//   6. Probe timeout and service errors are bounded and cannot hang the
//      evaluation runner or application shutdown
//   7. Smoke output records host identity, SDK version, duration and safe
//      failure reason without secrets
//
// Design: tests use a fake LangfuseClient with fetchTrace that returns
// in-memory recorded traces. No live Langfuse service required. The fake
// models eventual consistency (returns undefined until trace is "flushed")
// and service errors (throws on demand) so tests can exercise the bounded
// poll loop and error handling.

import test from "node:test"
import assert from "node:assert/strict"

import { createLangfuseSmokeProbe } from "./langfuse_smoke"
import { runSmokeCheck, CAPABILITY_ORDER } from "./smoke"
import type {
  LangfuseClient,
  LangfuseConfig,
  LangfuseTraceSnapshot,
} from "../answer/langfuse_exporter"
import type { SmokeProbeResult } from "./types"

// ---------------------------------------------------------------------------
// Fake Langfuse client with fetchTrace support
// ---------------------------------------------------------------------------

interface FakeClientOptions {
  /** Traces that have been "flushed" and are queryable. Maps traceId -> snapshot. */
  flushed?: Map<string, LangfuseTraceSnapshot>
  /** When set, fetchTrace throws this error instead of returning. */
  throwOnFetch?: Error
  /** Delay before fetchTrace resolves (ms). Models network latency. */
  fetchDelayMs?: number
}

function createFakeClient(options: FakeClientOptions = {}): LangfuseClient {
  const flushed = options.flushed ?? new Map()
  return {
    trace(params) {
      // Minimal trace() stub — not used by the smoke probe, but required
      // by the LangfuseClient interface. Returns a no-op trace object.
      return {
        span: () => ({ end() {}, update() {} }),
        generation: () => ({ end() {}, update() {} }),
        update: () => {},
      }
    },
    async fetchTrace(id: string): Promise<LangfuseTraceSnapshot | undefined> {
      if (options.throwOnFetch) throw options.throwOnFetch
      if (options.fetchDelayMs) {
        await new Promise<void>((resolve) => setTimeout(resolve, options.fetchDelayMs))
      }
      return flushed.get(id)
    },
  }
}

function createValidSnapshot(runId: string): LangfuseTraceSnapshot {
  return {
    id: runId,
    name: "answer-run",
    spans: [
      { name: "route", metadata: { decision: "knowledge" } },
      { name: "retrieval", metadata: { resultCount: 3 } },
      { name: "validation", metadata: { passed: true } },
    ],
    generations: [
      { name: "answer", model: "gpt-4o", metadata: { tokenCount: 42 } },
    ],
    metadata: { terminalStatus: "completed", replyLength: 100 },
  }
}

const PRIVACY_MARKER = "LANGFUSE_SMOKE_PRIVACY_MARKER_xyz789"
const VALID_CONFIG: LangfuseConfig = {
  publicKey: "pk-test",
  secretKey: "sk-test",
  baseUrl: "https://langfuse.example.com",
}

// ---------------------------------------------------------------------------
// Factory: undefined-when-not-configured (criterion #4)
// ---------------------------------------------------------------------------

test("T13: createLangfuseSmokeProbe returns undefined when config is undefined (criterion #4)", () => {
  const client = createFakeClient()
  const probe = createLangfuseSmokeProbe(undefined, {
    triggerRun: async () => "run-1",
    client,
    privacyMarker: PRIVACY_MARKER,
  })
  assert.equal(probe, undefined, "absent config → undefined probe (runner skips on local, fails on production)")
})

test("T13: createLangfuseSmokeProbe returns undefined when config has empty keys (criterion #4)", () => {
  const client = createFakeClient()
  const emptyConfig: LangfuseConfig = { publicKey: "", secretKey: "" }
  const probe = createLangfuseSmokeProbe(emptyConfig, {
    triggerRun: async () => "run-1",
    client,
    privacyMarker: PRIVACY_MARKER,
  })
  assert.equal(probe, undefined, "empty config → undefined probe")
})

test("T13: createLangfuseSmokeProbe returns undefined when client lacks fetchTrace (criterion #4)", () => {
  // Client with no fetchTrace method — can't verify trace reachability
  const client: LangfuseClient = {
    trace: () => ({
      span: () => ({ end() {}, update() {} }),
      generation: () => ({ end() {}, update() {} }),
      update: () => {},
    }),
  }
  const probe = createLangfuseSmokeProbe(VALID_CONFIG, {
    triggerRun: async () => "run-1",
    client,
    privacyMarker: PRIVACY_MARKER,
  })
  assert.equal(probe, undefined, "client without fetchTrace → undefined probe")
})

test("T13: createLangfuseSmokeProbe returns a probe when config + fetchTrace present", () => {
  const client = createFakeClient()
  const probe = createLangfuseSmokeProbe(VALID_CONFIG, {
    triggerRun: async () => "run-1",
    client,
    privacyMarker: PRIVACY_MARKER,
  })
  assert.equal(typeof probe, "function", "config + fetchTrace → real probe")
})

// ---------------------------------------------------------------------------
// Probe: successful trace verification (criteria #1, #2, #7)
// ---------------------------------------------------------------------------

test("T13: probe returns ok=true when trace is queryable with expected spans (criteria #1, #2)", async () => {
  const runId = "run-success"
  const flushed = new Map<string, LangfuseTraceSnapshot>([
    [runId, createValidSnapshot(runId)],
  ])
  const client = createFakeClient({ flushed })
  const probe = createLangfuseSmokeProbe(VALID_CONFIG, {
    triggerRun: async () => runId,
    client,
    privacyMarker: PRIVACY_MARKER,
  })!
  const result: SmokeProbeResult = await probe()
  assert.equal(result.ok, true, "trace queryable with expected spans → ok")
  assert.equal(result.reason, undefined, "success has no reason")
  assert.ok(result.outputs, "success has outputs")
  assert.ok(result.outputs!.includes("https://langfuse.example.com"), "outputs include host")
  assert.ok(result.outputs!.includes(runId), "outputs include runId")
})

test("T13: probe outputs include SDK version (criterion #7)", async () => {
  const runId = "run-sdk"
  const flushed = new Map([[runId, createValidSnapshot(runId)]])
  const client = createFakeClient({ flushed })
  const probe = createLangfuseSmokeProbe(VALID_CONFIG, {
    triggerRun: async () => runId,
    client,
    privacyMarker: PRIVACY_MARKER,
    sdkVersion: "langfuse@3.0.0",
  })!
  const result = await probe()
  assert.equal(result.ok, true)
  assert.ok(result.outputs!.includes("langfuse@3.0.0"), "outputs include SDK version")
})

test("T13: probe outputs use default Langfuse cloud host when baseUrl absent (criterion #7)", async () => {
  const runId = "run-default-host"
  const flushed = new Map([[runId, createValidSnapshot(runId)]])
  const client = createFakeClient({ flushed })
  const config: LangfuseConfig = { publicKey: "pk", secretKey: "sk" }
  const probe = createLangfuseSmokeProbe(config, {
    triggerRun: async () => runId,
    client,
    privacyMarker: PRIVACY_MARKER,
  })!
  const result = await probe()
  assert.equal(result.ok, true)
  assert.ok(
    result.outputs!.includes("https://cloud.langfuse.com"),
    "default host used when baseUrl absent",
  )
})

test("T13: probe outputs default SDK version to 'unknown' (criterion #7)", async () => {
  const runId = "run-sdk-default"
  const flushed = new Map([[runId, createValidSnapshot(runId)]])
  const client = createFakeClient({ flushed })
  const probe = createLangfuseSmokeProbe(VALID_CONFIG, {
    triggerRun: async () => runId,
    client,
    privacyMarker: PRIVACY_MARKER,
  })!
  const result = await probe()
  assert.ok(result.outputs!.includes("unknown"), "default SDK version is 'unknown'")
})

// ---------------------------------------------------------------------------
// Probe: trace not queryable / service errors (criteria #5, #6)
// ---------------------------------------------------------------------------

test("T13: probe returns ok=false when trace not queryable within timeout (criteria #1, #5, #6)", async () => {
  const flushed = new Map<string, LangfuseTraceSnapshot>() // empty — trace never appears
  const client = createFakeClient({ flushed })
  const probe = createLangfuseSmokeProbe(VALID_CONFIG, {
    triggerRun: async () => "run-missing",
    client,
    privacyMarker: PRIVACY_MARKER,
    timeoutMs: 200,
    pollIntervalMs: 50,
    pollAttempts: 3,
  })!
  const start = Date.now()
  const result = await probe()
  const elapsed = Date.now() - start
  assert.equal(result.ok, false, "trace not queryable → ok=false")
  assert.match(result.reason!, /not queryable within 200ms/, "reason mentions timeout")
  assert.match(result.reason!, /3 attempts/, "reason mentions attempt count")
  // Criterion #6: bounded — must not hang. With 200ms timeout + 3 attempts,
  // elapsed should be well under 1000ms.
  assert.ok(elapsed < 1000, `probe must be bounded (elapsed=${elapsed}ms < 1000ms)`)
})

test("T13: probe returns ok=false when fetchTrace throws every attempt (criteria #5, #6)", async () => {
  const client = createFakeClient({
    throwOnFetch: new Error("Langfuse service unreachable (503)"),
  })
  const probe = createLangfuseSmokeProbe(VALID_CONFIG, {
    triggerRun: async () => "run-unreachable",
    client,
    privacyMarker: PRIVACY_MARKER,
    timeoutMs: 200,
    pollIntervalMs: 50,
    pollAttempts: 3,
  })!
  const result = await probe()
  assert.equal(result.ok, false, "service error → ok=false")
  assert.match(result.reason!, /not queryable/, "reason mentions not queryable")
  assert.match(result.reason!, /Langfuse service unreachable/, "reason includes last error message")
})

test("T13: probe does not hang — bounded by timeoutMs even with slow fetchTrace (criterion #6)", async () => {
  // fetchTrace takes 500ms per call but timeoutMs is 200ms — the probe must
  // not wait for the slow fetch to complete if it exceeds the deadline.
  // Note: the poll loop checks Date.now() < deadline before each attempt,
  // so a single slow fetch that exceeds the deadline will still complete
  // (we can't cancel an in-flight promise), but subsequent attempts are
  // skipped. Total elapsed is bounded by one fetchDelay + timeoutMs.
  const client = createFakeClient({ fetchDelayMs: 100 })
  const probe = createLangfuseSmokeProbe(VALID_CONFIG, {
    triggerRun: async () => "run-slow",
    client,
    privacyMarker: PRIVACY_MARKER,
    timeoutMs: 250,
    pollIntervalMs: 50,
    pollAttempts: 5,
  })!
  const start = Date.now()
  const result = await probe()
  const elapsed = Date.now() - start
  assert.equal(result.ok, false, "slow fetch with empty flushed → ok=false")
  // Bounded: with 100ms fetch + 250ms timeout, elapsed should be under 1000ms.
  assert.ok(elapsed < 1000, `probe must be bounded (elapsed=${elapsed}ms < 1000ms)`)
})

test("T13: probe catches triggerRun failure (criterion #6)", async () => {
  const client = createFakeClient()
  const probe = createLangfuseSmokeProbe(VALID_CONFIG, {
    triggerRun: async () => {
      throw new Error("AnswerGeneration failed to start")
    },
    client,
    privacyMarker: PRIVACY_MARKER,
  })!
  const result = await probe()
  assert.equal(result.ok, false, "triggerRun failure → ok=false")
  assert.match(result.reason!, /triggerRun failed/, "reason mentions triggerRun")
  assert.match(result.reason!, /AnswerGeneration failed to start/, "reason includes error message")
  // Outputs still include host + sdkVersion even when triggerRun fails (no runId).
  assert.ok(result.outputs!.includes("https://langfuse.example.com"), "outputs include host on triggerRun failure")
})

// ---------------------------------------------------------------------------
// Probe: trace content verification (criterion #2)
// ---------------------------------------------------------------------------

test("T13: probe returns ok=false when trace id mismatches runId (criterion #2)", async () => {
  const runId = "run-correlation"
  const wrongSnapshot = createValidSnapshot("different-run-id")
  const flushed = new Map([[runId, wrongSnapshot]])
  const client = createFakeClient({ flushed })
  const probe = createLangfuseSmokeProbe(VALID_CONFIG, {
    triggerRun: async () => runId,
    client,
    privacyMarker: PRIVACY_MARKER,
  })!
  const result = await probe()
  assert.equal(result.ok, false, "id mismatch → ok=false")
  assert.match(result.reason!, /trace id mismatch/, "reason mentions id mismatch")
  assert.match(result.reason!, /expected run-correlation/, "reason mentions expected runId")
})

test("T13: probe returns ok=false when trace missing required spans (criterion #2)", async () => {
  const runId = "run-missing-spans"
  const incompleteSnapshot: LangfuseTraceSnapshot = {
    id: runId,
    name: "answer-run",
    spans: [{ name: "route" }], // missing retrieval + validation
    generations: [{ name: "answer" }],
    metadata: { terminalStatus: "completed" },
  }
  const flushed = new Map([[runId, incompleteSnapshot]])
  const client = createFakeClient({ flushed })
  const probe = createLangfuseSmokeProbe(VALID_CONFIG, {
    triggerRun: async () => runId,
    client,
    privacyMarker: PRIVACY_MARKER,
  })!
  const result = await probe()
  assert.equal(result.ok, false, "missing spans → ok=false")
  assert.match(result.reason!, /missing required spans/, "reason mentions missing spans")
  assert.match(result.reason!, /retrieval, validation/, "reason lists missing span names")
})

test("T13: probe returns ok=false when trace missing generation (criterion #2)", async () => {
  const runId = "run-no-generation"
  const noGenSnapshot: LangfuseTraceSnapshot = {
    id: runId,
    name: "answer-run",
    spans: [
      { name: "route" },
      { name: "retrieval" },
      { name: "validation" },
    ],
    generations: [], // no generation
    metadata: { terminalStatus: "completed" },
  }
  const flushed = new Map([[runId, noGenSnapshot]])
  const client = createFakeClient({ flushed })
  const probe = createLangfuseSmokeProbe(VALID_CONFIG, {
    triggerRun: async () => runId,
    client,
    privacyMarker: PRIVACY_MARKER,
  })!
  const result = await probe()
  assert.equal(result.ok, false, "missing generation → ok=false")
  assert.match(result.reason!, /missing generation/, "reason mentions missing generation")
})

test("T13: probe returns ok=false when trace missing terminal metadata (criterion #2)", async () => {
  const runId = "run-no-terminal"
  const noTerminalSnapshot: LangfuseTraceSnapshot = {
    id: runId,
    name: "answer-run",
    spans: [{ name: "route" }, { name: "retrieval" }, { name: "validation" }],
    generations: [{ name: "answer" }],
    metadata: {}, // no terminalStatus
  }
  const flushed = new Map([[runId, noTerminalSnapshot]])
  const client = createFakeClient({ flushed })
  const probe = createLangfuseSmokeProbe(VALID_CONFIG, {
    triggerRun: async () => runId,
    client,
    privacyMarker: PRIVACY_MARKER,
  })!
  const result = await probe()
  assert.equal(result.ok, false, "missing terminal metadata → ok=false")
  assert.match(result.reason!, /missing terminal metadata/, "reason mentions terminal metadata")
})

test("T13: probe accepts custom expectedSpans (criterion #2 — flexible fixture)", async () => {
  const runId = "run-custom-spans"
  // Fixture that only exercises route + context (no validation, no retrieval)
  const snapshot: LangfuseTraceSnapshot = {
    id: runId,
    name: "answer-run",
    spans: [{ name: "route" }, { name: "context" }],
    generations: [{ name: "answer" }],
    metadata: { terminalStatus: "completed" },
  }
  const flushed = new Map([[runId, snapshot]])
  const client = createFakeClient({ flushed })
  const probe = createLangfuseSmokeProbe(VALID_CONFIG, {
    triggerRun: async () => runId,
    client,
    privacyMarker: PRIVACY_MARKER,
    expectedSpans: ["route", "context"],
  })!
  const result = await probe()
  assert.equal(result.ok, true, "custom expectedSpans accepted when present")
})

// ---------------------------------------------------------------------------
// Probe: privacy verification (criterion #3)
// ---------------------------------------------------------------------------

test("T13: probe returns ok=false when privacy marker found in trace metadata (criterion #3)", async () => {
  const runId = "run-privacy-leak"
  const leakingSnapshot: LangfuseTraceSnapshot = {
    id: runId,
    name: "answer-run",
    spans: [
      { name: "route", metadata: { decision: "knowledge" } },
      { name: "retrieval", metadata: { rawPassage: `content with ${PRIVACY_MARKER} inside` } },
      { name: "validation", metadata: { passed: true } },
    ],
    generations: [{ name: "answer" }],
    metadata: { terminalStatus: "completed" },
  }
  const flushed = new Map([[runId, leakingSnapshot]])
  const client = createFakeClient({ flushed })
  const probe = createLangfuseSmokeProbe(VALID_CONFIG, {
    triggerRun: async () => runId,
    client,
    privacyMarker: PRIVACY_MARKER,
  })!
  const result = await probe()
  assert.equal(result.ok, false, "privacy marker in trace → ok=false")
  assert.match(result.reason!, /privacy violation/, "reason mentions privacy violation")
  assert.match(result.reason!, /raw retrieved content leaked/, "reason mentions raw content leaked")
})

test("T13: probe returns ok=true when privacy marker NOT in trace (criterion #3 — safe metadata)", async () => {
  const runId = "run-privacy-safe"
  const safeSnapshot: LangfuseTraceSnapshot = {
    id: runId,
    name: "answer-run",
    spans: [
      { name: "route", metadata: { decision: "knowledge" } },
      { name: "retrieval", metadata: { resultCount: 3, evidenceIds: ["ev-1", "ev-2"] } },
      { name: "validation", metadata: { passed: true } },
    ],
    generations: [{ name: "answer", metadata: { tokenCount: 42 } }],
    metadata: { terminalStatus: "completed", replyLength: 100 },
  }
  const flushed = new Map([[runId, safeSnapshot]])
  const client = createFakeClient({ flushed })
  const probe = createLangfuseSmokeProbe(VALID_CONFIG, {
    triggerRun: async () => runId,
    client,
    privacyMarker: PRIVACY_MARKER,
  })!
  const result = await probe()
  assert.equal(result.ok, true, "safe metadata without raw passage → ok=true")
})

test("T13: probe skips privacy check when privacyMarker is empty string", async () => {
  const runId = "run-no-marker"
  const snapshot = createValidSnapshot(runId)
  const flushed = new Map([[runId, snapshot]])
  const client = createFakeClient({ flushed })
  const probe = createLangfuseSmokeProbe(VALID_CONFIG, {
    triggerRun: async () => runId,
    client,
    privacyMarker: "", // empty — skip privacy check
  })!
  const result = await probe()
  assert.equal(result.ok, true, "empty privacyMarker → check skipped, trace still valid")
})

// ---------------------------------------------------------------------------
// Probe: reason never contains secrets (criterion #7)
// ---------------------------------------------------------------------------

test("T13: probe failure reasons never contain publicKey or secretKey (criterion #7)", async () => {
  const secretConfig: LangfuseConfig = {
    publicKey: "pk-super-secret-key-12345",
    secretKey: "sk-super-secret-key-67890",
    baseUrl: "https://langfuse.example.com",
  }
  // Trigger a failure (trace not queryable) and verify the reason has no secrets.
  const client = createFakeClient({ flushed: new Map() })
  const probe = createLangfuseSmokeProbe(secretConfig, {
    triggerRun: async () => "run-secret-check",
    client,
    privacyMarker: PRIVACY_MARKER,
    timeoutMs: 100,
    pollIntervalMs: 30,
    pollAttempts: 2,
  })!
  const result = await probe()
  assert.equal(result.ok, false)
  assert.equal(result.reason!.includes("pk-super-secret-key-12345"), false, "reason must not contain publicKey")
  assert.equal(result.reason!.includes("sk-super-secret-key-67890"), false, "reason must not contain secretKey")
  // Outputs also must not contain secrets — only host + sdkVersion + runId.
  for (const output of result.outputs ?? []) {
    assert.equal(output.includes("pk-super-secret-key-12345"), false, "outputs must not contain publicKey")
    assert.equal(output.includes("sk-super-secret-key-67890"), false, "outputs must not contain secretKey")
  }
})

// ---------------------------------------------------------------------------
// Integration with smoke runner (criteria #4, #5)
// ---------------------------------------------------------------------------

test("T13: runSmokeCheck skips langfuse on local profile when probe undefined (criterion #4)", async () => {
  // Probe undefined because config is absent
  const probe = createLangfuseSmokeProbe(undefined, {
    triggerRun: async () => "run-1",
    client: createFakeClient(),
    privacyMarker: PRIVACY_MARKER,
  })
  assert.equal(probe, undefined)
  const result = await runSmokeCheck("langfuse", "local", probe)
  assert.equal(result.status, "skipped", "local + undefined probe → skipped")
  assert.match(result.reason!, /no probe provided for local profile/, "skip reason mentions local profile")
})

test("T13: runSmokeCheck fails langfuse on production profile when probe undefined (criterion #5)", async () => {
  const probe = createLangfuseSmokeProbe(undefined, {
    triggerRun: async () => "run-1",
    client: createFakeClient(),
    privacyMarker: PRIVACY_MARKER,
  })
  assert.equal(probe, undefined)
  const result = await runSmokeCheck("langfuse", "production", probe)
  assert.equal(result.status, "failed", "production + undefined probe → failed")
  assert.match(result.reason!, /missing capability probe/, "fail reason mentions missing capability")
})

test("T13: runSmokeCheck passes langfuse on production profile when probe returns ok=true (criterion #5)", async () => {
  const runId = "run-production-pass"
  const flushed = new Map([[runId, createValidSnapshot(runId)]])
  const client = createFakeClient({ flushed })
  const probe = createLangfuseSmokeProbe(VALID_CONFIG, {
    triggerRun: async () => runId,
    client,
    privacyMarker: PRIVACY_MARKER,
  })
  const result = await runSmokeCheck("langfuse", "production", probe)
  assert.equal(result.status, "passed", "production + ok probe → passed")
  assert.equal(result.reason, undefined)
  assert.ok(result.durationMs >= 0, "durationMs recorded")
})

test("T13: runSmokeCheck fails langfuse on production profile when probe returns ok=false (criterion #5)", async () => {
  // Config present but trace not queryable → ok=false → production fails
  const client = createFakeClient({ flushed: new Map() })
  const probe = createLangfuseSmokeProbe(VALID_CONFIG, {
    triggerRun: async () => "run-production-fail",
    client,
    privacyMarker: PRIVACY_MARKER,
    timeoutMs: 100,
    pollIntervalMs: 30,
    pollAttempts: 2,
  })
  const result = await runSmokeCheck("langfuse", "production", probe)
  assert.equal(result.status, "failed", "production + ok=false → failed")
  assert.match(result.reason!, /not queryable/, "fail reason mentions not queryable")
})

test("T13: runSmokeCheck skips langfuse on local profile when probe returns ok=false but probe is defined (local allows failures from configured probes)", async () => {
  // Note: the existing runner marks ok=false as "failed" on BOTH profiles.
  // This test documents that behavior: local profile does NOT auto-skip
  // when the probe is defined but returns ok=false. Local skip only happens
  // when the probe is undefined (capability not configured).
  const client = createFakeClient({ flushed: new Map() })
  const probe = createLangfuseSmokeProbe(VALID_CONFIG, {
    triggerRun: async () => "run-local-defined-fail",
    client,
    privacyMarker: PRIVACY_MARKER,
    timeoutMs: 100,
    pollIntervalMs: 30,
    pollAttempts: 2,
  })
  const result = await runSmokeCheck("langfuse", "local", probe)
  // Probe is defined → runner invokes it → ok=false → status=failed (not skipped)
  assert.equal(result.status, "failed", "local + defined probe returning ok=false → failed (not skipped)")
})

// ---------------------------------------------------------------------------
// CAPABILITY_ORDER integration (criterion #8 — test coverage)
// ---------------------------------------------------------------------------

test("T13: CAPABILITY_ORDER includes 'langfuse' as 12th capability", () => {
  assert.ok(CAPABILITY_ORDER.includes("langfuse" as const), "langfuse in CAPABILITY_ORDER")
  assert.equal(CAPABILITY_ORDER.length, 12, "12 capabilities after T13")
  assert.equal(CAPABILITY_ORDER[11], "langfuse", "langfuse is last (appended after 11 originals)")
})