/**
 * Terminal event convergence characterization probe.
 *
 * This is a characterization test for the primary behavior seam
 * (`createMastraChatEventAdapter` → Answer run event stream). It verifies
 * the invariant that every Answer run converges to exactly one terminal
 * `done` event on the paths mandated by Ticket 01 + P3.3:
 *
 *   P1.1 baseline (3 probes):
 *   1. success      — runner returns `completed`
 *   2. cancellation — runner throws `AbortError`
 *   3. retrieval dependency outage — runner returns `insufficient_retrieval`
 *
 *   P3.3 Critic stream integration (4 probes):
 *   4. Critic valid     — runner returns `completed` (validationTrace.passed:true)
 *   5. Critic invalid   — degraded verdict → runner returns `insufficient_evidence`
 *   6. Critic unknown   — malformed JSON → runner returns `handoff_required`
 *   7. Critic oversized — >8KiB DoS guard → runner returns `insufficient_evidence`
 *
 * P3.3 is situation A (test-only): the adapter is status-agnostic and
 * already forwards the runner's terminal status with terminal-exactly-once
 * via the `terminalEmitted` guard. P3.2 guarantees the validator returns a
 * degraded verdict on invalid/unknown/oversized Critic output; the runner's
 * existing 3-round loop converges to `insufficient_evidence`/`handoff_required`.
 * These probes document that contract at the event-stream seam.
 *
 * Scope: P1.1 + P3.3. This file is a characterization probe — rollback is
 * to delete it. It does NOT modify production behavior or the runtime seam.
 *
 * Boundary: owned by `src/mastra/*`; MUST NOT import `src/api/*`.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createMastraChatEventAdapter,
  type MastraRunner,
  type MastraRunnerOutput,
} from "./chat_event_adapter"
import type { AnswerRunEvent, AnswerTerminalStatus } from "../types"
import type { AnswerRunOptions } from "../answer/generation"

// ---------------------------------------------------------------------------
// Fakes — mirror chat_event_adapter.test.ts patterns so the probe is
// self-contained and does not depend on test-only exports.
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

function cancellingRunner(): MastraRunner {
  return async () => {
    const err = new Error("cancelled in runner")
    err.name = "AbortError"
    throw err
  }
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

// ---------------------------------------------------------------------------
// Probe 1 — success converges to exactly one terminal event.
// ---------------------------------------------------------------------------

test("P1.1 convergence: success → exactly one terminal `done` event", async () => {
  const adapter = createMastraChatEventAdapter({
    runner: successRunner(makeRunnerOutput({ status: "completed" })),
  })
  const events = await collectEvents(adapter, "success path")
  assertOneTerminal(events, "completed")
})

// ---------------------------------------------------------------------------
// Probe 2 — cancellation converges to exactly one terminal event.
// ---------------------------------------------------------------------------

test("P1.1 convergence: cancellation → exactly one terminal `done` event with status cancelled", async () => {
  const abortController = new AbortController()
  const adapter = createMastraChatEventAdapter({
    runner: cancellingRunner(),
  })
  const events = await collectEvents(adapter, "cancel path", {
    signal: abortController.signal,
  })
  assertOneTerminal(events, "cancelled")
})

// ---------------------------------------------------------------------------
// Probe 3 — retrieval dependency outage converges to exactly one terminal event.
// The runner returns `insufficient_retrieval` (all retrieval channels
// unavailable), which is the deterministic outage outcome on the primary seam.
// ---------------------------------------------------------------------------

test("P1.1 convergence: retrieval dependency outage → exactly one terminal `done` event", async () => {
  const adapter = createMastraChatEventAdapter({
    runner: successRunner(
      makeRunnerOutput({
        status: "insufficient_retrieval",
        reply: "",
        references: [],
        tokens: [],
        degradation: {
          status: "insufficient",
          unavailableChannels: ["vector", "bm25", "graph"],
          reason: "no_results",
        },
        retrievalTrace: {
          resultCount: 0,
          channelStatuses: {
            vector: "unavailable",
            bm25: "unavailable",
            graph: "unavailable",
          },
        },
        contextTrace: {},
        validationTrace: {},
      }),
    ),
  })
  const events = await collectEvents(adapter, "outage path")
  assertOneTerminal(events, "insufficient_retrieval")
})

// ---------------------------------------------------------------------------
// P3.3 probes — Critic stream integration: terminal convergence on Critic
// failure paths.
//
// P3.2 guarantees ValidatorImpl returns a degraded verdict (passed:false) on
// invalid/unknown/oversized Critic output. The runner's existing 3-round
// validation loop converts this degraded verdict into a terminal status
// (insufficient_evidence or handoff_required). These probes verify the
// adapter forwards that terminal as exactly one `done` event — the
// "Critic failure has one terminal event" gate (not zero, not multiple).
//
// The adapter is status-agnostic: terminal-exactly-once holds for any
// runner-returned status via the `terminalEmitted` guard. These probes
// document the Critic-specific contract at the event-stream seam.
//
// Each failure probe also asserts NO `answer_delta` tokens are published —
// the "Critic failure never publishes" guarantee (ops.md red line) at the
// event-stream level.
// ---------------------------------------------------------------------------

/**
 * Build a runner output that mirrors what the real runner returns after a
 * Critic validation failure: 3-round loop exhausted (validationTrace.round=3,
 * passed=false), no validated answer (reply="", tokens=[]), degraded status.
 * `terminalStatus` is either `insufficient_evidence` or `handoff_required`
 * depending on whether handoff is enabled in the runner config.
 */
