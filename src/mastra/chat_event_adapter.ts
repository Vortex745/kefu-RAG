/**
 * Ticket 05 — Chat/Answer event adapter.
 *
 * Produces an `AnswerEventsSource`-compatible async iterable that consumes
 * the Mastra Answer topology (Ticket 03 hybrid: deterministic Workflow gates
 * around bounded Mastra Agent single-shot loops) and emits the existing 6
 * `AnswerRunEvent` types (progress ×4 stages + answer_delta + done) with
 * schema-versioned payload, ordering, run/session identity, cancellation,
 * and terminal-exactly-once semantics preserved.
 *
 * The adapter is the production Answer event source. It remains decoupled
 * from `@mastra/core` through the injected `MastraRunner` seam so event
 * compatibility can be tested without constructing a live provider runtime.
 *
 * Contracts preserved (per Ticket 05 spec):
 *   #1 Chat request fields + validation behavior (message/stream/runId/sessionId)
 *   #2 Answer event names + payload fields + ordering + run/session identity
 *   #3 SSE + complete JSON parity from one Answer event source
 *   #4 Historical replay compatibility for pre-Mastra runs
 *   #5 Client disconnect + AbortSignal cancellation → one cancelled terminal event, no late answer
 *   #6 Duplicate runner invocation cannot publish the same answer twice
 *
 * References:
 *   - T01 stream contract: agent.stream() result is NOT itself async-iterable;
 *     use streamResult.fullStream (typed events) or streamResult.textStream.
 *   - T02 §3: tenantId must NOT be a free-form tool arg; sourced from AccessContext.
 *   - T03 §3: 6-gate map (GATE 0 route → GATE 1 route-specific → GATE 2 context →
 *     GATE 3 answer Draft → GATE 4 validation → GATE 5 publish / GATE 6 handoff).
 *   - T03 §5: Mastra Agent maxSteps=1 + maxRetries=0 (single-shot, no competition).
 *   - T03 §7: the runner owns in-flight and pre-persistence cancellation;
 *     the adapter rejects pre-run aborts and terminalizes runner AbortErrors.
 *   - T04 §3: Memory → Store adapter contract (MastraMemoryAdapter); this chat
 *     adapter does NOT own memory — it delegates to the Answer pipeline.
 */

import { randomUUID } from "node:crypto"
import type {
  AnswerRunEvent,
  AnswerRunEventPayload,
  AnswerRunResult,
  AnswerRunStage,
  AnswerTerminalStatus,
  RouterDecision,
  RouteTraceData,
  RetrievalTraceData,
  ContextTraceData,
  ValidationTraceData,
} from "../types"
import type { AnswerRunOptions, AnswerRunObserver } from "../answer/generation"
import type { AccessContext } from "../access/context"
import { singleTenantAccessContext } from "../access/context"
import {
  createRunContext,
  hasRunResourceBudgetFailure,
  isRunBudgetError,
  runWithRunContext,
  type RunContext,
  type RunResourceBudgetOptions,
} from "../runtime/run_context"
import { withBudget } from "../runtime/deadline"

/**
 * Transport-level event source signature — structurally identical to
 * `AnswerEventsSource` in src/api/chat.ts. Inlined here (instead of imported)
 * to honor T02 #5 dependency direction: src/mastra/* must not import
 * src/api/*. TypeScript structural typing ensures the adapter's return type
 * is assignable to AnswerEventsSource at the createChatRouter injection site.
 */
export type MastraChatEventSource = (
  message: string,
  options: AnswerRunOptions
) => AsyncIterable<AnswerRunEvent>

/**
 * Map a terminal status (AnswerRunResult.status) to the run execution status
 * (AnswerRunEventBase.status). The two are distinct:
 *   - AnswerRunEventBase.status = run execution state (running/completed/degraded/failed/cancelled)
 *   - AnswerRunResult.status = terminal outcome (8 values including clarification_required, handoff_required, etc.)
 */
function terminalStatusToRunStatus(
  terminal: AnswerTerminalStatus
): AnswerRunEvent["status"] {
  switch (terminal) {
    case "completed":
      return "completed"
    case "cancelled":
      return "cancelled"
    case "provider_error":
    case "invalid_citation":
      return "failed"
    case "clarification_required":
    case "insufficient_retrieval":
    case "insufficient_evidence":
    case "handoff_required":
      return "degraded"
    default:
      return "degraded"
  }
}

