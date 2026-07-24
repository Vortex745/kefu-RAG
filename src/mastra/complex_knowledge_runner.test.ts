/**
 * Ticket 12 — Complex knowledge route Mastra runner tests.
 *
 * TDD test suite for `src/mastra/complex_knowledge_runner.ts`. Verifies the
 * MastraRunner contract for the complex knowledge route: dual-path retrieval
 * (runComplexLoop OR planner.decompose) → Evidence → Context → answer Draft →
 * Citation check → Critic validation loop (with correction-round budget
 * reuse) → publish / handoff.
 *
 * Coverage map (T12 acceptance criteria):
 *   #1 Complex requests preserve query decomposition, coverage criteria, and
 *      bounded retrieval-tool selection
 *      → planner path test (decompose + coverage criteria)
 *      → loop path test (bounded tool selection)
 *   #2 Tools delegate to existing authorized retrieval channels
 *      → accessContext propagation tests (loop + planner paths)
 *   #3 Iteration, tool-call, token, and duration budgets stop runaway loops
 *      → iteration budget test (loop stops at 3 iterations)
 *      → correction-round shared budget test
 *   #4 Correction rounds rebuild one coherent candidate from all accumulated
 *      authorized Evidence
 *      → correction accumulates results + rebuilds evidence + regenerates draft
 *   #5 Duplicate or malformed tool calls fail safely and use the approved
 *      deterministic fallback
 *      → duplicate tool call skipped without backend execution
 *      → correction loop 0 new results → deterministic searcher.search fallback
 *   #6 Cancellation stops active tools and prevents late observations/drafts
 *      → abort before route / during draft stream tests
 *   #7 Every path converges to one existing compatible terminal event
 *      → happy path (loop + planner) / insufficient_retrieval /
 *        invalid_citation / handoff_required / insufficient_evidence /
 *        provider_error / RouteNotComplexError / no-deps provider_error tests
 *
 * Boundary: this test file is owned by `src/mastra/*` and MUST NOT import
 * `src/api/*` or `src/index` (T02 #5 dependency direction).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createComplexKnowledgeMastraRunner,
  RouteNotComplexError,
} from "./complex_knowledge_runner"
import { buildEvidence } from "../answer/evidence"
import type { MastraRunnerInput } from "./chat_event_adapter"
import type { Router } from "../retrieval/router/interface"
import type {
  Searcher,
  SearchOptions,
  SearchOutcome,
} from "../retrieval/search/interface"
import type { ContextAssembler } from "../retrieval/context/interface"
import type { Validator } from "../critic/validator/interface"
import type { RePlanner } from "../critic/replanner/interface"
import type {
  Planner,
  DecomposeResult,
  RewriteResult,
  HypothesisResult,
} from "../retrieval/planner/interface"
import { PlannerError } from "../retrieval/planner/planner"
import type {
  ComplexLoopController,
  ComplexLoopDecision,
  ComplexLoopState,
  ComplexLoopResult,
} from "../retrieval/complex_loop"
import type { ConversationStore, ConversationTurn, ConversationMemory } from "../answer/conversation_store"
import type { HandoffStore } from "../answer/handoff_store"
import type { AccessContext } from "../access/context"
import type {
  Query,
  RetrievalResult,
  RouterDecision,
  CriticVerdict,
  AgentMessage,
  TokenUsage,
} from "../types"
import type { RetrievalToolName, RetrievalToolArgs } from "../retrieval/tool_selector"

// ---------------------------------------------------------------------------
// Test fakes
// ---------------------------------------------------------------------------

function makeFakeRouter(decision: RouterDecision): Router {
  return {
    async decide(_query): Promise<RouterDecision> {
      return decision
    },
  }
}

function makeRetrievalResult(overrides: Partial<RetrievalResult> = {}): RetrievalResult {
  return {
    chunk: {
      id: overrides.chunk?.id ?? "chunk-1",
      documentId: overrides.chunk?.documentId ?? "doc-1",
      content: overrides.chunk?.content ?? "Sample content for testing.",
      childrenIds: overrides.chunk?.childrenIds ?? [],
      metadata: overrides.chunk?.metadata ?? {},
      ...overrides.chunk,
    },
    score: overrides.score ?? 0.9,
    source: overrides.source ?? "vector",
    wikilinks: overrides.wikilinks ?? [],
    ...overrides,
  }
}

function makeFakeSearcher(
  outcomes: SearchOutcome[] | SearchOutcome
): Searcher & { calls: Array<{ query: Query; options?: SearchOptions }> } {
  const calls: Array<{ query: Query; options?: SearchOptions }> = []
  const outcomeList = Array.isArray(outcomes) ? outcomes : [outcomes]
  let callIndex = 0
  return {
    calls,
    async search(query: Query, options?: SearchOptions): Promise<SearchOutcome> {
      calls.push({ query, options })
      const outcome = outcomeList[Math.min(callIndex, outcomeList.length - 1)]
      callIndex += 1
      return outcome
    },
  }
}

function makeFakeAssembler(context: string = "assembled context"): ContextAssembler {
  return {
    async assemble(_results, _citationIds?): Promise<string> {
      return context
    },
  }
}

function makeFakeValidator(
  verdicts: CriticVerdict[] | CriticVerdict
): Validator & { calls: number } {
  const verdictList = Array.isArray(verdicts) ? verdicts : [verdicts]
  let callIndex = 0
  let callsCount = 0
  const validator = {
    get calls(): number {
      return callsCount
    },
    async validate(
      _answer: string,
      _context: AgentMessage[],
      _coverageCriteria?: string[]
    ): Promise<CriticVerdict> {
      const verdict = verdictList[Math.min(callIndex, verdictList.length - 1)]
      callIndex += 1
      callsCount++
      return verdict
    },
  } as Validator & { calls: number }
  return validator
}

function makeFakeRePlanner(
  gapQueries: Query[][] | Query[]
): RePlanner & { calls: number } {
  const queryList = Array.isArray(gapQueries[0]) ? (gapQueries as Query[][]) : [gapQueries as Query[]]
  let callIndex = 0
  let callsCount = 0
  const replanner = {
    get calls(): number {
      return callsCount
    },
    async replan(_verdict: CriticVerdict): Promise<Query[]> {
      const queries = queryList[Math.min(callIndex, queryList.length - 1)]
      callIndex += 1
      callsCount++
      return queries
    },
  } as RePlanner & { calls: number }
  return replanner
}

function makeScriptedDraftStream(
  tokensByCall: string[][] | string[]
): (messages: AgentMessage[], signal: AbortSignal) => AsyncIterable<string> {
  const tokensList = Array.isArray(tokensByCall[0]) ? (tokensByCall as string[][]) : [tokensByCall as string[]]
  let callIndex = 0
  return async function* scriptedStream(
    _messages: AgentMessage[],
    _signal: AbortSignal
  ): AsyncGenerator<string> {
    const tokens = tokensList[Math.min(callIndex, tokensList.length - 1)]
    callIndex += 1
    for (const token of tokens) {
      yield token
    }
  }
}

function makeAbortingDraftStream(atCall: number = 0): (messages: AgentMessage[], signal: AbortSignal) => AsyncIterable<string> {
  let callIndex = 0
  return async function* abortingStream(_messages, _signal) {
    if (callIndex === atCall) {
      callIndex++
      const err = new Error("Draft stream aborted")
      err.name = "AbortError"
      throw err
    }
    callIndex++
    yield "token"
  }
}

function makeFakeConversationStore(
  memory?: Partial<ConversationMemory>
): ConversationStore & {
  validatedTurns: ConversationTurn[]
  pendingClarificationConsumed: Array<{ sessionId: string; tenantId: string }>
  loadMemoryCalls: Array<{ sessionId: string; tenantId: string }>
} {
  const validatedTurns: ConversationTurn[] = []
  const pendingClarificationConsumed: Array<{ sessionId: string; tenantId: string }> = []
  const loadMemoryCalls: Array<{ sessionId: string; tenantId: string }> = []
  const baseMemory: ConversationMemory = {
    totalValidatedTurnCount: memory?.totalValidatedTurnCount ?? 0,
    oldestRecentTurnId: memory?.oldestRecentTurnId ?? null,
    summary: memory?.summary ?? null,
    summarizedThroughTurnId: memory?.summarizedThroughTurnId ?? null,
    schemaVersion: memory?.schemaVersion ?? 1,
    recentTurns: memory?.recentTurns ?? [],
  }
  return {
    validatedTurns,
    pendingClarificationConsumed,
    loadMemoryCalls,
    saveValidatedTurn(turn: ConversationTurn): void {
      validatedTurns.push(turn)
    },
    savePendingClarification(): void { /* no-op */ },
    loadConversationMemory(sessionId: string, tenantId: string): ConversationMemory {
      loadMemoryCalls.push({ sessionId, tenantId })
      return baseMemory
    },
    loadOlderTurnsForSummarization(): ConversationTurn[] { return [] },
    saveRollingSummary(): void { /* no-op */ },
    consumePendingClarification(sessionId: string, tenantId: string): string | null {
      pendingClarificationConsumed.push({ sessionId, tenantId })
      return null
    },
  } as unknown as ConversationStore & {
    validatedTurns: ConversationTurn[]
    pendingClarificationConsumed: Array<{ sessionId: string; tenantId: string }>
    loadMemoryCalls: Array<{ sessionId: string; tenantId: string }>
  }
}

