/**
 * P5.3: JWT signature verification using Node.js built-in crypto.
 *
 * This module closes the "unsafe" gap left by P5.1's `decodeJwtUnsafe`:
 * after decoding the JWT and before trusting its claims, the caller MUST
 * verify the signature against a key obtained from the JWKS cache.
 *
 * Supports RS256 (RSA-SHA256), the standard algorithm for OIDC-issued JWTs.
 * No external dependencies — uses only `node:crypto`.
 *
 * Fail-closed: any error during verification (malformed token, wrong key
 * format, signature mismatch) returns `false`. The caller treats `false`
 * as a rejected token (→ 401 at the middleware).
 */

import { createPublicKey, verify as cryptoVerify } from "node:crypto"
import type { JwksKeyCache } from "./jwks_cache"

/**
 * Verify a JWT's RS256 signature.
 *
 * @param token - The full JWT string (header.payload.signature)
 * @param pemKey - The public key in PEM format (obtained from JWKS)
 * @returns `true` if the signature is valid, `false` otherwise (fail-closed)
 */
export function verifyJwtSignature(token: string, pemKey: string): boolean {
  if (typeof token !== "string" || token.length === 0) return false
  if (typeof pemKey !== "string" || pemKey.length === 0) return false

  const parts = token.split(".")
  if (parts.length !== 3) return false

  const [headerB64, payloadB64, signatureB64] = parts
  const signingInput = `${headerB64}.${payloadB64}`

  // Decode the signature from base64url
  const signature = base64urlToBuffer(signatureB64)
  if (signature === null) return false

  // Verify the header declares RS256
  try {
    const header = JSON.parse(base64urlToString(headerB64) ?? "")
    if (header.alg !== "RS256") return false
  } catch {
    return false
  }

  try {
    const keyObject = createPublicKey(pemKey)
    return cryptoVerify(
      "RSA-SHA256",
      Buffer.from(signingInput, "utf8"),
      keyObject,
      signature
    )
  } catch {
    return false
  }
}

/**
 * Convert a JWK (JSON Web Key) to a PEM string suitable for `verifyJwtSignature`.
 *
 * This is used by the JWKS fetcher to convert the JWK from the JWKS endpoint
 * response into the PEM format that `verifyJwtSignature` expects.
 */
export function jwkToPem(jwk: {
  kty: string
  n?: string
  e?: string
  x?: string
  y?: string
  [key: string]: unknown
}): string | null {
  if (jwk.kty !== "RSA") return null
  if (!jwk.n || !jwk.e) return null

  try {
    const keyObject = createPublicKey({ key: jwk, format: "jwk" })
    return keyObject.export({ type: "spki", format: "pem" }).toString("utf8")
  } catch {
    return null
  }
}

/**
 * Fetch JWKS from an endpoint and return the PEM key for the given kid.
 *
 * This is the concrete `JwksFetcher` implementation that P5.3 wires into
 * the `getSigningKey` function. It fetches the JWKS JSON from the endpoint,
 * finds the key matching `kid`, converts it to PEM, and returns it.
 *
 * Returns `null` on any error (network failure, key not found, conversion
 * failure) — this is the fail-closed contract: the caller rejects the token.
 */
export function createJwksFetcher(
  jwksEndpoint: string
): (kid: string) => Promise<string | null> {
  return async (kid: string): Promise<string | null> => {
    try {
      const response = await fetch(jwksEndpoint)
      if (!response.ok) return null
      const jwks = (await response.json()) as { keys?: Array<{ kid?: string; [k: string]: unknown }> }
      if (!jwks.keys || !Array.isArray(jwks.keys)) return null

      const key = jwks.keys.find((k) => k.kid === kid)
      if (!key) return null

      return jwkToPem(key as { kty: string; n?: string; e?: string })
    } catch {
      return null
    }
  }
}

// ---------- internal helpers ----------

function base64urlToBuffer(s: string): Buffer | null {
  try {
    let b64 = s.replace(/-/g, "+").replace(/_/g, "/")
    const pad = b64.length % 4
    if (pad) b64 += "=".repeat(4 - pad)
    return Buffer.from(b64, "base64")
  } catch {
    return null
  }
}

function base64urlToString(s: string): string | null {
  const buf = base64urlToBuffer(s)
  return buf ? buf.toString("utf8") : null
}

/**
 * P5.3: Create a sync signature verifier backed by a `JwksKeyCache`.
 *
 * This is the bridge between the sync `IdentityAdapter.resolve()` and the
 * `JwksKeyCache` / `verifyJwtSignature` primitives. The composition root
 * warms the cache at startup via `warmJwksCache`, then passes the resulting
 * verifier closure to `OidcIdentityAdapter`.
 *
 * Contract:
 * - Cache hit (kid found, not expired) → `verifyJwtSignature(token, pem)`
 * - Cache miss (kid not found or expired) → `false` (fail-closed)
 * - Any error → `false` (fail-closed)
 *
 * The verifier is sync because `JwksKeyCache.get(kid)` is sync — live JWKS
 * fetch (async) is the composition root's responsibility, NOT the verifier's.
 */
export function createCacheBackedSignatureVerifier(
  cache: JwksKeyCache
): (token: string, kid: string) => boolean {
  return (token: string, kid: string): boolean => {
    try {
      const pem = cache.get(kid)
      if (pem === null) return false
      return verifyJwtSignature(token, pem)
    } catch {
      return false
    }
  }
}

/**
 * P5.3: Warm a `JwksKeyCache` by fetching all keys from a JWKS endpoint.
 *
 * The composition root calls this at startup to pre-populate the cache so
 * that `createCacheBackedSignatureVerifier` can verify tokens synchronously
 * without a network round-trip on the first request.
 *
 * @param jwksEndpoint - The JWKS URL (e.g., "https://issuer/.well-known/jwks.json")
 * @param cache - The `JwksKeyCache` to populate
 * @returns Number of keys successfully warmed (0 on any error — fail-closed)
 */
export async function warmJwksCache(
  jwksEndpoint: string,
  cache: JwksKeyCache
): Promise<number> {
  try {
    const response = await fetch(jwksEndpoint)
    if (!response.ok) return 0
    const jwks = (await response.json()) as { keys?: Array<{ kid?: string; [k: string]: unknown }> }
    if (!jwks.keys || !Array.isArray(jwks.keys)) return 0

    let warmed = 0
    for (const jwk of jwks.keys) {
      if (typeof jwk.kid !== "string" || jwk.kid.length === 0) continue
      const pem = jwkToPem(jwk as { kty: string; n?: string; e?: string })
      if (pem !== null) {
        cache.set(jwk.kid, pem)
        warmed++
      }
    }
    return warmed
  } catch {
    return 0
  }
}
