import assert from "node:assert/strict"
import test from "node:test"
import type OpenAI from "openai"
import {
  RunBudgetAccountingError,
  createRunContext,
  getRunResourceBudgetSnapshot,
  runWithRunContext,
} from "./run_context"
import { createRunBudgetedOpenAIClient } from "./openai_budget_client"

test("budgeted OpenAI client records non-stream chat usage and calculated cost", async () => {
  const raw = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        }),
      },
    },
    embeddings: { create: async () => ({ data: [] }) },
  } as unknown as OpenAI
  const client = createRunBudgetedOpenAIClient(raw)
  const ctx = createRunContext({
    resourceBudget: {
      limits: { maxModelCalls: 1, maxTokens: 6, maxCostMicros: 12 },
      estimateCostMicros: (_call, usage) => usage.totalTokens * 2,
    },
  })

  await runWithRunContext(ctx, () => client.chat.completions.create({
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
  }))

  assert.deepEqual(getRunResourceBudgetSnapshot(ctx), {
    modelCalls: 1,
    promptTokens: 4,
    completionTokens: 2,
    totalTokens: 6,
    costMicros: 12,
    limits: { maxModelCalls: 1, maxTokens: 6, maxCostMicros: 12 },
  })
})

test("budgeted OpenAI client requests and settles final usage for streams", async () => {
  let capturedRequest: Record<string, unknown> | undefined
  const chunks = [
    { choices: [{ delta: { content: "ok" } }], usage: null },
    {
      choices: [],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    },
  ]
  const raw = {
    chat: {
      completions: {
        create: async (request: Record<string, unknown>) => {
          capturedRequest = request
          return (async function* () {
            yield* chunks
          })()
        },
      },
    },
    embeddings: { create: async () => ({ data: [] }) },
  } as unknown as OpenAI
  const client = createRunBudgetedOpenAIClient(raw)
  const ctx = createRunContext({
    resourceBudget: { limits: { maxTokens: 4 } },
  })

  await runWithRunContext(ctx, async () => {
    const stream = await client.chat.completions.create({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    })
    for await (const _chunk of stream) {
      // Consume through the final usage chunk.
    }
  })

  assert.deepEqual(capturedRequest?.stream_options, { include_usage: true })
  assert.equal(getRunResourceBudgetSnapshot(ctx).totalTokens, 4)
})

test("budgeted OpenAI client is transparent outside an Answer run", async () => {
  let calls = 0
  const expected = { data: [], usage: { prompt_tokens: 2, total_tokens: 2 } }
  const raw = {
    chat: { completions: { create: async () => ({ choices: [] }) } },
    embeddings: {
      create: async () => {
        calls += 1
        return expected
      },
    },
  } as unknown as OpenAI
  const client = createRunBudgetedOpenAIClient(raw)

  const result = await client.embeddings.create({ model: "embed", input: "hello" })

  assert.equal(result, expected)
  assert.equal(calls, 1)
})

test("budgeted OpenAI stream fails closed when consumption ends before final usage", async () => {
  const raw = {
    chat: {
      completions: {
        create: async () => (async function* () {
          yield { choices: [{ delta: { content: "partial" } }], usage: null }
          yield {
            choices: [],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
          }
        })(),
      },
    },
    embeddings: { create: async () => ({ data: [] }) },
  } as unknown as OpenAI
  const client = createRunBudgetedOpenAIClient(raw)
  const ctx = createRunContext({
    resourceBudget: { limits: { maxTokens: 10 } },
  })

  await assert.rejects(
    runWithRunContext(ctx, async () => {
      const stream = await client.chat.completions.create({
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      })
      for await (const _chunk of stream) break
    }),
    RunBudgetAccountingError
  )
  assert.equal(ctx.signal.aborted, true)
})