function makeFakeHandoffStore(): HandoffStore & {
  createdCases: Array<{
    runId: string
    tenantId: string
    subjectId: string
    sessionId: string
    reasonCode: string
    userRequest: string
    conversationSummary: string
    evidenceIds: string[]
    traceReference: string
  }>
} {
  const createdCases: Array<any> = []
  return {
    createdCases,
    create(args: any): void {
      createdCases.push(args)
    },
  } as unknown as HandoffStore & { createdCases: Array<any> }
}

function makeFakePlanner(
  decomposeResult: DecomposeResult,
  rewriteResults?: RewriteResult[],
  navigateResults?: string[][],
  hypothesisResults?: HypothesisResult[]
): Planner & { decomposeCalls: Query[]; rewriteCalls: Query[]; navigateCalls: Query[]; hypothesisCalls: Query[] } {
  const decomposeCalls: Query[] = []
  const rewriteCalls: Query[] = []
  const navigateCalls: Query[] = []
  const hypothesisCalls: Query[] = []
  const rewrites = rewriteResults ?? decomposeResult.queries.map((q) => ({ query: q, usage: undefined as TokenUsage | undefined }))
  const navigates = navigateResults ?? decomposeResult.queries.map(() => [] as string[])
  const hypotheses = hypothesisResults ?? decomposeResult.queries.map(() => ({ text: "", usage: undefined as TokenUsage | undefined }))
  let rewriteIndex = 0
  let navigateIndex = 0
  let hypothesisIndex = 0
  return {
    decomposeCalls,
    rewriteCalls,
    navigateCalls,
    hypothesisCalls,
    async decompose(query: Query): Promise<DecomposeResult> {
      decomposeCalls.push(query)
      return decomposeResult
    },
    async rewrite(query: Query): Promise<RewriteResult> {
      rewriteCalls.push(query)
      const result = rewrites[Math.min(rewriteIndex, rewrites.length - 1)]
      rewriteIndex += 1
      return result
    },
    async navigate(query: Query): Promise<string[]> {
      navigateCalls.push(query)
      const result = navigates[Math.min(navigateIndex, navigates.length - 1)]
      navigateIndex += 1
      return result
    },
    async generateHypothesis(query: Query): Promise<HypothesisResult> {
      hypothesisCalls.push(query)
      const result = hypotheses[Math.min(hypothesisIndex, hypotheses.length - 1)]
      hypothesisIndex += 1
      return result
    },
  } as Planner & {
    decomposeCalls: Query[]
    rewriteCalls: Query[]
    navigateCalls: Query[]
    hypothesisCalls: Query[]
  }
}

