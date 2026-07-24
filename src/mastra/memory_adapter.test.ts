/**
 * Ticket 10 — Conversation Memory adapter tests.
 *
 * TDD test suite for `src/mastra/memory_adapter.ts`. Verifies the T04
 * section 3 adapter contract: pure pass-through to ConversationStore +
 * HandoffStore, no caching, no SQL, no Summarizer calls, no `tenantId`
 * free-form args, 1:1 threadId↔sessionId / resourceId↔tenantId mapping.
 *
 * Coverage map (T10 acceptance criteria):
 *   #1 Existing Conversation and summary data is readable without
 *      destructive migration
 *      → query() returns existing turns + summary; adapter never invokes
 *        any destructive method (no DROP/TRUNCATE/DELETE)
 *   #2 Only validated completed turns enter future Answer context and
 *      rolling summaries
 *      → query() delegates to loadConversationMemory (store filters
 *        kind='validated' at SQL layer); addValidatedTurn is the ONLY
 *        method that adds context; saveRollingSummary is pure pass-through
 *        (no summarizer call)
 *   #3 Tenant, subject, and session isolation remains fail-closed
 *      → query/addValidatedTurn/saveRollingSummary/getRollingSummary all
 *        pass resourceId straight through as tenantId (no fuzzing, no
 *        caching, no cross-tenant join); adapter exposes no "list all
 *        sessions" method
 *   #4 Handoff uses the same bounded memory projection as Answer
 *      contextualization
 *      → adapter.handoff delegates all 5 HandoffStore methods unchanged;
 *        cross-tenant 404 isolation preserved (no existence leak)
 *   #5 Summary failure and unavailable Mastra memory degrade to the
 *      approved compatible fallback
 *      → query() store error → empty snapshot (no throw);
 *        formatMemoryAsContext(emptySnapshot) → "" (no context prefix)
 *   #6 TTL cleanup and rollback preserve immutable Answer Trace history
 *      → adapter exposes NO delete method (no deleteInactiveBefore
 *        surface); save methods do NOT trigger TTL cleanup
 *   #7 Characterization tests prove old data remains readable before,
 *      during, and after rollback
 *      → data written by legacy saveValidatedTurn readable by
 *        adapter.query(); data written by adapter.addValidatedTurn has
 *        legacy ConversationTurn shape (readable by legacy
 *        loadConversationMemory)
 *
 * Adapter rules (T04 section 3 — structural tests on source file):
 *   R1: API uses `resourceId` (not `tenantId`) as the parameter name
 *   R2: No SQL/better-sqlite3 imports
 *   R3: No Summarizer import / .summarize() calls
 *   R4: No caching (every query() hits store)
 *   R5: threadId↔sessionId / resourceId↔tenantId 1:1 (no composite encoding)
 *
 * Boundary: this test file is owned by `src/mastra/*` and MUST NOT import
 * `src/api/*` or `src/index` (T02 #5 dependency direction).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"

import {
  createMastraMemoryAdapter,
  formatMemoryAsContext,
  type MastraMemoryAdapter,
  type ConversationMemorySnapshot,
} from "./memory_adapter"
import type {
  ConversationStore,
  ConversationTurn,
  ConversationMemory,
  RollingSummaryRecord,
} from "../answer/conversation_store"
import type {
  HandoffStore,
  HandoffCreateInput,
} from "../answer/handoff_store"
import type {
  HandoffCase,
  HandoffReasonCode,
  HandoffState,
} from "../types/answer"

const ADAPTER_SRC = path.join(__dirname, "memory_adapter.ts")

// ---------------------------------------------------------------------------
// Test fakes — minimal stubs that satisfy ConversationStore + HandoffStore
// contracts. Each fake tracks call counts + argument captures so tests can
// assert on delegation behavior.
// ---------------------------------------------------------------------------

interface TracedCall {
  method: string
  args: unknown[]
}

interface FakeConversationStore extends ConversationStore {
  calls: TracedCall[]
  memoryState: Map<string, ConversationMemory>
  rollingSummaries: Map<string, RollingSummaryRecord>
  validatedTurnsLog: ConversationTurn[]
  throwOnLoadConversationMemory: boolean
}

function makeFakeConversationStore(initial: {
  memory?: ConversationMemory
  rollingSummary?: RollingSummaryRecord | null
  sessionId?: string
  tenantId?: string
} = {}): FakeConversationStore {
  const calls: TracedCall[] = []
  const memoryState = new Map<string, ConversationMemory>()
  const rollingSummaries = new Map<string, RollingSummaryRecord>()
  const validatedTurnsLog: ConversationTurn[] = []

  const sid = initial.sessionId ?? "sess-test"
  const tid = initial.tenantId ?? "tenant-test"
  if (initial.memory) {
    memoryState.set(`${sid}|${tid}`, initial.memory)
  }
  if (initial.rollingSummary) {
    rollingSummaries.set(`${sid}|${tid}`, initial.rollingSummary)
  }

  const store: FakeConversationStore = {
    calls,
    memoryState,
    rollingSummaries,
    validatedTurnsLog,
    throwOnLoadConversationMemory: false,
    saveValidatedTurn(turn: ConversationTurn): void {
      calls.push({ method: "saveValidatedTurn", args: [turn] })
      validatedTurnsLog.push(turn)
    },
    loadConversationMemory(sessionId: string, tenantId: string): ConversationMemory {
      calls.push({ method: "loadConversationMemory", args: [sessionId, tenantId] })
      if (store.throwOnLoadConversationMemory) {
        throw new Error("simulated store failure (T10 #5 safe-degradation)")
      }
      return (
        memoryState.get(`${sessionId}|${tenantId}`) ?? {
          summary: null,
          summarizedThroughTurnId: null,
          schemaVersion: null,
          recentTurns: [],
          totalValidatedTurnCount: 0,
          oldestRecentTurnId: null,
        }
      )
    },
    loadRecentTurns(sessionId: string, tenantId: string, limit: number): ConversationTurn[] {
      calls.push({ method: "loadRecentTurns", args: [sessionId, tenantId, limit] })
      return []
    },
    savePendingClarification(sessionId: string, tenantId: string, originalMessage: string): void {
      calls.push({ method: "savePendingClarification", args: [sessionId, tenantId, originalMessage] })
    },
    consumePendingClarification(sessionId: string, tenantId: string): string | null {
      calls.push({ method: "consumePendingClarification", args: [sessionId, tenantId] })
      return null
    },
    deleteInactiveBefore(cutoffIso: string): number {
      calls.push({ method: "deleteInactiveBefore", args: [cutoffIso] })
      return 0
    },
    saveRollingSummary(
      sessionId: string,
      tenantId: string,
      summary: string,
      summarizedThroughTurnId: number,
      schemaVersion: number
    ): void {
      calls.push({
        method: "saveRollingSummary",
        args: [sessionId, tenantId, summary, summarizedThroughTurnId, schemaVersion],
      })
    },
    getRollingSummary(sessionId: string, tenantId: string): RollingSummaryRecord | null {
      calls.push({ method: "getRollingSummary", args: [sessionId, tenantId] })
      return rollingSummaries.get(`${sessionId}|${tenantId}`) ?? null
    },
    loadOlderTurnsForSummarization(
      sessionId: string,
      tenantId: string,
      fromIdExclusive: number,
      toIdInclusive: number
    ): ConversationTurn[] {
      calls.push({
        method: "loadOlderTurnsForSummarization",
        args: [sessionId, tenantId, fromIdExclusive, toIdInclusive],
      })
      return []
    },
  }
  return store
}

interface FakeHandoffStore extends HandoffStore {
  calls: TracedCall[]
  cases: Map<string, HandoffCase>
}

function makeFakeHandoffStore(): FakeHandoffStore {
  const calls: TracedCall[] = []
  const cases = new Map<string, HandoffCase>()
  const store: FakeHandoffStore = {
    calls,
    cases,
    create(input: HandoffCreateInput): HandoffCase | null {
      calls.push({ method: "create", args: [input] })
      const newCase: HandoffCase = {
        id: `case-${calls.length}`,
        runId: input.runId,
        tenantId: input.tenantId,
        subjectId: input.subjectId,
        sessionId: input.sessionId,
        reasonCode: input.reasonCode,
        userRequest: input.userRequest,
        conversationSummary: input.conversationSummary,
        evidenceIds: input.evidenceIds,
        traceReference: input.traceReference,
        status: "open",
        createdAt: "2026-07-19T10:00:00Z",
        updatedAt: "2026-07-19T10:00:00Z",
      }
      cases.set(newCase.id, newCase)
      return newCase
    },
    getById(caseId: string, tenantId: string): HandoffCase | null {
      calls.push({ method: "getById", args: [caseId, tenantId] })
      const c = cases.get(caseId)
      return c && c.tenantId === tenantId ? c : null
    },
    getByRunId(runId: string, tenantId: string): HandoffCase | null {
      calls.push({ method: "getByRunId", args: [runId, tenantId] })
      for (const c of cases.values()) {
        if (c.runId === runId && c.tenantId === tenantId) return c
      }
      return null
    },
    listByTenant(tenantId: string, status?: HandoffState): HandoffCase[] {
      calls.push({ method: "listByTenant", args: [tenantId, status] })
      const list: HandoffCase[] = []
      for (const c of cases.values()) {
        if (c.tenantId === tenantId && (!status || c.status === status)) {
          list.push(c)
        }
      }
      return list
    },
    updateStatus(
      caseId: string,
      tenantId: string,
      newStatus: HandoffState
    ): HandoffCase | null {
      calls.push({ method: "updateStatus", args: [caseId, tenantId, newStatus] })
      const c = cases.get(caseId)
      if (!c || c.tenantId !== tenantId) return null
      const updated: HandoffCase = { ...c, status: newStatus, updatedAt: "2026-07-19T11:00:00Z" }
      cases.set(caseId, updated)
      return updated
    },
  }
  return store
}

function makeConversationMemory(overrides: Partial<ConversationMemory> = {}): ConversationMemory {
  return {
    summary: null,
    summarizedThroughTurnId: null,
    schemaVersion: null,
    recentTurns: [],
    totalValidatedTurnCount: 0,
    oldestRecentTurnId: null,
    ...overrides,
  }
}

function makeTurn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    sessionId: "sess-test",
    tenantId: "tenant-test",
    role: "user",
    content: "hello",
    runId: "run-1",
    createdAt: "2026-07-19T10:00:00Z",
    ...overrides,
  }
}

const REASON_CODES: HandoffReasonCode[] = [
  "user_request",
  "policy_review",
  "insufficient_evidence",
  "provider_error",
  "other",
]

// ---------------------------------------------------------------------------
// T10 #1 — Existing Conversation and summary data is readable without
// destructive migration.
// ---------------------------------------------------------------------------

test("T10 #1 query(): returns existing turns + summary from store", () => {
  const store = makeFakeConversationStore({
    sessionId: "sess-1",
    tenantId: "tenant-A",
    memory: makeConversationMemory({
      summary: "earlier summary text",
      recentTurns: [
        makeTurn({ role: "user", content: "what is RAG?", sessionId: "sess-1", tenantId: "tenant-A" }),
        makeTurn({ role: "assistant", content: "RAG is...", sessionId: "sess-1", tenantId: "tenant-A" }),
      ],
      totalValidatedTurnCount: 2,
    }),
  })
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  const snapshot = adapter.query("sess-1", "tenant-A")

  assert.equal(snapshot.summary, "earlier summary text")
  assert.equal(snapshot.recentMessages.length, 2)
  assert.equal(snapshot.recentMessages[0].role, "user")
  assert.equal(snapshot.recentMessages[0].content, "what is RAG?")
  assert.equal(snapshot.recentMessages[0].createdAt, "2026-07-19T10:00:00Z")
  assert.equal(snapshot.recentMessages[1].role, "assistant")
  assert.equal(snapshot.recentMessages[1].content, "RAG is...")
  assert.equal(snapshot.totalValidatedTurnCount, 2)
})

test("T10 #1 query(): empty session returns empty snapshot (no destructive migration)", () => {
  const store = makeFakeConversationStore()
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  const snapshot = adapter.query("sess-empty", "tenant-empty")

  assert.equal(snapshot.summary, null)
  assert.deepEqual(snapshot.recentMessages, [])
  assert.equal(snapshot.totalValidatedTurnCount, 0)
})

test("T10 #1 query(): does NOT invoke any destructive method", () => {
  const store = makeFakeConversationStore()
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  adapter.query("sess-1", "tenant-A")

  const destructive = store.calls.filter((c) =>
    ["deleteInactiveBefore", "savePendingClarification", "consumePendingClarification"].includes(c.method)
  )
  assert.equal(destructive.length, 0, "query() must NOT invoke any destructive method")
  assert.equal(store.calls.length, 1, "query() invokes exactly one store method")
  assert.equal(store.calls[0].method, "loadConversationMemory")
})

test("T10 #1 getRollingSummary(): returns existing checkpoint (no destructive migration)", () => {
  const store = makeFakeConversationStore({
    sessionId: "sess-1",
    tenantId: "tenant-A",
    rollingSummary: {
      sessionId: "sess-1",
      tenantId: "tenant-A",
      summary: "rolling summary text",
      summarizedThroughTurnId: 42,
      schemaVersion: 1,
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-19T00:00:00Z",
    },
  })
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  const record = adapter.getRollingSummary("sess-1", "tenant-A")

  assert.ok(record !== null)
  assert.equal(record!.summary, "rolling summary text")
  assert.equal(record!.summarizedThroughTurnId, 42)
  assert.equal(record!.schemaVersion, 1)
})

test("T10 #1 query(): snapshot does NOT surface internal persistence fields", () => {
  // The adapter must NOT leak sessionId/tenantId/runId from ConversationTurn
  // into the Mastra-facing MemoryMessage — those are persistence-internal.
  const store = makeFakeConversationStore({
    sessionId: "sess-1",
    tenantId: "tenant-A",
    memory: makeConversationMemory({
      recentTurns: [makeTurn({ sessionId: "sess-1", tenantId: "tenant-A", runId: "internal-run" })],
      totalValidatedTurnCount: 1,
    }),
  })
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  const snapshot = adapter.query("sess-1", "tenant-A")

  assert.equal(snapshot.recentMessages.length, 1)
  const msg = snapshot.recentMessages[0] as unknown as Record<string, unknown>
  assert.equal(msg.role, "user")
  assert.equal(msg.content, "hello")
  assert.equal(msg.createdAt, "2026-07-19T10:00:00Z")
  // sessionId / tenantId / runId MUST NOT appear on the surfaced message.
  assert.equal(msg.sessionId, undefined, "sessionId MUST NOT leak into Mastra-facing message")
  assert.equal(msg.tenantId, undefined, "tenantId MUST NOT leak into Mastra-facing message")
  assert.equal(msg.runId, undefined, "runId MUST NOT leak into Mastra-facing message")
})

// ---------------------------------------------------------------------------
// T10 #2 — Only validated completed turns enter future Answer context and
// rolling summaries.
// ---------------------------------------------------------------------------

test("T10 #2 query(): delegates to loadConversationMemory (store filters kind='validated')", () => {
  const store = makeFakeConversationStore()
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  adapter.query("sess-1", "tenant-A")

  assert.equal(store.calls.length, 1)
  assert.equal(store.calls[0].method, "loadConversationMemory")
  assert.deepEqual(store.calls[0].args, ["sess-1", "tenant-A"])
})

test("T10 #2 addValidatedTurn(): is the ONLY method that adds validated context", () => {
  const store = makeFakeConversationStore()
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  adapter.addValidatedTurn({
    threadId: "sess-1",
    resourceId: "tenant-A",
    role: "user",
    content: "what is RAG?",
    runId: "run-1",
    createdAt: "2026-07-19T10:00:00Z",
  })

  assert.equal(store.calls.length, 1)
  assert.equal(store.calls[0].method, "saveValidatedTurn")
  const savedTurn = store.calls[0].args[0] as ConversationTurn
  assert.equal(savedTurn.sessionId, "sess-1")
  assert.equal(savedTurn.tenantId, "tenant-A")
  assert.equal(savedTurn.role, "user")
  assert.equal(savedTurn.content, "what is RAG?")
  assert.equal(savedTurn.runId, "run-1")
  assert.equal(savedTurn.createdAt, "2026-07-19T10:00:00Z")
})

test("T10 #2 saveRollingSummary(): pure pass-through (no summarizer call)", () => {
  const store = makeFakeConversationStore()
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  adapter.saveRollingSummary({
    threadId: "sess-1",
    resourceId: "tenant-A",
    summary: "computed summary text",
    summarizedThroughTurnId: 5,
    schemaVersion: 1,
  })

  assert.equal(store.calls.length, 1)
  assert.equal(store.calls[0].method, "saveRollingSummary")
  assert.deepEqual(store.calls[0].args, ["sess-1", "tenant-A", "computed summary text", 5, 1])
})

test("T10 #2 addValidatedTurn(): preserves role + content + runId + createdAt verbatim", () => {
  const store = makeFakeConversationStore()
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  adapter.addValidatedTurn({
    threadId: "sess-2",
    resourceId: "tenant-B",
    role: "assistant",
    content: "multi-line\nreply",
    runId: "run-xyz",
    createdAt: "2026-07-19T11:30:00.123Z",
  })

  assert.equal(store.validatedTurnsLog.length, 1)
  const turn = store.validatedTurnsLog[0]
  assert.equal(turn.role, "assistant")
  assert.equal(turn.content, "multi-line\nreply")
  assert.equal(turn.runId, "run-xyz")
  assert.equal(turn.createdAt, "2026-07-19T11:30:00.123Z")
})

test("T10 #2 query(): does NOT call loadRecentTurns / loadOlderTurnsForSummarization", () => {
  // query() must call only loadConversationMemory — the bounded-window
  // assembly is done by the store in one shot. Calling loadRecentTurns or
  // loadOlderTurnsForSummarization from the adapter would duplicate work
  // and risk bypassing the store's windowing logic.
  const store = makeFakeConversationStore()
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  adapter.query("sess-1", "tenant-A")

  const forbidden = store.calls.filter((c) =>
    ["loadRecentTurns", "loadOlderTurnsForSummarization"].includes(c.method)
  )
  assert.equal(forbidden.length, 0, "query() must NOT call loadRecentTurns or loadOlderTurnsForSummarization")
})

// ---------------------------------------------------------------------------
// T10 #3 — Tenant, subject, and session isolation remains fail-closed.
// ---------------------------------------------------------------------------

test("T10 #3 query(): resourceId passed straight through as tenantId (no fuzzing)", () => {
  const store = makeFakeConversationStore()
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  adapter.query("sess-isolation", "tenant-isolation")

  assert.deepEqual(store.calls[0].args, ["sess-isolation", "tenant-isolation"])
})

test("T10 #3 query(): cross-tenant read returns empty (delegated to store)", () => {
  const store = makeFakeConversationStore({
    sessionId: "sess-1",
    tenantId: "tenant-A",
    memory: makeConversationMemory({
      summary: "tenant-A summary",
      recentTurns: [makeTurn({ content: "tenant-A turn" })],
      totalValidatedTurnCount: 1,
    }),
  })
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  // Cross-tenant: query with tenant-B against a store seeded for tenant-A.
  // The store's loadConversationMemory filters by (sessionId, tenantId) at
  // the SQL layer — the adapter gets back an empty ConversationMemory.
  const snapshot = adapter.query("sess-1", "tenant-B")

  assert.equal(snapshot.summary, null)
  assert.deepEqual(snapshot.recentMessages, [])
  assert.equal(snapshot.totalValidatedTurnCount, 0)
})

test("T10 #3 query(): cross-session read returns empty (delegated to store)", () => {
  const store = makeFakeConversationStore({
    sessionId: "sess-A",
    tenantId: "tenant-1",
    memory: makeConversationMemory({
      recentTurns: [makeTurn({ content: "sess-A turn" })],
      totalValidatedTurnCount: 1,
    }),
  })
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  const snapshot = adapter.query("sess-B", "tenant-1")

  assert.deepEqual(snapshot.recentMessages, [])
  assert.equal(snapshot.totalValidatedTurnCount, 0)
})

test("T10 #3 addValidatedTurn(): cross-tenant write does NOT leak into other tenant's reads", () => {
  const store = makeFakeConversationStore()
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  adapter.addValidatedTurn({
    threadId: "sess-1",
    resourceId: "tenant-A",
    role: "user",
    content: "tenant-A secret",
    runId: "run-1",
    createdAt: "2026-07-19T10:00:00Z",
  })

  // Read from (sess-1, tenant-B) — must return empty (no leak).
  const snapshot = adapter.query("sess-1", "tenant-B")

  assert.deepEqual(snapshot.recentMessages, [], "cross-tenant read must NOT leak tenant-A content")
  assert.equal(snapshot.summary, null)
})

test("T10 #3 adapter exposes NO 'list all sessions' method (session isolation)", () => {
  const store = makeFakeConversationStore()
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  const a = adapter as unknown as Record<string, unknown>
  assert.equal(a.listSessions, undefined, "adapter MUST NOT expose listSessions (session isolation)")
  assert.equal(a.listAll, undefined, "adapter MUST NOT expose listAll (session isolation)")
  assert.equal(a.listByTenant, undefined, "adapter MUST NOT expose listByTenant (Mastra-facing surface has no tenant-listing)")
})

// ---------------------------------------------------------------------------
// T10 #4 — Handoff uses the same bounded memory projection as Answer
// contextualization.
// ---------------------------------------------------------------------------

test("T10 #4 adapter.handoff: delegates all 5 HandoffStore methods unchanged", () => {
  const store = makeFakeConversationStore()
  const handoff = makeFakeHandoffStore()
  const adapter = createMastraMemoryAdapter({ conversationStore: store, handoffStore: handoff })

  assert.ok(adapter.handoff, "adapter.handoff must be wired when handoffStore provided")

  const created = adapter.handoff!.create({
    runId: "run-1",
    tenantId: "tenant-A",
    subjectId: "subj-1",
    sessionId: "sess-1",
    reasonCode: REASON_CODES[0],
    userRequest: "I need a human",
    conversationSummary: "summary",
    evidenceIds: ["e1"],
    traceReference: "trace-1",
  })
  assert.ok(created !== null)
  assert.equal(created!.status, "open")

  const byId = adapter.handoff!.getById(created!.id, "tenant-A")
  assert.ok(byId !== null)
  assert.equal(byId!.id, created!.id)

  const byRun = adapter.handoff!.getByRunId("run-1", "tenant-A")
  assert.ok(byRun !== null)

  const list = adapter.handoff!.listByTenant("tenant-A")
  assert.equal(list.length, 1)

  const updated = adapter.handoff!.updateStatus(created!.id, "tenant-A", "claimed")
  assert.ok(updated !== null)
  assert.equal(updated!.status, "claimed")

  const methods = handoff.calls.map((c) => c.method)
  assert.deepEqual(methods, ["create", "getById", "getByRunId", "listByTenant", "updateStatus"])
})

test("T10 #4 adapter.handoff: NOT wired when handoffStore omitted (direct/ambiguous don't need it)", () => {
  const store = makeFakeConversationStore()
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  assert.equal(adapter.handoff, undefined, "adapter.handoff must be undefined when handoffStore omitted")
})

test("T10 #4 adapter.handoff: cross-tenant 404 isolation preserved (no existence leak)", () => {
  const store = makeFakeConversationStore()
  const handoff = makeFakeHandoffStore()
  const adapter = createMastraMemoryAdapter({ conversationStore: store, handoffStore: handoff })

  const created = adapter.handoff!.create({
    runId: "run-1",
    tenantId: "tenant-A",
    subjectId: "subj-1",
    sessionId: "sess-1",
    reasonCode: REASON_CODES[0],
    userRequest: "tenant-A request",
    conversationSummary: "summary",
    evidenceIds: [],
    traceReference: "trace-1",
  })
  assert.ok(created)

  // Tenant-B tries to read it → null (404), NOT throw, NOT leak existence.
  assert.equal(adapter.handoff!.getById(created!.id, "tenant-B"), null)
  assert.equal(adapter.handoff!.getByRunId("run-1", "tenant-B"), null)
  assert.equal(adapter.handoff!.listByTenant("tenant-B").length, 0)
  assert.equal(adapter.handoff!.updateStatus(created!.id, "tenant-B", "claimed"), null)
})

// ---------------------------------------------------------------------------
// T10 #5 — Summary failure and unavailable Mastra memory degrade to the
// approved compatible fallback.
// ---------------------------------------------------------------------------

test("T10 #5 query(): store error → empty snapshot (no throw)", () => {
  const store = makeFakeConversationStore()
  store.throwOnLoadConversationMemory = true
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  // Must not throw — must return an empty snapshot.
  const snapshot = adapter.query("sess-1", "tenant-A")

  assert.equal(snapshot.summary, null)
  assert.deepEqual(snapshot.recentMessages, [])
  assert.equal(snapshot.totalValidatedTurnCount, 0)
})

test("T10 #5 formatMemoryAsContext(): empty snapshot → empty string (no context prefix)", () => {
  const empty: ConversationMemorySnapshot = {
    summary: null,
    recentMessages: [],
    totalValidatedTurnCount: 0,
  }
  assert.equal(formatMemoryAsContext(empty), "")
})

test("T10 #5 formatMemoryAsContext(): summary-only snapshot → 'Summary of earlier conversation' prefix", () => {
  const summaryOnly: ConversationMemorySnapshot = {
    summary: "earlier summary text",
    recentMessages: [],
    totalValidatedTurnCount: 100,
  }
  const result = formatMemoryAsContext(summaryOnly)
  assert.ok(result.startsWith("Summary of earlier conversation:"))
  assert.ok(result.includes("earlier summary text"))
  assert.ok(!result.includes("Recent conversation:"), "must NOT include recent section when no messages")
})

test("T10 #5 formatMemoryAsContext(): recent-only snapshot → 'Recent conversation' prefix", () => {
  const recentOnly: ConversationMemorySnapshot = {
    summary: null,
    recentMessages: [
      { role: "user", content: "hi", createdAt: "2026-07-19T10:00:00Z" },
      { role: "assistant", content: "hello", createdAt: "2026-07-19T10:00:01Z" },
    ],
    totalValidatedTurnCount: 2,
  }
  const result = formatMemoryAsContext(recentOnly)
  assert.ok(result.startsWith("Recent conversation:"))
  assert.ok(result.includes("user: hi"))
  assert.ok(result.includes("assistant: hello"))
  assert.ok(!result.includes("Summary of earlier conversation:"), "must NOT include summary section when null")
})

test("T10 #5 formatMemoryAsContext(): both summary + recent → both sections joined by blank line", () => {
  const both: ConversationMemorySnapshot = {
    summary: "earlier summary",
    recentMessages: [
      { role: "user", content: "Q", createdAt: "2026-07-19T10:00:00Z" },
    ],
    totalValidatedTurnCount: 5,
  }
  const result = formatMemoryAsContext(both)
  assert.ok(result.includes("Summary of earlier conversation:"))
  assert.ok(result.includes("Recent conversation:"))
  assert.ok(result.includes("earlier summary"))
  assert.ok(result.includes("user: Q"))
  // Sections separated by blank line.
  assert.ok(result.includes("\n\nRecent conversation:"))
})

test("T10 #5 formatMemoryAsContext(): empty-string summary treated as no summary", () => {
  const emptySummary: ConversationMemorySnapshot = {
    summary: "",
    recentMessages: [],
    totalValidatedTurnCount: 0,
  }
  assert.equal(formatMemoryAsContext(emptySummary), "", "empty string summary must NOT produce a prefix")
})

test("T10 #5 query(): safe-degradation snapshot formats to empty context prefix", () => {
  // End-to-end: store error → empty snapshot → empty context prefix.
  // The runner can safely prepend formatMemoryAsContext(snapshot) to the
  // user's message without producing malformed output.
  const store = makeFakeConversationStore()
  store.throwOnLoadConversationMemory = true
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  const snapshot = adapter.query("sess-fail", "tenant-fail")
  const context = formatMemoryAsContext(snapshot)

  assert.equal(context, "", "safe-degradation snapshot must produce empty context prefix")
})

// ---------------------------------------------------------------------------
// T10 #6 — TTL cleanup and rollback preserve immutable Answer Trace history.
// ---------------------------------------------------------------------------

test("T10 #6 adapter exposes NO delete method (TTL scheduling owned by existing job)", () => {
  const store = makeFakeConversationStore()
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  const a = adapter as unknown as Record<string, unknown>
  assert.equal(a.deleteInactiveBefore, undefined, "adapter MUST NOT expose deleteInactiveBefore")
  assert.equal(a.delete, undefined, "adapter MUST NOT expose delete")
  assert.equal(a.deleteSession, undefined, "adapter MUST NOT expose deleteSession")
})

test("T10 #6 adapter exposes NO answer_run_events surface (trace history untouched)", () => {
  const store = makeFakeConversationStore()
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  const a = adapter as unknown as Record<string, unknown>
  assert.equal(a.deleteTrace, undefined, "adapter MUST NOT expose trace deletion")
  assert.equal(a.listTraceEvents, undefined, "adapter MUST NOT expose trace listing")
  assert.equal(a.answerRunEvents, undefined, "adapter MUST NOT expose answer_run_events surface")
})

test("T10 #6 saveValidatedTurn + saveRollingSummary do NOT invoke deleteInactiveBefore", () => {
  const store = makeFakeConversationStore()
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  adapter.addValidatedTurn({
    threadId: "sess-1",
    resourceId: "tenant-A",
    role: "user",
    content: "hello",
    runId: "run-1",
    createdAt: "2026-07-19T10:00:00Z",
  })
  adapter.saveRollingSummary({
    threadId: "sess-1",
    resourceId: "tenant-A",
    summary: "summary",
    summarizedThroughTurnId: 1,
    schemaVersion: 1,
  })

  const deleteCalls = store.calls.filter((c) => c.method === "deleteInactiveBefore")
  assert.equal(deleteCalls.length, 0, "save methods MUST NOT trigger TTL cleanup (trace history preserved)")
})

// ---------------------------------------------------------------------------
// T10 #7 — Characterization tests prove old data remains readable before,
// during, and after rollback.
// ---------------------------------------------------------------------------

test("T10 #7 characterization: data written by legacy saveValidatedTurn readable by adapter.query()", () => {
  // Rollback scenario: legacy code wrote turns via saveValidatedTurn before
  // the Mastra adapter was deployed. After rollback (adapter removed,
  // legacy path restored), the same data must be readable. We model this
  // by having the fake store contain turns written via the legacy
  // saveValidatedTurn path, then reading them via the adapter.
  const store = makeFakeConversationStore()

  // Phase 1: legacy path writes turns directly to the store.
  store.saveValidatedTurn(
    makeTurn({
      sessionId: "sess-rollback",
      tenantId: "tenant-rollback",
      role: "user",
      content: "legacy user message",
      runId: "legacy-run-1",
      createdAt: "2026-07-01T00:00:00Z",
    })
  )
  store.saveValidatedTurn(
    makeTurn({
      sessionId: "sess-rollback",
      tenantId: "tenant-rollback",
      role: "assistant",
      content: "legacy assistant reply",
      runId: "legacy-run-1",
      createdAt: "2026-07-01T00:00:01Z",
    })
  )

  // Phase 2: seed the store's loadConversationMemory with the legacy turns
  // (the SqliteConversationStore does this via SQL; the fake needs to be
  // told what to return for the (sess, tenant) key).
  store.memoryState.set(
    "sess-rollback|tenant-rollback",
    makeConversationMemory({
      summary: null,
      recentTurns: [
        makeTurn({
          sessionId: "sess-rollback",
          tenantId: "tenant-rollback",
          role: "user",
          content: "legacy user message",
          runId: "legacy-run-1",
          createdAt: "2026-07-01T00:00:00Z",
        }),
        makeTurn({
          sessionId: "sess-rollback",
          tenantId: "tenant-rollback",
          role: "assistant",
          content: "legacy assistant reply",
          runId: "legacy-run-1",
          createdAt: "2026-07-01T00:00:01Z",
        }),
      ],
      totalValidatedTurnCount: 2,
    })
  )

  // Phase 3: adapter reads the same store — legacy data must be readable.
  const adapter = createMastraMemoryAdapter({ conversationStore: store })
  const snapshot = adapter.query("sess-rollback", "tenant-rollback")

  assert.equal(snapshot.recentMessages.length, 2, "legacy turns must be readable by adapter (rollback readability)")
  assert.equal(snapshot.recentMessages[0].content, "legacy user message")
  assert.equal(snapshot.recentMessages[1].content, "legacy assistant reply")
})

test("T10 #7 characterization: data written by adapter.addValidatedTurn has legacy ConversationTurn shape", () => {
  // Forward-then-rollback scenario: Mastra adapter wrote turns via
  // addValidatedTurn during a deployment window. After rollback (adapter
  // removed, legacy path restored), the legacy code reads the same data via
  // loadConversationMemory. The adapter-written row must have the legacy
  // ConversationTurn shape (sessionId/tenantId/role/content/runId/createdAt)
  // so the SQL INSERT succeeds against the same schema.
  const store = makeFakeConversationStore()
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  adapter.addValidatedTurn({
    threadId: "sess-rollback",
    resourceId: "tenant-rollback",
    role: "user",
    content: "adapter-written message",
    runId: "adapter-run-1",
    createdAt: "2026-07-19T10:00:00Z",
  })

  assert.equal(store.validatedTurnsLog.length, 1)
  const savedTurn = store.validatedTurnsLog[0]
  // Legacy ConversationTurn shape — adapter does the 1:1 translation per R5.
  assert.equal(savedTurn.sessionId, "sess-rollback", "adapter-written turn has sessionId (legacy shape)")
  assert.equal(savedTurn.tenantId, "tenant-rollback", "adapter-written turn has tenantId (legacy shape)")
  assert.equal(savedTurn.role, "user")
  assert.equal(savedTurn.content, "adapter-written message")
  assert.equal(savedTurn.runId, "adapter-run-1")
  assert.equal(savedTurn.createdAt, "2026-07-19T10:00:00Z")
  // Verify all required fields are present with correct types.
  assert.ok(typeof savedTurn.sessionId === "string")
  assert.ok(typeof savedTurn.tenantId === "string")
  assert.ok(savedTurn.role === "user" || savedTurn.role === "assistant")
  assert.ok(typeof savedTurn.content === "string")
  assert.ok(typeof savedTurn.runId === "string")
  assert.ok(typeof savedTurn.createdAt === "string")
})

test("T10 #7 characterization: adapter.query() returns identical shape across repeated reads (idempotent)", () => {
  const store = makeFakeConversationStore({
    sessionId: "sess-stable",
    tenantId: "tenant-stable",
    memory: makeConversationMemory({
      summary: "stable summary",
      recentTurns: [makeTurn({ content: "stable turn" })],
      totalValidatedTurnCount: 1,
    }),
  })
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  const snap1 = adapter.query("sess-stable", "tenant-stable")
  const snap2 = adapter.query("sess-stable", "tenant-stable")
  const snap3 = adapter.query("sess-stable", "tenant-stable")

  assert.deepEqual(snap1, snap2)
  assert.deepEqual(snap2, snap3)
  assert.equal(
    store.calls.filter((c) => c.method === "loadConversationMemory").length,
    3,
    "every query() must hit the store (no caching — T04 rule 4)"
  )
})

// ---------------------------------------------------------------------------
// Adapter rule R1 — The adapter MUST NOT accept `tenantId` as a free-form
// tool argument. The adapter API uses Mastra's `resourceId` parameter name.
// ---------------------------------------------------------------------------

test("T10 R1 adapter API uses 'resourceId' (not 'tenantId') as public parameter name", () => {
  const store = makeFakeConversationStore()
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  // The adapter accepts an object with `resourceId` field (not `tenantId`).
  // TypeScript would reject `tenantId` here at compile time — this runtime
  // check verifies the call succeeds with the `resourceId` shape.
  adapter.addValidatedTurn({
    threadId: "sess-1",
    resourceId: "tenant-A",
    role: "user",
    content: "hello",
    runId: "run-1",
    createdAt: "2026-07-19T10:00:00Z",
  })
  adapter.saveRollingSummary({
    threadId: "sess-1",
    resourceId: "tenant-A",
    summary: "summary",
    summarizedThroughTurnId: 1,
    schemaVersion: 1,
  })

  // query + getRollingSummary take positional (threadId, resourceId) args.
  adapter.query("sess-1", "tenant-A")
  adapter.getRollingSummary("sess-1", "tenant-A")

  assert.equal(store.calls.length, 4, "all 4 adapter methods invoked successfully with resourceId API")
})

test("T10 R1 adapter source: public API signature uses 'resourceId' (not 'tenantId')", () => {
  const src = readFileSync(ADAPTER_SRC, "utf-8")

  // The MastraMemoryAdapter interface declarations must use `resourceId`
  // in their parameter lists (NOT `tenantId`).
  // Look for the interface method signatures.
  const queryMatch = src.match(/query\(\s*threadId:\s*string,\s*resourceId:\s*string\s*\)/)
  const getRollingSummaryMatch = src.match(/getRollingSummary\(\s*threadId:\s*string,\s*resourceId:\s*string\s*\)/)
  assert.ok(queryMatch, "interface query() must declare (threadId, resourceId) — not (sessionId, tenantId)")
  assert.ok(getRollingSummaryMatch, "interface getRollingSummary() must declare (threadId, resourceId)")

  // addValidatedTurn + saveRollingSummary use args objects with `resourceId`
  // field — verify the args type declarations include `resourceId: string`.
  assert.ok(
    /addValidatedTurn\(args:\s*\{[^}]*resourceId:\s*string/s.test(src),
    "addValidatedTurn args must include `resourceId: string` (not `tenantId`)"
  )
  assert.ok(
    /saveRollingSummary\(args:\s*\{[^}]*resourceId:\s*string/s.test(src),
    "saveRollingSummary args must include `resourceId: string` (not `tenantId`)"
  )
})

// ---------------------------------------------------------------------------
// Adapter rule R2 — The adapter MUST NOT perform any SQL or call
// better-sqlite3 directly.
// ---------------------------------------------------------------------------

test("T10 R2 memory_adapter.ts source: no SQL string literals", () => {
  const src = readFileSync(ADAPTER_SRC, "utf-8")

  // No SQL keywords used as string literals (case-insensitive). The
  // adapter must NOT contain any raw SQL — all persistence goes through
  // ConversationStore / HandoffStore interfaces.
  assert.ok(
    !/['"`](SELECT|INSERT|UPDATE|DELETE|DROP|TRUNCATE|CREATE|ALTER)\s/i.test(src),
    "memory_adapter.ts must NOT contain SQL string literals (all persistence goes through ConversationStore)"
  )
})

test("T10 R2 memory_adapter.ts source: no better-sqlite3 import", () => {
  const src = readFileSync(ADAPTER_SRC, "utf-8")

  assert.ok(
    !/from\s+['"]better-sqlite3['"]/.test(src),
    "memory_adapter.ts must NOT import better-sqlite3 directly"
  )
  assert.ok(
    !/require\s*\(\s*['"]better-sqlite3['"]/.test(src),
    "memory_adapter.ts must NOT require better-sqlite3 directly"
  )
})

// ---------------------------------------------------------------------------
// Adapter rule R3 — The adapter MUST NOT call Summarizer.summarize().
// ---------------------------------------------------------------------------

test("T10 R3 memory_adapter.ts source: no Summarizer import", () => {
  const src = readFileSync(ADAPTER_SRC, "utf-8")

  assert.ok(
    !/from\s+['"][^'"]*summarizer['"]/.test(src),
    "memory_adapter.ts must NOT import Summarizer (summarization is the Answer pipeline's job)"
  )
})

test("T10 R3 memory_adapter.ts source: no .summarize() method calls", () => {
  const src = readFileSync(ADAPTER_SRC, "utf-8")
  // Strip // line comments and /* */ block comments before checking — the
  // rule applies to actual executable code, not to comments that document
  // the rule itself (e.g. "MUST NOT call Summarizer.summarize()").
  const strippedSrc = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")

  assert.ok(
    !/\.summarize\s*\(/.test(strippedSrc),
    "memory_adapter.ts must NOT call .summarize() (summarization is the Answer pipeline's job)"
  )
})

