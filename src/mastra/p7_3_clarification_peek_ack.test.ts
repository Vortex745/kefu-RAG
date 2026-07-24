/**
 * P7.3 — Clarification peek-then-ack gate tests.
 *
 * Verifies the peek-then-ack contract in `route_dispatch_runner.ts`:
 *   - peek is side-effect free (non-destructive read before route decision)
 *   - ack persists resolution (destructive claim after route decision for
 *     non-ambiguous routes)
 *   - no unconfirmed mutation enters conversation/handoff store (if the
 *     dispatcher fails before claim, the pending is preserved)
 *   - ambiguous routes skip the claim (owner's savePendingClarification
 *     atomically replaces the old pending)
 *   - concurrent dispatches both peek, only one claim succeeds
 *
 * Boundary: this file is owned by `src/mastra/*` and MUST NOT import
 * `src/api/*` or `src/index` (T02 #5 dependency direction).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createRouteDispatchRunner } from "./route_dispatch_runner"
import type {
  MastraRunner,
  MastraRunnerInput,
  MastraRunnerOutput,
} from "./chat_event_adapter"
import type { AccessContext } from "../access/context"
import type { Query, RouterDecision } from "../types"

// ---------------------------------------------------------------------------
// Test fakes
// ---------------------------------------------------------------------------

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
    message: "It arrived damaged",
    runId: "run-p73-001",
    sessionId: "sess-p73-001",
    signal: new AbortController().signal,
    accessContext: makeAccessContext(),
    ...overrides,
  }
}

/**
 * Fake ConversationStore that tracks peek/claim/consume/save calls and
 * holds the pending clarification in-memory. `peekPendingClarification`
 * is non-destructive (returns without deleting); `claimPendingClarification`
 * and `consumePendingClarification` are destructive (return + delete).
 * `savePendingClarification` atomically replaces the pending.
 */
function makeFakeStore(initialPending: string | null) {
  let pending: string | null = initialPending
  const calls = {
    peek: 0,
    claim: 0,
    consume: 0,
    save: [] as Array<{ sessionId: string; tenantId: string; message: string }>,
  }
  return {
    calls,
    peekPendingClarification(): string | null {
      calls.peek += 1
      return pending
    },
    claimPendingClarification(): string | null {
      calls.claim += 1
      const claimed = pending
      pending = null
      return claimed
    },
    consumePendingClarification(): string | null {
      calls.consume += 1
      const consumed = pending
      pending = null
      return consumed
    },
    savePendingClarification(
      sessionId: string,
      tenantId: string,
      message: string
    ): void {
      calls.save.push({ sessionId, tenantId, message })
      pending = message
    },
    loadConversationMemory() {
      return {
        summary: null,
        summarizedThroughTurnId: null,
        schemaVersion: null,
        recentTurns: [],
        totalValidatedTurnCount: 0,
        oldestRecentTurnId: null,
      }
    },
    /** Inspect the current pending state (not part of the real interface). */
    inspectPending(): string | null {
      return pending
    },
  }
}

function makeFakeRunner(
  behavior:
    | { kind: "resolve"; output: Partial<MastraRunnerOutput> }
    | { kind: "reject"; error: Error }
): MastraRunner & { calls: MastraRunnerInput[] } {
  const calls: MastraRunnerInput[] = []
  const runner = async function fakeRunner(
    input: MastraRunnerInput
  ): Promise<MastraRunnerOutput> {
    calls.push(input)
    if (behavior.kind === "reject") throw behavior.error
    return {
      reply: behavior.output.reply ?? "fake reply",
      status: behavior.output.status ?? "completed",
      references: behavior.output.references ?? [],
      degradation: behavior.output.degradation ?? { status: "none", unavailableChannels: [] },
      tokens: behavior.output.tokens ?? [],
      routeTrace: behavior.output.routeTrace ?? {},
      retrievalTrace: behavior.output.retrievalTrace ?? {},
      contextTrace: behavior.output.contextTrace ?? {},
      validationTrace: behavior.output.validationTrace ?? {},
    }
  } as MastraRunner & { calls: MastraRunnerInput[] }
  Object.defineProperty(runner, "calls", {
    get: () => calls,
    enumerable: true,
  })
  return runner
}

