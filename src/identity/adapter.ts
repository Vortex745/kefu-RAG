/**
 * P5.2 + P5.3: Concrete IdentityAdapter wiring P5.1's OIDC primitives into
 * the runtime access gate.
 *
 * Pipeline: extract Bearer token → `decodeJwtUnsafe` → `validateClaims` →
 * (P5.3) signature verification → produce `AccessContext` from the validated
 * claims.
 *
 * P5.3 signature verification (Executor part — wired):
 * An optional `signatureVerifier` callback is injected via
 * `IdentityAdapterOptions`. When present, `resolve()` calls it AFTER claim
 * validation passes but BEFORE producing the AccessContext. The verifier is
 * sync and uses a pre-populated `JwksKeyCache` — the composition root is
 * responsible for warming the cache (e.g., via `createJwksFetcher` at
 * startup). When the verifier returns `false` (signature mismatch, kid not
 * in cache, or any error), `resolve()` fails closed (→ null → 401).
 *
 * When no verifier is provided, behavior is unchanged from P5.2 (claims
 * validated but signature not verified) — this preserves backward
 * compatibility for tests and single_tenant deployments.
 *
 * P5.3 live issuer probe (Supervisor part — D-002 blocked):
 * The "real issuer/JWKS probe" acceptance criterion requires a live OIDC
 * issuer endpoint. That is operator-blocked (D-002) and cannot be satisfied
 * by the Executor alone. The verifier wiring here is pre-positioned for
 * rapid activation when D-002 is lifted: the composition root fetches JWKS
 * at startup, warms the cache, and passes the verifier closure to the
 * adapter.
 *
 * Fail-closed semantics:
 * - `noop` config (single_tenant) → returns null. Single-tenant mode never
 *   calls the adapter — the middleware injects `singleTenantAccessContext()`
 *   directly. Returning null here is defense-in-depth.
 * - `fail_closed` config (enforced + missing OIDC fields) → returns null for
 *   every request (every token rejected). This is the runtime fail-closed
 *   gate that complements `validateAccessMode`'s startup gate.
 * - `active` config → decode + validate + (optional) verify. Any failure
 *   (no token, malformed JWT, claim mismatch, expired, signature mismatch,
 *   kid not in cache) → null (→ 401 at the middleware).
 */

import type { Request } from "express"
import type { AccessContext, IdentityAdapter, Scope } from "../access/context"
import type { OidcConfig, ClaimMapping } from "./oidc_config"
import { decodeJwtUnsafe, validateClaims, type JwtClaims } from "./claims"

/** Known scope strings that may appear in a JWT `scope` claim (OAuth2 space-separated). */
const KNOWN_SCOPES: ReadonlySet<string> = new Set(["chat", "ingest", "review", "admin"])

/**
 * Extract the scopes granted by a JWT. Reads the standard OAuth2 `scope`
 * claim (space-separated string). Unknown scope strings are dropped. When
 * the claim is absent, returns `["chat"]` — the minimal scope a valid
 * identity needs to reach any gated route (the middleware still enforces
 * the required scope per route).
 */
function scopesFromClaims(claims: JwtClaims): Scope[] {
  const raw = claims.scope
  if (typeof raw === "string" && raw.length > 0) {
    const scopes = raw
      .split(/\s+/)
      .filter((s): s is Scope => KNOWN_SCOPES.has(s))
    if (scopes.length > 0) return scopes
  }
  // Array form (non-standard but tolerated).
  if (Array.isArray(raw) && raw.every((v) => typeof v === "string")) {
    const scopes = (raw as string[]).filter((s): s is Scope =>
      KNOWN_SCOPES.has(s)
    )
    if (scopes.length > 0) return scopes
  }
  return ["chat"]
}

function groupsFromClaims(claims: JwtClaims, groupsClaim: string): string[] {
  const raw = (claims as JwtClaims)[groupsClaim]
  if (Array.isArray(raw) && raw.every((g) => typeof g === "string")) {
    return raw as string[]
  }
  return []
}

function stringClaim(claims: JwtClaims, key: string): string | null {
  const v = (claims as JwtClaims)[key]
  return typeof v === "string" && v.length > 0 ? v : null
}

/**
 * Build an `AccessContext` from validated JWT claims + the config's claim
 * mapping. Caller MUST have already validated claims (either via
 * `validateClaims` for the sync path, or via jose `jwtVerify` for the
 * async path — both establish the same trust boundary before this function
 * is called).
 */
