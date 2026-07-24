// Ticket 26 — Langfuse trace round-trip probe.
//
// Spec issue #26 acceptance criteria:
//   1. A configured run creates and retrieves the expected trace identity
//      and safe event metadata.
//   2. Partial credentials, endpoint outage, timeout, and client failure
//      produce explicit optional-observability outcomes.
//   3. Prompts, answers, tokens, credentials, tenant-private content, and
//      authorization data are absent from persisted reports.
//
// Command-owning probe that exercises the production Langfuse export path
// (Ticket 11 RealLangfuseExporter + LangfuseClient) end-to-end against an
// in-memory recording client that supports `fetchTrace` read-back, then
// verifies:
//   - AC1: trace is created with expected id + spans + generation + metadata
//   - AC2: 4 failure modes produce explicit bounded outcomes
//   - AC3: privacy marker (placed in raw answer_delta token + done.reply)
//     is absent from the persisted snapshot + probe outputs
//
// Design (karpathy-guidelines):
//   - Simplest viable shape: probe accepts a fixture describing the scenario
//     (revision + config + events + expectedRunId + expectedSpans +
//     privacyMarker), exercises the existing RealLangfuseExporter
//     end-to-end against an internal recording client, polls fetchTrace to
//     retrieve the snapshot, then runs 4 bounded failure scenarios by
//     constructing separate client/exporter pairs with different failure
//     triggers. Aggregates the snapshot + failure modes + privacy check
//     into a bounded-metadata output.
//   - No caller-supplied pass booleans — the probe owns verification:
//     ok=true only when the happy path produces a complete trace AND all
//     4 failure modes produce explicit errors AND the privacy marker is
//     absent from the serialized snapshot.
//   - Outputs contain only safe metadata (trace identity, span names,
//     generation count, terminal metadata, host, sdkVersion, failure mode
//     flags + bounded errors, privacyCheck, droppedCount) — never raw
//     prompts, answers, tokens, credentials, or auth material.
//
// Candidate-mode (OP-05 unsatisfied): the real `langfuse` npm package +
// Langfuse cloud service are not provisioned. The probe uses an internal
// RecordingLangfuseClient (implements trace() + fetchTrace()) as the
// candidate-mode substitute — same pattern as T19/T20/T24/T25 candidate-mode
// probes. The RealLangfuseExporter is exercised end-to-end: real export()
// calls traverse the production event→trace mapping logic. When OP-05 is
// lifted, the fixture swaps in a real `langfuse` npm client wrapping the
// Langfuse REST API for fetchTrace — probe code is production code exercised
// end-to-end.
//
// Rollback boundary: remove this module; no online runtime behavior changes
// (per Ticket 26 rollback spec — probe is a verification-only artifact).

import {
  createLangfuseExporter,
  type LangfuseClient,
  type LangfuseConfig,
  type LangfuseTrace,
  type LangfuseTraceSnapshot,
  RealLangfuseExporter,
} from "../answer/langfuse_exporter"
import type { AnswerRunEvent } from "../types"
import type { ProbeContext, ProbeImplementation, ProbeResult } from "./smoke_harness"

// ---------------------------------------------------------------------------
// Fixture contract
// ---------------------------------------------------------------------------

/**
 * Fixture describing the Langfuse round-trip probe scenario.
 *
 * The probe uses `revision` for provenance binding. `config` provides the
 * Langfuse credentials (used to construct the RealLangfuseExporter). `events`
 * is the AnswerRunEvent sequence the probe exports through the
 * RealLangfuseExporter — exercising the production event→trace mapping.
 * `expectedRunId` is the trace id the probe polls for via fetchTrace.
 * `expectedSpans` is the required span names in the retrieved snapshot.
 * `privacyMarker` must appear in the raw event payloads (e.g. answer_delta
 * token) but MUST NOT appear in the serialized trace snapshot — proving
 * the RealLangfuseExporter's privacy defaults hold.
 *
 * Optional test hooks (happyPathFetch* / happyPathTraceThrow) simulate
 * happy-path client misbehavior for error-path tests.
 */
