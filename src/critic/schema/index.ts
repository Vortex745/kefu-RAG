/**
 * P3.1 — Critic verdict schema, taxonomy, and classification (barrel).
 *
 * Definition-only module. P3.2 wires `classifyCriticVerdict` into the
 * validation boundary; P3.1 does not touch production callers.
 */

export {
  CRITIC_VERDICT_SCHEMA_VERSION,
  CRITIC_VERDICT_MAX_BYTES,
  CriticVerdictSchemaV1,
  type VersionedCriticVerdict,
} from "./schema"

export {
  INVALID_REASONS,
  UNKNOWN_REASONS,
  CRITIC_VERDICT_RECOGNIZED_KEYS,
  type CriticVerdictKind,
  type CriticInvalidReason,
  type CriticUnknownReason,
  type CriticRejectionReason,
  type CriticVerdictClassification,
} from "./taxonomy"

export {
  classifyCriticVerdict,
  type ClassifyCriticVerdictOptions,
} from "./classify"

export {
  VALID_FIXTURES,
  INVALID_FIXTURES,
  UNKNOWN_FIXTURES,
  makeOversizedFixture,
  allFixtures,
  type CriticVerdictFixture,
} from "./fixtures"
