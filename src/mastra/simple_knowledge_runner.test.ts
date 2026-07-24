/**
 * Ticket 11 — Simple knowledge route Mastra runner tests.
 *
 * TDD test suite for `src/mastra/simple_knowledge_runner.ts`. Verifies the
 * MastraRunner contract for the simple knowledge route: retrieval → Evidence
 * → Context → answer Draft → Citation check → Critic validation loop →
 * publish / handoff.
 *
 * Coverage map (T11 acceptance criteria):
 *   #1 Mastra delegates retrieval to existing Access Context-aware service
 *      → happy path test (searcher.search receives accessContext)
 *   #2 Retrieved results become same stable Evidence + bounded Context
 *      → happy path test (evidence built from results, context assembled)
 *   #3 Cannot complete without usable Evidence + valid Citation
 *      → empty evidence tests + no cited claims test
 *   #4 Unknown Citations + failed Critic rejected before publication
 *      → invalid_citation test + validation loop tests (replan exhausted,
 *         correction + regeneration, 3 rounds expired)
 *   #5 Retrieval/model/validation/cancellation failures → terminal statuses
 *      → insufficient_retrieval test + abort tests
 *   #6 Answer event/SSE/JSON/replay/Conversation/Handoff/Trace compatible
 *      → trace data test + save validated turns test + handoff creation test
 *   #7 Runtime rollback returns route to legacy orchestrator
 *      → RouteNotSimpleError test
 *
 * Boundary: this test file is owned by `src/mastra/*` and MUST NOT import
 * `src/api/*` or `src/index` (T02 #5 dependency direction).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createSimpleKnowledgeMastraRunner,
  RouteNotSimpleError,
} from "./simple_knowledge_runner"
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
  ConversationStore,
  ConversationTurn,
  ConversationMemory,
} from "../answer/conversation_store"
import type { HandoffStore } from "../answer/handoff_store"
import type { AccessContext } from "../access/context"
import type {
  Query,
  RetrievalResult,
  RouterDecision,
  CriticVerdict,
  AgentMessage,
} from "../types"

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
// T11 #1 — Mastra delegates retrieval to existing Access Context-aware service
// ---------------------------------------------------------------------------

test("T11 #1 happy path: retrieval success + validation pass → completed", async () => {
  const result = makeRetrievalResult()
  const evidence = buildEvidence([result])
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [result],
    unavailableChannels: [],
  })
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed", "happy path must reach completed")
  assert.equal(output.routeTrace.decision, "simple")
  assert.ok(output.reply.length > 0, "reply must be non-empty")
  assert.ok(output.references.length > 0, "must have at least one reference (T11 #3)")
  assert.ok(output.tokens.length > 0, "tokens must be collected from draft stream")
})

test("P1 regression: early simple terminal preserves the complete prepared route trace", async () => {
  const preparedTrace = {
    decision: "simple" as const,
    contextualizationOutcome: "failed" as const,
    contextualizationFailure: "context provider unavailable",
    contextualizationUsage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
    contextualizationDurationMs: 17,
  }
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => makeFakeSearcher({
      status: "ok",
      results: [],
      unavailableChannels: [],
    }),
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["unused"]),
  })

  const output = await runner(makeRunnerInput({
    preparedRoute: {
      decision: "simple",
      effectiveMessage: "effective",
      contextualizedQuery: "contextualized",
      routeTrace: preparedTrace,
    },
  }))

  assert.equal(output.status, "insufficient_evidence")
  assert.deepEqual(output.routeTrace, preparedTrace)
})

test("P1 regression: abort observed immediately before persistence writes no validated turns", async () => {
  const result = makeRetrievalResult()
  const evidence = buildEvidence([result])
  const conversationStore = makeFakeConversationStore()
  let armed = false
  let aborted = false
  const listeners = new Set<unknown>()
  const signal = {
    get aborted() { return aborted },
    addEventListener(_type: string, listener: unknown) {
      listeners.add(listener)
    },
    removeEventListener(_type: string, listener: unknown) {
      listeners.delete(listener)
      if (armed) aborted = true
    },
  } as unknown as AbortSignal
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => makeFakeSearcher({
      status: "ok",
      results: [result],
      unavailableChannels: [],
    }),
    assembler: makeFakeAssembler(),
    validator: {
      async validate(): Promise<CriticVerdict> {
        armed = true
        return { passed: true, hallucination: false, completeness: true }
      },
    },
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    conversationStore,
  })

  await assert.rejects(
    () => runner(makeRunnerInput({ signal })),
    (error: unknown) => {
      assert.equal((error as Error).name, "AbortError")
      return true
    }
  )
  assert.equal(conversationStore.validatedTurns.length, 0)
})

test("P1 regression: abort during post-persistence summarization keeps simple completion authoritative", async () => {
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
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => makeFakeSearcher({
      status: "ok",
      results: [result],
      unavailableChannels: [],
    }),
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
  })

  const output = await runner(makeRunnerInput({ signal: controller.signal }))
  assert.equal(output.status, "completed")
  assert.equal(output.summarizationOutcome, "failed")
  assert.equal(conversationStore.validatedTurns.length, 2)
})

test("T11 #1 accessContext propagated to searcher.search", async () => {
  const accessContext = makeAccessContext("tenant-xyz")
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [makeRetrievalResult()],
    unavailableChannels: [],
  })
  const evidence = buildEvidence([makeRetrievalResult()])
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
  })
  await runner(makeRunnerInput({ accessContext }))
  assert.equal(
    searcher.calls[0].options?.accessContext,
    accessContext,
    "searcher.search must receive accessContext (T11 #1)"
  )
})

test("T11 #2 stable Evidence + bounded Context: evidence built + context assembled", async () => {
  const result1 = makeRetrievalResult({ chunk: { id: "c1", documentId: "d1", content: "content1", childrenIds: [], metadata: {} } })
  const result2 = makeRetrievalResult({ chunk: { id: "c2", documentId: "d2", content: "content2", childrenIds: [], metadata: {} }, source: "bm25" })
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [result1, result2],
    unavailableChannels: [],
  })
  let assembledResults: RetrievalResult[] | null = null
  const assembler: ContextAssembler = {
    async assemble(results: RetrievalResult[]): Promise<string> {
      assembledResults = results
      return "assembled context"
    },
  }
  const evidence = buildEvidence([result1, result2])
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler,
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
  })
  const output = await runner(makeRunnerInput())
  assert.ok(assembledResults !== null, "assembler.assemble must be called")
  assert.ok((assembledResults as RetrievalResult[] | null)!.length > 0, "assembler must receive results")
  assert.equal(output.contextTrace.evidenceCount, evidence.length, "contextTrace records evidence count")
  assert.equal(output.contextTrace.contextLength, "assembled context".length, "contextTrace records context length")
  assert.equal(output.retrievalTrace.selectedEvidenceIds?.length, evidence.length, "retrievalTrace records evidence ids")
})

// ---------------------------------------------------------------------------
// T11 #3 — Cannot complete without usable Evidence + valid Citation
// ---------------------------------------------------------------------------

test("T11 #3 empty retrieval results → insufficient_evidence (no_results)", async () => {
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [],
    unavailableChannels: [],
  })
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["reply"]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "insufficient_evidence", "empty results → insufficient_evidence (T11 #3)")
  assert.equal(output.degradation.reason, "no_results", "degradation reason must be no_results")
  assert.deepEqual(output.references, [], "no references without evidence")
})

test("T11 #3 validation passes but no cited claims → insufficient_evidence (no_cited_claims)", async () => {
  const result = makeRetrievalResult()
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [result],
    unavailableChannels: [],
  })
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    // Answer with NO citations → referencesForReply returns []
    streamAnswerDraft: makeScriptedDraftStream(["This is an answer without any citations."]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "insufficient_evidence", "no cited claims → insufficient_evidence (T11 #3)")
  assert.equal(output.degradation.reason, "no_cited_claims", "degradation reason must be no_cited_claims")
  assert.deepEqual(output.tokens, [], "rejected Draft tokens must never be publishable")
})

// ---------------------------------------------------------------------------
// T11 #4 — Unknown Citations + failed Critic rejected before publication
// ---------------------------------------------------------------------------

test("T11 #4 unknown citation in initial draft → invalid_citation", async () => {
  const result = makeRetrievalResult()
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [result],
    unavailableChannels: [],
  })
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    // Answer with UNKNOWN citation → referencesForReply throws
    streamAnswerDraft: makeScriptedDraftStream(["Answer with [cite:ev_unknown_id] citation."]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "invalid_citation", "unknown citation → invalid_citation (T11 #4)")
  assert.equal(output.reply, "", "invalid_citation reply must be empty (draft rejected)")
  assert.deepEqual(output.tokens, [], "invalid-citation Draft tokens must be withheld")
})

test("T11 #4 validation fail + replan exhausted → insufficient_evidence", async () => {
  const result = makeRetrievalResult()
  const evidence = buildEvidence([result])
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [result],
    unavailableChannels: [],
  })
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    // Validator fails on first round, passes never
    validator: makeFakeValidator([{ passed: false, hallucination: false, completeness: false, missingGap: "gap1" }]),
    // RePlanner returns empty gap queries → exhausted
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "insufficient_evidence", "validation fail + replan exhausted → insufficient_evidence (T11 #4)")
  assert.equal(output.degradation.reason, "coverage_not_met", "degradation reason must be coverage_not_met")
  assert.equal(output.validationTrace.passed, false, "validationTrace records failure")
  assert.deepEqual(output.tokens, [], "failed-validation Draft tokens must be withheld")
})

test("T11 #4 validation fail + replan exhausted + handoffStore → handoff_required", async () => {
  const result = makeRetrievalResult()
  const evidence = buildEvidence([result])
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [result],
    unavailableChannels: [],
  })
  const handoffStore = makeFakeHandoffStore()
  const conversationStore = makeFakeConversationStore()
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator([{ passed: false, hallucination: false, completeness: false, missingGap: "gap1" }]),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    conversationStore,
    handoffStore,
    resolveTenantId: (ctx) => ctx.tenantId,
  })
  const input = makeRunnerInput()
  const output = await runner(input)
  assert.equal(output.status, "handoff_required", "handoff enabled + exhausted → handoff_required (T11 #4/#6)")
  assert.equal(handoffStore.createdCases.length, 1, "handoffStore.create must be called once")
  assert.equal(handoffStore.createdCases[0].runId, input.runId, "handoff case records runId")
  assert.equal(handoffStore.createdCases[0].tenantId, input.accessContext.tenantId, "handoff case records tenantId")
  assert.equal(handoffStore.createdCases[0].subjectId, input.accessContext.subjectId, "handoff case records subjectId")
  assert.equal(handoffStore.createdCases[0].reasonCode, "insufficient_evidence", "handoff reason must be insufficient_evidence")
  assert.ok(handoffStore.createdCases[0].evidenceIds.length > 0, "handoff case records evidence ids")
})

test("T11 #4 validation fail + correction retrieval + regeneration + pass → completed", async () => {
  const result1 = makeRetrievalResult({ chunk: { id: "c1", documentId: "d1", content: "content1", childrenIds: [], metadata: {} } })
  const result2 = makeRetrievalResult({ chunk: { id: "c2", documentId: "d2", content: "content2", childrenIds: [], metadata: {} } })
  const evidence1 = buildEvidence([result1])
  const evidence2 = buildEvidence([result1, result2])
  // searcher returns different results on each call:
  // call 0 (initial): [result1]
  // call 1 (correction): [result2]
  const searcher = makeFakeSearcher([
    { status: "ok", results: [result1], unavailableChannels: [] },
    { status: "ok", results: [result2], unavailableChannels: [] },
  ])
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    // Validator fails on round 1, passes on round 2
    validator: makeFakeValidator([
      { passed: false, hallucination: false, completeness: false, missingGap: "gap1" },
      { passed: true, hallucination: false, completeness: true },
    ]),
    // RePlanner returns one gap query
    replanner: makeFakeRePlanner([{ text: "gap query 1" }]),
    // Draft stream: call 0 returns answer citing evidence1, call 1 returns answer citing evidence2
    streamAnswerDraft: makeScriptedDraftStream([
      buildCitedAnswer(evidence1),
      buildCitedAnswer(evidence2),
    ]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "completed", "correction + regeneration + pass → completed (T11 #4)")
  assert.equal(output.validationTrace.round, 2, "must reach round 2")
  assert.equal(output.validationTrace.passed, true, "round 2 must pass")
  assert.equal(searcher.calls.length, 2, "searcher called twice (initial + correction)")
})

test("T11 #4 3 rounds expired without approval → insufficient_evidence", async () => {
  const result = makeRetrievalResult()
  const evidence = buildEvidence([result])
  const searcher = makeFakeSearcher([
    { status: "ok", results: [result], unavailableChannels: [] },
    { status: "ok", results: [makeRetrievalResult({ chunk: { id: "c2", documentId: "d2", content: "c2", childrenIds: [], metadata: {} } })], unavailableChannels: [] },
    { status: "ok", results: [makeRetrievalResult({ chunk: { id: "c3", documentId: "d3", content: "c3", childrenIds: [], metadata: {} } })], unavailableChannels: [] },
  ])
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    // Validator always fails
    validator: makeFakeValidator([{ passed: false, hallucination: false, completeness: false, missingGap: "gap" }]),
    // RePlanner returns distinct gap queries for rounds 0+1, then a repeat on
    // round 2. Round 2 fail → replan returns the repeat → dedupe filters it
    // out → gapQueries exhausted → break with validationTrace.round = 3
    // (round index 2 + 1). This exercises the "3 rounds expired" path.
    replanner: makeFakeRePlanner([
      [{ text: "gap query 1" }],
      [{ text: "gap query 2" }],
      [{ text: "gap query 1" }],
    ]),
    streamAnswerDraft: makeScriptedDraftStream([
      buildCitedAnswer(evidence),
      buildCitedAnswer(evidence),
      buildCitedAnswer(evidence),
    ]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "insufficient_evidence", "3 rounds expired → insufficient_evidence (T11 #4)")
  assert.equal(output.validationTrace.round, 3, "must reach round 3")
  assert.equal(output.validationTrace.passed, false, "round 3 must fail")
})

// ---------------------------------------------------------------------------
// T11 #5 — Retrieval/model/validation/cancellation failures → terminal statuses
// ---------------------------------------------------------------------------

test("T11 #5 insufficient retrieval (all channels unavailable) → insufficient_retrieval", async () => {
  const searcher = makeFakeSearcher({
    status: "insufficient",
    results: [],
    unavailableChannels: ["vector", "bm25", "graph"],
  })
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["reply"]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.status, "insufficient_retrieval", "all channels unavailable → insufficient_retrieval (T11 #5)")
  assert.ok(output.reply.includes("检索服务暂时不可用"), "reply must contain insufficient retrieval message")
})

test("T11 #5 abort before route → AbortError", async () => {
  const abortController = new AbortController()
  abortController.abort()
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => makeFakeSearcher({ status: "ok", results: [], unavailableChannels: [] }),
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["reply"]),
  })
  await assert.rejects(
    () => runner(makeRunnerInput({ signal: abortController.signal })),
    (err: Error) => err.name === "AbortError",
    "pre-route abort must throw AbortError (T11 #5)"
  )
})

test("T11 #5 abort during retrieval → AbortError", async () => {
  const abortingSearcher: Searcher = {
    async search(): Promise<SearchOutcome> {
      const err = new Error("Retrieval aborted")
      err.name = "AbortError"
      throw err
    },
  }
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => abortingSearcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["reply"]),
  })
  await assert.rejects(
    () => runner(makeRunnerInput()),
    (err: Error) => err.name === "AbortError",
    "retrieval abort must throw AbortError (T11 #5)"
  )
})

test("T11 #5 abort during draft stream → AbortError", async () => {
  const result = makeRetrievalResult()
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [result],
    unavailableChannels: [],
  })
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeAbortingDraftStream(0),
  })
  await assert.rejects(
    () => runner(makeRunnerInput()),
    (err: Error) => err.name === "AbortError",
    "draft stream abort must throw AbortError (T11 #5)"
  )
})

// ---------------------------------------------------------------------------
// T11 #6 — Answer event/SSE/JSON/replay/Conversation/Handoff/Trace compatible
// ---------------------------------------------------------------------------

test("T11 #6 trace data populated: routeTrace/retrievalTrace/contextTrace/validationTrace", async () => {
  const result = makeRetrievalResult()
  const evidence = buildEvidence([result])
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [result],
    unavailableChannels: [],
  })
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler("context content here"),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
  })
  const output = await runner(makeRunnerInput())
  assert.equal(output.routeTrace.decision, "simple", "routeTrace.decision must be simple")
  assert.ok(output.retrievalTrace.resultCount !== undefined, "retrievalTrace.resultCount must be set")
  assert.ok(output.retrievalTrace.channelStatuses !== undefined, "retrievalTrace.channelStatuses must be set")
  assert.ok(output.retrievalTrace.selectedEvidenceIds !== undefined, "retrievalTrace.selectedEvidenceIds must be set")
  assert.equal(output.contextTrace.evidenceCount, evidence.length, "contextTrace.evidenceCount must be set")
  assert.equal(output.contextTrace.contextLength, "context content here".length, "contextTrace.contextLength must be set")
  assert.equal(output.validationTrace.round, 1, "validationTrace.round must be 1 (first round passed)")
  assert.equal(output.validationTrace.passed, true, "validationTrace.passed must be true")
})

test("T11 #6 save validated turns on completed (T10 #2 invariant)", async () => {
  const result = makeRetrievalResult()
  const evidence = buildEvidence([result])
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [result],
    unavailableChannels: [],
  })
  const conversationStore = makeFakeConversationStore()
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    conversationStore,
    resolveTenantId: (ctx) => ctx.tenantId,
  })
  const input = makeRunnerInput({ message: "What is the return policy?" })
  await runner(input)
  assert.equal(conversationStore.validatedTurns.length, 2, "must save user + assistant turns (T10 #2)")
  assert.equal(conversationStore.validatedTurns[0].role, "user", "first turn is user")
  assert.equal(conversationStore.validatedTurns[0].content, input.message, "user turn content is raw input.message")
  assert.equal(conversationStore.validatedTurns[1].role, "assistant", "second turn is assistant")
  assert.ok(conversationStore.validatedTurns[1].content.length > 0, "assistant turn content is the reply")
  assert.equal(conversationStore.validatedTurns[0].runId, input.runId, "turns record runId")
  assert.equal(conversationStore.validatedTurns[0].sessionId, input.sessionId, "turns record sessionId")
  assert.equal(conversationStore.validatedTurns[0].tenantId, input.accessContext.tenantId, "turns record tenantId")
})

test("T11 #6 NO save validated turns on non-completed (T10 #2 invariant)", async () => {
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [],
    unavailableChannels: [],
  })
  const conversationStore = makeFakeConversationStore()
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["reply"]),
    conversationStore,
    resolveTenantId: (ctx) => ctx.tenantId,
  })
  await runner(makeRunnerInput())
  assert.equal(conversationStore.validatedTurns.length, 0, "must NOT save turns on insufficient_evidence (T10 #2)")
})

test("T11 #6 memory loading + pending clarification consumption", async () => {
  const result = makeRetrievalResult()
  const evidence = buildEvidence([result])
  const searcher = makeFakeSearcher({
    status: "ok",
    results: [result],
    unavailableChannels: [],
  })
  const conversationStore = makeFakeConversationStore({
    recentTurns: [
      { sessionId: "s1", tenantId: "t1", role: "user", content: "previous question", runId: "r1", createdAt: "2026-01-01T00:00:00Z" },
      { sessionId: "s1", tenantId: "t1", role: "assistant", content: "previous answer", runId: "r1", createdAt: "2026-01-01T00:00:00Z" },
    ],
  })
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream([buildCitedAnswer(evidence)]),
    conversationStore,
    resolveTenantId: (ctx) => ctx.tenantId,
  })
  const input = makeRunnerInput()
  await runner(input)
  assert.ok(conversationStore.loadMemoryCalls.length > 0, "loadConversationMemory must be called")
  assert.equal(conversationStore.loadMemoryCalls[0].sessionId, input.sessionId, "loadMemory called with correct sessionId")
  assert.equal(conversationStore.loadMemoryCalls[0].tenantId, input.accessContext.tenantId, "loadMemory called with correct tenantId")
  assert.ok(conversationStore.pendingClarificationConsumed.length > 0, "consumePendingClarification must be called")
})

// ---------------------------------------------------------------------------
// T11 #7 — Runtime rollback returns route to legacy orchestrator
// ---------------------------------------------------------------------------

test("T11 #7 route not simple (direct) → RouteNotSimpleError", async () => {
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("direct"),
    createSearcher: () => makeFakeSearcher({ status: "ok", results: [], unavailableChannels: [] }),
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["reply"]),
  })
  await assert.rejects(
    () => runner(makeRunnerInput()),
    (err) => err instanceof RouteNotSimpleError,
    "direct route must throw RouteNotSimpleError (T11 #7)"
  )
})

test("T11 #7 route not simple (complex) → RouteNotSimpleError", async () => {
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("complex"),
    createSearcher: () => makeFakeSearcher({ status: "ok", results: [], unavailableChannels: [] }),
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["reply"]),
  })
  await assert.rejects(
    () => runner(makeRunnerInput()),
    (err) => err instanceof RouteNotSimpleError,
    "complex route must throw RouteNotSimpleError (T11 #7)"
  )
})

test("T11 #7 RouteNotSimpleError carries decision for dispatch layer", async () => {
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("ambiguous"),
    createSearcher: () => makeFakeSearcher({ status: "ok", results: [], unavailableChannels: [] }),
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["reply"]),
  })
  try {
    await runner(makeRunnerInput())
    assert.fail("should have thrown")
  } catch (err) {
    assert.ok(err instanceof RouteNotSimpleError)
    assert.equal((err as RouteNotSimpleError).decision, "ambiguous", "error carries decision for dispatch")
  }
})

test("P1 regression: a non-simple runner does not consume pending clarification", async () => {
  const conversationStore = makeFakeConversationStore()
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("direct"),
    createSearcher: () => makeFakeSearcher({ status: "ok", results: [], unavailableChannels: [] }),
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["unused"]),
    conversationStore,
    resolveTenantId: (ctx) => ctx.tenantId,
  })

  await assert.rejects(() => runner(makeRunnerInput()), RouteNotSimpleError)
  assert.equal(
    conversationStore.pendingClarificationConsumed.length,
    0,
    "route ownership must be confirmed before destructive clarification consumption"
  )
})

test("T11 #7 RouteNotSimpleError has correct name for boundary detection", async () => {
  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("direct"),
    createSearcher: () => makeFakeSearcher({ status: "ok", results: [], unavailableChannels: [] }),
    assembler: makeFakeAssembler(),
    validator: makeFakeValidator({ passed: true, hallucination: false, completeness: true }),
    replanner: makeFakeRePlanner([]),
    streamAnswerDraft: makeScriptedDraftStream(["reply"]),
  })
  try {
    await runner(makeRunnerInput())
    assert.fail("should have thrown")
  } catch (err) {
    assert.equal((err as Error).name, "RouteNotSimpleError", "error name must be RouteNotSimpleError")
  }
})
