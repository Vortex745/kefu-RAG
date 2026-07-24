import assert from "node:assert/strict"
import test from "node:test"
import {
  ConversationImpl,
  InMemoryConversationStorage,
  assetUrl,
  formatReferenceLocation,
  mergeTraceEvent,
  normalizeTraceEvents,
  projectTraceEvents,
  type CompleteReplyData,
  type Message,
  type Reference,
  type RunHistory,
  type SseEventData,
  type TraceEvent,
  type PersistedState,
} from "./conversation"

function fixedNow(): Date {
  return new Date("2026-07-16T10:00:00.000Z")
}

function makeEvent(seq: number, eventId: string, type: string, extra: Partial<TraceEvent> = {}): TraceEvent {
  return {
    eventId,
    sequence: seq,
    type,
    ...extra,
  }
}

test("Conversation creates a thread on first load and persists it", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })

  const thread = conv.getActiveThread()
  assert.ok(thread, "active thread must exist after construction")
  assert.equal(thread!.messages.length, 0)

  const persisted = storage.load()
  assert.ok(persisted, "state must be persisted on construction")
  assert.equal(persisted!.threads.length, 1)
  assert.equal(persisted!.threads[0].id, thread!.id)
})

test("Conversation creates a new thread and switches active", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })
  const original = conv.getActiveThread()!
  const created = conv.createThread()

  assert.notEqual(created.id, original.id)
  assert.equal(conv.getActiveThread()?.id, created.id)
  assert.equal(conv.listThreads().length, 2)
})

test("Conversation deletes a thread and falls back to another", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })
  const first = conv.getActiveThread()!
  const second = conv.createThread()

  conv.setActiveThread(first.id)
  conv.deleteThread(first.id)

  assert.equal(conv.getActiveThread()?.id, second.id)
  assert.equal(conv.listThreads().length, 1)
})

test("Conversation deletes the last thread and synthesizes a new fallback", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })
  const only = conv.getActiveThread()!

  conv.deleteThread(only.id)

  const replacement = conv.getActiveThread()
  assert.ok(replacement, "deleting the last thread must synthesize a new one")
  assert.notEqual(replacement!.id, only.id)
  assert.equal(conv.listThreads().length, 1)
})

test("Conversation addUserMessage appends a user message and updates the title", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })
  const thread = conv.getActiveThread()!

  const message = conv.addUserMessage(thread.id, { content: "如何退款" })

  assert.equal(message.role, "user")
  assert.equal(message.content, "如何退款")
  assert.equal(message.status, "complete")
  assert.equal(thread.messages.length, 1)
  assert.equal(thread.title, "如何退款")
})

test("Conversation addUserMessage truncates title beyond 28 chars", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })
  const thread = conv.getActiveThread()!

  const longContent = "a".repeat(40)
  conv.addUserMessage(thread.id, { content: longContent })

  assert.equal(thread.title, "a".repeat(28) + "…")
})

test("Conversation addUserMessage preserves prompt for re-generation", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })
  const thread = conv.getActiveThread()!

  const message = conv.addUserMessage(thread.id, {
    content: "visible text",
    prompt: "visible text\n\n[附件：policy.txt]",
  })

  assert.equal(message.prompt, "visible text\n\n[附件：policy.txt]")
})

test("Conversation startAssistantRun creates a running assistant message with runId", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })
  const thread = conv.getActiveThread()!

  const message = conv.startAssistantRun(thread.id, { runId: "run-1" })

  assert.equal(message.role, "assistant")
  assert.equal(message.status, "running")
  assert.equal(message.runId, "run-1")
  assert.equal(thread.messages.length, 1)
})

test("Conversation appendAnswerDelta accumulates tokens", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })
  const thread = conv.getActiveThread()!
  const message = conv.startAssistantRun(thread.id, { runId: "run-1" })

  conv.appendAnswerDelta(message, "Hello")
  conv.appendAnswerDelta(message, " world")

  assert.equal(message.content, "Hello world")
})

