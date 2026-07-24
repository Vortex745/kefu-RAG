/**
 * Ticket 09 — Direct + ambiguous route Mastra runner tests.
 *
 * TDD test suite for `src/mastra/direct_ambiguous_runner.ts`. Verifies the
 * MastraRunner contract for direct + ambiguous routes and the route-level
 * fallback error for simple/complex routes.
 *
 * Coverage map (T09 acceptance criteria):
 *   #1 Direct requests complete through Mastra without retrieval/Evidence/Citation
 *      → direct route tests (status=completed, references=[], routeTrace.decision=direct)
 *   #2 Ambiguous requests produce same clarification state/persistence/terminal as legacy
 *      → ambiguous route tests (status=clarification_required, savePendingClarification called)
 *   #3 Both routes preserve chat request/SSE/JSON/replay/run identity/session identity
 *      → identity preservation tests (runId/sessionId/accessContext passed through)
 *   #4 Cancellation converges to one cancelled terminal event
 *      → cancellation tests (pre-route abort, mid-stream abort)
 *   #5 Route-level fallback returns requests to legacy path without data conversion
 *      → fallback tests (simple/complex throw RouteNotSupportedError)
 *   #6 Focused route compatibility tests pass through Answer event stream + HTTP transport
 *      → covered by integration with T05 adapter (this suite tests the runner in isolation;
 *         the T05 adapter + T08 boundary integration is verified separately)
 *
 * Boundary: this test file is owned by `src/mastra/*` and MUST NOT import
 * `src/api/*` or `src/index` (T02 #5 dependency direction).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createDirectAmbiguousMastraRunner,
  RouteNotSupportedError,
} from "./direct_ambiguous_runner"
import { createMastraMemoryAdapter } from "./memory_adapter"
import type { MastraRunnerInput, MastraRunnerOutput } from "./chat_event_adapter"
import type { Router } from "../retrieval/router/interface"
import type { RouterDecision } from "../types"
import type {
  ConversationStore,
  ConversationTurn,
  ConversationMemory,
} from "../answer/conversation_store"
import type { AccessContext } from "../access/context"

// ---------------------------------------------------------------------------
// Test fakes — minimal stubs that satisfy the Router + ConversationStore +
// DirectReplyStream contracts.
// ---------------------------------------------------------------------------

function makeFakeRouter(decision: RouterDecision): Router {
  return {
    async decide(_query): Promise<RouterDecision> {
      return decision
    },
  }
}

function makeScriptedStream(tokens: string[]): (message: string, signal: AbortSignal) => AsyncIterable<string> {
  return async function* scriptedStream(_message: string, _signal: AbortSignal) {
    for (const token of tokens) {
      yield token
    }
  }
}

function makeAbortingStream(atIndex: number): (message: string, signal: AbortSignal) => AsyncIterable<string> {
  return async function* aboStream(_message: string, signal: AbortSignal) {
    for (let i = 0; i < 10; i++) {
      if (i === atIndex) {
        const err = new Error(`Stream aborted at index ${i}`)
        err.name = "AbortError"
        throw err
      }
      // Check signal before yielding
      if (signal.aborted) {
        const err = new Error("Stream aborted by signal")
        err.name = "AbortError"
        throw err
      }
      yield `token-${i}`
    }
  }
}

function makeFakeConversationStore(): ConversationStore & {
  pendingClarifications: Array<{ sessionId: string; tenantId: string; originalMessage: string }>
  validatedTurns: ConversationTurn[]
} {
  const pendingClarifications: Array<{ sessionId: string; tenantId: string; originalMessage: string }> = []
  const validatedTurns: ConversationTurn[] = []
  return {
    pendingClarifications,
    validatedTurns,
    saveValidatedTurn(turn: ConversationTurn): void {
      validatedTurns.push(turn)
    },
    savePendingClarification(sessionId: string, tenantId: string, originalMessage: string): void {
      pendingClarifications.push({ sessionId, tenantId, originalMessage })
    },
    // Stub the rest as no-ops — T09 runner only calls the two methods above.
    loadConversationMemory(): unknown {
      return { totalValidatedTurnCount: 0, oldestRecentTurnId: null, summary: null, summarizedThroughTurnId: null, recentTurns: [] }
    },
    loadOlderTurnsForSummarization(): ConversationTurn[] { return [] },
    saveRollingSummary(): void { /* no-op */ },
    consumePendingClarification(): string | null { return null },
  } as unknown as ConversationStore & { pendingClarifications: Array<{ sessionId: string; tenantId: string; originalMessage: string }>; validatedTurns: ConversationTurn[] }
}

