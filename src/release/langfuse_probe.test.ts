// Ticket 26 — Langfuse trace round-trip probe tests.
//
// TDD red phase: defines the expected behavior of langfuseRoundTripProbe
// BEFORE the implementation exists. Tests cover all 3 acceptance criteria:
//   #1 — A configured run creates and retrieves the expected trace identity
//        and safe event metadata.
//   #2 — Partial credentials, endpoint outage, timeout, and client failure
//        produce explicit optional-observability outcomes.
//   #3 — Prompts, answers, tokens, credentials, tenant-private content, and
//        authorization data are absent from persisted reports.
//
// Plus isolation + sanitization + bounded-outputs + cancellation + error-path
// tests.
//
// Candidate-mode (OP-05 unsatisfied): the real Langfuse SDK + service are
// not provisioned. The probe uses an in-memory recording LangfuseClient
// (implements trace() + fetchTrace()) so the RealLangfuseExporter is
// exercised end-to-end against the recorded trace. When OP-05 is lifted,
// the fixture's client swaps to a real `langfuse` npm client wrapping the
// Langfuse REST API for fetchTrace — probe code is production code exercised
// end-to-end. Same candidate-mode pattern as T19/T20/T24/T25.

import assert from "node:assert/strict"
import test from "node:test"

import { langfuseRoundTripProbe, type LangfuseRoundTripProbeFixture } from "./langfuse_probe"
import type { ProbeContext } from "./smoke_harness"
import type { LangfuseConfig } from "../answer/langfuse_exporter"
import type { AnswerRunEvent } from "../types"

const REVISION = "abc123def4567890abcdef1234567890abcdef12"
const PRIVACY_MARKER = "LANGFUSE_PROBE_PRIVACY_MARKER_xyz789"
const EXPECTED_RUN_ID = "probe-run-happy-001"
const VALID_CONFIG: LangfuseConfig = {
  publicKey: "pk-test-probe",
  secretKey: "sk-test-probe",
  baseUrl: "https://langfuse.probe.example.com",
}

// Note: the probe uses its own internal RecordingLangfuseClient (see
// langfuse_probe.ts). Tests inject behavior via fixture hooks
// (happyPathFetchAlwaysUndefined, happyPathFetchThrow, happyPathTraceThrow)
// rather than constructing their own client — single source of truth,
// no divergent duplicates (code-review Standards finding #3).

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

function mkEvent(
  runId: string,
  sequence: number,
  overrides: Record<string, unknown> & { type?: string },
): AnswerRunEvent {
  return {
    schemaVersion: 1 as const,
    sessionId: "session-probe",
    runId,
    eventId: `${runId}:${sequence}`,
    sequence,
    createdAt: new Date(Date.now() + sequence * 10).toISOString(),
    stage: "route" as const,
    status: "running" as const,
    durationMs: null,
    attempt: 1,
    round: 0,
    inputSummary: "",
    outputSummary: "",
    ...overrides,
  } as unknown as AnswerRunEvent
}

function makeHappyPathEvents(): AnswerRunEvent[] {
  // Privacy marker is intentionally placed inside the answer_delta token —
  // RealLangfuseExporter must NOT export raw answer tokens, so the marker
  // must be absent from the resulting trace snapshot.
  return [
    mkEvent(EXPECTED_RUN_ID, 1, {
      type: "progress", stage: "route", status: "running",
    }),
    mkEvent(EXPECTED_RUN_ID, 2, {
      type: "progress", stage: "route", status: "completed", durationMs: 42,
      data: { decision: "complex", queryCount: 1 },
    }),
    mkEvent(EXPECTED_RUN_ID, 3, {
      type: "progress", stage: "retrieval", status: "running",
    }),
    mkEvent(EXPECTED_RUN_ID, 4, {
      type: "progress", stage: "retrieval", status: "completed", durationMs: 100,
      data: { resultCount: 3, selectedEvidenceIds: ["e1", "e2", "e3"] },
    }),
    mkEvent(EXPECTED_RUN_ID, 5, {
      type: "progress", stage: "validation", status: "running",
    }),
    mkEvent(EXPECTED_RUN_ID, 6, {
      type: "progress", stage: "validation", status: "completed", durationMs: 5,
      data: { passed: true, round: 1 },
    }),
    mkEvent(EXPECTED_RUN_ID, 7, {
      type: "answer_delta", stage: "answer", token: `answer with ${PRIVACY_MARKER} embedded`,
    }),
    mkEvent(EXPECTED_RUN_ID, 8, {
      type: "done", stage: "done", status: "completed",
      result: {
        schemaVersion: 1,
        runId: EXPECTED_RUN_ID,
        status: "completed",
        reply: `final answer with ${PRIVACY_MARKER} should not leak`,
        references: [{ id: "e1", title: "Evidence 1" }],
        degradation: { status: "none", unavailableChannels: [] },
        usage: { promptTokens: 100, completionTokens: 50 },
      },
    }),
  ] as AnswerRunEvent[]
}

