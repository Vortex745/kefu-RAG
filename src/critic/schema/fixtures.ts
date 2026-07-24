/**
 * P3.1 — Critic verdict test fixtures.
 *
 * Raw-string fixtures for `classifyCriticVerdict`, organized by the
 * three-way taxonomy (`valid` / `invalid` / `unknown`). Each fixture
 * declares its expected `kind` and `reason` so the test suite can assert
 * exact classification without re-deriving expectations.
 *
 * The fixtures are derived from observed real-world Critic LLM output
 * shapes, not just the TypeScript type:
 *   - The ValidatorImpl prompt emits
 *     `{ "passed": bool, "hallucination": bool, "completeness": bool,
 *        "missingGap": string | null }` (no `schemaVersion`), so the
 *     "current unversioned ValidatorImpl output" fixture is classified
 *     `invalid: schema_version_mismatch` — this is the gap P3.2 closes.
 *   - Real LLMs frequently emit string-form booleans (`"true"`), extra
 *     reasoning fields, numeric booleans (`0`/`1`), truncated JSON under
 *     token pressure, and empty content under content-filter refusals.
 *
 * P3.2's runtime enforcement will reuse these fixtures as its first-line
 * regression suite (the gate: "valid/invalid/unknown fields fixtures").
 *
 * Boundary: owned by `src/critic/schema/*`. Test-data only; MUST NOT be
 * imported by production runtime code.
 */

import type { CriticRejectionReason, CriticVerdictKind } from "./taxonomy"

/**
 * A single Critic verdict fixture: the raw response string and the
 * expected classification. Fixtures are plain data so they can be
 * serialized, diffed, and extended without touching test logic.
 */
export interface CriticVerdictFixture {
  /** Stable, human-readable name. Used as the test case label. */
  name: string
  /** Raw Critic response string (exactly what JSON.parse would receive). */
  raw: string
  /** Expected classification kind. */
  kind: CriticVerdictKind
  /** Expected rejection reason. Required when `kind !== "valid"`. */
  reason?: CriticRejectionReason
  /** Short note documenting why this shape is in the fixture set. */
  note: string
}

/**
 * Valid fixtures — schema-passing Critic verdicts. These are the only
 * shapes P3.2 may allow through to the replanner / publish decision.
 */
export const VALID_FIXTURES: readonly CriticVerdictFixture[] = [
  {
    name: "valid: passed=true, no missingGap",
    raw: JSON.stringify({
      schemaVersion: 1,
      passed: true,
      hallucination: false,
      completeness: true,
    }),
    kind: "valid",
    note: "Canonical approve verdict; missingGap omitted (optional).",
  },
  {
    name: "valid: passed=true, missingGap=null",
    raw: JSON.stringify({
      schemaVersion: 1,
      passed: true,
      hallucination: false,
      completeness: true,
      missingGap: null,
    }),
    kind: "valid",
    note: "ValidatorImpl prompt emits missingGap as string|null.",
  },
  {
    name: "valid: passed=false, missingGap string",
    raw: JSON.stringify({
      schemaVersion: 1,
      passed: false,
      hallucination: false,
      completeness: false,
      missingGap: "refund policy timeframe missing",
    }),
    kind: "valid",
    note: "Canonical replan-triggering verdict.",
  },
  {
    name: "valid: passed=false, hallucination=true",
    raw: JSON.stringify({
      schemaVersion: 1,
      passed: false,
      hallucination: true,
      completeness: true,
      missingGap: null,
    }),
    kind: "valid",
    note: "Hallucination flag triggers replan even when completeness holds.",
  },
  {
    name: "valid: passed=false, missingGap empty string",
    raw: JSON.stringify({
      schemaVersion: 1,
      passed: false,
      hallucination: false,
      completeness: false,
      missingGap: "",
    }),
    kind: "valid",
    note: "Empty missingGap is structurally valid (string); replanner treats !missingGap as no gap (semantic, P3.2).",
  },
  {
    name: "valid: with optional suggestion Query",
    raw: JSON.stringify({
      schemaVersion: 1,
      passed: false,
      hallucination: false,
      completeness: false,
      missingGap: "warranty period",
      suggestion: { text: "warranty period electronics", coverageCriteria: ["electronics"] },
    }),
    kind: "valid",
    note: "suggestion is unused by current replanner but part of CriticVerdict type; schema validates Query shape.",
  },
]

/**
 * Invalid fixtures — recognizable Critic verdict attempts that fail the
 * schema. P3.2 must route these through bounded replan/degrade only.
 */