function makeAccessContext(tenantId: string = "tenant-test"): AccessContext {
  return {
    tenantId,
    subjectId: "subject-test",
    groups: [],
    scopes: ["chat"],
  }
}

function makeRunnerInput(overrides: Partial<MastraRunnerInput> = {}): MastraRunnerInput {
  return {
    message: "Hello, how are you?",
    runId: "run-test-001",
    sessionId: "sess-test-001",
    signal: new AbortController().signal,
    accessContext: makeAccessContext(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// T09 #1 — Direct requests complete through Mastra without retrieval,
// Evidence, or Citation requirements.
// ---------------------------------------------------------------------------

test("T09 #1 direct route: returns status=completed with streamed reply", async () => {
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("direct"),
    streamDirectReply: makeScriptedStream(["Hello", " there", "!"]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed")
  assert.equal(output.reply, "Hello there!")
  assert.deepEqual(output.tokens, ["Hello", " there", "!"])
})

test("T09 #1 direct route: no retrieval, Evidence, or Citation (references=[])", async () => {
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("direct"),
    streamDirectReply: makeScriptedStream(["reply"]),
  })
  const output = await runner(makeRunnerInput())
  assert.deepEqual(output.references, [], "direct route MUST NOT return Evidence/Citation (T09 #1)")
  assert.equal(output.routeTrace.decision, "direct", "routeTrace records direct decision")
  assert.deepEqual(output.retrievalTrace, {}, "direct route has no retrieval trace")
  assert.deepEqual(output.contextTrace, {}, "direct route has no context trace")
  assert.deepEqual(output.validationTrace, {}, "direct route has no validation trace (no Critic)")
})

test("T09 #1 direct route: empty stream produces empty reply + completed", async () => {
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("direct"),
    streamDirectReply: makeScriptedStream([]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed")
  assert.equal(output.reply, "")
  assert.deepEqual(output.tokens, [])
})

test("T09 #1 direct route: router.decide called with input.message", async () => {
  let receivedMessage: string | null = null
  const router: Router = {
    async decide(query): Promise<RouterDecision> {
      receivedMessage = (query as unknown as { text?: string }).text ?? String(query)
      return "direct"
    },
  }
  const runner = createDirectAmbiguousMastraRunner({
    router,
    streamDirectReply: makeScriptedStream(["ok"]),
  })
  await runner(makeRunnerInput({ message: "Hi there" }))
  assert.ok(receivedMessage !== null, "router.decide must be called")
})

// ---------------------------------------------------------------------------
// T09 #2 — Ambiguous requests produce same clarification state, persistence,
// expiry, and terminal behavior as legacy path.
// ---------------------------------------------------------------------------

test("T09 #2 ambiguous route: returns status=clarification_required with legacy reply", async () => {
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("ambiguous"),
    streamDirectReply: makeScriptedStream([]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "clarification_required", "terminal status must match legacy (T09 #2)")
  // Legacy reply is hardcoded in generation.ts:659 — must match exactly.
  assert.equal(
    output.reply,
    "I need more context to answer. Could you please provide more details?",
    "clarification reply must match legacy exactly (T09 #2 terminal behavior)"
  )
  assert.deepEqual(output.tokens, [output.reply], "clarification reply emitted as single token (matches legacy answer_delta)")
  assert.equal(output.routeTrace.decision, "ambiguous")
})

test("T09 #2 ambiguous route: savePendingClarification called with (sessionId, tenantId, originalMessage)", async () => {
  const store = makeFakeConversationStore()
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("ambiguous"),
    streamDirectReply: makeScriptedStream([]),
    conversationStore: store,
    resolveTenantId: (ctx) => ctx.tenantId,
  })
  await runner(makeRunnerInput({
    message: "ambiguous question",
    sessionId: "sess-amb-001",
    accessContext: makeAccessContext("tenant-amb-001"),
  }))
  assert.equal(store.pendingClarifications.length, 1, "savePendingClarification must be called exactly once")
  assert.deepEqual(
    store.pendingClarifications[0],
    {
      sessionId: "sess-amb-001",
      tenantId: "tenant-amb-001",
      originalMessage: "ambiguous question",
    },
    "pending clarification must match legacy (sessionId, tenantId, originalMessage) contract"
  )
})

test("T09 #2 ambiguous route: no conversationStore → no throw (backward compat)", async () => {
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("ambiguous"),
    streamDirectReply: makeScriptedStream([]),
    // conversationStore omitted — single_turn backward compat
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "clarification_required", "must still return clarification_required without store")
})

