/**
 * Ticket 11 + Ticket 12 — Route dispatch Mastra runner tests.
 *
 * TDD test suite for `src/mastra/route_dispatch_runner.ts`. Verifies the
 * composition of the T09 direct/ambiguous runner, the T11 simple knowledge
 * runner, and the T12 complex knowledge runner into a single route-aware
 * MastraRunner.
 *
 * Coverage map:
 *   - Router decides exactly once per request.
 *   - Exactly one route owner is invoked.
 *   - Complex without an owner produces RouteNotSupportedError.
 *   - Owner failures propagate unchanged.
 *   - Prepared route and request identity are passed to the selected owner.
 *
 * Boundary: this file is owned by `src/mastra/*` and MUST NOT import
 * `src/api/*` or `src/index` (T02 #5 dependency direction).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createRouteDispatchRunner } from "./route_dispatch_runner"
import { RouteNotSupportedError } from "./direct_ambiguous_runner"
import { RouteNotComplexError } from "./complex_knowledge_runner"
import type {
  MastraRunner,
  MastraRunnerInput,
  MastraRunnerOutput,
} from "./chat_event_adapter"
import type { AccessContext } from "../access/context"
import type { Query, RouterDecision } from "../types"

// ---------------------------------------------------------------------------
// Test fakes — record calls + return scripted outputs/errors.
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
    message: "What is the return policy?",
    runId: "run-test-001",
    sessionId: "sess-test-001",
    signal: new AbortController().signal,
    accessContext: makeAccessContext(),
    ...overrides,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("T11 dispatch #1 simple route → simpleRunner handles, directAmbiguousRunner NOT called", async () => {
  const router = makeRouter("simple")
  const simpleRunner = makeFakeRunner({
    kind: "resolve",
    output: {
      status: "completed",
      reply: "simple reply",
      routeTrace: { decision: "simple" },
    },
  })
  const directAmbiguousRunner = makeFakeRunner({
    kind: "resolve",
    output: { status: "completed", reply: "should not be used" },
  })
  const runner = createRouteDispatchRunner({ router, simpleRunner, directAmbiguousRunner })
  const input = makeRunnerInput({ message: "What is the return policy?" })
  const output = await runner(input)
  assert.equal(output.status, "completed")
  assert.equal(output.reply, "simple reply")
  assert.equal(simpleRunner.calls.length, 1, "simpleRunner must be called exactly once")
  assert.equal(directAmbiguousRunner.calls.length, 0, "directAmbiguousRunner MUST NOT be called for simple route")
  assert.equal(simpleRunner.calls[0].message, input.message, "input.message passed through")
  assert.equal(simpleRunner.calls[0].preparedRoute?.decision, "simple")
  assert.equal(router.calls.length, 1)
})

test("T11 dispatch #2 direct route → directAmbiguousRunner handles without probing simpleRunner", async () => {
  const router = makeRouter("direct")
  const simpleRunner = makeFakeRunner({
    kind: "resolve",
    output: { status: "completed", reply: "should not be used" },
  })
  const directAmbiguousRunner = makeFakeRunner({
    kind: "resolve",
    output: {
      status: "completed",
      reply: "direct reply",
      routeTrace: { decision: "direct" },
    },
  })
  const runner = createRouteDispatchRunner({ router, simpleRunner, directAmbiguousRunner })
  const input = makeRunnerInput({ message: "Hello there" })
  const output = await runner(input)
  assert.equal(output.status, "completed")
  assert.equal(output.reply, "direct reply")
  assert.equal(simpleRunner.calls.length, 0, "non-owner simpleRunner must not run")
  assert.equal(directAmbiguousRunner.calls.length, 1, "directAmbiguousRunner owns direct")
  assert.equal(directAmbiguousRunner.calls[0].message, input.message, "input passed through to owner")
  assert.equal(directAmbiguousRunner.calls[0].preparedRoute?.decision, "direct")
  assert.equal(router.calls.length, 1)
})

test("T11 dispatch #2 ambiguous route → directAmbiguousRunner handles without probing simpleRunner", async () => {
  const router = makeRouter("ambiguous")
  const simpleRunner = makeFakeRunner({
    kind: "resolve",
    output: { status: "completed", reply: "should not be used" },
  })
  const directAmbiguousRunner = makeFakeRunner({
    kind: "resolve",
    output: {
      status: "clarification_required",
      reply: "I need more context.",
      routeTrace: { decision: "ambiguous" },
    },
  })
  const runner = createRouteDispatchRunner({ router, simpleRunner, directAmbiguousRunner })
  const output = await runner(makeRunnerInput({ message: "um what" }))
  assert.equal(output.status, "clarification_required")
  assert.equal(simpleRunner.calls.length, 0)
  assert.equal(directAmbiguousRunner.calls.length, 1)
  assert.equal(directAmbiguousRunner.calls[0].preparedRoute?.decision, "ambiguous")
  assert.equal(router.calls.length, 1)
})

test("T11 dispatch #3 complex route without complexRunner → RouteNotSupportedError", async () => {
  const router = makeRouter("complex")
  const simpleRunner = makeFakeRunner({
    kind: "resolve",
    output: { status: "completed", reply: "should not be used" },
  })
  const directAmbiguousRunner = makeFakeRunner({
    kind: "resolve",
    output: { status: "completed", reply: "should not be used" },
  })
  const runner = createRouteDispatchRunner({ router, simpleRunner, directAmbiguousRunner })
  await assert.rejects(
    () => runner(makeRunnerInput({ message: "multi-part complex query" })),
    (err: unknown) => {
      assert.ok(err instanceof RouteNotSupportedError, "complex route must propagate RouteNotSupportedError")
      assert.equal((err as RouteNotSupportedError).decision, "complex")
      return true
    },
    "complex route must report a missing owner"
  )
  assert.equal(simpleRunner.calls.length, 0)
  assert.equal(directAmbiguousRunner.calls.length, 0)
  assert.equal(router.calls.length, 1)
})

test("T11 dispatch #4 selected owner AbortError propagates unchanged", async () => {
  const router = makeRouter("simple")
  const abortErr = new Error("aborted")
  abortErr.name = "AbortError"
  const simpleRunner = makeFakeRunner({ kind: "reject", error: abortErr })
  const directAmbiguousRunner = makeFakeRunner({
    kind: "resolve",
    output: { status: "completed", reply: "should not be used" },
  })
  const runner = createRouteDispatchRunner({ router, simpleRunner, directAmbiguousRunner })
  await assert.rejects(
    () => runner(makeRunnerInput()),
    (err: unknown) => {
      assert.equal((err as Error).name, "AbortError", "AbortError must propagate unchanged")
      return true
    },
    "selected owner error must propagate"
  )
  assert.equal(simpleRunner.calls.length, 1, "selected simpleRunner must run once")
  assert.equal(directAmbiguousRunner.calls.length, 0, "directAmbiguousRunner MUST NOT be called for non-route errors")
})

test("T11 dispatch #5 provider_error from simpleRunner → propagates (no fallback)", async () => {
  const router = makeRouter("simple")
  const providerErr = new Error("OpenAI rate limited")
  const simpleRunner = makeFakeRunner({ kind: "reject", error: providerErr })
  const directAmbiguousRunner = makeFakeRunner({
    kind: "resolve",
    output: { status: "completed", reply: "should not be used" },
  })
  const runner = createRouteDispatchRunner({ router, simpleRunner, directAmbiguousRunner })
  await assert.rejects(
    () => runner(makeRunnerInput()),
    (err: unknown) => {
      assert.equal((err as Error).message, "OpenAI rate limited")
      return true
    }
  )
  assert.equal(directAmbiguousRunner.calls.length, 0, "provider error must NOT trigger fallback")
})

test("T11 dispatch #6 identity preservation: runId/sessionId/accessContext passed through", async () => {
  const router = makeRouter("simple")
  const simpleRunner = makeFakeRunner({
    kind: "resolve",
    output: { status: "completed", reply: "ok" },
  })
  const directAmbiguousRunner = makeFakeRunner({
    kind: "resolve",
    output: { status: "completed", reply: "ok" },
  })
  const runner = createRouteDispatchRunner({ router, simpleRunner, directAmbiguousRunner })
  const accessContext = makeAccessContext("tenant-xyz")
  const input = makeRunnerInput({
    message: "question",
    runId: "run-abc-123",
    sessionId: "sess-def-456",
    accessContext,
  })
  await runner(input)
  assert.equal(simpleRunner.calls[0].runId, "run-abc-123", "runId passed through")
  assert.equal(simpleRunner.calls[0].sessionId, "sess-def-456", "sessionId passed through")
  assert.equal(simpleRunner.calls[0].accessContext, accessContext, "accessContext passed through (same reference)")
  assert.equal(simpleRunner.calls[0].signal, input.signal, "signal passed through (same reference)")
})

// ---------------------------------------------------------------------------
// T12 — Complex route dispatch (complexRunner wired)
// ---------------------------------------------------------------------------

test("T12 dispatch #1 complex route WITH complexRunner wired → complexRunner handles (no legacy fallback)", async () => {
  const router = makeRouter("complex")
  const simpleRunner = makeFakeRunner({
    kind: "resolve",
    output: { status: "completed", reply: "should not be used" },
  })
  const directAmbiguousRunner = makeFakeRunner({
    kind: "resolve",
    output: { status: "completed", reply: "should not be used" },
  })
  const complexRunner = makeFakeRunner({
    kind: "resolve",
    output: {
      status: "completed",
      reply: "complex reply with citations",
      routeTrace: { decision: "complex" },
    },
  })
  const runner = createRouteDispatchRunner({
    router,
    simpleRunner,
    directAmbiguousRunner,
    complexRunner,
  })
  const input = makeRunnerInput({ message: "multi-part complex query" })
  const output = await runner(input)
  assert.equal(output.status, "completed", "complexRunner must handle the complex route")
  assert.equal(output.reply, "complex reply with citations")
  assert.equal(simpleRunner.calls.length, 0, "non-owner simpleRunner must not run")
  assert.equal(directAmbiguousRunner.calls.length, 0, "non-owner direct runner must not run")
  assert.equal(complexRunner.calls.length, 1, "complexRunner owns complex")
  assert.equal(complexRunner.calls[0].message, input.message, "input passed through to complexRunner")
  assert.equal(complexRunner.calls[0].preparedRoute?.decision, "complex")
  assert.equal(router.calls.length, 1)
})

test("T12 dispatch #2 complexRunner throws RouteNotComplexError → propagates (router disagreement)", async () => {
  const router = makeRouter("complex")
  const simpleRunner = makeFakeRunner({
    kind: "resolve",
    output: { status: "completed", reply: "should not be used" },
  })
  const directAmbiguousRunner = makeFakeRunner({
    kind: "resolve",
    output: { status: "completed", reply: "should not be used" },
  })
  const complexRunner = makeFakeRunner({
    kind: "reject",
    error: new RouteNotComplexError("simple"),
  })
  const runner = createRouteDispatchRunner({
    router,
    simpleRunner,
    directAmbiguousRunner,
    complexRunner,
  })
  await assert.rejects(
    () => runner(makeRunnerInput({ message: "multi-part complex query" })),
    (err: unknown) => {
      assert.ok(err instanceof RouteNotComplexError, "RouteNotComplexError must propagate (no further fallback)")
      assert.equal((err as RouteNotComplexError).decision, "simple")
      return true
    },
    "RouteNotComplexError from complexRunner must propagate — dispatch has no further fallback"
  )
  assert.equal(complexRunner.calls.length, 1, "complexRunner was tried")
})

test("T12 dispatch #3 complexRunner throws non-route error → propagates (no further fallback)", async () => {
  const router = makeRouter("complex")
  const providerErr = new Error("OpenAI rate limited during complex loop")
  const simpleRunner = makeFakeRunner({
    kind: "resolve",
    output: { status: "completed", reply: "should not be used" },
  })
  const directAmbiguousRunner = makeFakeRunner({
    kind: "resolve",
    output: { status: "completed", reply: "should not be used" },
  })
  const complexRunner = makeFakeRunner({
    kind: "reject",
    error: providerErr,
  })
  const runner = createRouteDispatchRunner({
    router,
    simpleRunner,
    directAmbiguousRunner,
    complexRunner,
  })
  await assert.rejects(
    () => runner(makeRunnerInput({ message: "multi-part complex query" })),
    (err: unknown) => {
      assert.equal((err as Error).message, "OpenAI rate limited during complex loop")
      return true
    },
    "non-route error from complexRunner must propagate — no further fallback"
  )
  assert.equal(complexRunner.calls.length, 1, "complexRunner was tried")
})

test("P1 regression: dispatch makes one authoritative route decision and invokes only its owner", async () => {
  let routeCalls = 0
  const router = {
    async decide(): Promise<"direct"> {
      routeCalls += 1
      return "direct"
    },
  }
  const simpleRunner = makeFakeRunner({
    kind: "resolve",
    output: { reply: "wrong simple reply", routeTrace: { decision: "simple" } },
  })
  const directAmbiguousRunner = makeFakeRunner({
    kind: "resolve",
    output: { reply: "direct reply", routeTrace: { decision: "direct" } },
  })
  const complexRunner = makeFakeRunner({
    kind: "resolve",
    output: { reply: "wrong complex reply", routeTrace: { decision: "complex" } },
  })
  const runner = createRouteDispatchRunner({
    router,
    simpleRunner,
    directAmbiguousRunner,
    complexRunner,
  })

  const output = await runner(makeRunnerInput())
  assert.equal(output.reply, "direct reply")
  assert.equal(routeCalls, 1, "router.decide must be called exactly once")
  assert.equal(simpleRunner.calls.length, 0, "non-owner simple runner must not run")
  assert.equal(directAmbiguousRunner.calls.length, 1, "direct owner must run exactly once")
  assert.equal(complexRunner.calls.length, 0, "non-owner complex runner must not run")
})

test("P1 regression: concurrent dispatches cannot both claim the same pending clarification", async () => {
  // P7.3 peek-then-ack: both dispatches peek (non-destructive) so both
  // route decisions see the pending context. But only one claim
  // (destructive ack) succeeds — the second claim is a no-op (row already
  // deleted). This preserves the P1 invariant: the pending is consumed
  // exactly once.
  let pending: string | null = "Which return policy?"
  let claimCount = 0
  const conversationStore = {
    peekPendingClarification(): string | null {
      return pending
    },
    claimPendingClarification(): string | null {
      const claimed = pending
      pending = null
      if (claimed !== null) claimCount += 1
      return claimed
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
  }
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
    conversationStore: conversationStore as never,
    resolveTenantId: (context) => context.tenantId,
  })

  await Promise.all([
    runner(makeRunnerInput({ runId: "run-claim-1", message: "It arrived damaged" })),
    runner(makeRunnerInput({ runId: "run-claim-2", message: "It arrived damaged" })),
  ])

  assert.equal(seenQueries.filter((query) => query.includes("Which return policy?")).length, 2)
  assert.equal(claimCount, 1, "exactly one claim must succeed (destructive ack)")
  assert.equal(directRunner.calls.length, 2)
})
