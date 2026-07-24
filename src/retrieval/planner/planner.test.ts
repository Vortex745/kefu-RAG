import assert from "node:assert/strict"
import test from "node:test"
import type OpenAI from "openai"
import type { ChatCompletion } from "openai/resources/chat/completions"
import { PlannerImpl, PlannerError } from "./planner"

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

test("decompose returns 2-4 validated sub-queries with coverage criteria", async () => {
  const client = fakeClient([
    completion(
      JSON.stringify({
        questions: [
          { q: "what is the refund policy", coverage: ["refund", "policy"] },
          { q: "how to apply for refund", coverage: ["apply", "process"] },
        ],
      }),
      { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
    ),
  ])
  const planner = new PlannerImpl(client as OpenAI, "test-model")

  const result = await planner.decompose({ text: "refund policy and process" })

  assert.equal(result.queries.length, 2)
  assert.equal(result.queries[0].text, "what is the refund policy")
  assert.deepEqual(result.queries[0].coverageCriteria, ["refund", "policy"])
  assert.equal(result.queries[1].text, "how to apply for refund")
  assert.deepEqual(result.usage, {
    promptTokens: 10,
    completionTokens: 20,
    totalTokens: 30,
  })
})

test("decompose retries once on malformed JSON then succeeds", async () => {
  const client = fakeClient([
    completion("not valid json at all"),
    completion(
      JSON.stringify({
        questions: [
          { q: "sub-question one", coverage: ["a"] },
          { q: "sub-question two", coverage: ["b"] },
        ],
      })
    ),
  ])
  const planner = new PlannerImpl(client as OpenAI, "test-model")

  const result = await planner.decompose({ text: "complex query" })

  assert.equal(result.queries.length, 2)
  assert.equal(result.queries[0].text, "sub-question one")
})

test("decompose retries on choices null (ModelScope intermittent bug)", async () => {
  const client = fakeClient([
    completion(null),
    completion(
      JSON.stringify({
        questions: [
          { q: "first", coverage: [] },
          { q: "second", coverage: [] },
        ],
      })
    ),
  ])
  const planner = new PlannerImpl(client as OpenAI, "test-model")

  const result = await planner.decompose({ text: "query" })

  assert.equal(result.queries.length, 2)
})

test("decompose throws PlannerError after retry on empty questions", async () => {
  const client = fakeClient([
    completion(JSON.stringify({ questions: [] })),
    completion(JSON.stringify({ questions: [] })),
  ])
  const planner = new PlannerImpl(client as OpenAI, "test-model")

  await assert.rejects(
    planner.decompose({ text: "query" }),
    (err: unknown) => {
      assert.ok(err instanceof PlannerError)
      assert.equal((err as PlannerError).stage, "decompose")
      return true
    }
  )
})

test("decompose throws PlannerError when only one sub-query", async () => {
  const client = fakeClient([
    completion(JSON.stringify({ questions: [{ q: "only one" }] })),
    completion(JSON.stringify({ questions: [{ q: "still one" }] })),
  ])
  const planner = new PlannerImpl(client as OpenAI, "test-model")

  await assert.rejects(
    planner.decompose({ text: "query" }),
    (err: unknown) => err instanceof PlannerError
  )
})

test("decompose throws on five sub-queries (exceeds max)", async () => {
  const client = fakeClient([
    completion(
      JSON.stringify({
        questions: [
          { q: "a" }, { q: "b" }, { q: "c" }, { q: "d" }, { q: "e" },
        ],
      })
    ),
    completion(
      JSON.stringify({
        questions: [
          { q: "a" }, { q: "b" }, { q: "c" }, { q: "d" }, { q: "e" },
        ],
      })
    ),
  ])
  const planner = new PlannerImpl(client as OpenAI, "test-model")

  await assert.rejects(
    planner.decompose({ text: "query" }),
    (err: unknown) => err instanceof PlannerError
  )
})

test("decompose accepts legacy string array format", async () => {
  const client = fakeClient([
    completion(JSON.stringify({ questions: ["legacy one", "legacy two"] })),
  ])
  const planner = new PlannerImpl(client as OpenAI, "test-model")

  const result = await planner.decompose({ text: "query" })

  assert.equal(result.queries.length, 2)
  assert.equal(result.queries[0].text, "legacy one")
  assert.equal(result.queries[0].coverageCriteria, undefined)
})

test("rewrite returns a validated search-friendly query preserving coverage", async () => {
  const client = fakeClient([
    completion("refund policy procedure steps", {
      prompt_tokens: 5,
      completion_tokens: 8,
      total_tokens: 13,
    }),
  ])
  const planner = new PlannerImpl(client as OpenAI, "test-model")

  const result = await planner.rewrite({
    text: "refund policy",
    coverageCriteria: ["refund"],
  })

  assert.equal(result.query.text, "refund policy procedure steps")
  assert.deepEqual(result.query.coverageCriteria, ["refund"])
  assert.deepEqual(result.usage, {
    promptTokens: 5,
    completionTokens: 8,
    totalTokens: 13,
  })
})

test("rewrite retries once on empty output then succeeds", async () => {
  const client = fakeClient([
    completion(""),
    completion("rewritten query"),
  ])
  const planner = new PlannerImpl(client as OpenAI, "test-model")

  const result = await planner.rewrite({ text: "original" })

  assert.equal(result.query.text, "rewritten query")
})

test("rewrite falls back to original on second empty output (does not throw)", async () => {
  const client = fakeClient([
    completion(""),
    completion(""),
  ])
  const planner = new PlannerImpl(client as OpenAI, "test-model")

  const result = await planner.rewrite({ text: "original query" })

  assert.equal(result.query.text, "original query")
})

test("rewrite retries on choices null", async () => {
  const client = fakeClient([
    completion(null),
    completion("rewritten"),
  ])
  const planner = new PlannerImpl(client as OpenAI, "test-model")

  const result = await planner.rewrite({ text: "original" })

  assert.equal(result.query.text, "rewritten")
})

test("generateHypothesis returns a hypothetical answer with usage", async () => {
  const client = fakeClient([
    completion("The refund policy allows returns within 30 days.", {
      prompt_tokens: 8,
      completion_tokens: 14,
      total_tokens: 22,
    }),
  ])
  const planner = new PlannerImpl(client as OpenAI, "test-model")

  const result = await planner.generateHypothesis({ text: "refund policy" })

  assert.equal(result.text, "The refund policy allows returns within 30 days.")
  assert.deepEqual(result.usage, {
    promptTokens: 8,
    completionTokens: 14,
    totalTokens: 22,
  })
})

test("generateHypothesis retries once on empty output then succeeds", async () => {
  const client = fakeClient([
    completion(""),
    completion("hypothetical answer"),
  ])
  const planner = new PlannerImpl(client as OpenAI, "test-model")

  const result = await planner.generateHypothesis({ text: "query" })

  assert.equal(result.text, "hypothetical answer")
})

test("generateHypothesis falls back to original query text on second empty (does not throw)", async () => {
  const client = fakeClient([
    completion(""),
    completion(""),
  ])
  const planner = new PlannerImpl(client as OpenAI, "test-model")

  const result = await planner.generateHypothesis({ text: "original query" })

  assert.equal(result.text, "original query")
})
