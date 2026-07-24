import type OpenAI from "openai"

import type { RetrievalResult } from "../types"
import type { AccessContext } from "../access/context"
import type { Searcher, SearchOptions, RetrievalChannel } from "./search/interface"
import {
  RETRIEVAL_TOOLS,
  validateToolArgs,
  toolToSearchOptions,
  type RetrievalToolName,
  type RetrievalToolArgs,
} from "./tool_selector"

/**
 * Ticket 08 — Add bounded complex retrieval loop.
 *
 * Spec §13 (bounded complex retrieval loop): allow complex knowledge
 * questions to alternate between LLM retrieval decisions and bounded
 * observations. The loop may combine complementary read-only tools,
 * accumulate Evidence and stop when it believes coverage is sufficient,
 * while deterministic gates retain final authority.
 *
 * The loop runs only for the complex route when a `ComplexLoopController`
 * is wired into the runner dependencies. Without it, the bounded
 * `planner.decompose` multi-query retrieval flow remains available.
 *
 * Budgets (criterion #1):
 * - at most 3 LLM decision iterations
 * - at most 4 retrieval tool calls per Answer run
 *
 * Stop reasons (criterion #6):
 * - `evidence-sufficient` — LLM declared coverage sufficient (does NOT
 *   bypass Citation/Critic gates — criterion #7)
 * - `iteration-budget` — 3 iterations exhausted
 * - `tool-budget` — 4 tool calls exhausted before iterations
 * - `provider-failure` — searcher.search() threw a non-Abort error
 * - `deterministic-fallback` — loop ended with zero usable results
 */

export const COMPLEX_LOOP_MAX_ITERATIONS = 3
export const COMPLEX_LOOP_MAX_TOOL_CALLS = 4

// ---------------------------------------------------------------------------
// Stop reason (criterion #6)
// ---------------------------------------------------------------------------

export type ComplexLoopStopReason =
  | "evidence-sufficient"
  | "iteration-budget"
  | "tool-budget"
  | "provider-failure"
  | "deterministic-fallback"

// ---------------------------------------------------------------------------
// Loop state (criterion #2)
// ---------------------------------------------------------------------------

export interface NormalizedToolCall {
  tool: RetrievalToolName
  /** Stable dedup key — same key means equivalent tool call (criterion #3). */
  argsKey: string
}

export interface ComplexLoopState {
  /** The original standalone query (contextualized). */
  query: string
  /** Coverage criteria from decomposition (optional). */
  coverageCriteria?: string[]
  /** Tool calls already executed (normalized). */
  priorToolCalls: NormalizedToolCall[]
  /** Bounded observations from prior iterations (compressed context string). */
  observations: string
  /** Accumulated Evidence IDs (criterion #2). */
  accumulatedEvidenceIds: string[]
  /** Remaining iteration budget. */
  remainingIterations: number
  /** Remaining tool call budget. */
  remainingToolCalls: number
}

// ---------------------------------------------------------------------------
// LLM decision (per iteration)
// ---------------------------------------------------------------------------

export interface ComplexLoopDecision {
  /** When true, LLM declares coverage sufficient — loop stops with "evidence-sufficient". */
  sufficient: boolean
  /** Present when sufficient=false. Validated tool name. */
  tool?: RetrievalToolName
  /** Present when sufficient=false. Validated tool args. */
  args?: RetrievalToolArgs
  /** Present when the LLM's choice was invalid and fell back to semantic_lexical_hybrid. */
  fallbackReason?: string
}

export interface ComplexLoopController {
  /**
   * Ask the LLM for the next tool decision given the current loop state.
   * Always returns a decision — falls back to `semantic_lexical_hybrid`
   * with `state.query` on any malformed/absent/forbidden choice (mirrors
   * ToolSelectorImpl's fallback semantics from Ticket 07). AbortError is
   * re-thrown to preserve user-cancellation.
   */
  decide(
    state: ComplexLoopState,
    signal?: AbortSignal
  ): Promise<ComplexLoopDecision>
}

