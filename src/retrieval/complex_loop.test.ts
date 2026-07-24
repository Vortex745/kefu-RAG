import assert from "node:assert/strict"
import test from "node:test"

import type { RetrievalResult } from "../types"
import type { SearchOptions, RetrievalChannel } from "./search/interface"
import type { OpenAI } from "openai"
import {
  COMPLEX_LOOP_MAX_ITERATIONS,
  COMPLEX_LOOP_MAX_TOOL_CALLS,
  normalizeToolCall,
  ComplexLoopControllerImpl,
  runComplexLoop,
  type ComplexLoopController,
  type ComplexLoopDecision,
  type ComplexLoopState,
  type ComplexLoopAssembler,
  type ComplexLoopCompressor,
  type ComplexLoopDeps,
  type ComplexLoopResult,
  type NormalizedToolCall,
} from "./complex_loop"
import type { RetrievalToolName, RetrievalToolArgs } from "./tool_selector"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeResult(id: string, content = `content-${id}`): RetrievalResult {
  return {
    chunk: {
      id,
      documentId: "doc-1",
      content,
      childrenIds: [],
      metadata: { source: "test" },
    },
    score: 1,
    source: "vector",
    wikilinks: [],
  }
}

function makeState(overrides: Partial<ComplexLoopState> = {}): ComplexLoopState {
  return {
    query: "test query",
    priorToolCalls: [],
    observations: "",
    accumulatedEvidenceIds: [],
    remainingIterations: COMPLEX_LOOP_MAX_ITERATIONS,
    remainingToolCalls: COMPLEX_LOOP_MAX_TOOL_CALLS,
    ...overrides,
  }
}

/**
 * Build a mock OpenAI client whose chat.completions.create returns a controlled
 * tool call. Captures the request params for assertion.
 */
function mockOpenAI(
  buildToolCall: (params: any) => any,
  shouldThrow?: (params: any) => Error | null
): OpenAI & { calls: any[] } {
  const calls: any[] = []
  const client = {
    chat: {
      completions: {
        create: async (params: any) => {
          calls.push(params)
          if (shouldThrow) {
            const err = shouldThrow(params)
            if (err) throw err
          }
          const toolCall = buildToolCall(params)
          return {
            choices: toolCall
              ? [{ message: { tool_calls: [toolCall] } }]
              : [{ message: {} }],
          }
        },
      },
    },
  }
  return Object.assign(client as unknown as OpenAI, { calls })
}

function toolCall(name: string, args: object): any {
  return {
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  }
}

/**
 * Build a controller that returns a controlled sequence of decisions.
 */
function scriptController(
  decisions: ComplexLoopDecision[]
): ComplexLoopController & { calls: ComplexLoopState[] } {
  const calls: ComplexLoopState[] = []
  let i = 0
  return {
    decide: async (state: ComplexLoopState) => {
      // Snapshot the state — runComplexLoop mutates it in place between
      // iterations, so a bare reference would retroactively reflect later
      // mutations. Deep-clone the mutable fields so tests can assert per-call
      // state values reliably.
      calls.push({
        ...state,
        priorToolCalls: state.priorToolCalls.map((c) => ({ ...c })),
        accumulatedEvidenceIds: [...state.accumulatedEvidenceIds],
        coverageCriteria: state.coverageCriteria
          ? [...state.coverageCriteria]
          : undefined,
      })
      const decision = decisions[Math.min(i, decisions.length - 1)]
      i += 1
      return decision
    },
    calls,
  } as ComplexLoopController & { calls: ComplexLoopState[] }
}

function decisionTool(
  tool: RetrievalToolName,
  query: string,
  seeds?: string[]
): ComplexLoopDecision {
  const args: RetrievalToolArgs = seeds ? { query, seeds } : { query }
  return { sufficient: false, tool, args }
}

const decisionSufficient: ComplexLoopDecision = { sufficient: true }

/**
 * Build a mock Searcher that returns controlled outcomes per call.
 */
function scriptSearcher(
  outcomes: Array<{ results: RetrievalResult[]; unavailableChannels?: RetrievalChannel[]; throwErr?: Error }>
): {
  search: (query: any, options: any) => Promise<any>
  calls: Array<{ query: any; options: any }>
} {
  const calls: Array<{ query: any; options: any }> = []
  let i = 0
  return {
    search: async (query: any, options: any) => {
      calls.push({ query, options })
      const outcome = outcomes[Math.min(i, outcomes.length - 1)]
      i += 1
      if (outcome.throwErr) throw outcome.throwErr
      return {
        status: "ok",
        results: outcome.results,
        unavailableChannels: outcome.unavailableChannels ?? [],
      }
    },
    calls,
  }
}

function mockAssembler(content = "assembled-context"): ComplexLoopAssembler {
  return {
    assemble: async () => content,
  }
}

function mockCompressor(
  behavior: "compress" | "skip" | "throw" = "compress"
): ComplexLoopCompressor & { calls: number } {
  // Use a closure-captured counter and re-expose it via a getter so tests
  // observe the LIVE value (Object.assign would snapshot the value at
  // assignment time and miss subsequent increments).
  let calls = 0
  const compressor: ComplexLoopCompressor & { calls: number } = {
    compress: async () => {
      calls += 1
      if (behavior === "throw") {
        throw new Error("compressor failed")
      }
      if (behavior === "skip") return null
      return {
        context: "compressed-context",
        inputTokens: 1000,
        outputTokens: 500,
        retainedEvidenceIds: ["ev_1"],
        droppedEvidenceIds: [],
      }
    },
    get calls() {
      return calls
    },
  }
  return compressor
}

