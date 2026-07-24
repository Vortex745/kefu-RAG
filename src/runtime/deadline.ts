/**
 * P7.1 — Deadline enforcement wrappers.
 *
 * Two complementary helpers that turn a `RunContext` into actual cancellation:
 *   - `withDeadline(work, ctx)` — wraps an in-flight promise. When the
 *     deadline fires or the controller aborts, the controller is aborted
 *     (so downstream work observing `ctx.signal` stops) and the wrapped
 *     promise rejects with `DeadlineExpiredError`.
 *   - `withBudget(work, ctx)` — wraps a work function that takes the
 *     AbortSignal as input. Same deadline semantics; the work receives
 *     the signal so it can wire it into its own downstream (the
 *     propagation is P7.2 scope; P7.1 provides the mechanism).
 *
 * Both helpers name their error `AbortError` so existing catch sites
 * (chat_event_adapter.ts:482 `err.name === "AbortError"`, runner
 * `checkAbort`/`abortable` helpers) treat deadline expiry identically to
 * external cancel — converging to one terminal event per the run contract.
 *
 * Rollback (per ledger declared boundary: "identity budget adapter"):
 *   `identityRunContext()` returns a context that never expires and only
 *   forwards an optional external signal. Substituting it for
 *   `createRunContext()` at any call site disables deadline enforcement
 *   without changing call signatures — pure data substitution.
 */

import type { RunContext } from "./run_context"
import { createRunContext, getRemainingBudget, isExpired } from "./run_context"

/**
 * Error thrown when a deadline fires or the controller aborts mid-run.
 *
 * Named `"AbortError"` so existing catch sites that branch on
 * `err.name === "AbortError"` (chat_event_adapter.ts:482, runner helpers)
 * treat deadline expiry identically to external cancel — converging to
 * exactly one terminal event (the P1.1 contract).
 */
export class DeadlineExpiredError extends Error {
  constructor(message: string = "run deadline exceeded") {
    super(message)
    this.name = "AbortError"
  }
}

/**
 * Wrap a promise with deadline enforcement.
 *
 * Behavior:
 *   - If `ctx` is omitted: returns `work` as-is (backward compat — no
 *     RunContext means no enforcement, identical to pre-P7.1 behavior).
 *   - If the deadline already elapsed or the controller is already aborted:
 *     rejects immediately with `DeadlineExpiredError` (no timer scheduled).
 *   - If `getRemainingBudget(ctx)` returns `Infinity` (identity context):
 *     no timer is scheduled — only external abort can fire the rejection.
 *     This is the rollback boundary: `withDeadline(work, identityRunContext())`
 *     resolves when `work` does, with no deadline pressure.
 *   - Otherwise: schedules a timer for `getRemainingBudget(ctx)`. When it
 *     fires: aborts `ctx.controller` (so downstream work observing
 *     `ctx.signal` stops), then rejects with `DeadlineExpiredError`.
 *   - If `work` resolves first: clears the timer and resolves the result.
 *   - If `work` rejects first: clears the timer and propagates the error
 *     unchanged (the controller is NOT auto-aborted — the work's own error
 *     is the terminal).
 *   - If `ctx.signal` fires `abort` mid-flight (external cancel): clears
 *     the timer and rejects with `DeadlineExpiredError`.
 *
 * Note: this helper does NOT itself cancel `work` — JS promises are not
 * cancellable. The actual stop-downstream-work happens via `ctx.controller.abort()`:
 * if `work` is structured to observe `ctx.signal` (e.g. fetch with `{ signal }`,
 * `abortable()` wrappers, `checkAbort()` checkpoints), it will receive the
 * abort and reject/short-circuit. P7.1 provides the mechanism; P7.2 wires
 * the propagation through model/retrieval/publish.
 */
export function withDeadline<T>(
  work: Promise<T>,
  ctx?: RunContext,
  now: () => number = Date.now
): Promise<T> {
  if (!ctx) return work
  if (isExpired(ctx, now) || ctx.signal.aborted) {
    return Promise.reject(
      new DeadlineExpiredError(
        ctx.signal.aborted ? "run aborted" : "run deadline exceeded"
      )
    )
  }
  const remaining = getRemainingBudget(ctx, now)
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      ctx.signal.removeEventListener("abort", onAbort)
      if (timer !== undefined) clearTimeout(timer)
      reject(
        new DeadlineExpiredError(
          ctx.signal.aborted ? "run aborted" : "run deadline exceeded"
        )
      )
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    ctx.signal.addEventListener("abort", onAbort, { once: true })
    // Identity context (infinite budget) — do NOT schedule a timer.
    // `setTimeout(fn, Infinity)` is silently coerced by Node to
    // `setTimeout(fn, 1)` (TimeoutOverflowWarning), which would fire
    // spuriously. Only external abort (via the signal listener) can fire
    // the rejection in this case.
    if (Number.isFinite(remaining)) {
      timer = setTimeout(() => {
        if (settled) return
        settled = true
        ctx.controller.abort()
        ctx.signal.removeEventListener("abort", onAbort)
        reject(new DeadlineExpiredError())
      }, remaining)
    }
    work.then(
      (value) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        ctx.signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (err) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        ctx.signal.removeEventListener("abort", onAbort)
        reject(err)
      }
    )
  })
}

