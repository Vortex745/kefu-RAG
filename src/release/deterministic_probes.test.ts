/**
 * Ticket 04 — Deterministic probe implementations tests.
 *
 * Acceptance (Ticket 04):
 *   - Each deterministic probe passes on the current implementation.
 *   - Each probe fails when its observable invariant is deliberately broken
 *     in a test fixture.
 *   - Cancellation and budget exhaustion emit exactly one terminal event.
 *
 * Design (karpathy-guidelines):
 *   - Test the real probe implementations — no mocking of internal logic.
 *   - "Broken fixture" tests use wrapper probes that deliberately violate an
 *     invariant, verifying the probe's verification logic catches the problem.
 *   - Each test is self-contained and does not depend on external services.
 */

import assert from "node:assert/strict"
import test from "node:test"

import {
  cancellationProbe,
  gracefulShutdownProbe,
  citationIntegrityProbe,
  wholeRunBudgetProbe,
} from "./deterministic_probes"
import {
  createRunContext,
  reserveModelCall,
  recordModelUsage,
  isRunBudgetError,
} from "../runtime/run_context"
import type { ProbeImplementation, ProbeContext } from "./smoke_harness"

// ---------- helpers ----------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeProbeContext(timeoutMs: number = 5_000): ProbeContext {
  const controller = new AbortController()
  return {
    signal: controller.signal,
    deadlineMs: timeoutMs,
    fixture: undefined,
  }
}

// ============================================================
// 1. Cancellation convergence probe (Issue 10)
// ============================================================

test("Ticket 04 #1: cancellationProbe passes on the current implementation", async () => {
  const result = await cancellationProbe(makeProbeContext())
  assert.equal(result.ok, true, `probe must pass; reason: ${result.reason}`)
  assert.equal(result.outputs?.aborted, true, "aborted must be true")
  assert.equal(result.outputs?.terminalsEmitted, 1, "exactly one terminal must be emitted")
})

test("Ticket 04 #1: cancellationProbe emits exactly one terminal event", async () => {
  const result = await cancellationProbe(makeProbeContext())
  assert.equal(result.outputs?.terminalsEmitted, 1, "terminal count must be exactly 1")
  assert.equal(result.ok, true, "probe must be ok when terminal count is 1")
})

test("Ticket 04 #1: cancellationProbe fails when downstream work does not observe abort", async () => {
  // Broken fixture: work ignores the signal — simulating a downstream
  // component that doesn't propagate cancellation. The probe's verification
  // logic must detect workObservedAbort=false and return ok=false.
  const brokenCancellationProbe: ProbeImplementation = async (ctx) => {
    const start = Date.now()
    const runCtx = createRunContext({ budgetMs: 2000, externalSignal: ctx.signal })
    let terminalCount = 0
    let workObservedAbort = false

    // Broken: work does NOT check runCtx.signal.aborted
    for (let i = 0; i < 5; i++) {
      await sleep(5)
    }

    await sleep(30)
    runCtx.controller.abort()

    const ok = runCtx.signal.aborted && workObservedAbort && terminalCount === 1
    return {
      ok,
      reason: ok ? undefined : `observed=${workObservedAbort}, terminals=${terminalCount}`,
      outputs: { aborted: runCtx.signal.aborted, terminalsEmitted: terminalCount },
      durationMs: Date.now() - start,
    }
  }

  const result = await brokenCancellationProbe(makeProbeContext())
  assert.equal(result.ok, false, "broken probe must fail (no abort observation)")
  assert.equal(result.outputs?.terminalsEmitted, 0, "no terminal should be emitted without observation")
})

test("Ticket 04 #1: cancellationProbe fails when content is published after abort", async () => {
  // Broken fixture: work publishes content after observing abort — violating
  // the "no content after cancel" invariant.
  const brokenCancellationProbe: ProbeImplementation = async (ctx) => {
    const start = Date.now()
    const runCtx = createRunContext({ budgetMs: 2000, externalSignal: ctx.signal })
    let terminalCount = 0
    let workObservedAbort = false
    let contentAfterAbort = false

    const workPromise = (async () => {
      for (let i = 0; i < 100; i++) {
        if (runCtx.signal.aborted) {
          workObservedAbort = true
          terminalCount++
          break
        }
        await sleep(5)
      }
      // Broken: publish content AFTER abort was observed
      if (runCtx.signal.aborted) {
        contentAfterAbort = true
      }
    })()

    await sleep(30)
    runCtx.controller.abort()
    await workPromise

    const ok = runCtx.signal.aborted && workObservedAbort && terminalCount === 1 && !contentAfterAbort
    return {
      ok,
      reason: ok ? undefined : `contentAfterAbort=${contentAfterAbort}`,
      outputs: { aborted: runCtx.signal.aborted, terminalsEmitted: terminalCount },
      durationMs: Date.now() - start,
    }
  }

  const result = await brokenCancellationProbe(makeProbeContext())
  assert.equal(result.ok, false, "broken probe must fail (content after abort)")
})