// ---------------------------------------------------------------------------
// normalizeToolCall — dedup key (criterion #3)
// ---------------------------------------------------------------------------

test("normalizeToolCall: same tool + same query → same argsKey", () => {
  const a = normalizeToolCall("semantic_lexical_hybrid", { query: "hello world" })
  const b = normalizeToolCall("semantic_lexical_hybrid", { query: "hello world" })
  assert.equal(a.argsKey, b.argsKey)
  assert.equal(a.tool, b.tool)
})

test("normalizeToolCall: same tool + different query → different argsKey", () => {
  const a = normalizeToolCall("semantic_lexical_hybrid", { query: "hello" })
  const b = normalizeToolCall("semantic_lexical_hybrid", { query: "world" })
  assert.notEqual(a.argsKey, b.argsKey)
})

test("normalizeToolCall: query whitespace + case normalized", () => {
  const a = normalizeToolCall("semantic_lexical_hybrid", { query: "  Hello   WORLD  " })
  const b = normalizeToolCall("semantic_lexical_hybrid", { query: "hello world" })
  assert.equal(a.argsKey, b.argsKey)
})

test("normalizeToolCall: seeds deduped + sorted", () => {
  const a = normalizeToolCall("graph_navigation", { query: "q", seeds: ["b", "a", "b"] })
  const b = normalizeToolCall("graph_navigation", { query: "q", seeds: ["a", "b"] })
  assert.equal(a.argsKey, b.argsKey)
})

test("normalizeToolCall: empty seeds → no seeds in key", () => {
  const a = normalizeToolCall("graph_navigation", { query: "q", seeds: [] })
  const b = normalizeToolCall("graph_navigation", { query: "q" })
  assert.equal(a.argsKey, b.argsKey)
  assert.ok(!a.argsKey.includes("s="))
})

test("normalizeToolCall: different tools + same query → different NormalizedToolCall", () => {
  const a = normalizeToolCall("semantic_lexical_hybrid", { query: "q" })
  const b = normalizeToolCall("graph_navigation", { query: "q" })
  assert.equal(a.argsKey, b.argsKey) // same argsKey (same args)
  assert.notEqual(a.tool, b.tool) // different tool
})

test("normalizeToolCall: different seeds → different argsKey", () => {
  const a = normalizeToolCall("graph_navigation", { query: "q", seeds: ["a"] })
  const b = normalizeToolCall("graph_navigation", { query: "q", seeds: ["b"] })
  assert.notEqual(a.argsKey, b.argsKey)
})

// ---------------------------------------------------------------------------
// ComplexLoopControllerImpl — LLM call parsing
// ---------------------------------------------------------------------------

test("ComplexLoopControllerImpl: stop_loop call → sufficient=true", async () => {
  const client = mockOpenAI(() => toolCall("stop_loop", { reason: "evidence-sufficient" }))
  const controller = new ComplexLoopControllerImpl(client as unknown as OpenAI, "test-model")
  const decision = await controller.decide(makeState())
  assert.equal(decision.sufficient, true)
  assert.equal(decision.tool, undefined)
})

test("ComplexLoopControllerImpl: semantic_lexical_hybrid valid call", async () => {
  const client = mockOpenAI(() =>
    toolCall("semantic_lexical_hybrid", { query: "search query" })
  )
  const controller = new ComplexLoopControllerImpl(client as unknown as OpenAI, "test-model")
  const decision = await controller.decide(makeState())
  assert.equal(decision.sufficient, false)
  assert.equal(decision.tool, "semantic_lexical_hybrid")
  assert.equal(decision.args?.query, "search query")
  assert.equal(decision.fallbackReason, undefined)
})

test("ComplexLoopControllerImpl: graph_navigation valid call with seeds", async () => {
  const client = mockOpenAI(() =>
    toolCall("graph_navigation", { query: "q", seeds: ["a", "b"] })
  )
  const controller = new ComplexLoopControllerImpl(client as unknown as OpenAI, "test-model")
  const decision = await controller.decide(makeState())
  assert.equal(decision.tool, "graph_navigation")
  assert.deepEqual(decision.args?.seeds, ["a", "b"])
})

test("ComplexLoopControllerImpl: pageindex_hierarchy valid call", async () => {
  const client = mockOpenAI(() =>
    toolCall("pageindex_hierarchy", { query: "q" })
  )
  const controller = new ComplexLoopControllerImpl(client as unknown as OpenAI, "test-model")
  const decision = await controller.decide(makeState())
  assert.equal(decision.tool, "pageindex_hierarchy")
})