// ---------------------------------------------------------------------------
// Fixture + context helpers
// ---------------------------------------------------------------------------

function makeBasicFixture(): LangfuseRoundTripProbeFixture {
  return {
    revision: REVISION,
    config: VALID_CONFIG,
    events: makeHappyPathEvents(),
    expectedRunId: EXPECTED_RUN_ID,
    expectedSpans: ["route", "retrieval", "validation"],
    privacyMarker: PRIVACY_MARKER,
  }
}

function makeProbeContext(
  fixture: LangfuseRoundTripProbeFixture,
  signal?: AbortSignal,
): ProbeContext {
  return {
    signal: signal ?? new AbortController().signal,
    deadlineMs: 30_000,
    fixture,
  }
}

// ============================================================
// #1 — Configured run creates and retrieves expected trace
//      identity and safe event metadata (AC1)
// ============================================================

test("Ticket 26 #1a: probe returns ok=true with a trace snapshot for the configured run", async () => {
  const result = await langfuseRoundTripProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true, `probe must succeed; reason: ${result.reason ?? "n/a"}`)
  const outputs = result.outputs ?? {}
  assert.equal(outputs.traceFound, true, "trace must be retrieved via fetchTrace")
})

test("Ticket 26 #1b: probe verifies snapshot.id equals expectedRunId (trace identity)", async () => {
  const result = await langfuseRoundTripProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true)
  const outputs = result.outputs ?? {}
  const traceIdentity = outputs.traceIdentity as { id: string; name: string; sessionId: string }
  assert.deepEqual(traceIdentity.id, EXPECTED_RUN_ID)
  assert.equal(traceIdentity.name, "answer-run")
  assert.equal(traceIdentity.sessionId, "session-probe")
})

test("Ticket 26 #1c: probe verifies snapshot contains all expected spans", async () => {
  const result = await langfuseRoundTripProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true)
  const outputs = result.outputs ?? {}
  const spanNames = outputs.spanNames as string[]
  assert.ok(Array.isArray(spanNames), "spanNames must be an array")
  for (const expected of ["route", "retrieval", "validation"]) {
    assert.ok(
      spanNames.includes(expected),
      `expected span '${expected}' missing; got: ${JSON.stringify(spanNames)}`,
    )
  }
})

test("Ticket 26 #1d: probe verifies snapshot contains at least one generation (answer observation)", async () => {
  const result = await langfuseRoundTripProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true)
  const outputs = result.outputs ?? {}
  const generationCount = outputs.generationCount as number
  assert.equal(typeof generationCount, "number")
  assert.ok(generationCount > 0, "generationCount must be > 0 (answer generation present)")
})

test("Ticket 26 #1e: probe verifies snapshot.metadata carries terminalStatus (safe event metadata)", async () => {
  const result = await langfuseRoundTripProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true)
  const outputs = result.outputs ?? {}
  const traceMetadata = outputs.traceMetadata as Record<string, unknown>
  assert.ok(traceMetadata, "traceMetadata must be present")
  assert.equal(traceMetadata.terminalStatus, "completed")
})

test("Ticket 26 #1f: probe records host identity + SDK version in outputs (no secrets)", async () => {
  const result = await langfuseRoundTripProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true)
  const outputs = result.outputs ?? {}
  assert.equal(outputs.host, VALID_CONFIG.baseUrl, "host identity must match config.baseUrl")
  assert.equal(typeof outputs.sdkVersion, "string")
})

// ============================================================
// #2 — Partial credentials, endpoint outage, timeout, and
//      client failure produce explicit optional-observability
//      outcomes (AC2)
// ============================================================