/**
 * Fake ComplexLoopController that returns scripted decisions in sequence.
 * The Nth call to `decide` returns the Nth scripted decision (last one
 * repeats if there are more calls than scripts).
 */
function makeFakeComplexLoopController(
  decisions: ComplexLoopDecision[]
): ComplexLoopController & { decideCalls: ComplexLoopState[] } {
  const decideCalls: ComplexLoopState[] = []
  let callIndex = 0
  return {
    decideCalls,
    async decide(state: ComplexLoopState, _signal?: AbortSignal): Promise<ComplexLoopDecision> {
      decideCalls.push(state)
      const decision = decisions[Math.min(callIndex, decisions.length - 1)]
      callIndex += 1
      return decision
    },
  } as ComplexLoopController & { decideCalls: ComplexLoopState[] }
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
    message: "What is the return policy for electronics and how does it differ from furniture?",
    runId: "run-test-001",
    sessionId: "sess-test-001",
    signal: new AbortController().signal,
    accessContext: makeAccessContext(),
    ...overrides,
  }
}

/**
 * Build a valid answer with citations for the given evidence. Used to make
 * streamAnswerDraft return answers that pass referencesForReply checks.
 */
function buildCitedAnswer(evidence: ReturnType<typeof buildEvidence>): string {
  if (evidence.length === 0) return "No evidence available."
  const firstId = evidence[0].id
  return `According to the document [cite:${firstId}], the return policy is 30 days.`
}

// ---------------------------------------------------------------------------
// T12 #1 — Complex requests preserve query decomposition, coverage criteria,
// and bounded retrieval-tool selection
// ---------------------------------------------------------------------------

test("T12 #1a planner path: sub-queries with coverage criteria are decomposed and searched", async () => {
  const subQueries: Query[] = [
    { text: "return policy electronics", coverageCriteria: ["electronics", "30 days"] },
    { text: "return policy furniture", coverageCriteria: ["furniture", "14 days"] },
  ]
  const decomposeResult: DecomposeResult = {
    queries: subQueries,
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
  }
  const planner = makeFakePlanner(decomposeResult)
  const result1 = makeRetrievalResult({ chunk: { id: "c1", documentId: "d1", content: "electronics policy", childrenIds: [], metadata: {} } })
  const result2 = makeRetrievalResult({ chunk: { id: "c2", documentId: "d2", content: "furniture policy", childrenIds: [], metadata: {} } })
  const searcher = makeFakeSearcher([
    { status: "ok", results: [result1], unavailableChannels: [] },
    { status: "ok", results: [result2], unavailableChannels: [] },
  ])
  const evidence = buildEvidence([result1, result2])
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    planner,
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed", "planner path must reach completed")
  assert.equal(output.routeTrace.decision, "complex")
  assert.equal(output.routeTrace.queryCount, 2, "queryCount must reflect decomposed sub-queries")
  assert.ok(output.routeTrace.subQueries, "subQueries must be populated")
  assert.equal(output.routeTrace.subQueries!.length, 2)
  assert.equal(planner.decomposeCalls.length, 1, "planner.decompose called once")
  assert.equal(planner.rewriteCalls.length, 2, "planner.rewrite called per sub-query")
  assert.equal(searcher.calls.length, 2, "searcher.search called per sub-query")
})