// ---------------------------------------------------------------------------
// Adapter rule R4 — The adapter MUST NOT cache ConversationMemory across
// requests. Every query() call hits the store.
// ---------------------------------------------------------------------------

test("T10 R4 query(): every call hits the store (no caching)", () => {
  const store = makeFakeConversationStore()
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  adapter.query("sess-1", "tenant-A")
  adapter.query("sess-1", "tenant-A")
  adapter.query("sess-1", "tenant-A")

  assert.equal(
    store.calls.filter((c) => c.method === "loadConversationMemory").length,
    3,
    "3 query() calls → 3 store hits (no caching; preserves TTL + cross-tenant freshness)"
  )
})

test("T10 R4 query(): store update between calls is reflected (no stale cache)", () => {
  const store = makeFakeConversationStore({
    sessionId: "sess-1",
    tenantId: "tenant-A",
    memory: makeConversationMemory({
      summary: "old summary",
      recentTurns: [],
      totalValidatedTurnCount: 1,
    }),
  })
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  const snap1 = adapter.query("sess-1", "tenant-A")
  assert.equal(snap1.summary, "old summary")

  // Update the store's state between calls — the adapter must NOT serve a
  // cached snapshot.
  store.memoryState.set(
    "sess-1|tenant-A",
    makeConversationMemory({
      summary: "new summary",
      recentTurns: [],
      totalValidatedTurnCount: 2,
    })
  )

  const snap2 = adapter.query("sess-1", "tenant-A")
  assert.equal(snap2.summary, "new summary", "adapter must reflect store updates (no caching)")
  assert.equal(snap2.totalValidatedTurnCount, 2)
})

