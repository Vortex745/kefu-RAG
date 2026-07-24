import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { DIRECT_REPLY_INSTRUCTIONS } from "./direct_reply_stream"

const SOURCE_PATH = path.join(__dirname, "direct_reply_stream.ts")

test("P1 regression: direct Agent defaults to the Chinese customer-service prompt", () => {
  // T09 refactored DIRECT_REPLY_INSTRUCTIONS to derive the agent identity from
  // SYSTEM_PROMPT instead of hardcoding it. The invariant being tested is that
  // the default prompt is a Chinese customer-service prompt that identifies the
  // agent as a knowledge-base-backed assistant. We check the key phrases rather
  // than an exact string so the test does not break on wording adjustments.
  assert.ok(
    typeof DIRECT_REPLY_INSTRUCTIONS === "string" && DIRECT_REPLY_INSTRUCTIONS.length > 0,
    "DIRECT_REPLY_INSTRUCTIONS must be a non-empty string"
  )
  assert.ok(
    DIRECT_REPLY_INSTRUCTIONS.includes("客服助手"),
    "DIRECT_REPLY_INSTRUCTIONS must identify the agent as a customer-service assistant"
  )
  assert.ok(
    DIRECT_REPLY_INSTRUCTIONS.includes("知识库"),
    "DIRECT_REPLY_INSTRUCTIONS must reference the knowledge base"
  )
  assert.ok(
    DIRECT_REPLY_INSTRUCTIONS.includes("引用证据"),
    "DIRECT_REPLY_INSTRUCTIONS must mention evidence citation"
  )
})

test("P1 regression: direct Agent construction uses the exported default prompt", () => {
  // T09 refactored the variable name from `instructions:` (object property) to
  // `const systemInstructions =` (local variable). The contract being tested
  // is that the default instructions fall back to DIRECT_REPLY_INSTRUCTIONS
  // when no custom instructions are provided.
  const source = readFileSync(SOURCE_PATH, "utf8")
  assert.match(source, /instructions\s*\?\?\s*DIRECT_REPLY_INSTRUCTIONS/)
})
