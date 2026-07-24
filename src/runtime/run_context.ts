import { AsyncLocalStorage } from "node:async_hooks"

/**
 * P7.1 — Run context: deadline / budget / AbortSignal.
 *
 * Formalizes the run-level time budget so that:
 *   - a deadline (wall-clock timestamp) is observable from any code with the
 *     context (P7.1 done-when: "remaining budget is observable");
 *   - cancel propagation can stop downstream work: an AbortController is the
 *     single source of truth that downstream stages (P7.2 scope) will honor;
 *   - an external transport cancel signal (e.g. `AnswerRunOptions.signal`
 *     already wired through `chat_event_adapter.ts` since P1.1) is linked
 *     into the controller, so cancel from any source converges to one abort.
 *
 * The context is additive: callers that do not adopt RunContext behave
 * exactly as before, while the Answer adapter can opt into shared budgets.
 *
 * Dependency direction: Runtime layer. Imports only Types-adjacent stdlib
 * (`node:crypto` not needed here). Does NOT import from Service / UI / API.
 *
 * Rollback boundary (per ledger): identity budget adapter — `identityRunContext()`
 * in `./deadline` produces a context that never expires and forwards an
 * optional external signal only; reverting P7.1 means deleting these files
 * OR substituting
 * `identityRunContext()` for any `createRunContext()` call site.
 */

/**
 * Run-level context carrying deadline + budget + abort signal.
 *
 * The `controller` field is intentionally exposed: deadline enforcement
 * (`withDeadline` / `withBudget` in `./deadline`) needs to abort the
 * controller when the deadline fires. Callers that only consume the
 * context (downstream stages in P7.2) read `signal` and never touch the
 * controller — the controller is the producer side.
 */
export type ModelCallKind = "chat" | "embedding"

export interface ModelCallDescriptor {
  readonly kind: ModelCallKind
  readonly model: string
}

export interface ModelUsage {
  readonly promptTokens: number
  readonly completionTokens: number
  readonly totalTokens: number
}

export interface RunResourceBudgetLimits {
  readonly maxModelCalls?: number
  readonly maxTokens?: number
  readonly maxCostMicros?: number
}

export interface RunResourceBudgetSnapshot {
  readonly modelCalls: number
  readonly promptTokens: number
  readonly completionTokens: number
  readonly totalTokens: number
  readonly costMicros: number
  readonly limits: RunResourceBudgetLimits
}

export interface RunResourceBudgetOptions {
  readonly limits?: RunResourceBudgetLimits
  readonly estimateCostMicros?: (
    call: ModelCallDescriptor,
    usage: ModelUsage
  ) => number | undefined
}

export interface ModelTokenPricing {
  readonly inputCostMicrosPerMillionTokens: number
  readonly outputCostMicrosPerMillionTokens: number
}

export interface RunResourceBudgetAuthority {
  readonly limits: RunResourceBudgetLimits
  snapshot(): RunResourceBudgetSnapshot
}

export interface ModelCallReservation {
  readonly id: number
  readonly call: ModelCallDescriptor
  readonly authority: RunResourceBudgetAuthority
}

export type RunBudgetDimension = "model_calls" | "tokens" | "cost_micros"

export class RunBudgetExceededError extends Error {
  readonly code = "RUN_BUDGET_EXCEEDED"

  constructor(
    readonly dimension: RunBudgetDimension,
    readonly limit: number,
    readonly actual: number
  ) {
    super(`run ${dimension} budget exceeded: ${actual} > ${limit}`)
    this.name = "AbortError"
  }
}

export class RunBudgetAccountingError extends Error {
  readonly code = "RUN_BUDGET_ACCOUNTING_ERROR"

  constructor(message: string) {
    super(message)
    this.name = "AbortError"
  }
}

interface ReservationState {
  call: ModelCallDescriptor
  fingerprint?: string
}

interface ResourceBudgetState {
  readonly estimateCostMicros?: RunResourceBudgetOptions["estimateCostMicros"]
  readonly reservations: Map<number, ReservationState>
  nextReservationId: number
  modelCalls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  costMicros: number
  failure?: "exceeded" | "accounting"
}

const resourceBudgetStates = new WeakMap<
  RunResourceBudgetAuthority,
  ResourceBudgetState
>()
const runContextStorage = new AsyncLocalStorage<RunContext>()

export interface RunContext {
  /** Wall-clock deadline (timestamp, ms). Equal to `createdAt + budgetMs`. */
  readonly deadline: number
  /** Original budget in ms (informational; the deadline is authoritative). */
  readonly budgetMs: number
  /** Creation timestamp (ms). */
  readonly createdAt: number
  /** AbortSignal triggered when the deadline fires or an external cancel arrives. */
  readonly signal: AbortSignal
  /** Controller that owns `signal`. Producer side; consumers should not abort. */
  readonly controller: AbortController
  /** Single authority for aggregate model calls, tokens, and cost in this run. */
  readonly resourceBudget: RunResourceBudgetAuthority
}

