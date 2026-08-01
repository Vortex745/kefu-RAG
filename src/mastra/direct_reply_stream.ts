/**
 * Ticket 09 — Direct reply stream for the direct/chitchat route.
 *
 * Uses the OpenAI-compatible SDK (`openai` npm package) with
 * `chat.completions.create({ stream: true })` so it works with any
 * OpenAI-compatible provider (DeepSeek, OpenAI, etc.) without relying on
 * the @mastra/core Responses API (which DeepSeek does not support).
 *
 * ## Boundary
 *
 * This module is owned by `src/mastra/*` and MUST NOT import from `src/api/*`
 * or `src/index` (T02 #5 dependency direction). It depends only on:
 *   - the `DirectReplyStream` type from `direct_ambiguous_runner.ts`
 *   - the `openai` npm package (already a project dependency)
 *   - `./system_prompt` for identity extraction
 *
 * ## Cancellation
 *
 * The AbortSignal is forwarded to the OpenAI client so mid-stream cancellation
 * surfaces as an AbortError from the async iterable (T09 #4 checkpoint 2).
 */

import OpenAI from "openai"
import type { DirectReplyStream } from "./direct_ambiguous_runner"
import { SYSTEM_PROMPT } from "./system_prompt"
import { createRunBudgetedOpenAIClient } from "../runtime/openai_budget_client"

// Extract the identity description from the first line of SYSTEM_PROMPT
// (e.g. "你是智能客服助手，..."). This lets the model know who it is
// without inheriting the strict citation / evidence constraints that only
// apply to knowledge-base routes.
const AGENT_IDENTITY = SYSTEM_PROMPT.split("\n")[0] ?? "你是智能客服助手。"

export const DIRECT_REPLY_INSTRUCTIONS =
  `${AGENT_IDENTITY}\n\n` +
  "当用户发来问候、对话性请求（如 hi、你好、在吗）或询问你的身份时，" +
  "请简短、自然地用中文回答。介绍自己时说明你是基于知识库提供服务的客服助手，" +
  "可回答知识库覆盖范围内的问题，并会引用证据片段供核对。" +
  "每次回复换一种措辞和句式，避免机械重复。回答保持在两到三句。" +
  "不要要求引用知识库片段，直接用自然语言回答即可。"

/**
 * Options for {@link createDirectReplyStream}.
 */
export interface DirectReplyStreamOptions {
  /** OpenAI-compatible model id (e.g. "deepseek-v4-flash"). */
  model: string
  /** OpenAI API key. */
  apiKey: string
  /** OpenAI-compatible base URL (optional, e.g. "https://api.deepseek.com/v1"). */
  baseURL?: string
  /** Per-request timeout in ms (default: SDK 10min). Bounds a hung stream. */
  timeout?: number
  /** Per-request retry count (default: SDK 2). */
  maxRetries?: number
  /** System instructions for the model. Defaults to DIRECT_REPLY_INSTRUCTIONS. */
  instructions?: string
}

/**
 * Construct an OpenAI-compatible client and return a `DirectReplyStream` that
 * streams chat completion tokens for a given message via the standard
 * `/chat/completions` endpoint (compatible with DeepSeek and other providers).
 */
export async function createDirectReplyStream(
  options: DirectReplyStreamOptions
): Promise<DirectReplyStream> {
  const { model, apiKey, baseURL, timeout, maxRetries, instructions } = options
  const systemInstructions = instructions ?? DIRECT_REPLY_INSTRUCTIONS

  const client = createRunBudgetedOpenAIClient(new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
  }))

  // Return the DirectReplyStream. Each call streams the model's reply tokens
  // for the supplied message; the AbortSignal is forwarded so mid-stream
  // cancellation propagates as an AbortError (T09 #4 checkpoint 2).
  return async function* directReplyStream(
    message: string,
    signal: AbortSignal
  ): AsyncIterable<string> {
    const stream = await client.chat.completions.create(
      {
        model,
        messages: [
          { role: "system", content: systemInstructions },
          { role: "user", content: message },
        ],
        stream: true,
      },
      { signal }
    )

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content
      if (token) yield token
    }
  }
}