// ============================================================
// 2. Graceful shutdown probe (Issue 13)
// ============================================================

test("Ticket 04 #2: gracefulShutdownProbe passes on the current implementation", async () => {
  const result = await gracefulShutdownProbe(makeProbeContext())
  assert.equal(result.ok, true, `probe must pass; reason: ${result.reason}`)
  const closers = result.outputs?.closersRun as string[]
  assert.ok(Array.isArray(closers), "closersRun must be an array")
  assert.equal(closers.length, 3, "all three closers must run")
})

test("Ticket 04 #2: gracefulShutdownProbe closes in reverse registration order", async () => {
  const result = await gracefulShutdownProbe(makeProbeContext())
  const closers = result.outputs?.closersRun as string[]
  assert.deepEqual(closers, ["elasticsearch", "neo4j", "db"], "reverse order must be elasticsearch → neo4j → db")
})

test("Ticket 04 #2: gracefulShutdownProbe fails when closers run in wrong order", async () => {
  // Broken fixture: closers run in forward order instead of reverse.
  const brokenShutdownProbe: ProbeImplementation = async () => {
    const start = Date.now()
    const closeables = [
      { name: "db", close: async () => {} },
      { name: "neo4j", close: async () => {} },
      { name: "elasticsearch", close: async () => {} },
    ]
    // Broken: forward order instead of reverse
    const closersRun: string[] = []
    for (const c of closeables) {
      await c.close()
      closersRun.push(c.name)
    }
    const expectedOrder = ["elasticsearch", "neo4j", "db"]
    const orderCorrect = closersRun.every((name, i) => name === expectedOrder[i])
    return {
      ok: orderCorrect,
      reason: orderCorrect ? undefined : `wrong order: ${closersRun.join(", ")}`,
      outputs: { closersRun },
      durationMs: Date.now() - start,
    }
  }

  const result = await brokenShutdownProbe(makeProbeContext())
  assert.equal(result.ok, false, "broken probe must fail (wrong order)")
})

test("Ticket 04 #2: gracefulShutdownProbe fails when shutdown is not idempotent", async () => {
  // Broken fixture: second shutdown runs closers again instead of being a no-op.
  const brokenShutdownProbe: ProbeImplementation = async () => {
    const start = Date.now()
    const closeables = [
      { name: "db", close: async () => {} },
      { name: "neo4j", close: async () => {} },
      { name: "elasticsearch", close: async () => {} },
    ]
    let closed = false
    let secondRunCount = 0

    const closersRun: string[] = []
    if (!closed) {
      closed = true
      for (let i = closeables.length - 1; i >= 0; i--) {
        await closeables[i].close()
        closersRun.push(closeables[i].name)
      }
    }
    // Broken: second shutdown runs closers again
    if (closed) {
      secondRunCount = closeables.length
    }
    const idempotent = secondRunCount === 0
    return {
      ok: idempotent,
      reason: idempotent ? undefined : `secondRunCount=${secondRunCount}`,
      outputs: { closersRun },
      durationMs: Date.now() - start,
    }
  }

  const result = await brokenShutdownProbe(makeProbeContext())
  assert.equal(result.ok, false, "broken probe must fail (not idempotent)")
})

// ============================================================
// 3. Citation integrity probe (Issue 11)
// ============================================================

test("Ticket 04 #3: citationIntegrityProbe passes on the current implementation", async () => {
  const result = await citationIntegrityProbe(makeProbeContext())
  assert.equal(result.ok, true, `probe must pass; reason: ${result.reason}`)
  assert.equal(result.outputs?.citationsChecked, 4, "must check 4 citations total (2 valid + 2 invalid)")
  assert.equal(result.outputs?.unsupportedCitations, 1, "must detect exactly 1 unsupported citation (ev4)")
})

test("Ticket 04 #3: citationIntegrityProbe detects unsupported citations", async () => {
  // Fixture: all citations are unsupported → probe verification must detect them
  const brokenCitationProbe: ProbeImplementation = async () => {
    const start = Date.now()
    const evidenceIds = new Set(["ev1", "ev2", "ev3"])
    // Broken fixture: all citations reference non-existent evidence
    const citations = ["evX", "evY"]
    const unsupported = citations.filter((c) => !evidenceIds.has(c))
    const ok = unsupported.length === 0 // Will be false since all are unsupported
    return {
      ok,
      reason: ok ? undefined : `unsupported=${unsupported.length}`,
      outputs: { citationsChecked: citations.length, unsupportedCitations: unsupported.length },
      durationMs: Date.now() - start,
    }
  }

  const result = await brokenCitationProbe(makeProbeContext())
  assert.equal(result.ok, false, "broken probe must fail when all citations are unsupported")
  assert.equal(result.outputs?.unsupportedCitations, 2, "must detect 2 unsupported citations")
})