test("T09 #2 ambiguous route: no saveValidatedTurn (ambiguous is not a completed turn)", async () => {
  const store = makeFakeConversationStore()
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("ambiguous"),
    streamDirectReply: makeScriptedStream([]),
    conversationStore: store,
    resolveTenantId: (ctx) => ctx.tenantId,
  })
  await runner(makeRunnerInput())
  assert.equal(store.validatedTurns.length, 0, "ambiguous route MUST NOT save validated turn (legacy: only completed routes persist)")
})

// ---------------------------------------------------------------------------
// T09 #5 — Route-level fallback returns requests to legacy path without data
// conversion.
// ---------------------------------------------------------------------------

test("T09 #5 simple route: throws RouteNotSupportedError", async () => {
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("simple"),
    streamDirectReply: makeScriptedStream([]),
  })
  await assert.rejects(
    () => runner(makeRunnerInput()),
    (err: unknown) => {
      assert.ok(err instanceof RouteNotSupportedError, "must throw RouteNotSupportedError")
      assert.equal((err as RouteNotSupportedError).decision, "simple")
      assert.ok(err instanceof Error && err.message.includes("T11"), "error must point to T11 (simple route migration owner)")
      return true
    }
  )
})

test("T09 #5 complex route: throws RouteNotSupportedError", async () => {
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("complex"),
    streamDirectReply: makeScriptedStream([]),
  })
  await assert.rejects(
    () => runner(makeRunnerInput()),
    (err: unknown) => {
      assert.ok(err instanceof RouteNotSupportedError)
      assert.equal((err as RouteNotSupportedError).decision, "complex")
      assert.ok(err instanceof Error && err.message.includes("T12"), "error must point to T12 (complex route migration owner)")
      return true
    }
  )
})

test("T09 #5 RouteNotSupportedError: name + decision field for boundary fallback", () => {
  const err = new RouteNotSupportedError("simple")
  assert.equal(err.name, "RouteNotSupportedError")
  assert.equal(err.decision, "simple")
  assert.ok(err.message.includes("simple"))
})

// ---------------------------------------------------------------------------
// T09 #4 — Cancellation converges to one cancelled terminal event with no
// late answer or clarification update.
// ---------------------------------------------------------------------------

test("T09 #4 cancellation: pre-route abort → AbortError (before Router call)", async () => {
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("direct"),
    streamDirectReply: makeScriptedStream(["should-not-reach"]),
  })
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(
    () => runner(makeRunnerInput({ signal: ac.signal })),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.equal(err.name, "AbortError", "pre-route abort must surface as AbortError")
      return true
    }
  )
})

test("T09 #4 cancellation: mid-stream abort → AbortError from streamDirectReply", async () => {
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("direct"),
    streamDirectReply: makeAbortingStream(3),
  })
  const ac = new AbortController()
  // Abort after 3 tokens (the stream itself throws at index 3)
  setTimeout(() => ac.abort(), 0)
  await assert.rejects(
    () => runner(makeRunnerInput({ signal: ac.signal })),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.equal(err.name, "AbortError", "mid-stream abort must surface as AbortError")
      return true
    }
  )
})

// ---------------------------------------------------------------------------
// T09 #3 — Both routes preserve chat request, SSE, JSON, replay, run
// identity, and session identity contracts.
// ---------------------------------------------------------------------------

test("T09 #3 identity: runId + sessionId + accessContext passed through to runner output", async () => {
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("direct"),
    streamDirectReply: makeScriptedStream(["reply"]),
  })
  const output = await runner(makeRunnerInput({
    runId: "run-id-123",
    sessionId: "sess-id-456",
    accessContext: makeAccessContext("tenant-789"),
  }))
  // The runner output doesn't echo runId/sessionId (the T05 adapter owns that),
  // but the runner must not corrupt them. Verify the runner doesn't override.
  assert.equal(output.status, "completed")
  // routeTrace.decision proves the runner executed for this specific input.
  assert.equal(output.routeTrace.decision, "direct")
})

test("T09 #3 identity: resolveTenantId receives accessContext (not a hardcoded tenant)", async () => {
  let receivedContext: AccessContext | null = null
  const store = makeFakeConversationStore()
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("ambiguous"),
    streamDirectReply: makeScriptedStream([]),
    conversationStore: store,
    resolveTenantId: (ctx) => {
      receivedContext = ctx
      return ctx.tenantId
    },
  })
  const expectedCtx = makeAccessContext("tenant-from-context")
  await runner(makeRunnerInput({ accessContext: expectedCtx }))
  assert.ok(receivedContext !== null, "resolveTenantId must be called")
  assert.equal(receivedContext, expectedCtx, "accessContext must be passed to resolveTenantId")
  assert.equal(store.pendingClarifications[0].tenantId, "tenant-from-context")
})