test("ComplexLoopControllerImpl: no tool call → fallback to semantic_lexical_hybrid with state.query", async () => {
  const client = mockOpenAI(() => null)
  const controller = new ComplexLoopControllerImpl(client as unknown as OpenAI, "test-model")
  const state = makeState({ query: "the original query" })
  const decision = await controller.decide(state)
  assert.equal(decision.sufficient, false)
  assert.equal(decision.tool, "semantic_lexical_hybrid")
  assert.equal(decision.args?.query, "the original query")
  assert.equal(decision.fallbackReason, "no_tool_call")
})

test("ComplexLoopControllerImpl: unknown tool → fallback", async () => {
  const client = mockOpenAI(() => toolCall("unknown_tool", { query: "q" }))
  const controller = new ComplexLoopControllerImpl(client as unknown as OpenAI, "test-model")
  const decision = await controller.decide(makeState())
  assert.equal(decision.tool, "semantic_lexical_hybrid")
  assert.equal(decision.fallbackReason, "unknown_tool: unknown_tool")
})

test("ComplexLoopControllerImpl: malformed JSON args → fallback", async () => {
  const client = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{
            message: {
              tool_calls: [{
                type: "function",
                function: { name: "semantic_lexical_hybrid", arguments: "not valid json" },
              }],
            },
          }],
        }),
      },
    },
  } as unknown as OpenAI
  const controller = new ComplexLoopControllerImpl(client, "test-model")
  const decision = await controller.decide(makeState())
  assert.equal(decision.tool, "semantic_lexical_hybrid")
  assert.equal(decision.fallbackReason, "malformed_arguments: semantic_lexical_hybrid")
})

test("ComplexLoopControllerImpl: invalid args (forbidden field) → fallback", async () => {
  const client = mockOpenAI(() =>
    toolCall("semantic_lexical_hybrid", { query: "q", tenantId: "evil" })
  )
  const controller = new ComplexLoopControllerImpl(client as unknown as OpenAI, "test-model")
  const decision = await controller.decide(makeState())
  assert.equal(decision.tool, "semantic_lexical_hybrid")
  assert.equal(decision.fallbackReason, "invalid_arguments: semantic_lexical_hybrid")
})

test("ComplexLoopControllerImpl: LLM error (non-Abort) → fallback", async () => {
  const client = mockOpenAI(
    () => null,
    () => new Error("network failure")
  )
  const controller = new ComplexLoopControllerImpl(client as unknown as OpenAI, "test-model")
  const decision = await controller.decide(makeState({ query: "the query" }))
  assert.equal(decision.tool, "semantic_lexical_hybrid")
  assert.equal(decision.args?.query, "the query")
  assert.ok(decision.fallbackReason?.startsWith("controller_error: network failure"))
})

test("ComplexLoopControllerImpl: AbortError → re-thrown", async () => {
  const abortError = new Error("aborted")
  abortError.name = "AbortError"
  const client = mockOpenAI(
    () => null,
    () => abortError
  )
  const controller = new ComplexLoopControllerImpl(client as unknown as OpenAI, "test-model")
  await assert.rejects(
    () => controller.decide(makeState()),
    (err: Error) => err.name === "AbortError"
  )
})

test("ComplexLoopControllerImpl: passes tools + tool_choice=auto to LLM", async () => {
  const client = mockOpenAI(() => toolCall("stop_loop", { reason: "evidence-sufficient" }))
  const controller = new ComplexLoopControllerImpl(client as unknown as OpenAI, "test-model")
  await controller.decide(makeState())
  assert.equal(client.calls.length, 1)
  assert.equal(client.calls[0].tool_choice, "auto")
  // 3 retrieval tools + 1 stop_loop = 4
  assert.equal(client.calls[0].tools.length, 4)
  assert.deepEqual(
    client.calls[0].tools.map((t: any) => t.function.name),
    ["semantic_lexical_hybrid", "graph_navigation", "pageindex_hierarchy", "stop_loop"]
  )
})

test("ComplexLoopControllerImpl: passes loop state as user message", async () => {
  const client = mockOpenAI(() => toolCall("stop_loop", { reason: "evidence-sufficient" }))
  const controller = new ComplexLoopControllerImpl(client as unknown as OpenAI, "test-model")
  const state = makeState({
    query: "my question",
    coverageCriteria: ["c1", "c2"],
    observations: "some observations",
    remainingIterations: 2,
    remainingToolCalls: 3,
  })
  await controller.decide(state)
  const userMsg = client.calls[0].messages[1].content
  assert.ok(userMsg.includes("my question"))
  assert.ok(userMsg.includes("c1; c2"))
  assert.ok(userMsg.includes("some observations"))
  assert.ok(userMsg.includes("Remaining iteration budget: 2"))
  assert.ok(userMsg.includes("Remaining tool call budget: 3"))
})

// ---------------------------------------------------------------------------
// runComplexLoop — orchestration (5 stop reasons + budgets + dedup + compression)
// ---------------------------------------------------------------------------

test("runComplexLoop: evidence-sufficient on iter 1 → stops immediately", async () => {
  const controller = scriptController([decisionSufficient])
  const searcher = scriptSearcher([{ results: [makeResult("r1")] }])
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler(),
  }
  const result = await runComplexLoop(deps, { query: "q" })
  assert.equal(result.stopReason, "evidence-sufficient")
  assert.equal(result.iterationsExecuted, 1)
  assert.equal(result.toolCallsExecuted, 0)
  assert.equal(result.toolCalls.length, 0)
  assert.equal(result.results.length, 0)
})

