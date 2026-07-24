import assert from "node:assert/strict"
import test from "node:test"
import type OpenAI from "openai"
import type { ChatCompletion } from "openai/resources/chat/completions"
import type { ConversationTurn } from "./conversation_store"
import { SummarizerImpl } from "./summarizer"

type CreateFn = NonNullable<OpenAI["chat"]["completions"]["create"]>

interface RecordedCall {
  body: unknown
  options: unknown
}

function fakeClient(
  responses: ChatCompletion[],
  recorded: RecordedCall[] = []
): Pick<OpenAI, "chat"> {
  let callIndex = 0
  const create = (((
    body: unknown,
    options?: unknown
  ) => {
    recorded.push({ body, options })
    const res = responses[callIndex]
    callIndex += 1
    return Promise.resolve(res)
  }) as unknown) as CreateFn
  return {
    chat: {
      completions: { create },
    },
  } as Pick<OpenAI, "chat">
}

function completion(
  content: string | null,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
): ChatCompletion {
  return {
    id: "test",
    object: "chat.completion",
    created: 0,
    model: "test",
    choices: content === null
      ? []
      : [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage,
  } as ChatCompletion
}

function makeTurn(
  overrides: Partial<ConversationTurn> & {
    role: "user" | "assistant"
    content: string
  }
): ConversationTurn {
  return {
    sessionId: "sess-1",
    tenantId: "default",
    runId: "run-1",
    createdAt: "2026-07-18T00:00:00.000Z",
    ...overrides,
  }
}

const olderTurns: ConversationTurn[] = [
  makeTurn({ role: "user", content: "我想退货" }),
  makeTurn({ role: "assistant", content: "好的,请提供订单号" }),
  makeTurn({ role: "user", content: "订单号是 ABC-123" }),
  makeTurn({ role: "assistant", content: "已记录,将在3个工作日内处理" }),
]

test("Ticket 02 P2: SummarizerImpl returns bounded summary with usage for initial summarization", async () => {
  const recorded: RecordedCall[] = []
  const client = fakeClient(
    [
      completion(
        "用户目标:退货。已确认订单号 ABC-123,等待3个工作日内处理。",
        { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 }
      ),
    ],
    recorded
  )
  const summarizer = new SummarizerImpl(client as OpenAI, "test-model")

  const result = await summarizer.summarize(olderTurns, null)

  assert.equal(
    result.summary,
    "用户目标:退货。已确认订单号 ABC-123,等待3个工作日内处理。"
  )
  assert.deepEqual(result.usage, {
    promptTokens: 80,
    completionTokens: 30,
    totalTokens: 110,
  })
  // Verify the call shape — max_tokens bounds the output.
  const body = recorded[0].body as { model: string; max_tokens: number; messages: Array<{ role: string; content: string }> }
  assert.equal(body.model, "test-model")
  assert.equal(body.max_tokens, 256, "default maxTokens is 256")
  assert.equal(body.messages[0].role, "system")
  assert.match(body.messages[0].content, /客服对话滚动摘要器/)
  assert.equal(body.messages[1].role, "user")
  assert.match(body.messages[1].content, /从零开始为这些对话内容生成摘要/)
})

test("Ticket 02 P2: SummarizerImpl integrates prior summary when advancing checkpoint", async () => {
  const recorded: RecordedCall[] = []
  const client = fakeClient(
    [completion("整合后的新摘要")],
    recorded
  )
  const summarizer = new SummarizerImpl(client as OpenAI, "test-model")

  const result = await summarizer.summarize(olderTurns, "已有摘要内容")

  assert.equal(result.summary, "整合后的新摘要")
  const body = recorded[0].body as { messages: Array<{ role: string; content: string }> }
  assert.match(
    body.messages[1].content,
    /当前已有摘要：\n已有摘要内容/,
    "prior summary is passed in the user message"
  )
  assert.match(
    body.messages[1].content,
    /保留已有摘要中仍然有效的事实/,
    "instructs the model to preserve still-valid prior facts"
  )
})

test("Ticket 02 P2: SummarizerImpl formats older turns with Chinese role labels", async () => {
  const recorded: RecordedCall[] = []
  const client = fakeClient([completion("摘要")], recorded)
  const summarizer = new SummarizerImpl(client as OpenAI, "test-model")

  await summarizer.summarize(olderTurns, null)

  const body = recorded[0].body as { messages: Array<{ content: string }> }
  const userContent = body.messages[1].content
  assert.match(userContent, /用户: 我想退货/)
  assert.match(userContent, /助手: 好的,请提供订单号/)
  assert.match(userContent, /用户: 订单号是 ABC-123/)
  assert.match(userContent, /助手: 已记录,将在3个工作日内处理/)
})

test("Ticket 02 P2: SummarizerImpl forwards AbortSignal to provider call", async () => {
  const recorded: RecordedCall[] = []
  const client = fakeClient([completion("摘要")], recorded)
  const summarizer = new SummarizerImpl(client as OpenAI, "test-model")

  const ac = new AbortController()
  await summarizer.summarize(olderTurns, null, ac.signal)

  assert.deepEqual(recorded[0].options, { signal: ac.signal })
})

test("Ticket 02 P2: SummarizerImpl respects custom maxTokens", async () => {
  const recorded: RecordedCall[] = []
  const client = fakeClient([completion("摘要")], recorded)
  const summarizer = new SummarizerImpl(client as OpenAI, "test-model", 128)

  await summarizer.summarize(olderTurns, null)

  const body = recorded[0].body as { max_tokens: number }
  assert.equal(body.max_tokens, 128, "custom maxTokens honored")
})

test("Ticket 02 P2: SummarizerImpl returns empty summary when model emits no content (caller treats as failure)", async () => {
  // Spec §2 L1746: provider failure (including empty content) triggers the
  // run's safe-degradation path. The Impl returns "" so the caller can
  // detect failure via `summary === ""` and fall back to recent turns only.
  const client = fakeClient([completion(null)])
  const summarizer = new SummarizerImpl(client as OpenAI, "test-model")

  const result = await summarizer.summarize(olderTurns, null)

  assert.equal(result.summary, "")
  assert.equal(result.usage, undefined)
})

test("Ticket 02 P2: SummarizerImpl propagates provider errors to caller (caller catches)", async () => {
  // Spec §2 L1746: provider failure records a safe degradation reason and
  // falls back to recent validated turns. The Impl does NOT swallow the
  // error — it propagates so the caller's try/catch can record the reason.
  const create = (() => Promise.reject(new Error("provider unavailable"))) as unknown as CreateFn
  const client = { chat: { completions: { create } } } as unknown as Pick<OpenAI, "chat">
  const summarizer = new SummarizerImpl(client as OpenAI, "test-model")

  await assert.rejects(
    summarizer.summarize(olderTurns, null),
    /provider unavailable/,
    "Impl propagates provider errors so the caller can record a safe degradation reason"
  )
})

test("Ticket 02 P2: SummarizerImpl handles empty olderTurns with existing summary (no-op advance)", async () => {
  // Caller may invoke summarize with empty olderTurns + non-null
  // existingSummary when the recent window shifted without new completions.
  // The Impl still calls the provider so the model can re-emit the existing
  // summary verbatim if no integration work is needed.
  const recorded: RecordedCall[] = []
  const client = fakeClient([completion("已有摘要原样保留")], recorded)
  const summarizer = new SummarizerImpl(client as OpenAI, "test-model")

  const result = await summarizer.summarize([], "已有摘要原样保留")

  assert.equal(result.summary, "已有摘要原样保留")
  const body = recorded[0].body as { messages: Array<{ content: string }> }
  // Empty olderTurns → transcript is empty string, but the call still proceeds.
  assert.match(body.messages[1].content, /需要折叠进摘要的较早对话：\n$/)
})