export function accessContextFromClaims(
  claims: JwtClaims,
  mapping: ClaimMapping
): AccessContext | null {
  const tenantId = stringClaim(claims, mapping.tenantClaim)
  const subjectId = stringClaim(claims, mapping.subjectClaim)
  // A token without a tenant or subject claim cannot be bound to an
  // identity — fail closed (→ 401). The claim-mapping is configurable, so
  // a deployment that uses "sub" for tenant (non-standard) is supported.
  if (!tenantId || !subjectId) return null
  return {
    tenantId,
    subjectId,
    groups: groupsFromClaims(claims, mapping.groupsClaim),
    scopes: scopesFromClaims(claims),
  }
}

/**
 * Extract a Bearer token from an Express request's Authorization header.
 * Returns null when the header is absent or not a Bearer token.
 */
export function extractBearerToken(req: unknown): string | null {
  if (!req || typeof req !== "object") return null
  const headers = (req as { headers?: Record<string, string | string[] | undefined> }).headers
  if (!headers) return null
  const raw = headers.authorization ?? headers.Authorization
  if (typeof raw !== "string") return null
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim())
  return match ? match[1].trim() : null
}

export interface IdentityAdapterOptions {
  /** The loaded OIDC config (noop / fail_closed / active). */
  config: OidcConfig
  /**
   * Injectable clock for `validateClaims` expiry checks. Defaults to
   * `Date.now`. Tests inject a fixed clock for deterministic exp/nbf.
   */
  now?: () => number
  /**
   * P5.3: Optional signature verification callback. When present, `resolve()`
   * calls it AFTER `validateClaims` passes but BEFORE producing the
   * AccessContext. The callback receives the full JWT token and the `kid`
   * extracted from the JWT header. It must return `true` if the signature
   * is valid, `false` otherwise (fail-closed).
   *
   * The callback is sync — it should use a pre-populated `JwksKeyCache`
   * (see `createCacheBackedSignatureVerifier`). Live JWKS fetch is the
   * composition root's responsibility (warm the cache at startup).
   *
   * When omitted, behavior is unchanged from P5.2 (claims validated but
   * signature not verified) — backward compatibility for tests and
   * single_tenant deployments.
   */
  signatureVerifier?: (token: string, kid: string) => boolean
}

/**
 * P5.2 IdentityAdapter — wires P5.1's OIDC primitives into the access
 * middleware contract. In enforced mode, `createAccessMiddleware` calls
 * `adapter.resolve(req)` per request:
 *   - null → 401 missing identity
 *   - AccessContext without required scope → 403
 *   - AccessContext with required scope → injected into res.locals, next()
 *
 * Single-tenant mode never calls the adapter (the middleware short-circuits
 * to `singleTenantAccessContext()`).
 */
export class OidcIdentityAdapter implements IdentityAdapter {
  private readonly config: OidcConfig
  private readonly now: () => number
  private readonly signatureVerifier?: (token: string, kid: string) => boolean

  constructor(options: IdentityAdapterOptions) {
    this.config = options.config
    this.now = options.now ?? (() => Date.now())
    this.signatureVerifier = options.signatureVerifier
  }

  async resolve(req: unknown): Promise<AccessContext | null> {
    // noop (single_tenant) — defense-in-depth; middleware never calls us.
    // fail_closed (enforced + misconfigured) — every request rejected.
    if (this.config.kind !== "active") return null

    const token = extractBearerToken(req)
    if (!token) return null

    const decoded = decodeJwtUnsafe(token)
    if (!decoded) return null

    const result = validateClaims(decoded.claims, this.config, this.now())
    if (!result.valid) return null

    // P5.3: signature verification (Executor part). When a verifier is
    // provided, the token's signature MUST be verified before producing
    // an AccessContext. The kid is extracted from the JWT header; if
    // absent, fail closed (a verifiable token must carry a kid).
    if (this.signatureVerifier) {
      const kid = extractKidFromHeader(decoded.header)
      if (kid === null) return null
      if (!this.signatureVerifier(token, kid)) return null
    }

    return accessContextFromClaims(decoded.claims, this.config.claimMapping)
  }
}

/**
 * Extract the `kid` (Key ID) from a decoded JWT header.
 * Returns null when the header is missing, not an object, or lacks a string `kid`.
 */
function extractKidFromHeader(header: unknown): string | null {
  if (typeof header !== "object" || header === null) return null
  const kid = (header as { kid?: unknown }).kid
  return typeof kid === "string" && kid.length > 0 ? kid : null
}