// ---------------------------------------------------------------------------
// MastraRunner seam — decouples adapter from the real @mastra/core package.
// Ticket 09 (route migration) wires this to the actual Mastra Agent; here it
// is an injected function so the event contract can be tested in isolation.
// ---------------------------------------------------------------------------

/**
 * Input to the Mastra runner. Mirrors AnswerRunOptions but with required
 * runId + sessionId (the adapter assigns them before invoking the runner).
 * `accessContext` is always non-undefined (adapter falls back to
 * singleTenantAccessContext per T04 §4 backward-compat).
 */
export interface MastraRunnerInput {
  message: string
  runId: string
  sessionId: string
  signal: AbortSignal
  accessContext: AccessContext
  /** Route preparation produced once by the dispatch runner. Standalone
   * route runners may omit it and perform their own ownership check. */
  preparedRoute?: PreparedMastraRoute
}

export interface PreparedMastraRoute {
  decision: RouterDecision
  effectiveMessage: string
  contextualizedQuery: string
  routeTrace: RouteTraceData
}

/**
 * Output from the Mastra runner. The adapter translates this into the 6
 * AnswerRunEvent types. Fields mirror AnswerRunResult so the adapter does
 * minimal shaping.
 */
export interface MastraRunnerOutput {
  /** Final reply text (assembled from answer_delta tokens). */
  reply: string
  /** Terminal status — one of AnswerRunResult.status. */
  status: AnswerRunResult["status"]
  /** Citation references for the reply. */
  references: AnswerRunResult["references"]
  /** Degradation flags (e.g. contextualization-failed, provider-fallback). */
  degradation: AnswerRunResult["degradation"]
  /** Streamed answer tokens (answer_delta events). May be empty if the runner
   *  assembles the reply without streaming. */
  tokens: string[]
  /** Trace data for the 4 progress stages. */
  routeTrace: RouteTraceData
  retrievalTrace: RetrievalTraceData
  contextTrace: ContextTraceData
  validationTrace: ValidationTraceData
  summarizationUsage?: AnswerRunResult["summarizationUsage"]
  summarizationDurationMs?: AnswerRunResult["summarizationDurationMs"]
  summarizationCheckpoint?: AnswerRunResult["summarizationCheckpoint"]
  summarizationOutcome?: AnswerRunResult["summarizationOutcome"]
}

/**
 * Injected Mastra runner. The adapter calls this exactly once per Answer run
 * (per T03 §5 Mastra Agent maxSteps=1 + maxRetries=0). The runner MUST:
 *   - Respect `signal.aborted` (throw AbortError on abort)
 *   - Return a single MastraRunnerOutput (no internal retries)
 *   - NOT emit AnswerRunEvents directly (the adapter owns event emission)
 */
export type MastraRunner = (input: MastraRunnerInput) => Promise<MastraRunnerOutput>

// ---------------------------------------------------------------------------
// Chat request validation — mirrors src/api/chat.ts:73-84 so the adapter
// preserves the existing chat request fields + validation behavior (T05 #1).
// ---------------------------------------------------------------------------

const ID_PATTERN = /^[a-zA-Z0-9-]{1,100}$/

export interface ChatRequestShape {
  message: string
  stream?: boolean
  runId?: string
  sessionId?: string
}

/**
 * Validate a ChatRequest-shaped input and return normalized message + runId
 * + sessionId. Throws on invalid input (mirrors the 400 behavior in
 * createChatRouter, but the adapter surfaces the error as a thrown exception
 * so the caller can map it to the appropriate HTTP response).
 */
export function validateChatRequest(input: ChatRequestShape): {
  message: string
  runId: string
  sessionId: string
} {
  if (!input.message?.trim()) {
    throw new Error("message is required")
  }
  const sessionId =
    typeof input.sessionId === "string" && ID_PATTERN.test(input.sessionId)
      ? input.sessionId
      : randomUUID()
  const runId =
    typeof input.runId === "string" && ID_PATTERN.test(input.runId)
      ? input.runId
      : randomUUID()
  return { message: input.message, runId, sessionId }
}

// ---------------------------------------------------------------------------
// Event construction helpers — emit the 6 AnswerRunEvent types with correct
// payload + ordering + run/session identity (T05 #2).
// ---------------------------------------------------------------------------