test("Conversation mergeTraceEvent dedupes by eventId and sorts by sequence", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })
  const thread = conv.getActiveThread()!
  const message = conv.startAssistantRun(thread.id, { runId: "run-1" })

  const e1 = makeEvent(1, "e1", "progress", { stage: "route" })
  const e2 = makeEvent(2, "e2", "progress", { stage: "retrieval" })
  // out-of-order insertion
  conv.mergeTraceEvent(message, e2)
  conv.mergeTraceEvent(message, e1)
  // overwrite e1 with a new event at the same eventId
  const e1Updated = makeEvent(1, "e1", "progress", { stage: "route", status: "done" })
  conv.mergeTraceEvent(message, e1Updated)

  assert.deepEqual(
    message.traceEvents.map((e) => e.eventId),
    ["e1", "e2"],
  )
  assert.equal(message.traceEvents[0].status, "done")
})

test("Conversation mergeTraceEvent with done event sets traceStatus and references", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })
  const thread = conv.getActiveThread()!
  const message = conv.startAssistantRun(thread.id, { runId: "run-1" })

  const done = makeEvent(3, "done-1", "done", {
    stage: "done",
    runId: "run-1",
    result: { status: "completed", references: [{ id: "ref-1", title: "Refund Policy" }] },
  })

  conv.mergeTraceEvent(message, done)

  assert.equal(message.traceStatus, "completed")
  assert.equal(message.references.length, 1)
  assert.equal(message.references[0].id, "ref-1")
})

test("Conversation finalizeRun sets message status", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })
  const thread = conv.getActiveThread()!
  const message = conv.startAssistantRun(thread.id, { runId: "run-1" })

  conv.finalizeRun(message, "complete")

  assert.equal(message.status, "complete")
})

test("Conversation run race handling: startRun, completeRun, cancelRun", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })

  assert.equal(conv.isRunning(), false)
  conv.startRun()
  assert.equal(conv.isRunning(), true)
  conv.completeRun()
  assert.equal(conv.isRunning(), false)

  conv.startRun()
  conv.cancelRun()
  assert.equal(conv.isRunning(), false)
})

test("Conversation persistence round-trips threads and settings", () => {
  const storage = new InMemoryConversationStorage()
  const first = new ConversationImpl({ storage, now: fixedNow })
  const thread = first.getActiveThread()!
  first.addUserMessage(thread.id, { content: "你好" })
  first.setStreamEnabled(false)
  first.setSidebarCollapsed(true)

  // New instance, same storage — state must be restored.
  const second = new ConversationImpl({ storage, now: fixedNow })
  const restored = second.getActiveThread()!
  assert.equal(restored.id, thread.id)
  assert.equal(restored.messages.length, 1)
  assert.equal(restored.messages[0].content, "你好")
  assert.equal(second.getStreamEnabled(), false)
  assert.equal(second.getSidebarCollapsed(), true)
})

test("Conversation persistence drops prompt field from user messages", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })
  const thread = conv.getActiveThread()!
  conv.addUserMessage(thread.id, {
    content: "visible",
    prompt: "hidden prompt context",
  })
  conv.save()

  const persisted = storage.load() as PersistedState
  assert.equal(persisted.threads[0].messages[0].prompt, undefined)
})

test("Conversation load with corrupted storage returns fallback state", () => {
  const storage = new InMemoryConversationStorage()
  storage.save({
    threads: [],
    activeThreadId: "missing",
    streamEnabled: true,
    sidebarCollapsed: false,
  })

  const conv = new ConversationImpl({ storage, now: fixedNow })
  const thread = conv.getActiveThread()
  assert.ok(thread, "empty threads array must synthesize a fallback thread")
  assert.equal(thread!.messages.length, 0)
})

test("Conversation load with missing active thread falls back to first thread", () => {
  const storage = new InMemoryConversationStorage()
  storage.save({
    threads: [
      {
        id: "thread-A",
        title: "A",
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
        messages: [],
      },
    ],
    activeThreadId: "thread-missing",
    streamEnabled: true,
    sidebarCollapsed: false,
  })

  const conv = new ConversationImpl({ storage, now: fixedNow })
  assert.equal(conv.getActiveThread()?.id, "thread-A")
})

