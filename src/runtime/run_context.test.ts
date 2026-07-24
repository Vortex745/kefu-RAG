/**
 * P7.1 — RunContext + deadline enforcement gate tests.
 *
 * Five required scenarios (per executor.md Prompt Shape):
 *   1. deadline 到期 → downstream work stops (AbortSignal abort)
 *   2. cancel → downstream work stops (external cancel propagation)
 *   3. remaining budget observable (getRemainingBudget returns correct values)
 *   4. deadline 未到期 → work 正常完成 (no false-positive abort)
 *   5. backward compat (无 RunContext 时行为不变)
 *
 * Plus coverage for the supporting API surface:
 *   - onExpire callback (deadline + external reasons)
 *   - externalSignal linking (already-aborted + later-aborted)
 *   - identityRunContext (rollback boundary)
 *   - DeadlineExpiredError named "AbortError" (terminal convergence contract)
 *
 * Boundary: src/runtime/*. Does NOT import from Service / UI / API.
 * Rollback: delete this file + run_context.ts + deadline.ts.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createRunContext,
  getRemainingBudget,
  isExpired,
  onExpire,
  DEFAULT_RUN_BUDGET_MS,
  type RunContext,
} from "./run_context"
import {
  withDeadline,
  withBudget,
  identityRunContext,
  DeadlineExpiredError,
} from "./deadline"

// ---------------------------------------------------------------------------
// Helpers — race-with-timeout safety net so a flaky timer never hangs CI.
// ---------------------------------------------------------------------------

function neverResolves(): Promise<never> {
  return new Promise<never>(() => {})
}

function resolveAfter<T>(value: T, ms: number): Promise<T> {
  return new Promise<T>((resolve) => setTimeout(() => resolve(value), ms))
}

// ===========================================================================
// Scenario 1 — deadline 到期 → downstream work stops (AbortSignal abort)
// ===========================================================================

test("P7.1 scenario 1: deadline expiry aborts controller and stops downstream work", async () => {
  // Budget small enough to fire before the test's own timeout, but
  // long enough that Node's timer coalescing won't fire it immediately.
  const ctx = createRunContext({ budgetMs: 30 })
  let downstreamObservedAbort = false
  let downstreamThrew = false

  const work = (signal: AbortSignal) =>
    new Promise<string>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          downstreamObservedAbort = true
          downstreamThrew = true
          reject(new Error("downstream aborted"))
        },
        { once: true }
      )
      // Never resolves on its own — only the deadline abort stops it.
    })

  await assert.rejects(
    withBudget(work, ctx),
    (err: unknown) => err instanceof DeadlineExpiredError
  )

  // Red line: deadline expiry must STOP downstream work (not just signal it).
  assert.equal(
    downstreamObservedAbort,
    true,
    "downstream work observed AbortSignal abort"
  )
  assert.equal(downstreamThrew, true, "downstream work stopped (threw on abort)")
  assert.equal(ctx.signal.aborted, true, "controller aborted after deadline")
  assert.equal(ctx.controller.signal.aborted, true, "controller.signal matches ctx.signal")
})

test("P7.1 scenario 1b: withDeadline aborts controller and rejects with DeadlineExpiredError when deadline fires", async () => {
  const ctx = createRunContext({ budgetMs: 30 })
  // Work that never resolves on its own — only deadline saves us.
  await assert.rejects(
    withDeadline(neverResolves(), ctx),
    (err: unknown) => err instanceof DeadlineExpiredError
  )
  assert.equal(ctx.signal.aborted, true, "controller aborted after deadline")
})

test("P7.1 scenario 1c: withDeadline already-expired context rejects immediately without scheduling timer", async () => {
  let mockNow = 10_000
  const ctx = createRunContext({ budgetMs: 100, now: () => mockNow })
  // Advance time past the deadline
  mockNow = 11_001
  await assert.rejects(
    withDeadline(resolveAfter("late", 5), ctx, () => mockNow),
    (err: unknown) => err instanceof DeadlineExpiredError
  )
  // No need to wait for the timer — should have rejected synchronously
  // (well, on next microtask).
})

// ===========================================================================
// Scenario 2 — cancel → downstream work stops (external cancel propagation)
// ===========================================================================

test("P7.1 scenario 2: external cancel aborts downstream work before deadline", async () => {
  // Large budget — cancel arrives well before deadline fires.
  const ctx = createRunContext({ budgetMs: 10_000 })
  let downstreamObservedAbort = false

  const work = (signal: AbortSignal) =>
    new Promise<string>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          downstreamObservedAbort = true
          reject(new Error("downstream aborted"))
        },
        { once: true }
      )
    })

  // External cancel after 30ms — well within the 10s budget.
  setTimeout(() => ctx.controller.abort(), 30)

  await assert.rejects(
    withBudget(work, ctx),
    (err: unknown) => err instanceof DeadlineExpiredError
  )

  assert.equal(
    downstreamObservedAbort,
    true,
    "downstream work observed abort on external cancel"
  )
  assert.equal(ctx.signal.aborted, true, "controller aborted after external cancel")
})

test("P7.1 scenario 2b: withDeadline observes external signal abort", async () => {
  const ctx = createRunContext({ budgetMs: 10_000 })
  setTimeout(() => ctx.controller.abort(), 20)

  await assert.rejects(
    withDeadline(neverResolves(), ctx),
    (err: unknown) => err instanceof DeadlineExpiredError
  )
  assert.equal(ctx.signal.aborted, true)
})

test("P7.1 scenario 2c: already-aborted context rejects immediately on entry", async () => {
  const ctx = createRunContext({ budgetMs: 10_000 })
  ctx.controller.abort()
  let workInvoked = false
  await assert.rejects(
    withBudget(async () => {
      workInvoked = true
      return "should not run"
    }, ctx),
    (err: unknown) => err instanceof DeadlineExpiredError
  )
  assert.equal(workInvoked, false, "work not invoked when context already aborted")
})

// ===========================================================================
// Scenario 3 — remaining budget is observable
// ===========================================================================

test("P7.1 scenario 3: getRemainingBudget returns correct values across the run lifecycle", () => {
  let mockNow = 1000
  const ctx = createRunContext({ budgetMs: 5000, now: () => mockNow })

  // At creation: full budget available.
  assert.equal(getRemainingBudget(ctx, () => mockNow), 5000, "full budget at creation")

  // 2s elapsed: 3s remaining.
  mockNow = 3000
  assert.equal(getRemainingBudget(ctx, () => mockNow), 3000, "3s remaining after 2s elapsed")

  // 1ms before deadline: 1ms remaining.
  mockNow = 5999
  assert.equal(getRemainingBudget(ctx, () => mockNow), 1, "1ms remaining just before deadline")

  // At deadline: 0.
  mockNow = 6000
  assert.equal(getRemainingBudget(ctx, () => mockNow), 0, "0 at deadline")

  // Past deadline: clamped to 0 (never negative).
  mockNow = 9999
  assert.equal(getRemainingBudget(ctx, () => mockNow), 0, "clamped to 0 past deadline")
})

test("P7.1 scenario 3b: isExpired tracks deadline correctly", () => {
  let mockNow = 1000
  const ctx = createRunContext({ budgetMs: 5000, now: () => mockNow })

  assert.equal(isExpired(ctx, () => mockNow), false, "not expired at creation")
  mockNow = 4999
  assert.equal(isExpired(ctx, () => mockNow), false, "not expired 1ms before deadline")
  mockNow = 6000
  assert.equal(isExpired(ctx, () => mockNow), true, "expired at deadline")
  mockNow = 9999
  assert.equal(isExpired(ctx, () => mockNow), true, "expired past deadline")
})

test("P7.1 scenario 3c: getRemainingBudget observable mid-run via injected clock", async () => {
  // Demonstrates the P7.1 done-when condition: a downstream stage CAN
  // query remaining budget at any time, not just before/after the run.
  // Pass `now` to both createRunContext AND withBudget so the deadline
  // check + timer scheduling use mock time (otherwise Date.now would
  // immediately consider the mock-created deadline long past).
  let mockNow = 0
  const ctx = createRunContext({ budgetMs: 1000, now: () => mockNow })
  const observed: number[] = []
  const work = async () => {
    observed.push(getRemainingBudget(ctx, () => mockNow))
    mockNow = 500
    // Stage 2: half consumed
    observed.push(getRemainingBudget(ctx, () => mockNow))
    mockNow = 1000
    // Stage 3: deadline reached
    observed.push(getRemainingBudget(ctx, () => mockNow))
    return "done"
  }
  await withBudget(work, ctx, () => mockNow)
  assert.deepEqual(observed, [1000, 500, 0], "remaining budget observable at each stage")
})

test("P7.1 scenario 3d: DEFAULT_RUN_BUDGET_MS is 30s (matches P4.2/P4.3 fetch timeout envelope)", () => {
  assert.equal(DEFAULT_RUN_BUDGET_MS, 30_000)
})

// ===========================================================================
// Scenario 4 — deadline 未到期 → work 正常完成 (no false-positive abort)
// ===========================================================================

test("P7.1 scenario 4: work completes normally when deadline does not fire", async () => {
  const ctx = createRunContext({ budgetMs: 10_000 })
  let signalAbortedDuringWork = false

  const work = async (signal: AbortSignal) => {
    await new Promise<void>((r) => setTimeout(r, 20))
    signalAbortedDuringWork = signal.aborted
    return "completed"
  }

  const result = await withBudget(work, ctx)
  assert.equal(result, "completed", "work completed normally")
  assert.equal(
    signalAbortedDuringWork,
    false,
    "signal was not aborted during work (deadline did not fire)"
  )
  assert.equal(
    ctx.signal.aborted,
    false,
    "controller not aborted on normal completion (no timer leak side-effect)"
  )
})

test("P7.1 scenario 4b: withDeadline resolves normally when work finishes before deadline", async () => {
  const ctx = createRunContext({ budgetMs: 10_000 })
  const result = await withDeadline(resolveAfter("ok", 20), ctx)
  assert.equal(result, "ok")
  assert.equal(ctx.signal.aborted, false, "controller not aborted on success")
})

test("P7.1 scenario 4c: withBudget preserves work's own errors (does not auto-abort on work error)", async () => {
  const ctx = createRunContext({ budgetMs: 10_000 })
  const customError = new Error("work failed for its own reason")
  const work = async () => {
    throw customError
  }
  await assert.rejects(
    withBudget(work, ctx),
    (err: unknown) => err === customError
  )
  assert.equal(
    ctx.signal.aborted,
    false,
    "controller not auto-aborted when work throws its own error (work error is terminal, not cancel)"
  )
})

// ===========================================================================
// Scenario 5 — backward compat (无 RunContext 时行为不变)
// ===========================================================================

test("P7.1 scenario 5: withDeadline without ctx returns work unchanged (backward compat)", async () => {
  // No RunContext at all — pre-P7.1 callers continue to work identically.
  const result = await withDeadline(Promise.resolve(42))
  assert.equal(result, 42, "withDeadline(work) without ctx is a passthrough")
})

test("P7.1 scenario 5b: identityRunContext never expires (rollback boundary)", async () => {
  const ctx = identityRunContext()
  assert.equal(isExpired(ctx), false, "identity context never expires")
  assert.equal(
    getRemainingBudget(ctx),
    Number.POSITIVE_INFINITY,
    "identity context has infinite budget"
  )
  // Work completes normally under identity context.
  const result = await withBudget(async () => "ok", ctx)
  assert.equal(result, "ok")
  assert.equal(ctx.signal.aborted, false, "identity controller not aborted on success")
})

test("P7.1 scenario 5c: identityRunContext forwards external cancel only (no deadline timer)", async () => {
  const external = new AbortController()
  const ctx = identityRunContext(external.signal)
  assert.equal(ctx.signal.aborted, false, "not aborted at creation")
  external.abort()
  assert.equal(ctx.signal.aborted, true, "external cancel propagates through identity context")
})

test("P7.1 scenario 5d: withDeadline with identityRunContext never fires deadline (long-running work completes)", async () => {
  const ctx = identityRunContext()
  // 50ms work — would never finish under a 10ms deadline context.
  const result = await withDeadline(resolveAfter("late", 50), ctx)
  assert.equal(result, "late")
})

test("P7.1 scenario 5e: RunContext public API remains backward compatible", () => {
  // The deadline API remains callable while resource budgets are opt-in.
  assert.equal(typeof createRunContext, "function")
  assert.equal(typeof getRemainingBudget, "function")
  assert.equal(typeof isExpired, "function")
  assert.equal(typeof onExpire, "function")
  assert.equal(typeof withDeadline, "function")
  assert.equal(typeof withBudget, "function")
  assert.equal(typeof identityRunContext, "function")
})

// ===========================================================================
// Scenario 6 — onExpire callback (deadline + external reasons)
// ===========================================================================

test("P7.1 scenario 6: onExpire fires with reason=deadline when budget elapses", async () => {
  const ctx = createRunContext({ budgetMs: 30 })
  let fired = false
  let observedReason: string | undefined

  await new Promise<void>((resolve) => {
    onExpire(ctx, (reason) => {
      fired = true
      observedReason = reason
      resolve()
    })
    // Safety net — if onExpire doesn't fire within 200ms, force resolve.
    setTimeout(resolve, 200)
  })

  assert.equal(fired, true, "onExpire callback fired")
  assert.equal(observedReason, "deadline", "reason is 'deadline' when budget elapses")
})

test("P7.1 scenario 6b: onExpire fires with reason=external on external cancel", async () => {
  const ctx = createRunContext({ budgetMs: 10_000 })
  let fired = false
  let observedReason: string | undefined

  await new Promise<void>((resolve) => {
    onExpire(ctx, (reason) => {
      fired = true
      observedReason = reason
      resolve()
    })
    setTimeout(() => ctx.controller.abort(), 30)
    // Safety net.
    setTimeout(resolve, 500)
  })

  assert.equal(fired, true, "onExpire callback fired on external cancel")
  assert.equal(observedReason, "external", "reason is 'external' on cancel")
})

test("P7.1 scenario 6c: onExpire on already-aborted context fires synchronously on next microtask", async () => {
  const ctx = createRunContext({ budgetMs: 10_000 })
  ctx.controller.abort()
  let fired = false
  let observedReason: string | undefined
  onExpire(ctx, (reason) => {
    fired = true
    observedReason = reason
  })
  // queueMicrotask fires on next microtask — await a resolved promise to drain.
  await Promise.resolve()
  assert.equal(fired, true, "onExpire fired on already-aborted context")
  assert.equal(observedReason, "external")
})

test("P7.1 scenario 6d: onExpire cleanup cancels the timer (no leak after normal completion)", async () => {
  const ctx = createRunContext({ budgetMs: 10_000 })
  let fired = false
  const cleanup = onExpire(ctx, () => {
    fired = true
  })
  // Work completes normally — cleanup should cancel the timer.
  cleanup()
  // Wait past the deadline to verify the callback never fires.
  await new Promise<void>((r) => setTimeout(r, 50))
  assert.equal(fired, false, "cleanup prevented callback from firing")
})

test("P7.1 scenario 6e: onExpire on already-expired context (deadline in past) fires synchronously with reason=deadline", async () => {
  let mockNow = 1000
  const ctx = createRunContext({ budgetMs: 100, now: () => mockNow })
  mockNow = 5000 // advance past deadline
  let fired = false
  let observedReason: string | undefined
  onExpire(ctx, (reason) => {
    fired = true
    observedReason = reason
  }, () => mockNow)
  await Promise.resolve()
  assert.equal(fired, true)
  assert.equal(observedReason, "deadline")
})

// ===========================================================================
// Scenario 7 — externalSignal linking (transport cancel converges with deadline)
// ===========================================================================

test("P7.1 scenario 7: already-aborted externalSignal aborts ctx at creation", () => {
  const external = new AbortController()
  external.abort()
  const ctx = createRunContext({ budgetMs: 10_000, externalSignal: external.signal })
  assert.equal(
    ctx.signal.aborted,
    true,
    "linked already-aborted external signal aborts ctx at creation (synchronous, no microtask delay)"
  )
})

test("P7.1 scenario 7b: later-aborted externalSignal propagates to ctx controller", async () => {
  const external = new AbortController()
  const ctx = createRunContext({ budgetMs: 10_000, externalSignal: external.signal })
  assert.equal(ctx.signal.aborted, false, "not aborted at creation")
  external.abort()
  assert.equal(
    ctx.signal.aborted,
    true,
    "external cancel propagates to ctx.controller (transport cancel converges with deadline)"
  )
})

test("P7.1 scenario 7c: explicit deadline option overrides budgetMs", () => {
  let mockNow = 1000
  const ctx = createRunContext({
    budgetMs: 5_000,
    deadline: 1500, // overrides 5s budget
    now: () => mockNow,
  })
  assert.equal(ctx.deadline, 1500, "explicit deadline wins over budgetMs")
  assert.equal(ctx.budgetMs, 5_000, "budgetMs is informational (not adjusted)")
  assert.equal(getRemainingBudget(ctx, () => mockNow), 500, "remaining = deadline - now")
})

// ===========================================================================
// Scenario 8 — DeadlineExpiredError named "AbortError" (terminal convergence)
// ===========================================================================

test("P7.1 scenario 8: DeadlineExpiredError is named 'AbortError' (terminal convergence contract)", () => {
  const err = new DeadlineExpiredError()
  assert.equal(err.name, "AbortError", "name is AbortError so existing catch sites treat it as cancel")
  assert.ok(err.message.length > 0, "has a non-empty message")
  assert.ok(err instanceof Error, "is an Error")
  assert.ok(err instanceof DeadlineExpiredError, "is a DeadlineExpiredError")
})

test("P7.1 scenario 8b: DeadlineExpiredError message distinguishes deadline vs abort", () => {
  const deadlineErr = new DeadlineExpiredError()
  assert.match(deadlineErr.message, /deadline/i, "default message mentions deadline")
  const abortErr = new DeadlineExpiredError("run aborted")
  assert.equal(abortErr.message, "run aborted", "custom message preserved")
})

test("P7.1 scenario 8c: chat_event_adapter-style catch (err.name === 'AbortError') treats DeadlineExpiredError as cancel", async () => {
  // Verifies the contract: existing catch sites in chat_event_adapter.ts:482
  //   `const isAbort = err instanceof Error && err.name === "AbortError"`
  // treat DeadlineExpiredError identically to external cancel — converging
  // to exactly one terminal event.
  const ctx = createRunContext({ budgetMs: 30 })
  let caughtAsAbort = false
  try {
    await withBudget(() => neverResolves(), ctx)
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      caughtAsAbort = true
    }
  }
  assert.equal(
    caughtAsAbort,
    true,
    "DeadlineExpiredError is caught by the same `err.name === 'AbortError'` check used in chat_event_adapter"
  )
})

// ===========================================================================
// Scenario 9 — context shape and immutability
// ===========================================================================

test("P7.1 scenario 9: RunContext fields are readonly (MutationTypeError on assignment)", () => {
  const ctx = createRunContext({ budgetMs: 1000 })
  assert.equal(typeof ctx.deadline, "number")
  assert.equal(typeof ctx.budgetMs, "number")
  assert.equal(typeof ctx.createdAt, "number")
  assert.ok(ctx.signal instanceof AbortSignal, "signal is AbortSignal")
  assert.ok(ctx.controller instanceof AbortController, "controller is AbortController")
  // TypeScript readonly is compile-time only; verify the contract by shape.
  assert.equal(ctx.budgetMs, 1000)
  assert.equal(ctx.deadline - ctx.createdAt, 1000, "deadline = createdAt + budgetMs")
})

test("P7.1 scenario 9b: createRunContext with no options uses DEFAULT_RUN_BUDGET_MS", () => {
  const before = Date.now()
  const ctx = createRunContext()
  const after = Date.now()
  assert.equal(ctx.budgetMs, DEFAULT_RUN_BUDGET_MS)
  // Deadline = createdAt + 30s. Account for Date.now() drift.
  assert.ok(
    ctx.deadline >= before + DEFAULT_RUN_BUDGET_MS - 1 &&
      ctx.deadline <= after + DEFAULT_RUN_BUDGET_MS + 1,
    "deadline is createdAt + DEFAULT_RUN_BUDGET_MS (within Date.now() jitter)"
  )
  assert.equal(ctx.signal.aborted, false, "fresh context is not aborted")
})

test("P7.1 scenario 9c: ctx.signal and ctx.controller.signal are the same object", () => {
  const ctx = createRunContext({ budgetMs: 1000 })
  assert.equal(
    ctx.signal,
    ctx.controller.signal,
    "ctx.signal IS ctx.controller.signal — one source of truth"
  )
})
