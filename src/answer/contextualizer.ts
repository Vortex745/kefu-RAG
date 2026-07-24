import type OpenAI from "openai"
import type { TokenUsage } from "../types"
import type { ConversationTurn } from "./conversation_store"

export interface ContextualizeResult {
  /**
   * Standalone query rewritten from the follow-up using conversation context.
   * Fed to Router/Planner for retrieval; the original follow-up is retained
   * for trace and UI display per spec §7 L1536.
   */
  query: string
  usage?: TokenUsage
}

/**
 * Ticket 08 P3: rewrites a follow-up message into a standalone query using
 * recent validated conversation turns, so retrieval (Router/Planner) can
 * understand the follow-up without the full conversation history in the
 * model prompt (spec §7 L1534: "unrestricted full traces are not inserted
 * into model prompts").
 *
 * Per spec §7 L1536: "Before Router classification, a contextualization step
 * rewrites the current follow-up into a standalone query while retaining the
 * original message for trace and UI display."
 *
 * P4 (spec L1537) handles failure fallback — contextualize() rejection must
 * degrade to the original message and record a safe reason.
 */
export interface Contextualizer {
  contextualize(
    followUp: string,
    recentTurns: ConversationTurn[],
    /**
     * Ticket 61 / 02 (spec §2 L1741, L1746): optional bounded rolling
     * summary of older validated turns that have already been folded out of
     * `recentTurns`. When non-null, the contextualizer is expected to weave
     * the summary into the model prompt so the rewritten query can reference
     * older confirmed facts, goals and constraints. Optional — omitting it
     * preserves the Ticket 08 P3 single-window behavior.
     */
    summary?: string | null
  ): Promise<ContextualizeResult>
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

function formatRecentTurns(turns: ConversationTurn[]): string {
  return turns
    .map((turn) => `${turn.role === "user" ? "用户" : "助手"}: ${turn.content}`)
    .join("\n")
}

/**
 * Ticket 08 P3: LLM-backed Contextualizer. Mirrors the RouterImpl/PlannerImpl
 * pattern — a single chat.completions.create call with a bounded conversation
 * transcript and the follow-up. The model is asked to emit ONLY the standalone
 * query (no preface, no quotes), so retrieval can consume it directly.
 *
 * Failure handling (exception, empty content, malformed response) is delegated
 * to P4 (spec §7 L1537) at the generation.ts call site — this Impl returns
 * whatever the model produced and lets the caller decide how to degrade.
 */
export class ContextualizerImpl implements Contextualizer {
  constructor(
    private client: OpenAI,
    private model: string
  ) {}

  async contextualize(
    followUp: string,
    recentTurns: ConversationTurn[],
    summary?: string | null
  ): Promise<ContextualizeResult> {
    const transcript = formatRecentTurns(recentTurns)
    const summaryBlock = summary
      ? `较早对话的摘要：\n${summary}\n\n`
      : ""
    const res = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: "system",
          content:
            "你是客服对话上下文改写器。基于最近的对话记录(以及较早对话的摘要,如有),把用户的当前追问改写为一条独立、可检索的查询。" +
            "只输出改写后的查询本身，不要任何前缀、引号或额外说明。若追问本身已独立，原样输出。",
        },
        {
          role: "user",
          content: `${summaryBlock}最近对话：\n${transcript}\n\n当前追问：${followUp}`,
        },
      ],
    })
    return { query: safeContent(res).trim(), usage: extractUsage(res) }
  }
}
