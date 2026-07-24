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
const STORAGE_KEY = "kefu-rag-ui-state-v2";
function createId(prefix) {
    const randomId = typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}-${randomId}`;
}
function createThreadInternal(now) {
    const iso = now().toISOString();
    return {
        id: createId("thread"),
        title: "新对话",
        createdAt: iso,
        updatedAt: iso,
        messages: [],
    };
}
export function normalizeTraceEvents(events) {
    if (!Array.isArray(events))
        return [];
    return events
        .filter((event) => event &&
        typeof event.eventId === "string" &&
        Number.isInteger(event.sequence) &&
        typeof event.type === "string")
        .sort((left, right) => left.sequence - right.sequence);
}
export function projectTraceEvents(events) {
    const projected = [];
    const indexes = new Map();
    const normalized = normalizeTraceEvents(events);
    const terminal = [...normalized].reverse().find(({ type }) => type === "done");
    normalized
        .filter(({ type }) => type !== "answer_delta")
        .forEach((event) => {
        const key = `${event.stage}:${event.attempt || 1}:${event.round || 0}`;
        const existingIndex = indexes.get(key);
        if (existingIndex === undefined) {
            indexes.set(key, projected.length);
            projected.push(event);
        }
        else {
            projected[existingIndex] = event;
        }
    });
    if (!terminal)
        return projected;
    return projected.map((event) => event.status === "running"
        ? {
            ...event,
            status: terminal.status === "cancelled" ? "cancelled" : "failed",
            outputSummary: terminal.status === "cancelled" ? "cancelled" : "interrupted",
        }
        : event);
}
export function mergeTraceEvent(message, event) {
    if (!event || typeof event.eventId !== "string")
        return;
    const byId = new Map((message.traceEvents || []).map((item) => [item.eventId, item]));
    byId.set(event.eventId, event);
    message.traceEvents = normalizeTraceEvents([...byId.values()]);
    message.runId = event.runId || message.runId;
    if (event.type === "done") {
        message.traceStatus = event.result?.status;
        message.references = Array.isArray(event.result?.references)
            ? event.result.references
            : message.references;
    }
}
/**
 * T57: reference.js helpers absorbed into Conversation. These format
 * reference metadata for display — section path, page number, image asset URL.
 * Previously lived in frontend/js/reference.js as window.ReferenceUi.
 */
export function formatReferenceLocation(reference) {
    const sectionPath = Array.isArray(reference?.sectionPath)
        ? reference.sectionPath.filter((item) => typeof item === "string" && item.trim())
        : [];
    const section = sectionPath.join(" / ");
    const page = Number.isInteger(reference?.page) && reference.page > 0
        ? `第 ${reference.page} 页`
        : "";
    return [section, page].filter(Boolean).join(" · ");
}
export function assetUrl(reference, apiBase) {
    const assetPath = reference?.image?.assetPath;
    if (typeof assetPath !== "string" ||
        !/^[a-f0-9]{64}\.[a-z0-9]{1,10}$/.test(assetPath)) {
        return "";
    }
    return `${String(apiBase).replace(/\/$/, "")}/assets/${assetPath}`;
}
export class InMemoryConversationStorage {
    store = new Map();
    load() {
        return this.store.get(STORAGE_KEY) ?? null;
    }
    save(state) {
        this.store.set(STORAGE_KEY, state);
    }
    clear() {
        this.store.clear();
    }
}
/**
 * LocalStorage-backed storage adapter — only used when window.localStorage
 * is available. In node tests, use InMemoryConversationStorage instead.
 */
export class LocalStorageConversationStorage {
    key = STORAGE_KEY;
    load() {
        try {
            const raw = globalThis.localStorage?.getItem(this.key);
            if (!raw)
                return null;
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    save(state) {
        try {
            ;
            globalThis.localStorage?.setItem(this.key, JSON.stringify(state));
        }
        catch {
            // storage full or unavailable — caller may surface a toast
        }
    }
}
export class ConversationImpl {
    threads;
    activeThreadId;
    streamEnabled;
    sidebarCollapsed;
    storage;
    now;
    running = false;
    constructor(options = {}) {
        this.storage = options.storage ?? new InMemoryConversationStorage();
        this.now = options.now ?? (() => new Date());
        const persisted = this.load();
        this.threads = persisted.threads;
        this.activeThreadId = persisted.activeThreadId;
        this.streamEnabled = persisted.streamEnabled;
        this.sidebarCollapsed = persisted.sidebarCollapsed;
        this.ensureActiveThread();
        // Persist the synthesized fallback state so callers can read it back
        // from storage immediately after construction.
        this.save();
    }
    listThreads() {
        return [...this.threads];
    }
    getActiveThread() {
        return this.threads.find((t) => t.id === this.activeThreadId) ?? null;
    }
    setActiveThread(threadId) {
        if (!this.threads.some((t) => t.id === threadId))
            return;
        this.activeThreadId = threadId;
        this.save();
    }
    createThread() {
        const thread = createThreadInternal(this.now);
        this.threads.unshift(thread);
        this.activeThreadId = thread.id;
        this.save();
        return thread;
    }
    deleteThread(threadId) {
        const index = this.threads.findIndex((t) => t.id === threadId);
        if (index === -1)
            return;
        this.threads.splice(index, 1);
        if (threadId === this.activeThreadId) {
            const next = this.threads[0] ?? createThreadInternal(this.now);
            if (this.threads.length === 0)
                this.threads.push(next);
            this.activeThreadId = next.id;
        }
        this.save();
    }
    addUserMessage(threadId, input) {
        const thread = this.threads.find((t) => t.id === threadId);
        if (!thread)
            throw new Error(`thread ${threadId} not found`);
        const now = this.now().toISOString();
        const message = {
            id: createId("message"),
            role: "user",
            content: input.content,
            status: "complete",
            createdAt: now,
            traceEvents: [],
            references: [],
        };
        if (input.prompt)
            message.prompt = input.prompt;
        thread.messages.push(message);
        thread.updatedAt = now;
        this.updateThreadTitle(thread, input.content);
        this.save();
        return message;
    }
    startAssistantRun(threadId, input) {
        const thread = this.threads.find((t) => t.id === threadId);
        if (!thread)
            throw new Error(`thread ${threadId} not found`);
        const now = this.now().toISOString();
        const message = {
            id: createId("message"),
            role: "assistant",
            content: "",
            status: "running",
            createdAt: now,
            runId: input.runId,
            traceEvents: [],
            references: [],
        };
        thread.messages.push(message);
        thread.updatedAt = now;
        this.save();
        return message;
    }
    appendAnswerDelta(message, token) {
        message.content += token;
    }
    mergeTraceEvent(message, event) {
        mergeTraceEvent(message, event);
    }
    finalizeRun(message, status) {
        message.status = status;
    }
    /**
     * T58: SSE stream merge — owns the per-chunk merge logic. app.js only owns
     * fetch + ReadableStream parsing; this method handles sessionId/event/token
     * merge and done detection. Returns `{ done }` so app.js can break the loop.
     */
    processSseEvent(message, data) {
        if (data && typeof data.sessionId === "string")
            message.sessionId = data.sessionId;
        if (data && data.event)
            this.mergeTraceEvent(message, data.event);
        if (data &&
            data.event &&
            data.event.type === "answer_delta" &&
            typeof data.token === "string") {
            this.appendAnswerDelta(message, data.token);
        }
        else if (data &&
            !data.event &&
            !data.done &&
            typeof data.token === "string") {
            this.appendAnswerDelta(message, data.token);
        }
        return { done: data?.done === true };
    }
    /**
     * T58: Stream completion status policy. When the stream ends, decide the
     * final status and content fallback based on traceStatus.
     */
    finalizeStreamRun(message) {
        const failed = message.traceStatus === "provider_error" ||
            message.traceStatus === "invalid_citation";
        if (!message.content) {
            message.content = failed ? "处理请求时出现错误，请重试。" : "（回答内容为空）";
        }
        message.status = failed ? "error" : "complete";
    }
    /**
     * T58: Abort status policy — user cancelled the run. Keep partial content;
     * fall back to "已停止生成。" only when no content was produced.
     */
    finalizeAbortedRun(message) {
        if (!message.content)
            message.content = "已停止生成。";
        message.status = "complete";
    }
    /**
     * T58: Network/connection error status policy — surface a friendly error
     * message and mark the run as errored.
     */
    finalizeConnectionError(message) {
        message.content = "连接服务器失败，请确认后端服务已启动后重试。";
        message.status = "error";
    }
    /**
     * T58: Restore a previous run's trace events from /chat/runs/:runId.
     * Owns normalization + done-event merge so app.js just hands off the JSON.
     */
    applyRunHistory(message, history) {
        if (!history)
            return;
        if (typeof history.sessionId === "string")
            message.sessionId = history.sessionId;
        message.traceEvents = normalizeTraceEvents(history.events);
        const done = [...message.traceEvents].reverse().find((event) => event.type === "done");
        if (done)
            this.mergeTraceEvent(message, done);
    }
    /**
     * T58: Non-stream reply merge + status policy. Owns runId/sessionId/
     * traceEvents/references/traceStatus/content/status. `ok` reflects
     * response.ok; status policy picks "error" or "complete" accordingly.
     */
    applyCompleteReply(message, data, ok) {
        if (data && typeof data.runId === "string")
            message.runId = data.runId;
        if (data && typeof data.sessionId === "string")
            message.sessionId = data.sessionId;
        message.traceEvents = normalizeTraceEvents(data?.events);
        message.references = Array.isArray(data?.references) ? data.references : [];
        message.traceStatus = data?.status;
        if (!ok) {
            message.content = "处理请求时出现错误，请重试。";
            message.status = "error";
            return { ok: false };
        }
        message.content = typeof data?.reply === "string" ? data.reply : "（回答内容为空）";
        message.status = "complete";
        return { ok: true };
    }
    load() {
        const fallback = createThreadInternal(this.now);
        const fallbackState = {
            threads: [fallback],
            activeThreadId: fallback.id,
            streamEnabled: true,
            sidebarCollapsed: false,
        };
        const loaded = this.storage.load();
        if (!loaded)
            return fallbackState;
        if (!Array.isArray(loaded.threads))
            return fallbackState;
        if (loaded.threads.length === 0)
            return fallbackState;
        const activeThreadExists = loaded.threads.some((t) => t.id === loaded.activeThreadId);
        return {
            threads: loaded.threads,
            activeThreadId: activeThreadExists ? loaded.activeThreadId : loaded.threads[0].id,
            streamEnabled: loaded.streamEnabled !== false,
            sidebarCollapsed: loaded.sidebarCollapsed === true,
        };
    }
    save() {
        this.storage.save({
            threads: this.threads.map((thread) => ({
                ...thread,
                messages: thread.messages.map(({ prompt, ...rest }) => rest),
            })),
            activeThreadId: this.activeThreadId,
            streamEnabled: this.streamEnabled,
            sidebarCollapsed: this.sidebarCollapsed,
        });
    }
    isRunning() {
        return this.running;
    }
    startRun() {
        this.running = true;
    }
    completeRun() {
        this.running = false;
    }
    cancelRun() {
        this.running = false;
    }
    getStreamEnabled() {
        return this.streamEnabled;
    }
    setStreamEnabled(enabled) {
        this.streamEnabled = enabled;
        this.save();
    }
    getSidebarCollapsed() {
        return this.sidebarCollapsed;
    }
    setSidebarCollapsed(collapsed) {
        this.sidebarCollapsed = collapsed;
        this.save();
    }
    ensureActiveThread() {
        if (!this.threads.some((t) => t.id === this.activeThreadId)) {
            const thread = createThreadInternal(this.now);
            this.threads.unshift(thread);
            this.activeThreadId = thread.id;
        }
    }
    updateThreadTitle(thread, content) {
        if (thread.messages.filter((m) => m.role === "user").length !== 1)
            return;
        const normalized = content.replace(/\s+/g, " ").trim();
        thread.title =
            normalized.length > 28 ? `${normalized.slice(0, 28)}…` : normalized || "新对话";
    }
}
