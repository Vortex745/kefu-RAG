import type { AnswerRunEvent } from "../types"
import type { AnswerRunObserver } from "./generation"

/**
 * T41/T50: Optional Langfuse event export via the AnswerRunObserver fanout.
 *
 * Consumes existing Answer run domain events for deep diagnostics.
 * Implementations must be fire-and-forget (never throw from export) and
 * must not alter the user-visible protocol or trace repository.
 *
 * T50: The speculative `close()` seam is removed — the repo has no real
 * Langfuse adapter. A real adapter can be introduced later behind the same
 * observer fanout without changing the interface.
 *
 * T11: A real adapter (`RealLangfuseExporter`) is now available, mapping
 * each Answer run to one Langfuse trace with spans/generations for route,
 * retrieval, context, validation, answer and terminal lifecycle events.
 * The factory `createLangfuseExporter` selects Noop when configuration is
 * absent and constructs Real when configuration is complete + a client is
 * injected. Tests use fake clients (criterion #8).
 *
 * Default: NoopLangfuseExporter (zero cost when disabled).
 */
export interface LangfuseExporter {
  export(event: AnswerRunEvent): void
  /**
   * T12 (spec issue #12 criterion #6, #7): flush pending events and release
   * Langfuse-specific resources within a bounded timeout. Idempotent —
   * repeated calls return the same promise. Must NOT close shared Answer or
   * retrieval resources (criterion #7).
   */
  close(): Promise<void>
}