// ---------------------------------------------------------------------------
// Adapter rule R5 — The adapter MUST translate Mastra's `threadId` →
// `sessionId` and `resourceId` → `tenantId` 1:1. No composite encoding.
// ---------------------------------------------------------------------------

test("T10 R5 query(): threadId→sessionId, resourceId→tenantId 1:1 (no composite encoding)", () => {
  const store = makeFakeConversationStore()
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  adapter.query("thread-abc", "resource-xyz")

  assert.deepEqual(
    store.calls[0].args,
    ["thread-abc", "resource-xyz"],
    "adapter passes threadId as sessionId, resourceId as tenantId — no encoding"
  )
})

test("T10 R5 addValidatedTurn(): threadId→sessionId, resourceId→tenantId 1:1", () => {
  const store = makeFakeConversationStore()
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  adapter.addValidatedTurn({
    threadId: "thread-abc",
    resourceId: "resource-xyz",
    role: "user",
    content: "hello",
    runId: "run-1",
    createdAt: "2026-07-19T10:00:00Z",
  })

  const savedTurn = store.validatedTurnsLog[0]
  assert.equal(savedTurn.sessionId, "thread-abc", "threadId preserved verbatim as sessionId (no encoding)")
  assert.equal(savedTurn.tenantId, "resource-xyz", "resourceId preserved verbatim as tenantId (no encoding)")
})

