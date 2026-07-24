import type OpenAI from "openai"
import type { Query, TokenUsage } from "../../types"
import type { DecomposeResult, HypothesisResult, RewriteResult } from "./interface"

export class PlannerError extends Error {
  constructor(
    message: string,
    readonly stage: "decompose" | "rewrite"
  ) {
    super(message)
    this.name = "PlannerError"
  }
}

const MIN_SUB_QUERIES = 2
const MAX_SUB_QUERIES = 4

function extractUsage(res: OpenAI.Chat.Completions.ChatCompletion): TokenUsage | undefined {
  const u = res.usage
  if (!u) return undefined
  return {
    promptTokens: u.prompt_tokens,
    completionTokens: u.completion_tokens ?? 0,
    totalTokens: u.total_tokens,
  }
}

function safeContent(res: OpenAI.Chat.Completions.ChatCompletion): string {
  if (!res.choices || res.choices.length === 0) return ""
  return res.choices[0]?.message?.content || ""
}

interface ParsedSubQuestion {
  q?: unknown
  text?: unknown
  coverage?: unknown
}

function parseDecompose(raw: string): Query[] {
  if (!raw.trim()) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const root = parsed as { questions?: unknown; sub_questions?: unknown }
  const itemsRaw: unknown = Array.isArray(root.questions)
    ? root.questions
    : Array.isArray(root.sub_questions)
      ? root.sub_questions
      : []
  const items: unknown[] = itemsRaw as unknown[]
  const queries: Query[] = []
  for (const item of items) {
    if (typeof item === "string") {
      const text = item.trim()
      if (text) queries.push({ text })
      continue
    }
    if (item && typeof item === "object") {
      const obj = item as ParsedSubQuestion
      const text = String(obj.q ?? obj.text ?? "").trim()
      if (!text) continue
      const coverage = Array.isArray(obj.coverage)
        ? obj.coverage.map((c) => String(c)).filter(Boolean)
        : undefined
      queries.push(coverage && coverage.length > 0 ? { text, coverageCriteria: coverage } : { text })
    }
  }
  return queries
}

function validateDecompose(queries: Query[]): Query[] {
  if (queries.length < MIN_SUB_QUERIES || queries.length > MAX_SUB_QUERIES) return []
  return queries
}

export class PlannerImpl {
  constructor(
    private client: OpenAI,
    private model: string
  ) {}

  async decompose(query: Query): Promise<DecomposeResult> {
    const systemContent =
      "Break the query into 2-4 independent sub-questions. " +
      'For each, list 1-3 coverage criteria (keywords that should appear in evidence). ' +
      'Return JSON: { "questions": [{ "q": "sub-question", "coverage": ["keyword"] }] }'
    let lastUsage: TokenUsage | undefined
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: query.text },
        ],
        response_format: { type: "json_object" },
      })
      lastUsage = extractUsage(res)
      const parsed = parseDecompose(safeContent(res))
      const validated = validateDecompose(parsed)
      if (validated.length > 0) {
        return { queries: validated, usage: lastUsage }
      }
    }
    throw new PlannerError(
      `decompose produced malformed output after retry (got ${0} valid sub-queries, expected ${MIN_SUB_QUERIES}-${MAX_SUB_QUERIES})`,
      "decompose"
    )
  }

  async rewrite(query: Query): Promise<RewriteResult> {
    const systemContent =
      "Rewrite the query to be more search-friendly, expanding synonyms where helpful. " +
      "Return only the rewritten query text."
    let lastUsage: TokenUsage | undefined
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: query.text },
        ],
      })
      lastUsage = extractUsage(res)
      const text = safeContent(res).trim()
      if (text) {
        return {
          query: { text, coverageCriteria: query.coverageCriteria },
          usage: lastUsage,
        }
      }
    }
    return { query, usage: lastUsage }
  }

  async navigate(query: Query): Promise<string[]> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: "system",
          content:
            'List entity names related to this query. Return JSON: { "entities": ["..."] }',
        },
        { role: "user", content: query.text },
      ],
      response_format: { type: "json_object" },
    })
    const raw = JSON.parse(safeContent(res) || "{}")
    return raw.entities || []
  }

  async generateHypothesis(query: Query): Promise<HypothesisResult> {
    const systemContent =
      "Write a short hypothetical answer to the query that an ideal document would contain. " +
      "Return only the hypothesis text. Do not include explanations or preface."
    let lastUsage: TokenUsage | undefined
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: query.text },
        ],
      })
      lastUsage = extractUsage(res)
      const text = safeContent(res).trim()
      if (text) {
        return { text, usage: lastUsage }
      }
    }
    return { text: query.text, usage: lastUsage }
  }
}