/**
 * Default per-run budget. Mirrors the per-hop fetch timeout (P4.2/P4.3
 * `URL_FETCH_TIMEOUT_MS = 30_000`) so a single run gets the same time
 * envelope as one URL fetch — bounded by design.
 */
export const DEFAULT_RUN_BUDGET_MS = 30_000

export interface CreateRunContextOptions {
  /** Budget in ms from creation. Defaults to `DEFAULT_RUN_BUDGET_MS`. */
  budgetMs?: number
  /**
   * Optional explicit deadline timestamp (ms). Overrides `budgetMs` when set.
   * Useful for composing with a parent context (parent.deadline - now()).
   */
  deadline?: number
  /**
   * Optional external cancel signal linked into the controller. When the
   * external signal aborts, this context's controller aborts too — so
   * transport-level cancel (e.g. Express `req` close via `AnswerRunOptions.signal`)
   * converges with deadline expiry into one AbortSignal for downstream work.
   */
  externalSignal?: AbortSignal
  /** Optional clock for tests. Defaults to `Date.now`. */
  now?: () => number
  /** Optional whole-run model call, token, and cost limits. Omitted = unlimited. */
  resourceBudget?: RunResourceBudgetOptions
}

/**
 * Create a RunContext with a deadline + budget + linked AbortController.
 *
 * The controller is NOT auto-aborted when the deadline fires — that is the
 * caller's responsibility (`withDeadline` / `withBudget` in `./deadline` do
 * it; a long-lived owner can call `onExpire` directly to wire its own
 * side-effect). This separation lets one RunContext be shared through
 * deeply-nested call chains without implicit timers.
 *
 * If `externalSignal` is already aborted at creation, the controller is
 * constructed aborted (so `signal.aborted` is true immediately —
 * downstream work observes the cancel without delay).
 */
export function createRunContext(options: CreateRunContextOptions = {}): RunContext {
  const now = options.now ?? Date.now
  const createdAt = now()
  const budgetMs = options.budgetMs ?? DEFAULT_RUN_BUDGET_MS
  const deadline = options.deadline ?? createdAt + budgetMs
  const controller = new AbortController()
  if (options.externalSignal) {
    linkExternalSignal(options.externalSignal, controller)
  }
  return {
    deadline,
    budgetMs,
    createdAt,
    signal: controller.signal,
    controller,
    resourceBudget: createResourceBudgetAuthority(options.resourceBudget),
  }
}

/** Run work with this exact RunContext available to provider-level adapters. */
export function runWithRunContext<T>(ctx: RunContext, work: () => T): T {
  return runContextStorage.run(ctx, work)
}

/** Current Answer run context, or undefined outside an instrumented run. */
export function getCurrentRunContext(): RunContext | undefined {
  return runContextStorage.getStore()
}

export function getRunResourceBudgetSnapshot(
  ctx: RunContext
): RunResourceBudgetSnapshot {
  return ctx.resourceBudget.snapshot()
}

/** Reserve one provider call synchronously before any async invocation starts. */
export function reserveModelCall(
  ctx: RunContext,
  call: ModelCallDescriptor
): ModelCallReservation {
  const state = getResourceBudgetState(ctx.resourceBudget)
  const nextCount = state.modelCalls + 1
  const limit = ctx.resourceBudget.limits.maxModelCalls
  if (limit !== undefined && nextCount > limit) {
    state.failure = "exceeded"
    ctx.controller.abort()
    throw new RunBudgetExceededError("model_calls", limit, nextCount)
  }

  state.modelCalls = nextCount
  const id = state.nextReservationId++
  const normalizedCall = Object.freeze({ ...call })
  state.reservations.set(id, { call: normalizedCall })
  return Object.freeze({ id, call: normalizedCall, authority: ctx.resourceBudget })
}

/**
 * Settle a reserved call exactly once. An identical duplicate is idempotent;
 * a conflicting duplicate fails closed instead of corrupting aggregate usage.
 */
