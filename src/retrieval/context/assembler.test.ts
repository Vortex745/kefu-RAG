import assert from "node:assert/strict"
import test from "node:test"
import type { Chunk, RetrievalResult } from "../../types"
import { ContextAssemblerImpl } from "./assembler"

function child(id: string, parent: Chunk): RetrievalResult {
  return {
    chunk: {
      id,
      documentId: parent.documentId,
      parentId: parent.id,
      content: `child-${id}`,
      childrenIds: [],
      metadata: { source: "policy.md", kind: "child" },
    },
    parentChunk: parent,
    score: 1,
    source: "vector",
    wikilinks: [],
  }
}

test("context deduplicates parent expansion while preserving child citations", async () => {
  const parent: Chunk = {
    id: "parent-1",
    documentId: "doc-1",
    content: "完整父级退款政策",
    childrenIds: ["child-1", "child-2"],
    metadata: { source: "policy.md", kind: "parent" },
  }
  const first = child("child-1", parent)
  const second = child("child-2", parent)
  const context = await new ContextAssemblerImpl().assemble(
    [first, second],
    new Map([
      ["doc-1\0child-1", "ev-child-1"],
      ["doc-1\0child-2", "ev-child-2"],
    ])
  )

  assert.equal(context.match(/完整父级退款政策/g)?.length, 1)
  assert.match(context, /\[cite:ev-child-1\] \[cite:ev-child-2\]/)
  assert.equal(context.includes("child-child-1"), false)
})

test("parent expansion keeps the matched child inside a bounded context window", async () => {
  const evidence = "命中的退款证据必须保留"
  const parent: Chunk = {
    id: "parent-long",
    documentId: "doc-long",
    content: `${"前置无关内容".repeat(1_200)}${evidence}${"后置无关内容".repeat(1_200)}`,
    childrenIds: ["child-hit"],
    metadata: { source: "long.md", kind: "parent" },
  }
  const result = child("child-hit", parent)
  result.chunk.content = evidence
  const context = await new ContextAssemblerImpl().assemble(
    [result],
    new Map([["doc-long\0child-hit", "ev-hit"]])
  )

  assert.match(context, /\[cite:ev-hit\]/)
  assert.equal(context.includes(evidence), true)
  assert.equal(context.length < parent.content.length, true)
})

test("context budget counts wrappers and uses the configured token counter", async () => {
  const parent: Chunk = {
    id: "parent-budget",
    documentId: "doc-budget",
    content: "预算证据".repeat(500),
    childrenIds: ["child-budget"],
    metadata: { source: "budget.md", kind: "parent" },
  }
  const result = child("child-budget", parent)
  result.chunk.content = "预算证据".repeat(20)
  const assembler = new ContextAssemblerImpl({
    maxContextTokens: 220,
    maxParentTokens: 100,
    countTokens: (text) => text.length,
  })
  const context = await assembler.assemble(
    [result],
    new Map([["doc-budget\0child-budget", "ev-budget"]])
  )

  assert.equal(context.length <= 220, true)
  assert.match(context, /\[cite:ev-budget\]/)
  assert.equal(context.includes("预算证据"), true)
})

test("citations are emitted only for child evidence fully included in the window", async () => {
  const firstEvidence = "甲".repeat(80)
  const secondEvidence = "乙".repeat(80)
  const parent: Chunk = {
    id: "parent-two-children",
    documentId: "doc-two-children",
    content: `${firstEvidence}\n${secondEvidence}`,
    childrenIds: ["child-first", "child-second"],
    metadata: { source: "two.md", kind: "parent" },
  }
  const first = child("child-first", parent)
  first.chunk.content = firstEvidence
  const second = child("child-second", parent)
  second.chunk.content = secondEvidence
  const context = await new ContextAssemblerImpl({
    maxContextTokens: 400,
    maxParentTokens: 100,
    countTokens: (text) => text.length,
  }).assemble(
    [first, second],
    new Map([
      ["doc-two-children\0child-first", "ev-first"],
      ["doc-two-children\0child-second", "ev-second"],
    ])
  )

  assert.match(context, /\[cite:ev-first\]/)
  assert.equal(context.includes("[cite:ev-second]"), false)
  assert.equal(context.includes(firstEvidence), true)
  assert.equal(context.includes(secondEvidence), false)
})

test("the default budget preserves one maximum-size CJK child", async () => {
  const evidence = "证".repeat(1_500)
  const parent: Chunk = {
    id: "parent-max-cjk",
    documentId: "doc-max-cjk",
    content: evidence,
    childrenIds: ["child-max-cjk"],
    metadata: { source: "cjk.md", kind: "parent" },
  }
  const result = child("child-max-cjk", parent)
  result.chunk.content = evidence
  const context = await new ContextAssemblerImpl().assemble(
    [result],
    new Map([["doc-max-cjk\0child-max-cjk", "ev-max-cjk"]])
  )

  assert.match(context, /\[cite:ev-max-cjk\]/)
  assert.equal(context.includes(evidence), true)
})