export const INVALID_FIXTURES: readonly CriticVerdictFixture[] = [
  {
    name: "invalid: current unversioned ValidatorImpl output (no schemaVersion)",
    raw: JSON.stringify({
      passed: true,
      hallucination: false,
      completeness: true,
      missingGap: null,
    }),
    kind: "invalid",
    reason: "schema_version_mismatch",
    note: "This is the current production ValidatorImpl output shape. P3.2 closes the gap by emitting schemaVersion.",
  },
  {
    name: "invalid: schemaVersion=2 (unknown future version)",
    raw: JSON.stringify({
      schemaVersion: 2,
      passed: true,
      hallucination: false,
      completeness: true,
    }),
    kind: "invalid",
    reason: "schema_version_mismatch",
    note: "Future version bump must not silently validate against v1 schema.",
  },
  {
    name: "invalid: schemaVersion as string \"1\"",
    raw: JSON.stringify({
      schemaVersion: "1",
      passed: true,
      hallucination: false,
      completeness: true,
    }),
    kind: "invalid",
    reason: "schema_version_mismatch",
    note: "String-form version is a common LLM type confusion.",
  },
  {
    name: "invalid: missing passed field",
    raw: JSON.stringify({
      schemaVersion: 1,
      hallucination: false,
      completeness: true,
    }),
    kind: "invalid",
    reason: "missing_required_field",
    note: "passed is the publish gate; absent passed must never default to true.",
  },
  {
    name: "invalid: missing hallucination field",
    raw: JSON.stringify({
      schemaVersion: 1,
      passed: false,
      completeness: true,
    }),
    kind: "invalid",
    reason: "missing_required_field",
    note: "hallucination is required for replan/handoff routing.",
  },
  {
    name: "invalid: missing completeness field",
    raw: JSON.stringify({
      schemaVersion: 1,
      passed: true,
      hallucination: false,
    }),
    kind: "invalid",
    reason: "missing_required_field",
    note: "completeness is required for replan/handoff routing.",
  },
  {
    name: "invalid: string-form boolean passed=\"true\"",
    raw: JSON.stringify({
      schemaVersion: 1,
      passed: "true",
      hallucination: "false",
      completeness: true,
    }),
    kind: "invalid",
    reason: "wrong_type",
    note: "Common LLM output drift; must not be coerced to true (could smuggle a false).",
  },
  {
    name: "invalid: numeric boolean passed=1",
    raw: JSON.stringify({
      schemaVersion: 1,
      passed: 1,
      hallucination: 0,
      completeness: 1,
    }),
    kind: "invalid",
    reason: "wrong_type",
    note: "Numeric booleans are not coerced; 0/1 ambiguous with truthy/falsy bugs.",
  },
  {
    name: "invalid: missingGap as number",
    raw: JSON.stringify({
      schemaVersion: 1,
      passed: false,
      hallucination: false,
      completeness: false,
      missingGap: 42,
    }),
    kind: "invalid",
    reason: "wrong_type",
    note: "Type confusion on missingGap; replanner expects string.",
  },
  {
    name: "invalid: missingGap as boolean",
    raw: JSON.stringify({
      schemaVersion: 1,
      passed: false,
      hallucination: false,
      completeness: false,
      missingGap: true,
    }),
    kind: "invalid",
    reason: "wrong_type",
    note: "Type confusion on missingGap; must be string|null.",
  },
  {
    name: "invalid: extra dangerous field (reasoning injection)",
    raw: JSON.stringify({
      schemaVersion: 1,
      passed: true,
      hallucination: false,
      completeness: true,
      reasoning: "the answer looks correct",
    }),
    kind: "invalid",
    reason: "extra_dangerous_field",
    note: "LLMs often add reasoning fields; strict schema rejects unknown top-level keys.",
  },
  {
    name: "invalid: extra dangerous field (approve override attempt)",
    raw: JSON.stringify({
      schemaVersion: 1,
      passed: false,
      hallucination: true,
      completeness: false,
      approved: true,
    }),
    kind: "invalid",
    reason: "extra_dangerous_field",
    note: "Hostile shape: extra 'approved' field cannot override the strict schema's passed=false.",
  },
  {
    name: "invalid: suggestion.text missing",
    raw: JSON.stringify({
      schemaVersion: 1,
      passed: false,
      hallucination: false,
      completeness: false,
      missingGap: "gap",
      suggestion: { coverageCriteria: ["x"] },
    }),
    kind: "invalid",
    reason: "missing_required_field",
    note: "suggestion.text is required by Query schema.",
  },
  {
    name: "invalid: suggestion.text wrong type",
    raw: JSON.stringify({
      schemaVersion: 1,
      passed: false,
      hallucination: false,
      completeness: false,
      missingGap: "gap",
      suggestion: { text: 123 },
    }),
    kind: "invalid",
    reason: "wrong_type",
    note: "suggestion.text must be string.",
  },
]