export function recordModelUsage(
  ctx: RunContext,
  reservation: ModelCallReservation,
  usage?: ModelUsage
): RunResourceBudgetSnapshot {
  if (reservation.authority !== ctx.resourceBudget) {
    return failAccounting(ctx, "model call reservation belongs to another run")
  }
  const state = getResourceBudgetState(ctx.resourceBudget)
  const reservationState = state.reservations.get(reservation.id)
  if (!reservationState) {
    return failAccounting(ctx, "unknown model call reservation")
  }

  const fingerprint = usage
    ? `${usage.promptTokens}:${usage.completionTokens}:${usage.totalTokens}`
    : "none"
  if (reservationState.fingerprint !== undefined) {
    if (reservationState.fingerprint !== fingerprint) {
      return failAccounting(ctx, "conflicting usage for an already-settled model call")
    }
    return ctx.resourceBudget.snapshot()
  }

  const { maxTokens, maxCostMicros } = ctx.resourceBudget.limits
  if (!usage) {
    if (maxTokens !== undefined || maxCostMicros !== undefined) {
      return failAccounting(
        ctx,
        "provider usage is required when token or cost budgets are configured"
      )
    }
    reservationState.fingerprint = fingerprint
    return ctx.resourceBudget.snapshot()
  }
  try {
    validateUsage(usage)
  } catch (error) {
    return failAccounting(
      ctx,
      error instanceof Error ? error.message : "provider usage is invalid"
    )
  }

  let estimatedCost: number | undefined
  try {
    estimatedCost = state.estimateCostMicros?.(reservationState.call, usage)
    if (estimatedCost !== undefined) {
      validateNonNegativeInteger("estimated cost", estimatedCost)
    }
  } catch (error) {
    return failAccounting(
      ctx,
      error instanceof Error ? error.message : "cost estimate is invalid"
    )
  }
  if (maxCostMicros !== undefined && estimatedCost === undefined) {
    return failAccounting(
      ctx,
      `cost estimate unavailable for model "${reservationState.call.model}"`
    )
  }

  reservationState.fingerprint = fingerprint
  state.promptTokens += usage.promptTokens
  state.completionTokens += usage.completionTokens
  state.totalTokens += usage.totalTokens
  state.costMicros += estimatedCost ?? 0

  if (maxTokens !== undefined && state.totalTokens > maxTokens) {
    state.failure = "exceeded"
    ctx.controller.abort()
    throw new RunBudgetExceededError("tokens", maxTokens, state.totalTokens)
  }
  if (maxCostMicros !== undefined && state.costMicros > maxCostMicros) {
    state.failure = "exceeded"
    ctx.controller.abort()
    throw new RunBudgetExceededError("cost_micros", maxCostMicros, state.costMicros)
  }
  return ctx.resourceBudget.snapshot()
}

export function runBudgetRequiresUsage(ctx: RunContext): boolean {
  const limits = ctx.resourceBudget.limits
  const state = getResourceBudgetState(ctx.resourceBudget)
  return limits.maxTokens !== undefined ||
    limits.maxCostMicros !== undefined ||
    state.estimateCostMicros !== undefined
}

/** Build a provider-neutral integer-microcurrency estimator from configuration. */
export function createModelCostEstimator(
  pricing: Readonly<Record<string, ModelTokenPricing>>
): NonNullable<RunResourceBudgetOptions["estimateCostMicros"]> {
  return (call, usage) => {
    const rate = pricing[call.model]
    if (!rate) return undefined
    validateNonNegativeInteger(
      `${call.model}.inputCostMicrosPerMillionTokens`,
      rate.inputCostMicrosPerMillionTokens
    )
    validateNonNegativeInteger(
      `${call.model}.outputCostMicrosPerMillionTokens`,
      rate.outputCostMicrosPerMillionTokens
    )
    return Math.ceil(
      (usage.promptTokens * rate.inputCostMicrosPerMillionTokens +
        usage.completionTokens * rate.outputCostMicrosPerMillionTokens) /
        1_000_000
    )
  }
}

export function isRunBudgetError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const code = (error as { code?: unknown }).code
  return code === "RUN_BUDGET_EXCEEDED" || code === "RUN_BUDGET_ACCOUNTING_ERROR"
}

export function hasRunResourceBudgetFailure(ctx: RunContext): boolean {
  return getResourceBudgetState(ctx.resourceBudget).failure !== undefined
}

function createResourceBudgetAuthority(
  options: RunResourceBudgetOptions = {}
): RunResourceBudgetAuthority {
  const limits = Object.freeze({ ...(options.limits ?? {}) })
  validateLimits(limits)
  let authority: RunResourceBudgetAuthority
  authority = Object.freeze({
    limits,
    snapshot: (): RunResourceBudgetSnapshot => {
      const state = getResourceBudgetState(authority)
      return {
        modelCalls: state.modelCalls,
        promptTokens: state.promptTokens,
        completionTokens: state.completionTokens,
        totalTokens: state.totalTokens,
        costMicros: state.costMicros,
        limits,
      }
    },
  })
  resourceBudgetStates.set(authority, {
    estimateCostMicros: options.estimateCostMicros,
    reservations: new Map(),
    nextReservationId: 1,
    modelCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costMicros: 0,
    failure: undefined,
  })
  return authority
}