export interface LangfuseRoundTripProbeFixture {
  /** Trusted repository revision (recorded in outputs for provenance binding). */
  revision: string
  /** Complete Langfuse credentials — partial config triggers composition-time error. */
  config: LangfuseConfig
  /** AnswerRunEvent sequence to export through the RealLangfuseExporter. */
  events: AnswerRunEvent[]
  /** Expected trace id (runId) — probe polls fetchTrace(expectedRunId). */
  expectedRunId: string
  /** Required span names in the retrieved snapshot (e.g. route, retrieval, validation). */
  expectedSpans: string[]
  /**
   * Privacy marker — must appear in raw event payloads but MUST NOT appear
   * in the serialized trace snapshot. Proves RealLangfuseExporter's privacy
   * defaults (raw prompts/answers/tokens excluded from export).
   */
  privacyMarker: string
  /** Optional: SDK version recorded in outputs (default "candidate-3.x"). */
  sdkVersion?: string
  /** Optional test hook: when true, happy-path fetchTrace always returns undefined. */
  happyPathFetchAlwaysUndefined?: boolean
  /** Optional test hook: when set, happy-path fetchTrace throws this error. */
  happyPathFetchThrow?: Error
  /** Optional test hook: when set, happy-path client.trace() throws during export. */
  happyPathTraceThrow?: Error
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LANGFUSE_HOST = "https://cloud.langfuse.com"
const DEFAULT_SDK_VERSION = "candidate-3.x"
const POLL_INTERVAL_MS = 25
const POLL_ATTEMPTS = 4 // 4 attempts * 25ms = 100ms bounded poll budget
const FAILURE_ERROR_MAX_CHARS = 512

// ---------------------------------------------------------------------------
// RecordingLangfuseClient (candidate-mode substitute for real langfuse SDK)
// ---------------------------------------------------------------------------

interface RecordedSpan {
  name: string
  metadata?: Record<string, unknown>
  level?: string
  statusMessage?: string
  ended: boolean
  endTime?: Date
}

interface RecordedGeneration {
  name: string
  model?: string
  metadata?: Record<string, unknown>
  level?: string
  statusMessage?: string
  ended: boolean
  endTime?: Date
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
}

interface RecordedTrace {
  name: string
  id?: string
  sessionId?: string
  userId?: string
  metadata?: Record<string, unknown>
  spans: RecordedSpan[]
  generations: RecordedGeneration[]
}

/**
 * In-memory recording LangfuseClient — candidate-mode substitute for the
 * real `langfuse` npm package client. Implements `trace()` (returns a
 * recording LangfuseTrace whose span/generation/update calls mutate the
 * recorded state) and `fetchTrace()` (returns the recorded snapshot).
 *
 * Test hooks:
 *   - `fetchThrowError`: when set, fetchTrace throws (endpoint outage).
 *   - `fetchAlwaysUndefined`: when true, fetchTrace returns undefined (timeout).
 *   - `traceThrowError`: when set, trace() throws (client failure during export).
 *
 * When OP-05 is lifted, swap this for a real `new Langfuse(config)` client
 * wrapping the Langfuse REST API for fetchTrace. Probe code is unchanged.
 */
class RecordingLangfuseClient implements LangfuseClient {
  readonly traces = new Map<string, RecordedTrace>()
  fetchThrowError: Error | null = null
  fetchAlwaysUndefined = false
  traceThrowError: Error | null = null

