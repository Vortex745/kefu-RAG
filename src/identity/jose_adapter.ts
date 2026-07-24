/**
 * Ticket 05: Replace cache-only OIDC verification with jose-based async
 * standards-based verification.
 *
 * This adapter uses the maintained `jose` library for signature, issuer,
 * audience, allowed algorithm (RS256), expiry, and not-before validation in
 * ONE trust boundary (`jwtVerify`). Remote JWKS caching, cooldown, and key
 * rotation are handled by jose's `createRemoteJWKS` — a cold cache or a
 * rotated `kid` recovers without process restart.
 *
 * Fail-closed semantics:
 * - `noop` config (single_tenant) → returns null (middleware never calls us).
 * - `fail_closed` config (enforced + missing OIDC fields) → returns null.
 * - `active` config → extract token → `jwtVerify` → construct AccessContext
 *   from the VERIFIED payload. Any failure (no token, malformed JWT, claim
 *   mismatch, expired, invalid signature, unknown key, JWKS outage beyond
 *   bounded cache behavior) → null (→ 401 at the middleware).
 *
 * The adapter is ASYNC because jose's `jwtVerify` and `createRemoteJWKS`
 * fetch are async. The middleware must `await adapter.resolve(req)`.
 */

import { jwtVerify, createRemoteJWKSet } from "jose"
import type { AccessContext, IdentityAdapter } from "../access/context"
import type { OidcConfig } from "./oidc_config"
import type { JwtClaims } from "./claims"
import { accessContextFromClaims, extractBearerToken } from "./adapter"

export interface JoseIdentityAdapterOptions {
  /** The loaded OIDC config (noop / fail_closed / active). */
  config: OidcConfig
  /**
   * Optional jose `createRemoteJWKSet` options (cooldownDuration,
   * cacheMaxAge, timeoutDuration) — only used in `active` config.
   *
   * Production code can leave this unset (jose's defaults apply: 30s
   * cooldown, 10min cacheMaxAge, 5s timeout). Tests that need to exercise
   * key-rotation recovery without waiting 30s can pass
   * `{ cooldownDuration: 0 }` to allow immediate re-fetch on a new kid.
   */
  jwksOptions?: {
    cooldownDuration?: number
    cacheMaxAge?: number
    timeoutDuration?: number
  }
}

/**
 * Identity adapter backed by jose's `jwtVerify` + `createRemoteJWKS`.
 *
 * In enforced mode with an active config, `resolve()` verifies the JWT
 * signature against keys fetched from the JWKS endpoint (with built-in
 * caching, cooldown, and rotation recovery), validates issuer/audience/
 * algorithm/expiry/not-before, and constructs an AccessContext from the
 * verified payload.
 *
 * Single-tenant mode never calls the adapter (the middleware short-circuits
 * to `singleTenantAccessContext()`).
 */
export class JoseIdentityAdapter implements IdentityAdapter {
  private readonly config: OidcConfig
  private readonly remoteJWKS?: ReturnType<typeof createRemoteJWKSet>

  constructor(options: JoseIdentityAdapterOptions) {
    this.config = options.config
    if (options.config.kind === "active") {
      this.remoteJWKS = createRemoteJWKSet(
        new URL(options.config.jwksEndpoint),
        options.jwksOptions,
      )
    }
  }

  async resolve(req: unknown): Promise<AccessContext | null> {
    // noop (single_tenant) — defense-in-depth; middleware never calls us.
    // fail_closed (enforced + misconfigured) — every request rejected.
    if (this.config.kind !== "active") return null
    if (!this.remoteJWKS) return null

    const token = extractBearerToken(req)
    if (!token) return null

    try {
      const { payload } = await jwtVerify(token, this.remoteJWKS, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: ["RS256"],
        clockTolerance: `${this.config.clockSkewSeconds}s`,
      })
      // Construct AccessContext ONLY from the verified payload.
      return accessContextFromClaims(
        payload as JwtClaims,
        this.config.claimMapping,
      )
    } catch {
      // Fail-closed: malformed token, unknown key, invalid signature,
      // JWKS outage beyond bounded cache behavior, claim mismatch,
      // expired, not-yet-valid — all yield null (→ 401 at middleware).
      return null
    }
  }
}
