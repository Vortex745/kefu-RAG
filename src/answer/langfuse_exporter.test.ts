import assert from "node:assert/strict"
import test from "node:test"
import {
  NoopLangfuseExporter,
  RealLangfuseExporter,
  createLangfuseExporter,
  type LangfuseClient,
  type LangfuseConfig,
  type LangfuseExporter,
  type LangfuseGeneration,
  type LangfuseSpan,
  type LangfuseTrace,
} from "./langfuse_exporter"
import type { AnswerRunEvent } from "../types"

test("NoopLangfuseExporter export is a no-op", async () => {
  const exporter: LangfuseExporter = new NoopLangfuseExporter()
  // Noop exporter must not inspect event shape — any AnswerRunEvent is accepted.
  const event = {
    type: "progress",
    schemaVersion: 1 as const,
    sessionId: "s",
    runId: "r",
    eventId: "r:1",
    sequence: 1,
    createdAt: new Date().toISOString(),
    stage: "route" as const,
    status: "running" as const,
    durationMs: null,
    attempt: 1,
    round: 0,
    inputSummary: "",
    outputSummary: "",
  } as AnswerRunEvent
  assert.doesNotThrow(() => exporter.export(event))
})

// ---------------------------------------------------------------------------
// T11 — Fake Langfuse client + event helpers (criterion #8)
// ---------------------------------------------------------------------------

interface RecordedSpan {
  name: string
  startTime?: Date
  endTime?: Date
  metadata?: Record<string, unknown>
  level?: string
  statusMessage?: string
  ended: boolean
  updates: Array<Record<string, unknown>>
}

interface RecordedGeneration {
  name: string
  startTime?: Date
  endTime?: Date
  model?: string
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
  metadata?: Record<string, unknown>
  level?: string
  statusMessage?: string
  ended: boolean
  updates: Array<Record<string, unknown>>
}

interface RecordedTrace {
  name: string
  id?: string
  sessionId?: string
  userId?: string
  metadata?: Record<string, unknown>
  spans: RecordedSpan[]
  generations: RecordedGeneration[]
  updates: Array<{ metadata?: Record<string, unknown>; level?: string; statusMessage?: string }>
}

class FakeLangfuseClient implements LangfuseClient {
  traces: RecordedTrace[] = []
  trace(params: { name: string; id?: string; sessionId?: string; userId?: string; metadata?: Record<string, unknown> }): LangfuseTrace {
    const recorded: RecordedTrace = { ...params, spans: [], generations: [], updates: [] }
    this.traces.push(recorded)
    return {
      span(spanParams) {
        const span: RecordedSpan = { ...spanParams, ended: false, updates: [] }
        recorded.spans.push(span)
        return {
          end(endParams) {
            // Realistic merge: metadata is merged, other fields overwritten.
            if (endParams?.metadata) {
              span.metadata = { ...(span.metadata || {}), ...endParams.metadata }
            }
            Object.assign(span, endParams)
            span.ended = true
          },
          update(updateParams) {
            if (updateParams.metadata) {
              span.metadata = { ...(span.metadata || {}), ...updateParams.metadata }
            }
            span.updates.push(updateParams)
          },
        }
      },
      generation(genParams) {
        const gen: RecordedGeneration = { ...genParams, ended: false, updates: [] }
        recorded.generations.push(gen)
        return {
          end(endParams) {
            if (endParams?.metadata) {
              gen.metadata = { ...(gen.metadata || {}), ...endParams.metadata }
            }
            Object.assign(gen, endParams)
            gen.ended = true
          },
          update(updateParams) {
            if (updateParams.metadata) {
              gen.metadata = { ...(gen.metadata || {}), ...updateParams.metadata }
            }
            gen.updates.push(updateParams)
          },
        }
      },
      update(params) {
        if (params.metadata) {
          recorded.metadata = { ...(recorded.metadata || {}), ...params.metadata }
        }
        recorded.updates.push(params)
      },
    }
  }
}

function mkEvent(runId: string, sequence: number, overrides: Partial<AnswerRunEvent> & { type?: string }): AnswerRunEvent {
  return {
    schemaVersion: 1 as const,
    sessionId: "session-1",
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
  } as AnswerRunEvent
}

// ---------------------------------------------------------------------------
// T11 — Factory tests (criteria #1, #2)
// ---------------------------------------------------------------------------

test("T11: createLangfuseExporter returns Noop when config is undefined", () => {
  const exporter = createLangfuseExporter(undefined, undefined)
  assert.ok(exporter instanceof NoopLangfuseExporter, "undefined config → Noop")
})

