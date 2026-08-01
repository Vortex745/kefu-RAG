import assert from "node:assert/strict"
import test from "node:test"
import type OpenAI from "openai"
import type { RetrievalResult } from "../../types"
import { rerank } from "./reranker"

function makeResult(id: string): RetrievalResult {
  return {
    chunk: {
      documentId: "doc-1",
      id,
      content: `content-${id}`,
      childrenIds: [],
      metadata: { kind: "child" },
    },
    score: 1,
    source: "vector",
    wikilinks: [],
  }
}

function makeClient(capture: (options: { signal?: AbortSignal }) => void): OpenAI {
  return {
    chat: {
      completions: {
        create: async (_body: unknown, options?: { signal?: AbortSignal }) => {
          // Mirror the OpenAI SDK: an already-aborted signal rejects the
          // request with an AbortError before any network I/O.
          if (options?.signal?.aborted) {
            const error = new Error("Request was aborted")
            error.name = "AbortError"
            throw error
          }
          capture(options ?? {})
          return {
            choices: [{ message: { content: "5" } }],
          }
        },
      },
    },
  } as unknown as OpenAI
}

test("rerank returns results unchanged when 3 or fewer results", async () => {
  const results = [makeResult("a"), makeResult("b"), makeResult("c")]
  let createCalled = false
  const out = await rerank(makeClient(() => { createCalled = true }), "model", "q", results)
  assert.equal(out, results, "no rerank for <= 3 results")
  assert.equal(createCalled, false, "no LLM call for <= 3 results")
})

test("rerank forwards an external signal to every per-result LLM call", async () => {
  const signals: Array<AbortSignal | undefined> = []
  const results = [makeResult("a"), makeResult("b"), makeResult("c"), makeResult("d")]
  const controller = new AbortController()
  await rerank(makeClient(({ signal }) => signals.push(signal)), "model", "q", results, controller.signal)
  assert.equal(signals.length, 4, "one LLM call per result")
  for (const signal of signals) {
    assert.ok(signal instanceof AbortSignal, "signal forwarded to each call")
    assert.equal(signal.aborted, false, "signal not aborted on happy path")
  }
})

test("rerank rejects when the external signal is already aborted", async () => {
  const results = [makeResult("a"), makeResult("b"), makeResult("c"), makeResult("d")]
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    rerank(makeClient(() => {}), "model", "q", results, controller.signal),
    /aborted|Abort/i,
    "already-aborted external signal must reject rerank"
  )
})

test("rerank rejects when the external signal aborts mid-flight", async () => {
  const results = [makeResult("a"), makeResult("b"), makeResult("c"), makeResult("d")]
  const controller = new AbortController()
  const pending = rerank(
    {
      chat: {
        completions: {
          create: async (_body: unknown, options?: { signal?: AbortSignal }) => {
            await new Promise<void>((resolve, reject) => {
              // Mirror the OpenAI SDK: an abort mid-request rejects with
              // AbortError; a hanging provider would never settle.
              options?.signal?.addEventListener("abort", () => {
                const error = new Error("Request was aborted")
                error.name = "AbortError"
                reject(error)
              }, { once: true })
              setTimeout(() => {
                resolve()
              }, 10_000)
            })
            return { choices: [{ message: { content: "5" } }] }
          },
        },
      },
    } as unknown as OpenAI,
    "model",
    "q",
    results,
    controller.signal
  )
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(pending, /aborted|Abort/i, "mid-flight abort must reject rerank")
})

test("rerank sorts results by descending LLM score", async () => {
  const results = [makeResult("a"), makeResult("b"), makeResult("c"), makeResult("d")]
  let call = 0
  const out = await rerank(
    {
      chat: {
        completions: {
          create: async () => {
            const scores = ["3", "9", "5", "1"]
            return { choices: [{ message: { content: scores[call++] } }] }
          },
        },
      },
    } as unknown as OpenAI,
    "model",
    "q",
    results
  )
  assert.deepEqual(
    out.map((r) => r.chunk.id),
    ["b", "c", "a", "d"],
    "sorted by score descending"
  )
})