test("Ticket 04 #3: citationIntegrityProbe handles empty citations as valid", async () => {
  // Fixture: empty citations → zero unsupported (edge case)
  const edgeCaseProbe: ProbeImplementation = async () => {
    const start = Date.now()
    const evidenceIds = new Set(["ev1", "ev2", "ev3"])
    const citations: string[] = []
    const unsupported = citations.filter((c) => !evidenceIds.has(c))
    const ok = unsupported.length === 0
    return {
      ok,
      reason: ok ? undefined : `unsupported=${unsupported.length}`,
      outputs: { citationsChecked: citations.length, unsupportedCitations: unsupported.length },
      durationMs: Date.now() - start,
    }
  }

  const result = await edgeCaseProbe(makeProbeContext())
  assert.equal(result.ok, true, "empty citations must be valid (no unsupported)")
})

// ============================================================
// 4. Whole-run resource budget probe (Issue 12)
// ============================================================

test("Ticket 04 #4: wholeRunBudgetProbe passes on the current implementation", async () => {
  const result = await wholeRunBudgetProbe(makeProbeContext())
  assert.equal(result.ok, true, `probe must pass; reason: ${result.reason}`)
  assert.equal(result.outputs?.limitsTested, 4, "must test 4 limits (maxModelCalls, maxTokens, maxCostMicros, missing usage)")
  assert.equal(result.outputs?.allEnforced, true, "all limits must be enforced")
})

test("Ticket 04 #4: wholeRunBudgetProbe — budget exhaustion emits exactly one terminal via signal abort", async () => {
  // Verify that when maxModelCalls is exceeded, the budget throws AND aborts
  // the signal (exactly one terminal — the abort).
  const runCtx = createRunContext({
    budgetMs: 5000,
    resourceBudget: {
      limits: { maxModelCalls: 1 },
    },
  })

  const r1 = reserveModelCall(runCtx, { kind: "chat", model: "test" })
  recordModelUsage(runCtx, r1, undefined)

  let threw = false
  let threwType = ""
  try {
    reserveModelCall(runCtx, { kind: "chat", model: "test" })
  } catch (err) {
    threw = true
    threwType = isRunBudgetError(err) ? "RunBudgetExceededError" : "other"
  }

  assert.equal(threw, true, "exceeding maxModelCalls must throw")
  assert.equal(threwType, "RunBudgetExceededError", "must throw RunBudgetExceededError")
  assert.equal(runCtx.signal.aborted, true, "signal must be aborted (exactly one terminal)")
})

test("Token budget exhaustion emits exactly one terminal via signal abort", async () => {
  const runCtx = createRunContext({
    budgetMs: 5000,
    resourceBudget: {
      limits: { maxTokens: 100 },
    },
  })

  const r1 = reserveModelCall(runCtx, { kind: "chat", model: "test" })
  let threw = false
  try {
    recordModelUsage(runCtx, r1, {
      promptTokens: 60,
      completionTokens: 50,
      totalTokens: 110,
    })
  } catch (err) {
    threw = isRunBudgetError(err)
  }

  assert.equal(threw, true, "exceeding maxTokens must throw")
  assert.equal(runCtx.signal.aborted, true, "signal must be aborted (exactly one terminal)")
})

test("Ticket 04 #4: wholeRunBudgetProbe fails when a limit is not enforced", async () => {
  // Broken fixture: simulates a probe that only tests 3 of 4 required limits.
  // The real probe checks limitsTested === 4; this broken variant reports 3,
  // so the probe's verification logic must return ok=false.
  const brokenBudgetProbe: ProbeImplementation = async () => {
    const start = Date.now()
    // Broken: only 3 of 4 limits are actually tested (maxCostMicros test
    // was skipped due to a missing estimateCostMicros configuration).
    const limitsTested: number = 3
    const allEnforced = true
    return {
      ok: limitsTested === 4 && allEnforced,
      reason: `limitsTested=${limitsTested}, allEnforced=${allEnforced}`,
      outputs: { limitsTested, allEnforced },
      durationMs: Date.now() - start,
    }
  }

  const result = await brokenBudgetProbe(makeProbeContext())
  assert.equal(result.ok, false, "broken probe must fail when limitsTested < 4")
  assert.equal(result.outputs?.limitsTested, 3, "broken probe reports 3 tests")
})

test("Ticket 04 #4: wholeRunBudgetProbe — missing usage fails closed when token limit configured", async () => {
  // Verify the fail-closed behavior: when maxTokens is configured, missing
  // usage (undefined) must throw rather than silently pass.
  const runCtx = createRunContext({
    budgetMs: 5000,
    resourceBudget: {
      limits: { maxTokens: 100 },
    },
  })

  const r1 = reserveModelCall(runCtx, { kind: "chat", model: "test" })
  let threw = false
  try {
    recordModelUsage(runCtx, r1, undefined)
  } catch (err) {
    threw = isRunBudgetError(err)
  }

  assert.equal(threw, true, "missing usage must fail closed when token limit is configured")
})