/**
 * Wrap a work function with budget enforcement. The work receives the
 * AbortSignal so it can wire it into its own downstream.
 *
 * Behavior:
 *   - If the deadline already elapsed at entry OR the controller is already
 *     aborted: aborts the controller and throws `DeadlineExpiredError`
 *     immediately (no work invoked).
 *   - If `getRemainingBudget(ctx)` returns `Infinity` (identity context):
 *     no timer is scheduled — only external abort can settle the race.
 *   - Otherwise: schedules a deadline timer. When the timer fires: sets
 *     `deadlineFired`, then calls `ctx.controller.abort()` (synchronously
 *     fires the abort listener registered by `cancelPromise`, which rejects
 *     with `DeadlineExpiredError("run deadline exceeded")`).
 *   - If external cancel arrives (via `ctx.controller.abort()` called
 *     outside this helper): the abort listener fires with `deadlineFired`
 *     still false, so `cancelPromise` rejects with
 *     `DeadlineExpiredError("run aborted")`.
 *   - Uses `Promise.race([workPromise, cancelPromise])` so the wrapping
 *     ALWAYS settles even if `work` does not observe the abort signal.
 *     A no-op `.catch()` is attached to `workPromise` to suppress
 *     `unhandledRejection` if cancel wins the race.
 *   - If `work` resolves first: clears the timer and returns the result.
 *   - If `work` rejects first (before any cancel): propagates the error
 *     unchanged. The controller is NOT auto-aborted — the work's own
 *     error is the terminal.
 *
 * Listener registration order: `cancelPromise` registers its abort
 * listener BEFORE `work(ctx.signal)` is invoked, so when the controller
 * aborts (whether by timer or externally), `cancelPromise`'s listener
 * fires FIRST — guaranteeing the cancel terminal wins the race over any
 * work-side abort handler. This is the structural guarantee that
 * `withBudget` always converges to `DeadlineExpiredError` on cancel,
 * never to a downstream-specific error shape.
 *
 * The distinction between "external cancel" and "deadline cancel" is
 * observable via the error message ("run aborted" vs "run deadline
 * exceeded") but both share `name = "AbortError"`, satisfying the red
 * line "Every cancellation, timeout, outage, invalid Critic response,
 * and unknown citation must converge to one terminal event" (ops.md).
 */
export async function withBudget<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ctx: RunContext,
  now: () => number = Date.now
): Promise<T> {
  if (isExpired(ctx, now) || ctx.signal.aborted) {
    ctx.controller.abort()
    throw new DeadlineExpiredError(
      ctx.signal.aborted ? "run aborted" : "run deadline exceeded"
    )
  }
  const remaining = getRemainingBudget(ctx, now)

  let timer: ReturnType<typeof setTimeout> | undefined
  let deadlineFired = false

  // cancelPromise settles (rejects) when EITHER the deadline timer fires
  // OR an external abort arrives. Registered BEFORE work(ctx.signal) so
  // its listener fires first when the controller aborts (AbortSignal
  // dispatches listeners in registration order).
  const cancelPromise = new Promise<never>((_resolve, reject) => {
    ctx.signal.addEventListener(
      "abort",
      () => {
        reject(
          new DeadlineExpiredError(
            deadlineFired ? "run deadline exceeded" : "run aborted"
          )
        )
      },
      { once: true }
    )
    // Identity context (infinite budget) — no timer scheduled. Only
    // external abort can settle the race.
    if (Number.isFinite(remaining)) {
      timer = setTimeout(() => {
        deadlineFired = true
        // controller.abort() fires the abort listener synchronously,
        // which calls reject() on cancelPromise. No need to reject here.
        ctx.controller.abort()
      }, remaining)
    }
  })

  const workPromise = work(ctx.signal)
  // Suppress potential unhandledRejection if cancel wins the race and
  // work later rejects (because the abort triggered its own listener).
  // Does NOT replace workPromise — Promise.race still sees work's
  // rejection if work settles first.
  workPromise.catch(() => {})

  try {
    return await Promise.race([workPromise, cancelPromise])
  } catch (err) {
    // DeadlineExpiredError came from cancelPromise — propagate as-is.
    if (err instanceof DeadlineExpiredError) throw err
    // Work rejected with its own error before any cancel — propagate unchanged.
    throw err
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Identity adapter — produces a RunContext that never expires and only
 * forwards an optional external cancel signal. This is the declared
 * rollback boundary for P7.1 ("identity budget adapter"): substituting it
 * for any `createRunContext()` call disables deadline enforcement without
 * changing call signatures or downstream propagation wiring (P7.2).
 *
 * `getRemainingBudget(identityRunContext())` always returns
 * `Number.POSITIVE_INFINITY`; `isExpired(...)` always returns `false`;
 * `withDeadline(work, identityRunContext())` skips timer scheduling via
 * the `Number.isFinite(remaining)` guard — only external abort (via the
 * signal listener) can fire the rejection. Resolves when `work` does.
 *
 * Use cases:
 *   - Rollback: temporarily disable deadline enforcement at a call site
 *     without code-shape change.
 *   - Tests: a context that participates in the RunContext contract but
 *     imposes no time pressure.
 *   - Background jobs that should run to completion regardless of the
 *     transport signal (omit `externalSignal` too).
 */
export function identityRunContext(externalSignal?: AbortSignal): RunContext {
  return createRunContext({
    budgetMs: Number.POSITIVE_INFINITY,
    externalSignal,
  })
}