test("normalizeTraceEvents filters malformed events and sorts by sequence", () => {
  const events = [
    { eventId: "e1", sequence: 2, type: "progress" },
    { eventId: "e2", sequence: 1, type: "progress" },
    // malformed — filtered out
    { eventId: "e3", sequence: 3, type: 123 } as unknown as TraceEvent,
    { sequence: 4, type: "progress" } as TraceEvent, // missing eventId
  ]
  const result = normalizeTraceEvents(events)
  assert.deepEqual(
    result.map((e) => e.eventId),
    ["e2", "e1"],
  )
})

test("projectTraceEvents merges events with same stage:attempt:round key", () => {
  const events: TraceEvent[] = [
    makeEvent(1, "e1", "progress", { stage: "route", attempt: 1, round: 0, status: "running" }),
    makeEvent(2, "e2", "progress", { stage: "route", attempt: 1, round: 0, status: "done" }),
    makeEvent(3, "e3", "progress", { stage: "retrieval", attempt: 1, round: 0 }),
    makeEvent(4, "e4", "answer_delta"),
    makeEvent(5, "e5", "done", { stage: "done", status: "completed" }),
  ]

  const projected = projectTraceEvents(events)
  // answer_delta filtered out; e2 overwrote e1 at the same key; e5 (done)
  // is kept as its own key since stage="done" is distinct from "route".
  assert.deepEqual(
    projected.map((e) => e.eventId),
    ["e2", "e3", "e5"],
  )
  // e2 overwrote e1 at the same key
  assert.equal(projected[0].status, "done")
})

test("projectTraceEvents marks still-running events as failed when terminal is not cancelled", () => {
  const events: TraceEvent[] = [
    makeEvent(1, "e1", "progress", { stage: "route", status: "running" }),
    makeEvent(2, "e2", "progress", { stage: "retrieval", status: "running" }),
    makeEvent(3, "e3", "done", { stage: "done", status: "provider_error" }),
  ]

  const projected = projectTraceEvents(events)
  // The done event itself is kept; its status is not "running" so it stays as-is.
  assert.deepEqual(
    projected.map((e) => e.status),
    ["failed", "failed", "provider_error"],
  )
})

test("projectTraceEvents marks still-running events as cancelled when terminal is cancelled", () => {
  const events: TraceEvent[] = [
    makeEvent(1, "e1", "progress", { stage: "route", status: "running" }),
    makeEvent(2, "e2", "done", { stage: "done", status: "cancelled" }),
  ]

  const projected = projectTraceEvents(events)
  assert.equal(projected[0].status, "cancelled")
  // The done event itself keeps its cancelled status (not re-mapped).
  assert.equal(projected[1].status, "cancelled")
})

test("mergeTraceEvent standalone function preserves message.runId from event.runId", () => {
  const message: Message = {
    id: "m1",
    role: "assistant",
    content: "",
    status: "running",
    createdAt: "2026-07-16T00:00:00.000Z",
    traceEvents: [],
    references: [],
  }

  mergeTraceEvent(message, makeEvent(1, "e1", "progress", { runId: "run-from-event" }))
  assert.equal(message.runId, "run-from-event")
})

test("formatReferenceLocation joins section path and page number", () => {
  const reference: Reference = {
    id: "ref-1",
    sectionPath: ["Refund Policy", "Eligibility"],
    page: 3,
  }
  assert.equal(formatReferenceLocation(reference), "Refund Policy / Eligibility · 第 3 页")
})

test("formatReferenceLocation omits empty section path and zero page", () => {
  const reference: Reference = {
    id: "ref-1",
    sectionPath: [],
    page: 0,
  }
  assert.equal(formatReferenceLocation(reference), "")
})

test("formatReferenceLocation filters blank section entries", () => {
  const reference: Reference = {
    id: "ref-1",
    sectionPath: ["Policy", "  ", ""],
    page: 1,
  }
  assert.equal(formatReferenceLocation(reference), "Policy · 第 1 页")
})

test("formatReferenceLocation handles missing reference fields gracefully", () => {
  const reference: Reference = { id: "ref-1" }
  assert.equal(formatReferenceLocation(reference), "")
})