test("T11: createLangfuseExporter returns Noop when config fields are empty", () => {
  const config: LangfuseConfig = { publicKey: "", secretKey: "" }
  const exporter = createLangfuseExporter(config, undefined)
  assert.ok(exporter instanceof NoopLangfuseExporter, "empty config → Noop")
})

test("T11: createLangfuseExporter throws on partial config (publicKey without secretKey)", () => {
  const config: LangfuseConfig = { publicKey: "pk-xxx", secretKey: "" }
  assert.throws(
    () => createLangfuseExporter(config, undefined),
    /partial.*secretKey/i,
    "partial config must throw with clear message mentioning missing secretKey",
  )
})

test("T11: createLangfuseExporter throws on partial config (secretKey without publicKey)", () => {
  const config: LangfuseConfig = { publicKey: "", secretKey: "sk-xxx" }
  assert.throws(
    () => createLangfuseExporter(config, undefined),
    /partial.*publicKey/i,
    "partial config must throw with clear message mentioning missing publicKey",
  )
})

test("T11: createLangfuseExporter throws when config is complete but no client", () => {
  const config: LangfuseConfig = { publicKey: "pk-xxx", secretKey: "sk-xxx" }
  assert.throws(
    () => createLangfuseExporter(config, undefined),
    /no client was injected/i,
    "complete config without client must throw clear message",
  )
})

test("T11: createLangfuseExporter returns Real when config is complete + client provided", () => {
  const config: LangfuseConfig = { publicKey: "pk-xxx", secretKey: "sk-xxx" }
  const client = new FakeLangfuseClient()
  const exporter = createLangfuseExporter(config, client, { chatModel: "gpt-4o" })
  assert.ok(exporter instanceof RealLangfuseExporter, "complete config + client → Real")
})

// ---------------------------------------------------------------------------
// T11 — Mapping tests (criteria #3, #4)
// ---------------------------------------------------------------------------

test("T11: RealLangfuseExporter creates one trace per run with sessionId (criterion #3)", () => {
  const client = new FakeLangfuseClient()
  const exporter = new RealLangfuseExporter(client)
  exporter.export(mkEvent("run-1", 1, { type: "progress", stage: "route", status: "running" }))
  assert.equal(client.traces.length, 1, "one trace created for one run")
  assert.equal(client.traces[0].id, "run-1", "trace id = runId")
  assert.equal(client.traces[0].sessionId, "session-1", "trace sessionId = event sessionId")
  assert.equal(client.traces[0].name, "answer-run", "trace name = answer-run")
})

test("T11: RealLangfuseExporter maps route events to spans (criterion #4)", () => {
  const client = new FakeLangfuseClient()
  const exporter = new RealLangfuseExporter(client)
  // route running
  exporter.export(mkEvent("run-2", 1, {
    type: "progress", stage: "route", status: "running",
    data: { decision: "simple" },
  }))
  // route completed
  exporter.export(mkEvent("run-2", 2, {
    type: "progress", stage: "route", status: "completed", durationMs: 42,
    data: { decision: "simple", queryCount: 1 },
  }))
  const trace = client.traces[0]
  assert.equal(trace.spans.length, 1, "one span for route stage")
  assert.equal(trace.spans[0].name, "route", "span name = route")
  assert.ok(trace.spans[0].ended, "route span ended on completion")
  assert.equal(trace.spans[0].metadata?.decision, "simple", "span metadata carries safe route data")
})

test("T11: RealLangfuseExporter maps answer_delta to a generation (criterion #4)", () => {
  const client = new FakeLangfuseClient()
  const exporter = new RealLangfuseExporter(client, { chatModel: "gpt-4o" })
  exporter.export(mkEvent("run-3", 1, { type: "progress", stage: "route", status: "running" }))
  exporter.export(mkEvent("run-3", 2, { type: "answer_delta", stage: "answer", token: "Hello" }))
  exporter.export(mkEvent("run-3", 3, { type: "answer_delta", stage: "answer", token: " world" }))
  const trace = client.traces[0]
  assert.equal(trace.generations.length, 1, "one generation for answer stage")
  assert.equal(trace.generations[0].name, "answer", "generation name = answer")
  assert.equal(trace.generations[0].model, "gpt-4o", "generation model = chatModel")
  assert.equal(trace.generations[0].metadata?.tokenCount, 2, "token count accumulated")
})

