import assert from "node:assert/strict"
import test from "node:test"
import type OpenAI from "openai"

import type { Evidence } from "../types"
import { CONTEXT_INTRO, CONTEXT_SUFFIX } from "../retrieval/context/assembler"
import {
  formatEvidenceBlock,
  computeContextBudget,
} from "../retrieval/context/budget"
import {
  ContextCompressorImpl,
  type ContextCompressor,
} from "./context_compressor"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEvidence(overrides: Partial<Evidence> & Pick<Evidence, "id" | "source" | "excerpt">): Evidence {
  return {
    documentId: `doc-${overrides.id}`,
    documentVersionId: `doc-${overrides.id}`,
    documentVersion: 1,
    chunkId: `chunk-${overrides.id}`,
    title: `Title ${overrides.id}`,
    channels: ["vector"],
    score: 1,
    wikilinks: [],
    ...overrides,
  }
}

interface MockChatCompletion {
  content: string
  usage?: OpenAI.Chat.Completions.ChatCompletion["usage"]
}

function createMockClient(responses: MockChatCompletion[]): OpenAI {
  let callIndex = 0
  return {
    chat: {
      completions: {
        create: async () => {
          const response = responses[Math.min(callIndex, responses.length - 1)]
          callIndex += 1
          return {
            choices: [
              {
                message: { role: "assistant", content: response.content },
                finish_reason: "stop",
                index: 0,
              },
            ],
            usage: response.usage,
            id: `mock-${callIndex}`,
            model: "mock-model",
            object: "chat.completion",
            created: 0,
          } as unknown as OpenAI.Chat.Completions.ChatCompletion
        },
      },
    },
  } as unknown as OpenAI
}

function createMockClientThatThrows(error: Error): OpenAI {
  return {
    chat: {
      completions: {
        create: async () => {
          throw error
        },
      },
    },
  } as unknown as OpenAI
}

// ---------------------------------------------------------------------------
// Tests — bypass when under-budget
// ---------------------------------------------------------------------------

test("compress returns null when uncompressed context fits the budget (bypass — criterion #1)", async () => {
  const evidence = [
    makeEvidence({ id: "ev_001", source: "doc.txt", excerpt: "短内容。" }),
  ]
  const budget = 6_000
  const client = createMockClient([{ content: "压缩后的内容。" }])
  const compressor = new ContextCompressorImpl(client, "mock-model")
  const result = await compressor.compress(evidence, "问题", { maxContextTokens: budget }, undefined)
  assert.equal(result, null, "under-budget → bypass compression → null")
})

// ---------------------------------------------------------------------------
// Tests — basic compression success path
// ---------------------------------------------------------------------------

test("compress returns a result with compressed blocks when over-budget (criterion #2 + #3)", async () => {
  const evidence = [
    makeEvidence({
      id: "ev_001",
      source: "doc.txt",
      excerpt: "x".repeat(10_000), // large excerpt → over-budget
    }),
  ]
  const client = createMockClient([{ content: "压缩后的关键事实。" }])
  const compressor = new ContextCompressorImpl(client, "mock-model")
  const result = await compressor.compress(
    evidence,
    "问题",
    { maxContextTokens: 6_000 },
    undefined
  )
  assert.ok(result, "over-budget → compression attempted → non-null result")
  assert.ok(result.context.startsWith(CONTEXT_INTRO), "context starts with INTRO")
  assert.ok(result.context.endsWith(CONTEXT_SUFFIX), "context ends with SUFFIX")
  assert.ok(
    result.context.includes("[cite:ev_001] [来源: doc.txt]"),
    "compressed context contains the deterministic header for ev_001"
  )
  assert.ok(
    result.context.includes("压缩后的关键事实。"),
    "compressed context contains the LLM-produced body"
  )
  assert.deepEqual(result.retainedEvidenceIds, ["ev_001"])
  assert.deepEqual(result.droppedEvidenceIds, [])
  assert.ok(result.outputTokens <= 6_000, "compressed output fits within budget")
  assert.ok(result.outputTokens < result.inputTokens, "compressed output is smaller than uncompressed input")
})

// ---------------------------------------------------------------------------
// Tests — per-Evidence-group compression (no provenance merging)
// ---------------------------------------------------------------------------