test("assetUrl returns empty string when no image assetPath is present", () => {
  const reference: Reference = { id: "ref-1" }
  assert.equal(assetUrl(reference, "http://localhost:3001/api"), "")
})

test("assetUrl rejects malformed assetPath (wrong length or characters)", () => {
  const reference: Reference = {
    id: "ref-1",
    image: { assetPath: "not-a-hash.png" },
  }
  assert.equal(assetUrl(reference, "http://localhost:3001/api"), "")
})

test("assetUrl builds URL from valid sha-256 hash assetPath", () => {
  const sha =
    "a".repeat(64) + ".png" // 64 hex chars + .png
  const reference: Reference = {
    id: "ref-1",
    image: { assetPath: sha },
  }
  assert.equal(
    assetUrl(reference, "http://localhost:3001/api"),
    `http://localhost:3001/api/assets/${sha}`,
  )
})

test("assetUrl strips trailing slash from apiBase", () => {
  const sha = "b".repeat(64) + ".jpg"
  const reference: Reference = {
    id: "ref-1",
    image: { assetPath: sha },
  }
  assert.equal(
    assetUrl(reference, "http://localhost:3001/api/"),
    `http://localhost:3001/api/assets/${sha}`,
  )
})

// ---------------------------------------------------------------------------
// T58: SSE stream merge, restore, status policy, run race handling.
// ---------------------------------------------------------------------------

function makeRunningAssistantMessage(): Message {
  return {
    id: "m-running",
    role: "assistant",
    content: "",
    status: "running",
    createdAt: "2026-07-16T10:00:00.000Z",
    traceEvents: [],
    references: [],
  }
}

test("processSseEvent merges trace event and appends token when event is answer_delta", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })
  const message = makeRunningAssistantMessage()
  const event = makeEvent(1, "e1", "answer_delta", { stage: "answer" })

  const result = conv.processSseEvent(message, {
    sessionId: "sess-1",
    event,
    token: "Hello",
  })

  assert.equal(result.done, false)
  assert.equal(message.sessionId, "sess-1")
  assert.equal(message.traceEvents.length, 1)
  assert.equal(message.content, "Hello")
})

test("processSseEvent appends token when no event and not done", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })
  const message = makeRunningAssistantMessage()

  conv.processSseEvent(message, { token: "World" })
  assert.equal(message.content, "World")
})

test("processSseEvent does not append token when event is not answer_delta", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })
  const message = makeRunningAssistantMessage()
  const event = makeEvent(1, "e1", "progress", { stage: "route" })

  conv.processSseEvent(message, { event, token: "ignored" })
  assert.equal(message.content, "")
  assert.equal(message.traceEvents.length, 1)
})

test("processSseEvent detects done marker", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })
  const message = makeRunningAssistantMessage()

  const result = conv.processSseEvent(message, { done: true })
  assert.equal(result.done, true)
})

test("processSseEvent preserves existing sessionId when chunk lacks it", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })
  const message = makeRunningAssistantMessage()
  message.sessionId = "pre-existing"

  conv.processSseEvent(message, { token: "x" })
  assert.equal(message.sessionId, "pre-existing")
})

test("finalizeStreamRun marks error when traceStatus is provider_error", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })
  const message = makeRunningAssistantMessage()
  message.traceStatus = "provider_error"

  conv.finalizeStreamRun(message)
  assert.equal(message.status, "error")
  assert.equal(message.content, "处理请求时出现错误，请重试。")
})

test("finalizeStreamRun marks complete when traceStatus is healthy", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })
  const message = makeRunningAssistantMessage()
  message.content = "partial answer"
  message.traceStatus = "completed"

  conv.finalizeStreamRun(message)
  assert.equal(message.status, "complete")
  assert.equal(message.content, "partial answer")
})

test("finalizeStreamRun falls back to placeholder when no content and healthy", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })
  const message = makeRunningAssistantMessage()

  conv.finalizeStreamRun(message)
  assert.equal(message.status, "complete")
  assert.equal(message.content, "（回答内容为空）")
})