test("Ticket 26 #2a: partialCredentials produces explicit failure (composition-time error caught)", async () => {
  const result = await langfuseRoundTripProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true, "happy path must succeed for failure-mode aggregation")
  const outputs = result.outputs ?? {}
  const failureModes = outputs.failureModes as Record<string, string>
  assert.equal(
    failureModes.partialCredentials,
    "passed",
    `partialCredentials must produce explicit failure; got: ${JSON.stringify(failureModes)}`,
  )
  const failureErrors = outputs.failureErrors as Record<string, string>
  assert.ok(failureErrors.partialCredentials, "partialCredentials must have error message")
  assert.match(
    failureErrors.partialCredentials,
    /partial|secretKey|publicKey|missing/i,
    `partialCredentials error must mention the missing credential; got: ${failureErrors.partialCredentials}`,
  )
})

test("Ticket 26 #2b: endpointOutage produces explicit failure (fetchTrace throws)", async () => {
  const result = await langfuseRoundTripProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true)
  const outputs = result.outputs ?? {}
  const failureModes = outputs.failureModes as Record<string, string>
  assert.equal(
    failureModes.endpointOutage,
    "passed",
    `endpointOutage must produce explicit failure; got: ${JSON.stringify(failureModes)}`,
  )
  const failureErrors = outputs.failureErrors as Record<string, string>
  assert.match(
    failureErrors.endpointOutage,
    /outage|unreachable|fetch|network|throw/i,
    `endpointOutage error must mention service outage; got: ${failureErrors.endpointOutage}`,
  )
})

test("Ticket 26 #2c: timeout produces explicit failure (fetchTrace returns undefined within bounded poll)", async () => {
  const result = await langfuseRoundTripProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true)
  const outputs = result.outputs ?? {}
  const failureModes = outputs.failureModes as Record<string, string>
  assert.equal(
    failureModes.timeout,
    "passed",
    `timeout must produce explicit failure; got: ${JSON.stringify(failureModes)}`,
  )
  const failureErrors = outputs.failureErrors as Record<string, string>
  assert.match(
    failureErrors.timeout,
    /timeout|not queryable|undefined|poll|bounded/i,
    `timeout error must mention bounded timeout; got: ${failureErrors.timeout}`,
  )
})

test("Ticket 26 #2d: clientFailure produces explicit failure (client.trace throws during export)", async () => {
  const result = await langfuseRoundTripProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true)
  const outputs = result.outputs ?? {}
  const failureModes = outputs.failureModes as Record<string, string>
  assert.equal(
    failureModes.clientFailure,
    "passed",
    `clientFailure must produce explicit failure; got: ${JSON.stringify(failureModes)}`,
  )
  const failureErrors = outputs.failureErrors as Record<string, string>
  assert.match(
    failureErrors.clientFailure,
    /client|trace|throw|dropped|export/i,
    `clientFailure error must mention client failure; got: ${failureErrors.clientFailure}`,
  )
})

test("Ticket 26 #2e: probe aggregates all 4 failure modes — allFailuresPassed=true", async () => {
  const result = await langfuseRoundTripProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true)
  const outputs = result.outputs ?? {}
  const failureModes = outputs.failureModes as Record<string, string>
  assert.equal(Object.keys(failureModes).length, 4, "must have exactly 4 failure modes")
  for (const [mode, status] of Object.entries(failureModes)) {
    assert.equal(status, "passed", `failure mode '${mode}' must be 'passed', got '${status}'`)
  }
  assert.equal(outputs.allFailuresPassed, true, "allFailuresPassed must be true")
})

// ============================================================
// #3 — Prompts, answers, tokens, credentials, tenant-private
//      content, and authorization data are absent from persisted
//      reports (AC3)
// ============================================================

test("Ticket 26 #3a: privacyMarker appears in event input but NOT in serialized trace snapshot", async () => {
  // Verify the marker is genuinely in the input events
  const fixture = makeBasicFixture()
  const inputJson = JSON.stringify(fixture.events)
  assert.ok(
    inputJson.includes(PRIVACY_MARKER),
    "privacyMarker must be present in input events (otherwise test is vacuous)",
  )

  const result = await langfuseRoundTripProbe(makeProbeContext(fixture))
  assert.equal(result.ok, true)
  const outputs = result.outputs ?? {}

  // Privacy check passed
  assert.equal(outputs.privacyCheck, "passed", "privacyCheck must be 'passed' when marker absent from snapshot")

  // The serialized outputs MUST NOT contain the privacy marker
  const outputsJson = JSON.stringify(outputs)
  assert.ok(
    !outputsJson.includes(PRIVACY_MARKER),
    `privacyMarker must NOT appear in probe outputs (would indicate raw answer/passage leak); got snippet containing marker`,
  )
})

