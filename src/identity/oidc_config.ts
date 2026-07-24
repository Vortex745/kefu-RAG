/**
 * P5.1: OIDC configuration for enforced identity mode.
 *
 * In `single_tenant` mode (default, rollback boundary), OIDC is skipped —
 * `loadOidcConfig` returns a noop config and no JWT validation runs. This
 * preserves backward compatibility: existing single_tenant deployments are
 * unaffected by P5.1.
 *
 * In `enforced` mode, `loadOidcConfig` reads OIDC_ISSUER, OIDC_AUDIENCE and
 * OIDC_JWKS_ENDPOINT from the environment. If ANY required field is missing
 * or blank, the result is `fail_closed` — the caller MUST reject, never
 * silently degrade to no-OIDC. This is the fail-closed guarantee required by
 * the P5.1 gate: a misconfigured enforced deployment rejects every token
 * rather than accepting unverified ones.
 *
 * Live JWKS fetch (connecting to the real issuer endpoint) is P5.3 scope
 * (D-002 operator-blocked). P5.1 only defines the config structure and the
 * bounded key cache; it does NOT perform any network I/O. A fail_closed
 * config is a configuration error, not a trigger to connect to a live issuer.
 */

/** Claim mapping: which JWT claim becomes tenantId / subjectId / groups. */
export interface ClaimMapping {
  tenantClaim: string // default "tenant_id"
  subjectClaim: string // default "sub"
  groupsClaim: string // default "groups"
}

/** Active OIDC configuration (enforced mode, fully configured). */
export interface ActiveOidcConfig {
  kind: "active"
  issuer: string
  audience: string
  jwksEndpoint: string
  claimMapping: ClaimMapping
  /** Allowed clock skew (seconds) for exp/nbf checks. Default 60. */
  clockSkewSeconds: number
}

/** Noop config — single_tenant mode skips OIDC entirely (backward compat). */
export interface NoopOidcConfig {
  kind: "noop"
  reason: string
}

/** Fail-closed signal — enforced mode misconfigured (missing required fields). */
export interface FailClosedOidcConfig {
  kind: "fail_closed"
  reason: string
  missingFields: string[]
}

export type OidcConfig = NoopOidcConfig | ActiveOidcConfig | FailClosedOidcConfig

export const DEFAULT_CLAIM_MAPPING: ClaimMapping = {
  tenantClaim: "tenant_id",
  subjectClaim: "sub",
  groupsClaim: "groups",
}

export const DEFAULT_CLOCK_SKEW_SECONDS = 60

/** Environment source for OIDC config (testable — inject process.env or a fake). */
export interface OidcEnvSource {
  OIDC_ISSUER?: string
  OIDC_AUDIENCE?: string
  OIDC_JWKS_ENDPOINT?: string
  OIDC_TENANT_CLAIM?: string
  OIDC_SUBJECT_CLAIM?: string
  OIDC_GROUPS_CLAIM?: string
  OIDC_CLOCK_SKEW_SECONDS?: string
}

function isBlank(v: string | undefined): boolean {
  return v === undefined || v.trim() === ""
}

/**
 * Load OIDC configuration from the environment.
 *
 * - `single_tenant` → noop (OIDC skipped, backward compat preserved).
 * - `enforced` + all required fields present → active config.
 * - `enforced` + ANY required field missing/blank → fail_closed (the caller
 *   MUST reject; never silently degrade to no-OIDC).
 *
 * Required fields for enforced mode: OIDC_ISSUER, OIDC_AUDIENCE, OIDC_JWKS_ENDPOINT.
 */
export function loadOidcConfig(
  env: OidcEnvSource,
  accessMode: "single_tenant" | "enforced"
): OidcConfig {
  if (accessMode === "single_tenant") {
    return { kind: "noop", reason: "single_tenant_mode" }
  }

  // enforced — all required fields must be present and non-blank
  const missingFields: string[] = []
  if (isBlank(env.OIDC_ISSUER)) missingFields.push("OIDC_ISSUER")
  if (isBlank(env.OIDC_AUDIENCE)) missingFields.push("OIDC_AUDIENCE")
  if (isBlank(env.OIDC_JWKS_ENDPOINT)) missingFields.push("OIDC_JWKS_ENDPOINT")
  if (missingFields.length > 0) {
    return {
      kind: "fail_closed",
      reason: `enforced mode missing required OIDC config: ${missingFields.join(", ")}`,
      missingFields,
    }
  }

  const clockSkewSeconds = env.OIDC_CLOCK_SKEW_SECONDS
    ? Number(env.OIDC_CLOCK_SKEW_SECONDS)
    : DEFAULT_CLOCK_SKEW_SECONDS
  if (!Number.isFinite(clockSkewSeconds) || clockSkewSeconds < 0) {
    return {
      kind: "fail_closed",
      reason: `OIDC_CLOCK_SKEW_SECONDS must be a non-negative finite number`,
      missingFields: ["OIDC_CLOCK_SKEW_SECONDS"],
    }
  }

  return {
    kind: "active",
    issuer: env.OIDC_ISSUER!.trim(),
    audience: env.OIDC_AUDIENCE!.trim(),
    jwksEndpoint: env.OIDC_JWKS_ENDPOINT!.trim(),
    claimMapping: {
      tenantClaim: env.OIDC_TENANT_CLAIM?.trim() || DEFAULT_CLAIM_MAPPING.tenantClaim,
      subjectClaim: env.OIDC_SUBJECT_CLAIM?.trim() || DEFAULT_CLAIM_MAPPING.subjectClaim,
      groupsClaim: env.OIDC_GROUPS_CLAIM?.trim() || DEFAULT_CLAIM_MAPPING.groupsClaim,
    },
    clockSkewSeconds,
  }
}