function makeBaseEvent(args: {
  runId: string
  sessionId: string
  sequence: number
  stage: AnswerRunStage
  status: AnswerRunEvent["status"]
  runStartedAt: number
}): Omit<AnswerRunEvent, "type" | "message" | "data" | "token" | "result"> {
  // Note: spread below adds the discriminated `type` field per payload variant.
  const now = new Date().toISOString()
  return {
    schemaVersion: 1,
    sessionId: args.sessionId,
    runId: args.runId,
    eventId: `${args.runId}:${args.sequence}`,
    sequence: args.sequence,
    createdAt: now,
    stage: args.stage,
    status: args.status,
    durationMs: Date.now() - args.runStartedAt,
    attempt: 1,
    round: 0,
    inputSummary: "",
    outputSummary: "",
  }
}

function makeProgressEvent(
  base: Omit<AnswerRunEvent, "type" | "message" | "data" | "token" | "result">,
  payload: Extract<AnswerRunEventPayload, { type: "progress" }>
): AnswerRunEvent {
  return { ...base, ...payload } as AnswerRunEvent
}

function makeAnswerDeltaEvent(
  base: Omit<AnswerRunEvent, "type" | "message" | "data" | "token" | "result">,
  token: string
): AnswerRunEvent {
  return { ...base, type: "answer_delta", stage: "answer", token } as AnswerRunEvent
}

function makeDoneEvent(
  base: Omit<AnswerRunEvent, "type" | "message" | "data" | "token" | "result">,
  result: AnswerRunResult
): AnswerRunEvent {
  return { ...base, type: "done", stage: "done", result } as AnswerRunEvent
}

// ---------------------------------------------------------------------------
// Cancellation — T03 §7 three checkpoints + late-event prohibition.
// ---------------------------------------------------------------------------

function checkAbort(signal: AbortSignal, checkpoint: string): void {
  if (signal.aborted) {
    const err = new Error(`Answer run cancelled at ${checkpoint}`)
    err.name = "AbortError"
    throw err
  }
}

// ---------------------------------------------------------------------------
// Adapter factory — returns an MastraChatEventSource that consumes the Mastra
// Answer topology via the injected MastraRunner.
// ---------------------------------------------------------------------------

export interface MastraChatEventAdapterOptions {
  runner: MastraRunner
  /** Authoritative local trace persistence. Failure stops publication. */
  traceObserver?: AnswerRunObserver
  /**
   * T13 (spec issue #13 criterion #1+#2): observer fanout. The adapter calls
   * each observer's `onEvent(event)` BEFORE yielding the event.
   *
   * Observers are fire-and-forget per T06 §5.1: observer failure is
   * swallowed (console.warn) and NEVER breaks the event stream or alters
   * the user-visible trace. Fanout order matches T06 §5.3:
   *   1. AnswerTraceRepository (hard dependency — caller constructs the
   *      list in this order; the adapter itself only warns on failure).
   *   2. langfuseObserver (soft — already swallows internally).
   *
   * When omitted, no observers are notified.
   */
  observers?: AnswerRunObserver[]
  /**
   * P7.2: Per-run deadline budget in milliseconds. When set, the adapter
   * constructs a `RunContext` (linking `AnswerRunOptions.signal` as the
   * external cancel signal) and wraps the runner invocation in
   * `withBudget`. The resulting `ctx.signal` is passed to the runner as
   * `input.signal` so every stage (route/retrieval/context/answer/
   * validation/publish) honors cancellation from BOTH the deadline timer
   * AND the external transport signal — converging to exactly one
   * terminal event via the existing `terminalEmitted` guard.
   *
   * When omitted: no deadline enforcement; the adapter passes
   * `AnswerRunOptions.signal` directly to the runner (pre-P7.2 behavior
   * — backward compat).
   */
  budgetMs?: number
  /** Whole-run aggregate model call, token, and cost limits. */
  resourceBudget?: RunResourceBudgetOptions
}

