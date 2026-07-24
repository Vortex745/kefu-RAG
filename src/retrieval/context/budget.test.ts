import assert from "node:assert/strict"
import test from "node:test"

import type { Evidence } from "../../types"
import { CONTEXT_INTRO, CONTEXT_SUFFIX, modelTokenCount } from "./assembler"
import {
  computeContextBudget,
  formatEvidenceBlock,
  type ContextBudgetBreakdown,
} from "./budget"

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

test("formatEvidenceBlock produces [cite:ID] [来源: SOURCE] header + excerpt + trailing newline", () => {
  const ev = makeEvidence({
    id: "ev_abc123",
    source: "FAQ.md",
    excerpt: "退款政策：7天无理由退款。",
  })
  const block = formatEvidenceBlock(ev)
  assert.equal(
    block,
    "[cite:ev_abc123] [来源: FAQ.md]\n退款政策：7天无理由退款。\n"
  )
})

test("formatEvidenceBlock preserves the exact excerpt text without truncation or escaping", () => {
  const ev = makeEvidence({
    id: "ev_special",
    source: "manual.pdf",
    excerpt: "含有特殊字符：[cite:ev_other] 不应被转义。\n\t第二行。",
  })
  const block = formatEvidenceBlock(ev)
  assert.ok(block.includes("[cite:ev_special] [来源: manual.pdf]\n"))
  // The excerpt is embedded verbatim — no escaping, no truncation.
  assert.ok(block.includes("含有特殊字符：[cite:ev_other] 不应被转义。\n\t第二行。\n"))
})

test("computeContextBudget with empty Evidence array returns overhead-only token count and overBudget=false", () => {
  const breakdown = computeContextBudget([], {
    maxContextTokens: 6_000,
    countTokens: (t) => t.length,
  })
  const overhead = (CONTEXT_INTRO + CONTEXT_SUFFIX).length
  assert.equal(breakdown.uncompressedTokens, overhead)
  assert.equal(breakdown.overBudget, false)
  assert.deepEqual(breakdown.evidenceIds, [])
})

test("computeContextBudget with single small Evidence returns overhead + block tokens and overBudget=false", () => {
  const ev = makeEvidence({
    id: "ev_small",
    source: "doc.txt",
    excerpt: "短内容。",
  })
  const breakdown = computeContextBudget([ev], {
    maxContextTokens: 6_000,
    countTokens: (t) => t.length,
  })
  const expected = (CONTEXT_INTRO + CONTEXT_SUFFIX).length
    + formatEvidenceBlock(ev).length
  assert.equal(breakdown.uncompressedTokens, expected)
  assert.equal(breakdown.overBudget, false)
  assert.deepEqual(breakdown.evidenceIds, ["ev_small"])
})

test("computeContextBudget with many large Evidence groups returns overBudget=true", () => {
  const largeExcerpt = "x".repeat(1_000)
  const evidence: Evidence[] = Array.from({ length: 10 }, (_, i) =>
    makeEvidence({
      id: `ev_${i}`,
      source: `doc-${i}.txt`,
      excerpt: largeExcerpt,
    })
  )
  const breakdown = computeContextBudget(evidence, {
    maxContextTokens: 6_000,
    countTokens: (t) => t.length,
  })
  assert.ok(breakdown.overBudget, "10 groups × 1000 chars each > 6000 char budget")
  assert.equal(breakdown.evidenceIds.length, 10)
  assert.deepEqual(
    breakdown.evidenceIds,
    evidence.map((ev) => ev.id)
  )
})

test("computeContextBudget uses default maxContextTokens=6000 when omitted", () => {
  const ev = makeEvidence({
    id: "ev_default_budget",
    source: "doc.txt",
    excerpt: "内容。",
  })
  const breakdown = computeContextBudget([ev])
  assert.equal(breakdown.maxContextTokens, 6_000)
  // Default countTokens is modelTokenCount (UTF-8 byte length for Chinese).
  // The breakdown should use modelTokenCount, not character length.
  const expected = modelTokenCount(CONTEXT_INTRO + CONTEXT_SUFFIX)
    + modelTokenCount(formatEvidenceBlock(ev))
  assert.equal(breakdown.uncompressedTokens, expected)
  assert.equal(breakdown.overBudget, false)
})

test("computeContextBudget boundary: exactly equal to budget → overBudget=false (criterion #1: below or equal bypasses compression)", () => {
  const overhead = (CONTEXT_INTRO + CONTEXT_SUFFIX).length
  const budget = 1_000
  // Construct evidence whose FULL block (header + excerpt + trailing newline)
  // plus overhead exactly equals the budget.
  const ev = makeEvidence({
    id: "ev_boundary",
    source: "s",
    excerpt: "x",
  })
  const headerOverhead = formatEvidenceBlock(ev).length - 1 // block length minus the 1-char excerpt
  const excerptLength = budget - overhead - headerOverhead
  const evExact = makeEvidence({
    id: "ev_boundary",
    source: "s",
    excerpt: "x".repeat(excerptLength),
  })
  const breakdown = computeContextBudget([evExact], {
    maxContextTokens: budget,
    countTokens: (t) => t.length,
  })
  assert.equal(breakdown.uncompressedTokens, budget)
  assert.equal(breakdown.overBudget, false, "exactly equal to budget → NOT over-budget → bypass compression")
})

test("computeContextBudget boundary: one token over budget → overBudget=true", () => {
  const overhead = (CONTEXT_INTRO + CONTEXT_SUFFIX).length
  const budget = 1_000
  const ev = makeEvidence({
    id: "ev_just_over",
    source: "s",
    excerpt: "x",
  })
  const headerOverhead = formatEvidenceBlock(ev).length - 1
  const excerptLength = budget - overhead - headerOverhead + 1 // one char more than boundary
  const evOver = makeEvidence({
    id: "ev_just_over",
    source: "s",
    excerpt: "x".repeat(excerptLength),
  })
  const breakdown = computeContextBudget([evOver], {
    maxContextTokens: budget,
    countTokens: (t) => t.length,
  })
  assert.equal(breakdown.uncompressedTokens, budget + 1)
  assert.equal(breakdown.overBudget, true, "one token over budget → over-budget → trigger compression")
})

test("computeContextBudget with custom countTokens function uses it for both overhead and block tokens", () => {
  const ev = makeEvidence({
    id: "ev_custom_counter",
    source: "doc.txt",
    excerpt: "hello world",
  })
  let callCount = 0
  const customCounter = (text: string): number => {
    callCount += 1
    return text.split(/\s+/).filter(Boolean).length
  }
  const breakdown = computeContextBudget([ev], {
    maxContextTokens: 10,
    countTokens: customCounter,
  })
  assert.ok(callCount > 0, "custom counter was called")
  // Words in INTRO + SUFFIX + one block.
  const expected = customCounter(CONTEXT_INTRO + CONTEXT_SUFFIX)
    + customCounter(formatEvidenceBlock(ev))
  assert.equal(breakdown.uncompressedTokens, expected)
})