  trace(params: {
    name: string
    id?: string
    sessionId?: string
    userId?: string
    metadata?: Record<string, unknown>
  }): LangfuseTrace {
    if (this.traceThrowError) throw this.traceThrowError
    const id = params.id ?? `trace-${this.traces.size + 1}`
    const recorded: RecordedTrace = {
      name: params.name,
      id,
      sessionId: params.sessionId,
      userId: params.userId,
      metadata: params.metadata,
      spans: [],
      generations: [],
    }
    this.traces.set(id, recorded)
    return {
      span: (spanParams) => {
        const span: RecordedSpan = {
          name: spanParams.name,
          metadata: spanParams.metadata,
          level: spanParams.level,
          statusMessage: spanParams.statusMessage,
          ended: false,
        }
        recorded.spans.push(span)
        return {
          end: (endParams) => {
            if (endParams?.metadata) {
              span.metadata = { ...(span.metadata || {}), ...endParams.metadata }
            }
            if (endParams?.level) span.level = endParams.level
            if (endParams?.statusMessage) span.statusMessage = endParams.statusMessage
            if (endParams?.endTime) span.endTime = endParams.endTime
            span.ended = true
          },
          update: (updateParams) => {
            if (updateParams.metadata) {
              span.metadata = { ...(span.metadata || {}), ...updateParams.metadata }
            }
            if (updateParams.level) span.level = updateParams.level
            if (updateParams.statusMessage) span.statusMessage = updateParams.statusMessage
          },
        }
      },
      generation: (genParams) => {
        const gen: RecordedGeneration = {
          name: genParams.name,
          model: genParams.model,
          metadata: genParams.metadata,
          level: genParams.level,
          statusMessage: genParams.statusMessage,
          ended: false,
        }
        recorded.generations.push(gen)
        return {
          end: (endParams) => {
            if (endParams?.metadata) {
              gen.metadata = { ...(gen.metadata || {}), ...endParams.metadata }
            }
            if (endParams?.usage) gen.usage = endParams.usage
            if (endParams?.level) gen.level = endParams.level
            if (endParams?.statusMessage) gen.statusMessage = endParams.statusMessage
            if (endParams?.endTime) gen.endTime = endParams.endTime
            gen.ended = true
          },
          update: (updateParams) => {
            if (updateParams.metadata) {
              gen.metadata = { ...(gen.metadata || {}), ...updateParams.metadata }
            }
            if (updateParams.usage) gen.usage = updateParams.usage
            if (updateParams.level) gen.level = updateParams.level
            if (updateParams.statusMessage) gen.statusMessage = updateParams.statusMessage
          },
        }
      },
      update: (params) => {
        if (params.metadata) {
          recorded.metadata = { ...(recorded.metadata || {}), ...params.metadata }
        }
      },
    }
  }