test("finalizeAbortedRun keeps partial content and marks complete", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })
  const message = makeRunningAssistantMessage()
  message.content = "partial"

  conv.finalizeAbortedRun(message)
  assert.equal(message.status, "complete")
  assert.equal(message.content, "partial")
})

test("finalizeAbortedRun falls back to stopped message when no content", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })
  const message = makeRunningAssistantMessage()

  conv.finalizeAbortedRun(message)
  assert.equal(message.status, "complete")
  assert.equal(message.content, "已停止生成。")
})

test("finalizeConnectionError marks error with friendly message", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })
  const message = makeRunningAssistantMessage()
  message.content = "partial"

  conv.finalizeConnectionError(message)
  assert.equal(message.status, "error")
  assert.equal(message.content, "连接服务器失败，请确认后端服务已启动后重试。")
})

test("applyRunHistory normalizes events and merges done event", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })
  const message = makeRunningAssistantMessage()
  const history: RunHistory = {
    sessionId: "sess-restored",
    events: [
      makeEvent(2, "e2", "progress", { stage: "retrieval" }),
      makeEvent(1, "e1", "progress", { stage: "route" }),
      makeEvent(3, "e3", "done", { result: { status: "completed" } }),
    ],
  }

  conv.applyRunHistory(message, history)
  assert.equal(message.sessionId, "sess-restored")
  assert.equal(message.traceEvents.length, 3)
  assert.equal(message.traceEvents[0].eventId, "e1")
  assert.equal(message.traceEvents[2].eventId, "e3")
  assert.equal(message.traceStatus, "completed")
})

test("applyRunHistory preserves existing sessionId when history lacks it", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })
  const message = makeRunningAssistantMessage()
  message.sessionId = "pre-existing"

  conv.applyRunHistory(message, { events: [] })
  assert.equal(message.sessionId, "pre-existing")
})

test("applyRunHistory ignores null history gracefully", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })
  const message = makeRunningAssistantMessage()
  message.sessionId = "pre-existing"

  // @ts-expect-error — verifying runtime defensive check
  conv.applyRunHistory(message, null)
  assert.equal(message.sessionId, "pre-existing")
})

test("applyCompleteReply merges all fields and marks complete when ok", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })
  const message = makeRunningAssistantMessage()
  const data: CompleteReplyData = {
    runId: "run-9",
    sessionId: "sess-9",
    events: [makeEvent(1, "e1", "done", { result: { status: "completed" } })],
    references: [{ id: "ref-1" }],
    status: "completed",
    reply: "final answer",
  }

  const result = conv.applyCompleteReply(message, data, true)

  assert.equal(result.ok, true)
  assert.equal(message.runId, "run-9")
  assert.equal(message.sessionId, "sess-9")
  assert.equal(message.traceEvents.length, 1)
  assert.equal(message.references.length, 1)
  assert.equal(message.traceStatus, "completed")
  assert.equal(message.content, "final answer")
  assert.equal(message.status, "complete")
})

test("applyCompleteReply marks error when response not ok", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })
  const message = makeRunningAssistantMessage()
  const data: CompleteReplyData = {
    status: "provider_error",
    reply: "ignored",
  }

  const result = conv.applyCompleteReply(message, data, false)

  assert.equal(result.ok, false)
  assert.equal(message.status, "error")
  assert.equal(message.content, "处理请求时出现错误，请重试。")
})

test("applyCompleteReply falls back to placeholder when reply missing", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })
  const message = makeRunningAssistantMessage()

  conv.applyCompleteReply(message, {}, true)
  assert.equal(message.status, "complete")
  assert.equal(message.content, "（回答内容为空）")
})

test("run race: isRunning blocks until startRun is called", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })

  assert.equal(conv.isRunning(), false)
  conv.startRun()
  assert.equal(conv.isRunning(), true)
  conv.completeRun()
  assert.equal(conv.isRunning(), false)
})

test("run race: cancelRun stops the run", () => {
  const storage = new InMemoryConversationStorage()
  const conv = new ConversationImpl({ storage, now: fixedNow })

  conv.startRun()
  conv.cancelRun()
  assert.equal(conv.isRunning(), false)
})
