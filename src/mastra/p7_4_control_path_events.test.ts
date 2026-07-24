/**
 * P7.4 — Control-path event tests at the primary seam (Answer run event stream).
 *
 * Verifies that `createMastraChatEventAdapter` converges to exactly one
 * terminal `done` event on every control path NOT already covered by:
 *   - `terminal_event_convergence.test.ts` (P1.1 success/cancel/outage +
 *     P3.3 Critic valid/invalid/unknown/oversized)
 *   - `p7_2_cancel_propagation.test.ts` (cancel@retrieval/model/publish +
 *     deadline expiry + backward compat + 3 蓝军)
 *   - `p7_3_clarification_peek_ack.test.ts` (peek-then-ack at the
 *     dispatcher level — NOT at the event-stream seam)
 *
 * The adapter has two terminal-emission paths:
 *   1. Success path (runner returns output → done with runnerOutput.status)
 *   2. Catch path (runner throws → AbortError→cancelled | else→provider_error)
 *
 * Gaps filled by this file:
 *   1. Success → `clarification_required` (P7.3 covered dispatcher peek/ack
 *      semantics; this covers the EVENT SEQUENCE — terminal convergence at
 *      the seam. Primary P7.4 gap.)
 *   2. Success → `invalid_citation` (ops.md red line: "unknown citation
 *      must converge to one terminal event" — not previously covered.)
 *   3. Catch → non-AbortError → `provider_error` (catch path's non-abort
 *      branch — not previously covered; p7_2 only covers AbortError paths.)
 *   4. Success → `completed` with partial degradation + references (graceful
 *      degradation convergence — terminal_event_convergence #3 only covers
 *      FULL outage → insufficient_retrieval; partial outage with a valid
 *      answer is a distinct control path.)
 *   5. Pre-run cancel → GATE 0 abort → `cancelled` (p7_2 tests cancel
 *      MID-runner; pre-run cancel via `checkAbort(signal, "GATE 0")` is a
 *      distinct control path where the runner is never invoked.)
 *
 * Scope: P7.4 — test-only (Situation A). Boundary: `src/mastra/*`. Does NOT
 * import `src/api/*`. Rollback: delete this file.
 *
 * Debt note: the `abortError`/`checkAbort`/`abortable` helper duplication
 * across 5 production files (registered in Convergence Review Round 2 Debt
 * Register) is NOT addressed here — extracting to `src/runtime/abort_helpers.ts`
 * would modify 5 production files with 2 implementation styles, violating
 * P7.4's declared rollback boundary ("revert tests only"). Left as
 * registered debt for P8.x.
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
// Fakes — mirror terminal_event_convergence.test.ts + p7_2 patterns so the
// probe is self-contained and does not depend on test-only exports.
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

function successRunner(output: MastraRunnerOutput = makeRunnerOutput()): MastraRunner {
  return async () => output
}

/** Runner that throws `error` (caller controls `.name` to simulate AbortError vs provider error). */
function throwingRunner(error: Error): MastraRunner {
  return async () => {
    throw error
  }
}

/**
 * Runner that records whether it was invoked. Used to verify pre-run cancel
 * suppresses runner invocation entirely (GATE 0 abort).
 */
function recordingRunner(
  output: MastraRunnerOutput = makeRunnerOutput(),
): MastraRunner & { invoked: boolean } {
  let invoked = false
  const runner = async (_input: MastraRunnerInput): Promise<MastraRunnerOutput> => {
    invoked = true
    return output
  }
  return Object.defineProperties(runner, {
    invoked: { get: () => invoked, enumerable: true },
  }) as MastraRunner & { invoked: boolean }
}

async function collectEvents(
  source: ReturnType<typeof createMastraChatEventAdapter>,
  message: string,
  options: AnswerRunOptions = {},
): Promise<AnswerRunEvent[]> {
  const events: AnswerRunEvent[] = []
  for await (const event of source(message, options)) {
    events.push(event)
  }
  return events
}

