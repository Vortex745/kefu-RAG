/**
 * P3.1 — Critic verdict schema, taxonomy, and classification tests.
 *
 * This file IS the P3.1 gate ("valid/invalid/unknown fields fixtures").
 * It verifies:
 *   - The schema version is pinned (`CRITIC_VERDICT_SCHEMA_VERSION === 1`).
 *   - The taxonomy reasons are pinned and disjoint.
 *   - Every fixture in `allFixtures()` classifies to its declared
 *     expectation (valid → verdict present; invalid/unknown → exact reason).
 *   - The current unversioned `ValidatorImpl` output is classified
 *     `invalid: schema_version_mismatch` (the audit gap P3.2 closes).
 *   - `classifyCriticVerdict` never throws (always-returns contract).
 *   - The DoS guard fires before JSON.parse.
 *
 * Boundary: owned by `src/critic/schema/*`. MUST NOT import `src/api/*` or
 * `src/mastra/*` (dependency direction).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  CRITIC_VERDICT_SCHEMA_VERSION,
  CRITIC_VERDICT_MAX_BYTES,
  CriticVerdictSchemaV1,
  INVALID_REASONS,
  UNKNOWN_REASONS,
  CRITIC_VERDICT_RECOGNIZED_KEYS,
  classifyCriticVerdict,
  VALID_FIXTURES,
  INVALID_FIXTURES,
  UNKNOWN_FIXTURES,
  makeOversizedFixture,
  allFixtures,
  type CriticVerdictFixture,
} from "./index"

// ---------------------------------------------------------------------------
// Schema version + constants are pinned (Done criterion: 版本固定)
// ---------------------------------------------------------------------------

test("P3.1: CRITIC_VERDICT_SCHEMA_VERSION is pinned to 1", () => {
  assert.equal(CRITIC_VERDICT_SCHEMA_VERSION, 1)
})

test("P3.1: CRITIC_VERDICT_MAX_BYTES is bounded and explicit", () => {
  assert.equal(CRITIC_VERDICT_MAX_BYTES, 8 * 1024)
  assert.ok(CRITIC_VERDICT_MAX_BYTES > 0, "must be a positive bound")
})

test("P3.1: CriticVerdictSchemaV1 strict-rejects unknown top-level keys", () => {
  const result = CriticVerdictSchemaV1.safeParse({
    schemaVersion: 1,
    passed: true,
    hallucination: false,
    completeness: true,
    injectedField: "evil",
  })
  assert.equal(result.success, false)
  const codes = result.error.issues.map((i) => i.code)
  assert.ok(codes.includes("unrecognized_keys"), `expected unrecognized_keys, got ${codes.join(",")}`)
})

test("P3.1: CriticVerdictSchemaV1 rejects string-form booleans (no coercion)", () => {
  const result = CriticVerdictSchemaV1.safeParse({
    schemaVersion: 1,
    passed: "true",
    hallucination: "false",
    completeness: true,
  })
  assert.equal(result.success, false)
})

test("P3.1: CriticVerdictSchemaV1 accepts missingGap as string|null|absent", () => {
  for (const missingGap of [undefined, null, "a gap", ""]) {
    const payload: Record<string, unknown> = {
      schemaVersion: 1,
      passed: true,
      hallucination: false,
      completeness: true,
    }
    if (missingGap !== undefined) payload.missingGap = missingGap
    const result = CriticVerdictSchemaV1.safeParse(payload)
    assert.equal(result.success, true, `missingGap=${String(missingGap)} should be valid`)
  }
})

// ---------------------------------------------------------------------------
// Taxonomy reasons are pinned and disjoint (Done criterion: 拒绝原因固定)
// ---------------------------------------------------------------------------

test("P3.1: INVALID_REASONS and UNKNOWN_REASONS are disjoint", () => {
  const invalidSet = new Set(INVALID_REASONS)
  const unknownSet = new Set(UNKNOWN_REASONS)
  for (const r of invalidSet) {
    assert.ok(!unknownSet.has(r as never), `reason ${r} must not appear in both sets`)
  }
})

test("P3.1: INVALID_REASONS covers the pinned v1 set (no enum fields in v1)", () => {
  // v1 schema has no enum fields, so `unknown_enum` is intentionally
  // absent (reserved for future schema versions). See taxonomy.ts.
  assert.deepEqual(
    [...INVALID_REASONS].sort(),
    [
      "extra_dangerous_field",
      "missing_required_field",
      "oversized_response",
      "schema_version_mismatch",
      "wrong_type",
    ]
  )
})

test("P3.1: UNKNOWN_REASONS covers the pinned set", () => {
  assert.deepEqual(
    [...UNKNOWN_REASONS].sort(),
    [
      "empty_content",
      "malformed_json",
      "non_object_root",
      "truncated_json",
      "unparseable_unknown",
    ]
  )
})

test("P3.1: CRITIC_VERDICT_RECOGNIZED_KEYS is pinned and includes schemaVersion", () => {
  assert.ok(CRITIC_VERDICT_RECOGNIZED_KEYS.includes("schemaVersion"))
  assert.ok(CRITIC_VERDICT_RECOGNIZED_KEYS.includes("passed"))
  assert.ok(CRITIC_VERDICT_RECOGNIZED_KEYS.includes("hallucination"))
  assert.ok(CRITIC_VERDICT_RECOGNIZED_KEYS.includes("completeness"))
  assert.ok(CRITIC_VERDICT_RECOGNIZED_KEYS.includes("missingGap"))
})

test("P3.1: recognized keys are unique", () => {
  assert.equal(CRITIC_VERDICT_RECOGNIZED_KEYS.length, new Set(CRITIC_VERDICT_RECOGNIZED_KEYS).size)
})

// ---------------------------------------------------------------------------
// Fixture coverage: valid/invalid/unknown fixtures exist (the gate)
// ---------------------------------------------------------------------------

test("P3.1: VALID_FIXTURES is non-empty and all declare kind=valid", () => {
  assert.ok(VALID_FIXTURES.length >= 3, "need at least 3 valid fixtures")
  for (const f of VALID_FIXTURES) {
    assert.equal(f.kind, "valid", `${f.name} should be valid`)
    assert.equal(f.reason, undefined, `${f.name} should not declare a reason`)
  }
})

test("P3.1: INVALID_FIXTURES is non-empty and all declare kind=invalid with a reason", () => {
  assert.ok(INVALID_FIXTURES.length >= 6, "need broad invalid coverage")
  for (const f of INVALID_FIXTURES) {
    assert.equal(f.kind, "invalid", `${f.name} should be invalid`)
    assert.ok(f.reason, `${f.name} must declare a reason`)
    assert.ok(
      (INVALID_REASONS as readonly string[]).includes(f.reason!),
      `${f.name} reason ${f.reason} must be in INVALID_REASONS`
    )
  }
})

test("P3.1: UNKNOWN_FIXTURES is non-empty and all declare kind=unknown with a reason", () => {
  assert.ok(UNKNOWN_FIXTURES.length >= 5, "need broad unknown coverage")
  for (const f of UNKNOWN_FIXTURES) {
    assert.equal(f.kind, "unknown", `${f.name} should be unknown`)
    assert.ok(f.reason, `${f.name} must declare a reason`)
    assert.ok(
      (UNKNOWN_REASONS as readonly string[]).includes(f.reason!),
      `${f.name} reason ${f.reason} must be in UNKNOWN_REASONS`
    )
  }
})

test("P3.1: every invalid reason is covered by at least one fixture", () => {
  const covered = new Set(INVALID_FIXTURES.map((f) => f.reason))
  for (const r of INVALID_REASONS) {
    if (r === "oversized_response") {
      // Oversized is covered by makeOversizedFixture, not INVALID_FIXTURES.
      assert.ok(makeOversizedFixture().reason === "oversized_response")
      continue
    }
    assert.ok(covered.has(r), `invalid reason ${r} has no fixture`)
  }
})

test("P3.1: every unknown reason is covered by at least one fixture", () => {
  const covered = new Set(UNKNOWN_FIXTURES.map((f) => f.reason))
  for (const r of UNKNOWN_REASONS) {
    assert.ok(covered.has(r), `unknown reason ${r} has no fixture`)
  }
})

test("P3.1: fixture names are unique", () => {
  const names = allFixtures().map((f) => f.name)
  assert.equal(names.length, new Set(names).size, "fixture names must be unique")
})

// ---------------------------------------------------------------------------
// THE GATE: every fixture classifies to its declared expectation
// ---------------------------------------------------------------------------

test("P3.1 gate: every fixture classifies to its declared kind + reason", () => {
  const failures: string[] = []
  for (const f of allFixtures()) {
    const result = classifyCriticVerdict(f.raw)
    if (result.kind !== f.kind) {
      failures.push(`${f.name}: expected kind=${f.kind}, got kind=${result.kind} (reason=${result.reason})`)
      continue
    }
    if (f.kind !== "valid" && result.reason !== f.reason) {
      failures.push(`${f.name}: expected reason=${f.reason}, got reason=${result.reason}`)
      continue
    }
    if (f.kind === "valid" && !result.verdict) {
      failures.push(`${f.name}: valid kind must carry a verdict`)
    }
  }
  assert.deepEqual(failures, [], `fixture classification mismatches:\n${failures.join("\n")}`)
})

test("P3.1 gate: valid fixtures carry a fully-typed verdict", () => {
  for (const f of VALID_FIXTURES) {
    const result = classifyCriticVerdict(f.raw)
    assert.equal(result.kind, "valid", `${f.name}`)
    assert.ok(result.verdict, `${f.name} must carry a verdict`)
    assert.equal(result.verdict!.schemaVersion, 1, `${f.name} verdict.schemaVersion`)
    assert.equal(typeof result.verdict!.passed, "boolean", `${f.name} verdict.passed type`)
    assert.equal(typeof result.verdict!.hallucination, "boolean", `${f.name} verdict.hallucination type`)
    assert.equal(typeof result.verdict!.completeness, "boolean", `${f.name} verdict.completeness type`)
    assert.equal(result.reason, undefined, `${f.name} valid must not carry a reason`)
  }
})

// ---------------------------------------------------------------------------
// Audit gap: current unversioned ValidatorImpl output is rejected
// ---------------------------------------------------------------------------

test("P3.1 audit gap: current ValidatorImpl output (no schemaVersion) is invalid:schema_version_mismatch", () => {
  // This is the exact shape src/critic/validator/validator.ts emits today:
  // JSON.parse(res.choices[0]?.message?.content || "{}") as CriticVerdict
  // The output has NO schemaVersion field.
  const currentOutput = JSON.stringify({
    passed: true,
    hallucination: false,
    completeness: true,
    missingGap: null,
  })
  const result = classifyCriticVerdict(currentOutput)
  assert.equal(result.kind, "invalid")
  assert.equal(result.reason, "schema_version_mismatch")
  // P3.2 closes this gap by emitting schemaVersion in ValidatorImpl.
})

// ---------------------------------------------------------------------------
// classifyCriticVerdict never throws (always-returns contract for P3.2)
// ---------------------------------------------------------------------------

test("P3.1: classifyCriticVerdict never throws on adversarial inputs", () => {
  const adversarial = [
    "",
    "   ",
    "\x00",
    "{",
    "{}}",
    '{"a":' .repeat(100),
    "null",
    "undefined",
    "[[[[[",
    '{"passed":' .repeat(50) + "true}",
    String.fromCharCode(0, 1, 2, 3),
    "\uFEFF",
    '{"schemaVersion": 1, "passed": true, "hallucination": false, "completeness": true, "missingGap": "x", "suggestion": {"text": "y", "context": {"nested": {"deep": [1, 2, 3]}}}}',
  ]
  for (const raw of adversarial) {
    try {
      const result = classifyCriticVerdict(raw)
      assert.ok(
        result.kind === "valid" || result.kind === "invalid" || result.kind === "unknown",
        `adversarial input must classify to a valid kind, got ${result.kind}`
      )
    } catch (err) {
      assert.fail(`classifyCriticVerdict threw on input ${JSON.stringify(raw)}: ${String(err)}`)
    }
  }
})

// ---------------------------------------------------------------------------
// DoS guard: oversized rejected BEFORE parse (no parser CPU spent)
// ---------------------------------------------------------------------------

test("P3.1 DoS guard: oversized response rejected as invalid:oversized_response", () => {
  const oversized = makeOversizedFixture()
  const result = classifyCriticVerdict(oversized.raw)
  assert.equal(result.kind, "invalid")
  assert.equal(result.reason, "oversized_response")
  assert.ok(result.details?.includes("exceeds"), `details should mention exceed, got: ${result.details}`)
})

test("P3.1 DoS guard: oversized rejected even when raw is not valid JSON", () => {
  // 9 KiB of garbage — must still be oversized_response, not malformed_json,
  // proving the byte guard runs before JSON.parse.
  const garbage = "x".repeat(9 * 1024)
  const result = classifyCriticVerdict(garbage)
  assert.equal(result.kind, "invalid")
  assert.equal(result.reason, "oversized_response")
})

test("P3.1 DoS guard: maxBytes option is honored", () => {
  const tiny = '{"schemaVersion":1,"passed":true,"hallucination":false,"completeness":true}'
  // Default bound: passes.
  assert.equal(classifyCriticVerdict(tiny).kind, "valid")
  // Tight bound: rejected as oversized (proves the guard is configurable
  // for P3.2 / diagnostic use, not hard-coded).
  const tight = classifyCriticVerdict(tiny, { maxBytes: 10 })
  assert.equal(tight.kind, "invalid")
  assert.equal(tight.reason, "oversized_response")
})

// ---------------------------------------------------------------------------
// 蓝军自检 (red team): real Critic output shapes are covered
// ---------------------------------------------------------------------------

test("P3.1 蓝军: schema covers ValidatorImpl prompt-declared shape", () => {
  // The ValidatorImpl system prompt declares:
  //   { "passed": bool, "hallucination": bool, "completeness": bool,
  //     "missingGap": string | null }
  // The v1 schema accepts this shape once schemaVersion is added (P3.2).
  const promptShape = JSON.stringify({
    schemaVersion: 1,
    passed: true,
    hallucination: false,
    completeness: true,
    missingGap: null,
  })
  const result = classifyCriticVerdict(promptShape)
  assert.equal(result.kind, "valid", "prompt-declared shape + schemaVersion must be valid")
})

test("P3.1 蓝军: replanner-consumed fields are present in valid verdict", () => {
  // The replanner (src/critic/replanner/replanner.ts) consumes:
  //   verdict.passed (branch), verdict.missingGap (gap query text).
  // Both must be reachable on every valid verdict.
  const result = classifyCriticVerdict(
    JSON.stringify({
      schemaVersion: 1,
      passed: false,
      hallucination: false,
      completeness: false,
      missingGap: "refund window",
    })
  )
  assert.equal(result.kind, "valid")
  assert.equal(result.verdict!.passed, false)
  assert.equal(result.verdict!.missingGap, "refund window")
})

test("P3.1 蓝军: Mastra runner validationTrace field is derivable from valid verdict", () => {
  // src/mastra/{simple,complex}_knowledge_runner.ts set:
  //   validationTrace = { round: round + 1, passed: verdict.passed }
  // The schema guarantees `passed: boolean` is present and typed, so the
  // trace is always derivable from a valid verdict.
  const result = classifyCriticVerdict(
    JSON.stringify({
      schemaVersion: 1,
      passed: true,
      hallucination: false,
      completeness: true,
    })
  )
  assert.equal(result.kind, "valid")
  assert.equal(typeof result.verdict!.passed, "boolean")
})

test("P3.1 蓝军: empty object {} is unknown, not invalid (cannot tell it is a verdict)", () => {
  const result = classifyCriticVerdict("{}")
  assert.equal(result.kind, "unknown")
  assert.equal(result.reason, "unparseable_unknown")
})

test("P3.1 蓝军: schemaVersion-only object is invalid, not unknown (recognizable attempt)", () => {
  // { "schemaVersion": 1 } has a recognized key but is missing required
  // fields → invalid: missing_required_field, NOT unknown.
  const result = classifyCriticVerdict('{"schemaVersion": 1}')
  assert.equal(result.kind, "invalid")
  assert.equal(result.reason, "missing_required_field")
})

// ---------------------------------------------------------------------------
// Pure function: side-effect-free, deterministic
// ---------------------------------------------------------------------------

test("P3.1: classifyCriticVerdict is deterministic (same input → same output)", () => {
  const raw = JSON.stringify({
    schemaVersion: 1,
    passed: false,
    hallucination: true,
    completeness: false,
    missingGap: "gap",
  })
  const a = classifyCriticVerdict(raw)
  const b = classifyCriticVerdict(raw)
  assert.deepEqual(a, b)
})

test("P3.1: classifyCriticVerdict does not mutate input", () => {
  const raw = JSON.stringify({
    schemaVersion: 1,
    passed: true,
    hallucination: false,
    completeness: true,
  })
  const before = raw
  classifyCriticVerdict(raw)
  assert.equal(raw, before, "input string must not be mutated")
})