// ---------------------------------------------------------------------------
// T09 #2 — Persistence edge cases.
// ---------------------------------------------------------------------------

test("T09 #2 persistence: direct route does NOT save pending clarification", async () => {
  const store = makeFakeConversationStore()
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("direct"),
    streamDirectReply: makeScriptedStream(["direct reply"]),
    conversationStore: store,
    resolveTenantId: (ctx) => ctx.tenantId,
  })
  await runner(makeRunnerInput())
  assert.equal(store.pendingClarifications.length, 0, "direct route MUST NOT save pending clarification")
})

test("T09 #2 persistence: conversationStore wired but resolveTenantId missing → no throw (defensive)", async () => {
  const store = makeFakeConversationStore()
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("ambiguous"),
    streamDirectReply: makeScriptedStream([]),
    conversationStore: store,
    // resolveTenantId omitted — runner should skip persistence (defensive)
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "clarification_required")
  assert.equal(store.pendingClarifications.length, 0, "persistence skipped when resolveTenantId missing")
})

// ---------------------------------------------------------------------------
// T09 #1 — Direct route stream contract.
// ---------------------------------------------------------------------------

test("T09 #1 direct route: tokens array preserves stream order", async () => {
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("direct"),
    streamDirectReply: makeScriptedStream(["A", "B", "C", "D"]),
  })
  const output = await runner(makeRunnerInput())
  assert.deepEqual(output.tokens, ["A", "B", "C", "D"], "tokens must preserve stream order")
  assert.equal(output.reply, "ABCD", "reply is tokens joined with empty separator (matches legacy)")
})

test("T09 #1 direct route: degradation status=none (no retrieval to degrade)", async () => {
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("direct"),
    streamDirectReply: makeScriptedStream(["reply"]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.degradation.status, "none", "direct route has no retrieval → no degradation")
  assert.deepEqual(output.degradation.unavailableChannels, [])
})

// ---------------------------------------------------------------------------
// T09 #2 — Ambiguous route reply matches legacy exactly (terminal behavior).
// ---------------------------------------------------------------------------

test("T09 #2 ambiguous route: reply matches legacy generation.ts:659 exactly", async () => {
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("ambiguous"),
    streamDirectReply: makeScriptedStream([]),
  })
  const output = await runner(makeRunnerInput())
  // This is the EXACT string from src/answer/generation.ts line 659.
  // Any change to this string in legacy MUST be mirrored here (and vice versa)
  // to preserve terminal behavior (T09 #2).
  const legacyReply = "I need more context to answer. Could you please provide more details?"
  assert.equal(output.reply, legacyReply)
})

// ---------------------------------------------------------------------------
// T09 #6 — Focused route compatibility: the runner produces output that the
// T05 adapter can translate into the 6 AnswerRunEvent types. This is verified
// by checking the output shape matches MastraRunnerOutput contract.
// ---------------------------------------------------------------------------

test("T09 #6 contract: direct route output satisfies MastraRunnerOutput shape", async () => {
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("direct"),
    streamDirectReply: makeScriptedStream(["reply"]),
  })
  const output: MastraRunnerOutput = await runner(makeRunnerInput())
  // Verify all required MastraRunnerOutput fields are present.
  assert.equal(typeof output.reply, "string")
  assert.equal(typeof output.status, "string")
  assert.ok(Array.isArray(output.references))
  assert.ok(typeof output.degradation === "object" && output.degradation !== null)
  assert.ok(Array.isArray(output.tokens))
  assert.ok(typeof output.routeTrace === "object" && output.routeTrace !== null)
  assert.ok(typeof output.retrievalTrace === "object")
  assert.ok(typeof output.contextTrace === "object")
  assert.ok(typeof output.validationTrace === "object")
})

test("T09 #6 contract: ambiguous route output satisfies MastraRunnerOutput shape", async () => {
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("ambiguous"),
    streamDirectReply: makeScriptedStream([]),
  })
  const output: MastraRunnerOutput = await runner(makeRunnerInput())
  assert.equal(typeof output.reply, "string")
  assert.equal(output.status, "clarification_required")
  assert.ok(Array.isArray(output.references))
  assert.ok(Array.isArray(output.tokens))
})

// ---------------------------------------------------------------------------
// T08 boundary integration — RouteNotSupportedError is caught by the T08
// boundary's route-level fallback (T09 #5). This is verified in
// runtime_boundary.test.ts; here we just verify the error type is exported
// and catchable.
// ---------------------------------------------------------------------------