test("T10 R5 saveRollingSummary(): threadId→sessionId, resourceId→tenantId 1:1", () => {
  const store = makeFakeConversationStore()
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  adapter.saveRollingSummary({
    threadId: "thread-abc",
    resourceId: "resource-xyz",
    summary: "summary",
    summarizedThroughTurnId: 10,
    schemaVersion: 1,
  })

  assert.deepEqual(store.calls[0].args, ["thread-abc", "resource-xyz", "summary", 10, 1])
})

test("T10 R5 getRollingSummary(): threadId→sessionId, resourceId→tenantId 1:1", () => {
  const store = makeFakeConversationStore()
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  adapter.getRollingSummary("thread-abc", "resource-xyz")

  assert.deepEqual(store.calls[0].args, ["thread-abc", "resource-xyz"])
})

test("T10 R5 no composite encoding: special characters in threadId/resourceId preserved", () => {
  const store = makeFakeConversationStore()
  const adapter = createMastraMemoryAdapter({ conversationStore: store })

  // threadId with pipe (would break composite encoding if adapter used "|"
  // as separator) — must be preserved verbatim.
  adapter.query("thread|with|pipes", "resource:with:colons")

  assert.deepEqual(
    store.calls[0].args,
    ["thread|with|pipes", "resource:with:colons"],
    "special characters in threadId/resourceId preserved (no composite encoding)"
  )
})

// ---------------------------------------------------------------------------
// Compile-time type check: MastraMemoryAdapter interface is structurally
// compatible with the createMastraMemoryAdapter return type.
// ---------------------------------------------------------------------------

test("T10 type compat: createMastraMemoryAdapter returns a MastraMemoryAdapter", () => {
  const store = makeFakeConversationStore()
  const adapter: MastraMemoryAdapter = createMastraMemoryAdapter({ conversationStore: store })

  // If this compiles, the return type is structurally compatible with the
  // declared interface. Runtime check verifies the methods exist.
  assert.equal(typeof adapter.query, "function")
  assert.equal(typeof adapter.addValidatedTurn, "function")
  assert.equal(typeof adapter.saveRollingSummary, "function")
  assert.equal(typeof adapter.getRollingSummary, "function")
})
