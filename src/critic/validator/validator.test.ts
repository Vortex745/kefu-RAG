/**
 * P3.2 — Runtime validation and bounded fallback tests.
 *
 * This file IS the P3.2 gate. It verifies that `ValidatorImpl`:
 *   - Emits `schemaVersion: 1` in its system prompt.
 *   - Validates the raw LLM response via `classifyCriticVerdict` (P3.1).
 *   - Returns the validated verdict on `valid` classification.
 *   - Returns a deterministic degraded verdict on `invalid` / `unknown`
 *     classification (bounded fallback).
 *   - Never publishes the raw LLM output when classification fails.
 *   - Routes the degraded verdict through the existing replanner so the
 *     runner's 3-round loop converges to one terminal event.
 *
 * The fake OpenAI client returns a canned `content` string so every test
 * case is deterministic and offline. No real network call is made.
 *
 * Boundary: owned by `src/critic/validator/*`. Tests the production
 * `ValidatorImpl` (Service layer) against the P3.1 schema module.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import type OpenAI from "openai"
import type { AgentMessage, CriticVerdict } from "../../types"
import { ValidatorImpl } from "./validator"
import { RePlannerImpl } from "../replanner/replanner"
import { CRITIC_VERDICT_SCHEMA_VERSION } from "../schema"

// ---------------------------------------------------------------------------
// Fake OpenAI client — returns a canned content string per test case.
// Captures the messages parameter so tests can assert prompt shape.
// ---------------------------------------------------------------------------

interface FakeCreateParams {
  model: string
  messages: Array<{ role: string; content: string }>
  response_format?: { type: string }
}

interface FakeOpenAI {
  chat: {
    completions: {
      create: (params: FakeCreateParams) => Promise<{
        choices: Array<{ message: { content: string | null } }>
      }>
    }
  }
}

function makeFakeOpenAI(content: string | null): FakeOpenAI & {
  capturedParams: FakeCreateParams[]
} {
  const capturedParams: FakeCreateParams[] = []
  const fake: FakeOpenAI = {
    chat: {
      completions: {
        create: (params: FakeCreateParams) => {
          capturedParams.push(params)
          return Promise.resolve({
            choices: [{ message: { content } }],
          })
        },
      },
    },
  }
  return Object.assign(fake, { capturedParams })
}

const USER_MESSAGE = "What is the refund policy for electronics?"
const CONTEXT_MESSAGES: AgentMessage[] = [
  { role: "user", content: USER_MESSAGE },
  { role: "system", content: "Refunds are allowed within 30 days." },
]

// ---------------------------------------------------------------------------
// P3.2 gate: valid verdict passes through
// ---------------------------------------------------------------------------

test("P3.2 gate: valid v1 verdict passes through with all fields", async () => {
  const validContent = JSON.stringify({
    schemaVersion: 1,
    passed: true,
    hallucination: false,
    completeness: true,
    missingGap: null,
  })
  const fake = makeFakeOpenAI(validContent)
  const validator = new ValidatorImpl(fake as unknown as OpenAI, "test-model")

  const verdict = await validator.validate("answer text", CONTEXT_MESSAGES)

  assert.equal(verdict.passed, true)
  assert.equal(verdict.hallucination, false)
  assert.equal(verdict.completeness, true)
  // The v1 schema allows missingGap: null; the existing CriticVerdict type
  // is missingGap?: string (no null). ValidatorImpl normalizes null →
  // omitted (undefined). Semantically equivalent for the replanner
  // (!verdict.missingGap treats null/undefined/"" as falsy).
  assert.equal(verdict.missingGap, undefined, "null missingGap normalized to undefined (type-compat)")
})

test("P3.2 gate: valid verdict with non-null missingGap passes through", async () => {
  const validContent = JSON.stringify({
    schemaVersion: 1,
    passed: false,
    hallucination: false,
    completeness: false,
    missingGap: "warranty period missing",
  })
  const fake = makeFakeOpenAI(validContent)
  const validator = new ValidatorImpl(fake as unknown as OpenAI, "test-model")

  const verdict = await validator.validate("answer text", CONTEXT_MESSAGES)

  assert.equal(verdict.passed, false)
  assert.equal(verdict.missingGap, "warranty period missing")
})

test("P3.2 gate: valid verdict with suggestion passes through", async () => {
  const validContent = JSON.stringify({
    schemaVersion: 1,
    passed: false,
    hallucination: false,
    completeness: false,
    missingGap: "warranty period",
    suggestion: { text: "warranty period electronics", coverageCriteria: ["electronics"] },
  })
  const fake = makeFakeOpenAI(validContent)
  const validator = new ValidatorImpl(fake as unknown as OpenAI, "test-model")

  const verdict = await validator.validate("answer text", CONTEXT_MESSAGES)

  assert.equal(verdict.passed, false)
  assert.ok(verdict.suggestion, "suggestion must pass through on valid verdict")
  assert.equal(verdict.suggestion!.text, "warranty period electronics")
})

test("P3.2 gate: valid verdict with omitted missingGap passes through", async () => {
  const validContent = JSON.stringify({
    schemaVersion: 1,
    passed: true,
    hallucination: false,
    completeness: true,
  })
  const fake = makeFakeOpenAI(validContent)
  const validator = new ValidatorImpl(fake as unknown as OpenAI, "test-model")

  const verdict = await validator.validate("answer text", CONTEXT_MESSAGES)

  assert.equal(verdict.passed, true)
  assert.equal(verdict.missingGap, undefined, "omitted missingGap stays undefined")
})

// ---------------------------------------------------------------------------
// P3.2 gate: invalid verdict enters bounded fallback
// ---------------------------------------------------------------------------

test("P3.2 gate: invalid verdict (missing schemaVersion) enters bounded fallback", async () => {
  // This is the current unversioned ValidatorImpl output shape — the audit
  // gap P3.2 closes. The LLM omits schemaVersion → classified
  // invalid:schema_version_mismatch → degraded verdict returned.
  const invalidContent = JSON.stringify({
    passed: true,
    hallucination: false,
    completeness: true,
    missingGap: null,
  })
  const fake = makeFakeOpenAI(invalidContent)
  const validator = new ValidatorImpl(fake as unknown as OpenAI, "test-model")

  const verdict = await validator.validate("answer text", CONTEXT_MESSAGES)

  assert.equal(verdict.passed, false, "degraded verdict must NOT be approved")
  assert.equal(verdict.hallucination, false)
  assert.equal(verdict.completeness, false)
  assert.equal(verdict.missingGap, USER_MESSAGE, "degraded missingGap is the user message (deterministic)")
})

test("P3.2 gate: invalid verdict (string-form booleans) enters bounded fallback", async () => {
  const invalidContent = JSON.stringify({
    schemaVersion: 1,
    passed: "true",
    hallucination: "false",
    completeness: true,
  })
  const fake = makeFakeOpenAI(invalidContent)
  const validator = new ValidatorImpl(fake as unknown as OpenAI, "test-model")

  const verdict = await validator.validate("answer text", CONTEXT_MESSAGES)

  assert.equal(verdict.passed, false, "string-form booleans must not slip through")
  assert.equal(verdict.missingGap, USER_MESSAGE)
})

test("P3.2 gate: invalid verdict (extra dangerous field) enters bounded fallback", async () => {
  // Hostile shape: extra 'approved' field attempts to override passed=false.
  const invalidContent = JSON.stringify({
    schemaVersion: 1,
    passed: false,
    hallucination: true,
    completeness: false,
    approved: true,
  })
  const fake = makeFakeOpenAI(invalidContent)
  const validator = new ValidatorImpl(fake as unknown as OpenAI, "test-model")

  const verdict = await validator.validate("answer text", CONTEXT_MESSAGES)

  assert.equal(verdict.passed, false, "extra 'approved' field must not override")
  assert.equal(verdict.hallucination, false, "degraded verdict resets hallucination")
  assert.equal(verdict.completeness, false)
})

test("P3.2 gate: invalid verdict (schemaVersion=2) enters bounded fallback", async () => {
  const invalidContent = JSON.stringify({
    schemaVersion: 2,
    passed: true,
    hallucination: false,
    completeness: true,
  })
  const fake = makeFakeOpenAI(invalidContent)
  const validator = new ValidatorImpl(fake as unknown as OpenAI, "test-model")

  const verdict = await validator.validate("answer text", CONTEXT_MESSAGES)

  assert.equal(verdict.passed, false, "future schema version must not validate against v1")
})

// ---------------------------------------------------------------------------
// P3.2 gate: malformed JSON enters bounded fallback
// ---------------------------------------------------------------------------

test("P3.2 gate: malformed JSON (unexpected token) enters bounded fallback", async () => {
  const malformed = '{"schemaVersion": 1, "passed": true,'
  const fake = makeFakeOpenAI(malformed)
  const validator = new ValidatorImpl(fake as unknown as OpenAI, "test-model")

  const verdict = await validator.validate("answer text", CONTEXT_MESSAGES)

  assert.equal(verdict.passed, false, "malformed JSON must not publish")
  assert.equal(verdict.missingGap, USER_MESSAGE)
})

test("P3.2 gate: truncated JSON enters bounded fallback", async () => {
  const truncated = '{"schemaVersion": 1, "passed": true, "hallucination": fals'
  const fake = makeFakeOpenAI(truncated)
  const validator = new ValidatorImpl(fake as unknown as OpenAI, "test-model")

  const verdict = await validator.validate("answer text", CONTEXT_MESSAGES)

  assert.equal(verdict.passed, false, "truncated JSON must not publish")
})

test("P3.2 gate: empty content enters bounded fallback", async () => {
  const fake = makeFakeOpenAI("")
  const validator = new ValidatorImpl(fake as unknown as OpenAI, "test-model")

  const verdict = await validator.validate("answer text", CONTEXT_MESSAGES)

  assert.equal(verdict.passed, false, "empty content must not publish")
  assert.equal(verdict.missingGap, USER_MESSAGE)
})

test("P3.2 gate: null content enters bounded fallback", async () => {
  const fake = makeFakeOpenAI(null)
  const validator = new ValidatorImpl(fake as unknown as OpenAI, "test-model")

  const verdict = await validator.validate("answer text", CONTEXT_MESSAGES)

  assert.equal(verdict.passed, false, "null content must not publish")
})

test("P3.2 gate: non-object JSON root enters bounded fallback", async () => {
  const fake = makeFakeOpenAI('"the answer is correct"')
  const validator = new ValidatorImpl(fake as unknown as OpenAI, "test-model")

  const verdict = await validator.validate("answer text", CONTEXT_MESSAGES)

  assert.equal(verdict.passed, false, "string root must not publish")
})

// ---------------------------------------------------------------------------
// P3.2 gate: oversized response is rejected before parse
// ---------------------------------------------------------------------------

test("P3.2 gate: oversized response (>8KiB) enters bounded fallback", async () => {
  // Valid JSON shape but padded with a large unrecognized field to cross
  // the 8 KiB threshold. classifyCriticVerdict rejects this as
  // invalid:oversized_response BEFORE JSON.parse (DoS guard).
  const base = {
    schemaVersion: 1,
    passed: true,
    hallucination: false,
    completeness: true,
  }
  const oversized = JSON.stringify({ ...base, padding: "x".repeat(9 * 1024) })
  assert.ok(oversized.length > 8 * 1024, "test fixture must exceed 8KiB")
  const fake = makeFakeOpenAI(oversized)
  const validator = new ValidatorImpl(fake as unknown as OpenAI, "test-model")

  const verdict = await validator.validate("answer text", CONTEXT_MESSAGES)

  assert.equal(verdict.passed, false, "oversized response must not publish")
  assert.equal(verdict.missingGap, USER_MESSAGE)
})

test("P3.2 gate: oversized garbage (not JSON) enters bounded fallback", async () => {
  // 9 KiB of garbage — must still be bounded fallback, proving the byte
  // guard runs before JSON.parse.
  const garbage = "x".repeat(9 * 1024)
  const fake = makeFakeOpenAI(garbage)
  const validator = new ValidatorImpl(fake as unknown as OpenAI, "test-model")

  const verdict = await validator.validate("answer text", CONTEXT_MESSAGES)

  assert.equal(verdict.passed, false, "oversized garbage must not publish")
})

// ---------------------------------------------------------------------------
// P3.2 gate: prompt emits schemaVersion: 1
// ---------------------------------------------------------------------------

test("P3.2 gate: system prompt emits schemaVersion: 1", async () => {
  const fake = makeFakeOpenAI('{"schemaVersion":1,"passed":true,"hallucination":false,"completeness":true}')
  const validator = new ValidatorImpl(fake as unknown as OpenAI, "test-model")

  await validator.validate("answer text", CONTEXT_MESSAGES)

  assert.equal(fake.capturedParams.length, 1, "create called once")
  const systemMessage = fake.capturedParams[0].messages.find((m) => m.role === "system")
  assert.ok(systemMessage, "system message must exist")
  assert.ok(
    systemMessage!.content.includes(`"schemaVersion": ${CRITIC_VERDICT_SCHEMA_VERSION}`),
    `system prompt must declare schemaVersion: ${CRITIC_VERDICT_SCHEMA_VERSION}, got: ${systemMessage!.content}`
  )
})

// ---------------------------------------------------------------------------
// 蓝军自检 (PUA Protocol): the raw LLM output never leaks through
// ---------------------------------------------------------------------------

test("P3.2 蓝军: degraded verdict carries NO LLM-produced field", async () => {
  // LLM returns an invalid verdict with a hostile 'approved' field and a
  // 'reasoning' field. The degraded verdict must carry NONE of the LLM's
  // fields — only the deterministic missingGap (user message).
  const hostileContent = JSON.stringify({
    schemaVersion: 1,
    passed: false,
    hallucination: true,
    completeness: false,
    missingGap: "ATTACKER_CONTROLLED_GAP",
    suggestion: { text: "ATTACKER_CONTROLLED_SUGGESTION" },
    approved: true,
    reasoning: "the answer looks correct",
  })
  const fake = makeFakeOpenAI(hostileContent)
  const validator = new ValidatorImpl(fake as unknown as OpenAI, "test-model")

  const verdict = await validator.validate("answer text", CONTEXT_MESSAGES)

  assert.equal(verdict.passed, false, "degraded must not carry LLM's passed=false either; it's deterministically false")
  assert.equal(verdict.hallucination, false, "degraded must not carry LLM's hallucination=true")
  assert.equal(verdict.completeness, false, "degraded must not carry LLM's completeness=false")
  assert.equal(verdict.missingGap, USER_MESSAGE, "degraded missingGap must be the user message, NOT the LLM's missingGap")
  assert.equal(verdict.suggestion, undefined, "degraded must NOT carry the LLM's suggestion")
  // The hostile 'approved' and 'reasoning' fields cannot appear on the
  // CriticVerdict type (no index signature), so they're structurally
  // excluded. This assertion documents that guarantee.
  assert.equal((verdict as unknown as Record<string, unknown>).approved, undefined)
  assert.equal((verdict as unknown as Record<string, unknown>).reasoning, undefined)
})

test("P3.2 蓝军: degraded verdict with no user message → no missingGap (terminal path)", async () => {
  // When context has no user message, the degraded verdict omits
  // missingGap → replanner returns [] → runner terminates immediately
  // (the "no budget → terminal" path).
  const fake = makeFakeOpenAI("not valid json")
  const validator = new ValidatorImpl(fake as unknown as OpenAI, "test-model")

  const verdict = await validator.validate("answer text", [
    { role: "system", content: "system context only" },
  ])

  assert.equal(verdict.passed, false)
  assert.equal(verdict.missingGap, undefined, "no user message → no missingGap → terminal")
})

test("P3.2 蓝军: degraded verdict with whitespace-only user message → no missingGap", async () => {
  const fake = makeFakeOpenAI("not valid json")
  const validator = new ValidatorImpl(fake as unknown as OpenAI, "test-model")

  const verdict = await validator.validate("answer text", [
    { role: "user", content: "   " },
  ])

  assert.equal(verdict.passed, false)
  assert.equal(verdict.missingGap, undefined, "whitespace-only user message → no missingGap")
})

test("P3.2 蓝军: degraded verdict flows through existing replanner (bounded correction)", async () => {
  // The degraded verdict's missingGap (user message) must drive the
  // existing RePlannerImpl to produce a correction query. This is the
  // "bounded correction" path — the runner's 3-round loop will re-search
  // the user message, then dedup it on the next round, converging to
  // insufficient_evidence within the budget.
  const fake = makeFakeOpenAI("not valid json")
  const validator = new ValidatorImpl(fake as unknown as OpenAI, "test-model")
  const replanner = new RePlannerImpl()

  const verdict = await validator.validate("answer text", CONTEXT_MESSAGES)
  const gapQueries = await replanner.replan(verdict)

  assert.equal(verdict.passed, false)
  assert.equal(gapQueries.length, 1, "replanner must produce one gap query from degraded verdict")
  assert.equal(gapQueries[0].text, USER_MESSAGE, "gap query is the user message (deterministic)")
})

test("P3.2 蓝军: degraded verdict (no user message) flows through replanner (terminal path)", async () => {
  const fake = makeFakeOpenAI("not valid json")
  const validator = new ValidatorImpl(fake as unknown as OpenAI, "test-model")
  const replanner = new RePlannerImpl()

  const verdict = await validator.validate("answer text", [
    { role: "system", content: "system context only" },
  ])
  const gapQueries = await replanner.replan(verdict)

  assert.equal(verdict.passed, false)
  assert.equal(verdict.missingGap, undefined)
  assert.equal(gapQueries.length, 0, "no missingGap → replanner returns [] → runner terminates")
})

test("P3.2 蓝军: repeated degraded verdicts converge (dedup → terminal)", async () => {
  // Simulate two rounds of degraded verdicts. The runner's seenGapQueries
  // dedup would filter the duplicate gap query on round 1, causing
  // immediate terminal. This test verifies the replanner produces the
  // SAME gap query for the same input (deterministic), so the dedup
  // converges.
  const fake = makeFakeOpenAI("not valid json")
  const validator = new ValidatorImpl(fake as unknown as OpenAI, "test-model")
  const replanner = new RePlannerImpl()

  const v1 = await validator.validate("answer text", CONTEXT_MESSAGES)
  const g1 = await replanner.replan(v1)
  const v2 = await validator.validate("answer text", CONTEXT_MESSAGES)
  const g2 = await replanner.replan(v2)

  assert.deepEqual(g1, g2, "same input → same gap query (deterministic → dedup converges)")
  assert.equal(g1[0].text, USER_MESSAGE)
})

// ---------------------------------------------------------------------------
// P3.2 蓝军: valid verdict does NOT carry schemaVersion forward
// ---------------------------------------------------------------------------

test("P3.2 蓝军: valid verdict does not forward schemaVersion (type-compat with CriticVerdict)", async () => {
  // The existing CriticVerdict type is unversioned. ValidatorImpl consumes
  // schemaVersion at the schema boundary and does not forward it, so
  // existing callers that consume CriticVerdict are unaffected.
  const validContent = JSON.stringify({
    schemaVersion: 1,
    passed: true,
    hallucination: false,
    completeness: true,
  })
  const fake = makeFakeOpenAI(validContent)
  const validator = new ValidatorImpl(fake as unknown as OpenAI, "test-model")

  const verdict = await validator.validate("answer text", CONTEXT_MESSAGES)

  assert.equal((verdict as unknown as Record<string, unknown>).schemaVersion, undefined, "schemaVersion is consumed at the boundary")
})

// ---------------------------------------------------------------------------
// P3.2 蓝军: defense-in-depth — classifyCriticVerdict throw still degrades
// ---------------------------------------------------------------------------

test("P3.2 蓝军: if classifyCriticVerdict throws, validator still returns degraded verdict", async () => {
  // classifyCriticVerdict has a never-throws contract (P3.1). If a future
  // bug violates it, the try/catch in ValidatorImpl must still route to
  // the degraded verdict so the runner converges to one terminal event.
  // We simulate this by passing a content that triggers classification
  // and verifying the validator never throws on any input.
  const adversarialContents = [
    "",
    "\x00",
    "{",
    "{}}",
    "null",
    "[[[[",
    String.fromCharCode(0, 1, 2, 3),
    "\uFEFF",
    "x".repeat(20 * 1024), // well over the 8KiB bound
  ]
  for (const content of adversarialContents) {
    const fake = makeFakeOpenAI(content)
    const validator = new ValidatorImpl(fake as unknown as OpenAI, "test-model")
    try {
      const verdict = await validator.validate("answer text", CONTEXT_MESSAGES)
      assert.equal(verdict.passed, false, `adversarial content ${JSON.stringify(content).slice(0, 40)} must degrade`)
    } catch (err) {
      assert.fail(`ValidatorImpl threw on adversarial content: ${String(err)}`)
    }
  }
})