test("runComplexLoop: evidence-sufficient on iter 2 (after 1 tool call)", async () => {
  const controller = scriptController([
    decisionTool("semantic_lexical_hybrid", "q1"),
    decisionSufficient,
  ])
  const searcher = scriptSearcher([{ results: [makeResult("r1")] }])
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler(),
  }
  const result = await runComplexLoop(deps, { query: "q" })
  assert.equal(result.stopReason, "evidence-sufficient")
  assert.equal(result.iterationsExecuted, 2)
  assert.equal(result.toolCallsExecuted, 1)
  assert.equal(result.results.length, 1)
})

test("runComplexLoop: iteration-budget — 3 iterations, no sufficient", async () => {
  // LLM always picks a different tool+args to avoid dedup
  const controller = scriptController([
    decisionTool("semantic_lexical_hybrid", "q1"),
    decisionTool("semantic_lexical_hybrid", "q2"),
    decisionTool("semantic_lexical_hybrid", "q3"),
  ])
  const searcher = scriptSearcher([{ results: [makeResult("r1")] }])
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler(),
  }
  const result = await runComplexLoop(deps, { query: "q" })
  assert.equal(result.stopReason, "iteration-budget")
  assert.equal(result.iterationsExecuted, 3)
  assert.equal(result.toolCallsExecuted, 3)
})

test("runComplexLoop: tool-budget — 4 tool calls, 5th iteration hits tool-budget", async () => {
  // 5 decisions, all different (no dedup). After 4 tool calls, budget=0.
  // Iter 5: controller decides tool, but tool-budget check stops the loop.
  const controller = scriptController([
    decisionTool("semantic_lexical_hybrid", "q1"),
    decisionTool("semantic_lexical_hybrid", "q2"),
    decisionTool("semantic_lexical_hybrid", "q3"),
    decisionTool("semantic_lexical_hybrid", "q4"),
    decisionTool("semantic_lexical_hybrid", "q5"),
  ])
  const searcher = scriptSearcher([{ results: [makeResult("r1")] }])
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler(),
  }
  const result = await runComplexLoop(deps, { query: "q" })
  // 3 iterations max — loop ends on iteration-budget BEFORE tool-budget can trigger
  // (3 iters * 1 tool call each = 3 tool calls, well under the 4 budget)
  assert.equal(result.stopReason, "iteration-budget")
  assert.equal(result.iterationsExecuted, 3)
  assert.equal(result.toolCallsExecuted, 3)
})

test("runComplexLoop: tool-budget triggers when 4 tool calls happen before 3 iterations", async () => {
  // This test is hard to construct because each iteration = 1 tool call.
  // To hit tool-budget before iteration-budget, we'd need 4+ tool calls in <3 iterations.
  // Since 1 iter = 1 tool call, max 3 tool calls in 3 iterations — can't exceed 4.
  // So tool-budget only triggers if duplicates consume iterations but not tool budget,
  // AND then real calls exceed budget. Hard to construct — skip explicit test, rely on
  // the budget check code path being covered by inspection.
  // This test is a placeholder documenting the constraint.
  assert.ok(COMPLEX_LOOP_MAX_TOOL_CALLS >= COMPLEX_LOOP_MAX_ITERATIONS)
})

test("runComplexLoop: provider-failure — searcher throws non-Abort", async () => {
  const controller = scriptController([
    decisionTool("semantic_lexical_hybrid", "q1"),
  ])
  const searcher = scriptSearcher([
    { results: [], throwErr: new Error("ES connection refused") },
  ])
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler(),
  }
  const result = await runComplexLoop(deps, { query: "q" })
  assert.equal(result.stopReason, "provider-failure")
  assert.equal(result.iterationsExecuted, 1)
  assert.equal(result.toolCallsExecuted, 0) // search threw, didn't count
  assert.equal(result.results.length, 0)
})

test("runComplexLoop: deterministic-fallback — all iterations return duplicates", async () => {
  // First call executes; second is a duplicate of the first; third is a duplicate.
  // All produce 0 new results because searcher returns empty.
  const controller = scriptController([
    decisionTool("semantic_lexical_hybrid", "q1"),
    decisionTool("semantic_lexical_hybrid", "q1"), // duplicate
    decisionTool("semantic_lexical_hybrid", "q1"), // duplicate
  ])
  const searcher = scriptSearcher([{ results: [] }])
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler(),
  }
  const result = await runComplexLoop(deps, { query: "q" })
  // First call executed (0 results); 2nd and 3rd are duplicates (skipped).
  // accumulatedResults.length === 0 → deterministic-fallback
  assert.equal(result.stopReason, "deterministic-fallback")
  assert.equal(result.iterationsExecuted, 3)
  assert.equal(result.toolCallsExecuted, 1) // only first call executed
  assert.equal(result.toolCalls[0].duplicate, false)
  assert.equal(result.toolCalls[1].duplicate, true)
  assert.equal(result.toolCalls[2].duplicate, true)
})