/**
 * Unknown fixtures — responses that cannot be identified as a Critic
 * verdict. P3.2 must treat as unprocessable: do not trust, do not
 * interpret, converge to one terminal event.
 */
export const UNKNOWN_FIXTURES: readonly CriticVerdictFixture[] = [
  {
    name: "unknown: malformed JSON (unexpected token)",
    raw: '{"schemaVersion": 1, "passed": true,',
    kind: "unknown",
    reason: "malformed_json",
    note: "Trailing comma / missing closing brace; not a verdict.",
  },
  {
    name: "unknown: truncated JSON (unexpected end of input)",
    raw: '{"schemaVersion": 1, "passed": true, "hallucination": fals',
    kind: "unknown",
    reason: "truncated_json",
    note: "Token-limit truncation mid-token; common under output budget pressure.",
  },
  {
    name: "unknown: truncated JSON (unterminated string)",
    raw: '{"schemaVersion": 1, "passed": true, "missingGap": "refund',
    kind: "unknown",
    reason: "truncated_json",
    note: "Token-limit truncation mid-string value.",
  },
  {
    name: "unknown: empty content",
    raw: "",
    kind: "unknown",
    reason: "empty_content",
    note: "Content-filter refusal or empty provider response.",
  },
  {
    name: "unknown: whitespace-only content",
    raw: "   \n  \t ",
    kind: "unknown",
    reason: "empty_content",
    note: "Whitespace-only is treated as empty.",
  },
  {
    name: "unknown: null root",
    raw: "null",
    kind: "unknown",
    reason: "non_object_root",
    note: "Provider returned JSON null.",
  },
  {
    name: "unknown: array root",
    raw: '[{"passed": true}]',
    kind: "unknown",
    reason: "non_object_root",
    note: "Array root is not a verdict object.",
  },
  {
    name: "unknown: string root",
    raw: '"the answer is correct"',
    kind: "unknown",
    reason: "non_object_root",
    note: "Plain-string LLM response (json_object mode bypassed).",
  },
  {
    name: "unknown: number root",
    raw: "42",
    kind: "unknown",
    reason: "non_object_root",
    note: "Numeric root.",
  },
  {
    name: "unknown: boolean root",
    raw: "true",
    kind: "unknown",
    reason: "non_object_root",
    note: "Boolean root.",
  },
  {
    name: "unknown: empty object (no recognized keys)",
    raw: "{}",
    kind: "unknown",
    reason: "unparseable_unknown",
    note: "Object with no Critic fields; cannot tell it is a verdict attempt.",
  },
  {
    name: "unknown: unrelated JSON object",
    raw: JSON.stringify({ foo: "bar", count: 3 }),
    kind: "unknown",
    reason: "unparseable_unknown",
    note: "Object with no recognized Critic keys.",
  },
]

/**
 * Oversized fixture — valid JSON shape but exceeds the byte budget. Built
 * at runtime so the source fixture stays readable. Classified `invalid`
 * (recognizable verdict attempt, rejected before parse as a DoS guard).
 */
export function makeOversizedFixture(): CriticVerdictFixture {
  const base = {
    schemaVersion: 1,
    passed: true,
    hallucination: false,
    completeness: true,
  }
  // Pad with a large unrecognized field to cross the 8 KiB threshold.
  const padding = "x".repeat(9 * 1024)
  return {
    name: "invalid: oversized response (>8KiB)",
    raw: JSON.stringify({ ...base, padding }),
    kind: "invalid",
    reason: "oversized_response",
    note: "DoS bound: oversized payload rejected before JSON.parse.",
  }
}

/**
 * All fixtures combined, for the gate test that asserts every fixture is
 * classified to its declared expectation. Includes the oversized fixture.
 */
export function allFixtures(): readonly CriticVerdictFixture[] {
  return [
    ...VALID_FIXTURES,
    ...INVALID_FIXTURES,
    ...UNKNOWN_FIXTURES,
    makeOversizedFixture(),
  ]
}