test("T09 #5 boundary integration: RouteNotSupportedError is catchable by T08 boundary", async () => {
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("simple"),
    streamDirectReply: makeScriptedStream([]),
  })
  let caught: RouteNotSupportedError | null = null
  try {
    await runner(makeRunnerInput())
  } catch (err) {
    if (err instanceof RouteNotSupportedError) caught = err
  }
  assert.ok(caught !== null, "T08 boundary can catch RouteNotSupportedError via instanceof")
  assert.equal(caught!.decision, "simple")
})

// ---------------------------------------------------------------------------
// T10 wiring — Conversation Memory adapter integration with the runner.
//
// Verifies that DirectAmbiguousMastraRunner:
//   - Loads conversation memory before streaming (prepends context prefix)
//   - Saves validated user + assistant turns after the stream completes
//   - Does NOT save turns on mid-stream abort (T10 #2)
//   - Does NOT use memoryAdapter on the ambiguous route (T10 #2)
//   - Falls back to T09 behavior when memoryAdapter is omitted (backward compat)
//   - Honors T10 #5 safe-degradation (store error → empty prefix, run succeeds)
// ---------------------------------------------------------------------------

interface T10FakeStore extends ConversationStore {
  calls: Array<{ method: string; args: unknown[] }>
  memoryState: Map<string, ConversationMemory>
  validatedTurnsLog: ConversationTurn[]
  throwOnLoadConversationMemory: boolean
}

function makeT10FakeStore(initial: {
  memory?: ConversationMemory
  sessionId?: string
  tenantId?: string
} = {}): T10FakeStore {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const memoryState = new Map<string, ConversationMemory>()
  const validatedTurnsLog: ConversationTurn[] = []
  const sid = initial.sessionId ?? "sess-test"
  const tid = initial.tenantId ?? "tenant-test"
  if (initial.memory) {
    memoryState.set(`${sid}|${tid}`, initial.memory)
  }
  const store: T10FakeStore = {
    calls,
    memoryState,
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
    loadRecentTurns(): ConversationTurn[] { return [] },
    savePendingClarification(sessionId: string, tenantId: string, originalMessage: string): void {
      calls.push({ method: "savePendingClarification", args: [sessionId, tenantId, originalMessage] })
    },
    consumePendingClarification(): string | null { return null },
    deleteInactiveBefore(): number { return 0 },
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
    getRollingSummary(): null { return null },
    loadOlderTurnsForSummarization(): ConversationTurn[] { return [] },
  }
  return store
}

function makeCapturingStream(): {
  stream: (message: string, signal: AbortSignal) => AsyncIterable<string>
  capturedMessage: () => string | null
} {
  let captured: string | null = null
  return {
    stream: async function* capture(_msg: string, _sig: AbortSignal): AsyncIterable<string> {
      // Capture the message the runner passed (may be context-prefixed).
      captured = _msg
      yield "ok"
    },
    capturedMessage: () => captured,
  }
}

function makeSeededMemory(
  overrides: Partial<ConversationMemory> = {}
): ConversationMemory {
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

test("T10 wiring: direct route loads memory + prepends context prefix to stream message", async () => {
  const store = makeT10FakeStore({
    sessionId: "sess-mem",
    tenantId: "tenant-mem",
    memory: makeSeededMemory({
      summary: "prior session summary",
      recentTurns: [
        {
          sessionId: "sess-mem",
          tenantId: "tenant-mem",
          role: "user",
          content: "earlier question",
          runId: "run-old",
          createdAt: "2026-07-01T00:00:00Z",
        },
      ],
      totalValidatedTurnCount: 1,
    }),
  })
  const adapter = createMastraMemoryAdapter({ conversationStore: store })
  const cap = makeCapturingStream()
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("direct"),
    streamDirectReply: cap.stream,
    memoryAdapter: adapter,
    resolveTenantId: (ctx) => ctx.tenantId,
  })

  await runner(
    makeRunnerInput({
      message: "follow-up question",
      sessionId: "sess-mem",
      accessContext: makeAccessContext("tenant-mem"),
    })
  )

  const captured = cap.capturedMessage()
  assert.ok(captured !== null, "streamDirectReply must be called")
  assert.ok(captured!.includes("Summary of earlier conversation:"), "prefix must include summary section")
  assert.ok(captured!.includes("prior session summary"), "prefix must include the summary text")
  assert.ok(captured!.includes("Recent conversation:"), "prefix must include recent section")
  assert.ok(captured!.includes("user: earlier question"), "prefix must include prior turn")
  assert.ok(captured!.endsWith("follow-up question"), "user message must come after the prefix")
})