test("Ticket 26 #3b: probe outputs do not contain credentials (publicKey/secretKey)", async () => {
  const result = await langfuseRoundTripProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true)
  const outputsJson = JSON.stringify(result.outputs)
  assert.ok(
    !outputsJson.includes(VALID_CONFIG.publicKey),
    "publicKey must NOT appear in probe outputs (credential leak)",
  )
  assert.ok(
    !outputsJson.includes(VALID_CONFIG.secretKey),
    "secretKey must NOT appear in probe outputs (credential leak)",
  )
})

test("Ticket 26 #3c: probe outputs do not contain raw prompts/answers/tokens", async () => {
  const result = await langfuseRoundTripProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true)
  const outputsJson = JSON.stringify(result.outputs)
  // Raw answer content phrases that appear in the events must NOT leak
  assert.ok(
    !outputsJson.includes("answer with"),
    "raw answer_delta token content must NOT appear in outputs (answer leak)",
  )
  assert.ok(
    !outputsJson.includes("final answer with"),
    "raw done.result.reply content must NOT appear in outputs (answer leak)",
  )
})

test("Ticket 26 #3d: probe outputs do not contain tenant-private content or authorization data", async () => {
  const result = await langfuseRoundTripProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true)
  const outputs = result.outputs ?? {}
  // Outputs must not include raw event payloads
  assert.equal(outputs.events, undefined, "events must NOT be in outputs (tenant-private content)")
  assert.equal(outputs.config, undefined, "config must NOT be in outputs (authorization data)")
  assert.equal(outputs.client, undefined, "client must NOT be in outputs (authorization data)")
})

// ============================================================
// #4 — Isolation: probe is verification-only, not registered in
//      DETERMINISTIC_PROBE_IMPLEMENTATIONS
// ============================================================

test("Ticket 26 #4: probe is not registered in DETERMINISTIC_PROBE_IMPLEMENTATIONS (verification-only)", async () => {
  // Dynamic import to avoid circular dependency at module load time
  const { DETERMINISTIC_PROBE_IMPLEMENTATIONS } = await import("./deterministic_probes")
  const registered = Object.keys(DETERMINISTIC_PROBE_IMPLEMENTATIONS ?? {})
  assert.ok(
    !registered.includes("langfuse"),
    `langfuse must NOT be in DETERMINISTIC_PROBE_IMPLEMENTATIONS (it's an optional-observability probe, not a deterministic gate); got: ${JSON.stringify(registered)}`,
  )
  assert.ok(
    !registered.includes("langfuseRoundTrip"),
    `langfuseRoundTrip must NOT be in DETERMINISTIC_PROBE_IMPLEMENTATIONS; got: ${JSON.stringify(registered)}`,
  )
})

// ============================================================
// #5 — Bounded outputs + safe metadata only
// ============================================================

test("Ticket 26 #5a: probe output failureErrors are bounded (each <= 512 chars)", async () => {
  const result = await langfuseRoundTripProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true)
  const outputs = result.outputs ?? {}
  const failureErrors = outputs.failureErrors as Record<string, string>
  for (const [mode, err] of Object.entries(failureErrors)) {
    assert.ok(
      typeof err === "string" && err.length <= 512,
      `failureErrors.${mode} must be a string <= 512 chars; got length ${err?.length}`,
    )
  }
})

test("Ticket 26 #5b: probe outputs contain only safe metadata fields (no raw event payloads)", async () => {
  const result = await langfuseRoundTripProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true)
  const outputs = result.outputs ?? {}
  // Allowed safe metadata keys (extended with failure-mode fields per AC2)
  const allowedKeys = new Set([
    "traceFound",
    "traceIdentity",
    "traceMetadata",
    "spanNames",
    "generationCount",
    "host",
    "sdkVersion",
    "privacyCheck",
    "failureModes",
    "failureErrors",
    "allFailuresPassed",
    "revision",
    "candidateMode",
    "droppedCount",
  ])
  for (const key of Object.keys(outputs)) {
    assert.ok(
      allowedKeys.has(key),
      `output key '${key}' is not in allowed safe-metadata set; allowed: ${[...allowedKeys].join(", ")}`,
    )
  }
})

