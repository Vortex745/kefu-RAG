import type OpenAI from "openai"
import type { Query } from "../types"
import type { SearchOptions } from "./search/interface"

/**
 * Ticket 07 — Add single-round retrieval tool choice.
 *
 * Spec §12 (bounded tool loop, single-round slice): for the simple knowledge
 * route, the LLM may choose ONE read-only retrieval strategy from a strict
 * tool schema. The selected tool is executed through the existing authorized
 * Searcher with the request Access Context. Direct and ambiguous routes
 * bypass tool selection entirely.
 *
 * Three read-only retrieval tools are exposed to the LLM:
 * 1. `semantic_lexical_hybrid` — vector + BM25 channels (default fallback)
 * 2. `graph_navigation` — graph channel only, with optional seed entities
 * 3. `pageindex_hierarchy` — PageIndex channel only
 *
 * Tool arguments are validated before execution and CANNOT supply Tenant,
 * Principal, or unrestricted backend query fields (criterion #2). Only
 * `query` (string) and `seeds` (string[], graph_navigation only) are allowed.
 *
 * Malformed, unsupported, or absent tool choice falls back to
 * `semantic_lexical_hybrid` (criterion #5).
 */

export type RetrievalToolName =
  | "semantic_lexical_hybrid"
  | "graph_navigation"
  | "pageindex_hierarchy"

export interface RetrievalToolArgs {
  /** The search query (always the effective message text). */
  query: string
  /** Optional seed entities for graph navigation (max 10 items). */
  seeds?: string[]
}

export interface RetrievalToolSelection {
  tool: RetrievalToolName
  args: RetrievalToolArgs
}

export interface ToolSelectionResult {
  /** The validated tool selection (always valid — fallback applied on any error). */
  selection: RetrievalToolSelection
  /** Present when the LLM's original choice was invalid and fell back to semantic_lexical_hybrid. */
  fallbackReason?: string
}

export interface ToolSelector {
  /**
   * Ask the LLM which read-only retrieval tool best fits the query.
   * Always returns a valid selection — falls back to `semantic_lexical_hybrid`
   * on malformed/unsupported/absent tool choice (criterion #5).
   * AbortError is re-thrown to preserve user-cancellation.
   */
  selectTool(query: Query, signal?: AbortSignal): Promise<ToolSelectionResult>
}

// ---------------------------------------------------------------------------
// Tool schema (OpenAI function-calling format)
// ---------------------------------------------------------------------------

export const RETRIEVAL_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "semantic_lexical_hybrid" as const,
      description:
        "Search using semantic (vector) and lexical (BM25) hybrid retrieval. Best for factual keyword queries, definitional questions, and short-answer lookups.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query text" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "graph_navigation" as const,
      description:
        "Search using knowledge-graph navigation. Best for multi-hop relational queries, entity-centric questions, and connected-fact lookup.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query text" },
          seeds: {
            type: "array",
            items: { type: "string" },
            description: "Optional seed entity names to anchor graph traversal (max 10)",
            maxItems: 10,
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "pageindex_hierarchy" as const,
      description:
        "Search using PageIndex hierarchical document structure. Best for page-oriented queries, section-level lookups, and table-of-contents navigation.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query text" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
]

// ---------------------------------------------------------------------------
// Validation (criterion #2: cannot supply Tenant, Principal, or unrestricted
// backend query fields)
// ---------------------------------------------------------------------------

/**
 * Arg keys that would let the caller bypass ACL or inject raw backend queries.
 * Any presence of these keys causes the selection to be rejected and fall back
 * to semantic_lexical_hybrid (criterion #2).
 */
const FORBIDDEN_ARG_KEYS = new Set([
  // Tenant / Principal / identity fields
  "tenantId", "tenant", "subjectId", "subject", "principal", "userId", "user",
  "accessToken", "token", "refreshToken", "auth", "authorization",
  // Unrestricted backend query fields
  "sql", "cypher", "query_body", "esQuery", "elasticsearchQuery",
  "filter", "must", "should", "must_not", "query_string",
  "rawQuery", "raw_query", "body", "payload", "request",
])

const MAX_SEEDS = 10
const MAX_SEED_LENGTH = 200

/**
 * Validate tool arguments against the strict read-only schema (criterion #2).
 *
 * Allowed args:
 * - `query` (string, non-empty, required)
 * - `seeds` (string[], max 10 items, each max 200 chars — graph_navigation only)
 *
 * Rejects:
 * - Any forbidden arg key (Tenant/Principal/identity/backend query fields)
 * - Non-string query or empty query
 * - Non-array seeds or items exceeding max length
 * - Any arg key other than `query` and `seeds`
 *
 * Returns the validated args, or `null` if validation fails (caller falls back).
 */