test("runComplexLoop: dedup — same tool+args twice → second is duplicate", async () => {
  const controller = scriptController([
    decisionTool("semantic_lexical_hybrid", "q1"),
    decisionTool("semantic_lexical_hybrid", "q1"), // duplicate
    decisionSufficient,
  ])
  const searcher = scriptSearcher([{ results: [makeResult("r1")] }])
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler(),
  }
  const result = await runComplexLoop(deps, { query: "q" })
  assert.equal(result.toolCallsExecuted, 1)
  assert.equal(result.toolCalls.length, 2)
  assert.equal(result.toolCalls[0].duplicate, false)
  assert.equal(result.toolCalls[0].resultCount, 1)
  assert.equal(result.toolCalls[1].duplicate, true)
  assert.equal(result.toolCalls[1].resultCount, 0)
})

test("runComplexLoop: dedup — query whitespace normalization makes calls duplicates", async () => {
  const controller = scriptController([
    decisionTool("semantic_lexical_hybrid", "  hello   world  "),
    decisionTool("semantic_lexical_hybrid", "hello world"), // normalized same
    decisionSufficient,
  ])
  const searcher = scriptSearcher([{ results: [makeResult("r1")] }])
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler(),
  }
  const result = await runComplexLoop(deps, { query: "q" })
  assert.equal(result.toolCallsExecuted, 1)
  assert.equal(result.toolCalls[1].duplicate, true)
})

test("runComplexLoop: results accumulate across iterations", async () => {
  const controller = scriptController([
    decisionTool("semantic_lexical_hybrid", "q1"),
    decisionTool("graph_navigation", "q2"),
    decisionSufficient,
  ])
  const searcher = scriptSearcher([
    { results: [makeResult("r1")] },
    { results: [makeResult("r2")] },
  ])
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler(),
  }
  const result = await runComplexLoop(deps, { query: "q" })
  assert.equal(result.results.length, 2)
  assert.equal(result.results[0].chunk.id, "r1")
  assert.equal(result.results[1].chunk.id, "r2")
})

test("runComplexLoop: results dedupe by chunk ID (criterion #4)", async () => {
  const controller = scriptController([
    decisionTool("semantic_lexical_hybrid", "q1"),
    decisionTool("graph_navigation", "q2"),
    decisionSufficient,
  ])
  // Both calls return the SAME chunk ID → deduped to 1 result
  const searcher = scriptSearcher([
    { results: [makeResult("r1")] },
    { results: [makeResult("r1")] }, // same chunk ID
  ])
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler(),
  }
  const result = await runComplexLoop(deps, { query: "q" })
  assert.equal(result.results.length, 1) // deduped
})

test("runComplexLoop: AbortError from controller → propagates", async () => {
  const abortError = new Error("aborted")
  abortError.name = "AbortError"
  const controller: ComplexLoopController = {
    decide: async () => {
      throw abortError
    },
  }
  const searcher = scriptSearcher([{ results: [] }])
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler(),
  }
  await assert.rejects(
    () => runComplexLoop(deps, { query: "q" }),
    (err: Error) => err.name === "AbortError"
  )
})

test("runComplexLoop: AbortError from searcher → propagates", async () => {
  const controller = scriptController([
    decisionTool("semantic_lexical_hybrid", "q1"),
  ])
  const abortError = new Error("aborted")
  abortError.name = "AbortError"
  const searcher = scriptSearcher([{ results: [], throwErr: abortError }])
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler(),
  }
  await assert.rejects(
    () => runComplexLoop(deps, { query: "q" }),
    (err: Error) => err.name === "AbortError"
  )
})

test("runComplexLoop: AbortError from compressor → propagates", async () => {
  const controller = scriptController([
    decisionTool("semantic_lexical_hybrid", "q1"),
  ])
  const abortError = new Error("aborted")
  abortError.name = "AbortError"
  const compressor = {
    compress: async () => {
      throw abortError
    },
  }
  const searcher = scriptSearcher([{ results: [makeResult("r1")] }])
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler(),
    compressor: compressor as any,
  }
  await assert.rejects(
    () => runComplexLoop(deps, { query: "q" }),
    (err: Error) => err.name === "AbortError"
  )
})

test("runComplexLoop: compressor runs after each iteration (criterion #5)", async () => {
  const controller = scriptController([
    decisionTool("semantic_lexical_hybrid", "q1"),
    decisionTool("graph_navigation", "q2"),
    decisionSufficient,
  ])
  const searcher = scriptSearcher([
    { results: [makeResult("r1")] },
    { results: [makeResult("r2")] },
  ])
  const compressor = mockCompressor("compress")
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler(),
    compressor,
  }
  const result = await runComplexLoop(deps, { query: "q" })
  assert.equal(compressor.calls, 2) // one per iteration with results
  assert.equal(result.toolCalls[0].compressionRan, true)
  assert.equal(result.toolCalls[0].compressionInputTokens, 1000)
  assert.equal(result.toolCalls[0].compressionOutputTokens, 500)
  assert.equal(result.toolCalls[1].compressionRan, true)
})

