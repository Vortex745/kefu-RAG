/**
 * P3.1 — Critic verdict classification (pure schema checker).
 *
 * `classifyCriticVerdict` takes a raw Critic response string and returns
 * a `CriticVerdictClassification` (`valid` | `invalid` | `unknown` with a
 * pinned rejection reason). It is the logic P3.2's enforcement layer will
 * call at the validation boundary; P3.1 does NOT wire it into
 * `ValidatorImpl` or any Mastra runner.
 *
 * Classification algorithm (matches the taxonomy in `taxonomy.ts`):
 *
 *   1. Byte-size guard  → `invalid: oversized_response` (DoS bound,
 *      checked before JSON.parse so an oversized payload never reaches
 *      the parser).
 *   2. Empty payload     → `unknown: empty_content`.
 *   3. JSON.parse        → on throw, split `truncated_json` (unexpected
 *      end of input) from `malformed_json`; both are `unknown` because
 *      the response cannot be identified as a verdict.
 *   4. Non-object root   → `unknown: non_object_root` (array / string /
 *      number / boolean / null root).
 *   5. Unrecognizable    → `unknown: unparseable_unknown` (object root
 *      with none of `CRITIC_VERDICT_RECOGNIZED_KEYS`).
 *   6. Zod schema        → on success `valid`; on failure map the first
 *      relevant Zod issue to an `invalid` reason, with this priority:
 *        a. `schema_version_mismatch` (missing / wrong-type / wrong-value
 *           `schemaVersion`) — version is foundational; if wrong, no
 *           field-level validation is trustworthy. Under Zod 4 a missing
 *           or mismatched literal field produces `invalid_value` on the
 *           `schemaVersion` path.
 *        b. `extra_dangerous_field` (unrecognized top-level keys; Zod 4
 *           code `unrecognized_keys`).
 *        c. `missing_required_field` (any required field absent; Zod 4
 *           reports this as `invalid_type` with "received undefined" in
 *           the message).
 *        d. `wrong_type` (boolean / string / null type mismatches,
 *           including string-form `"true"`/`"false"` booleans and union
 *           mismatches; Zod 4 codes `invalid_type` without "received
 *           undefined" or `invalid_union`).
 *
 * Zod 4 issue-code reference (verified at implementation time):
 *   - literal mismatch (incl. missing literal field) → `invalid_value`
 *   - type mismatch / missing required field          → `invalid_type`
 *       (message contains "received undefined" iff the field is missing)
 *   - union type mismatch                            → `invalid_union`
 *   - unknown top-level keys (under `.strict()`)     → `unrecognized_keys`
 *   The v1 schema has no enum fields, so no `invalid_enum_value` path.
 *
 * The function is pure and side-effect-free: it never throws, never logs,
 * and never mutates its input. P3.2 owns routing (bounded replan /
 * degrade / terminal event) on top of this classification.
 *
 * Boundary: owned by `src/critic/schema/*`. MUST NOT import `src/api/*` or
 * `src/mastra/*` (dependency direction: Types -> ... -> Runtime -> UI).
 */

import { CriticVerdictSchemaV1, CRITIC_VERDICT_MAX_BYTES } from "./schema"
import {
  CRITIC_VERDICT_RECOGNIZED_KEYS,
  type CriticVerdictClassification,
} from "./taxonomy"

/**
 * Options for `classifyCriticVerdict`. P3.2 may override `maxBytes` for
 * test/diagnostic purposes; production uses the default
 * `CRITIC_VERDICT_MAX_BYTES`.
 */
export interface ClassifyCriticVerdictOptions {
  maxBytes?: number
}

/**
 * Classify a raw Critic response string into `valid` / `invalid` / `unknown`.
 *
 * Never throws. A thrown error here would itself be a bug — callers (P3.2)
 * rely on the always-returns contract to guarantee a terminal event.
 */