export function validateToolArgs(
  tool: RetrievalToolName,
  rawArgs: unknown
): RetrievalToolArgs | null {
  if (!isPlainObject(rawArgs)) return null

  // Reject any forbidden key — even if the value is null/undefined, the
  // presence of the key indicates the caller attempted to supply a
  // restricted field (criterion #2 strict enforcement).
  for (const key of Object.keys(rawArgs)) {
    if (FORBIDDEN_ARG_KEYS.has(key)) return null
  }

  // Only `query` and `seeds` are allowed
  const allowedKeys = new Set(["query", "seeds"])
  for (const key of Object.keys(rawArgs)) {
    if (!allowedKeys.has(key)) return null
  }

  const query = (rawArgs as Record<string, unknown>).query
  if (typeof query !== "string" || query.trim().length === 0) return null

  const args: RetrievalToolArgs = { query }

  const seeds = (rawArgs as Record<string, unknown>).seeds
  if (seeds !== undefined) {
    // seeds only valid for graph_navigation
    if (tool !== "graph_navigation") return null
    if (!Array.isArray(seeds)) return null
    if (seeds.length > MAX_SEEDS) return null
    const validatedSeeds: string[] = []
    for (const seed of seeds) {
      if (typeof seed !== "string") return null
      if (seed.length > MAX_SEED_LENGTH) return null
      validatedSeeds.push(seed)
    }
    args.seeds = validatedSeeds
  }

  return args
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// Tool → SearchOptions mapping
// ---------------------------------------------------------------------------

/**
 * Map a validated tool selection to SearchOptions for the Searcher.
 *
 * - `semantic_lexical_hybrid` → channels: ["vector", "bm25"]
 * - `graph_navigation` → channels: ["graph"], graphSeeds: args.seeds
 * - `pageindex_hierarchy` → channels: ["pageIndex"]
 */
export function toolToSearchOptions(selection: RetrievalToolSelection): SearchOptions {
  switch (selection.tool) {
    case "semantic_lexical_hybrid":
      return { channels: ["vector", "bm25"] }
    case "graph_navigation":
      return {
        channels: ["graph"],
        ...(selection.args.seeds ? { graphSeeds: selection.args.seeds } : {}),
      }
    case "pageindex_hierarchy":
      return { channels: ["pageIndex"] }
  }
}

/**
 * Build a safe input summary for the trace event (criterion #7).
 * Redacts nothing — the args are already validated to contain only safe fields.
 */
export function formatToolInputSummary(selection: RetrievalToolSelection): string {
  const queryPreview = selection.args.query.length > 80
    ? selection.args.query.substring(0, 80) + "..."
    : selection.args.query
  if (selection.args.seeds && selection.args.seeds.length > 0) {
    return `tool=${selection.tool}; query="${queryPreview}"; seeds=${selection.args.seeds.length}`
  }
  return `tool=${selection.tool}; query="${queryPreview}"`
}

// ---------------------------------------------------------------------------
// Fallback selection (criterion #5)
// ---------------------------------------------------------------------------

const FALLBACK_SELECTION: RetrievalToolSelection = {
  tool: "semantic_lexical_hybrid",
  args: { query: "" }, // query will be filled by the caller
}

/**
 * Build a fallback result with the query filled in.
 */
export function fallbackSelection(
  query: string,
  reason: string
): ToolSelectionResult {
  return {
    selection: { ...FALLBACK_SELECTION, args: { query } },
    fallbackReason: reason,
  }
}

// ---------------------------------------------------------------------------
// ToolSelectorImpl — LLM call with function-calling
// ---------------------------------------------------------------------------

export class ToolSelectorImpl implements ToolSelector {
  constructor(
    private client: OpenAI,
    private model: string
  ) {}

  async selectTool(query: Query, signal?: AbortSignal): Promise<ToolSelectionResult> {
    let res
    try {
      res = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: [
            {
              role: "system",
              content:
                "You are a retrieval strategy selector. Choose the ONE read-only retrieval tool that best fits the user's query. " +
                "Call the function with the user's query text. If no tool fits, call semantic_lexical_hybrid.",
            },
            { role: "user", content: query.text },
          ],
          tools: RETRIEVAL_TOOLS,
          tool_choice: "auto",
        },
        signal ? { signal } : undefined
      )
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err
      // Non-Abort error: fall back to semantic_lexical_hybrid (criterion #5)
      return fallbackSelection(query.text, `tool_selector_error: ${err instanceof Error ? err.message : String(err)}`)
    }

    const toolCall = res.choices?.[0]?.message?.tool_calls?.[0]
    if (!toolCall || toolCall.type !== "function") {
      // No tool call: fall back (criterion #5 — "absent tool choice")
      return fallbackSelection(query.text, "no_tool_call")
    }

    const toolName = toolCall.function?.name
    if (!isKnownToolName(toolName)) {
      // Unknown tool: fall back (criterion #5 — "unsupported tool choice")
      return fallbackSelection(query.text, `unknown_tool: ${String(toolName)}`)
    }

    let parsedArgs: unknown
    try {
      parsedArgs = JSON.parse(toolCall.function?.arguments || "{}")
    } catch {
      // Malformed JSON: fall back (criterion #5 — "malformed tool choice")
      return fallbackSelection(query.text, `malformed_arguments: ${toolName}`)
    }

    const validatedArgs = validateToolArgs(toolName, parsedArgs)
    if (!validatedArgs) {
      // Invalid args (forbidden fields, wrong types, etc.): fall back (criterion #2 + #5)
      return fallbackSelection(query.text, `invalid_arguments: ${toolName}`)
    }

    return {
      selection: { tool: toolName, args: validatedArgs },
    }
  }
}

function isKnownToolName(name: unknown): name is RetrievalToolName {
  return (
    name === "semantic_lexical_hybrid" ||
    name === "graph_navigation" ||
    name === "pageindex_hierarchy"
  )
}