test("compress compresses each Evidence group independently — each block has its own deterministic header (criterion #2)", async () => {
  const evidence = [
    makeEvidence({ id: "ev_001", source: "doc-a.txt", excerpt: "x".repeat(10_000) }),
    makeEvidence({ id: "ev_002", source: "doc-b.txt", excerpt: "y".repeat(10_000) }),
  ]
  const client = createMockClient([
    { content: "压缩后的内容A。" },
    { content: "压缩后的内容B。" },
  ])
  const compressor = new ContextCompressorImpl(client, "mock-model")
  const result = await compressor.compress(evidence, "问题", { maxContextTokens: 6_000 }, undefined)
  assert.ok(result)
  assert.ok(result.context.includes("[cite:ev_001] [来源: doc-a.txt]"), "block 1 has its own header")
  assert.ok(result.context.includes("[cite:ev_002] [来源: doc-b.txt]"), "block 2 has its own header")
  assert.deepEqual(result.retainedEvidenceIds, ["ev_001", "ev_002"])
  assert.deepEqual(result.droppedEvidenceIds, [])
})

// ---------------------------------------------------------------------------
// Tests — per-group failure handling
// ---------------------------------------------------------------------------

test("compress records a group as dropped when its LLM call returns empty content (criterion #5)", async () => {
  const evidence = [
    makeEvidence({ id: "ev_001", source: "doc-a.txt", excerpt: "x".repeat(10_000) }),
    makeEvidence({ id: "ev_002", source: "doc-b.txt", excerpt: "y".repeat(10_000) }),
  ]
  const client = createMockClient([
    { content: "压缩后的内容A。" },
    { content: "" }, // empty content → group dropped
  ])
  const compressor = new ContextCompressorImpl(client, "mock-model")
  const result = await compressor.compress(evidence, "问题", { maxContextTokens: 6_000 }, undefined)
  assert.ok(result)
  assert.deepEqual(result.retainedEvidenceIds, ["ev_001"])
  assert.deepEqual(result.droppedEvidenceIds, ["ev_002"])
  assert.ok(result.context.includes("[cite:ev_001]"), "retained group's block is present")
  assert.ok(!result.context.includes("[cite:ev_002]"), "dropped group's block is absent")
})

test("compress returns null when ALL groups fail (full discard — deterministic fallback, criterion #5)", async () => {
  const evidence = [
    makeEvidence({ id: "ev_001", source: "doc-a.txt", excerpt: "x".repeat(10_000) }),
    makeEvidence({ id: "ev_002", source: "doc-b.txt", excerpt: "y".repeat(10_000) }),
  ]
  const client = createMockClient([
    { content: "" }, // group 1 fails
    { content: "" }, // group 2 fails
  ])
  const compressor = new ContextCompressorImpl(client, "mock-model")
  const result = await compressor.compress(evidence, "问题", { maxContextTokens: 6_000 }, undefined)
  assert.equal(result, null, "all groups failed → null → deterministic fallback")
})

// ---------------------------------------------------------------------------
// Tests — unknown Evidence ID validation
// ---------------------------------------------------------------------------

test("compress returns null when the LLM-produced content contains an unknown [cite:ev_XXX] marker (criterion #4)", async () => {
  const evidence = [
    makeEvidence({ id: "ev_001", source: "doc-a.txt", excerpt: "x".repeat(10_000) }),
  ]
  const client = createMockClient([
    { content: "压缩后的内容 [cite:ev_unknown] 不应出现。" }, // contains unknown citation
  ])
  const compressor = new ContextCompressorImpl(client, "mock-model")
  const result = await compressor.compress(evidence, "问题", { maxContextTokens: 6_000 }, undefined)
  assert.equal(result, null, "LLM content contains [cite:ev_XXX] → group fails → validation failure → null")
})

// ---------------------------------------------------------------------------
// Tests — AbortError propagation
// ---------------------------------------------------------------------------

test("compress re-throws AbortError when the LLM call is aborted (user-cancellation preserved)", async () => {
  const evidence = [
    makeEvidence({ id: "ev_001", source: "doc-a.txt", excerpt: "x".repeat(10_000) }),
  ]
  const abortError = new Error("Aborted")
  abortError.name = "AbortError"
  const client = createMockClientThatThrows(abortError)
  const compressor = new ContextCompressorImpl(client, "mock-model")
  await assert.rejects(
    () => compressor.compress(evidence, "问题", { maxContextTokens: 6_000 }, undefined),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
    "AbortError should be re-thrown, not swallowed"
  )
})