export class NoopLangfuseExporter implements LangfuseExporter {
  export(_event: AnswerRunEvent): void {}
  async close(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// T11 — Minimal Langfuse client interface (dependency injection seam)
// ---------------------------------------------------------------------------

/**
 * T11: Minimal subset of the Langfuse SDK client surface that
 * `RealLangfuseExporter` consumes. Structurally compatible with the real
 * `langfuse` npm package client so that production wiring can pass
 * `new Langfuse(config)` directly. Tests inject a fake implementation
 * (criterion #8 — no live Langfuse service required).
 *
 * The interface is intentionally narrow: only `trace()` is called on the
 * client; spans and generations are created on the returned trace object.
 */
export interface LangfuseClient {
  trace(params: {
    name: string
    id?: string
    sessionId?: string
    userId?: string
    metadata?: Record<string, unknown>
  }): LangfuseTrace
  /**
   * T12 (spec issue #12 criterion #6): flush pending events to the Langfuse
   * backend within a bounded timeout. Optional — absent on minimal fakes that
   * don't model network latency. The real `langfuse` npm package provides this.
   */
  flushAsync?(): Promise<void>
  /**
   * T12: shutdown the client and flush all pending events. Optional —
   * `close()` falls back to `flushAsync()` when `shutdownAsync` is absent.
   */
  shutdownAsync?(): Promise<void>
  /**
   * T13 (spec issue #13 criterion #1): read a trace back by ID. Optional —
   * the smoke probe uses this to verify a configured Answer run reaches
   * Langfuse with its core and agentic spans. Absent on minimal fakes that
   * don't model read-back; the real `langfuse` npm package does not expose
   * this directly, so production callers wrap the Langfuse REST API
   * (GET /api/public/traces/{id}). Returns undefined when the trace is not
   * yet queryable (eventual consistency) so the probe can poll.
   */
  fetchTrace?(id: string): Promise<LangfuseTraceSnapshot | undefined>
}

/**
 * T13 (spec issue #13 criterion #2): read-only snapshot of a Langfuse trace
 * used by the smoke probe to verify that an Answer run reached Langfuse with
 * its core and agentic spans. Mirrors the structure the real Langfuse REST
 * API returns for GET /api/public/traces/{id}. The fake client used in tests
 * returns the same shape from its in-memory recorded traces.
 */
export interface LangfuseTraceSnapshot {
  id: string
  name: string
  spans: Array<{
    name: string
    metadata?: Record<string, unknown>
    level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR"
    statusMessage?: string
  }>
  generations: Array<{
    name: string
    model?: string
    metadata?: Record<string, unknown>
    level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR"
  }>
  metadata?: Record<string, unknown>
}

export interface LangfuseTrace {
  span(params: {
    name: string
    startTime?: Date
    endTime?: Date
    metadata?: Record<string, unknown>
    level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR"
    statusMessage?: string
  }): LangfuseSpan
  generation(params: {
    name: string
    startTime?: Date
    endTime?: Date
    model?: string
    usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
    metadata?: Record<string, unknown>
    level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR"
    statusMessage?: string
  }): LangfuseGeneration
  update(params: {
    metadata?: Record<string, unknown>
    level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR"
    statusMessage?: string
  }): void
}

export interface LangfuseSpan {
  end(params?: {
    endTime?: Date
    metadata?: Record<string, unknown>
    level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR"
    statusMessage?: string
  }): void
  update(params: {
    metadata?: Record<string, unknown>
    level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR"
    statusMessage?: string
  }): void
}

export interface LangfuseGeneration {
  end(params?: {
    endTime?: Date
    metadata?: Record<string, unknown>
    usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
    level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR"
    statusMessage?: string
  }): void
  update(params: {
    metadata?: Record<string, unknown>
    usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
    level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR"
    statusMessage?: string
  }): void
}

// ---------------------------------------------------------------------------
// T11 — Configuration
// ---------------------------------------------------------------------------

/**
 * T11: Langfuse configuration. All three fields are required when Langfuse
 * export is enabled. When any field is absent, the factory selects Noop
 * (criterion #1). When some but not all fields are present, the factory
 * throws a clear composition-time error (criterion #2).
 */
export interface LangfuseConfig {
  publicKey: string
  secretKey: string
  baseUrl?: string
}

// ---------------------------------------------------------------------------
// T11 — RealLangfuseExporter
// ---------------------------------------------------------------------------

/**
 * T11: Per-run state tracked by `RealLangfuseExporter`. One Answer run maps
 * to one Langfuse trace (criterion #3). Route/retrieval/context/validation
 * events map to spans; answer_delta events accumulate into a generation
 * (criterion #4).
 */
interface RunState {
  trace: LangfuseTrace
  /** Spans keyed by stage name (route, retrieval, context, validation). */
  spans: Map<string, LangfuseSpan>
  /** Generation for the answer stage, created on first answer_delta. */
  generation: LangfuseGeneration | null
  /** Accumulated answer token count (criterion #5 — token counts exported). */
  answerTokenCount: number
  /** First event timestamp for the run (trace startTime). */
  startedAt: Date
  /** Chat model ID for the generation's `model` field (criterion #5). */
  chatModel?: string
}

/**
 * T11 (spec issue #11): Real Langfuse exporter that maps each Answer run to
 * one Langfuse trace. Constructed by `createLangfuseExporter` when config is
 * complete and a client is injected. All `export()` calls are wrapped in
 * try/catch — client or export failure NEVER throws (criterion #7), preserving
 * the Answer stream, terminal result, Citation set and local SQLite trace.
 *
 * Privacy defaults (criterion #6): raw prompts, retrieved passages and full
 * answer content are excluded from export. Only safe identifiers, stage,
 * status, duration, attempts, model IDs, token counts, Evidence counts and
 * degradation reasons are exported (criterion #5).
 */
export class RealLangfuseExporter implements LangfuseExporter {
  private readonly client: LangfuseClient
  private readonly chatModel?: string
  private readonly runs = new Map<string, RunState>()
  /**
   * T12 (spec issue #12 criterion #4): bounded non-blocking export queue.
   * The `runs` Map IS the queue — one entry per in-flight Answer run. When
   * `maxRuns` is reached, new runs are dropped (criterion #5) to prevent
   * unbounded memory growth from abandoned runs (no done event).
   */
  private readonly maxRuns: number
  /**
   * T12 (criterion #5): count of events dropped due to queue overflow or
   * client failure. Exposed via `getDroppedCount()` for observability.
   */
  private droppedCount = 0
  /**
   * T12 (criterion #7): cached close promise — repeated calls return the
   * same promise (idempotent).
   */
  private closePromise: Promise<void> | undefined

  constructor(client: LangfuseClient, options?: { chatModel?: string; maxRuns?: number }) {
    this.client = client
    this.chatModel = options?.chatModel
    this.maxRuns = options?.maxRuns ?? 100
  }

  export(event: AnswerRunEvent): void {
    // Criterion #7: never throw — all client calls are fire-and-forget.
    try {
      this.exportUnsafe(event)
    } catch {
      // T12 (criterion #5): sustained exporter outage — record the drop and
      // warn so operators can detect Langfuse backend issues. The Answer run,
      // terminal result, Citation set and local SQLite trace are unaffected.
      this.droppedCount += 1
      this.warnDrop(event, "export threw")
    }
  }

  /**
   * T12 (criterion #5): returns the number of events dropped due to queue
   * overflow or sustained client failure. For operator observability.
   */
  getDroppedCount(): number {
    return this.droppedCount
  }

  /**
   * T12 (spec issue #12 criterion #6, #7): flush pending Langfuse events
   * within a bounded timeout. Idempotent — repeated calls return the same
   * promise. Does NOT close shared Answer or retrieval resources (criterion
   * #7) — only Langfuse-specific state is flushed.
   */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closePromise = this.doClose().catch(() => {
      // Criterion #7: close failures are swallowed — shutdown must not fail.
    })
    return this.closePromise
  }

  private async doClose(): Promise<void> {
    // Flush any pending client events within a bounded timeout. Prefer
    // shutdownAsync (flush + mark as shutting down) when available; fall back
    // to flushAsync; fall back to no-op when neither is present (minimal fakes).
    if (typeof this.client.shutdownAsync === "function") {
      await this.client.shutdownAsync()
    } else if (typeof this.client.flushAsync === "function") {
      await this.client.flushAsync()
    }
    // Clear run state to release references (criterion #7 — does not close
    // shared Answer/retrieval resources, only Langfuse-specific state).
    this.runs.clear()
  }

  private warnDrop(event: AnswerRunEvent, reason: string): void {
    // Criterion #5: record a local warning. Uses console.warn to avoid
    // coupling to a specific logger. Operators can grep for [langfuse].
    console.warn(
      `[langfuse] dropped event ${event.runId}:${event.sequence} (${reason}; total dropped: ${this.droppedCount})`
    )
  }

  private exportUnsafe(event: AnswerRunEvent): void {
    const state = this.getOrCreateRun(event)
    switch (event.type) {
      case "progress":
        this.handleProgress(state, event)
        break
      case "answer_delta":
        this.handleAnswerDelta(state, event)
        break
      case "done":
        this.handleDone(state, event)
        break
    }
  }

  private getOrCreateRun(event: AnswerRunEvent): RunState {
    const existing = this.runs.get(event.runId)
    if (existing) return existing
    // T12 (criterion #4, #5): bounded queue — when maxRuns is reached, reject
    // new runs to prevent unbounded memory growth from abandoned runs. The
    // export() catch block records the drop + warns (criterion #5).
    if (this.runs.size >= this.maxRuns) {
      throw new Error(`export queue full (maxRuns=${this.maxRuns})`)
    }
    const startedAt = new Date(event.createdAt)
    const trace = this.client.trace({
      name: "answer-run",
      id: event.runId,
      sessionId: event.sessionId,
      metadata: {
        runId: event.runId,
        sessionId: event.sessionId,
        startedAt: startedAt.toISOString(),
      },
    })
    const state: RunState = {
      trace,
      spans: new Map(),
      generation: null,
      answerTokenCount: 0,
      startedAt,
      chatModel: this.chatModel,
    }
    this.runs.set(event.runId, state)
    return state
  }

  private handleProgress(state: RunState, event: Extract<AnswerRunEvent, { type: "progress" }>): void {
    const stageName = event.stage
    const isRunning = event.status === "running"
    const existingSpan = state.spans.get(stageName)

    if (isRunning && !existingSpan) {
      // Start a new span for this stage.
      const span = state.trace.span({
        name: stageName,
        startTime: new Date(event.createdAt),
        metadata: this.safeProgressMetadata(event),
      })
      state.spans.set(stageName, span)
    } else if (existingSpan) {
      // End the existing span with completion metadata.
      const level = this.statusToLevel(event.status)
      const params: Parameters<LangfuseSpan["end"]>[0] = {
        endTime: event.durationMs != null
          ? new Date(new Date(event.createdAt).getTime())
          : undefined,
        metadata: this.safeProgressMetadata(event),
        level,
        statusMessage: level !== "DEFAULT" ? `${event.stage} ${event.status}` : undefined,
      }
      existingSpan.end(params)
    } else {
      // Terminal event (completed/degraded/failed) without a prior "running"
      // event — create and immediately end a span. This handles runtimes that
      // elide the "running" event for fast stages, ensuring every stage that
      // emits a progress event still produces a span (criterion #4).
      const level = this.statusToLevel(event.status)
      const span = state.trace.span({
        name: stageName,
        startTime: new Date(event.createdAt),
        metadata: this.safeProgressMetadata(event),
      })
      span.end({
        endTime: new Date(event.createdAt),
        metadata: this.safeProgressMetadata(event),
        level,
        statusMessage: level !== "DEFAULT" ? `${event.stage} ${event.status}` : undefined,
      })
    }

    // T12 (spec issue #12 criterion #1): when the route event carries
    // contextualization outcome metadata, create a bounded "contextualization"
    // child span with token counts and safe outcome. Only created for
    // "success" / "failed" outcomes — "skipped" means no LLM call was made.
    if (stageName === "route" && isRunning) {
      this.maybeCreateContextualizationSpan(state, event)
    }
    // T12 (spec issue #12 criterion #2): compression metadata is already
    // folded into the context span via safeKeysForStage — no separate span
    // needed (the context span IS the compression span).
  }

  /**
   * T12: Create a bounded "contextualization" span on the trace when the
   * route event carries contextualization outcome metadata. The span is
   * created with a back-dated startTime (createdAt - durationMs) so its
   * duration reflects the actual LLM call wall-clock time.
   */
  private maybeCreateContextualizationSpan(
    state: RunState,
    event: Extract<AnswerRunEvent, { type: "progress" }>
  ): void {
    // T12: null safety — event.data is optional. When absent, fall back to an
    // empty record so property lookups do not throw (same fix as
    // safeProgressMetadata). The export() catch block would otherwise count
    // this as a dropped event on every route-progress event without data.
    const data = (event.data ?? {}) as Record<string, unknown>
    const outcome = data["contextualizationOutcome"]
    if (outcome !== "success" && outcome !== "failed") return
    const durationMs = typeof data["contextualizationDurationMs"] === "number"
      ? data["contextualizationDurationMs"] as number
      : 0
    const end = new Date(event.createdAt)
    const start = new Date(end.getTime() - durationMs)
    const usage = data["contextualizationUsage"] as
      { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined
    const span = state.trace.span({
      name: "contextualization",
      startTime: start,
      metadata: {
        outcome,
        durationMs,
        ...(usage ? { usage } : {}),
        ...(data["contextualizationFailure"]
          ? { failure: data["contextualizationFailure"] as string }
          : {}),
      },
      level: outcome === "failed" ? "WARNING" : "DEFAULT",
      statusMessage: outcome === "failed" ? "contextualization failed" : undefined,
    })
    span.end({ endTime: end })
  }

  private handleAnswerDelta(state: RunState, event: Extract<AnswerRunEvent, { type: "answer_delta" }>): void {
    // Criterion #6: raw answer tokens are NOT exported — only the count.
    state.answerTokenCount += 1
    if (!state.generation) {
      state.generation = state.trace.generation({
        name: "answer",
        startTime: new Date(event.createdAt),
        model: state.chatModel,
        metadata: { tokenCount: 1 },
      })
    } else {
      state.generation.update({
        metadata: { tokenCount: state.answerTokenCount },
      })
    }
  }

  private handleDone(state: RunState, event: Extract<AnswerRunEvent, { type: "done" }>): void {
    const result = event.result
    // Finalize the generation with token usage (criterion #5).
    if (state.generation) {
      state.generation.end({
        endTime: new Date(event.createdAt),
        usage: { completionTokens: state.answerTokenCount },
        metadata: {
          terminalStatus: result.status,
          replyLength: result.reply.length,
          referenceCount: result.references.length,
        },
        level: this.terminalLevel(result.status),
        statusMessage: result.status !== "completed" ? result.status : undefined,
      })
    }
    // T12 (spec issue #12 criterion #1): create a bounded "summarization" span
    // when the done event carries summarization outcome metadata. Only created
    // for "success" / "failed" outcomes — "skipped" means no LLM call was made.
    this.maybeCreateSummarizationSpan(state, event)
    // Finalize the trace with terminal metadata (criterion #5).
    state.trace.update({
      metadata: {
        terminalStatus: result.status,
        replyLength: result.reply.length,
        referenceCount: result.references.length,
        referenceIds: result.references.map((r) => r.id),
        degradationStatus: result.degradation.status,
        degradationReason: result.degradation.reason,
        degradationUnavailableChannels: result.degradation.unavailableChannels,
        answerTokenCount: state.answerTokenCount,
        // T12: surface summarization outcome at the trace level for quick filtering.
        ...(result.summarizationOutcome
          ? { summarizationOutcome: result.summarizationOutcome }
          : {}),
        ...(result.summarizationUsage
          ? { summarizationUsage: result.summarizationUsage }
          : {}),
      },
      level: this.terminalLevel(result.status),
      statusMessage: result.status !== "completed" ? result.status : undefined,
    })
    // Clean up run state to avoid unbounded memory growth.
    this.runs.delete(event.runId)
  }

  /**
   * T12: Create a bounded "summarization" span on the trace when the done
   * event carries summarization outcome metadata. The span is back-dated to
   * reflect the actual LLM call wall-clock duration.
   */
  private maybeCreateSummarizationSpan(
    state: RunState,
    event: Extract<AnswerRunEvent, { type: "done" }>
  ): void {
    const result = event.result
    const outcome = result.summarizationOutcome
    if (outcome !== "success" && outcome !== "failed") return
    const durationMs = typeof result.summarizationDurationMs === "number"
      ? result.summarizationDurationMs
      : 0
    const end = new Date(event.createdAt)
    const start = new Date(end.getTime() - durationMs)
    const span = state.trace.span({
      name: "summarization",
      startTime: start,
      metadata: {
        outcome,
        durationMs,
        ...(result.summarizationUsage
          ? { usage: result.summarizationUsage }
          : {}),
        ...(result.summarizationCheckpoint != null
          ? { checkpoint: result.summarizationCheckpoint }
          : {}),
      },
      level: outcome === "failed" ? "WARNING" : "DEFAULT",
      statusMessage: outcome === "failed" ? "summarization failed" : undefined,
    })
    span.end({ endTime: end })
  }

  /**
   * Criterion #5: safe metadata exported for each progress event.
   * Criterion #6: raw prompts, retrieved passages and full answer content
   * are excluded. `inputSummary` and `outputSummary` are already safe
   * summaries (not raw content) and are included.
   */
  private safeProgressMetadata(event: Extract<AnswerRunEvent, { type: "progress" }>): Record<string, unknown> {
    const base: Record<string, unknown> = {
      stage: event.stage,
      status: event.status,
      attempt: event.attempt,
      round: event.round,
      durationMs: event.durationMs,
      inputSummary: event.inputSummary,
      outputSummary: event.outputSummary,
    }
    // Merge stage-specific safe fields from `data`. Guard against undefined
    // data (test fixtures / partial events may omit it).
    const data = (event.data ?? {}) as Record<string, unknown>
    const safeKeys = this.safeKeysForStage(event.stage)
    for (const key of safeKeys) {
      if (key in data) {
        base[key] = data[key]
      }
    }
    return base
  }

  /**
   * Whitelist of safe metadata keys per stage (criterion #6 — excludes raw
   * passages/prompts; includes only identifiers, counts, status, duration,
   * model IDs, token counts, Evidence counts and degradation reasons).
   */
  private safeKeysForStage(stage: string): string[] {
    switch (stage) {
      case "route":
        return [
          "decision", "queryCount", "modelCalls", "tokens",
          "selectedTool", "toolFallbackReason",
          "complexLoopStopReason", "complexLoopIterations", "complexLoopToolCalls",
          "contextualizationFailure",
          // T12 (spec issue #12 criterion #1): contextualization outcome + token usage.
          "contextualizationOutcome", "contextualizationUsage", "contextualizationDurationMs",
        ]
      case "retrieval":
        return [
          "resultCount", "selectedEvidenceIds",
          "correction", "fallback", "complexLoop", "iteration", "duplicate",
          "channelStatuses", "unselectedChannels",
          "hydeUsed", "graphSeeds", "graphHops", "graphCandidates",
          "selectedTool", "toolInputSummary", "toolFallbackReason",
          // T12 (spec issue #12 criterion #3): complex-loop observation compression
          // metadata (previously missing from the whitelist — bug fix).
          "complexLoopCompressionRan",
          "complexLoopCompressionInputTokens",
          "complexLoopCompressionOutputTokens",
        ]
      case "context":
        return [
          "evidenceCount", "contextLength",
          "compressionRan", "compressionInputTokens", "compressionOutputTokens",
          "compressionRetainedEvidenceIds", "compressionDroppedEvidenceIds",
          // T12 (spec issue #12 criterion #2): aggregated LLM token usage from
          // the compressor's per-group calls.
          "compressionUsage",
        ]
      case "validation":
        return ["round", "passed"]
      default:
        return []
    }
  }

  private statusToLevel(status: string): "DEBUG" | "DEFAULT" | "WARNING" | "ERROR" {
    switch (status) {
      case "running": return "DEFAULT"
      case "completed": return "DEFAULT"
      case "degraded": return "WARNING"
      case "failed": return "ERROR"
      case "cancelled": return "DEFAULT"
      default: return "DEFAULT"
    }
  }

  private terminalLevel(status: string): "DEBUG" | "DEFAULT" | "WARNING" | "ERROR" {
    switch (status) {
      case "completed": return "DEFAULT"
      case "clarification_required": return "DEFAULT"
      case "insufficient_retrieval":
      case "insufficient_evidence": return "WARNING"
      case "invalid_citation":
      case "provider_error": return "ERROR"
      case "cancelled": return "DEFAULT"
      case "handoff_required": return "WARNING"
      default: return "DEFAULT"
    }
  }
}

// ---------------------------------------------------------------------------
// T11 — Factory
// ---------------------------------------------------------------------------

/**
 * T11: Factory that selects the right exporter based on configuration.
 *
 * - Config absent (undefined, null, or all fields empty) → `NoopLangfuseExporter`
 *   (criterion #1 — absent configuration selects Noop behavior).
 * - Config partial (some but not all required fields present) → throws clear
 *   composition-time error (criterion #2 — fails clearly rather than silently
 *   exporting incomplete traces).
 * - Config complete + client provided → `RealLangfuseExporter` (criterion #1).
 * - Config complete + no client → throws clear composition-time error
 *   (the caller must install the `langfuse` package and inject a client).
 *
 * The `client` parameter is required for Real because the `langfuse` npm
 * package is NOT a project dependency — production wiring constructs the
 * client only when the package is installed, and tests inject a fake client
 * (criterion #8).
 */
export function createLangfuseExporter(
  config: LangfuseConfig | undefined,
  client: LangfuseClient | undefined,
  options?: { chatModel?: string },
): LangfuseExporter {
  // Criterion #1: absent configuration → Noop.
  if (!config) return new NoopLangfuseExporter()
  const hasPublicKey = !!config.publicKey?.trim()
  const hasSecretKey = !!config.secretKey?.trim()
  // Criterion #2: partial configuration → clear composition-time error.
  if (hasPublicKey !== hasSecretKey) {
    const missing = hasPublicKey ? "secretKey" : "publicKey"
    throw new Error(
      `Langfuse configuration is partial: ${missing} is missing. ` +
      `Either provide both publicKey and secretKey, or omit both to use Noop.`,
    )
  }
  // Both absent → Noop (criterion #1 — empty config = Noop).
  if (!hasPublicKey && !hasSecretKey) return new NoopLangfuseExporter()
  // Config complete but no client → clear composition-time error.
  if (!client) {
    throw new Error(
      "Langfuse configuration is complete but no client was injected. " +
      "Install the 'langfuse' package and pass a client to createLangfuseExporter, " +
      "or omit Langfuse configuration to use Noop.",
    )
  }
  return new RealLangfuseExporter(client, options)
}

// ---------------------------------------------------------------------------
// T11 — Observer adapter
// ---------------------------------------------------------------------------

/**
 * T11: Wraps a `LangfuseExporter` as an `AnswerRunObserver` for the Answer
 * event-source observer fanout. Each emitted `AnswerRunEvent` is forwarded
 * to the exporter's `export()` method.
 *
 * The exporter's `export()` is fire-and-forget (criterion #7) — observer
 * failures are swallowed by the event-source fanout and never break the
 * Answer stream.
 */
export function langfuseObserver(exporter: LangfuseExporter): AnswerRunObserver {
  return {
    onEvent: (event) => exporter.export(event),
  }
}
