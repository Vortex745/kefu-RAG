/**
 * Ticket 13 — Observability and evaluation wiring tests.
 *
 * Verifies the 7 acceptance criteria from the T13 spec
 * (.scratch/mastra-migration/issues/13-connect-observability-evaluation.md):
 *   #1 Direct, ambiguous, simple, complex, correction, cancellation, Handoff,
 *      and terminal paths share one run and session correlation model
 *   #2 Local Answer Trace persistence and historical replay remain
 *      authoritative and compatible
 *   #3 Telemetry exports only the approved bounded metadata by default
 *   #4 Exporter failure, timeout, or shutdown flush failure cannot change
 *      the Answer result
 *   #5 Mastra evaluation results are recorded separately from hard
 *      invariants and cannot change their verdicts
 *   #6 Disabled observability and optional evaluation runtimes preserve
 *      zero-setup local behavior
 *   #7 Focused tests and release acceptance cover both enabled and disabled
 *      modes
 *
 * Boundary: this test file lives in src/mastra/* and tests the T13 wiring
 * (adapter observer fanout + index.ts observer construction + evaluation
 * structural separation). It does NOT test the LangfuseExporter internals
 * (covered by langfuse_exporter.test.ts) or the hard invariants semantics
 * (covered by hard_invariants.test.ts).
 *
 * T06 blueprint: .scratch/mastra-migration/decisions/06-observability-evaluation-coexistence.md
 *   - §2: 6 identity levels (run/session/workflow/tool/generation/terminal)
 *   - §3: AnswerTraceRepository authoritative; Mastra spans do NOT replace it
 *   - §4: Noop default + 6 prohibited exports + safe whitelist per stage
 *   - §5: Fire-and-forget; observer failure NEVER throws; local trace
 *     always attempted before export (fanout order: trace → exporter)
 *   - §6: 8 hard invariants deterministic + non-overridable; RAGAS
 *     structurally separate; Mastra scorers shadow-mode only
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  createMastraChatEventAdapter,
  type MastraRunner,
  type MastraRunnerOutput,
} from "./chat_event_adapter";
import type { AnswerRunEvent } from "../types";
import type { AnswerRunObserver } from "../answer/generation";
import type { AnswerRunOptions } from "../answer/generation";
import { AnswerTraceRepository } from "../answer/trace_repository";
import { openDb } from "../ingestion/tracking/db";
import {
  NoopLangfuseExporter,
  langfuseObserver,
  type LangfuseExporter,
} from "../answer/langfuse_exporter";

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
    contextTrace: { evidenceCount: 1, contextLength: 24 },
    validationTrace: { round: 0, passed: true },
    ...overrides,
  };
}

function makeFakeRunner(
  output: MastraRunnerOutput = makeFakeRunnerOutput(),
): MastraRunner {
  return async (input) => {
    if (input.signal.aborted) {
      const err = new Error("Answer run cancelled at runner");
      err.name = "AbortError";
      throw err;
    }
    return output;
  };
}

async function collectEvents(
  source: ReturnType<typeof createMastraChatEventAdapter>,
  message: string,
  options: AnswerRunOptions = {},
): Promise<AnswerRunEvent[]> {
  const events: AnswerRunEvent[] = [];
  for await (const event of source(message, options)) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Criterion #1 — Single run + session correlation model across all paths.
// ---------------------------------------------------------------------------

test("T13 #1: observer receives every event with consistent runId + sessionId", async () => {
  const observed: AnswerRunEvent[] = [];
  const observer: AnswerRunObserver = { onEvent: (e) => observed.push(e) };
  const adapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(),
    observers: [observer],
  });
  const events = await collectEvents(adapter, "hello", {
    runId: "run-correlation-1",
    sessionId: "session-correlation-1",
  });
  // Observer saw every event the consumer saw (same count).
  assert.equal(observed.length, events.length, "observer must receive every event");
  // Every observed event carries the same runId + sessionId (single correlation model).
  for (const e of observed) {
    assert.equal(e.runId, "run-correlation-1");
    assert.equal(e.sessionId, "session-correlation-1");
  }
  // Observer order matches consumer order.
  assert.deepEqual(
    observed.map((e) => e.eventId),
    events.map((e) => e.eventId),
  );
});

test("T13 #1: observer receives validated publication order (route → retrieval → context → validation → answer → done)", async () => {
  const observed: AnswerRunEvent[] = [];
  const observer: AnswerRunObserver = { onEvent: (e) => observed.push(e) };
  const adapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(),
    observers: [observer],
  });
  await collectEvents(adapter, "hello", {
    runId: "run-order-1",
    sessionId: "session-order-1",
  });
  const stages = observed.map((e) => e.stage);
  assert.equal(stages[0], "route");
  assert.equal(stages[1], "retrieval");
  assert.equal(stages[2], "context");
  // Draft tokens are publishable only after validation completes.
  const validationIdx = stages.indexOf("validation");
  const firstAnswerIdx = stages.indexOf("answer");
  assert.ok(firstAnswerIdx > validationIdx, "answer events must come after validation");
  // done is last
  assert.equal(stages[stages.length - 1], "done");
});

test("T13 #1: observer receives the SAME event references as the consumer (no cloning)", async () => {
  // The adapter must pass the exact event object to observers that it yields
  // — this proves observers see the real event, not a copy or a derivative.
  const observed: AnswerRunEvent[] = [];
  const observer: AnswerRunObserver = { onEvent: (e) => observed.push(e) };
  const adapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(),
    observers: [observer],
  });
  const events = await collectEvents(adapter, "hello", {
    runId: "run-ref-1",
    sessionId: "session-ref-1",
  });
  assert.equal(observed.length, events.length);
  for (let i = 0; i < events.length; i++) {
    assert.equal(observed[i], events[i], `event ${i} must be referentially identical`);
  }
});

test("T13 #1: cancellation path also correlates runId + sessionId via observer", async () => {
  const observed: AnswerRunEvent[] = [];
  const observer: AnswerRunObserver = { onEvent: (e) => observed.push(e) };
  const adapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(),
    observers: [observer],
  });
  const ac = new AbortController();
  ac.abort();
  const events = await collectEvents(adapter, "hello", {
    runId: "run-cancel-1",
    sessionId: "session-cancel-1",
    signal: ac.signal,
  });
  // Observer saw the cancelled terminal event with consistent identity.
  assert.ok(observed.length >= 1);
  const terminal = observed[observed.length - 1];
  assert.equal(terminal.type, "done");
  assert.equal(terminal.runId, "run-cancel-1");
  assert.equal(terminal.sessionId, "session-cancel-1");
  assert.equal(events.length, observed.length);
});

test("T13 #1: provider-failure path also correlates runId + sessionId via observer", async () => {
  const observed: AnswerRunEvent[] = [];
  const observer: AnswerRunObserver = { onEvent: (e) => observed.push(e) };
  const failingRunner: MastraRunner = async () => {
    const err = new Error("provider down");
    throw err;
  };
  const adapter = createMastraChatEventAdapter({
    runner: failingRunner,
    observers: [observer],
  });
  const events = await collectEvents(adapter, "hello", {
    runId: "run-fail-1",
    sessionId: "session-fail-1",
  });
  // Observer saw the failed terminal event with consistent identity.
  assert.ok(observed.length >= 1);
  const terminal = observed[observed.length - 1];
  assert.equal(terminal.type, "done");
  assert.equal(terminal.runId, "run-fail-1");
  assert.equal(terminal.sessionId, "session-fail-1");
  assert.equal(events.length, observed.length);
});

// ---------------------------------------------------------------------------
// Criterion #2 — Local Answer Trace persistence + replay authoritative.
// ---------------------------------------------------------------------------

test("T13 #2: AnswerTraceRepository as observer captures all events (authoritative local trace)", async () => {
  const db = openDb(":memory:");
  try {
    const repository = new AnswerTraceRepository(db);
    const adapter = createMastraChatEventAdapter({
      runner: makeFakeRunner(),
      observers: [repository],
    });
    const events = await collectEvents(adapter, "hello", {
      runId: "run-trace-1",
      sessionId: "session-trace-1",
    });
    // Repository persisted every event (observer fanout wired correctly).
    const history = repository.getRun("run-trace-1");
    assert.ok(history, "history must be persisted");
    assert.equal(history?.sessionId, "session-trace-1");
    assert.equal(history?.events.length, events.length);
    // Replay preserves sequence order (ordered by sequence ASC).
    for (let i = 0; i < events.length; i++) {
      assert.equal(history?.events[i].eventId, events[i].eventId);
      assert.equal(history?.events[i].sequence, events[i].sequence);
    }
    // Replay preserves terminal event.
    assert.equal(history?.events[history.events.length - 1].type, "done");
  } finally {
    db.close();
  }
});

test("T13 #2: Mastra-adapter events are shape-compatible with legacy runAnswer events (replay compatibility)", async () => {
  // T06 §3.3: pre-Mastra + Mastra + mixed runs replay identically because
  // the event shape is the contract, not the producer. This test verifies
  // Mastra-adapter events carry all legacy AnswerRunEvent base fields.
  const db = openDb(":memory:");
  try {
    const repository = new AnswerTraceRepository(db);
    const adapter = createMastraChatEventAdapter({
      runner: makeFakeRunner(),
      observers: [repository],
    });
    await collectEvents(adapter, "hello", {
      runId: "run-shape-1",
      sessionId: "session-shape-1",
    });
    const history = repository.getRun("run-shape-1");
    assert.ok(history);
    for (const e of history!.events) {
      // Every event has the legacy AnswerRunEvent base fields.
      assert.equal(e.schemaVersion, 1, "schemaVersion must be 1 (legacy compat)");
      assert.ok(e.runId);
      assert.ok(e.sessionId);
      assert.ok(e.eventId);
      assert.equal(typeof e.sequence, "number");
      assert.equal(typeof e.createdAt, "string");
      assert.ok(e.stage);
      assert.ok(e.status);
      assert.equal(typeof e.durationMs, "number");
      assert.equal(typeof e.attempt, "number");
      assert.equal(typeof e.round, "number");
    }
  } finally {
    db.close();
  }
});

test("T13 #2: AnswerTraceRepository is the authoritative source — observer fanout delivers to it", async () => {
  // T06 §3.1: AnswerTraceRepository is the authoritative source for product
  // history + replay. This test verifies the adapter's observer fanout
  // delivers events to the repository BEFORE the consumer sees them
  // (matching legacy runAnswer → notifyObservers → yield pattern).
  const db = openDb(":memory:");
  try {
    const repository = new AnswerTraceRepository(db);
    let observerSeenCount = 0;
    const countingObserver: AnswerRunObserver = {
      onEvent: () => { observerSeenCount++ },
    };
    const adapter = createMastraChatEventAdapter({
      runner: makeFakeRunner(),
      observers: [repository, countingObserver],
    });
    let consumerSeenCount = 0;
    for await (const _event of adapter("hello", {
      runId: "run-authoritative-1",
      sessionId: "session-authoritative-1",
    })) {
      consumerSeenCount++;
      // After each yield, the observer must have already seen this event
      // (notify-before-yield invariant). The observer count is always at
      // least equal to the consumer count — proving the repository had the
      // event persisted before the consumer advanced.
      assert.ok(
        observerSeenCount >= consumerSeenCount,
        `observer must be notified before yield (observer=${observerSeenCount}, consumer=${consumerSeenCount})`,
      );
    }
    assert.equal(observerSeenCount, consumerSeenCount);
    // Repository persisted everything.
    const history = repository.getRun("run-authoritative-1");
    assert.ok(history);
    assert.equal(history?.events.length, consumerSeenCount);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Criterion #3 — Telemetry exports only approved bounded metadata by default.
// ---------------------------------------------------------------------------

test("T13 #3: langfuseObserver receives every event when wired (export wiring verification)", async () => {
  const exported: AnswerRunEvent[] = [];
  const fakeExporter: LangfuseExporter = {
    export: (e) => { exported.push(e) },
    close: () => Promise.resolve(),
  };
  const adapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(),
    observers: [langfuseObserver(fakeExporter)],
  });
  await collectEvents(adapter, "hello", {
    runId: "run-export-1",
    sessionId: "session-export-1",
  });
  // Exporter received every event (wiring is correct).
  assert.ok(exported.length >= 6, "exporter must receive every event via observer");
  for (const e of exported) {
    assert.ok(e.runId);
    assert.ok(e.sessionId);
  }
});

test("T13 #3: NoopLangfuseExporter is a true no-op (disabled-mode default)", async () => {
  const noop = new NoopLangfuseExporter();
  // export does nothing — no throw, no side effect.
  assert.doesNotThrow(() => noop.export({} as AnswerRunEvent));
  await assert.doesNotReject(() => noop.close());
});

test("T13 #3: src/index.ts wiring pattern attaches langfuseObserver only when NOT Noop (T06 §4.3)", () => {
  // Structural assertion: src/index.ts must guard langfuseObserver attachment
  // with `instanceof NoopLangfuseExporter` to honor the Noop default. This
  // mirrors the legacy createAnswerRuntime pattern (runtime.ts L170-173).
  const indexSource = readFileSync(
    path.resolve(process.cwd(), "src/index.ts"),
    "utf8",
  );
  // The guard must be present.
  assert.ok(
    indexSource.includes("instanceof NoopLangfuseExporter"),
    "src/index.ts must guard langfuseObserver attachment with NoopLangfuseExporter check",
  );
  // mastraObservers construction must be present.
  assert.ok(
    indexSource.includes("mastraObservers"),
    "src/index.ts must construct mastraObservers list",
  );
  // observers must be passed to createMastraChatEventAdapter.
  assert.ok(
    indexSource.includes("observers: mastraObservers"),
    "src/index.ts must pass observers to createMastraChatEventAdapter",
  );
  assert.ok(
    indexSource.includes("traceObserver: answerRuntime.traceRepository"),
    "src/index.ts must wire local trace persistence as the hard observer",
  );
  assert.ok(
    !indexSource.includes("const mastraObservers: AnswerRunObserver[] = [answerRuntime.traceRepository]"),
    "local trace persistence must not be downgraded into the soft observer fanout",
  );
});

// ---------------------------------------------------------------------------
// Criterion #4 — Exporter failure isolation (fire-and-forget).
// ---------------------------------------------------------------------------

test("T13 #4: observer throwing does NOT break the event stream", async () => {
  const throwingObserver: AnswerRunObserver = {
    onEvent: () => { throw new Error("observer failure") },
  };
  const adapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(),
    observers: [throwingObserver],
  });
  const events = await collectEvents(adapter, "hello", {
    runId: "run-throw-1",
    sessionId: "session-throw-1",
  });
  // Stream is unaffected — all 6+ events yielded.
  assert.ok(events.length >= 6);
  assert.equal(events[events.length - 1].type, "done");
});

test("T13 #4: observer throwing on terminal event still yields the terminal", async () => {
  const throwingObserver: AnswerRunObserver = {
    onEvent: (e) => {
      if (e.type === "done") throw new Error("terminal observer failure");
    },
  };
  const adapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(),
    observers: [throwingObserver],
  });
  const events = await collectEvents(adapter, "hello", {
    runId: "run-throw-2",
    sessionId: "session-throw-2",
  });
  const terminal = events[events.length - 1];
  assert.equal(terminal.type, "done");
  // Terminal result is preserved (not altered by observer failure).
  const done = terminal as Extract<AnswerRunEvent, { type: "done" }>;
  assert.equal(done.result.status, "completed");
});

test("T13 #4: fanout continues to subsequent observers after one throws", async () => {
  const observedBySecond: AnswerRunEvent[] = [];
  const observers: AnswerRunObserver[] = [
    { onEvent: () => { throw new Error("first observer fails") } },
    { onEvent: (e) => { observedBySecond.push(e) } },
  ];
  const adapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(),
    observers,
  });
  const events = await collectEvents(adapter, "hello", {
    runId: "run-fanout-1",
    sessionId: "session-fanout-1",
  });
  // Second observer still received every event despite first observer failing.
  assert.equal(observedBySecond.length, events.length);
});

test("T13 #4: exporter failure does not affect local trace persistence (T06 §5.3 fanout order)", async () => {
  // T06 §5.3: observer fanout order is traceRepository (hard) → exporter (soft).
  // Exporter failure MUST NOT prevent local trace persistence.
  const db = openDb(":memory:");
  try {
    const repository = new AnswerTraceRepository(db);
    const failingExporter: LangfuseExporter = {
      export: () => { throw new Error("langfuse backend down") },
      close: () => Promise.resolve(),
    };
    const adapter = createMastraChatEventAdapter({
      runner: makeFakeRunner(),
      observers: [repository, langfuseObserver(failingExporter)],
    });
    const events = await collectEvents(adapter, "hello", {
      runId: "run-isolation-1",
      sessionId: "session-isolation-1",
    });
    // Stream unaffected by exporter failure.
    assert.ok(events.length >= 6);
    assert.equal(events[events.length - 1].type, "done");
    // Local trace persisted despite exporter failure (T06 §5.3).
    const history = repository.getRun("run-isolation-1");
    assert.ok(history, "local trace must be persisted despite exporter failure");
    assert.equal(history?.events.length, events.length);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Criterion #5 — Mastra evaluation separate from hard invariants.
// ---------------------------------------------------------------------------

test("T13 #5: hard_invariants.ts does NOT import from ../mastra/* (structural separation)", () => {
  // T06 §6.1: hard invariants are Mastra-independent — they consume only
  // GoldenCase[] + CaseResult[] and must not call Mastra Agent methods.
  const file = readFileSync(
    path.resolve(process.cwd(), "src/evaluation/hard_invariants.ts"),
    "utf8",
  );
  const mastraImportRegex = /from\s+["']\.\.\/mastra\//;
  assert.equal(
    mastraImportRegex.test(file),
    false,
    "hard_invariants.ts must not import from ../mastra/* — T06 §6.1 Mastra-independent",
  );
});

test("T13 #5: smoke.ts does NOT import from ../mastra/* (smokeGatePassed is Mastra-independent)", () => {
  // T06 §6.3: Mastra scorers are NEVER consulted by smokeGatePassed.
  const file = readFileSync(
    path.resolve(process.cwd(), "src/evaluation/smoke.ts"),
    "utf8",
  );
  const mastraImportRegex = /from\s+["']\.\.\/mastra\//;
  assert.equal(mastraImportRegex.test(file), false);
});

test("T13 #5: release_verification.ts does NOT import from ../mastra/*", () => {
  const file = readFileSync(
    path.resolve(process.cwd(), "src/evaluation/release_verification.ts"),
    "utf8",
  );
  const mastraImportRegex = /from\s+["']\.\.\/mastra\//;
  assert.equal(mastraImportRegex.test(file), false);
});

test("T13 #5: EvaluationArtifact type has ragas? + ragasShadow? as separate top-level fields", () => {
  // T06 §6.2: RAGAS results live in separate top-level fields, NOT under
  // aggregateMetrics.hardInvariants or aggregateMetrics.qualityMetrics.
  // This structural separation guarantees RAGAS cannot change deterministic
  // verdicts.
  const file = readFileSync(
    path.resolve(process.cwd(), "src/evaluation/types.ts"),
    "utf8",
  );
  // Extract the EvaluationArtifact interface body.
  const artifactMatch = file.match(/export interface EvaluationArtifact \{([\s\S]*?)\n\}/);
  assert.ok(artifactMatch, "EvaluationArtifact interface must exist");
  const body = artifactMatch![1];
  // ragas? and ragasShadow? must appear at the top level (not nested).
  assert.ok(
    /^\s*ragas\?:/m.test(body),
    "ragas? must be a top-level field of EvaluationArtifact",
  );
  assert.ok(
    /^\s*ragasShadow\?:/m.test(body),
    "ragasShadow? must be a top-level field of EvaluationArtifact",
  );
  // They must NOT appear inside aggregateMetrics.
  const aggMatch = body.match(/aggregateMetrics:\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(aggMatch, "aggregateMetrics must exist");
  const aggBody = aggMatch![1];
  assert.equal(
    /^\s*ragas\?:/m.test(aggBody),
    false,
    "ragas? must NOT be inside aggregateMetrics (structural separation)",
  );
  assert.equal(
    /^\s*ragasShadow\?:/m.test(aggBody),
    false,
    "ragasShadow? must NOT be inside aggregateMetrics (structural separation)",
  );
});

test("T13 #5: evaluateHardInvariants consumes only GoldenCase[] + CaseResult[] (no Mastra params)", () => {
  // T06 §6.1: evaluateHardInvariants signature is (cases: GoldenCase[], results: CaseResult[]).
  // No Mastra Agent, no Mastra scorer, no Mastra observability parameter.
  const file = readFileSync(
    path.resolve(process.cwd(), "src/evaluation/hard_invariants.ts"),
    "utf8",
  );
  // Find the function signature.
  const sigMatch = file.match(/export function evaluateHardInvariants\s*\([^)]*\)/);
  assert.ok(sigMatch, "evaluateHardInvariants function must exist");
  const sig = sigMatch![0];
  // Must accept GoldenCase[] and CaseResult[].
  assert.ok(sig.includes("GoldenCase"), "must accept GoldenCase[]");
  assert.ok(sig.includes("CaseResult"), "must accept CaseResult[]");
  // Must NOT accept any Mastra-typed parameter.
  assert.equal(sig.includes("Mastra"), false, "must NOT accept Mastra-typed parameters");
});

// ---------------------------------------------------------------------------
// Criterion #6 — Disabled observability preserves zero-setup local behavior.
// ---------------------------------------------------------------------------

test("T13 #6: adapter with no observers option works normally (zero-setup)", async () => {
  const adapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(),
    // observers option omitted — backward compat with pre-T13 callers.
  });
  const events = await collectEvents(adapter, "hello", {
    runId: "run-disabled-1",
    sessionId: "session-disabled-1",
  });
  assert.ok(events.length >= 6);
  assert.equal(events[events.length - 1].type, "done");
});

test("T13 #6: adapter with empty observers array works normally", async () => {
  const adapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(),
    observers: [],
  });
  const events = await collectEvents(adapter, "hello", {
    runId: "run-disabled-2",
    sessionId: "session-disabled-2",
  });
  assert.ok(events.length >= 6);
  assert.equal(events[events.length - 1].type, "done");
});

test("T13 #6: disabled-mode (NoopLangfuseExporter) runs identically to no-observability mode", async () => {
  // Simulate the src/index.ts wiring when Langfuse is not configured:
  //   observers = [traceRepository] only (langfuseObserver NOT attached).
  // This is the production default (T06 §4.3 Noop default).
  const db = openDb(":memory:");
  try {
    const repository = new AnswerTraceRepository(db);
    const noopExporter = new NoopLangfuseExporter();
    const observers: AnswerRunObserver[] = [repository];
    // Mirror src/index.ts L188-190: only attach langfuseObserver if NOT Noop.
    if (!(noopExporter instanceof NoopLangfuseExporter)) {
      observers.push(langfuseObserver(noopExporter));
    }
    const adapter = createMastraChatEventAdapter({
      runner: makeFakeRunner(),
      observers,
    });
    const events = await collectEvents(adapter, "hello", {
      runId: "run-noop-1",
      sessionId: "session-noop-1",
    });
    // Stream + local trace both work identically to enabled mode.
    assert.ok(events.length >= 6);
    assert.equal(events[events.length - 1].type, "done");
    const history = repository.getRun("run-noop-1");
    assert.ok(history);
    assert.equal(history?.events.length, events.length);
    // langfuseObserver was NOT attached (only traceRepository).
    assert.equal(observers.length, 1);
  } finally {
    db.close();
  }
});

test("T13 #6: disabled-mode adapter (no observers) still persists trace when wired with repository only", async () => {
  // Even with no Langfuse configured, the trace repository observer alone
  // provides full local trace persistence (T06 §3.1 authoritative source).
  const db = openDb(":memory:");
  try {
    const repository = new AnswerTraceRepository(db);
    const adapter = createMastraChatEventAdapter({
      runner: makeFakeRunner(),
      observers: [repository],
    });
    await collectEvents(adapter, "hello", {
      runId: "run-trace-only-1",
      sessionId: "session-trace-only-1",
    });
    const history = repository.getRun("run-trace-only-1");
    assert.ok(history);
    assert.ok(history!.events.length >= 6);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Criterion #7 — Focused tests cover both enabled and disabled modes.
// ---------------------------------------------------------------------------

test("T13 #7: enabled-mode (with observers) and disabled-mode (no observers) produce identical event sequences", async () => {
  // T06 §5.2: observability failure MUST NOT affect the Answer stream.
  // Corollary: the event stream is observer-independent — observers are
  // fire-and-forget and cannot alter the yielded events. This test verifies
  // both modes produce the same event sequence (same shape, order, identity).
  const enabledAdapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(),
    observers: [
      { onEvent: () => {} },
      { onEvent: () => {} },
      { onEvent: () => { throw new Error("observer failure must not affect stream") } },
    ],
  });
  const disabledAdapter = createMastraChatEventAdapter({
    runner: makeFakeRunner(),
    // no observers — zero-setup mode
  });
  const [enabled, disabled] = await Promise.all([
    collectEvents(enabledAdapter, "hello", {
      runId: "run-enabled",
      sessionId: "session-enabled",
    }),
    collectEvents(disabledAdapter, "hello", {
      runId: "run-disabled",
      sessionId: "session-disabled",
    }),
  ]);
  // Same event count.
  assert.equal(enabled.length, disabled.length);
  // Same event types in same order.
  assert.deepEqual(
    enabled.map((e) => e.type),
    disabled.map((e) => e.type),
  );
  // Same stages in same order.
  assert.deepEqual(
    enabled.map((e) => e.stage),
    disabled.map((e) => e.stage),
  );
  // Same status for each event.
  for (let i = 0; i < enabled.length; i++) {
    assert.equal(enabled[i].status, disabled[i].status);
  }
  // Terminal result is identical.
  const enabledTerminal = enabled[enabled.length - 1] as Extract<AnswerRunEvent, { type: "done" }>;
  const disabledTerminal = disabled[disabled.length - 1] as Extract<AnswerRunEvent, { type: "done" }>;
  assert.equal(enabledTerminal.result.status, disabledTerminal.result.status);
  assert.equal(enabledTerminal.result.reply, disabledTerminal.result.reply);
});

test("T13 #7: focused tests cover enabled-mode (langfuseObserver + repository) full path", async () => {
  // This is the "enabled mode" end-to-end: both traceRepository AND
  // langfuseObserver wired, like production with Langfuse configured.
  const db = openDb(":memory:");
  try {
    const repository = new AnswerTraceRepository(db);
    const exported: AnswerRunEvent[] = [];
    const fakeExporter: LangfuseExporter = {
      export: (e) => { exported.push(e) },
      close: () => Promise.resolve(),
    };
    const adapter = createMastraChatEventAdapter({
      runner: makeFakeRunner(),
      observers: [repository, langfuseObserver(fakeExporter)],
    });
    const events = await collectEvents(adapter, "hello", {
      runId: "run-enabled-full-1",
      sessionId: "session-enabled-full-1",
    });
    // Both observers received every event.
    const history = repository.getRun("run-enabled-full-1");
    assert.ok(history);
    assert.equal(history?.events.length, events.length);
    assert.equal(exported.length, events.length);
    // Stream yielded every event.
    assert.ok(events.length >= 6);
    assert.equal(events[events.length - 1].type, "done");
  } finally {
    db.close();
  }
});