export function classifyCriticVerdict(
  raw: string,
  options: ClassifyCriticVerdictOptions = {}
): CriticVerdictClassification {
  const maxBytes = options.maxBytes ?? CRITIC_VERDICT_MAX_BYTES

  // 1. Byte-size guard (DoS bound, before parse).
  const byteLength = Buffer.byteLength(raw, "utf8")
  if (byteLength > maxBytes) {
    return {
      kind: "invalid",
      reason: "oversized_response",
      details: `response ${byteLength}B exceeds ${maxBytes}B`,
    }
  }

  // 2. Empty payload.
  if (raw === "" || raw.trim() === "") {
    return { kind: "unknown", reason: "empty_content" }
  }

  // 3. JSON parse.
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // V8/Node JSON parse errors use "Unexpected end of JSON input" for
    // truncated input and "Unexpected token" / "Expected" for malformed.
    const isTruncated =
      /unexpected end of (json )?input/i.test(message) ||
      /end of data/i.test(message) ||
      /unterminated/i.test(message)
    return {
      kind: "unknown",
      reason: isTruncated ? "truncated_json" : "malformed_json",
      details: truncate(message, 160),
    }
  }

  // 4. Non-object root.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      kind: "unknown",
      reason: "non_object_root",
      details: `root type ${Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed}`,
    }
  }

  // 5. Unrecognizable object (no Critic fields at all).
  const root = parsed as Record<string, unknown>
  const hasRecognizedKey = CRITIC_VERDICT_RECOGNIZED_KEYS.some((k) =>
    Object.prototype.hasOwnProperty.call(root, k)
  )
  if (!hasRecognizedKey) {
    return {
      kind: "unknown",
      reason: "unparseable_unknown",
      details: `keys: ${truncate(Object.keys(root).join(","), 120)}`,
    }
  }

  // 6. Zod schema validation.
  const result = CriticVerdictSchemaV1.safeParse(parsed)
  if (result.success) {
    return { kind: "valid", verdict: result.data }
  }

  // Map the first relevant Zod issue to an `invalid` reason, with priority
  // schema_version_mismatch > extra_dangerous_field > missing_required_field
  // > wrong_type > unknown_enum.
  const issues = result.error.issues
  const reason = mapZodIssuesToReason(issues)
  const firstIssue = issues[0]
  const details = formatIssue(firstIssue)

  return { kind: "invalid", reason, details }
}

/**
 * Map a list of Zod 4 issues to a single `CriticInvalidReason`, respecting
 * the priority order documented above. Returns the first matching reason
 * by priority (not by issue order in `issues`).
 *
 * Zod 4 issue-code mapping (verified at implementation time):
 *   - `invalid_value` on `schemaVersion`  → schema_version_mismatch
 *   - `unrecognized_keys`                  → extra_dangerous_field
 *   - `invalid_type` w/ "received undefined" → missing_required_field
 *   - `invalid_type` w/o "received undefined" → wrong_type
 *   - `invalid_union`                      → wrong_type
 *   - any other code                        → wrong_type (fail-closed)
 */
function mapZodIssuesToReason(
  issues: ReadonlyArray<{
    code: string
    path: ReadonlyArray<string | number | symbol>
    message: string
    keys?: ReadonlyArray<string>
  }>
):
  | "schema_version_mismatch"
  | "extra_dangerous_field"
  | "missing_required_field"
  | "wrong_type" {
  const has = (code: string, predicate?: (i: typeof issues[number]) => boolean) =>
    issues.some((i) => i.code === code && (predicate ? predicate(i) : true))

  // a. schemaVersion: missing, wrong type, or wrong literal value. Under
  //    Zod 4 all three produce `invalid_value` on the schemaVersion path.
  if (has("invalid_value", (i) => i.path[0] === "schemaVersion")) {
    return "schema_version_mismatch"
  }

  // b. Unrecognized top-level keys (extra dangerous fields).
  if (has("unrecognized_keys")) return "extra_dangerous_field"

  // c. Missing required fields — Zod 4 reports these as `invalid_type`
  //    with "received undefined" in the message (the field is absent,
  //    not just mistyped).
  if (
    has("invalid_type", (i) =>
      /received undefined/i.test(i.message)
    )
  ) {
    return "missing_required_field"
  }

  // d. Type mismatches (incl. string-form booleans) and union mismatches.
  if (has("invalid_type") || has("invalid_union")) return "wrong_type"

  // Fallback: if Zod reported an issue we did not anticipate, surface it
  // as a type mismatch so the caller still rejects (fail-closed) rather
  // than publishing. This branch should be empty under the v1 schema; a
  // test asserts the recognized-issue coverage.
  return "wrong_type"
}

function formatIssue(issue: {
  code: string
  path: ReadonlyArray<string | number | symbol>
  message: string
  keys?: ReadonlyArray<string>
}): string {
  const pathStr = issue.path.length > 0 ? issue.path.join(".") : "(root)"
  const keysStr = issue.keys && issue.keys.length > 0 ? ` keys=[${issue.keys.join(",")}]` : ""
  return truncate(`${issue.code} @ ${pathStr}${keysStr}: ${issue.message}`, 200)
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…"
}