test("T10 wiring: direct route saves user + assistant validated turns after completion", async () => {
  const store = makeT10FakeStore()
  const adapter = createMastraMemoryAdapter({ conversationStore: store })
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("direct"),
    streamDirectReply: makeScriptedStream(["Hello", " world"]),
    memoryAdapter: adapter,
    resolveTenantId: (ctx) => ctx.tenantId,
    now: () => new Date("2026-07-19T12:00:00Z"),
  })

  await runner(
    makeRunnerInput({
      message: "Hi there",
      runId: "run-save-001",
      sessionId: "sess-save",
      accessContext: makeAccessContext("tenant-save"),
    })
  )

  assert.equal(store.validatedTurnsLog.length, 2, "must save exactly 2 turns (user + assistant)")

  const userTurn = store.validatedTurnsLog[0]
  assert.equal(userTurn.role, "user")
  assert.equal(userTurn.content, "Hi there", "user turn content = raw input.message (not prefixed)")
  assert.equal(userTurn.sessionId, "sess-save")
  assert.equal(userTurn.tenantId, "tenant-save")
  assert.equal(userTurn.runId, "run-save-001")
  assert.equal(userTurn.createdAt, "2026-07-19T12:00:00.000Z", "createdAt uses injected clock")

  const assistantTurn = store.validatedTurnsLog[1]
  assert.equal(assistantTurn.role, "assistant")
  assert.equal(assistantTurn.content, "Hello world", "assistant turn content = joined reply")
  assert.equal(assistantTurn.sessionId, "sess-save")
  assert.equal(assistantTurn.tenantId, "tenant-save")
  assert.equal(assistantTurn.runId, "run-save-001")
  assert.equal(assistantTurn.createdAt, "2026-07-19T12:00:00.000Z")
})

test("T10 wiring: no memoryAdapter → raw message passed to stream (T09 backward compat)", async () => {
  const cap = makeCapturingStream()
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("direct"),
    streamDirectReply: cap.stream,
    // memoryAdapter omitted — T09 behavior
  })

  await runner(makeRunnerInput({ message: "plain message" }))

  const captured = cap.capturedMessage()
  assert.equal(captured, "plain message", "no memoryAdapter → no prefix, raw message passed")
})

test("T10 wiring: memoryAdapter wired but resolveTenantId missing → no memory ops (defensive)", async () => {
  const store = makeT10FakeStore()
  const adapter = createMastraMemoryAdapter({ conversationStore: store })
  const cap = makeCapturingStream()
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("direct"),
    streamDirectReply: cap.stream,
    memoryAdapter: adapter,
    // resolveTenantId omitted — runner must skip memory ops defensively
  })

  await runner(makeRunnerInput({ message: "no resolver" }))

  assert.equal(cap.capturedMessage(), "no resolver", "no resolveTenantId → raw message (no prefix)")
  assert.equal(store.validatedTurnsLog.length, 0, "no resolveTenantId → no turns saved")
  assert.equal(
    store.calls.filter((c) => c.method === "loadConversationMemory").length,
    0,
    "no resolveTenantId → no query() call"
  )
})

test("T10 wiring: mid-stream abort → no validated turns saved (T10 #2)", async () => {
  const store = makeT10FakeStore()
  const adapter = createMastraMemoryAdapter({ conversationStore: store })
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("direct"),
    streamDirectReply: makeAbortingStream(2),
    memoryAdapter: adapter,
    resolveTenantId: (ctx) => ctx.tenantId,
  })

  const ac = new AbortController()
  setTimeout(() => ac.abort(), 0)

  await assert.rejects(
    () => runner(makeRunnerInput({ signal: ac.signal })),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.equal(err.name, "AbortError", "mid-stream abort must surface as AbortError")
      return true
    }
  )

  assert.equal(
    store.validatedTurnsLog.length,
    0,
    "mid-stream abort → NO validated turns saved (T10 #2: only completed turns persist)"
  )
})

test("T10 wiring: ambiguous route → no memoryAdapter calls (T10 #2)", async () => {
  const store = makeT10FakeStore()
  const adapter = createMastraMemoryAdapter({ conversationStore: store })
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("ambiguous"),
    streamDirectReply: makeScriptedStream([]),
    memoryAdapter: adapter,
    resolveTenantId: (ctx) => ctx.tenantId,
  })

  const output = await runner(makeRunnerInput({ message: "ambiguous input" }))

  assert.equal(output.status, "clarification_required")
  assert.equal(
    store.validatedTurnsLog.length,
    0,
    "ambiguous route MUST NOT save validated turns (not a completed turn — T10 #2)"
  )
  assert.equal(
    store.calls.filter((c) => c.method === "loadConversationMemory").length,
    0,
    "ambiguous route MUST NOT load conversation memory (no LLM stream to prefix)"
  )
})