/** Assert the event stream has exactly one terminal `done` event, last in order. */
function assertOneTerminal(
  events: AnswerRunEvent[],
  expectedStatus: AnswerTerminalStatus,
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

/** Assert NO `answer_delta` events were emitted (failure/clarification never publishes). */
function assertNoAnswerDeltas(events: AnswerRunEvent[], label: string): void {
  const deltas = events.filter((e) => e.type === "answer_delta")
  assert.equal(
    deltas.length,
    0,
    `${label}: no answer_delta tokens must be published (got ${deltas.length})`,
  )
}

// ===========================================================================
// Test 1 — Clarification event sequence at the primary seam.
//
// P7.3 covered peek-then-ack at the DISPATCHER level (route_dispatch_runner).
// This test covers the EVENT SEQUENCE: when the runner returns
// `clarification_required`, the adapter must emit exactly one terminal `done`
// with status `clarification_required`, no answer_delta tokens (clarification
// does not publish an answer), and run status `degraded` (per
// terminalStatusToRunStatus mapping). This is the primary P7.4 gap.
// ===========================================================================

test("P7.4 clarification path: runner returns clarification_required → exactly one terminal done with status clarification_required", async () => {
  const adapter = createMastraChatEventAdapter({
    runner: successRunner(
      makeRunnerOutput({
        status: "clarification_required",
        reply: "Could you clarify which product you're asking about?",
        references: [],
        tokens: [], // clarification never publishes validated answer tokens
        degradation: { status: "none", unavailableChannels: [] },
        validationTrace: { round: 0, passed: false },
        routeTrace: { decision: "ambiguous" },
      }),
    ),
  })
  const events = await collectEvents(adapter, "clarification needed")
  assertOneTerminal(events, "clarification_required")
  assertNoAnswerDeltas(events, "clarification path")
  // Run status maps clarification_required → "degraded" (terminalStatusToRunStatus).
  const terminal = events.find((e) => e.type === "done")
  if (!terminal || terminal.type !== "done") throw new Error("expected done event")
  assert.equal(terminal.status, "degraded", "clarification_required maps to degraded run status")
})

// ===========================================================================
// Test 2 — Invalid citation convergence (ops.md red line).
//
// ops.md: "Every cancellation, timeout, outage, invalid Critic response, and
// unknown citation must converge to one terminal event." The invalid_citation
// terminal was NOT previously covered at the primary seam. The adapter is
// status-agnostic on the success path, so this documents the contract: runner
// returns invalid_citation → exactly one terminal, NO answer_delta tokens
// (unknown citation suppresses publication — "Never publish unvalidated
// Critic output or unknown citations").
// ===========================================================================

test("P7.4 invalid citation path: runner returns invalid_citation → exactly one terminal done with status invalid_citation", async () => {
  const adapter = createMastraChatEventAdapter({
    runner: successRunner(
      makeRunnerOutput({
        status: "invalid_citation",
        reply: "",
        references: [],
        tokens: [], // invalid citation suppresses answer publication
        degradation: {
          status: "insufficient",
          unavailableChannels: [],
          reason: "no_cited_claims",
        },
        validationTrace: { round: 1, passed: false },
      }),
    ),
  })
  const events = await collectEvents(adapter, "invalid citation path")
  assertOneTerminal(events, "invalid_citation")
  assertNoAnswerDeltas(events, "invalid citation path")
  // invalid_citation maps to "failed" run status (terminalStatusToRunStatus).
  const terminal = events.find((e) => e.type === "done")
  if (!terminal || terminal.type !== "done") throw new Error("expected done event")
  assert.equal(terminal.status, "failed", "invalid_citation maps to failed run status")
})

// ===========================================================================
// Test 3 — Provider error (non-AbortError) convergence via catch path.
//
// The adapter catch path (L524-549) branches on `err.name === "AbortError"`:
//   - AbortError → status "cancelled" (covered by p7_2 #1-4)
//   - else → status "provider_error" (NOT previously covered)
//
// This test covers the non-abort branch: runner throws a generic Error
// (e.g., OpenAI 500, network failure) → exactly one terminal `done` with
// status `provider_error`, run status `failed`, no answer_delta tokens.
// ===========================================================================

test("P7.4 provider error path: runner throws non-AbortError → exactly one terminal done with status provider_error", async () => {
  const providerError = new Error("openai request failed: 503 service unavailable")
  // NOT named "AbortError" — this is a provider error, not a cancellation.
  const adapter = createMastraChatEventAdapter({
    runner: throwingRunner(providerError),
  })
  const events = await collectEvents(adapter, "provider error path")
  assertOneTerminal(events, "provider_error")
  assertNoAnswerDeltas(events, "provider error path")
  // provider_error maps to "failed" run status (terminalStatusToRunStatus).
  const terminal = events.find((e) => e.type === "done")
  if (!terminal || terminal.type !== "done") throw new Error("expected done event")
  assert.equal(terminal.status, "failed", "provider_error maps to failed run status")
  // The terminal reply is empty (no answer was produced).
  assert.equal(terminal.result.reply, "", "provider error terminal must have empty reply")
  assert.equal(terminal.result.references.length, 0, "provider error terminal must have no references")
})

// ===========================================================================
// Test 4 — Outage partial degradation with references (graceful degradation).
//
// terminal_event_convergence #3 covers FULL outage (all channels down →
// insufficient_retrieval). This test covers PARTIAL outage: some retrieval
// channels unavailable (degradation.status="partial"), but the runner still
// produces a validated answer with references. The adapter must emit exactly
// one terminal `done` with status `completed`, answer_delta tokens published,
// and references present. This verifies graceful degradation convergence —
// the system continues to produce valid output when some dependencies are
// unavailable (ops.md: "Elasticsearch/Neo4j 断连时系统仍能受控启动并报告
// degraded").
// ===========================================================================

test("P7.4 outage partial degradation: runner returns completed with partial degradation + references → exactly one terminal done with status completed", async () => {
  const adapter = createMastraChatEventAdapter({
    runner: successRunner(
      makeRunnerOutput({
        status: "completed",
        reply: "Based on the available documentation, the return policy allows 30 days.",
        references: [
          {
            id: "ref-1",
            documentId: "doc-policy",
            documentVersionId: "ver-1",
            documentVersion: 1,
            chunkId: "chunk-42",
            title: "Return Policy",
            source: "https://example.com/policy",
            excerpt: "Returns accepted within 30 days of purchase.",
            channels: ["vector", "bm25"],
            score: 0.92,
            wikilinks: [],
          },
        ],
        tokens: ["Based on the available ", "documentation, the return ", "policy allows 30 days."],
        degradation: {
          status: "partial",
          unavailableChannels: ["graph"], // graph channel down, vector+bm25 survived
          reason: "no_results",
        },
        retrievalTrace: {
          resultCount: 1,
          channelStatuses: {
            vector: "completed",
            bm25: "completed",
            graph: "unavailable",
          },
        },
        validationTrace: { round: 1, passed: true },
      }),
    ),
  })
  const events = await collectEvents(adapter, "partial outage path")
  assertOneTerminal(events, "completed")
  // Partial outage with validated answer → answer_delta tokens ARE published.
  const deltas = events.filter((e) => e.type === "answer_delta")
  assert.equal(
    deltas.length,
    3,
    "partial outage with validated answer must publish answer_delta tokens",
  )
  // References must be present in the terminal event.
  const terminal = events.find((e) => e.type === "done")
  if (!terminal || terminal.type !== "done") throw new Error("expected done event")
  assert.equal(
    terminal.result.references.length,
    1,
    "partial outage terminal must carry validated references",
  )
  assert.equal(terminal.result.references[0].id, "ref-1", "reference id must match")
  assert.equal(
    terminal.result.degradation.status,
    "partial",
    "terminal degradation status must be partial",
  )
  assert.deepEqual(
    terminal.result.degradation.unavailableChannels,
    ["graph"],
    "terminal must report graph channel as unavailable",
  )
  // Run status for completed is "completed" (not degraded — the RUN completed;
  // degradation is a retrieval-layer property, not a run-layer property).
  assert.equal(terminal.status, "completed", "completed terminal maps to completed run status")
})

// ===========================================================================
// Test 5 — Pre-run cancel convergence (GATE 0 abort).
//
// p7_2 tests cancel MID-runner (signal fires while runner is executing). This
// test covers cancel BEFORE the runner is invoked: the signal is already
// aborted when the adapter starts. The adapter's `checkAbort(signal, "GATE 0
// (before route)")` at L405 throws AbortError → catch path → cancelled
// terminal. The runner is NEVER invoked. This is a distinct control path
// (pre-run abort vs mid-run abort) and verifies the GATE 0 checkpoint works.
// ===========================================================================

test("P7.4 pre-run cancel path: signal already aborted before runner call → exactly one terminal done with status cancelled, runner NOT invoked", async () => {
  const runner = recordingRunner(makeRunnerOutput({ status: "completed" }))
  const adapter = createMastraChatEventAdapter({
    runner,
    budgetMs: 10_000, // large budget — pre-run abort fires before any deadline
  })
  const abortController = new AbortController()
  // Abort BEFORE calling the adapter — signal is already aborted at GATE 0.
  abortController.abort()
  const events = await collectEvents(adapter, "pre-run cancel", {
    signal: abortController.signal,
  })
  assertOneTerminal(events, "cancelled")
  assertNoAnswerDeltas(events, "pre-run cancel path")
  assert.equal(runner.invoked, false, "runner must NOT be invoked when signal is already aborted at GATE 0")
})