/**
 * Create an MastraChatEventSource backed by the Mastra Answer topology. The
 * returned function implements the event-source contract injected into
 * `createChatRouter(traceRepository, eventsSource)` (T05 #3).
 *
 * The adapter:
 *   - Validates the chat request (T05 #1)
 *   - Emits 6 AnswerRunEvent types in T03 §3 gate order (T05 #2)
 *   - Supports both SSE streaming and complete JSON collection (T05 #3)
 *   - Produces events replayable via AnswerTraceRepository.getRun (T05 #4)
 *   - Emits exactly one cancelled terminal when the run aborts before the
 *     runner's completion boundary (T05 #5)
 *   - Guarantees terminal-exactly-once (T05 #6)
 */
export function createMastraChatEventAdapter(
  options: MastraChatEventAdapterOptions
): MastraChatEventSource {
  const { runner, traceObserver, observers, budgetMs, resourceBudget } = options
  return async function* mastraChatEventSource(
    message: string,
    runOptions?: AnswerRunOptions
  ): AsyncGenerator<AnswerRunEvent> {
    // T05 #1: chat request validation. The adapter performs the same
    // validation as createChatRouter so it can be dropped in as a
    // transport-level eventsSource without weakening the contract.
    const { message: validatedMessage, runId, sessionId } = validateChatRequest({
      message,
      runId: runOptions?.runId,
      sessionId: runOptions?.sessionId,
    })

    // T04 §4: accessContext fallback — singleTenantAccessContext when
    // undefined preserves backward compat for bare-router mounts.
    const accessContext: AccessContext =
      runOptions?.accessContext ?? singleTenantAccessContext()

    // T03 §7 checkpoint 1: before LLM call. (Moved inside try block so an
    // already-aborted signal produces a cancelled terminal event instead of
    // throwing out of the generator — T05 #5.)
    const signal = runOptions?.signal ?? new AbortController().signal

    const runStartedAt = Date.now()
    let sequence = 0
    let terminalEmitted = false
    let traceFailure: unknown
    let runContext: RunContext | undefined
    const nextSequence = () => ++sequence

    /**
     * T13 (T06 §5.1 fire-and-forget): notify each observer of an event
     * BEFORE yielding it. Observer failure is swallowed (console.warn) and
     * never propagates into the Answer event stream.
     */
    const notifyObservers = (event: AnswerRunEvent): void => {
      if (traceObserver) {
        try {
          traceObserver.onEvent(event)
        } catch (err) {
          traceFailure = err
          throw err
        }
      }
      if (!observers || observers.length === 0) return
      for (const observer of observers) {
        try {
          observer.onEvent(event)
        } catch (err) {
          console.warn(
            "[mastra-adapter] Observer failed; event stream unaffected:",
            err instanceof Error ? err.message : err,
          )
        }
      }
    }

    // Helper: emit a progress event for a stage.
    const emitProgress = function* (
      stage: "route" | "retrieval" | "context" | "validation",
      messageText: string,
      data: RouteTraceData | RetrievalTraceData | ContextTraceData | ValidationTraceData
    ): Generator<AnswerRunEvent> {
      const base = makeBaseEvent({
        runId,
        sessionId,
        sequence: nextSequence(),
        stage,
        status: "completed",
        runStartedAt,
      })
      const event = makeProgressEvent(base, {
        type: "progress",
        stage,
        message: messageText,
        data: data as RouteTraceData & RetrievalTraceData & ContextTraceData & ValidationTraceData,
      })
      notifyObservers(event)
      yield event
    }

    try {
      // T03 §7 checkpoint 1: before LLM call.
      checkAbort(signal, "GATE 0 (before route)")

      // P7.2: When budgetMs is configured, construct a RunContext that
      // links the transport signal as externalSignal and wrap the runner
      // invocation in `withBudget`. The runner receives `ctx.signal` as
      // `input.signal`, so every stage (route/retrieval/context/answer/
      // validation/publish) honors cancellation from BOTH the deadline
      // timer AND the external transport signal. `DeadlineExpiredError`
      // is named "AbortError" so the catch path below treats deadline
      // expiry identically to external cancel → exactly one terminal.
      //
      // When budgetMs is omitted: pass `signal` directly (pre-P7.2
      // behavior — backward compat).
      let runnerOutput: MastraRunnerOutput
      if (budgetMs !== undefined || resourceBudget !== undefined) {
        const ctx: RunContext = createRunContext({
          budgetMs: budgetMs ?? Number.POSITIVE_INFINITY,
          externalSignal: signal,
          resourceBudget,
        })
        runContext = ctx
        runnerOutput = await runWithRunContext(
          ctx,
          () => withBudget(
            (ctxSignal) =>
              runner({
                message: validatedMessage,
                runId,
                sessionId,
                signal: ctxSignal,
                accessContext,
              }),
            ctx
          )
        )
      } else {
        runnerOutput = await runner({
          message: validatedMessage,
          runId,
          sessionId,
          signal,
          accessContext,
        })
      }

      // The runner owns route/retrieval/context execution and persistence.
      // Once it returns, its output is authoritative: a later transport abort
      // must not rewrite already-persisted completed state as cancelled.
      // Emit only stages that actually ran, using the real aggregated trace.
      yield* emitProgress("route", "Routing query", runnerOutput.routeTrace)
      if (Object.keys(runnerOutput.retrievalTrace).length > 0) {
        yield* emitProgress("retrieval", "Retrieving evidence", runnerOutput.retrievalTrace)
      }
      if (Object.keys(runnerOutput.contextTrace).length > 0) {
        yield* emitProgress("context", "Contextualizing", runnerOutput.contextTrace)
      }

      // GATE 4 — validation (Critic per T03 §6).
      if (Object.keys(runnerOutput.validationTrace).length > 0) {
        yield* emitProgress(
          "validation",
          "Validating draft",
          runnerOutput.validationTrace
        )
      }

      // Only validated tokens are publishable knowledge output.
      for (const token of runnerOutput.tokens) {
        const base = makeBaseEvent({
          runId,
          sessionId,
          sequence: nextSequence(),
          stage: "answer",
          status: "running",
          runStartedAt,
        })
        const event = makeAnswerDeltaEvent(base, token)
        notifyObservers(event)
        yield event
      }

      // GATE 5 — publish (terminal done event).
      // T05 #6: terminal-exactly-once. The `terminalEmitted` guard ensures
      // we never emit a second done event even if the runner somehow returns
      // twice (it shouldn't, but the guard is structural).
      if (!terminalEmitted) {
        terminalEmitted = true
        const base = makeBaseEvent({
          runId,
          sessionId,
          sequence: nextSequence(),
          stage: "done",
          status: terminalStatusToRunStatus(runnerOutput.status),
          runStartedAt,
        })
        const event = makeDoneEvent(base, {
          runId,
          reply: runnerOutput.reply,
          status: runnerOutput.status,
          references: runnerOutput.references,
          degradation: runnerOutput.degradation,
          summarizationUsage: runnerOutput.summarizationUsage,
          summarizationDurationMs: runnerOutput.summarizationDurationMs,
          summarizationCheckpoint: runnerOutput.summarizationCheckpoint,
          summarizationOutcome: runnerOutput.summarizationOutcome,
        })
        notifyObservers(event)
        yield event
      }
    } catch (err) {
      if (err === traceFailure) throw err
      // RouteNotSupportedError indicates an incomplete Mastra route map. All
      // production routes are migrated, so surface it as a hard error instead
      // of converting it into a misleading terminal result.
      if (
        err instanceof Error &&
        err.name === "RouteNotSupportedError"
      ) {
        throw err
      }
      // T05 #5: abort → one cancelled terminal event, no late answer.
      // T03 §7: late-event prohibition — after abort, only the terminal
      // done event with status=cancelled is emitted; no further
      // answer_delta or progress events.
      if (!terminalEmitted) {
        terminalEmitted = true
        const isAbort =
          err instanceof Error && err.name === "AbortError"
        const isResourceBudgetError =
          isRunBudgetError(err) ||
          (runContext !== undefined && hasRunResourceBudgetFailure(runContext))
        const base = makeBaseEvent({
          runId,
          sessionId,
          sequence: nextSequence(),
          stage: "done",
          status: isAbort ? "cancelled" : "failed",
          runStartedAt,
        })
        const event = makeDoneEvent(base, {
          runId,
          reply: "",
          status: isAbort ? "cancelled" : "provider_error",
          references: [],
          degradation: {
            status: "insufficient",
            unavailableChannels: [],
            reason: isResourceBudgetError
              ? "resource_budget_exceeded"
              : isAbort
                ? undefined
                : "no_cited_claims",
          },
        })
        notifyObservers(event)
        yield event
      }
      // Swallow the error — the terminal event is the contract.
    }
  }
}