test("P1 regression: early complex terminal preserves prepared and planner route trace fields", async () => {
  const preparedTrace = {
    decision: "complex" as const,
    contextualizationOutcome: "failed" as const,
    contextualizationFailure: "context provider unavailable",
    contextualizationUsage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
    contextualizationDurationMs: 23,
  }
  const planner = makeFakePlanner({
    queries: [{ text: "missing evidence", coverageCriteria: ["policy"] }],
    usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
  })
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => makeFakeSearcher({
      status: "ok",
      results: [],
      unavailableChannels: [],
    }),
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["unused"]),
    planner,
  })

  const output = await runner(makeRunnerInput({
    preparedRoute: {
      decision: "complex",
      effectiveMessage: "effective",
      contextualizedQuery: "contextualized",
      routeTrace: preparedTrace,
    },
  }))

  assert.equal(output.status, "insufficient_evidence")
  assert.equal(output.routeTrace.contextualizationFailure, preparedTrace.contextualizationFailure)
  assert.deepEqual(output.routeTrace.contextualizationUsage, preparedTrace.contextualizationUsage)
  assert.equal(output.routeTrace.contextualizationDurationMs, preparedTrace.contextualizationDurationMs)
  assert.equal(output.routeTrace.queryCount, 1)
  assert.equal(output.routeTrace.modelCalls, 4)
  assert.equal(output.routeTrace.tokens, 14)
})

test("T12 #1b loop path: bounded loop runs with tool selection (≤3 iter / ≤4 tools)", async () => {
  const result1 = makeRetrievalResult({ chunk: { id: "c1", documentId: "d1", content: "loop content", childrenIds: [], metadata: {} } })
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [result1],
    unavailableChannels: [],
  })
  const controller = makeFakeComplexLoopController([
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "first" } },
    { sufficient: true },
  ])
  const evidence = buildEvidence([result1])
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    complexLoopController: controller,
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed", "loop path must reach completed")
  assert.equal(output.routeTrace.complexLoopStopReason, "evidence-sufficient")
  assert.equal(output.routeTrace.complexLoopIterations, 2, "2 iterations executed (decide + sufficient)")
  assert.equal(output.routeTrace.complexLoopToolCalls, 1, "1 tool call executed")
  assert.equal(searcher.calls.length, 1, "searcher.search called once by the loop")
  assert.ok(searcher.calls[0].options?.accessContext, "searcher must receive accessContext (T12 #2)")
})

// ---------------------------------------------------------------------------
// T12 #2 — Tools delegate to existing authorized retrieval channels
// ---------------------------------------------------------------------------

test("T12 #2a loop path: searcher.search receives accessContext", async () => {
  const accessContext = makeAccessContext("tenant-loop")
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [makeRetrievalResult()],
    unavailableChannels: [],
  })
  const controller = makeFakeComplexLoopController([{ sufficient: true }])
  const evidence = buildEvidence([makeRetrievalResult()])
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    complexLoopController: controller,
  })
  // Need at least one result for the loop to be "available" — but with
  // sufficient=true on first iteration, no tool call is made. Provide a
  // result via the searcher anyway to avoid empty-evidence terminal.
  // Use a controller that calls a tool first, then stops.
  const controller2 = makeFakeComplexLoopController([
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "test" } },
    { sufficient: true },
  ])
  const runner2 = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    complexLoopController: controller2,
  })
  await runner2(makeRunnerInput({ accessContext }))
  assert.equal(
    searcher.calls[0].options?.accessContext,
    accessContext,
    "searcher.search must receive accessContext in loop path (T12 #2)"
  )
})

test("T12 #2b planner path: searcher.search receives accessContext", async () => {
  const accessContext = makeAccessContext("tenant-planner")
  const subQueries: Query[] = [{ text: "sub-query-1" }]
  const decomposeResult: DecomposeResult = { queries: subQueries }
  const planner = makeFakePlanner(decomposeResult)
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [makeRetrievalResult()],
    unavailableChannels: [],
  })
  const evidence = buildEvidence([makeRetrievalResult()])
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    planner,
  })
  await runner(makeRunnerInput({ accessContext }))
  assert.equal(
    searcher.calls[0].options?.accessContext,
    accessContext,
    "searcher.search must receive accessContext in planner path (T12 #2)"
  )
})

// ---------------------------------------------------------------------------
// T12 #3 — Iteration, tool-call, token, and duration budgets stop runaway
// Agent loops
// ---------------------------------------------------------------------------

test("T12 #3a loop stops at COMPLEX_LOOP_MAX_ITERATIONS (3) when controller never declares sufficient", async () => {
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [makeRetrievalResult({ chunk: { id: "c-iter", documentId: "d-iter", content: `content`, childrenIds: [], metadata: {} } })],
    unavailableChannels: [],
  })
  // Controller always returns a non-duplicate tool call, never sufficient.
  // The loop runs 3 iterations (the ceiling), each with a unique query.
  const controller = makeFakeComplexLoopController([
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "iter-1" } },
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "iter-2" } },
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "iter-3" } },
  ])
  const evidence = buildEvidence([makeRetrievalResult()])
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    complexLoopController: controller,
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.routeTrace.complexLoopIterations, 3, "loop must stop at 3 iterations")
  assert.equal(output.routeTrace.complexLoopStopReason, "iteration-budget", "stop reason must be iteration-budget")
  assert.equal(output.routeTrace.complexLoopToolCalls, 3, "3 tool calls (one per iteration, no duplicates)")
})

