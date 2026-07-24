/**
 * Ticket 05 — Chat/Answer event adapter compatibility tests.
 *
 * Verifies the transport adapter in `chat_event_adapter.ts`
 * preserves the 6 contracts mandated by the Ticket 05 spec:
 *   #1 Chat request fields + validation behavior
 *   #2 Answer event names + payload fields + ordering + run/session identity
 *   #3 SSE + complete JSON parity from one Answer event source
 *   #4 Historical replay compatibility for pre-Mastra runs
 *   #5 Client disconnect + AbortSignal cancellation → one cancelled terminal, no late answer
 *   #6 Duplicate runner invocation cannot publish the same answer twice
 *
 * Boundary: same as Tickets 01-04 — this test file lives in src/mastra/* and
 * MUST NOT be imported by src/answer/*, src/api/*, src/index.ts. It uses a
 * fake MastraRunner to exercise the adapter without the real @mastra/core
 * package (which is not installed per AGENTS.md dependency approval boundary).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createMastraChatEventAdapter,
  validateChatRequest,
  type MastraRunner,
  type MastraRunnerOutput,
} from "./chat_event_adapter";
import type { AnswerRunEvent, AnswerRunResult, AnswerTerminalStatus } from "../types";
import type { AnswerRunOptions } from "../answer/generation";
import { singleTenantAccessContext } from "../access/context";

// ---------------------------------------------------------------------------
// Fake MastraRunner — returns a controlled output for testing.
// ---------------------------------------------------------------------------

function makeFakeRunnerOutput(overrides: Partial<MastraRunnerOutput> = {}): MastraRunnerOutput {
  return {
    reply: "This is a test reply.",
    status: "completed",
    references: [],
    degradation: { status: "none", unavailableChannels: [] },
    tokens: ["Hello", ", ", "world", "!"],
    routeTrace: { decision: "simple" },
    retrievalTrace: { resultCount: 1 },
    contextTrace: { evidenceCount: 1, contextLength: 32 },
    validationTrace: { round: 1, passed: true },
    ...overrides,
  };
}

function makeFakeRunner(
  output: MastraRunnerOutput = makeFakeRunnerOutput(),
  hooks: { beforeCall?: () => void; afterCall?: () => void } = {}
): MastraRunner {
  return async (input) => {
    hooks.beforeCall?.();
    // Respect abort signal — mirrors what the real Mastra Agent would do.
    if (input.signal.aborted) {
      const err = new Error("Answer run cancelled at runner");
      err.name = "AbortError";
      throw err;
    }
    hooks.afterCall?.();
    return output;
  };
}

// ---------------------------------------------------------------------------
// Helper: collect all events from the adapter into an array.
// ---------------------------------------------------------------------------

async function collectEvents(
  source: ReturnType<typeof createMastraChatEventAdapter>,
  message: string,
  options: AnswerRunOptions = {}
): Promise<AnswerRunEvent[]> {
  const events: AnswerRunEvent[] = [];
  for await (const event of source(message, options)) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Criterion #1 — Preserve existing chat request fields and validation behavior.
// ---------------------------------------------------------------------------

test("T05 #1: validateChatRequest accepts a valid request", () => {
  const result = validateChatRequest({
    message: "hello",
    runId: "run-123",
    sessionId: "session-456",
  });
  assert.equal(result.message, "hello");
  assert.equal(result.runId, "run-123");
  assert.equal(result.sessionId, "session-456");
});

test("T05 #1: validateChatRequest rejects empty/whitespace message", () => {
  assert.throws(() => validateChatRequest({ message: "" }), /message is required/);
  assert.throws(() => validateChatRequest({ message: "   " }), /message is required/);
  assert.throws(() => validateChatRequest({ message: undefined as unknown as string }), /message is required/);
});

test("T05 #1: validateChatRequest falls back to uuid for missing/invalid runId/sessionId", () => {
  const result = validateChatRequest({ message: "hi" });
  assert.ok(result.runId, "runId should default to a uuid");
  assert.ok(result.sessionId, "sessionId should default to a uuid");
  assert.notEqual(result.runId, result.sessionId, "runId and sessionId should be distinct uuids");

  // Invalid format (contains spaces) should also fall back to uuid.
  const result2 = validateChatRequest({ message: "hi", runId: "has space", sessionId: "also space" });
  assert.notEqual(result2.runId, "has space");
  assert.notEqual(result2.sessionId, "also space");
});

test("T05 #1: adapter surfaces validation error when message is empty", async () => {
  const adapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(),
  });
  // The adapter generator should throw on the first iteration.
  await assert.rejects(
    async () => {
      for await (const _event of adapter("", {})) {
        // Should not emit any event.
      }
    },
    /message is required/
  );
});

// ---------------------------------------------------------------------------
// Criterion #2 — Preserve schema-versioned Answer event names, payload fields,
// ordering, run identity, and session identity.
// ---------------------------------------------------------------------------

test("T05 #2: adapter emits all 6 event types in T03 §3 gate order", async () => {
  const adapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(),
  });
  const events = await collectEvents(adapter, "test message");

  // Expected order: progress(route) → progress(retrieval) → progress(context) →
  //                 answer_delta* → progress(validation) → done
  const progressStages = events
    .filter((e) => e.type === "progress")
    .map((e) => e.stage);
  assert.deepEqual(
    progressStages,
    ["route", "retrieval", "context", "validation"],
    "progress events must be emitted in T03 §3 gate order"
  );

  // At least one answer_delta event.
  const answerDeltas = events.filter((e) => e.type === "answer_delta");
  assert.ok(answerDeltas.length >= 1, "must emit at least one answer_delta event");

  // Exactly one done event, and it must be the last event.
  const doneEvents = events.filter((e) => e.type === "done");
  assert.equal(doneEvents.length, 1, "must emit exactly one done event");
  assert.equal(events[events.length - 1].type, "done", "done must be the last event");
});

test("T05 #2: every event has schemaVersion=1 and required base fields", async () => {
  const adapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(),
  });
  const events = await collectEvents(adapter, "test message");

  for (const event of events) {
    assert.equal(event.schemaVersion, 1, "schemaVersion must be 1");
    assert.ok(event.runId, "runId must be present");
    assert.ok(event.sessionId, "sessionId must be present");
    assert.ok(event.eventId, "eventId must be present");
    assert.equal(typeof event.sequence, "number", "sequence must be a number");
    assert.equal(typeof event.createdAt, "string", "createdAt must be a string");
    assert.ok(["route", "retrieval", "context", "answer", "validation", "done"].includes(event.stage));
    assert.ok(["running", "completed", "degraded", "failed", "cancelled"].includes(event.status));
  }
});

test("P1 regression: event identity remains runId:sequence", async () => {
  const adapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(),
  });
  const runId = "run-deterministic-events";
  const events = await collectEvents(adapter, "test message", {
    runId,
    sessionId: "session-deterministic-events",
  });

  for (const event of events) {
    assert.equal(event.eventId, `${runId}:${event.sequence}`);
  }
});

test("P1 regression: invalid citation remains a failed run", async () => {
  const adapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(
      makeFakeRunnerOutput({
        status: "invalid_citation",
        reply: "",
        references: [],
        tokens: [],
      })
    ),
  });
  const events = await collectEvents(adapter, "test message");
  const terminal = events.at(-1);

  assert.equal(terminal?.type, "done");
  assert.equal(terminal?.status, "failed");
  if (terminal?.type === "done") {
    assert.equal(terminal.result.status, "invalid_citation");
  }
});

test("T05 #2: sequence is monotonically increasing across all events", async () => {
  const adapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(makeFakeRunnerOutput({ tokens: ["a", "b", "c", "d", "e"] })),
  });
  const events = await collectEvents(adapter, "test message");

  for (let i = 1; i < events.length; i++) {
    assert.ok(
      events[i].sequence > events[i - 1].sequence,
      `sequence must be monotonic: event ${i} seq=${events[i].sequence} <= event ${i - 1} seq=${events[i - 1].sequence}`
    );
  }
});

test("T05 #2: run identity + session identity preserved across all events", async () => {
  const adapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(),
  });
  const runId = "run-identity-test";
  const sessionId = "session-identity-test";
  const events = await collectEvents(adapter, "test message", { runId, sessionId });

  for (const event of events) {
    assert.equal(event.runId, runId, "all events must share the same runId");
    assert.equal(event.sessionId, sessionId, "all events must share the same sessionId");
  }
});

test("T05 #2: answer_delta events carry token field; done carries result", async () => {
  const adapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(),
  });
  const events = await collectEvents(adapter, "test message");

  const answerDeltas = events.filter((e) => e.type === "answer_delta");
  for (const delta of answerDeltas) {
    assert.equal(typeof delta.token, "string", "answer_delta must carry a string token");
    assert.ok(delta.token.length > 0, "token must be non-empty");
  }

  const done = events.find((e) => e.type === "done");
  assert.ok(done, "done event must exist");
  if (done.type === "done") {
    assert.ok(done.result, "done must carry result");
    assert.equal(done.result.status, "completed", "result.status must be completed");
    assert.equal(typeof done.result.reply, "string", "result.reply must be a string");
    assert.ok(Array.isArray(done.result.references), "result.references must be an array");
    assert.ok(done.result.degradation, "result.degradation must be present");
  }
});

// ---------------------------------------------------------------------------
// Criterion #3 — Preserve SSE and complete JSON parity from one Answer event source.
// ---------------------------------------------------------------------------

test("T05 #3: adapter output is SSE-encodable via streamPayload parity", async () => {
  // Mirrors src/api/chat.ts:16-29 streamPayload encoding.
  const adapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(),
  });
  const sessionId = "sse-parity-session";
  const events = await collectEvents(adapter, "test", { sessionId });

  for (const event of events) {
    // Every event must be JSON-serializable (SSE encodes as data: {json}\n\n).
    const payload = {
      sessionId,
      runId: event.runId,
      event,
      ...(event.type === "answer_delta" ? { token: event.token } : {}),
      ...(event.type === "done"
        ? {
            done: true,
            status: event.result.status,
            references: event.result.references,
            degradation: event.result.degradation,
          }
        : {}),
    };
    const json = JSON.stringify(payload);
    assert.ok(json.length > 0, "SSE payload must be JSON-serializable");
    // SSE frame format.
    const frame = `data: ${json}\n\n`;
    assert.ok(frame.startsWith("data: "), "SSE frame must start with 'data: '");
    assert.ok(frame.endsWith("\n\n"), "SSE frame must end with '\\n\\n'");
  }
});

test("T05 #3: adapter output is collectable into a complete JSON response", async () => {
  // Mirrors src/api/chat.ts:154-184 complete JSON path.
  const adapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(),
  });
  const runId = "json-parity-run";
  const sessionId = "json-parity-session";
  const events = await collectEvents(adapter, "test", { runId, sessionId });

  const terminal = events.find((e) => e.type === "done");
  assert.ok(terminal, "must have a terminal done event");
  if (terminal.type === "done") {
    const jsonResponse = {
      reply: terminal.result.reply,
      sessionId,
      runId: terminal.result.runId,
      status: terminal.result.status,
      references: terminal.result.references,
      degradation: terminal.result.degradation,
      events,
    };
    // Must be JSON-serializable.
    const json = JSON.stringify(jsonResponse);
    assert.ok(json.length > 0, "complete JSON response must be serializable");
    const parsed = JSON.parse(json);
    assert.equal(parsed.reply, terminal.result.reply);
    assert.equal(parsed.sessionId, sessionId);
    assert.equal(parsed.runId, runId);
    assert.equal(parsed.events.length, events.length);
  }
});

// ---------------------------------------------------------------------------
// Criterion #4 — Preserve historical replay compatibility for pre-Mastra runs.
// ---------------------------------------------------------------------------

test("T05 #4: adapter-emitted events have the same shape as pre-Mastra events", async () => {
  const adapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(),
  });
  const events = await collectEvents(adapter, "test");

  // Every event must satisfy the AnswerRunEventBase + AnswerRunEventPayload
  // contract — same shape as events emitted by the legacy runAnswer.
  for (const event of events) {
    assert.equal(event.schemaVersion, 1, "schemaVersion=1 matches pre-Mastra events");
    assert.ok(["progress", "answer_delta", "done"].includes(event.type));
    if (event.type === "progress") {
      assert.ok(["route", "retrieval", "context", "validation"].includes(event.stage));
      assert.equal(typeof event.message, "string");
    }
    if (event.type === "answer_delta") {
      assert.equal(event.stage, "answer");
      assert.equal(typeof event.token, "string");
    }
    if (event.type === "done") {
      assert.equal(event.stage, "done");
      assert.ok(event.result);
    }
  }
});

test("T05 #4: events are appendable to AnswerTraceRepository (idempotent INSERT)", async () => {
  // Mirrors the AnswerTraceRepository.append contract: INSERT OR IGNORE on
  // (run_id, event_id). Adapter events must be appendable without conflict.
  const adapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(),
  });
  const events = await collectEvents(adapter, "test");

  // Simulate the trace repository's idempotency check: no duplicate event_id
  // within the same run.
  const seenEventIds = new Set<string>();
  for (const event of events) {
    assert.ok(
      !seenEventIds.has(event.eventId),
      `duplicate eventId detected: ${event.eventId}`
    );
    seenEventIds.add(event.eventId);
  }
  // All events share the same runId — required for trace repository scoping.
  const runId = events[0].runId;
  for (const event of events) {
    assert.equal(event.runId, runId, "all events must share runId for trace append");
  }
});

// ---------------------------------------------------------------------------
// Criterion #5 — Client disconnect + AbortSignal cancellation → one cancelled
// terminal event, no late answer.
// ---------------------------------------------------------------------------

test("T05 #5: abort before runner call → one cancelled terminal, no answer_delta", async () => {
  const abortController = new AbortController();
  abortController.abort(); // pre-abort

  const adapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(),
  });
  const events = await collectEvents(adapter, "test", {
    signal: abortController.signal,
  });

  // No answer_delta events should be emitted after abort.
  const answerDeltas = events.filter((e) => e.type === "answer_delta");
  assert.equal(answerDeltas.length, 0, "no answer_delta after pre-abort");

  // Exactly one done event with status=cancelled.
  const doneEvents = events.filter((e) => e.type === "done");
  assert.equal(doneEvents.length, 1, "exactly one terminal event");
  if (doneEvents[0].type === "done") {
    assert.equal(doneEvents[0].result.status, "cancelled", "terminal status must be cancelled");
    assert.equal(doneEvents[0].status, "cancelled", "run status must be cancelled");
  }
});

test("T05 #5: runner throws AbortError mid-flight → one cancelled terminal event", async () => {
  const abortController = new AbortController();
  const adapter = createMastraChatEventAdapter({
    runner: async (input) => {
      await new Promise<void>((_resolve, reject) => {
        input.signal.addEventListener("abort", () => {
          const err = new Error("cancelled in runner");
          err.name = "AbortError";
          reject(err);
        }, { once: true });
        queueMicrotask(() => abortController.abort());
      });
      return makeFakeRunnerOutput();
    },
  });

  const events = await collectEvents(adapter, "test", {
    signal: abortController.signal,
  });

  const doneEvents = events.filter((e) => e.type === "done");
  assert.equal(doneEvents.length, 1, "exactly one terminal event");
  if (doneEvents[0].type === "done") {
    assert.equal(
      doneEvents[0].result.status,
      "cancelled",
      "terminal status must be cancelled when abort during run"
    );
  }
});

test("P1 regression: abort after runner completion does not rewrite completed state as cancelled", async () => {
  const abortController = new AbortController();
  const adapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(),
  });

  const events: AnswerRunEvent[] = [];
  for await (const event of adapter("test", { signal: abortController.signal })) {
    events.push(event);
    if (event.type === "progress" && event.stage === "route") {
      abortController.abort();
    }
  }

  const doneEvents = events.filter((event) => event.type === "done");
  assert.equal(doneEvents.length, 1, "runner completion must still publish one terminal");
  if (doneEvents[0].type === "done") {
    assert.equal(doneEvents[0].result.status, "completed");
    assert.equal(doneEvents[0].status, "completed");
  }
});

test("T05 #5: no late events after terminal done", async () => {
  // The adapter must not emit any event after the done event.
  const adapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(),
  });
  const events = await collectEvents(adapter, "test");

  const doneIndex = events.findIndex((e) => e.type === "done");
  assert.ok(doneIndex >= 0, "must have a done event");
  assert.equal(
    doneIndex,
    events.length - 1,
    "done must be the last event — no late events"
  );
});

// ---------------------------------------------------------------------------
// Criterion #6 — Duplicate runner invocation cannot publish the same answer twice.
// ---------------------------------------------------------------------------

test("T05 #6: terminal done event emitted exactly once", async () => {
  const adapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(),
  });
  const events = await collectEvents(adapter, "test");

  const doneEvents = events.filter((e) => e.type === "done");
  assert.equal(doneEvents.length, 1, "must emit exactly one done event (terminal-exactly-once)");
});

test("T05 #6: duplicate runner invocation guard still emits one terminal", async () => {
  // The adapter invokes the runner once and the terminalEmitted guard prevents
  // any duplicate terminal publication inside one source invocation.
  let callCount = 0;
  const adapter = createMastraChatEventAdapter({
    runner: async (input) => {
      callCount++;
      // Respect abort — second call would be after terminal, so it shouldn't happen.
      if (input.signal.aborted) {
        const err = new Error("cancelled");
        err.name = "AbortError";
        throw err;
      }
      return makeFakeRunnerOutput();
    },
  });
  const events = await collectEvents(adapter, "test");

  // Runner is called exactly once per adapter invocation (per T03 §5
  // Mastra Agent maxSteps=1 + maxRetries=0).
  assert.equal(callCount, 1, "runner must be called exactly once per adapter invocation");
  const doneEvents = events.filter((e) => e.type === "done");
  assert.equal(doneEvents.length, 1, "exactly one terminal event");
});

test("T05 #6: every event has a unique eventId (no duplicate publish)", async () => {
  const adapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(),
  });
  const events = await collectEvents(adapter, "test");

  const eventIds = events.map((e) => e.eventId);
  const uniqueIds = new Set(eventIds);
  assert.equal(
    eventIds.length,
    uniqueIds.size,
    "all eventIds must be unique — no duplicate publish"
  );
});

// ---------------------------------------------------------------------------
// Cross-ticket consistency — honors T02, T03, T04 decisions.
// ---------------------------------------------------------------------------

test("T05 honors Draft → validation → publish ordering for knowledge routes", async () => {
  const adapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(),
  });
  const events = await collectEvents(adapter, "test");

  // The adapter must emit events in the T03 §3 6-gate order.
  const stages = events.map((e) => e.stage);
  // Aggregated runner output is available only after validation, so approved
  // answer deltas are published after the validation stage.
  assert.equal(stages[0], "route", "GATE 0 route must be first");
  assert.equal(stages[1], "retrieval", "GATE 1/2 retrieval must follow route");
  assert.equal(stages[2], "context", "GATE 2 context must follow retrieval");
  const validationIndex = stages.indexOf("validation");
  assert.ok(validationIndex > 0, "validation must appear after context");
  // answer_delta events are approved publication, not raw Draft output.
  const answerStart = stages.indexOf("answer");
  assert.ok(answerStart > validationIndex, "answer publication must follow validation");
  // done must be last.
  assert.equal(stages[stages.length - 1], "done", "done must be the last stage");
});

test("T05 honors T04 §4 accessContext fallback to singleTenantAccessContext", async () => {
  // When accessContext is undefined (bare-router mount), the adapter must
  // fall back to singleTenantAccessContext per T04 §4 backward-compat.
  let capturedAccessContext: unknown = null;
  const adapter = createMastraChatEventAdapter({
    runner: async (input) => {
      capturedAccessContext = input.accessContext;
      return makeFakeRunnerOutput();
    },
  });
  // No accessContext in options — adapter must inject singleTenant fallback.
  await collectEvents(adapter, "test");

  assert.ok(capturedAccessContext, "accessContext must be injected (not undefined)");
  // The single-tenant fallback has deterministic tenantId/subjectId.
  const expected = singleTenantAccessContext();
  const actual = capturedAccessContext as { tenantId: string; subjectId: string };
  assert.equal(actual.tenantId, expected.tenantId, "fallback tenantId must match singleTenantAccessContext");
  assert.equal(actual.subjectId, expected.subjectId, "fallback subjectId must match singleTenantAccessContext");
});

test("T05 honors T02 §3 — tenantId is NOT a free-form tool arg in MastraRunnerInput", async () => {
  // T02 §3 forbids passing tenantId as a tool arg. The MastraRunnerInput
  // must source tenantId from accessContext, not from a separate tenantId field.
  const adapter = createMastraChatEventAdapter({
    runner: async (input) => {
      // input must NOT have a top-level tenantId field.
      assert.ok(
        !("tenantId" in input),
        "MastraRunnerInput must NOT have a top-level tenantId field (T02 §3)"
      );
      // tenantId is sourced from accessContext.
      assert.ok(input.accessContext, "accessContext must be present");
      assert.ok(input.accessContext.tenantId, "accessContext.tenantId must be present");
      return makeFakeRunnerOutput();
    },
  });
  await collectEvents(adapter, "test");
});

test("T05 live source check — AnswerEventsSource signature is compatible with runAnswer", () => {
  // The adapter factory returns a function with the same signature as
  // runAnswer (message, options?) => AsyncIterable<AnswerRunEvent>, so it
  // can be injected into createChatRouter as the eventsSource parameter.
  const adapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(),
  });
  // Type-level check: the adapter is assignable to AnswerEventsSource.
  // (This is enforced at compile time by the return type; here we verify
  // the runtime shape.)
  assert.equal(typeof adapter, "function", "adapter must be a function");
  // The function must return an async iterable when called.
  const result = adapter("test", {});
  assert.ok(
    typeof result[Symbol.asyncIterator] === "function",
    "adapter must return an async iterable"
  );
});

test("P1 regression: progress events carry the runner's real trace data", async () => {
  const output = makeFakeRunnerOutput({
    routeTrace: { decision: "complex", contextualizationOutcome: "success" },
    retrievalTrace: { resultCount: 3, selectedEvidenceIds: ["ev-1", "ev-2"] },
    contextTrace: { evidenceCount: 2, contextLength: 144 },
    validationTrace: { round: 2, passed: true },
  });
  const events = await collectEvents(
    createMastraChatEventAdapter({ runner: makeFakeRunner(output) }),
    "trace me"
  );
  const progress = events.filter((event) => event.type === "progress");
  assert.deepEqual(
    progress.map((event) => event.data),
    [output.routeTrace, output.retrievalTrace, output.contextTrace, output.validationTrace]
  );
});

test("P1 regression: direct and ambiguous routes do not emit fake retrieval/context/validation progress", async () => {
  for (const output of [
    makeFakeRunnerOutput({
      routeTrace: { decision: "direct" },
      retrievalTrace: {},
      contextTrace: {},
      validationTrace: {},
    }),
    makeFakeRunnerOutput({
      status: "clarification_required",
      routeTrace: { decision: "ambiguous" },
      retrievalTrace: {},
      contextTrace: {},
      validationTrace: {},
    }),
  ]) {
    const events = await collectEvents(
      createMastraChatEventAdapter({ runner: makeFakeRunner(output) }),
      "route-only"
    );
    const progressStages = events
      .filter((event) => event.type === "progress")
      .map((event) => event.stage);
    assert.deepEqual(progressStages, ["route"]);
  }
});

test("P1 regression: aggregated progress events close their stage with completed status", async () => {
  const events = await collectEvents(
    createMastraChatEventAdapter({ runner: makeFakeRunner() }),
    "status check"
  );
  const progress = events.filter((event) => event.type === "progress");
  assert.ok(progress.length > 0);
  assert.ok(progress.every((event) => event.status === "completed"));
});

test("P1 regression: trace persistence failure is hard and stops publication", async () => {
  let softObserverCalls = 0;
  const adapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(),
    traceObserver: {
      onEvent() {
        throw new Error("sqlite unavailable");
      },
    },
    observers: [{ onEvent() { softObserverCalls += 1; } }],
  });

  await assert.rejects(
    async () => collectEvents(adapter, "trace failure"),
    /sqlite unavailable/
  );
  assert.equal(softObserverCalls, 0, "soft exporters must not run after trace persistence fails");
});

test("P1 regression: summarization metadata reaches the terminal AnswerRunResult", async () => {
  const output = makeFakeRunnerOutput({
    summarizationOutcome: "success",
    summarizationUsage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    summarizationDurationMs: 7,
    summarizationCheckpoint: 12,
  });
  const events = await collectEvents(
    createMastraChatEventAdapter({ runner: makeFakeRunner(output) }),
    "summary metadata"
  );
  const done = events.at(-1);
  assert.equal(done?.type, "done");
  if (done?.type !== "done") throw new Error("expected done event");
  assert.equal(done.result.summarizationOutcome, "success");
  assert.deepEqual(done.result.summarizationUsage, output.summarizationUsage);
  assert.equal(done.result.summarizationDurationMs, 7);
  assert.equal(done.result.summarizationCheckpoint, 12);
});
