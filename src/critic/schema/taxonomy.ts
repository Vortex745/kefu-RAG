/**
 * P3.1 — Critic verdict error taxonomy.
 *
 * Defines the three-way classification of a raw Critic response and the
 * pinned set of rejection reasons. This module is definition-only: it
 * declares the taxonomy; the runtime checker lives in `classify.ts` and
 * production enforcement is P3.2.
 *
 * Classification contract (matches the P3.1 gate
 * "valid/invalid/unknown fields fixtures"):
 *
 *   - `valid`   — the response parses, is an object, carries
 *                 `schemaVersion: 1`, and satisfies every field of
 *                 `CriticVerdictSchemaV1`. The verdict is safe to publish.
 *
 *   - `invalid` — the response is recognizably a Critic verdict attempt
 *                 (a JSON object that touches at least one Critic field or
 *                 carries a `schemaVersion`), but fails the schema. The
 *                 rejection `reason` is one of the `INVALID_REASONS`.
 *                 P3.2 must route invalid responses through bounded
 *                 replan/degrade — never through `answer_delta` or
 *                 `completed`.
 *
 *   - `unknown` — the response cannot be identified as a Critic verdict
 *                 at all (malformed JSON, non-object root, empty payload,
 *                 or a JSON object with no recognizable Critic fields).
 *                 The rejection `reason` is one of the `UNKNOWN_REASONS`.
 *                 P3.2 must treat `unknown` as unprocessable: do not trust,
 *                 do not interpret, converge to one terminal event.
 *
 * The reason sets are disjoint between `invalid` and `unknown` so a caller
 * can branch on `kind` without inspecting `reason`, and so test fixtures
 * can assert exact reasons without ambiguity.
 *
 * Boundary: owned by `src/critic/schema/*`. MUST NOT import `src/api/*` or
 * `src/mastra/*` (dependency direction: Types -> ... -> Runtime -> UI).
 */

import type { VersionedCriticVerdict } from "./schema"

/**
 * Three-way classification of a raw Critic response.
 *
 * - `valid`   — schema-passing; safe to publish.
 * - `invalid` — recognizable verdict attempt that fails schema; bounded
 *                replan/degrade only.
 * - `unknown` — unrecognizable as a verdict; unprocessable.
 */
export type CriticVerdictKind = "valid" | "invalid" | "unknown"

/**
 * Rejection reasons for `invalid` verdicts. A response is `invalid` when
 * it is a JSON object that looks like a Critic verdict (touches a Critic
 * field or carries `schemaVersion`) but fails `CriticVerdictSchemaV1`.
 *
 * Note: `unknown_enum` is reserved for future schema versions that
 * introduce enum-typed fields. The v1 schema has no enum fields
 * (`schemaVersion` is a `z.literal(1)`, booleans are `z.boolean()`), so
 * an `unknown_enum` reason is not reachable under v1 and is intentionally
 * absent from `INVALID_REASONS`. Adding a future enum field requires
 * adding the reason here, to `INVALID_REASONS`, and a fixture + test.
 */
export type CriticInvalidReason =
  | "missing_required_field"
  | "wrong_type"
  | "extra_dangerous_field"
  | "schema_version_mismatch"
  | "oversized_response"

/**
 * Rejection reasons for `unknown` verdicts. A response is `unknown` when
 * it cannot be identified as a Critic verdict at all.
 */
export type CriticUnknownReason =
  | "malformed_json"
  | "truncated_json"
  | "empty_content"
  | "non_object_root"
  | "unparseable_unknown"

/**
 * Union of all rejection reasons. `INVALID_REASONS` and `UNKNOWN_REASONS`
 * are disjoint; a reason unambiguously determines its `kind`.
 */
export type CriticRejectionReason = CriticInvalidReason | CriticUnknownReason

/**
 * Pinned, exhaustive set of `invalid` rejection reasons reachable under
 * the v1 schema. Disjoint from `UNKNOWN_REASONS`. Adding a value here
 * requires a fixture + test (P3.1 gate) and a P3.2 routing decision.
 */
export const INVALID_REASONS: readonly CriticInvalidReason[] = [
  "missing_required_field",
  "wrong_type",
  "extra_dangerous_field",
  "schema_version_mismatch",
  "oversized_response",
]

/**
 * Pinned, exhaustive set of `unknown` rejection reasons. Disjoint from
 * `INVALID_REASONS`.
 */
export const UNKNOWN_REASONS: readonly CriticUnknownReason[] = [
  "malformed_json",
  "truncated_json",
  "empty_content",
  "non_object_root",
  "unparseable_unknown",
]

/**
 * Result of classifying a raw Critic response.
 *
 * - When `kind === "valid"`, `verdict` is present and `reason` is absent.
 * - When `kind === "invalid" | "unknown"`, `verdict` is absent and
 *   `reason` is present. `details` carries a short human-readable
 *   diagnostic (field path, parse error excerpt) for traces/observability;
 *   it MUST NOT be echoed into the Answer event stream as user-facing
 *   content.
 */
export interface CriticVerdictClassification {
  kind: CriticVerdictKind
  verdict?: VersionedCriticVerdict
  reason?: CriticRejectionReason
  details?: string
}

/**
 * The set of top-level keys that identify a JSON object as a Critic
 * verdict attempt. If a parsed JSON object contains none of these keys,
 * it is classified `unknown: unparseable_unknown` rather than `invalid`
 * (we cannot tell it is trying to be a Critic verdict).
 *
 * `schemaVersion` is included so a bare `{"schemaVersion": 1}` is treated
 * as an `invalid` verdict (missing required fields) rather than unknown.
 */
export const CRITIC_VERDICT_RECOGNIZED_KEYS: readonly string[] = [
  "schemaVersion",
  "passed",
  "hallucination",
  "completeness",
  "missingGap",
  "suggestion",
]