test("T11: RealLangfuseExporter maps done event to trace finalization (criterion #4)", () => {
  const client = new FakeLangfuseClient()
  const exporter = new RealLangfuseExporter(client, { chatModel: "gpt-4o" })
  exporter.export(mkEvent("run-4", 1, { type: "progress", stage: "route", status: "running" }))
  exporter.export(mkEvent("run-4", 2, { type: "answer_delta", stage: "answer", token: "ok" }))
  exporter.export(mkEvent("run-4", 3, {
    type: "done", stage: "done",
    result: {
      runId: "run-4",
      status: "completed",
      reply: "the answer",
      references: [{ id: "ev-1" } as any],
      degradation: { status: "none", unavailableChannels: [] },
    },
  }))
  const trace = client.traces[0]
  assert.ok(trace.generations[0].ended, "generation ended on done")
  assert.equal(trace.generations[0].metadata?.terminalStatus, "completed", "generation carries terminalStatus")
  assert.equal(trace.generations[0].metadata?.replyLength, "the answer".length, "replyLength exported (not raw reply)")
  assert.equal(trace.generations[0].metadata?.referenceCount, 1, "referenceCount exported")
  assert.ok(trace.updates.length >= 1, "trace updated on done")
  const finalUpdate = trace.updates.at(-1)!
  assert.equal(finalUpdate.metadata?.terminalStatus, "completed", "trace carries terminalStatus")
  assert.equal(finalUpdate.metadata?.answerTokenCount, 1, "trace carries answerTokenCount")
})

test("T11: RealLangfuseExporter handles multiple concurrent runs (criterion #3)", () => {
  const client = new FakeLangfuseClient()
  const exporter = new RealLangfuseExporter(client)
  exporter.export(mkEvent("run-a", 1, { type: "progress", stage: "route", status: "running" }))
  exporter.export(mkEvent("run-b", 1, { type: "progress", stage: "route", status: "running" }))
  exporter.export(mkEvent("run-a", 2, {
    type: "done", stage: "done",
    result: { runId: "run-a", status: "completed", reply: "a", references: [], degradation: { status: "none", unavailableChannels: [] } },
  }))
  exporter.export(mkEvent("run-b", 2, {
    type: "done", stage: "done",
    result: { runId: "run-b", status: "completed", reply: "b", references: [], degradation: { status: "none", unavailableChannels: [] } },
  }))
  assert.equal(client.traces.length, 2, "two traces for two runs")
  assert.equal(client.traces[0].id, "run-a", "first trace = run-a")
  assert.equal(client.traces[1].id, "run-b", "second trace = run-b")
})

// ---------------------------------------------------------------------------
// T11 — Privacy tests (criteria #5, #6)
// ---------------------------------------------------------------------------

test("T11: RealLangfuseExporter excludes raw answer content (criterion #6)", () => {
  const client = new FakeLangfuseClient()
  const exporter = new RealLangfuseExporter(client)
  exporter.export(mkEvent("run-5", 1, { type: "progress", stage: "route", status: "running" }))
  exporter.export(mkEvent("run-5", 2, { type: "answer_delta", stage: "answer", token: "SECRET_ANSWER_CONTENT" }))
  exporter.export(mkEvent("run-5", 3, {
    type: "done", stage: "done",
    result: {
      runId: "run-5", status: "completed",
      reply: "FULL_SECRET_REPLY_WITH_PII",
      references: [],
      degradation: { status: "none", unavailableChannels: [] },
    },
  }))
  const traceJson = JSON.stringify(client.traces[0])
  assert.ok(!traceJson.includes("SECRET_ANSWER_CONTENT"), "raw answer_delta token must NOT appear in export")
  assert.ok(!traceJson.includes("FULL_SECRET_REPLY_WITH_PII"), "raw reply must NOT appear in export")
  assert.ok(traceJson.includes("replyLength"), "replyLength (safe metric) SHOULD appear")
})

test("T11: RealLangfuseExporter excludes retrieved passages, exports only safe metadata (criterion #5+#6)", () => {
  const client = new FakeLangfuseClient()
  const exporter = new RealLangfuseExporter(client)
  exporter.export(mkEvent("run-6", 1, { type: "progress", stage: "route", status: "running" }))
  exporter.export(mkEvent("run-6", 2, {
    type: "progress", stage: "retrieval", status: "completed", durationMs: 50,
    data: {
      resultCount: 3,
      selectedEvidenceIds: ["ev-1", "ev-2", "ev-3"],
      channelStatuses: { vector: "completed", bm25: "completed" },
    },
  }))
  const trace = client.traces[0]
  const retrievalSpan = trace.spans.find((s) => s.name === "retrieval")!
  assert.ok(retrievalSpan, "retrieval span exists")
  assert.equal(retrievalSpan.metadata?.resultCount, 3, "resultCount exported (safe count)")
  assert.deepEqual(retrievalSpan.metadata?.selectedEvidenceIds, ["ev-1", "ev-2", "ev-3"], "evidence IDs exported (safe identifiers)")
  // The retrieval span metadata should NOT contain raw passage content (it's not in the event data anyway,
  // but the whitelist ensures even if it were, it wouldn't be exported).
  assert.equal(retrievalSpan.metadata?.excerpt, undefined, "no raw excerpt field in metadata")
})

