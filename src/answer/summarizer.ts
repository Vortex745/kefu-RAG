import type OpenAI from "openai"
import type { TokenUsage } from "../types"
import type { ConversationTurn } from "./conversation_store"

/**
 * Ticket 61 / 02 (spec §2 L1745): bounded rolling summary produced by folding
 * older validated turns (and optionally the prior summary) into a compact
 * memory projection. The summary must preserve:
 *   - user goals and confirmed facts
 *   - explicit constraints and corrections
 *   - unresolved questions
 * and drop:
 *   - greetings, repetition, and obsolete statements
 *
 * The summary text and recent turns share one hard contextualization token
 * budget (spec §2 L1746). Provider failure is delegated to the caller —
 * `summarize()` rejection triggers the run's safe-degradation path (use
 * recent validated turns only, record a safe reason, do not fail the run).
 */
export interface SummarizeResult {
  summary: string
  usage?: TokenUsage
}

export interface Summarizer {
  /**
   * Produce a bounded rolling summary from `olderTurns` (validated turns
   * that have just fallen out of the recent window) integrated with the
   * optional `existingSummary` (the prior checkpoint text).
   *
   * The caller passes `olderTurns` in chronological (id-ascending) order.
   * Empty `olderTurns` is allowed only when `existingSummary` is non-null
   * (a no-op advance); the Impl still calls the provider so the model can
   * re-emit the existing summary verbatim if no integration work is needed.
   *
   * Returns the new summary text. The caller is responsible for persisting
   * it via `saveRollingSummary` and for handling provider failure (try/catch
   * around `summarize()`).
   */
  summarize(
    olderTurns: ConversationTurn[],
    existingSummary: string | null,
    signal?: AbortSignal
  ): Promise<SummarizeResult>
}

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

function formatTurns(turns: ConversationTurn[]): string {
  return turns
    .map((turn) => `${turn.role === "user" ? "用户" : "助手"}: ${turn.content}`)
    .join("\n")
}

/**
 * Ticket 61 / 02 (spec §2 L1745): LLM-backed Summarizer. Mirrors the
 * ContextualizerImpl pattern — a single chat.completions.create call with
 * the older validated turns and the prior summary text. The model is asked
 * to emit ONLY the new rolling summary (no preface, no quotes) so the
 * caller can persist it verbatim.
 *
 * The summary is bounded by `maxTokens` (default 256) — enough for a
 * multi-turn rolling summary without overflowing the contextualization
 * budget shared with the recent-pair window.
 *
 * Failure handling (exception, empty content, malformed response) is
 * delegated to the generation.ts call site (spec §2 L1746) — this Impl
 * returns whatever the model produced and lets the caller decide how to
 * degrade. An empty result string is treated by the caller as a provider
 * failure (fall back to recent validated turns only).
 */
export class SummarizerImpl implements Summarizer {
  constructor(
    private client: OpenAI,
    private model: string,
    private readonly maxTokens: number = 256
  ) {}

  async summarize(
    olderTurns: ConversationTurn[],
    existingSummary: string | null,
    signal?: AbortSignal
  ): Promise<SummarizeResult> {
    const transcript = formatTurns(olderTurns)
    const priorBlock = existingSummary
      ? `当前已有摘要：\n${existingSummary}\n\n请基于上述已有摘要整合新的对话内容，保留已有摘要中仍然有效的事实。`
      : "当前还没有任何摘要，请从零开始为这些对话内容生成摘要。"
    const res = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [
        {
          role: "system",
          content:
            "你是客服对话滚动摘要器。基于较早的已验证对话内容生成或更新一条紧凑的会话摘要。" +
            "必须保留：用户目标、已确认的事实、明确的约束和纠正、未解决的问题。" +
            "必须丢弃：问候、重复内容、已失效的陈述。" +
            "只输出新的摘要本身，不要任何前缀、引号或额外说明。摘要必须用中文，长度不超过 256 tokens。",
        },
        {
          role: "user",
          content: `${priorBlock}\n\n需要折叠进摘要的较早对话：\n${transcript}`,
        },
      ],
    }, { signal })
    return { summary: safeContent(res).trim(), usage: extractUsage(res) }
  }
}