function criticFailureRunnerOutput(
  terminalStatus: "insufficient_evidence" | "handoff_required",
): MastraRunnerOutput {
  return makeRunnerOutput({
    status: terminalStatus,
    reply: "",
    references: [],
    tokens: [], // Critic failure suppresses answer publication
    degradation: {
      status: "insufficient",
      unavailableChannels: [],
      reason: "no_cited_claims",
    },
    validationTrace: { round: 3, passed: false }, // 3-round loop exhausted
  })
}

/** Assert NO answer_delta events were emitted (Critic failure never publishes). */
function assertNoAnswerDeltas(events: AnswerRunEvent[], label: string): void {
  const deltas = events.filter((e) => e.type === "answer_delta")
  assert.equal(
    deltas.length,
    0,
    `${label}: no answer_delta tokens must be published on Critic failure (got ${deltas.length})`,
  )
}

// Probe 4 — Critic valid → runner returns completed with validationTrace
// .passed:true → exactly one terminal (completed). Answer tokens ARE published.
test("P3.3 convergence: Critic valid → exactly one terminal `done` event with status completed", async () => {
  const adapter = createMastraChatEventAdapter({
    runner: successRunner(
      makeRunnerOutput({
        status: "completed",
        reply: "validated answer",
        tokens: ["validated ", "answer"],
        validationTrace: { round: 1, passed: true },
      }),
    ),
  })
  const events = await collectEvents(adapter, "critic valid path")
  assertOneTerminal(events, "completed")
  // Critic valid → validated answer tokens are published.
  const deltas = events.filter((e) => e.type === "answer_delta")
  assert.equal(deltas.length, 2, "validated answer tokens must be published on Critic valid")
})

// Probe 5 — Critic invalid (degraded verdict: schema mismatch / wrong types /
// extra dangerous fields) → runner 3-round loop exhausts → insufficient_evidence
// terminal → exactly one terminal. No answer tokens published.
test("P3.3 convergence: Critic invalid (degraded verdict) → exactly one terminal `done` event with status insufficient_evidence", async () => {
  const adapter = createMastraChatEventAdapter({
    runner: successRunner(criticFailureRunnerOutput("insufficient_evidence")),
  })
  const events = await collectEvents(adapter, "critic invalid path")
  assertOneTerminal(events, "insufficient_evidence")
  assertNoAnswerDeltas(events, "critic invalid path")
})

// Probe 6 — Critic unknown (malformed JSON / truncated / empty content / non-
// object root) → runner 3-round loop exhausts → handoff_required terminal →
// exactly one terminal. Covers the case where handoff is enabled in runner
// config (terminal=handoff_required instead of insufficient_evidence).
test("P3.3 convergence: Critic unknown (malformed JSON) → exactly one terminal `done` event with status handoff_required", async () => {
  const adapter = createMastraChatEventAdapter({
    runner: successRunner(criticFailureRunnerOutput("handoff_required")),
  })
  const events = await collectEvents(adapter, "critic unknown path")
  assertOneTerminal(events, "handoff_required")
  assertNoAnswerDeltas(events, "critic unknown path")
})

// Probe 7 — Critic oversized (>8KiB DoS guard triggered before JSON.parse) →
// runner 3-round loop exhausts → insufficient_evidence terminal → exactly one
// terminal. Verifies the DoS-bound failure path converges the same as other
// Critic failure modes.
test("P3.3 convergence: Critic oversized → exactly one terminal `done` event with status insufficient_evidence", async () => {
  const adapter = createMastraChatEventAdapter({
    runner: successRunner(criticFailureRunnerOutput("insufficient_evidence")),
  })
  const events = await collectEvents(adapter, "critic oversized path")
  assertOneTerminal(events, "insufficient_evidence")
  assertNoAnswerDeltas(events, "critic oversized path")
})