test("T11: RealLangfuseExporter exports degradation reasons (criterion #5)", () => {
  const client = new FakeLangfuseClient()
  const exporter = new RealLangfuseExporter(client)
  exporter.export(mkEvent("run-7", 1, { type: "progress", stage: "route", status: "running" }))
  exporter.export(mkEvent("run-7", 2, {
    type: "done", stage: "done",
    result: {
      runId: "run-7", status: "insufficient_evidence",
      reply: "", references: [],
      degradation: { status: "insufficient", unavailableChannels: ["graph"], reason: "no_results" },
    },
  }))
  const trace = client.traces[0]
  const finalUpdate = trace.updates.at(-1)!
  assert.equal(finalUpdate.metadata?.degradationStatus, "insufficient", "degradation status exported")
  assert.equal(finalUpdate.metadata?.degradationReason, "no_results", "degradation reason exported")
  assert.deepEqual(finalUpdate.metadata?.degradationUnavailableChannels, ["graph"], "unavailable channels exported")
  assert.equal(finalUpdate.level, "WARNING", "insufficient_evidence → WARNING level")
})

// ---------------------------------------------------------------------------
// T11 — Failure isolation tests (criterion #7)
// ---------------------------------------------------------------------------

test("T11: RealLangfuseExporter client.trace throwing does not throw from export (criterion #7)", () => {
  const throwingClient: LangfuseClient = {
    trace: () => { throw new Error("langfuse service down") },
  }
  const exporter = new RealLangfuseExporter(throwingClient)
  assert.doesNotThrow(() => {
    exporter.export(mkEvent("run-8", 1, { type: "progress", stage: "route", status: "running" }))
  }, "export must not throw even when client.trace throws")
})

test("T11: RealLangfuseExporter span.end throwing does not throw from export (criterion #7)", () => {
  const client: LangfuseClient = {
    trace: () => ({
      span: () => ({ end: () => { throw new Error("span end failed") }, update: () => {} }),
      generation: () => ({ end: () => {}, update: () => {} }),
      update: () => {},
    }),
  }
  const exporter = new RealLangfuseExporter(client)
  exporter.export(mkEvent("run-9", 1, { type: "progress", stage: "route", status: "running" }))
  assert.doesNotThrow(() => {
    exporter.export(mkEvent("run-9", 2, {
      type: "progress", stage: "route", status: "completed", durationMs: 10,
      data: { decision: "simple" },
    }))
  }, "export must not throw even when span.end throws")
})

test("T11: RealLangfuseExporter trace.update throwing does not throw from export (criterion #7)", () => {
  const client: LangfuseClient = {
    trace: () => ({
      span: () => ({ end: () => {}, update: () => {} }),
      generation: () => ({ end: () => {}, update: () => {} }),
      update: () => { throw new Error("trace update failed") },
    }),
  }
  const exporter = new RealLangfuseExporter(client)
  exporter.export(mkEvent("run-10", 1, { type: "progress", stage: "route", status: "running" }))
  assert.doesNotThrow(() => {
    exporter.export(mkEvent("run-10", 2, {
      type: "done", stage: "done",
      result: { runId: "run-10", status: "completed", reply: "ok", references: [], degradation: { status: "none", unavailableChannels: [] } },
    }))
  }, "export must not throw even when trace.update throws")
})

// ---------------------------------------------------------------------------
// T12 — Agentic span export tests (criteria #1, #2, #3)
// ---------------------------------------------------------------------------