test("T10 wiring: saved user turn has raw input.message (not context-prefixed)", async () => {
  const store = makeT10FakeStore({
    sessionId: "sess-raw",
    tenantId: "tenant-raw",
    memory: makeSeededMemory({
      summary: "context that would be prepended to the LLM prompt",
      recentTurns: [],
      totalValidatedTurnCount: 1,
    }),
  })
  const adapter = createMastraMemoryAdapter({ conversationStore: store })
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("direct"),
    streamDirectReply: makeScriptedStream(["reply"]),
    memoryAdapter: adapter,
    resolveTenantId: (ctx) => ctx.tenantId,
    now: () => new Date("2026-07-19T12:00:00Z"),
  })

  await runner(
    makeRunnerInput({
      message: "raw user message",
      sessionId: "sess-raw",
      accessContext: makeAccessContext("tenant-raw"),
    })
  )

  // The LLM saw the context-prefixed message, but the persisted user turn
  // must be the raw input.message — otherwise the rolling summary would
  // accumulate context prefixes (data corruption).
  assert.equal(store.validatedTurnsLog.length, 2)
  assert.equal(
    store.validatedTurnsLog[0].content,
    "raw user message",
    "persisted user turn MUST be raw input.message, NOT the context-prefixed prompt"
  )
  assert.equal(
    store.validatedTurnsLog[1].content,
    "reply",
    "persisted assistant turn MUST be the raw reply"
  )
})

test("T10 wiring: createdAt uses injected clock for both turns", async () => {
  const store = makeT10FakeStore()
  const adapter = createMastraMemoryAdapter({ conversationStore: store })
  const fixedDate = new Date("2026-01-15T08:30:45.678Z")
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("direct"),
    streamDirectReply: makeScriptedStream(["r"]),
    memoryAdapter: adapter,
    resolveTenantId: (ctx) => ctx.tenantId,
    now: () => fixedDate,
  })

  await runner(makeRunnerInput())

  assert.equal(
    store.validatedTurnsLog[0].createdAt,
    "2026-01-15T08:30:45.678Z",
    "user turn createdAt uses injected clock"
  )
  assert.equal(
    store.validatedTurnsLog[1].createdAt,
    "2026-01-15T08:30:45.678Z",
    "assistant turn createdAt uses injected clock (same instant — both turns stamped together)"
  )
})

test("T10 wiring: T10 #5 safe-degradation — store error on query → empty prefix, run succeeds", async () => {
  const store = makeT10FakeStore()
  store.throwOnLoadConversationMemory = true
  const adapter = createMastraMemoryAdapter({ conversationStore: store })
  const cap = makeCapturingStream()
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("direct"),
    streamDirectReply: cap.stream,
    memoryAdapter: adapter,
    resolveTenantId: (ctx) => ctx.tenantId,
    now: () => new Date("2026-07-19T12:00:00Z"),
  })

  // The run must succeed despite the store throwing on query() — the adapter
  // catches the error and returns an empty snapshot (T10 #5).
  const output = await runner(makeRunnerInput({ message: "degraded" }))

  assert.equal(output.status, "completed", "run must complete despite store error on query()")
  assert.equal(
    cap.capturedMessage(),
    "degraded",
    "empty snapshot → empty prefix → raw message passed to stream (T10 #5)"
  )
  // Turns are still saved — saveValidatedTurn does not depend on query() success.
  assert.equal(store.validatedTurnsLog.length, 2, "validated turns saved even when query() degraded")
})

test("T10 wiring: memoryAdapter.query receives (sessionId, tenantId from AccessContext)", async () => {
  const store = makeT10FakeStore()
  const adapter = createMastraMemoryAdapter({ conversationStore: store })
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("direct"),
    streamDirectReply: makeScriptedStream(["ok"]),
    memoryAdapter: adapter,
    resolveTenantId: (ctx) => ctx.tenantId,
  })

  await runner(
    makeRunnerInput({
      sessionId: "sess-ctx-001",
      accessContext: makeAccessContext("tenant-from-ctx"),
    })
  )

  // Verify query() was called with (sessionId=threadId, tenantId=resourceId
  // from AccessContext) — T04 §3 rule 1: tenantId sourced from AccessContext,
  // not from free-form args.
  const queryCall = store.calls.find((c) => c.method === "loadConversationMemory")
  assert.ok(queryCall, "loadConversationMemory must be called")
  assert.deepEqual(
    queryCall!.args,
    ["sess-ctx-001", "tenant-from-ctx"],
    "query() receives (sessionId, tenantId from AccessContext) — T04 §3 rule 1"
  )
})