test("T12 #3b correction round shares budget with initial run (T09 §13 reuse)", async () => {
  // Initial run: 2 iterations, 1 tool call, evidence-sufficient.
  // Then validator fails, replanner produces 1 gap query.
  // Correction round: reuses runComplexLoop with remainingIterations=1,
  // remainingToolCalls=3, priorToolCalls=[initial call].
  const searcher = makeFakeSearcher([
    // Initial loop call (1 tool call)
    { status: "ok", results: [makeRetrievalResult({ chunk: { id: "c-init", documentId: "d-init", content: "initial", childrenIds: [], metadata: {} } })], unavailableChannels: [] },
    // Correction loop call (1 tool call — different query to avoid dedup)
    { status: "ok", results: [makeRetrievalResult({ chunk: { id: "c-corr", documentId: "d-corr", content: "correction", childrenIds: [], metadata: {} } })], unavailableChannels: [] },
  ])
  const controller = makeFakeComplexLoopController([
    // Initial run: 1 tool call then sufficient
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "initial-query" } },
    { sufficient: true },
    // Correction round: 1 tool call then sufficient (different query to avoid dedup)
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "correction-query" } },
    { sufficient: true },
  ])
  // Validator: round 0 fails → replan → round 1 passes
  const validator = makeFakeValidator([
    { passed: false, hallucination: false, completeness: false },
    { passed: true, hallucination: false, completeness: true },
  ])
  const replanner = makeFakeRePlanner([[{ text: "gap-query-1" }]])
  const evidence = buildEvidence([
    makeRetrievalResult({ chunk: { id: "c-init", documentId: "d-init", content: "initial", childrenIds: [], metadata: {} } }),
    makeRetrievalResult({ chunk: { id: "c-corr", documentId: "d-corr", content: "correction", childrenIds: [], metadata: {} } }),
  ])
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator,
    replanner,
    streamAnswerDraft: makeScriptedDraftStream([
      buildCitedAnswer(buildEvidence([makeRetrievalResult({ chunk: { id: "c-init", documentId: "d-init", content: "initial", childrenIds: [], metadata: {} } })])),
      buildCitedAnswer(evidence),
    ]),
    complexLoopController: controller,
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed", "correction round must converge to completed")
  assert.equal(output.validationTrace.round, 2, "validation passed on round 2")
  // The correction round ran runComplexLoop with reduced budgets.
  // Initial loop: 2 decide calls (1 tool + sufficient) → iterationsExecuted=2.
  // sharedRemainingIterations = max(0, 3 - 2) = 1 → correction loop can make
  // only 1 decide call (the iteration budget is consumed before the second
  // `sufficient` decision would be requested). Total = 2 + 1 = 3.
  // The 3rd call proves correction used runComplexLoop (legacy path doesn't
  // call controller.decide at all).
  assert.equal(
    controller.decideCalls.length,
    3,
    "controller.decide called for initial (2) + correction (1) rounds — sharedRemainingIterations=1 caps correction to 1 decide call"
  )
})

// ---------------------------------------------------------------------------
// T12 #4 — Correction rounds rebuild one coherent candidate from all
// accumulated authorized Evidence
// ---------------------------------------------------------------------------

test("T12 #4 correction round accumulates results and regenerates draft from rebuilt context", async () => {
  const initialResult = makeRetrievalResult({ chunk: { id: "c-init", documentId: "d-init", content: "initial evidence", childrenIds: [], metadata: {} } })
  const correctionResult = makeRetrievalResult({ chunk: { id: "c-corr", documentId: "d-corr", content: "correction evidence", childrenIds: [], metadata: {} } })
  const searcher = makeFakeSearcher([
    // Initial retrieval (planner path: 1 sub-query)
    { status: "ok", results: [initialResult], unavailableChannels: [] },
    // Correction retrieval (1 gap query)
    { status: "ok", results: [correctionResult], unavailableChannels: [] },
  ])
  const subQueries: Query[] = [{ text: "initial sub-query" }]
  const planner = makeFakePlanner({ queries: subQueries })
  // Validator: round 0 fails → replan → round 1 passes
  const validator = makeFakeValidator([
    { passed: false, hallucination: false, completeness: false },
    { passed: true, hallucination: false, completeness: true },
  ])
  const replanner = makeFakeRePlanner([[{ text: "gap-query" }]])
  // Draft stream: initial draft (cites initial evidence) + regen draft (cites both)
  const initialEvidence = buildEvidence([initialResult])
  const bothEvidence = buildEvidence([initialResult, correctionResult])
  const draftStream = makeScriptedDraftStream([
    buildCitedAnswer(initialEvidence),
    buildCitedAnswer(bothEvidence),
  ])
  let draftCallCount = 0
  const wrappedDraftStream = (messages: AgentMessage[], signal: AbortSignal) => {
    draftCallCount += 1
    return draftStream(messages, signal)
  }
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator,
    replanner,
    streamAnswerDraft: wrappedDraftStream,
    planner,
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed", "correction must converge to completed")
  assert.equal(draftCallCount, 2, "draft stream called twice (initial + regen)")
  assert.equal(searcher.calls.length, 2, "searcher called twice (initial + correction)")
  // The final reply must cite evidence from the accumulated set.
  assert.ok(output.references.length > 0, "final references must be non-empty")
})

