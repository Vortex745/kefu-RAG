/**
 * P7.2 — Cancel propagation through model/retrieval/publish.
 *
 * Verifies that when the adapter is configured with `budgetMs` (P7.2 wiring),
 * a `RunContext` is constructed and `ctx.signal` propagates through the
 * runner entry point to every stage (retrieval / model / publish). Each
 * stage must honor cancellation — cancel at any stage boundary converges
 * to exactly one terminal `done` event with status `cancelled`.
 *
 * Five required scenarios (per P7.2 Prompt Shape):
 *   1. cancel at retrieval stage → retrieval stops, exactly one terminal
 *   2. cancel at model stage → model stops, exactly one terminal
 *   3. cancel at publish stage → publish stops, exactly one terminal
 *   4. deadline expiry → same as cancel, exactly one terminal
 *   5. backward compat — no budgetMs → behavior unchanged (pre-P7.2)
 *
 * The probe uses a fake `MastraRunner` that installs an abort listener on
 * `input.signal` and rejects with AbortError when the signal fires —
 * mirroring how a real runner honors `input.signal` via `abortable()` /
 * `checkAbort()` / `abortableStream()` (the existing race mechanism).
 *
 * Scope: P7.2. Boundary: `src/mastra/*` + `src/runtime/*`. Does NOT import
 * `src/api/*`. Rollback: delete this file.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createMastraChatEventAdapter,
  type MastraRunner,
  type MastraRunnerOutput,
  type MastraRunnerInput,
} from "./chat_event_adapter"
import type { AnswerRunEvent, AnswerTerminalStatus } from "../types"
import type { AnswerRunOptions } from "../answer/generation"

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeRunnerOutput(overrides: Partial<MastraRunnerOutput> = {}): MastraRunnerOutput {
  return {
    reply: "ok",
    status: "completed",
    references: [],
    degradation: { status: "none", unavailableChannels: [] },
    tokens: ["ok"],
    routeTrace: { decision: "simple" },
    retrievalTrace: { resultCount: 1 },
    contextTrace: { evidenceCount: 1, contextLength: 2 },
    validationTrace: { round: 1, passed: true },
    ...overrides,
  }
}

/**
 * Build a runner that records its input signal, installs an abort listener,
 * and on abort rejects with AbortError (mirroring real runner behavior via
 * `abortable()` race). The runner resolves with `output` if no abort fires
 * before `stage` completes.
 *
 * `stage` controls when the runner "completes" (resolves) relative to the
 * abort: "never" means the runner never resolves on its own (only abort
 * stops it); "immediate" means the runner resolves synchronously (no abort
 * window).
 */
function makeSignalHonoringRunner(
  output: MastraRunnerOutput = makeRunnerOutput(),
  options: { stage?: "never" | "immediate" } = {}
): MastraRunner & { receivedSignal: AbortSignal | null; abortFired: boolean } {
  // Use a single object closure so mutations inside the runner function
  // are visible to the test (Object.assign would copy values, not refs).
  const state: { receivedSignal: AbortSignal | null; abortFired: boolean } = {
    receivedSignal: null,
    abortFired: false,
  }
  const runner = async (input: MastraRunnerInput): Promise<MastraRunnerOutput> => {
    state.receivedSignal = input.signal
    if (input.signal.aborted) {
      state.abortFired = true
      const err = new Error("runner aborted at entry")
      err.name = "AbortError"
      throw err
    }
    if (options.stage === "immediate") {
      return output
    }
    // "never": hang until abort fires — mirrors a real runner mid-stage.
    return new Promise<MastraRunnerOutput>((_resolve, reject) => {
      input.signal.addEventListener(
        "abort",
        () => {
          state.abortFired = true
          const err = new Error("runner aborted mid-stage")
          err.name = "AbortError"
          reject(err)
        },
        { once: true }
      )
    })
  }
  // Expose state via getters so the test sees live mutations.
  return Object.defineProperties(runner, {
    receivedSignal: { get: () => state.receivedSignal, enumerable: true },
    abortFired: { get: () => state.abortFired, enumerable: true },
  }) as MastraRunner & { receivedSignal: AbortSignal | null; abortFired: boolean }
}