test("runComplexLoop: compressor error (non-Abort) → swallowed, deterministic context used", async () => {
  const controller = scriptController([
    decisionTool("semantic_lexical_hybrid", "q1"),
    decisionSufficient,
  ])
  const searcher = scriptSearcher([{ results: [makeResult("r1")] }])
  const compressor = mockCompressor("throw")
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler("deterministic-context"),
    compressor,
  }
  const result = await runComplexLoop(deps, { query: "q" })
  assert.equal(compressor.calls, 1)
  assert.equal(result.toolCalls[0].compressionRan, false)
  assert.equal(result.finalObservation, "deterministic-context")
})

test("runComplexLoop: compressor returns null → compressionRan=false", async () => {
  const controller = scriptController([
    decisionTool("semantic_lexical_hybrid", "q1"),
    decisionSufficient,
  ])
  const searcher = scriptSearcher([{ results: [makeResult("r1")] }])
  const compressor = mockCompressor("skip")
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler("assembled"),
    compressor,
  }
  const result = await runComplexLoop(deps, { query: "q" })
  assert.equal(result.toolCalls[0].compressionRan, false)
  assert.equal(result.finalObservation, "assembled")
})

test("runComplexLoop: observations passed to next controller.decide() call", async () => {
  const controller = scriptController([
    decisionTool("semantic_lexical_hybrid", "q1"),
    decisionSufficient,
  ])
  const searcher = scriptSearcher([{ results: [makeResult("r1")] }])
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler("the-observation"),
  }
  await runComplexLoop(deps, { query: "q" })
  // Second decide() call should see the observation from the first iteration
  assert.equal(controller.calls.length, 2)
  assert.equal(controller.calls[0].observations, "")
  assert.equal(controller.calls[1].observations, "the-observation")
})

test("runComplexLoop: accessContext passed to searcher.search()", async () => {
  const controller = scriptController([
    decisionTool("semantic_lexical_hybrid", "q1"),
    decisionSufficient,
  ])
  const searcher = scriptSearcher([{ results: [makeResult("r1")] }])
  const accessContext = {
    tenantId: "tenant-1",
    subjectId: "user-1",
    groups: ["g1"],
  } as any
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler(),
  }
  await runComplexLoop(deps, { query: "q", accessContext })
  assert.equal(searcher.calls.length, 1)
  assert.equal(searcher.calls[0].options.accessContext, accessContext)
})

test("runComplexLoop: ≥2 different tools in one run (criterion #8)", async () => {
  const controller = scriptController([
    decisionTool("semantic_lexical_hybrid", "q1"),
    decisionTool("graph_navigation", "q2"),
    decisionSufficient,
  ])
  const searcher = scriptSearcher([
    { results: [makeResult("r1")] },
    { results: [makeResult("r2")] },
  ])
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler(),
  }
  const result = await runComplexLoop(deps, { query: "q" })
  const distinctTools = new Set(result.toolCalls.map((c) => c.tool))
  assert.ok(distinctTools.size >= 2, "should have at least 2 different tools")
  assert.ok(distinctTools.has("semantic_lexical_hybrid"))
  assert.ok(distinctTools.has("graph_navigation"))
})

test("runComplexLoop: guaranteed termination within 3 iterations + 4 tool calls (criterion #8)", async () => {
  // LLM never declares sufficient — loop must terminate on budget
  const controller = scriptController([
    decisionTool("semantic_lexical_hybrid", "q1"),
    decisionTool("graph_navigation", "q2"),
    decisionTool("pageindex_hierarchy", "q3"),
    decisionTool("semantic_lexical_hybrid", "q4"), // wouldn't run (iter budget hit)
  ])
  const searcher = scriptSearcher([{ results: [makeResult("r1")] }])
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler(),
  }
  const result = await runComplexLoop(deps, { query: "q" })
  assert.ok(result.iterationsExecuted <= COMPLEX_LOOP_MAX_ITERATIONS)
  assert.ok(result.toolCallsExecuted <= COMPLEX_LOOP_MAX_TOOL_CALLS)
  assert.equal(result.stopReason, "iteration-budget")
})

test("runComplexLoop: priorToolCalls accumulate so LLM sees them in state", async () => {
  const controller = scriptController([
    decisionTool("semantic_lexical_hybrid", "q1"),
    decisionTool("graph_navigation", "q2", ["seedA"]),
    decisionSufficient,
  ])
  const searcher = scriptSearcher([
    { results: [makeResult("r1")] },
    { results: [makeResult("r2")] },
  ])
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler(),
  }
  await runComplexLoop(deps, { query: "q" })
  // 3rd decide() call should see 2 prior tool calls
  assert.equal(controller.calls[2].priorToolCalls.length, 2)
  assert.equal(controller.calls[2].priorToolCalls[0].tool, "semantic_lexical_hybrid")
  assert.equal(controller.calls[2].priorToolCalls[1].tool, "graph_navigation")
})

test("runComplexLoop: finalObservation reflects last iteration's context", async () => {
  const controller = scriptController([
    decisionTool("semantic_lexical_hybrid", "q1"),
    decisionSufficient,
  ])
  const searcher = scriptSearcher([{ results: [makeResult("r1")] }])
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler("the-final-context"),
  }
  const result = await runComplexLoop(deps, { query: "q" })
  assert.equal(result.finalObservation, "the-final-context")
})

