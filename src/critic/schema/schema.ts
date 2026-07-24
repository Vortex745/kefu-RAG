/**
 * P3.1 — Critic verdict schema and version pin.
 *
 * This module defines the *target* schema for a valid Critic verdict emitted
 * by `ValidatorImpl` (src/critic/validator/validator.ts). It is a
 * definition-only module: it does NOT replace the existing `CriticVerdict`
 * type in `src/types/agent.ts`, does NOT modify `ValidatorImpl`, and is NOT
 * wired into any production call path. Runtime enforcement is P3.2.
 *
 * Versioning contract:
 *   - `CRITIC_VERDICT_SCHEMA_VERSION` is the current (and only) supported
 *     schema version. A verdict without a matching `schemaVersion` is
 *     classified as `schema_version_mismatch` by `classifyCriticVerdict`.
 *   - Future schema changes MUST bump this constant and add a new
 *     `CriticVerdictSchemaV<n>` alongside the legacy schema, so P3.2 can
 *     dispatch by version without silent drift.
 *
 * Strictness contract (matches audit issue 04 acceptance criteria):
 *   - Required fields: `schemaVersion`, `passed`, `hallucination`,
 *     `completeness`. Missing any → `missing_required_field`.
 *   - Booleans are strict `boolean` (no string-form `"true"`/`"false"`,
 *     no `0`/`1`). Wrong type → `wrong_type`.
 *   - `missingGap` is optional; when present it MUST be `string | null`.
 *     Matches the ValidatorImpl LLM prompt
 *     (`"missingGap": string | null`) and the existing replanner semantics
 *     (`!verdict.missingGap` treats `null`/`undefined`/`""` as "no gap").
 *   - `suggestion` is optional; when present it MUST match the `Query`
 *     shape. `suggestion` is currently unused by production callers
 *     (replanner consumes `missingGap`), but it is part of the existing
 *     `CriticVerdict` type and is retained for forward compatibility.
 *   - Unknown top-level fields are rejected (`extra_dangerous_field`) so
 *     an attacker or model drift cannot smuggle fields past the boundary.
 *
 * Boundary: owned by `src/critic/schema/*`. MUST NOT import `src/api/*` or
 * `src/mastra/*` (dependency direction: Types -> ... -> Runtime -> UI).
 */

import { z } from "zod"

/**
 * The current Critic verdict schema version. Pinned by P3.1.
 *
 * A verdict with `schemaVersion !== 1` (including absent, wrong type, or
 * unknown future versions) is rejected as `schema_version_mismatch`.
 */
export const CRITIC_VERDICT_SCHEMA_VERSION = 1 as const

/**
 * Zod schema for the `Query`-shaped `suggestion` field. Mirrors the
 * `Query` type in `src/types/retrieval.ts` (duplicated here to avoid a
 * circular type import and to keep the schema module self-contained).
 * The two definitions are structurally identical.
 */
const QuerySchema = z.object({
  text: z.string(),
  subQueries: z.array(z.string()).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  coverageCriteria: z.array(z.string()).optional(),
})

/**
 * Zod schema for Critic verdict v1.
 *
 * `.strict()` rejects unknown top-level keys (extra dangerous fields).
 * Booleans use `z.boolean()` (not `z.coerce.boolean()`) so string-form
 * `"true"`/`"false"` and numeric `0`/`1` are rejected, not coerced.
 */
export const CriticVerdictSchemaV1 = z
  .object({
    schemaVersion: z.literal(CRITIC_VERDICT_SCHEMA_VERSION),
    passed: z.boolean(),
    hallucination: z.boolean(),
    completeness: z.boolean(),
    missingGap: z.union([z.string(), z.null()]).optional(),
    suggestion: QuerySchema.optional(),
  })
  .strict()

/**
 * The validated Critic verdict shape. This is the type P3.2 will require
 * `ValidatorImpl` to emit before its output reaches the replanner or any
 * publish decision.
 *
 * It extends the existing `CriticVerdict` (src/types/agent.ts) with a
 * required `schemaVersion` field; the two are intentionally distinct so
 * P3.1 can define the target without breaking current production callers
 * that consume the unversioned `CriticVerdict`.
 */
export type VersionedCriticVerdict = z.infer<typeof CriticVerdictSchemaV1>

/**
 * Maximum accepted raw response size in bytes (UTF-8). A Critic verdict is
 * a small structured JSON object; anything larger indicates model drift or
 * a DoS attempt. P3.2's enforcement layer rejects oversized payloads
 * before JSON parsing using this constant.
 *
 * 8 KiB is generous for the current schema (typical verdict < 200 bytes)
 * while bounding the parse cost.
 */
export const CRITIC_VERDICT_MAX_BYTES = 8 * 1024
