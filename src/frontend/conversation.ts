/**
 * T56: Conversation interface — owns thread state, run projection,
 * persistence, and race handling for the chat UI.
 *
 * Expand phase: this module is introduced alongside the existing app.js
 * global state. app.js is NOT migrated yet — T57/T58 will migrate
 * thread state and SSE stream merge into this interface.
 *
 * Design rules (karpathy guidelines):
 * - No browser framework. Pure TypeScript, testable in node.
 * - Persistence is a seam: the Conversation takes a Storage adapter
 *   so tests can substitute in-memory storage.
 * - Trace event projection reuses the same logic that app.js uses today
 *   (normalizeTraceEvents / projectTraceEvents / mergeTraceEvent) —
 *   extracted verbatim to preserve behavior.
 */

export type MessageRole = "user" | "assistant"
export type MessageStatus = "running" | "complete" | "error"

export interface TraceEvent {
  eventId: string
  sequence: number
  type: string
  stage?: string
  status?: string
  attempt?: number
  round?: number
  durationMs?: number
  data?: Record<string, unknown>
  result?: { status?: string; references?: Reference[] }
  runId?: string
}

export interface Reference {
  id: string
  title?: string
  source?: string
  excerpt?: string
  sectionPath?: string[]
  page?: number
  image?: { assetPath?: string; captions?: string[] }
  [key: string]: unknown
}

export interface Message {
  id: string
  role: MessageRole
  content: string
  status: MessageStatus
  createdAt: string
  runId?: string
  sessionId?: string
  traceEvents: TraceEvent[]
  references: Reference[]
  traceStatus?: string
  prompt?: string
}

export interface Thread {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messages: Message[]
}

export interface PersistedState {
  threads: Thread[]
  activeThreadId: string
  streamEnabled: boolean
  sidebarCollapsed: boolean
}

/**
 * Storage seam — localStorage in production, in-memory Map in tests.
 */
export interface ConversationStorage {
  load(): PersistedState | null
  save(state: PersistedState): void
}

export interface AddUserMessageInput {
  content: string
  prompt?: string
}

export interface StartAssistantRunInput {
  runId: string
}

/**
 * T58: SSE stream merge — payload shape for one SSE `data:` chunk from /api/chat.
 * Conversation owns the merge logic; app.js owns fetch + ReadableStream.
 */
export interface SseEventData {
  done?: boolean
  sessionId?: string
  event?: TraceEvent
  token?: string
}

/**
 * T58: /chat/runs/:runId history payload — used to restore a previous run's
 * trace events after page reload.
 */
export interface RunHistory {
  sessionId?: string
  events?: TraceEvent[]
}

/**
 * T58: Non-stream /api/chat reply payload — used when streamEnabled is false.
 */
export interface CompleteReplyData {
  runId?: string
  sessionId?: string
  events?: TraceEvent[]
  references?: Reference[]
  status?: string
  reply?: string
}

export interface ProcessSseEventResult {
  done: boolean
}

export interface ApplyCompleteReplyResult {
  ok: boolean
}

export interface Conversation {
  listThreads(): Thread[]
  getActiveThread(): Thread | null
  setActiveThread(threadId: string): void
  createThread(): Thread
  deleteThread(threadId: string): void

  addUserMessage(threadId: string, input: AddUserMessageInput): Message
  startAssistantRun(threadId: string, input: StartAssistantRunInput): Message
  appendAnswerDelta(message: Message, token: string): void
  mergeTraceEvent(message: Message, event: TraceEvent): void
  finalizeRun(message: Message, status: MessageStatus): void

  // T58: SSE stream merge + restore + status policy owned by Conversation.
  processSseEvent(message: Message, data: SseEventData): ProcessSseEventResult
  finalizeStreamRun(message: Message): void
  finalizeAbortedRun(message: Message): void
  finalizeConnectionError(message: Message): void
  applyRunHistory(message: Message, history: RunHistory): void
  applyCompleteReply(
    message: Message,
    data: CompleteReplyData,
    ok: boolean,
  ): ApplyCompleteReplyResult

  load(): PersistedState
  save(): void

  isRunning(): boolean
  startRun(): void
  completeRun(): void
  cancelRun(): void
}

const STORAGE_KEY = "kefu-rag-ui-state-v2"