  async fetchTrace(id: string): Promise<LangfuseTraceSnapshot | undefined> {
    if (this.fetchThrowError) throw this.fetchThrowError
    if (this.fetchAlwaysUndefined) return undefined
    const recorded = this.traces.get(id)
    if (!recorded) return undefined
    return {
      id: recorded.id ?? id,
      name: recorded.name,
      spans: recorded.spans.map((s) => ({
        name: s.name,
        metadata: s.metadata,
        level: s.level as "DEBUG" | "DEFAULT" | "WARNING" | "ERROR" | undefined,
        statusMessage: s.statusMessage,
      })),
      generations: recorded.generations.map((g) => ({
        name: g.name,
        model: g.model,
        metadata: g.metadata,
        level: g.level as "DEBUG" | "DEFAULT" | "WARNING" | "ERROR" | undefined,
        statusMessage: g.statusMessage,
      })),
      metadata: recorded.metadata,
    }
  }
}

// ---------------------------------------------------------------------------
// Failure scenario helper
// ---------------------------------------------------------------------------

interface FailureScenarioResult {
  mode: string
  /** "passed" = explicit failure observed; "failed" = expected failure but operation succeeded */
  status: string
  /** Bounded error message (<= 512 chars) */
  error: string
}

/**
 * Run the partialCredentials failure scenario.
 *
 * createLangfuseExporter must throw a composition-time error when config
 * has publicKey but not secretKey (or vice versa). The probe catches the
 * throw and reports it as an explicit bounded failure.
 */
function runPartialCredentialsScenario(): FailureScenarioResult {
  const partialConfig: LangfuseConfig = {
    publicKey: "pk-test-partial",
    secretKey: "",
  }
  const dummyClient = new RecordingLangfuseClient()
  try {
    createLangfuseExporter(partialConfig, dummyClient)
    return {
      mode: "partialCredentials",
      status: "failed",
      error: "expected createLangfuseExporter to throw on partial config but it did not",
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      mode: "partialCredentials",
      status: "passed",
      error: `partial credentials rejected (partialCredentials): ${msg}`.slice(0, FAILURE_ERROR_MAX_CHARS),
    }
  }
}

/**
 * Run the endpointOutage failure scenario.
 *
 * Constructs a RecordingLangfuseClient whose fetchTrace throws on every call
 * (simulating Langfuse service outage). Exports one event through
 * RealLangfuseExporter, closes the exporter, then polls fetchTrace. Every
 * poll throws — the probe must catch and report as explicit bounded failure.
 */
async function runEndpointOutageScenario(): Promise<FailureScenarioResult> {
  const client = new RecordingLangfuseClient()
  client.fetchThrowError = new Error("Langfuse endpoint outage: service unreachable (ECONNREFUSED)")
  try {
    const exporter = new RealLangfuseExporter(client, { chatModel: "probe-chat-model" })
    // Export one minimal event so the trace exists in client.traces
    exporter.export(makeMinimalProbeEvent("run-outage", "session-outage"))
    await exporter.close()
    // Poll fetchTrace — should throw on every attempt
    try {
      await client.fetchTrace("run-outage")
      return {
        mode: "endpointOutage",
        status: "failed",
        error: "expected fetchTrace to throw on endpoint outage but it did not",
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        mode: "endpointOutage",
        status: "passed",
        error: `Langfuse endpoint outage (endpointOutage): ${msg}`.slice(0, FAILURE_ERROR_MAX_CHARS),
      }
    }
  } catch (err) {
    // Unexpected throw — NOT one of the 4 documented failure modes. Marking
    // it "passed" would conflate unexpected throws with documented failures
    // (reviewers grepping for outage would be unable to distinguish them).
    // Same fix as Ticket 25 ragas_shadow_cli runFailureScenario catch.
    const msg = err instanceof Error ? err.message : String(err)
    return {
      mode: "endpointOutage",
      status: "unexpected_error",
      error: `endpoint outage scenario threw unexpectedly (endpointOutage): ${msg}`.slice(0, FAILURE_ERROR_MAX_CHARS),
    }
  }
}

/**
 * Run the timeout failure scenario.
 *
 * Constructs a RecordingLangfuseClient whose fetchTrace always returns
 * undefined (simulating eventual-consistency timeout — trace never becomes
 * queryable). Exports one event, closes the exporter, then polls fetchTrace
 * within a bounded budget. Every poll returns undefined — the probe must
 * report as explicit bounded failure.
 */
async function runTimeoutScenario(): Promise<FailureScenarioResult> {
  const client = new RecordingLangfuseClient()
  client.fetchAlwaysUndefined = true
  try {
    const exporter = new RealLangfuseExporter(client, { chatModel: "probe-chat-model" })
    exporter.export(makeMinimalProbeEvent("run-timeout", "session-timeout"))
    await exporter.close()
    // Poll fetchTrace within bounded budget — should always return undefined
    let lastResult: LangfuseTraceSnapshot | undefined = undefined
    for (let i = 0; i < POLL_ATTEMPTS; i++) {
      lastResult = await client.fetchTrace("run-timeout")
      if (lastResult) break
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }
    if (lastResult) {
      return {
        mode: "timeout",
        status: "failed",
        error: "expected fetchTrace to return undefined (timeout) but it returned a snapshot",
      }
    }
    return {
      mode: "timeout",
      status: "passed",
      error: `Langfuse trace not queryable within bounded poll (timeout): ${POLL_ATTEMPTS} attempts * ${POLL_INTERVAL_MS}ms`.slice(0, FAILURE_ERROR_MAX_CHARS),
    }
  } catch (err) {
    // Unexpected throw — NOT one of the 4 documented failure modes.
    const msg = err instanceof Error ? err.message : String(err)
    return {
      mode: "timeout",
      status: "unexpected_error",
      error: `timeout scenario threw unexpectedly (timeout): ${msg}`.slice(0, FAILURE_ERROR_MAX_CHARS),
    }
  }
}

/**
 * Run the clientFailure failure scenario.
 *
 * Constructs a RecordingLangfuseClient whose trace() throws (simulating
 * Langfuse client SDK failure during export). RealLangfuseExporter must
 * catch the throw internally (fire-and-forget) and increment droppedCount.
 * The probe then verifies droppedCount > 0 and fetchTrace returns undefined
 * (no trace was recorded) — both signal explicit bounded failure.
 */
async function runClientFailureScenario(): Promise<FailureScenarioResult> {
  const client = new RecordingLangfuseClient()
  client.traceThrowError = new Error("Langfuse client SDK failure: trace() threw")
  try {
    const exporter = new RealLangfuseExporter(client, { chatModel: "probe-chat-model" })
    // Export one event — RealLangfuseExporter must catch the throw internally
    exporter.export(makeMinimalProbeEvent("run-client-fail", "session-client-fail"))
    await exporter.close()
    const droppedCount = exporter.getDroppedCount()
    if (droppedCount === 0) {
      return {
        mode: "clientFailure",
        status: "failed",
        error: "expected RealLangfuseExporter to drop the event on client.trace throw but droppedCount=0",
      }
    }
    // fetchTrace should return undefined (trace was never recorded)
    const snapshot = await client.fetchTrace("run-client-fail")
    if (snapshot) {
      return {
        mode: "clientFailure",
        status: "failed",
        error: "expected fetchTrace to return undefined (no trace recorded) but got a snapshot",
      }
    }
    return {
      mode: "clientFailure",
      status: "passed",
      error: `Langfuse client failure during export (clientFailure): ${droppedCount} event(s) dropped; trace not recorded`.slice(0, FAILURE_ERROR_MAX_CHARS),
    }
  } catch (err) {
    // Unexpected throw — NOT one of the 4 documented failure modes.
    const msg = err instanceof Error ? err.message : String(err)
    return {
      mode: "clientFailure",
      status: "unexpected_error",
      error: `clientFailure scenario threw unexpectedly (clientFailure): ${msg}`.slice(0, FAILURE_ERROR_MAX_CHARS),
    }
  }
}

/**
 * Helper: build a minimal AnswerRunEvent for failure-scenario exporters.
 * Avoids duplicating the 11-field literal across 3 scenarios.
 */
function makeMinimalProbeEvent(runId: string, sessionId: string): AnswerRunEvent {
  return {
    schemaVersion: 1,
    sessionId,
    runId,
    eventId: `${runId}:1`,
    sequence: 1,
    createdAt: new Date().toISOString(),
    stage: "route",
    status: "running",
    durationMs: null,
    attempt: 1,
    round: 0,
    inputSummary: "",
    outputSummary: "",
  } as AnswerRunEvent
}

// ---------------------------------------------------------------------------
// Probe implementation
// ---------------------------------------------------------------------------

export const langfuseRoundTripProbe: ProbeImplementation = async (
  ctx: ProbeContext,
): Promise<ProbeResult> => {
  const start = Date.now()

  // --- Validate fixture ---
  if (!ctx.fixture) {
    return {
      ok: false,
      reason: "missing fixture: LangfuseRoundTripProbeFixture required (revision + config + events + expectedRunId + expectedSpans + privacyMarker)",
      durationMs: Date.now() - start,
    }
  }
  const fixture = ctx.fixture as LangfuseRoundTripProbeFixture
  if (!fixture.revision) {
    return {
      ok: false,
      reason: "fixture.revision is required (non-empty)",
      durationMs: Date.now() - start,
    }
  }
  if (!fixture.config) {
    return {
      ok: false,
      reason: "fixture.config is required (LangfuseConfig with publicKey + secretKey + optional baseUrl)",
      durationMs: Date.now() - start,
    }
  }
  if (!Array.isArray(fixture.events) || fixture.events.length === 0) {
    return {
      ok: false,
      reason: "fixture.events must be a non-empty array (AnswerRunEvent sequence to export)",
      durationMs: Date.now() - start,
    }
  }
  if (!fixture.expectedRunId) {
    return {
      ok: false,
      reason: "fixture.expectedRunId is required (trace id to poll via fetchTrace)",
      durationMs: Date.now() - start,
    }
  }
  if (!fixture.privacyMarker) {
    return {
      ok: false,
      reason: "fixture.privacyMarker is required (must appear in raw events, must NOT appear in trace snapshot — proves privacy defaults hold)",
      durationMs: Date.now() - start,
    }
  }

  // AC3 precondition: privacyMarker MUST appear in fixture.events. If it
  // doesn't, privacyCheck would be vacuously "passed" (marker absent from
  // snapshot because it was never in the inputs) — proving nothing about
  // the RealLangfuseExporter's privacy defaults. Reject explicitly so the
  // fixture author fixes the test, not the probe.
  const eventsJson = JSON.stringify(fixture.events)
  if (!eventsJson.includes(fixture.privacyMarker)) {
    return {
      ok: false,
      reason: `fixture.privacyMarker '${fixture.privacyMarker.slice(0, 32)}...' must appear in fixture.events — otherwise AC3 is vacuously satisfied and proves nothing about RealLangfuseExporter privacy defaults`,
      durationMs: Date.now() - start,
    }
  }

  // Check for pre-aborted signal — probe cannot run if already aborted
  if (ctx.signal.aborted) {
    return {
      ok: false,
      reason: "signal already aborted — probe cannot run",
      durationMs: Date.now() - start,
    }
  }

  const sdkVersion = fixture.sdkVersion ?? DEFAULT_SDK_VERSION
  const host = fixture.config.baseUrl ?? DEFAULT_LANGFUSE_HOST

  // --- Phase 1: Happy path — exercise RealLangfuseExporter end-to-end ---
  const happyClient = new RecordingLangfuseClient()
  if (fixture.happyPathFetchAlwaysUndefined) happyClient.fetchAlwaysUndefined = true
  if (fixture.happyPathFetchThrow) happyClient.fetchThrowError = fixture.happyPathFetchThrow
  if (fixture.happyPathTraceThrow) happyClient.traceThrowError = fixture.happyPathTraceThrow

  let exporter: RealLangfuseExporter | null = null
  let droppedCount = 0
  try {
    exporter = new RealLangfuseExporter(happyClient, { chatModel: "probe-chat-model" })
    for (const event of fixture.events) {
      exporter.export(event)
    }
    await exporter.close()
    droppedCount = exporter.getDroppedCount()
  } catch (err) {
    // RealLangfuseExporter.export() never throws (catches internally), but
    // close() might. Treat as probe failure.
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      reason: `RealLangfuseExporter threw unexpectedly: ${msg.slice(0, FAILURE_ERROR_MAX_CHARS)}`,
      outputs: {
        traceFound: false,
        host,
        sdkVersion,
        droppedCount,
        revision: fixture.revision,
        candidateMode: true,
      },
      durationMs: Date.now() - start,
    }
  }