test("T12: RealLangfuseExporter creates contextualization span on success (criterion #1)", () => {
  const client = new FakeLangfuseClient()
  const exporter = new RealLangfuseExporter(client)
  exporter.export(mkEvent("t12-ctx-1", 1, {
    type: "progress", stage: "route", status: "running",
    data: {
      contextualizationOutcome: "success",
      contextualizationUsage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      contextualizationDurationMs: 45,
    },
  }))
  const trace = client.traces[0]
  const ctxSpan = trace.spans.find((s) => s.name === "contextualization")
  assert.ok(ctxSpan, "contextualization span created on success outcome")
  assert.equal(ctxSpan!.metadata?.outcome, "success", "outcome metadata exported")
  assert.deepEqual(
    ctxSpan!.metadata?.usage,
    { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    "token usage exported on contextualization span"
  )
  assert.equal(ctxSpan!.metadata?.durationMs, 45, "duration exported on contextualization span")
  assert.equal(ctxSpan!.level, "DEFAULT", "success → DEFAULT level")
  assert.ok(ctxSpan!.ended, "contextualization span ended (bounded)")
})

test("T12: RealLangfuseExporter creates contextualization span on failure with WARNING level (criterion #1)", () => {
  const client = new FakeLangfuseClient()
  const exporter = new RealLangfuseExporter(client)
  exporter.export(mkEvent("t12-ctx-2", 1, {
    type: "progress", stage: "route", status: "running",
    data: {
      contextualizationOutcome: "failed",
      contextualizationFailure: "provider rejected",
      contextualizationDurationMs: 10,
    },
  }))
  const trace = client.traces[0]
  const ctxSpan = trace.spans.find((s) => s.name === "contextualization")
  assert.ok(ctxSpan, "contextualization span created on failed outcome")
  assert.equal(ctxSpan!.metadata?.outcome, "failed")
  assert.equal(ctxSpan!.metadata?.failure, "provider rejected", "failure reason exported")
  assert.equal(ctxSpan!.level, "WARNING", "failed → WARNING level")
  assert.equal(ctxSpan!.statusMessage, "contextualization failed")
})

test("T12: RealLangfuseExporter skips contextualization span when outcome is skipped (criterion #1)", () => {
  const client = new FakeLangfuseClient()
  const exporter = new RealLangfuseExporter(client)
  exporter.export(mkEvent("t12-ctx-3", 1, {
    type: "progress", stage: "route", status: "running",
    data: { contextualizationOutcome: "skipped" },
  }))
  const trace = client.traces[0]
  const ctxSpan = trace.spans.find((s) => s.name === "contextualization")
  assert.equal(ctxSpan, undefined, "no contextualization span when outcome is skipped")
  // Route span still created
  assert.ok(trace.spans.find((s) => s.name === "route"), "route span still created")
})

test("T12: RealLangfuseExporter creates summarization span on success (criterion #1)", () => {
  const client = new FakeLangfuseClient()
  const exporter = new RealLangfuseExporter(client)
  exporter.export(mkEvent("t12-sum-1", 1, { type: "progress", stage: "route", status: "running" }))
  exporter.export(mkEvent("t12-sum-1", 2, {
    type: "done", stage: "done",
    result: {
      runId: "t12-sum-1", status: "completed", reply: "ok", references: [],
      degradation: { status: "none", unavailableChannels: [] },
      summarizationOutcome: "success",
      summarizationUsage: { promptTokens: 500, completionTokens: 50, totalTokens: 550 },
      summarizationDurationMs: 120,
      summarizationCheckpoint: 42,
    },
  }))
  const trace = client.traces[0]
  const sumSpan = trace.spans.find((s) => s.name === "summarization")
  assert.ok(sumSpan, "summarization span created on success outcome")
  assert.equal(sumSpan!.metadata?.outcome, "success")
  assert.deepEqual(
    sumSpan!.metadata?.usage,
    { promptTokens: 500, completionTokens: 50, totalTokens: 550 },
    "token usage exported on summarization span"
  )
  assert.equal(sumSpan!.metadata?.durationMs, 120, "duration exported")
  assert.equal(sumSpan!.metadata?.checkpoint, 42, "checkpoint exported")
  assert.ok(sumSpan!.ended, "summarization span ended (bounded)")
  // Trace-level metadata also surfaces summarization outcome
  const finalUpdate = trace.updates.at(-1)!
  assert.equal(finalUpdate.metadata?.summarizationOutcome, "success", "trace-level outcome")
})

test("T12: RealLangfuseExporter creates summarization span on failure with WARNING level (criterion #1)", () => {
  const client = new FakeLangfuseClient()
  const exporter = new RealLangfuseExporter(client)
  exporter.export(mkEvent("t12-sum-2", 1, { type: "progress", stage: "route", status: "running" }))
  exporter.export(mkEvent("t12-sum-2", 2, {
    type: "done", stage: "done",
    result: {
      runId: "t12-sum-2", status: "completed", reply: "ok", references: [],
      degradation: { status: "none", unavailableChannels: [] },
      summarizationOutcome: "failed",
      summarizationDurationMs: 30,
    },
  }))
  const trace = client.traces[0]
  const sumSpan = trace.spans.find((s) => s.name === "summarization")
  assert.ok(sumSpan, "summarization span created on failed outcome")
  assert.equal(sumSpan!.level, "WARNING", "failed → WARNING level")
  assert.equal(sumSpan!.statusMessage, "summarization failed")
})

test("T12: RealLangfuseExporter skips summarization span when outcome is skipped (criterion #1)", () => {
  const client = new FakeLangfuseClient()
  const exporter = new RealLangfuseExporter(client)
  exporter.export(mkEvent("t12-sum-3", 1, { type: "progress", stage: "route", status: "running" }))
  exporter.export(mkEvent("t12-sum-3", 2, {
    type: "done", stage: "done",
    result: {
      runId: "t12-sum-3", status: "completed", reply: "ok", references: [],
      degradation: { status: "none", unavailableChannels: [] },
    },
  }))
  const trace = client.traces[0]
  const sumSpan = trace.spans.find((s) => s.name === "summarization")
  assert.equal(sumSpan, undefined, "no summarization span when outcome absent")
})

test("T12: RealLangfuseExporter exports compressionUsage on context span (criterion #2)", () => {
  const client = new FakeLangfuseClient()
  const exporter = new RealLangfuseExporter(client)
  exporter.export(mkEvent("t12-comp-1", 1, { type: "progress", stage: "route", status: "running" }))
  exporter.export(mkEvent("t12-comp-1", 2, {
    type: "progress", stage: "context", status: "completed", durationMs: 80,
    data: {
      evidenceCount: 5,
      contextLength: 1000,
      compressionRan: true,
      compressionInputTokens: 800,
      compressionOutputTokens: 300,
      compressionRetainedEvidenceIds: ["ev-1", "ev-2"],
      compressionDroppedEvidenceIds: ["ev-3"],
      compressionUsage: { promptTokens: 800, completionTokens: 300, totalTokens: 1100 },
    },
  }))
  const trace = client.traces[0]
  const ctxSpan = trace.spans.find((s) => s.name === "context")
  assert.ok(ctxSpan, "context span created")
  assert.equal(ctxSpan!.metadata?.compressionRan, true, "compressionRan exported")
  assert.equal(ctxSpan!.metadata?.compressionInputTokens, 800, "input tokens exported")
  assert.equal(ctxSpan!.metadata?.compressionOutputTokens, 300, "output tokens exported")
  assert.deepEqual(
    ctxSpan!.metadata?.compressionUsage,
    { promptTokens: 800, completionTokens: 300, totalTokens: 1100 },
    "compressionUsage (LLM token counts) exported (criterion #2)"
  )
  assert.deepEqual(
    ctxSpan!.metadata?.compressionRetainedEvidenceIds,
    ["ev-1", "ev-2"],
    "retained Evidence IDs exported (criterion #2 — no raw Evidence content)"
  )
  assert.deepEqual(
    ctxSpan!.metadata?.compressionDroppedEvidenceIds,
    ["ev-3"],
    "dropped Evidence IDs exported (criterion #2)"
  )
})

test("T12: RealLangfuseExporter exports complex-loop compression metadata on retrieval span (criterion #3)", () => {
  const client = new FakeLangfuseClient()
  const exporter = new RealLangfuseExporter(client)
  exporter.export(mkEvent("t12-loop-1", 1, { type: "progress", stage: "route", status: "running" }))
  exporter.export(mkEvent("t12-loop-1", 2, {
    type: "progress", stage: "retrieval", status: "completed", durationMs: 50,
    data: {
      complexLoop: true,
      iteration: 2,
      duplicate: false,
      fallback: false,
      selectedTool: "graph_navigation",
      toolInputSummary: "graph_navigation(q='test', seeds=3)",
      complexLoopCompressionRan: true,
      complexLoopCompressionInputTokens: 600,
      complexLoopCompressionOutputTokens: 200,
    },
  }))
  const trace = client.traces[0]
  const retSpan = trace.spans.find((s) => s.name === "retrieval")
  assert.ok(retSpan, "retrieval span created")
  assert.equal(retSpan!.metadata?.complexLoop, true, "complexLoop flag exported")
  assert.equal(retSpan!.metadata?.iteration, 2, "iteration index exported")
  assert.equal(retSpan!.metadata?.selectedTool, "graph_navigation", "selected tool exported")
  assert.equal(retSpan!.metadata?.toolInputSummary, "graph_navigation(q='test', seeds=3)", "tool input summary exported")
  assert.equal(retSpan!.metadata?.complexLoopCompressionRan, true, "compression ran flag exported (bug fix)")
  assert.equal(retSpan!.metadata?.complexLoopCompressionInputTokens, 600, "compression input tokens exported (bug fix)")
  assert.equal(retSpan!.metadata?.complexLoopCompressionOutputTokens, 200, "compression output tokens exported (bug fix)")
})

test("T12: RealLangfuseExporter exports complex-loop stop reason + tool fallback on route span (criterion #3)", () => {
  const client = new FakeLangfuseClient()
  const exporter = new RealLangfuseExporter(client)
  exporter.export(mkEvent("t12-loop-2", 1, { type: "progress", stage: "route", status: "running" }))
  exporter.export(mkEvent("t12-loop-2", 2, {
    type: "progress", stage: "route", status: "completed", durationMs: 200,
    data: {
      decision: "complex",
      complexLoopStopReason: "evidence-sufficient",
      complexLoopIterations: 3,
      complexLoopToolCalls: 4,
      selectedTool: "semantic_lexical_hybrid",
      toolFallbackReason: "no_tool_call",
    },
  }))
  const trace = client.traces[0]
  // Route span ends on the completed event — find the route span
  const routeSpan = trace.spans.find((s) => s.name === "route")
  assert.ok(routeSpan, "route span created")
  assert.equal(routeSpan!.metadata?.complexLoopStopReason, "evidence-sufficient", "stop reason exported (criterion #3)")
  assert.equal(routeSpan!.metadata?.complexLoopIterations, 3, "iteration count exported")
  assert.equal(routeSpan!.metadata?.complexLoopToolCalls, 4, "tool call count exported")
  assert.equal(routeSpan!.metadata?.selectedTool, "semantic_lexical_hybrid", "selected tool exported")
  assert.equal(routeSpan!.metadata?.toolFallbackReason, "no_tool_call", "fallback reason exported (criterion #3)")
})

// ---------------------------------------------------------------------------
// T12 — Bounded queue + drop policy tests (criteria #4, #5)
// ---------------------------------------------------------------------------

test("T12: RealLangfuseExporter enforces maxRuns bound — drops new runs when full (criterion #4)", () => {
  const client = new FakeLangfuseClient()
  const exporter = new RealLangfuseExporter(client, { maxRuns: 1 })
  // First run succeeds
  exporter.export(mkEvent("run-a", 1, { type: "progress", stage: "route", status: "running" }))
  assert.equal(client.traces.length, 1, "first run created")
  assert.equal(exporter.getDroppedCount(), 0, "no drops yet")
  // Second run is dropped (queue full — maxRuns=1)
  exporter.export(mkEvent("run-b", 1, { type: "progress", stage: "route", status: "running" }))
  assert.equal(client.traces.length, 1, "second run dropped (maxRuns=1)")
  assert.equal(exporter.getDroppedCount(), 1, "dropped count incremented")
  // Subsequent events for the first run still work (existing run, not a new one)
  exporter.export(mkEvent("run-a", 2, {
    type: "done", stage: "done",
    result: { runId: "run-a", status: "completed", reply: "ok", references: [], degradation: { status: "none", unavailableChannels: [] } },
  }))
  assert.equal(exporter.getDroppedCount(), 1, "existing run events not dropped")
})

test("T12: RealLangfuseExporter drops + counts + warns on sustained client failure (criterion #5)", () => {
  const throwingClient: LangfuseClient = {
    trace: () => { throw new Error("langfuse backend down") },
  }
  const exporter = new RealLangfuseExporter(throwingClient)
  // Capture console.warn to verify warning is recorded
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (msg: string) => { warnings.push(msg) }
  try {
    exporter.export(mkEvent("run-outage", 1, { type: "progress", stage: "route", status: "running" }))
    exporter.export(mkEvent("run-outage", 2, {
      type: "progress", stage: "route", status: "completed", durationMs: 10,
      data: { decision: "simple" },
    }))
  } finally {
    console.warn = originalWarn
  }
  assert.equal(exporter.getDroppedCount(), 2, "both events dropped + counted")
  assert.equal(warnings.length, 2, "warning recorded for each drop")
  assert.ok(warnings[0].includes("[langfuse]"), "warning has [langfuse] prefix")
  assert.ok(warnings[0].includes("total dropped: 1"), "warning includes running count")
  assert.ok(warnings[1].includes("total dropped: 2"), "warning includes updated count")
})

test("T12: RealLangfuseExporter default maxRuns is 100 (criterion #4 — production bound)", () => {
  const client = new FakeLangfuseClient()
  const exporter = new RealLangfuseExporter(client)
  // Export 100 runs — all should succeed
  for (let i = 0; i < 100; i++) {
    exporter.export(mkEvent(`run-${i}`, 1, { type: "progress", stage: "route", status: "running" }))
  }
  assert.equal(client.traces.length, 100, "100 runs created (default maxRuns)")
  assert.equal(exporter.getDroppedCount(), 0, "no drops at boundary")
  // 101st run is dropped
  exporter.export(mkEvent("run-overflow", 1, { type: "progress", stage: "route", status: "running" }))
  assert.equal(client.traces.length, 100, "101st run dropped")
  assert.equal(exporter.getDroppedCount(), 1, "overflow dropped + counted")
})

// ---------------------------------------------------------------------------
// T12 — Graceful shutdown flush + idempotent close tests (criteria #6, #7)
// ---------------------------------------------------------------------------

test("T12: RealLangfuseExporter.close() calls client.shutdownAsync when available (criterion #6)", async () => {
  let shutdownCalled = false
  let flushCalled = false
  const client: LangfuseClient = {
    trace: () => ({
      span: () => ({ end: () => {}, update: () => {} }),
      generation: () => ({ end: () => {}, update: () => {} }),
      update: () => {},
    }),
    flushAsync: async () => { flushCalled = true },
    shutdownAsync: async () => { shutdownCalled = true },
  }
  const exporter = new RealLangfuseExporter(client)
  await exporter.close()
  assert.equal(shutdownCalled, true, "shutdownAsync called (preferred over flushAsync)")
  assert.equal(flushCalled, false, "flushAsync NOT called when shutdownAsync is available")
})

test("T12: RealLangfuseExporter.close() falls back to flushAsync when shutdownAsync absent (criterion #6)", async () => {
  let flushCalled = false
  const client: LangfuseClient = {
    trace: () => ({
      span: () => ({ end: () => {}, update: () => {} }),
      generation: () => ({ end: () => {}, update: () => {} }),
      update: () => {},
    }),
    flushAsync: async () => { flushCalled = true },
  }
  const exporter = new RealLangfuseExporter(client)
  await exporter.close()
  assert.equal(flushCalled, true, "flushAsync called as fallback")
})

test("T12: RealLangfuseExporter.close() is no-op when neither flush nor shutdown available (criterion #6)", async () => {
  const client: LangfuseClient = {
    trace: () => ({
      span: () => ({ end: () => {}, update: () => {} }),
      generation: () => ({ end: () => {}, update: () => {} }),
      update: () => {},
    }),
  }
  const exporter = new RealLangfuseExporter(client)
  await exporter.close()
  // No assertion needed — just verify it doesn't throw
})

test("T12: RealLangfuseExporter.close() is idempotent — repeated calls return same promise (criterion #7)", async () => {
  let shutdownCount = 0
  const client: LangfuseClient = {
    trace: () => ({
      span: () => ({ end: () => {}, update: () => {} }),
      generation: () => ({ end: () => {}, update: () => {} }),
      update: () => {},
    }),
    shutdownAsync: async () => { shutdownCount++ },
  }
  const exporter = new RealLangfuseExporter(client)
  const p1 = exporter.close()
  const p2 = exporter.close()
  const p3 = exporter.close()
  assert.equal(p1, p2, "same promise returned (idempotent)")
  assert.equal(p2, p3, "same promise returned (idempotent)")
  await p1
  assert.equal(shutdownCount, 1, "shutdownAsync called only once despite 3 close() calls")
})

test("T12: RealLangfuseExporter.close() swallows client flush failure — shutdown must not fail (criterion #7)", async () => {
  const client: LangfuseClient = {
    trace: () => ({
      span: () => ({ end: () => {}, update: () => {} }),
      generation: () => ({ end: () => {}, update: () => {} }),
      update: () => {},
    }),
    shutdownAsync: async () => { throw new Error("flush timeout") },
  }
  const exporter = new RealLangfuseExporter(client)
  await exporter.close()
  // No assertion needed — close() must not throw even when shutdownAsync throws
})

test("T12: RealLangfuseExporter.close() clears run state but does not close shared resources (criterion #7)", async () => {
  const client = new FakeLangfuseClient()
  const exporter = new RealLangfuseExporter(client)
  exporter.export(mkEvent("run-close", 1, { type: "progress", stage: "route", status: "running" }))
  assert.equal(client.traces.length, 1, "trace created")
  await exporter.close()
  // After close, the exporter is still usable (doesn't throw) but run state is cleared
  assert.doesNotThrow(() => {
    exporter.export(mkEvent("run-after-close", 1, { type: "progress", stage: "route", status: "running" }))
  }, "exporter still usable after close (does not close shared resources)")
  assert.equal(client.traces.length, 2, "new trace created after close (shared resources intact)")
})

test("T12: NoopLangfuseExporter.close() is a no-op (criterion #6 — backward compat)", async () => {
  const exporter = new NoopLangfuseExporter()
  await exporter.close()
  // No assertion needed — just verify it doesn't throw and returns a promise
})