// ---------------------------------------------------------------------------
// T12 #5 — Duplicate or malformed tool calls fail safely and use the
// approved deterministic fallback
// ---------------------------------------------------------------------------

test("T12 #5a duplicate tool call is skipped without backend execution", async () => {
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [makeRetrievalResult({ chunk: { id: "c-dup", documentId: "d-dup", content: "content", childrenIds: [], metadata: {} } })],
    unavailableChannels: [],
  })
  // Controller returns the SAME tool+args on the second iteration → duplicate.
  // Third iteration declares sufficient.
  const controller = makeFakeComplexLoopController([
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "same-query" } },
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "same-query" } },
    { sufficient: true },
  ])
  const evidence = buildEvidence([makeRetrievalResult({ chunk: { id: "c-dup", documentId: "d-dup", content: "content", childrenIds: [], metadata: {} } })])
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    complexLoopController: controller,
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed")
  assert.equal(output.routeTrace.complexLoopIterations, 3, "3 iterations (decide + dup-decide + sufficient)")
  assert.equal(output.routeTrace.complexLoopToolCalls, 1, "only 1 tool call executed (duplicate skipped)")
  assert.equal(searcher.calls.length, 1, "searcher.search called only once (duplicate not executed)")
})

test("T12 #5b correction loop 0 new results → deterministic searcher.search fallback", async () => {
  // Initial run: 1 tool call, evidence-sufficient.
  // Validator fails → replan → 1 gap query.
  // Correction loop: controller declares sufficient immediately (0 new results, non-fallback stop).
  // Wait — the runner's deterministic-fallback condition is:
  //   results.length === 0 && stopReason !== "evidence-sufficient"
  // So if the correction loop returns evidence-sufficient with 0 results,
  // NO deterministic fallback runs. We need a different stopReason.
  // Use iteration-budget with 0 results → deterministic fallback fires.
  const initialResult = makeRetrievalResult({ chunk: { id: "c-init", documentId: "d-init", content: "initial", childrenIds: [], metadata: {} } })
  const fallbackResult = makeRetrievalResult({ chunk: { id: "c-fb", documentId: "d-fb", content: "fallback", childrenIds: [], metadata: {} } })
  const searcher = makeFakeSearcher([
    // Initial loop call (1 tool call, returns initialResult)
    { status: "ok", results: [initialResult], unavailableChannels: [] },
    // Correction loop call: controller declares sufficient immediately,
    // so 0 tool calls, 0 results. Then deterministic fallback fires →
    // searcher.search(gapQuery) returns fallbackResult.
    { status: "ok", results: [fallbackResult], unavailableChannels: [] },
  ])
  // Controller: initial run (1 call + sufficient), correction (sufficient immediately).
  // Correction returns evidence-sufficient with 0 results → NOT a fallback case.
  // To trigger fallback, use iteration-budget stop with 0 results.
  // But iteration-budget requires 3 iterations with no sufficient. Let's do that.
  const controller = makeFakeComplexLoopController([
    // Initial: 1 call + sufficient
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "initial-q" } },
    { sufficient: true },
    // Correction: 3 iterations, no tool calls (all duplicates of initial)
    // → iteration-budget stop, 0 results → deterministic fallback fires.
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "initial-q" } }, // duplicate
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "initial-q" } }, // duplicate
    { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "initial-q" } }, // duplicate
  ])
  const validator = makeFakeValidator([
    { passed: false, hallucination: false, completeness: false },
    { passed: true, hallucination: false, completeness: true },
  ])
  const replanner = makeFakeRePlanner([[{ text: "gap-query" }]])
  const evidence = buildEvidence([initialResult, fallbackResult])
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator,
    replanner,
    streamAnswerDraft: makeScriptedDraftStream([
      buildCitedAnswer(buildEvidence([initialResult])),
      buildCitedAnswer(evidence),
    ]),
    complexLoopController: controller,
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed", "deterministic fallback must yield new evidence → completed")
  // searcher.calls: [0]=initial loop, [1]=deterministic fallback
  assert.ok(searcher.calls.length >= 2, "deterministic fallback must call searcher.search")
})

// ---------------------------------------------------------------------------
// T12 #6 — Cancellation stops active tools and prevents late observations,
// drafts, or answers
// ---------------------------------------------------------------------------

test("T12 #6a abort before route → throws AbortError", async () => {
  const ac = new AbortController()
  ac.abort()
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => makeFakeSearcher({ status: "ok", results: [makeRetrievalResult()], unavailableChannels: [] }),
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["reply"]),
    complexLoopController: makeFakeComplexLoopController([{ sufficient: true }]),
  })
  await assert.rejects(
    () => runner(makeRunnerInput({ signal: ac.signal })),
    (err: unknown) => {
      assert.equal((err as Error).name, "AbortError", "pre-route abort must surface as AbortError")
      return true
    }
  )
})

test("T12 #6b abort during draft stream → throws AbortError", async () => {
  const ac = new AbortController()
  const result = makeRetrievalResult()
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [result],
    unavailableChannels: [],
  })
  // Abort right after the loop returns (before draft stream completes).
  // Use an aborting draft stream to simulate mid-stream abort.
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeAbortingDraftStream(0),
    complexLoopController: makeFakeComplexLoopController([
      { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "q" } },
      { sufficient: true },
    ]),
  })
  // The abort signal is not aborted upfront; the draft stream itself throws.
  await assert.rejects(
    () => runner(makeRunnerInput({ signal: ac.signal })),
    (err: unknown) => {
      assert.equal((err as Error).name, "AbortError", "mid-stream abort must surface as AbortError")
      return true
    }
  )
})

