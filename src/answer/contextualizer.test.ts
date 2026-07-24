import assert from "node:assert/strict"
import test from "node:test"
import type OpenAI from "openai"
import type { ChatCompletion } from "openai/resources/chat/completions"
import type { ConversationTurn } from "./conversation_store"
import { ContextualizerImpl } from "./contextualizer"

type CreateFn = NonNullable<OpenAI["chat"]["completions"]["create"]>

function fakeClient(responses: ChatCompletion[]): Pick<OpenAI, "chat"> {
  let callIndex = 0
  const create = (((
    _body: unknown,
    _options?: unknown
  ) => {
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

const recentTurns: ConversationTurn[] = [
  { sessionId: "sess-1", tenantId: "default", role: "user", content: "怎么安装这个设备?", runId: "run-1", createdAt: "2026-07-18T00:00:00.000Z" },
  { sessionId: "sess-1", tenantId: "default", role: "assistant", content: "请按以下步骤安装...", runId: "run-1", createdAt: "2026-07-18T00:00:01.000Z" },
]

test("Ticket 08 P3: ContextualizerImpl returns the rewritten standalone query with usage", async () => {
  const client = fakeClient([
    completion("怎么使用已安装的设备?", { prompt_tokens: 50, completion_tokens: 12, total_tokens: 62 }),
  ])
  const contextualizer = new ContextualizerImpl(client as OpenAI, "test-model")

  const result = await contextualizer.contextualize("它怎么用?", recentTurns)

  assert.equal(result.query, "怎么使用已安装的设备?")
  assert.deepEqual(result.usage, {
    promptTokens: 50,
    completionTokens: 12,
    totalTokens: 62,
  })
})

test("Ticket 08 P3: ContextualizerImpl returns empty query when the model emits no content (P4 will degrade)", async () => {
  const client = fakeClient([completion(null)])
  const contextualizer = new ContextualizerImpl(client as OpenAI, "test-model")

  const result = await contextualizer.contextualize("它怎么用?", recentTurns)

  assert.equal(result.query, "")
  assert.equal(result.usage, undefined)
})

// ============================================================
// Ticket 61 / 02 P3 — Contextualizer.contextualize optional summary param
// ============================================================

test("Ticket 02 P3: ContextualizerImpl weaves rolling summary into prompt when provided", async () => {
  // Spec §2 L1741, L1746: when a rolling summary exists, the contextualizer
  // must include it in the model prompt so the rewritten query can reference
  // older confirmed facts, goals and constraints that have been folded out
  // of the recent-pair window.
  const calls: Array<{ body: unknown }> = []
  const create = (((
    body: unknown,
    _options?: unknown
  ) => {
    calls.push({ body })
    return Promise.resolve(completion("用户之前提到订单 ABC-123,现在追问的退货状态如何查询?"))
  }) as unknown) as CreateFn
  const client = { chat: { completions: { create } } } as unknown as Pick<OpenAI, "chat">
  const contextualizer = new ContextualizerImpl(client as OpenAI, "test-model")

  const result = await contextualizer.contextualize(
    "状态怎样了?",
    recentTurns,
    "用户目标:退货。已确认订单号 ABC-123,等待3个工作日内处理。"
  )

  assert.equal(result.query, "用户之前提到订单 ABC-123,现在追问的退货状态如何查询?")
  const body = calls[0].body as { messages: Array<{ role: string; content: string }> }
  // System prompt mentions the summary-aware capability.
  assert.match(body.messages[0].content, /较早对话的摘要/)
  // User message contains the summary block before the recent transcript.
  assert.match(
    body.messages[1].content,
    /较早对话的摘要：\n用户目标:退货。已确认订单号 ABC-123,等待3个工作日内处理。/
  )
  // Recent transcript still present after the summary block.
  assert.match(body.messages[1].content, /最近对话：\n/)
  // Follow-up still present at the end.
  assert.match(body.messages[1].content, /当前追问：状态怎样了\?$/)
})

test("Ticket 02 P3: ContextualizerImpl omits summary block when summary is null", async () => {
  // Backward compat: null summary → no summary block in prompt. Equivalent
  // to the pre-Ticket-02 behavior (Ticket 08 P3 single-window).
  const calls: Array<{ body: unknown }> = []
  const create = (((
    body: unknown,
    _options?: unknown
  ) => {
    calls.push({ body })
    return Promise.resolve(completion("怎么使用已安装的设备?"))
  }) as unknown) as CreateFn
  const client = { chat: { completions: { create } } } as unknown as Pick<OpenAI, "chat">
  const contextualizer = new ContextualizerImpl(client as OpenAI, "test-model")

  await contextualizer.contextualize("它怎么用?", recentTurns, null)

  const body = calls[0].body as { messages: Array<{ content: string }> }
  assert.ok(
    !/较早对话的摘要：/.test(body.messages[1].content),
    "null summary → no summary block in user message"
  )
  assert.match(body.messages[1].content, /^最近对话：/)
})

test("Ticket 02 P3: ContextualizerImpl omits summary block when summary is undefined (backward compat)", async () => {
  // Spec §2 L1746: omitting the param preserves the Ticket 08 P3 single-
  // window behavior. This guarantees existing callers (pre-Ticket-02) keep
  // working without changes.
  const calls: Array<{ body: unknown }> = []
  const create = (((
    body: unknown,
    _options?: unknown
  ) => {
    calls.push({ body })
    return Promise.resolve(completion("怎么使用已安装的设备?"))
  }) as unknown) as CreateFn
  const client = { chat: { completions: { create } } } as unknown as Pick<OpenAI, "chat">
  const contextualizer = new ContextualizerImpl(client as OpenAI, "test-model")

  await contextualizer.contextualize("它怎么用?", recentTurns)

  const body = calls[0].body as { messages: Array<{ content: string }> }
  assert.ok(
    !/较早对话的摘要：/.test(body.messages[1].content),
    "undefined summary → no summary block in user message"
  )
  assert.match(body.messages[1].content, /^最近对话：/)
})

test("Ticket 02 P3: ContextualizerImpl omits summary block when summary is empty string", async () => {
  // Empty string summary (e.g. provider returned no content) is treated as
  // "no summary available" — same as null. This aligns with the P2 contract
  // where empty summary text triggers the run's safe-degradation path.
  const calls: Array<{ body: unknown }> = []
  const create = (((
    body: unknown,
    _options?: unknown
  ) => {
    calls.push({ body })
    return Promise.resolve(completion("怎么使用已安装的设备?"))
  }) as unknown) as CreateFn
  const client = { chat: { completions: { create } } } as unknown as Pick<OpenAI, "chat">
  const contextualizer = new ContextualizerImpl(client as OpenAI, "test-model")

  await contextualizer.contextualize("它怎么用?", recentTurns, "")

  const body = calls[0].body as { messages: Array<{ content: string }> }
  assert.ok(
    !/较早对话的摘要：/.test(body.messages[1].content),
    "empty-string summary → no summary block (treated as null)"
  )
})
