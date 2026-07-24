/**
 * P5.1: JWT claim validation against an OIDC config.
 *
 * `validateClaims` checks iss / aud / exp (and nbf if present) against the
 * active OIDC config. Missing issuer or audience in the TOKEN is fail-closed
 * (reject). A noop config (single_tenant) is fail-closed for this path —
 * single_tenant uses `singleTenantAccessContext()`, not JWT.
 *
 * Signature verification is NOT performed here — it is the JWKS key cache's
 * purpose (P5.1 cache + P5.3 live fetch). `decodeJwtUnsafe` only extracts
 * claims; callers MUST verify the signature separately (via the JWKS cache)
 * before trusting these claims. The function is named "Unsafe" to make this
 * contract explicit.
 */

import type { ActiveOidcConfig, OidcConfig } from "./oidc_config"

export interface JwtClaims {
  iss?: unknown
  aud?: unknown
  exp?: unknown
  nbf?: unknown
  sub?: unknown
  iat?: unknown
  [claim: string]: unknown
}

export interface ClaimValidationResult {
  valid: boolean
  reason?: string
}

/**
 * Decode a JWT's header and payload WITHOUT signature verification.
 * Returns null on any structural error (fail-closed — caller must reject).
 */
export function decodeJwtUnsafe(
  token: string
): { header: unknown; claims: JwtClaims } | null {
  if (typeof token !== "string" || token.length === 0) return null
  const parts = token.split(".")
  if (parts.length < 2) return null
  try {
    const header = JSON.parse(base64urlDecode(parts[0])) as unknown
    const claims = JSON.parse(base64urlDecode(parts[1])) as unknown
    if (
      typeof claims !== "object" ||
      claims === null ||
      Array.isArray(claims)
    ) {
      return null
    }
    return { header, claims: claims as JwtClaims }
  } catch {
    return null
  }
}

function base64urlDecode(s: string): string {
  // base64url → base64
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/")
  // pad to multiple of 4
  const pad = b64.length % 4
  if (pad) b64 += "=".repeat(4 - pad)
  return Buffer.from(b64, "base64").toString("utf8")
}

/**
 * Validate JWT claims against an OIDC config.
 *
 * - noop config → invalid (oidc path disabled; single_tenant uses a different path).
 * - fail_closed config → invalid (propagate the fail-closed reason).
 * - active config → validate iss/aud/exp/nbf.
 *
 * Missing iss or aud in the token → reject (fail-closed). This is the P5.1
 * gate: a token without issuer or audience is never accepted.
 */
export function validateClaims(
  claims: JwtClaims,
  config: OidcConfig,
  now: number = Date.now()
): ClaimValidationResult {
  if (config.kind === "noop") {
    return { valid: false, reason: "oidc_disabled_noop_config" }
  }
  if (config.kind === "fail_closed") {
    return { valid: false, reason: `oidc_fail_closed: ${config.reason}` }
  }
  return validateAgainstActiveConfig(claims, config, now)
}

function validateAgainstActiveConfig(
  claims: JwtClaims,
  config: ActiveOidcConfig,
  now: number
): ClaimValidationResult {
  // issuer — must be present and match exactly
  if (claims.iss === undefined || claims.iss === null) {
    return { valid: false, reason: "missing_issuer" }
  }
  if (typeof claims.iss !== "string" || claims.iss !== config.issuer) {
    return { valid: false, reason: "issuer_mismatch" }
  }

  // audience — must be present and contain the configured audience
  if (claims.aud === undefined || claims.aud === null) {
    return { valid: false, reason: "missing_audience" }
  }
  const audList = normalizeAudience(claims.aud)
  if (!audList.includes(config.audience)) {
    return { valid: false, reason: "audience_mismatch" }
  }

  // expiry — must be present and not expired (with clock skew)
  if (claims.exp === undefined || claims.exp === null) {
    return { valid: false, reason: "missing_expiry" }
  }
  const exp = toNumber(claims.exp)
  if (exp === null) {
    return { valid: false, reason: "invalid_expiry" }
  }
  const skewMs = config.clockSkewSeconds * 1000
  if (now > exp * 1000 + skewMs) {
    return { valid: false, reason: "token_expired" }
  }

  // not-before (optional) — if present, must be in the past (with skew)
  if (claims.nbf !== undefined && claims.nbf !== null) {
    const nbf = toNumber(claims.nbf)
    if (nbf === null) {
      return { valid: false, reason: "invalid_nbf" }
    }
    if (now + skewMs < nbf * 1000) {
      return { valid: false, reason: "token_not_yet_valid" }
    }
  }

  return { valid: true }
}

function normalizeAudience(aud: unknown): string[] {
  if (typeof aud === "string") return [aud]
  if (Array.isArray(aud) && aud.every((a) => typeof a === "string")) {
    return aud as string[]
  }
  return []
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v)
  return null
}