// ---------------------------------------------------------------------------
// Per-tool-call trace (for retrieval events in generation.ts)
// ---------------------------------------------------------------------------

export interface ComplexLoopToolCallTrace {
  tool: RetrievalToolName
  args: RetrievalToolArgs
  argsKey: string
  /** True when this call was a duplicate and skipped (criterion #3). */
  duplicate: boolean
  /** Result count from this call (0 if duplicate). */
  resultCount: number
  /** Channels that were unavailable during this call. */
  unavailableChannels: RetrievalChannel[]
  /** Search call duration in ms (0 if duplicate). */
  durationMs: number
  /** Whether observation compression ran after this call. */
  compressionRan: boolean
  compressionInputTokens?: number
  compressionOutputTokens?: number
  compressionRetainedEvidenceIds?: string[]
  compressionDroppedEvidenceIds?: string[]
  /** Present when the LLM's tool choice was a fallback. */
  fallbackReason?: string
}

export interface ComplexLoopResult {
  /** All accumulated retrieval results (deduplicated by chunk ID — criterion #4). */
  results: RetrievalResult[]
  /** Per-tool-call metadata for trace events. */
  toolCalls: ComplexLoopToolCallTrace[]
  /** Stop reason (criterion #6). */
  stopReason: ComplexLoopStopReason
  /** Iterations actually executed (counts duplicates). */
  iterationsExecuted: number
  /** Tool calls actually executed (excludes duplicates). */
  toolCallsExecuted: number
  /** Final compressed observation context. */
  finalObservation: string
}

// ---------------------------------------------------------------------------
// Assembler — minimal interface matching ContextAssemblerImpl.assemble
// ---------------------------------------------------------------------------

export interface ComplexLoopAssembler {
  assemble(
    results: RetrievalResult[],
    citationIds?: ReadonlyMap<string, string>
  ): Promise<string>
}

// ---------------------------------------------------------------------------
// Compressor — adapter-friendly interface for bounding observation memory.
// The loop passes accumulated RetrievalResult[] so generation.ts can build
// full Evidence[] (via buildEvidence) before calling ContextCompressor.
// ---------------------------------------------------------------------------

export interface ComplexLoopCompressor {
  compress(
    results: RetrievalResult[],
    query: string,
    budget: { maxContextTokens: number },
    signal?: AbortSignal
  ): Promise<{
    context: string
    inputTokens: number
    outputTokens: number
    retainedEvidenceIds: string[]
    droppedEvidenceIds: string[]
  } | null>
}

// ---------------------------------------------------------------------------
// Loop entry point
// ---------------------------------------------------------------------------

export interface ComplexLoopDeps {
  controller: ComplexLoopController
  searcher: Searcher
  assembler: ComplexLoopAssembler
  /** Optional compressor for bounding observation memory (criterion #5). */
  compressor?: ComplexLoopCompressor
}

export interface ComplexLoopInput {
  query: string
  coverageCriteria?: string[]
  accessContext?: AccessContext
  signal?: AbortSignal
  /**
   * Ticket 09 (spec §13 correction-round reuse): remaining iteration budget
   * carried over from a prior loop run (initial complex run). When omitted,
   * defaults to `COMPLEX_LOOP_MAX_ITERATIONS` (3) — the initial-run case.
   * When provided (correction round), the loop respects the reduced budget
   * so the Answer run's total iterations across initial + correction stays
   * within the spec-declared ceiling (criterion #2).
   */
  remainingIterations?: number
  /**
   * Ticket 09: remaining tool-call budget carried over from a prior loop run.
   * Same semantics as `remainingIterations` but for tool calls.
   */
  remainingToolCalls?: number
  /**
   * Ticket 09 (criterion #6): prior normalized tool calls from earlier loop
   * runs in the same Answer run. The loop treats these as already-seen for
   * dedup purposes, so a tool call made in the initial complex run is not
   * repeated in the correction round. When omitted, defaults to `[]`.
   */
  priorToolCalls?: NormalizedToolCall[]
}

// ---------------------------------------------------------------------------
// normalizeToolCall — dedup key (criterion #3)
// ---------------------------------------------------------------------------