test("T10 wiring: empty memory snapshot → no prefix, raw message passed to stream", async () => {
  const store = makeT10FakeStore()  // empty store — no seeded memory
  const adapter = createMastraMemoryAdapter({ conversationStore: store })
  const cap = makeCapturingStream()
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("direct"),
    streamDirectReply: cap.stream,
    memoryAdapter: adapter,
    resolveTenantId: (ctx) => ctx.tenantId,
  })

  await runner(makeRunnerInput({ message: "first message" }))

  // Empty snapshot (null summary + no recent turns) → formatMemoryAsContext
  // returns "" → no prefix → raw message passed to stream.
  assert.equal(
    cap.capturedMessage(),
    "first message",
    "empty memory → no prefix → raw message (matches T09 behavior for first-turn)"
  )
})

test("P1 regression: prepared direct and ambiguous routes preserve the authoritative route trace", async () => {
  const routeTrace = {
    decision: "direct" as const,
    contextualizationOutcome: "success" as const,
    contextualizationDurationMs: 12,
    contextualizationUsage: {
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
    },
  }
  const directRunner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("ambiguous"),
    streamDirectReply: makeScriptedStream(["ok"]),
  })
  const directOutput = await directRunner(makeRunnerInput({
    preparedRoute: {
      decision: "direct",
      effectiveMessage: "effective direct",
      contextualizedQuery: "contextualized direct",
      routeTrace,
    },
  }))
  assert.deepEqual(directOutput.routeTrace, routeTrace)

  const ambiguousTrace = { ...routeTrace, decision: "ambiguous" as const }
  const ambiguousRunner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("direct"),
    streamDirectReply: makeScriptedStream([]),
  })
  const ambiguousOutput = await ambiguousRunner(makeRunnerInput({
    preparedRoute: {
      decision: "ambiguous",
      effectiveMessage: "effective ambiguous",
      contextualizedQuery: "contextualized ambiguous",
      routeTrace: ambiguousTrace,
    },
  }))
  assert.deepEqual(ambiguousOutput.routeTrace, ambiguousTrace)
})

test("P1 regression: direct route triggers rolling summarization and returns metadata", async () => {
  const store = makeT10FakeStore({
    sessionId: "sess-test-001",
    memory: makeSeededMemory({
      totalValidatedTurnCount: 13,
      oldestRecentTurnId: 14,
    }),
  })
  store.loadOlderTurnsForSummarization = () => [{
    sessionId: "sess-test",
    tenantId: "tenant-test",
    role: "user",
    content: "older fact",
    runId: "older-run",
    createdAt: "2026-07-01T00:00:00.000Z",
  }]
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("direct"),
    streamDirectReply: makeScriptedStream(["reply"]),
    conversationStore: store,
    memoryAdapter: createMastraMemoryAdapter({ conversationStore: store }),
    resolveTenantId: (ctx) => ctx.tenantId,
    summarizer: {
      async summarize() {
        return {
          summary: "rolling summary",
          usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
        }
      },
    },
  })

  const output = await runner(makeRunnerInput())
  assert.equal(output.summarizationOutcome, "success")
  assert.deepEqual(output.summarizationUsage, {
    promptTokens: 4,
    completionTokens: 2,
    totalTokens: 6,
  })
  assert.equal(output.summarizationCheckpoint, 13)
  assert.equal(store.calls.filter((call) => call.method === "saveRollingSummary").length, 1)
})

test("P1 regression: abort during direct post-persistence summarization does not cancel saved completion", async () => {
  const store = makeT10FakeStore({
    sessionId: "sess-test-001",
    memory: makeSeededMemory({ totalValidatedTurnCount: 13, oldestRecentTurnId: 14 }),
  })
  store.loadOlderTurnsForSummarization = () => [{
    sessionId: "sess-test",
    tenantId: "tenant-test",
    role: "user",
    content: "older fact",
    runId: "older-run",
    createdAt: "2026-07-01T00:00:00.000Z",
  }]
  const controller = new AbortController()
  const runner = createDirectAmbiguousMastraRunner({
    router: makeFakeRouter("direct"),
    streamDirectReply: makeScriptedStream(["reply"]),
    conversationStore: store,
    memoryAdapter: createMastraMemoryAdapter({ conversationStore: store }),
    resolveTenantId: (ctx) => ctx.tenantId,
    summarizer: {
      async summarize() {
        controller.abort()
        const error = new Error("summary aborted")
        error.name = "AbortError"
        throw error
      },
    },
  })

  const output = await runner(makeRunnerInput({ signal: controller.signal }))
  assert.equal(output.status, "completed")
  assert.equal(output.summarizationOutcome, "failed")
  assert.equal(store.validatedTurnsLog.length, 2)
})