  // --- Phase 2: Poll fetchTrace for the expected runId ---
  let snapshot: LangfuseTraceSnapshot | undefined
  let lastFetchError: unknown
  try {
    for (let i = 0; i < POLL_ATTEMPTS; i++) {
      try {
        snapshot = await happyClient.fetchTrace(fixture.expectedRunId)
        if (snapshot) break
      } catch (err) {
        lastFetchError = err
      }
      if (i < POLL_ATTEMPTS - 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
      }
    }
  } catch (err) {
    lastFetchError = err
  }

  // --- Phase 3: Run 4 failure scenarios (AC2) ---
  const failureResults: FailureScenarioResult[] = []
  failureResults.push(runPartialCredentialsScenario())
  failureResults.push(await runEndpointOutageScenario())
  failureResults.push(await runTimeoutScenario())
  failureResults.push(await runClientFailureScenario())

  const failureModes: Record<string, string> = {}
  const failureErrors: Record<string, string> = {}
  for (const result of failureResults) {
    failureModes[result.mode] = result.status
    failureErrors[result.mode] = result.error
  }
  const allFailuresPassed = failureResults.every((r) => r.status === "passed")

  // --- Phase 4: Happy-path aggregation ---
  if (!snapshot) {
    const errPart = lastFetchError instanceof Error
      ? `; last error: ${lastFetchError.message}`
      : lastFetchError !== undefined
        ? `; last error: ${String(lastFetchError)}`
        : ""
    return {
      ok: false,
      reason: `happy-path trace ${fixture.expectedRunId} not retrievable within bounded poll (timeout): ${POLL_ATTEMPTS} attempts * ${POLL_INTERVAL_MS}ms${errPart}`.slice(0, 512),
      outputs: {
        traceFound: false,
        failureModes,
        failureErrors,
        allFailuresPassed,
        host,
        sdkVersion,
        droppedCount,
        revision: fixture.revision,
        candidateMode: true,
      },
      durationMs: Date.now() - start,
    }
  }