// ============================================================
// #6 — Cancellation propagation
// ============================================================

test("Ticket 26 #6: pre-aborted signal returns ok=false immediately without invoking client", async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await langfuseRoundTripProbe(
    makeProbeContext(makeBasicFixture(), controller.signal),
  )
  assert.equal(result.ok, false, "probe must fail when signal is pre-aborted")
  assert.match(
    result.reason ?? "",
    /abort/i,
    `reason must mention abort; got: ${result.reason}`,
  )
  // Must not have produced any trace outputs (probe never ran)
  assert.equal(result.outputs, undefined, "no outputs when pre-aborted")
})

// ============================================================
// #7 — Error paths (what could go wrong — Karpathy diagnostic)
// ============================================================

test("Ticket 26 #7a: missing fixture returns ok=false with clear reason", async () => {
  const result = await langfuseRoundTripProbe({
    signal: new AbortController().signal,
    deadlineMs: 30_000,
    fixture: undefined,
  })
  assert.equal(result.ok, false)
  assert.match(result.reason ?? "", /missing fixture/i)
})

test("Ticket 26 #7b: missing revision returns ok=false with clear reason", async () => {
  const fixture = makeBasicFixture()
  fixture.revision = ""
  const result = await langfuseRoundTripProbe(makeProbeContext(fixture))
  assert.equal(result.ok, false)
  assert.match(result.reason ?? "", /revision/i)
})

test("Ticket 26 #7c: missing events array returns ok=false with clear reason", async () => {
  const fixture = makeBasicFixture()
  fixture.events = []
  const result = await langfuseRoundTripProbe(makeProbeContext(fixture))
  assert.equal(result.ok, false)
  assert.match(result.reason ?? "", /events/i)
})

test("Ticket 26 #7d: missing expectedRunId returns ok=false with clear reason", async () => {
  const fixture = makeBasicFixture()
  fixture.expectedRunId = ""
  const result = await langfuseRoundTripProbe(makeProbeContext(fixture))
  assert.equal(result.ok, false)
  assert.match(result.reason ?? "", /expectedRunId/i)
})

test("Ticket 26 #7e: missing privacyMarker returns ok=false (cannot verify privacy without marker)", async () => {
  const fixture = makeBasicFixture()
  fixture.privacyMarker = ""
  const result = await langfuseRoundTripProbe(makeProbeContext(fixture))
  assert.equal(result.ok, false)
  assert.match(
    result.reason ?? "",
    /privacyMarker/i,
    `reason must mention privacyMarker; got: ${result.reason}`,
  )
})

test("Ticket 26 #7f: missing config returns ok=false with clear reason", async () => {
  const fixture = makeBasicFixture()
  // Use type assertion to test missing-config error path
  delete (fixture as { config?: unknown }).config
  const result = await langfuseRoundTripProbe(makeProbeContext(fixture))
  assert.equal(result.ok, false)
  assert.match(result.reason ?? "", /config/i)
})

// ============================================================
// #8 — Probe verification semantics: AC3 precondition (privacyMarker
//      must appear in inputs — otherwise AC3 is vacuously satisfied)
// ============================================================

test("Ticket 26 #8: probe rejects fixture where privacyMarker is absent from events (AC3 vacuous-truth guard)", async () => {
  // Construct a fixture where the privacy marker is NOT in events. The probe
  // MUST reject this — otherwise privacyCheck="passed" would prove nothing
  // about RealLangfuseExporter's privacy defaults (marker absent from
  // snapshot simply because it was never in the inputs).
  const fixture = makeBasicFixture()
  fixture.privacyMarker = "MARKER_NOT_IN_INPUTS_xyz999"
  const result = await langfuseRoundTripProbe(makeProbeContext(fixture))
  assert.equal(result.ok, false, "probe must reject fixture with privacyMarker absent from events")
  assert.match(
    result.reason ?? "",
    /must appear in fixture\.events|vacuously/i,
    `reason must mention vacuous-truth guard; got: ${result.reason}`,
  )
})

// ============================================================
// #8b — Happy-path error hooks (happyPathFetchThrow / happyPathTraceThrow)
// ============================================================