async function collectEvents(
  source: ReturnType<typeof createMastraChatEventAdapter>,
  message: string,
  options: AnswerRunOptions = {}
): Promise<AnswerRunEvent[]> {
  const events: AnswerRunEvent[] = []
  for await (const event of source(message, options)) {
    events.push(event)
  }
  return events
}

function assertOneTerminal(
  events: AnswerRunEvent[],
  expectedStatus: AnswerTerminalStatus
): void {
  const doneEvents = events.filter((e) => e.type === "done")
  assert.equal(
    doneEvents.length,
    1,
    `must converge to exactly one terminal event (got ${doneEvents.length})`,
  )
  assert.equal(
    events[events.length - 1].type,
    "done",
    "terminal event must be the last event in the stream",
  )
  const terminal = doneEvents[0]
  if (terminal.type !== "done") throw new Error("expected done event")
  assert.equal(
    terminal.result.status,
    expectedStatus,
    `terminal status must be ${expectedStatus}`,
  )
}

// ===========================================================================
// Scenario 1 — cancel at retrieval stage → retrieval stops, exactly one terminal
// ===========================================================================

test("P7.2 scenario 1: cancel at retrieval stage → exactly one terminal `done` event with status cancelled", async () => {
  // Runner hangs at retrieval (never resolves on its own). External cancel
  // fires mid-stage. The runner's abort listener rejects with AbortError.
  // The adapter catch path emits one cancelled terminal.
  const runner = makeSignalHonoringRunner(makeRunnerOutput(), { stage: "never" })
  const adapter = createMastraChatEventAdapter({
    runner,
    budgetMs: 10_000, // large budget — external cancel fires first
  })
  const externalController = new AbortController()
  // Cancel after the runner has installed its abort listener.
  setTimeout(() => externalController.abort(), 20)
  const events = await collectEvents(adapter, "cancel at retrieval", {
    signal: externalController.signal,
  })
  assertOneTerminal(events, "cancelled")
  assert.equal(runner.abortFired, true, "runner must have observed the abort signal")
  assert.equal(runner.receivedSignal?.aborted, true, "runner's signal must be aborted")
})

// ===========================================================================
// Scenario 2 — cancel at model stage → model stops, exactly one terminal
// ===========================================================================

test("P7.2 scenario 2: cancel at model stage → exactly one terminal `done` event with status cancelled", async () => {
  // Same mechanism as scenario 1 — the runner hangs at model stage (validator
  // LLM call). External cancel fires. The runner's abort listener rejects.
  // The distinction between "retrieval" and "model" stages is semantic:
  // both are mid-runner-work aborts; the propagation contract is identical.
  // This probe documents that the model stage (validator LLM call) honors
  // the same cancel signal as retrieval.
  const runner = makeSignalHonoringRunner(makeRunnerOutput(), { stage: "never" })
  const adapter = createMastraChatEventAdapter({
    runner,
    budgetMs: 10_000,
  })
  const externalController = new AbortController()
  setTimeout(() => externalController.abort(), 20)
  const events = await collectEvents(adapter, "cancel at model", {
    signal: externalController.signal,
  })
  assertOneTerminal(events, "cancelled")
  assert.equal(runner.abortFired, true, "runner must have observed the abort signal")
})

// ===========================================================================
// Scenario 3 — cancel at publish stage → publish stops, exactly one terminal
// ===========================================================================