/**
 * Build a stable dedup key for a tool call. Two calls are "equivalent"
 * (criterion #3) when they have the same tool name, same normalized query
 * (trim + lowercase + collapse whitespace), and same normalized seed set
 * (deduped + sorted).
 *
 * Equivalent calls are rejected as duplicates without backend execution.
 */
export function normalizeToolCall(
  tool: RetrievalToolName,
  args: RetrievalToolArgs
): NormalizedToolCall {
  const normalizedQuery = args.query.trim().toLowerCase().replace(/\s+/g, " ")
  const seeds =
    args.seeds && args.seeds.length > 0
      ? [...new Set(args.seeds.map((s) => s.trim()).filter((s) => s.length > 0))].sort()
      : []
  const argsKey =
    seeds.length > 0
      ? `q=${normalizedQuery};s=${seeds.join(",")}`
      : `q=${normalizedQuery}`
  return { tool, argsKey }
}

// ---------------------------------------------------------------------------
// STOP_LOOP_TOOL — additional function for the LLM to declare sufficiency
// ---------------------------------------------------------------------------

const STOP_LOOP_TOOL = {
  type: "function" as const,
  function: {
    name: "stop_loop" as const,
    description:
      "Stop the retrieval loop because the accumulated observations already cover the user's question. " +
      "This does NOT bypass downstream Citation/Critic gates — they still run after the loop terminates.",
    parameters: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string" as const,
          enum: ["evidence-sufficient"] as const,
          description: "The reason for stopping the loop.",
        },
      },
      required: ["reason"],
      additionalProperties: false as const,
    },
  },
}

const COMPLEX_LOOP_TOOLS = [...RETRIEVAL_TOOLS, STOP_LOOP_TOOL]

const COMPLEX_LOOP_SYSTEM_PROMPT =
  "You are a retrieval planner for a knowledge-grounded answer system. " +
  "Your job is to drive a bounded retrieval loop by choosing ONE action per turn: " +
  "either call a retrieval tool to gather more Evidence, or call stop_loop when the " +
  "accumulated observations already cover the user's question.\n\n" +
  "Available retrieval tools (call ONE per turn):\n" +
  "- semantic_lexical_hybrid({query}): vector + BM25 hybrid search — best for factual/keyword queries\n" +
  "- graph_navigation({query, seeds?}): knowledge-graph traversal — best for multi-hop relational queries\n" +
  "- pageindex_hierarchy({query}): PageIndex hierarchical lookup — best for page-oriented queries\n\n" +
  "Stop tool:\n" +
  "- stop_loop({reason: \"evidence-sufficient\"}): stop the loop because observations cover the question. " +
  "NOTE: this does NOT bypass downstream Citation/Critic gates — they still run after the loop terminates.\n\n" +
  "Rules:\n" +
  "- Do NOT repeat a tool call with equivalent arguments you have already made.\n" +
  "- If observations cover the question, call stop_loop.\n" +
  "- If you need more evidence, call ONE retrieval tool with a focused query."

