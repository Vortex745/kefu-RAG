/**
 * P5.1 + P5.2 + P5.3: Identity module barrel — OIDC config + bounded JWKS key
 * cache + claim validation + signature verification. Additive only; no
 * production caller wires signature verification yet (P5.3 Executor part is
 * wired and tested; the live JWKS probe / Supervisor verification is blocked
 * on D-002 — operator must provide real OIDC issuer config).
 */

export {
  loadOidcConfig,
  DEFAULT_CLAIM_MAPPING,
  DEFAULT_CLOCK_SKEW_SECONDS,
} from "./oidc_config"
export type {
  OidcConfig,
  ActiveOidcConfig,
  NoopOidcConfig,
  FailClosedOidcConfig,
  ClaimMapping,
  OidcEnvSource,
} from "./oidc_config"

export {
  JwksKeyCache,
  getSigningKey,
  DEFAULT_JWKS_MAX_KEYS,
  DEFAULT_JWKS_TTL_MS,
} from "./jwks_cache"
export type {
  JwksCacheEntry,
  JwksCacheOptions,
  SigningKeyResult,
  JwksFetcher,
} from "./jwks_cache"

export { validateClaims, decodeJwtUnsafe } from "./claims"
export type { JwtClaims, ClaimValidationResult } from "./claims"

// P5.2: concrete IdentityAdapter wiring P5.1 primitives into the access gate.
export { OidcIdentityAdapter, extractBearerToken, accessContextFromClaims } from "./adapter"
export type { IdentityAdapterOptions } from "./adapter"

// Ticket 05: jose-based async IdentityAdapter with remote JWKS caching/rotation.
export { JoseIdentityAdapter } from "./jose_adapter"
export type { JoseIdentityAdapterOptions } from "./jose_adapter"

// P5.3: signature verification primitives + cache-backed verifier factory + cache warmer.
// Retained as compatibility helpers — production callers now use JoseIdentityAdapter.
export {
  verifyJwtSignature,
  jwkToPem,
  createJwksFetcher,
  createCacheBackedSignatureVerifier,
  warmJwksCache,
} from "./signature_verify"