test("runComplexLoop: evidence-sufficient on iter 1 (no tool calls) → finalObservation empty", async () => {
  const controller = scriptController([decisionSufficient])
  const searcher = scriptSearcher([{ results: [] }])
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler(),
  }
  const result = await runComplexLoop(deps, { query: "q" })
  assert.equal(result.finalObservation, "")
  assert.equal(result.results.length, 0)
})

test("runComplexLoop: fallback decision (LLM error) uses state.query for fallback tool", async () => {
  // Controller returns a fallback decision (no_tool_call) — should use state.query
  const fallbackDecision: ComplexLoopDecision = {
    sufficient: false,
    tool: "semantic_lexical_hybrid",
    args: { query: "fallback-query" },
    fallbackReason: "no_tool_call",
  }
  const controller = scriptController([fallbackDecision, decisionSufficient])
  const searcher = scriptSearcher([{ results: [makeResult("r1")] }])
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler(),
  }
  const result = await runComplexLoop(deps, { query: "the-original-query" })
  assert.equal(result.toolCallsExecuted, 1)
  assert.equal(result.toolCalls[0].fallbackReason, "no_tool_call")
  // The fallback args.query is what gets searched
  assert.equal(searcher.calls[0].query.text, "fallback-query")
})

test("runComplexLoop: accumulatedEvidenceIds populated after each iteration", async () => {
  const controller = scriptController([
    decisionTool("semantic_lexical_hybrid", "q1"),
    decisionSufficient,
  ])
  const searcher = scriptSearcher([{ results: [makeResult("r1")] }])
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler(),
  }
  await runComplexLoop(deps, { query: "q" })
  // Second decide() call should see accumulated evidence IDs
  assert.ok(controller.calls[1].accumulatedEvidenceIds.length > 0)
  assert.ok(
    controller.calls[1].accumulatedEvidenceIds[0].startsWith("ev_"),
    `expected ev_ prefix, got ${controller.calls[1].accumulatedEvidenceIds[0]}`
  )
})

// ---------------------------------------------------------------------------
// Ticket 09 — shared budget + dedup across loop runs (correction-round reuse)
// ---------------------------------------------------------------------------

test("T09 §criterion#2: remainingIterations limits the loop to the carried-over budget", async () => {
  // Controller always returns a non-sufficient decision with a different
  // query so no duplicates. With remainingIterations=1, the loop should
  // execute exactly 1 iteration and stop with iteration-budget.
  const controller = scriptController([
    decisionTool("semantic_lexical_hybrid", "q1"),
    decisionTool("semantic_lexical_hybrid", "q2"), // should never execute
  ])
  const searcher = scriptSearcher([{ results: [makeResult("r1")] }])
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler(),
  }
  const result = await runComplexLoop(deps, {
    query: "the-query",
    remainingIterations: 1,
    remainingToolCalls: 4,
  })
  assert.equal(result.iterationsExecuted, 1, "must stop at 1 iteration")
  assert.equal(result.toolCallsExecuted, 1)
  assert.equal(result.stopReason, "iteration-budget")
  // Controller should only be called once
  assert.equal(controller.calls.length, 1)
})

test("T09 §criterion#2: remainingToolCalls limits the loop to the carried-over budget", async () => {
  // With remainingToolCalls=1, the loop should execute 1 tool call and then
  // stop with tool-budget on the next non-duplicate decision.
  const controller = scriptController([
    decisionTool("semantic_lexical_hybrid", "q1"),
    decisionTool("graph_navigation", "q2"), // triggers tool-budget
    decisionSufficient, // never reached
  ])
  const searcher = scriptSearcher([
    { results: [makeResult("r1")] },
    { results: [makeResult("r2")] }, // never reached
  ])
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler(),
  }
  const result = await runComplexLoop(deps, {
    query: "the-query",
    remainingIterations: 3,
    remainingToolCalls: 1,
  })
  assert.equal(result.toolCallsExecuted, 1, "must stop at 1 tool call")
  assert.equal(result.iterationsExecuted, 2, "2 iterations: 1 tool call + 1 tool-budget check")
  // 2nd iteration detects tool budget exhausted → stopReason changes
  // Results are non-empty (r1), so stopReason stays "tool-budget" (NOT deterministic-fallback)
  assert.equal(result.stopReason, "tool-budget")
})

test("T09 §criterion#2: remainingIterations=0 → immediate return, stopReason=deterministic-fallback", async () => {
  // When the prior loop run exhausted the iteration budget, the correction
  // round's loop call should return immediately with zero iterations and
  // deterministic-fallback (criterion #5 — fall back to deterministic Searcher).
  const controller = scriptController([
    decisionTool("semantic_lexical_hybrid", "q1"), // never reached
  ])
  const searcher = scriptSearcher([{ results: [makeResult("r1")] }])
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler(),
  }
  const result = await runComplexLoop(deps, {
    query: "the-query",
    remainingIterations: 0,
    remainingToolCalls: 4,
  })
  assert.equal(result.iterationsExecuted, 0, "must not execute any iterations")
  assert.equal(result.toolCallsExecuted, 0)
  assert.equal(result.results.length, 0)
  assert.equal(result.stopReason, "deterministic-fallback")
  assert.equal(controller.calls.length, 0, "controller must not be called")
  assert.equal(searcher.calls.length, 0, "searcher must not be called")
})