// ---------------------------------------------------------------------------
// T12 #7 — Every path converges to one existing compatible terminal event
// ---------------------------------------------------------------------------

test("T12 #7a happy path (loop) → completed", async () => {
  const result = makeRetrievalResult()
  const searcher = makeFakeSearcher({ status: "ok", results: [result], unavailableChannels: [] })
  const evidence = buildEvidence([result])
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    complexLoopController: makeFakeComplexLoopController([
      { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "q" } },
      { sufficient: true },
    ]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed", "happy path (loop) must reach completed")
  assert.equal(output.routeTrace.decision, "complex")
  assert.ok(output.references.length > 0, "must have references")
  assert.ok(output.tokens.length > 0, "must collect tokens")
})

test("T12 #7b happy path (planner) → completed", async () => {
  const result = makeRetrievalResult()
  const searcher = makeFakeSearcher({ status: "ok", results: [result], unavailableChannels: [] })
  const evidence = buildEvidence([result])
  const planner = makeFakePlanner({ queries: [{ text: "sub-q" }] })
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    planner,
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed", "happy path (planner) must reach completed")
  assert.equal(output.routeTrace.decision, "complex")
  assert.equal(output.routeTrace.queryCount, 1, "planner path records queryCount")
})

test("T12 #7c insufficient retrieval (loop 0 results) → insufficient_retrieval", async () => {
  const searcher = makeFakeSearcher({ status: "ok", results: [], unavailableChannels: [] })
  // Controller: 1 tool call returning 0 results, then sufficient (loop ends with 0 results).
  // 0 results + evidence-sufficient → loop ends, but retrievalAvailable=false → insufficient_retrieval.
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["reply"]),
    complexLoopController: makeFakeComplexLoopController([
      { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "q" } },
      { sufficient: true },
    ]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "insufficient_retrieval", "0 results → insufficient_retrieval (T12 #7)")
})

test("T12 #7d unknown citation in initial draft → invalid_citation", async () => {
  const result = makeRetrievalResult()
  const searcher = makeFakeSearcher({ status: "ok", results: [result], unavailableChannels: [] })
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    // Draft with UNKNOWN citation → referencesForReply throws (evidence.ts L166)
    // → caught at complex_knowledge_runner.ts L977-1004 → invalid_citation.
    // Mirrors T11 #4 pattern. Note: a draft with NO [cite:xxx] markers does
    // NOT throw (returns empty references) → that case is handled by the
    // final citation check at L1454-1483 as insufficient_evidence.
    streamAnswerDraft: makeScriptedDraftStream(["answer with [cite:unknown-id]"]),
    complexLoopController: makeFakeComplexLoopController([
      { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "q" } },
      { sufficient: true },
    ]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "invalid_citation", "unknown citation → invalid_citation (T12 #7)")
  assert.equal(output.degradation.reason, "no_cited_claims")
  assert.deepEqual(output.tokens, [], "invalid-citation Draft tokens must be withheld")
})

test("T12 #7e validation exhausted with handoff → handoff_required", async () => {
  const result = makeRetrievalResult()
  const searcher = makeFakeSearcher({ status: "ok", results: [result], unavailableChannels: [] })
  const evidence = buildEvidence([result])
  const handoffStore = makeFakeHandoffStore()
  // Validator always fails → 3 rounds exhausted. Replanner returns gap queries
  // but correction retrieval returns 0 new results → handoff_required.
  const validator = makeFakeValidator({ passed: false, hallucination: false, completeness: false })
  const replanner = makeFakeRePlanner([[{ text: "gap-q-1" }]])
  const searcherWithEmptyCorrection = makeFakeSearcher([
    { status: "ok", results: [result], unavailableChannels: [] }, // initial
    { status: "ok", results: [], unavailableChannels: [] }, // correction (0 new)
  ])
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcherWithEmptyCorrection,
    assembler: makeFakeAssembler(),
    validator,
    replanner,
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    handoffStore,
    resolveTenantId: (ctx) => ctx.tenantId,
    complexLoopController: makeFakeComplexLoopController([
      { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "q" } },
      { sufficient: true },
    ]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "handoff_required", "exhausted + handoffStore → handoff_required (T12 #7)")
  assert.equal(handoffStore.createdCases.length, 1, "handoff case must be created")
})

test("T12 #7f validation exhausted without handoff → insufficient_evidence", async () => {
  const result = makeRetrievalResult()
  const searcher = makeFakeSearcher([
    { status: "ok", results: [result], unavailableChannels: [] }, // initial
    { status: "ok", results: [], unavailableChannels: [] }, // correction (0 new)
  ])
  const evidence = buildEvidence([result])
  // No handoffStore → insufficient_evidence
  const validator = makeFakeValidator({ passed: false, hallucination: false, completeness: false })
  const replanner = makeFakeRePlanner([[{ text: "gap-q-1" }]])
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator,
    replanner,
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    complexLoopController: makeFakeComplexLoopController([
      { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "q" } },
      { sufficient: true },
    ]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "insufficient_evidence", "exhausted without handoff → insufficient_evidence (T12 #7)")
  assert.equal(output.degradation.reason, "coverage_not_met")
})