function formatLoopStateForLLM(state: ComplexLoopState): string {
  const lines: string[] = []
  lines.push(`Question: ${state.query}`)
  lines.push(`Coverage criteria: ${state.coverageCriteria?.join("; ") ?? "none"}`)
  lines.push(
    `Prior tool calls: ${
      state.priorToolCalls.length === 0
        ? "none"
        : state.priorToolCalls.map((c) => `${c.tool}(${c.argsKey})`).join("; ")
    }`
  )
  lines.push(`Remaining iteration budget: ${state.remainingIterations}`)
  lines.push(`Remaining tool call budget: ${state.remainingToolCalls}`)
  lines.push("")
  lines.push("Observations from prior iterations:")
  lines.push(state.observations || "(none yet — this is the first iteration)")
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// ComplexLoopControllerImpl — LLM call with function-calling
// ---------------------------------------------------------------------------

export class ComplexLoopControllerImpl implements ComplexLoopController {
  constructor(
    private client: OpenAI,
    private model: string
  ) {}

  async decide(
    state: ComplexLoopState,
    signal?: AbortSignal
  ): Promise<ComplexLoopDecision> {
    let res
    try {
      res = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: [
            { role: "system", content: COMPLEX_LOOP_SYSTEM_PROMPT },
            { role: "user", content: formatLoopStateForLLM(state) },
          ],
          tools: COMPLEX_LOOP_TOOLS,
          tool_choice: "auto",
        },
        signal ? { signal } : undefined
      )
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err
      // Non-Abort: fallback to semantic_lexical_hybrid with state.query
      return {
        sufficient: false,
        tool: "semantic_lexical_hybrid",
        args: { query: state.query },
        fallbackReason: `controller_error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      }
    }

    const toolCall = res.choices?.[0]?.message?.tool_calls?.[0]
    if (!toolCall || toolCall.type !== "function") {
      return {
        sufficient: false,
        tool: "semantic_lexical_hybrid",
        args: { query: state.query },
        fallbackReason: "no_tool_call",
      }
    }

    const toolName = toolCall.function?.name

    // stop_loop → sufficient=true
    if (toolName === "stop_loop") {
      return { sufficient: true }
    }

    // Retrieval tool — validate via existing validateToolArgs (Ticket 07)
    if (!isKnownToolName(toolName)) {
      return {
        sufficient: false,
        tool: "semantic_lexical_hybrid",
        args: { query: state.query },
        fallbackReason: `unknown_tool: ${String(toolName)}`,
      }
    }

    let parsedArgs: unknown
    try {
      parsedArgs = JSON.parse(toolCall.function?.arguments || "{}")
    } catch {
      return {
        sufficient: false,
        tool: "semantic_lexical_hybrid",
        args: { query: state.query },
        fallbackReason: `malformed_arguments: ${toolName}`,
      }
    }

    const validatedArgs = validateToolArgs(toolName, parsedArgs)
    if (!validatedArgs) {
      return {
        sufficient: false,
        tool: "semantic_lexical_hybrid",
        args: { query: state.query },
        fallbackReason: `invalid_arguments: ${toolName}`,
      }
    }

    return {
      sufficient: false,
      tool: toolName,
      args: validatedArgs,
    }
  }
}

// ---------------------------------------------------------------------------
// runComplexLoop — the bounded orchestrator (criterion #1)
// ---------------------------------------------------------------------------

/**
 * Run the bounded complex retrieval loop.
 *
 * Iterations: at most `COMPLEX_LOOP_MAX_ITERATIONS` (3).
 * Tool calls: at most `COMPLEX_LOOP_MAX_TOOL_CALLS` (4).
 *
 * Each iteration:
 * 1. Call `controller.decide(state)` — LLM picks next tool OR declares sufficient
 * 2. If sufficient → stop with "evidence-sufficient" (criterion #7 — does NOT bypass gates)
 * 3. Normalize tool call → dedup check (criterion #3)
 * 4. If duplicate → skip execution, continue (don't consume tool budget)
 * 5. If tool budget exhausted → stop with "tool-budget"
 * 6. Execute via `searcher.search()` with `toolToSearchOptions` + accessContext
 * 7. Accumulate results (dedupe by chunk ID — criterion #4)
 * 8. Build observation context (assembler + optional compressor — criterion #5)
 * 9. Update state.observations, state.priorToolCalls, state.accumulatedEvidenceIds
 *
 * AbortError propagates from any step to preserve user-cancellation.
 * Non-Abort searcher error → stop with "provider-failure".
 * Non-Abort controller/compressor error → swallowed (fallback to deterministic).
 */
export async function runComplexLoop(
  deps: ComplexLoopDeps,
  input: ComplexLoopInput
): Promise<ComplexLoopResult> {
  const state: ComplexLoopState = {
    query: input.query,
    ...(input.coverageCriteria ? { coverageCriteria: input.coverageCriteria } : {}),
    // Ticket 09: carry over prior tool calls for cross-loop dedup (criterion #6).
    // Default to empty for the initial complex run; correction rounds pass the
    // accumulated dedup set so a tool call made in the initial run is not
    // repeated in correction.
    priorToolCalls: input.priorToolCalls ? [...input.priorToolCalls] : [],
    observations: "",
    accumulatedEvidenceIds: [],
    // Ticket 09: carry over remaining budgets from a prior loop run
    // (criterion #2 — correction shares the Answer run's total budgets).
    // Default to the full ceilings for the initial complex run.
    remainingIterations:
      input.remainingIterations ?? COMPLEX_LOOP_MAX_ITERATIONS,
    remainingToolCalls:
      input.remainingToolCalls ?? COMPLEX_LOOP_MAX_TOOL_CALLS,
  }

  const toolCalls: ComplexLoopToolCallTrace[] = []
  const accumulatedResults: RetrievalResult[] = []
  let stopReason: ComplexLoopStopReason = "iteration-budget"
  let finalObservation = ""
  let iterationsExecuted = 0
  let toolCallsExecuted = 0

  while (state.remainingIterations > 0) {
    // 1. LLM decision
    let decision: ComplexLoopDecision
    try {
      decision = await deps.controller.decide(state, input.signal)
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err
      // Controller threw non-Abort (defensive — impl catches, but be safe)
      stopReason = "provider-failure"
      break
    }

    // Consume iteration budget (criterion #1)
    state.remainingIterations -= 1
    iterationsExecuted += 1

    // 2. LLM declares sufficient → stop (criterion #7 — does NOT bypass gates)
    if (decision.sufficient) {
      stopReason = "evidence-sufficient"
      break
    }

    // 3. Normalize + dedup check (criterion #3)
    const tool = decision.tool!
    const args = decision.args!
    const normalized = normalizeToolCall(tool, args)
    const isDuplicate = state.priorToolCalls.some(
      (c) => c.tool === normalized.tool && c.argsKey === normalized.argsKey
    )

    if (isDuplicate) {
      // Reject as duplicate without backend execution (criterion #3).
      // Don't consume tool budget; do consume iteration budget (loop progresses).
      toolCalls.push({
        tool,
        args,
        argsKey: normalized.argsKey,
        duplicate: true,
        resultCount: 0,
        unavailableChannels: [],
        durationMs: 0,
        compressionRan: false,
        ...(decision.fallbackReason ? { fallbackReason: decision.fallbackReason } : {}),
      })
      continue
    }

    // 5. Tool budget check
    if (state.remainingToolCalls <= 0) {
      stopReason = "tool-budget"
      // Don't record the call since we didn't execute
      break
    }

    // 6. Execute retrieval
    const searchStartedAt = Date.now()
    let outcome
    try {
      const searchOptions: SearchOptions = {
        ...toolToSearchOptions({ tool, args }),
        ...(input.accessContext ? { accessContext: input.accessContext } : {}),
      }
      outcome = await deps.searcher.search({ text: args.query }, searchOptions)
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err
      stopReason = "provider-failure"
      break
    }
    const durationMs = Date.now() - searchStartedAt

    // Consume tool budget (criterion #1)
    state.remainingToolCalls -= 1
    toolCallsExecuted += 1

    // Record in priorToolCalls (for future dedup checks)
    state.priorToolCalls.push(normalized)

    // 7. Accumulate results (dedupe by chunk ID — criterion #4)
    for (const r of outcome.results) {
      const key = `${r.chunk.documentId}\0${r.chunk.id}`
      if (
        !accumulatedResults.some(
          (existing) =>
            `${existing.chunk.documentId}\0${existing.chunk.id}` === key
        )
      ) {
        accumulatedResults.push(r)
      }
    }

    // 8. Build observation context (deterministic + compressed — criterion #5)
    const evidence = buildEvidenceForLoop(accumulatedResults)
    state.accumulatedEvidenceIds = evidence.map((e) => e.id)

    let observationContext: string
    try {
      const citationIds = citationIdsByChunkForLoop(evidence)
      observationContext = await deps.assembler.assemble(accumulatedResults, citationIds)
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err
      // Assembler failed — use a minimal deterministic fallback
      observationContext = accumulatedResults
        .map((r) => r.chunk.content)
        .join("\n\n")
    }

    let compressionRan = false
    let compressionInputTokens: number | undefined
    let compressionOutputTokens: number | undefined
    let compressionRetainedEvidenceIds: string[] | undefined
    let compressionDroppedEvidenceIds: string[] | undefined

    if (deps.compressor) {
      try {
        const result = await deps.compressor.compress(
          accumulatedResults,
          input.query,
          { maxContextTokens: 6_000 },
          input.signal
        )
        if (result) {
          observationContext = result.context
          compressionRan = true
          compressionInputTokens = result.inputTokens
          compressionOutputTokens = result.outputTokens
          compressionRetainedEvidenceIds = result.retainedEvidenceIds
          compressionDroppedEvidenceIds = result.droppedEvidenceIds
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err
        // non-Abort: swallow, use deterministic context (criterion #5 fallback)
      }
    }

    // 9. Update state
    state.observations = observationContext
    finalObservation = observationContext

    toolCalls.push({
      tool,
      args,
      argsKey: normalized.argsKey,
      duplicate: false,
      resultCount: outcome.results.length,
      unavailableChannels: outcome.unavailableChannels,
      durationMs,
      compressionRan,
      ...(compressionInputTokens !== undefined ? { compressionInputTokens } : {}),
      ...(compressionOutputTokens !== undefined ? { compressionOutputTokens } : {}),
      ...(compressionRetainedEvidenceIds !== undefined
        ? { compressionRetainedEvidenceIds }
        : {}),
      ...(compressionDroppedEvidenceIds !== undefined
        ? { compressionDroppedEvidenceIds }
        : {}),
      ...(decision.fallbackReason ? { fallbackReason: decision.fallbackReason } : {}),
    })
  }

  // Deterministic-fallback: loop ended with zero usable results
  if (
    accumulatedResults.length === 0 &&
    (stopReason === "iteration-budget" || stopReason === "tool-budget")
  ) {
    stopReason = "deterministic-fallback"
  }

  return {
    results: accumulatedResults,
    toolCalls,
    stopReason,
    iterationsExecuted,
    toolCallsExecuted,
    finalObservation,
  }
}

// ---------------------------------------------------------------------------
// Helpers — local minimal versions to avoid circular imports
// ---------------------------------------------------------------------------

/**
 * Minimal Evidence shape for the loop's observation building. We only need
 * `id` for the trace and `chunk.documentId`/`chunk.id` for citation map.
 * The full Evidence construction is deferred to generation.ts (which has
 * the authoritative `buildEvidence` from `../answer/evidence`).
 *
 * The loop produces this minimal shape so the compressor (which expects
 * `Evidence[]`) can be invoked. generation.ts will rebuild authoritative
 * Evidence from `results` after the loop terminates.
 */
function buildEvidenceForLoop(
  results: RetrievalResult[]
): Array<{ id: string; documentId: string; chunkId: string }> {
  const seen = new Set<string>()
  const evidence: Array<{ id: string; documentId: string; chunkId: string }> = []
  for (const r of results) {
    const key = `${r.chunk.documentId}\0${r.chunk.id}`
    if (seen.has(key)) continue
    seen.add(key)
    evidence.push({
      id: `ev_${r.chunk.documentId}_${r.chunk.id}`,
      documentId: r.chunk.documentId,
      chunkId: r.chunk.id,
    })
  }
  return evidence
}

function citationIdsByChunkForLoop(
  evidence: Array<{ id: string; documentId: string; chunkId: string }>
): Map<string, string> {
  const map = new Map<string, string>()
  for (const e of evidence) {
    map.set(`${e.documentId}\0${e.chunkId}`, e.id)
  }
  return map
}

function isKnownToolName(name: unknown): name is RetrievalToolName {
  return (
    name === "semantic_lexical_hybrid" ||
    name === "graph_navigation" ||
    name === "pageindex_hierarchy"
  )
}