function createId(prefix: string): string {
  const randomId =
    typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${randomId}`
}

function createThreadInternal(now: () => Date): Thread {
  const iso = now().toISOString()
  return {
    id: createId("thread"),
    title: "新对话",
    createdAt: iso,
    updatedAt: iso,
    messages: [],
  }
}

export function normalizeTraceEvents(events: TraceEvent[] | undefined): TraceEvent[] {
  if (!Array.isArray(events)) return []
  return events
    .filter(
      (event) =>
        event &&
        typeof event.eventId === "string" &&
        Number.isInteger(event.sequence) &&
        typeof event.type === "string",
    )
    .sort((left, right) => left.sequence - right.sequence)
}

export function projectTraceEvents(events: TraceEvent[]): TraceEvent[] {
  const projected: TraceEvent[] = []
  const indexes = new Map<string, number>()
  const normalized = normalizeTraceEvents(events)
  const terminal = [...normalized].reverse().find(({ type }) => type === "done")
  normalized
    .filter(({ type }) => type !== "answer_delta")
    .forEach((event) => {
      const key = `${event.stage}:${event.attempt || 1}:${event.round || 0}`
      const existingIndex = indexes.get(key)
      if (existingIndex === undefined) {
        indexes.set(key, projected.length)
        projected.push(event)
      } else {
        projected[existingIndex] = event
      }
    })
  if (!terminal) return projected
  return projected.map((event) =>
    event.status === "running"
      ? {
          ...event,
          status: terminal.status === "cancelled" ? "cancelled" : "failed",
          outputSummary: terminal.status === "cancelled" ? "cancelled" : "interrupted",
        }
      : event,
  )
}

export function mergeTraceEvent(message: Message, event: TraceEvent): void {
  if (!event || typeof event.eventId !== "string") return
  const byId = new Map((message.traceEvents || []).map((item) => [item.eventId, item]))
  byId.set(event.eventId, event)
  message.traceEvents = normalizeTraceEvents([...byId.values()])
  message.runId = event.runId || message.runId

  if (event.type === "done") {
    message.traceStatus = event.result?.status
    message.references = Array.isArray(event.result?.references)
      ? event.result.references
      : message.references
  }
}

/**
 * T57: reference.js helpers absorbed into Conversation. These format
 * reference metadata for display — section path, page number, image asset URL.
 * Previously lived in frontend/js/reference.js as window.ReferenceUi.
 */
export function formatReferenceLocation(reference: Reference): string {
  const sectionPath = Array.isArray(reference?.sectionPath)
    ? reference.sectionPath.filter(
        (item) => typeof item === "string" && item.trim(),
      )
    : []
  const section = sectionPath.join(" / ")
  const page =
    Number.isInteger(reference?.page) && reference.page! > 0
      ? `第 ${reference.page} 页`
      : ""
  return [section, page].filter(Boolean).join(" · ")
}

export function assetUrl(reference: Reference, apiBase: string): string {
  const assetPath = reference?.image?.assetPath
  if (
    typeof assetPath !== "string" ||
    !/^[a-f0-9]{64}\.[a-z0-9]{1,10}$/.test(assetPath)
  ) {
    return ""
  }
  return `${String(apiBase).replace(/\/$/, "")}/assets/${assetPath}`
}

export class InMemoryConversationStorage implements ConversationStorage {
  private store = new Map<string, PersistedState>()

  load(): PersistedState | null {
    return this.store.get(STORAGE_KEY) ?? null
  }
  save(state: PersistedState): void {
    this.store.set(STORAGE_KEY, state)
  }
  clear(): void {
    this.store.clear()
  }
}

/**
 * LocalStorage-backed storage adapter — only used when window.localStorage
 * is available. In node tests, use InMemoryConversationStorage instead.
 */
export class LocalStorageConversationStorage implements ConversationStorage {
  private readonly key = STORAGE_KEY

  load(): PersistedState | null {
    try {
      const raw = (globalThis as { localStorage?: Storage }).localStorage?.getItem(this.key)
      if (!raw) return null
      return JSON.parse(raw) as PersistedState
    } catch {
      return null
    }
  }

  save(state: PersistedState): void {
    try {
      ;(globalThis as { localStorage?: Storage }).localStorage?.setItem(
        this.key,
        JSON.stringify(state),
      )
    } catch {
      // storage full or unavailable — caller may surface a toast
    }
  }
}

export interface ConversationOptions {
  storage?: ConversationStorage
  now?: () => Date
}

export class ConversationImpl implements Conversation {
  private threads: Thread[]
  private activeThreadId: string
  private streamEnabled: boolean
  private sidebarCollapsed: boolean
  private readonly storage: ConversationStorage
  private readonly now: () => Date
  private running = false

  constructor(options: ConversationOptions = {}) {
    this.storage = options.storage ?? new InMemoryConversationStorage()
    this.now = options.now ?? (() => new Date())
    const persisted = this.load()
    this.threads = persisted.threads
    this.activeThreadId = persisted.activeThreadId
    this.streamEnabled = persisted.streamEnabled
    this.sidebarCollapsed = persisted.sidebarCollapsed
    this.ensureActiveThread()
    // Persist the synthesized fallback state so callers can read it back
    // from storage immediately after construction.
    this.save()
  }

  listThreads(): Thread[] {
    return [...this.threads]
  }

  getActiveThread(): Thread | null {
    return this.threads.find((t) => t.id === this.activeThreadId) ?? null
  }

  setActiveThread(threadId: string): void {
    if (!this.threads.some((t) => t.id === threadId)) return
    this.activeThreadId = threadId
    this.save()
  }

  createThread(): Thread {
    const thread = createThreadInternal(this.now)
    this.threads.unshift(thread)
    this.activeThreadId = thread.id
    this.save()
    return thread
  }

  deleteThread(threadId: string): void {
    const index = this.threads.findIndex((t) => t.id === threadId)
    if (index === -1) return
    this.threads.splice(index, 1)
    if (threadId === this.activeThreadId) {
      const next = this.threads[0] ?? createThreadInternal(this.now)
      if (this.threads.length === 0) this.threads.push(next)
      this.activeThreadId = next.id
    }
    this.save()
  }

  addUserMessage(threadId: string, input: AddUserMessageInput): Message {
    const thread = this.threads.find((t) => t.id === threadId)
    if (!thread) throw new Error(`thread ${threadId} not found`)
    const now = this.now().toISOString()
    const message: Message = {
      id: createId("message"),
      role: "user",
      content: input.content,
      status: "complete",
      createdAt: now,
      traceEvents: [],
      references: [],
    }
    if (input.prompt) message.prompt = input.prompt
    thread.messages.push(message)
    thread.updatedAt = now
    this.updateThreadTitle(thread, input.content)
    this.save()
    return message
  }

  startAssistantRun(threadId: string, input: StartAssistantRunInput): Message {
    const thread = this.threads.find((t) => t.id === threadId)
    if (!thread) throw new Error(`thread ${threadId} not found`)
    const now = this.now().toISOString()
    const message: Message = {
      id: createId("message"),
      role: "assistant",
      content: "",
      status: "running",
      createdAt: now,
      runId: input.runId,
      traceEvents: [],
      references: [],
    }
    thread.messages.push(message)
    thread.updatedAt = now
    this.save()
    return message
  }

  appendAnswerDelta(message: Message, token: string): void {
    message.content += token
  }

  mergeTraceEvent(message: Message, event: TraceEvent): void {
    mergeTraceEvent(message, event)
  }

  finalizeRun(message: Message, status: MessageStatus): void {
    message.status = status
  }

  /**
   * T58: SSE stream merge — owns the per-chunk merge logic. app.js only owns
   * fetch + ReadableStream parsing; this method handles sessionId/event/token
   * merge and done detection. Returns `{ done }` so app.js can break the loop.
   */
  processSseEvent(message: Message, data: SseEventData): ProcessSseEventResult {
    if (data && typeof data.sessionId === "string") message.sessionId = data.sessionId
    if (data && data.event) this.mergeTraceEvent(message, data.event)
    if (
      data &&
      data.event &&
      data.event.type === "answer_delta" &&
      typeof data.token === "string"
    ) {
      this.appendAnswerDelta(message, data.token)
    } else if (
      data &&
      !data.event &&
      !data.done &&
      typeof data.token === "string"
    ) {
      this.appendAnswerDelta(message, data.token)
    }
    return { done: data?.done === true }
  }

  /**
   * T58: Stream completion status policy. When the stream ends, decide the
   * final status and content fallback based on traceStatus.
   */
  finalizeStreamRun(message: Message): void {
    const failed =
      message.traceStatus === "provider_error" ||
      message.traceStatus === "invalid_citation"
    if (!message.content) {
      message.content = failed ? "处理请求时出现错误，请重试。" : "（回答内容为空）"
    }
    message.status = failed ? "error" : "complete"
  }

  /**
   * T58: Abort status policy — user cancelled the run. Keep partial content;
   * fall back to "已停止生成。" only when no content was produced.
   */
  finalizeAbortedRun(message: Message): void {
    if (!message.content) message.content = "已停止生成。"
    message.status = "complete"
  }

  /**
   * T58: Network/connection error status policy — surface a friendly error
   * message and mark the run as errored.
   */
  finalizeConnectionError(message: Message): void {
    message.content = "连接服务器失败，请确认后端服务已启动后重试。"
    message.status = "error"
  }

  /**
   * T58: Restore a previous run's trace events from /chat/runs/:runId.
   * Owns normalization + done-event merge so app.js just hands off the JSON.
   */
  applyRunHistory(message: Message, history: RunHistory): void {
    if (!history) return
    if (typeof history.sessionId === "string") message.sessionId = history.sessionId
    message.traceEvents = normalizeTraceEvents(history.events)
    const done = [...message.traceEvents].reverse().find((event) => event.type === "done")
    if (done) this.mergeTraceEvent(message, done)
  }

  /**
   * T58: Non-stream reply merge + status policy. Owns runId/sessionId/
   * traceEvents/references/traceStatus/content/status. `ok` reflects
   * response.ok; status policy picks "error" or "complete" accordingly.
   */
  applyCompleteReply(
    message: Message,
    data: CompleteReplyData,
    ok: boolean,
  ): ApplyCompleteReplyResult {
    if (data && typeof data.runId === "string") message.runId = data.runId
    if (data && typeof data.sessionId === "string") message.sessionId = data.sessionId
    message.traceEvents = normalizeTraceEvents(data?.events)
    message.references = Array.isArray(data?.references) ? data.references : []
    message.traceStatus = data?.status
    if (!ok) {
      message.content = "处理请求时出现错误，请重试。"
      message.status = "error"
      return { ok: false }
    }
    message.content = typeof data?.reply === "string" ? data.reply : "（回答内容为空）"
    message.status = "complete"
    return { ok: true }
  }

  load(): PersistedState {
    const fallback = createThreadInternal(this.now)
    const fallbackState: PersistedState = {
      threads: [fallback],
      activeThreadId: fallback.id,
      streamEnabled: true,
      sidebarCollapsed: false,
    }
    const loaded = this.storage.load()
    if (!loaded) return fallbackState
    if (!Array.isArray(loaded.threads)) return fallbackState
    if (loaded.threads.length === 0) return fallbackState
    const activeThreadExists = loaded.threads.some((t) => t.id === loaded.activeThreadId)
    return {
      threads: loaded.threads,
      activeThreadId: activeThreadExists ? loaded.activeThreadId : loaded.threads[0].id,
      streamEnabled: loaded.streamEnabled !== false,
      sidebarCollapsed: loaded.sidebarCollapsed === true,
    }
  }

  save(): void {
    this.storage.save({
      threads: this.threads.map((thread) => ({
        ...thread,
        messages: thread.messages.map(({ prompt, ...rest }) => rest),
      })),
      activeThreadId: this.activeThreadId,
      streamEnabled: this.streamEnabled,
      sidebarCollapsed: this.sidebarCollapsed,
    })
  }

  isRunning(): boolean {
    return this.running
  }

  startRun(): void {
    this.running = true
  }

  completeRun(): void {
    this.running = false
  }

  cancelRun(): void {
    this.running = false
  }

  getStreamEnabled(): boolean {
    return this.streamEnabled
  }

  setStreamEnabled(enabled: boolean): void {
    this.streamEnabled = enabled
    this.save()
  }

  getSidebarCollapsed(): boolean {
    return this.sidebarCollapsed
  }

  setSidebarCollapsed(collapsed: boolean): void {
    this.sidebarCollapsed = collapsed
    this.save()
  }

  private ensureActiveThread(): void {
    if (!this.threads.some((t) => t.id === this.activeThreadId)) {
      const thread = createThreadInternal(this.now)
      this.threads.unshift(thread)
      this.activeThreadId = thread.id
    }
  }

  private updateThreadTitle(thread: Thread, content: string): void {
    if (thread.messages.filter((m) => m.role === "user").length !== 1) return
    const normalized = content.replace(/\s+/g, " ").trim()
    thread.title =
      normalized.length > 28 ? `${normalized.slice(0, 28)}…` : normalized || "新对话"
  }
}