test("T12 #7g provider failure in loop → provider_error", async () => {
  // searcher.search throws a non-Abort error → loop stops with provider-failure.
  const searcher: Searcher = {
    async search(): Promise<SearchOutcome> {
      throw new Error("Elasticsearch down")
    },
  }
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["reply"]),
    complexLoopController: makeFakeComplexLoopController([
      { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "q" } },
    ]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "provider_error", "loop provider failure → provider_error (T12 #7)")
  assert.equal(output.routeTrace.complexLoopStopReason, "provider-failure")
})

test("T12 #7h RouteNotComplexError for non-complex routes", async () => {
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => makeFakeSearcher({ status: "ok", results: [makeRetrievalResult()], unavailableChannels: [] }),
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["reply"]),
  })
  await assert.rejects(
    () => runner(makeRunnerInput()),
    (err: unknown) => {
      assert.ok(err instanceof RouteNotComplexError, "non-complex route → RouteNotComplexError")
      assert.equal((err as RouteNotComplexError).decision, "simple")
      return true
    }
  )
})

test("T12 #7i no planner AND no controller → provider_error", async () => {
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => makeFakeSearcher({ status: "ok", results: [makeRetrievalResult()], unavailableChannels: [] }),
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["reply"]),
    // Neither planner nor complexLoopController wired
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "provider_error", "no planner + no controller → provider_error (T12 #7)")
})

test("T12 #7j conversation memory: validated turns saved only on completed", async () => {
  const result = makeRetrievalResult()
  const searcher = makeFakeSearcher({ status: "ok", results: [result], unavailableChannels: [] })
  const evidence = buildEvidence([result])
  const conversationStore = makeFakeConversationStore()
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    conversationStore,
    resolveTenantId: (ctx) => ctx.tenantId,
    complexLoopController: makeFakeComplexLoopController([
      { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "q" } },
      { sufficient: true },
    ]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed")
  assert.equal(conversationStore.validatedTurns.length, 2, "user + assistant turn saved on completed (T10 #2)")
  assert.equal(conversationStore.validatedTurns[0].role, "user")
  assert.equal(conversationStore.validatedTurns[1].role, "assistant")
})

test("P1 regression: abort during post-persistence summarization keeps complex completion authoritative", async () => {
  const result = makeRetrievalResult()
  const evidence = buildEvidence([result])
  const conversationStore = makeFakeConversationStore({
    totalValidatedTurnCount: 13,
    oldestRecentTurnId: 14,
  })
  conversationStore.loadOlderTurnsForSummarization = () => [{
    sessionId: "sess-test-001",
    tenantId: "tenant-test",
    role: "user",
    content: "older fact",
    runId: "older-run",
    createdAt: "2026-07-01T00:00:00.000Z",
  }]
  const controller = new AbortController()
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => makeFakeSearcher({ status: "ok", results: [result], unavailableChannels: [] }),
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    conversationStore,
    resolveTenantId: (ctx) => ctx.tenantId,
    summarizer: {
      async summarize() {
        controller.abort()
        const error = new Error("summary aborted")
        error.name = "AbortError"
        throw error
      },
    },
    complexLoopController: makeFakeComplexLoopController([
      { sufficient: false, tool: "semantic_lexical_hybrid", args: { query: "q" } },
      { sufficient: true },
    ]),
  })

  const output = await runner(makeRunnerInput({ signal: controller.signal }))
  assert.equal(output.status, "completed")
  assert.equal(output.summarizationOutcome, "failed")
  assert.equal(conversationStore.validatedTurns.length, 2)
})

test("T12 #7k planner path: PlannerError → provider_error", async () => {
  const searcher = makeFakeSearcher({ status: "ok", results: [makeRetrievalResult()], unavailableChannels: [] })
  // Planner whose decompose throws a real PlannerError instance.
  // The runner catches `instanceof PlannerError` at L684 → provider_error.
  // Using a plain Error with name="PlannerError" would NOT match instanceof.
  const planner: Planner = {
    async decompose(): Promise<DecomposeResult> {
      throw new PlannerError("decompose failed", "decompose")
    },
    async rewrite(): Promise<RewriteResult> { return { query: { text: "q" } } },
    async navigate(): Promise<string[]> { return [] },
    async generateHypothesis(): Promise<HypothesisResult> { return { text: "" } },
  }
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["reply"]),
    planner,
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "provider_error", "PlannerError → provider_error (T12 #7)")
})

test("P1 regression: a non-complex runner does not consume pending clarification", async () => {
  const conversationStore = makeFakeConversationStore()
  const runner = createComplexKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => makeFakeSearcher({ status: "ok", results: [], unavailableChannels: [] }),
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["unused"]),
    conversationStore,
    resolveTenantId: (ctx) => ctx.tenantId,
  })

  await assert.rejects(() => runner(makeRunnerInput()), RouteNotComplexError)
  assert.equal(
    conversationStore.pendingClarificationConsumed.length,
    0,
    "route ownership must be confirmed before destructive clarification consumption"
  )
})