function getResourceBudgetState(
  authority: RunResourceBudgetAuthority
): ResourceBudgetState {
  const state = resourceBudgetStates.get(authority)
  if (!state) throw new RunBudgetAccountingError("unknown run resource budget authority")
  return state
}

function failAccounting(ctx: RunContext, message: string): never {
  getResourceBudgetState(ctx.resourceBudget).failure = "accounting"
  ctx.controller.abort()
  throw new RunBudgetAccountingError(message)
}

function validateLimits(limits: RunResourceBudgetLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (value !== undefined) validateNonNegativeInteger(name, value)
  }
}

function validateUsage(usage: ModelUsage): void {
  validateNonNegativeInteger("promptTokens", usage.promptTokens)
  validateNonNegativeInteger("completionTokens", usage.completionTokens)
  validateNonNegativeInteger("totalTokens", usage.totalTokens)
}

function validateNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RunBudgetAccountingError(`${name} must be a non-negative integer`)
  }
}

/**
 * Returns remaining budget in ms. Clamped to 0 (never negative — a
 * negative remaining budget is observationally equivalent to zero since
 * downstream work should stop on <= 0).
 *
 * Observable by design: this is the P7.1 done-when condition. Any code with
 * the context can query it at any time, including mid-run to decide whether
 * to start a new downstream stage.
 */
export function getRemainingBudget(
  ctx: RunContext,
  now: () => number = Date.now
): number {
  const remaining = ctx.deadline - now()
  return remaining > 0 ? remaining : 0
}

/**
 * True if the deadline has passed. Distinct from `signal.aborted`:
 *   - `isExpired` becomes true at the deadline timestamp;
 *   - `signal.aborted` becomes true when the controller is actually aborted
 *     (which happens on the next microtask after `withDeadline`/`withBudget`
 *     observes the expiry, or immediately if `externalSignal` was already
 *     aborted at context creation).
 *
 * Callers that want to short-circuit before starting expensive downstream
 * work should check `isExpired(ctx) || ctx.signal.aborted` — covers both
 * "deadline silently elapsed while we were waiting" and "external cancel".
 */
export function isExpired(
  ctx: RunContext,
  now: () => number = Date.now
): boolean {
  return now() >= ctx.deadline
}

/**
 * Register a callback fired when the deadline elapses OR when an external
 * cancel arrives — whichever is first.
 *
 * The callback receives the reason:
 *   - `"deadline"` — the wall-clock deadline fired (the caller is responsible
 *     for aborting the controller if it wants downstream propagation; this
 *     helper deliberately does NOT auto-abort so a pure observer can read
 *     the deadline without side effects);
 *   - `"external"` — the AbortSignal was already aborted (either at context
 *     creation via an already-aborted `externalSignal`, or via a later
 *     `controller.abort()` call).
 *
 * Returns a cleanup function that clears the timer and removes the abort
 * listener. Call it when the owning work completes normally to avoid
 * leaking the timer (the timer would otherwise fire on a stale context).
 *
 * Idempotent: if the context is already expired/aborted at registration,
 * the callback fires synchronously on the next microtask (via
 * `queueMicrotask`) and the returned cleanup is a no-op.
 */
export function onExpire(
  ctx: RunContext,
  callback: (reason: "deadline" | "external") => void,
  now: () => number = Date.now
): () => void {
  if (ctx.signal.aborted) {
    queueMicrotask(() => callback("external"))
    return () => {}
  }
  const remaining = getRemainingBudget(ctx, now)
  if (remaining <= 0) {
    queueMicrotask(() => callback("deadline"))
    return () => {}
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    if (timer !== undefined) clearTimeout(timer)
    ctx.signal.removeEventListener("abort", onExternal)
  }
  const onExternal = () => {
    callback("external")
    cleanup()
  }
  ctx.signal.addEventListener("abort", onExternal, { once: true })
  timer = setTimeout(() => {
    callback("deadline")
    cleanup()
  }, remaining)
  return cleanup
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Link an external AbortSignal into the controller so external cancel
 * propagates as this context's abort. If the external signal is already
 * aborted, the controller is constructed aborted (synchronous — no microtask
 * delay) so `signal.aborted` is true immediately at context creation.
 */
function linkExternalSignal(
  external: AbortSignal,
  controller: AbortController
): void {
  if (external.aborted) {
    controller.abort()
    return
  }
  external.addEventListener(
    "abort",
    () => controller.abort(),
    { once: true }
  )
}