test("Ticket 26 #8b: happyPathFetchThrow causes probe to return ok=false with endpoint-outage reason", async () => {
  const fixture = makeBasicFixture()
  fixture.happyPathFetchThrow = new Error("simulated endpoint outage: fetchTrace threw")
  const result = await langfuseRoundTripProbe(makeProbeContext(fixture))
  assert.equal(result.ok, false, "probe must fail when happy-path fetchTrace always throws")
  assert.match(
    result.reason ?? "",
    /not.*retrievable|not queryable|fetchTrace|timeout|outage/i,
    `reason must mention retrieval failure; got: ${result.reason}`,
  )
  const outputs = result.outputs ?? {}
  assert.equal(outputs.traceFound, false, "traceFound must be false when fetchTrace always throws")
  // Failure modes should still be aggregated
  assert.ok(outputs.failureModes, "failureModes must be aggregated even when happy-path fails")
})

test("Ticket 26 #8c: happyPathTraceThrow causes probe to report ok=false with droppedCount > 0", async () => {
  const fixture = makeBasicFixture()
  fixture.happyPathTraceThrow = new Error("simulated client SDK failure: trace() threw")
  const result = await langfuseRoundTripProbe(makeProbeContext(fixture))
  assert.equal(result.ok, false, "probe must fail when happy-path client.trace() always throws")
  const outputs = result.outputs ?? {}
  assert.equal(outputs.traceFound, false, "traceFound must be false when trace() throws")
  assert.ok(
    (outputs.droppedCount as number) > 0,
    `droppedCount must be > 0 (events dropped due to client failure); got ${outputs.droppedCount}`,
  )
})

test("Ticket 26 #9: candidateMode=true is recorded in outputs (OP-05 unsatisfied)", async () => {
  const result = await langfuseRoundTripProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true)
  const outputs = result.outputs ?? {}
  assert.equal(outputs.candidateMode, true, "candidateMode must be true (OP-05 unsatisfied)")
})

test("Ticket 26 #10: revision is recorded in outputs (provenance binding)", async () => {
  const result = await langfuseRoundTripProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true)
  const outputs = result.outputs ?? {}
  assert.equal(outputs.revision, REVISION, "revision must be recorded for provenance binding")
})

// ============================================================
// #11 — Failure path: trace not found (happy path fetchTrace returns undefined)
// ============================================================

test("Ticket 26 #11: probe returns ok=false with explicit reason when happy-path trace is not retrievable", async () => {
  // Construct a fixture where the happy-path client's fetchTrace always
  // returns undefined (simulates eventual-consistency timeout — trace
  // never becomes queryable). The probe must report ok=false with an
  // explicit reason mentioning the bounded poll, and still aggregate the
  // 4 failure modes.
  const fixture = makeBasicFixture()
  // Trigger happy-path fetchTrace always-undefined behavior
  fixture.happyPathFetchAlwaysUndefined = true

  const result = await langfuseRoundTripProbe(makeProbeContext(fixture))
  assert.equal(result.ok, false, "probe must fail when happy-path trace is not retrievable")
  assert.match(
    result.reason ?? "",
    /not.*retrievable|not queryable|fetchTrace|timeout|undefined/i,
    `reason must mention trace retrieval failure; got: ${result.reason}`,
  )
  const outputs = result.outputs ?? {}
  assert.equal(outputs.traceFound, false, "traceFound must be false")
  // Failure modes should still be aggregated (probe continues to failure scenarios)
  const failureModes = outputs.failureModes as Record<string, string> | undefined
  assert.ok(failureModes, "failureModes must be aggregated even if happy path fails")
})

// ============================================================
// #12 — Bounded duration: probe completes within deadlineMs
// ============================================================

test("Ticket 26 #12: probe completes within deadlineMs (bounded duration)", async () => {
  const start = Date.now()
  const result = await langfuseRoundTripProbe(makeProbeContext(makeBasicFixture()))
  const elapsed = Date.now() - start
  assert.equal(result.ok, true)
  assert.ok(
    elapsed < 5_000,
    `probe must complete within bounded duration; took ${elapsed}ms (deadline 30s, but probe must be much faster)`,
  )
  assert.ok(
    typeof result.durationMs === "number" && result.durationMs > 0,
    "durationMs must be a positive number",
  )
})