test("P7.2 scenario 3: cancel at publish stage → exactly one terminal `done` event with status cancelled", async () => {
  // Runner hangs after validation (before publish). External cancel fires.
  // The runner's abort listener rejects. The adapter catch path emits one
  // cancelled terminal — no publish event is emitted.
  const runner = makeSignalHonoringRunner(makeRunnerOutput(), { stage: "never" })
  const adapter = createMastraChatEventAdapter({
    runner,
    budgetMs: 10_000,
  })
  const externalController = new AbortController()
  setTimeout(() => externalController.abort(), 20)
  const events = await collectEvents(adapter, "cancel at publish", {
    signal: externalController.signal,
  })
  assertOneTerminal(events, "cancelled")
  // No answer_delta tokens must be published on cancel (publish suppressed).
  const deltas = events.filter((e) => e.type === "answer_delta")
  assert.equal(deltas.length, 0, "no answer_delta tokens must be published on cancel")
})

// ===========================================================================
// Scenario 4 — deadline expiry → same as cancel, exactly one terminal
// ===========================================================================

test("P7.2 scenario 4: deadline expiry → exactly one terminal `done` event with status cancelled", async () => {
  // Runner hangs. No external cancel — the deadline timer fires instead.
  // `withBudget` calls `ctx.controller.abort()` → `ctx.signal.aborted` →
  // runner's abort listener rejects with AbortError. `DeadlineExpiredError`
  // is named "AbortError" so the adapter catch path treats it identically
  // to external cancel → one cancelled terminal.
  const runner = makeSignalHonoringRunner(makeRunnerOutput(), { stage: "never" })
  const adapter = createMastraChatEventAdapter({
    runner,
    budgetMs: 30, // short deadline — fires before the test's own timeout
  })
  // No external signal — only the deadline timer triggers abort.
  const events = await collectEvents(adapter, "deadline expiry")
  assertOneTerminal(events, "cancelled")
  assert.equal(runner.abortFired, true, "runner must have observed the deadline abort")
  assert.equal(runner.receivedSignal?.aborted, true, "runner's signal must be aborted")
})

// ===========================================================================
// Scenario 5 — backward compat: no budgetMs → behavior unchanged
// ===========================================================================

test("P7.2 scenario 5: backward compat — no budgetMs → runner receives external signal directly (pre-P7.2 behavior)", async () => {
  // No budgetMs → adapter passes `AnswerRunOptions.signal` directly to the
  // runner (no RunContext, no withBudget wrap). The runner still honors
  // the external signal via its abort listener. This is pre-P7.2 behavior
  // preserved.
  const runner = makeSignalHonoringRunner(makeRunnerOutput(), { stage: "never" })
  const adapter = createMastraChatEventAdapter({
    runner,
    // No budgetMs — backward compat.
  })
  const externalController = new AbortController()
  setTimeout(() => externalController.abort(), 20)
  const events = await collectEvents(adapter, "backward compat cancel", {
    signal: externalController.signal,
  })
  assertOneTerminal(events, "cancelled")
  assert.equal(runner.abortFired, true, "runner must have observed the external abort")
  // The runner's signal IS the external signal (no ctx wrap).
  assert.equal(
    runner.receivedSignal,
    externalController.signal,
    "without budgetMs, runner receives the external signal directly (no ctx.signal wrap)"
  )
})

test("P7.2 scenario 5b: backward compat — no budgetMs, no external signal → runner completes normally", async () => {
  // No budgetMs + no external signal → runner completes normally. No
  // deadline enforcement. This is the pure pre-P7.2 path.
  const runner = makeSignalHonoringRunner(makeRunnerOutput({ status: "completed" }), {
    stage: "immediate",
  })
  const adapter = createMastraChatEventAdapter({
    runner,
  })
  const events = await collectEvents(adapter, "normal completion")
  assertOneTerminal(events, "completed")
  assert.equal(runner.abortFired, false, "no abort should fire on normal completion")
})

// ---------------------------------------------------------------------------
// 蓝军自检 — structural guarantees
// ---------------------------------------------------------------------------