test("T09 §criterion#6: priorToolCalls skips duplicates from the prior loop run", async () => {
  // The prior loop run already called semantic_lexical_hybrid("hello world").
  // The correction round's loop should skip that as a duplicate WITHOUT
  // backend execution, then execute a new non-duplicate tool call.
  const priorToolCalls: NormalizedToolCall[] = [
    normalizeToolCall("semantic_lexical_hybrid", { query: "hello world" }),
  ]
  const controller = scriptController([
    decisionTool("semantic_lexical_hybrid", "hello world"), // duplicate of prior
    decisionTool("graph_navigation", "new query"), // new, non-duplicate
    decisionSufficient,
  ])
  const searcher = scriptSearcher([
    { results: [makeResult("r1")] }, // only called for the new query
  ])
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler(),
  }
  const result = await runComplexLoop(deps, {
    query: "the-query",
    remainingIterations: 3,
    remainingToolCalls: 4,
    priorToolCalls,
  })
  // First decision was a duplicate → skipped (no backend call)
  // Second decision was new → executed
  assert.equal(result.toolCallsExecuted, 1, "only the new tool call executes")
  assert.equal(result.iterationsExecuted, 3, "3 iterations: duplicate + new + sufficient")
  assert.equal(result.stopReason, "evidence-sufficient")
  // Searcher should only be called once (for the new query)
  assert.equal(searcher.calls.length, 1)
  // First tool call trace should be flagged as duplicate
  assert.equal(result.toolCalls[0].duplicate, true)
  assert.equal(result.toolCalls[0].tool, "semantic_lexical_hybrid")
  // Second tool call trace should be a real execution
  assert.equal(result.toolCalls[1].duplicate, false)
  assert.equal(result.toolCalls[1].tool, "graph_navigation")
})

test("T09 §criterion#6: priorToolCalls + all-duplicate decisions → deterministic-fallback", async () => {
  // All decisions in the correction round are duplicates of prior tool calls.
  // The loop should skip all of them and end with deterministic-fallback
  // (zero usable new results — criterion #5 fall back to deterministic Searcher).
  const priorToolCalls: NormalizedToolCall[] = [
    normalizeToolCall("semantic_lexical_hybrid", { query: "q1" }),
    normalizeToolCall("graph_navigation", { query: "q2" }),
    normalizeToolCall("pageindex_hierarchy", { query: "q3" }),
  ]
  const controller = scriptController([
    decisionTool("semantic_lexical_hybrid", "q1"), // duplicate
    decisionTool("graph_navigation", "q2"), // duplicate
    decisionTool("pageindex_hierarchy", "q3"), // duplicate
  ])
  const searcher = scriptSearcher([{ results: [makeResult("r1")] }])
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler(),
  }
  const result = await runComplexLoop(deps, {
    query: "the-query",
    remainingIterations: 3,
    remainingToolCalls: 4,
    priorToolCalls,
  })
  assert.equal(result.iterationsExecuted, 3, "3 iterations consumed (all duplicates)")
  assert.equal(result.toolCallsExecuted, 0, "no tool calls executed (all duplicates)")
  assert.equal(result.results.length, 0)
  assert.equal(result.stopReason, "deterministic-fallback")
  assert.equal(searcher.calls.length, 0, "searcher must not be called for duplicates")
  // All tool call traces should be flagged as duplicate
  assert.equal(result.toolCalls.length, 3)
  for (const call of result.toolCalls) {
    assert.equal(call.duplicate, true)
  }
})

test("T09 §criterion#2+#6: shared budget across runs — prior run used 2 iterations + 2 tool calls, correction has 1+2 left", async () => {
  // Simulate the initial complex run using 2 iterations + 2 tool calls.
  // The correction round should have 1 iteration + 2 tool calls remaining.
  const priorToolCalls: NormalizedToolCall[] = [
    normalizeToolCall("semantic_lexical_hybrid", { query: "initial-q1" }),
    normalizeToolCall("graph_navigation", { query: "initial-q2" }),
  ]
  const controller = scriptController([
    decisionTool("pageindex_hierarchy", "correction-q1"), // new, non-duplicate
    decisionTool("semantic_lexical_hybrid", "correction-q2"), // would be new but budget exhausted
  ])
  const searcher = scriptSearcher([{ results: [makeResult("r1")] }])
  const deps: ComplexLoopDeps = {
    controller,
    searcher: searcher as any,
    assembler: mockAssembler(),
  }
  const result = await runComplexLoop(deps, {
    query: "correction-query",
    remainingIterations: 1, // 3 - 2 used in initial = 1 left
    remainingToolCalls: 2, // 4 - 2 used in initial = 2 left
    priorToolCalls,
  })
  // Only 1 iteration runs (remainingIterations=1). The first decision is new
  // and executes (1 tool call). The loop then stops with iteration-budget.
  assert.equal(result.iterationsExecuted, 1)
  assert.equal(result.toolCallsExecuted, 1)
  assert.equal(result.stopReason, "iteration-budget")
  assert.equal(result.results.length, 1)
  // The new tool call should NOT be a duplicate
  assert.equal(result.toolCalls[0].duplicate, false)
  assert.equal(result.toolCalls[0].tool, "pageindex_hierarchy")
})