function makeRouter(decision: RouterDecision): {
  decide(query: Query): Promise<RouterDecision>
  calls: Query[]
} {
  const calls: Query[] = []
  return {
    calls,
    async decide(query: Query): Promise<RouterDecision> {
      calls.push(query)
      return decision
    },
  }
}

function makeThrowingRouter(error: Error): {
  decide(query: Query): Promise<RouterDecision>
  calls: Query[]
} {
  const calls: Query[] = []
  return {
    calls,
    async decide(query: Query): Promise<RouterDecision> {
      calls.push(query)
      throw error
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("P7.3 #1: peek is side-effect free — pending preserved after peek even when router throws", async () => {
  const store = makeFakeStore("Which return policy?")
  const router = makeThrowingRouter(new Error("router model unavailable"))
  const directRunner = makeFakeRunner({ kind: "resolve", output: {} })
  const runner = createRouteDispatchRunner({
    router,
    simpleRunner: makeFakeRunner({ kind: "resolve", output: {} }),
    directAmbiguousRunner: directRunner,
    conversationStore: store as never,
    resolveTenantId: (context) => context.tenantId,
  })

  await assert.rejects(
    () => runner(makeRunnerInput()),
    (err: unknown) => {
      assert.equal((err as Error).message, "router model unavailable")
      return true
    }
  )

  assert.equal(store.calls.peek, 1, "peek must be called exactly once")
  assert.equal(
    store.inspectPending(),
    "Which return policy?",
    "peek is non-destructive — pending still in store after peek"
  )
  assert.equal(store.calls.claim, 0, "claim must NOT be reached when router throws")
  assert.equal(directRunner.calls.length, 0, "owner must not run when router throws")
})

test("P7.3 #2: ack persists resolution — direct route consumes pending via claim after route decision", async () => {
  const store = makeFakeStore("Which return policy?")
  const router = makeRouter("direct")
  const directRunner = makeFakeRunner({
    kind: "resolve",
    output: { status: "completed", reply: "direct answer" },
  })
  const runner = createRouteDispatchRunner({
    router,
    simpleRunner: makeFakeRunner({ kind: "resolve", output: {} }),
    directAmbiguousRunner: directRunner,
    conversationStore: store as never,
    resolveTenantId: (context) => context.tenantId,
  })

  const output = await runner(makeRunnerInput({ message: "It arrived damaged" }))

  assert.equal(output.status, "completed")
  assert.equal(store.calls.peek, 1, "peek must be called before route decision")
  assert.equal(store.calls.claim, 1, "claim must be called after route decision (destructive ack)")
  assert.equal(store.calls.consume, 0, "consume fallback must NOT be used when claim is available")
  assert.equal(
    store.inspectPending(),
    null,
    "pending must be consumed (deleted) after successful non-ambiguous route"
  )
  assert.equal(directRunner.calls.length, 1, "direct owner must run exactly once")
  // The effective message passed to the owner must include the peeked pending prefix.
  assert.equal(
    directRunner.calls[0].preparedRoute?.effectiveMessage,
    "Which return policy? It arrived damaged",
    "effectiveMessage must prepend the peeked pending to the user message"
  )
})

test("P7.3 #3: no unconfirmed mutation — router failure before claim preserves pending in store", async () => {
  const store = makeFakeStore("Which return policy?")
  const router = makeThrowingRouter(new Error("router timeout"))
  const directRunner = makeFakeRunner({ kind: "resolve", output: {} })
  const runner = createRouteDispatchRunner({
    router,
    simpleRunner: makeFakeRunner({ kind: "resolve", output: {} }),
    directAmbiguousRunner: directRunner,
    conversationStore: store as never,
    resolveTenantId: (context) => context.tenantId,
  })

  await assert.rejects(
    () => runner(makeRunnerInput()),
    (err: unknown) => {
      assert.equal((err as Error).message, "router timeout")
      return true
    }
  )

  // The critical P7.3 invariant: no unconfirmed mutation. The dispatcher
  // peeked (non-destructive) but never claimed (destructive) because the
  // route decision failed. The pending remains in the store for the next
  // dispatch to pick up.
  assert.equal(store.calls.peek, 1)
  assert.equal(store.calls.claim, 0, "claim must NOT run — route decision was not authoritative")
  assert.equal(store.calls.consume, 0)
  assert.equal(
    store.inspectPending(),
    "Which return policy?",
    "pending preserved — no unconfirmed mutation entered the store"
  )
  assert.equal(directRunner.calls.length, 0, "owner must not run on router failure")
  assert.equal(router.calls.length, 1, "router must be called exactly once before failing")
})

test("P7.3 #4: ambiguous route skips claim — owner savePendingClarification atomically replaces", async () => {
  const store = makeFakeStore("old pending question")
  const router = makeRouter("ambiguous")
  // Simulate the direct_ambiguous_runner ambiguous path: it calls
  // savePendingClarification (atomic DELETE+INSERT) with the new effective
  // message, replacing the old pending.
  const directAmbiguousRunner: MastraRunner = async (input: MastraRunnerInput) => {
    assert.ok(input.preparedRoute, "owner must receive preparedRoute in dispatch mode")
    // The ambiguous owner saves a NEW pending (atomically replaces the old).
    // In the real runner this is gated on conversationStore + resolveTenantId.
    ;(store as never as {
      savePendingClarification(s: string, t: string, m: string): void
    }).savePendingClarification(
      input.sessionId,
      "tenant-test",
      "new ambiguous question"
    )
    return {
      reply: "I need more context.",
      status: "clarification_required",
      references: [],
      degradation: { status: "none", unavailableChannels: [] },
      tokens: [],
      routeTrace: input.preparedRoute.routeTrace,
      retrievalTrace: {},
      contextTrace: {},
      validationTrace: {},
    }
  }
  const runner = createRouteDispatchRunner({
    router,
    simpleRunner: makeFakeRunner({ kind: "resolve", output: {} }),
    directAmbiguousRunner,
    conversationStore: store as never,
    resolveTenantId: (context) => context.tenantId,
  })

  const output = await runner(makeRunnerInput({ message: "um what" }))

  assert.equal(output.status, "clarification_required")
  assert.equal(store.calls.peek, 1, "peek must be called before route decision")
  assert.equal(
    store.calls.claim,
    0,
    "claim must NOT be called for ambiguous route — owner's save atomically replaces"
  )
  assert.equal(store.calls.consume, 0)
  assert.equal(store.calls.save.length, 1, "owner must call savePendingClarification exactly once")
  assert.equal(
    store.inspectPending(),
    "new ambiguous question",
    "old pending atomically replaced by new pending via save (not null — not claimed)"
  )
})

test("P7.3 #5: concurrent dispatches both peek, only one claim succeeds (destructive ack)", async () => {
  const store = makeFakeStore("Which return policy?")
  const seenQueries: string[] = []
  const router = {
    async decide(query: Query): Promise<"direct"> {
      seenQueries.push(query.text)
      await Promise.resolve()
      return "direct"
    },
  }
  const directRunner = makeFakeRunner({ kind: "resolve", output: { reply: "ok" } })
  const runner = createRouteDispatchRunner({
    router,
    simpleRunner: makeFakeRunner({ kind: "resolve", output: {} }),
    directAmbiguousRunner: directRunner,
    conversationStore: store as never,
    resolveTenantId: (context) => context.tenantId,
  })

  await Promise.all([
    runner(makeRunnerInput({ runId: "run-concurrent-1", message: "It arrived damaged" })),
    runner(makeRunnerInput({ runId: "run-concurrent-2", message: "It arrived damaged" })),
  ])

  // Both dispatches peek (non-destructive), so both route decisions see the
  // pending context prepended to the user message.
  assert.equal(
    seenQueries.filter((query) => query.includes("Which return policy?")).length,
    2,
    "both dispatches must see the pending via non-destructive peek"
  )
  assert.equal(store.calls.peek, 2, "peek must be called for both dispatches")
  assert.equal(
    store.calls.claim,
    2,
    "claim must be called for both dispatches (both route to non-ambiguous direct)"
  )
  // The first claim returns the pending (destructive); the second claim is a
  // no-op (row already deleted). The pending is consumed exactly once.
  assert.equal(
    store.inspectPending(),
    null,
    "pending must be consumed after both dispatches complete"
  )
  assert.equal(directRunner.calls.length, 2, "both dispatches must invoke the direct owner")
})