test("compress swallows non-AbortError exceptions and records the group as dropped (criterion #5)", async () => {
  const evidence = [
    makeEvidence({ id: "ev_001", source: "doc-a.txt", excerpt: "x".repeat(10_000) }),
    makeEvidence({ id: "ev_002", source: "doc-b.txt", excerpt: "y".repeat(10_000) }),
  ]
  const providerError = new Error("OpenAI provider timeout")
  const client = createMockClientThatThrows(providerError)
  const compressor = new ContextCompressorImpl(client, "mock-model")
  const result = await compressor.compress(evidence, "问题", { maxContextTokens: 6_000 }, undefined)
  assert.equal(result, null, "all groups threw non-AbortError → all dropped → null → deterministic fallback")
})

// ---------------------------------------------------------------------------
// Tests — still-over-budget fallback
// ---------------------------------------------------------------------------

test("compress returns null when the compressed total still exceeds the budget (deterministic fallback)", async () => {
  const evidence = Array.from({ length: 50 }, (_, i) =>
    makeEvidence({
      id: `ev_${String(i).padStart(3, "0")}`,
      source: `doc-${i}.txt`,
      excerpt: "x".repeat(2_000),
    })
  )
  // Each group produces a large compressed block → total still exceeds budget
  const largeCompressed = "z".repeat(500)
  const client = createMockClient(evidence.map(() => ({ content: largeCompressed })))
  const compressor = new ContextCompressorImpl(client, "mock-model", 600)
  const result = await compressor.compress(evidence, "问题", { maxContextTokens: 6_000 }, undefined)
  // 50 groups × (header + 500 chars + newline) > 6000 → still over budget → null
  assert.equal(result, null, "compressed total still exceeds budget → null → deterministic fallback")
})

// ---------------------------------------------------------------------------
// Tests — context structure (INTRO + blocks + SUFFIX)
// ---------------------------------------------------------------------------

test("compress assembles context with INTRO prefix, compressed blocks, and SUFFIX suffix", async () => {
  const evidence = [
    makeEvidence({ id: "ev_001", source: "doc-a.txt", excerpt: "x".repeat(10_000) }),
    makeEvidence({ id: "ev_002", source: "doc-b.txt", excerpt: "y".repeat(10_000) }),
  ]
  const client = createMockClient([
    { content: "压缩后A。" },
    { content: "压缩后B。" },
  ])
  const compressor = new ContextCompressorImpl(client, "mock-model")
  const result = await compressor.compress(evidence, "问题", { maxContextTokens: 6_000 }, undefined)
  assert.ok(result)
  assert.ok(result.context.startsWith(CONTEXT_INTRO))
  assert.ok(result.context.endsWith(CONTEXT_SUFFIX))
  // Each block has the deterministic header + compressed content + trailing newline
  const block1 = "[cite:ev_001] [来源: doc-a.txt]\n压缩后A。\n"
  const block2 = "[cite:ev_002] [来源: doc-b.txt]\n压缩后B。\n"
  assert.ok(result.context.includes(block1), `context should contain block 1:\n${block1}`)
  assert.ok(result.context.includes(block2), `context should contain block 2:\n${block2}`)
})

// ---------------------------------------------------------------------------
// Tests — token usage aggregation
// ---------------------------------------------------------------------------

test("compress aggregates token usage from all per-group LLM calls", async () => {
  const evidence = [
    makeEvidence({ id: "ev_001", source: "doc-a.txt", excerpt: "x".repeat(10_000) }),
    makeEvidence({ id: "ev_002", source: "doc-b.txt", excerpt: "y".repeat(10_000) }),
  ]
  const client = createMockClient([
    { content: "压缩后A。", usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
    { content: "压缩后B。", usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 } },
  ])
  const compressor = new ContextCompressorImpl(client, "mock-model")
  const result = await compressor.compress(evidence, "问题", { maxContextTokens: 6_000 }, undefined)
  assert.ok(result)
  assert.ok(result.usage, "aggregated usage should be present")
  assert.equal(result.usage!.promptTokens, 300, "100 + 200 = 300")
  assert.equal(result.usage!.completionTokens, 30, "10 + 20 = 30")
  assert.equal(result.usage!.totalTokens, 330, "110 + 220 = 330")
})

test("compress returns usage as undefined when the LLM response has no usage field", async () => {
  const evidence = [
    makeEvidence({ id: "ev_001", source: "doc-a.txt", excerpt: "x".repeat(10_000) }),
  ]
  const client = createMockClient([{ content: "压缩后A。", usage: undefined }])
  const compressor = new ContextCompressorImpl(client, "mock-model")
  const result = await compressor.compress(evidence, "问题", { maxContextTokens: 6_000 }, undefined)
  assert.ok(result)
  assert.equal(result.usage, undefined, "no usage field → undefined")
})