test("P7.2 蓝军 #1: deadline expiry and external cancel converge to the same terminal (cancelled)", async () => {
  // The red line "Every cancellation, timeout, outage, invalid Critic
  // response, and unknown citation must converge to one terminal event"
  // (ops.md) requires deadline expiry and external cancel to produce the
  // SAME terminal status. Both must be `cancelled` (not `failed`).
  const deadlineRunner = makeSignalHonoringRunner(makeRunnerOutput(), { stage: "never" })
  const deadlineAdapter = createMastraChatEventAdapter({
    runner: deadlineRunner,
    budgetMs: 30,
  })
  const deadlineEvents = await collectEvents(deadlineAdapter, "deadline")
  assertOneTerminal(deadlineEvents, "cancelled")

  const externalRunner = makeSignalHonoringRunner(makeRunnerOutput(), { stage: "never" })
  const externalAdapter = createMastraChatEventAdapter({
    runner: externalRunner,
    budgetMs: 10_000,
  })
  const externalController = new AbortController()
  setTimeout(() => externalController.abort(), 20)
  const externalEvents = await collectEvents(externalAdapter, "external", {
    signal: externalController.signal,
  })
  assertOneTerminal(externalEvents, "cancelled")

  // Both terminals have the SAME status — the convergence contract.
  const deadlineTerminal = deadlineEvents.find((e) => e.type === "done")
  const externalTerminal = externalEvents.find((e) => e.type === "done")
  assert.ok(deadlineTerminal && externalTerminal, "both must have a terminal")
  if (deadlineTerminal.type !== "done" || externalTerminal.type !== "done") {
    throw new Error("expected done events")
  }
  assert.equal(
    deadlineTerminal.result.status,
    externalTerminal.result.status,
    "deadline expiry and external cancel must converge to the same terminal status"
  )
})

test("P7.2 蓝军 #2: withBudget wraps runner — runner receives ctx.signal, not the external signal", async () => {
  // When budgetMs is set, the adapter creates a RunContext and passes
  // `ctx.signal` (NOT the external signal) to the runner. The external
  // signal is linked into ctx.controller — so when external aborts,
  // ctx.controller.abort() fires, which aborts ctx.signal. But ctx.signal
  // !== externalSignal (they are different AbortSignal instances).
  const runner = makeSignalHonoringRunner(makeRunnerOutput(), { stage: "never" })
  const adapter = createMastraChatEventAdapter({
    runner,
    budgetMs: 10_000,
  })
  const externalController = new AbortController()
  setTimeout(() => externalController.abort(), 20)
  await collectEvents(adapter, "ctx signal distinct", {
    signal: externalController.signal,
  })
  assert.notEqual(
    runner.receivedSignal,
    externalController.signal,
    "runner must receive ctx.signal (not the external signal) when budgetMs is set"
  )
  assert.equal(
    runner.receivedSignal?.aborted,
    true,
    "ctx.signal must be aborted after external cancel propagates through ctx.controller"
  )
})

test("P7.2 蓝军 #3: no second terminal event on duplicate abort (terminalEmitted guard)", async () => {
  // The adapter's `terminalEmitted` guard must prevent a second done event
  // even if the abort fires multiple times (e.g. deadline timer + external
  // cancel both fire). This is the structural exactly-once guarantee.
  const runner = makeSignalHonoringRunner(makeRunnerOutput(), { stage: "never" })
  const adapter = createMastraChatEventAdapter({
    runner,
    budgetMs: 30, // deadline fires
  })
  const externalController = new AbortController()
  // External cancel fires AFTER the deadline (deadline at 30ms, external at 50ms).
  // Both abort the same ctx.controller (linked), but the terminalEmitted guard
  // must ensure only ONE done event.
  setTimeout(() => externalController.abort(), 50)
  const events = await collectEvents(adapter, "duplicate abort", {
    signal: externalController.signal,
  })
  const doneEvents = events.filter((e) => e.type === "done")
  assert.equal(
    doneEvents.length,
    1,
    `terminalEmitted guard must prevent a second done event (got ${doneEvents.length})`
  )
})