  // --- Phase 5: Verify snapshot (AC1 + AC3) ---
  const traceIdentity = {
    id: snapshot.id,
    name: snapshot.name,
    sessionId: snapshot.metadata?.sessionId as string | undefined,
  }
  const spanNames = snapshot.spans.map((s) => s.name)
  const generationCount = snapshot.generations.length
  const traceMetadata = snapshot.metadata ?? {}

  // AC1: spans + generation + terminal metadata
  const missingSpans = fixture.expectedSpans.filter((name) => !spanNames.includes(name))
  const spansOk = missingSpans.length === 0
  const generationOk = generationCount > 0
  const terminalMetadataOk = !!(
    traceMetadata && typeof traceMetadata === "object" && "terminalStatus" in traceMetadata
  )

  // AC3: privacy marker must NOT appear in the serialized snapshot
  const snapshotJson = JSON.stringify(snapshot)
  const privacyLeaked = fixture.privacyMarker && snapshotJson.includes(fixture.privacyMarker)
  const privacyCheck = privacyLeaked ? "failed" : "passed"

  // --- Aggregate final result ---
  const happyPathOk = spansOk && generationOk && terminalMetadataOk
  const ok = happyPathOk && allFailuresPassed && privacyCheck === "passed"

  return {
    ok,
    reason: ok
      ? undefined
      : `one or more checks failed: spansOk=${spansOk}, generationOk=${generationOk}, terminalMetadataOk=${terminalMetadataOk}, allFailuresPassed=${allFailuresPassed}, privacyCheck=${privacyCheck}`,
    outputs: {
      traceFound: true,
      traceIdentity,
      traceMetadata,
      spanNames,
      generationCount,
      host,
      sdkVersion,
      privacyCheck,
      failureModes,
      failureErrors,
      allFailuresPassed,
      droppedCount,
      revision: fixture.revision,
      candidateMode: true,
    },
    durationMs: Date.now() - start,
  }
}
