/**
 * P5.3 pre-work: Tests for JWT signature verification (RS256) + JWKS fetcher.
 *
 * These tests prove the signature verification logic is correct using a local
 * OIDC test server (real HTTP + real RSA-2048 keys + real RS256 signatures).
 * They do NOT satisfy P5.3's "real issuer/JWKS probe" acceptance criterion —
 * that requires operator-provided OIDC configuration (D-002).
 */

import assert from "node:assert/strict"
import test from "node:test"
import {
  verifyJwtSignature,
  jwkToPem,
  createJwksFetcher,
  createCacheBackedSignatureVerifier,
  warmJwksCache,
} from "./signature_verify"
import { JwksKeyCache } from "./jwks_cache"
import { LocalOidcServer } from "./local_oidc_server"

// ---------- helpers ----------

function b64url(obj: unknown): string {
  const json = JSON.stringify(obj)
  return Buffer.from(json, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

// ============================================================
// verifyJwtSignature
// ============================================================

test("P5.3 verifyJwtSignature: valid RS256 signature → true", async () => {
  const server = new LocalOidcServer({ issuer: "http://127.0.0.1", audience: "test-api" })
  await server.start()
  try {
    const token = server.issueToken({ sub: "user1" })
    const pem = server.getPublicKeyPem()
    assert.equal(verifyJwtSignature(token, pem), true)
  } finally {
    await server.stop()
  }
})

test("P5.3 verifyJwtSignature: tampered payload → false", async () => {
  const server = new LocalOidcServer({ issuer: "http://127.0.0.1", audience: "test-api" })
  await server.start()
  try {
    const token = server.issueToken({ sub: "user1" })
    const parts = token.split(".")
    // Flip last chars of payload — signature won't match
    const tamperedPayload = parts[1].slice(0, -2) + "xx"
    const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`
    const pem = server.getPublicKeyPem()
    assert.equal(verifyJwtSignature(tamperedToken, pem), false)
  } finally {
    await server.stop()
  }
})

test("P5.3 verifyJwtSignature: wrong key → false", async () => {
  const server1 = new LocalOidcServer({ issuer: "http://127.0.0.1", audience: "test-api" })
  const server2 = new LocalOidcServer({ issuer: "http://127.0.0.1", audience: "test-api" })
  await server1.start()
  await server2.start()
  try {
    const token = server1.issueToken({ sub: "user1" })
    const wrongPem = server2.getPublicKeyPem()
    assert.equal(verifyJwtSignature(token, wrongPem), false)
  } finally {
    await server1.stop()
    await server2.stop()
  }
})

test("P5.3 verifyJwtSignature: malformed token (2 parts) → false", () => {
  assert.equal(verifyJwtSignature("header.payload", "some-pem"), false)
})

test("P5.3 verifyJwtSignature: empty token → false", () => {
  assert.equal(verifyJwtSignature("", "some-pem"), false)
})

test("P5.3 verifyJwtSignature: empty key → false", () => {
  assert.equal(verifyJwtSignature("a.b.c", ""), false)
})

test("P5.3 verifyJwtSignature: non-RS256 algorithm (HS256) → false", () => {
  // Construct a JWT with alg=HS256 — verifyJwtSignature must reject it
  const header = b64url({ alg: "HS256", typ: "JWT", kid: "test" })
  const payload = b64url({ sub: "user1" })
  const fakeSignature = b64url("fake-signature")
  const token = `${header}.${payload}.${fakeSignature}`
  assert.equal(verifyJwtSignature(token, "some-pem"), false)
})

// ============================================================
// jwkToPem
// ============================================================

test("P5.3 jwkToPem: valid RSA JWK → PEM string", async () => {
  const server = new LocalOidcServer({ issuer: "http://127.0.0.1", audience: "test-api" })
  await server.start()
  try {
    // Fetch the JWKS from the server to get a real JWK
    const response = await fetch(server.jwksEndpoint)
    const jwks = (await response.json()) as { keys: Array<Record<string, unknown>> }
    const jwk = jwks.keys[0]
    const pem = jwkToPem(jwk as { kty: string; n?: string; e?: string })
    assert.ok(pem !== null, "jwkToPem must return a PEM string for a valid RSA JWK")
    assert.ok(pem!.startsWith("-----BEGIN PUBLIC KEY-----"), "PEM must start with public key header")
  } finally {
    await server.stop()
  }
})

test("P5.3 jwkToPem: non-RSA JWK (kty='EC') → null", () => {
  const result = jwkToPem({ kty: "EC", x: "abc", y: "def" })
  assert.equal(result, null)
})

test("P5.3 jwkToPem: missing n → null", () => {
  const result = jwkToPem({ kty: "RSA", e: "AQAB" })
  assert.equal(result, null)
})

test("P5.3 jwkToPem: missing e → null", () => {
  const result = jwkToPem({ kty: "RSA", n: "some-modulus" })
  assert.equal(result, null)
})

// ============================================================
// createJwksFetcher
// ============================================================

test("P5.3 createJwksFetcher: fetches JWKS and returns PEM for matching kid", async () => {
  const server = new LocalOidcServer({ issuer: "http://127.0.0.1", audience: "test-api" })
  await server.start()
  try {
    const fetcher = createJwksFetcher(server.jwksEndpoint)
    const pem = await fetcher(server.kid)
    assert.ok(pem !== null, "fetcher must return PEM for matching kid")
    assert.ok(pem!.startsWith("-----BEGIN PUBLIC KEY-----"))
  } finally {
    await server.stop()
  }
})

test("P5.3 createJwksFetcher: kid not found → null (fail-closed)", async () => {
  const server = new LocalOidcServer({ issuer: "http://127.0.0.1", audience: "test-api" })
  await server.start()
  try {
    const fetcher = createJwksFetcher(server.jwksEndpoint)
    const pem = await fetcher("nonexistent-kid")
    assert.equal(pem, null)
  } finally {
    await server.stop()
  }
})

test("P5.3 createJwksFetcher: network error (invalid endpoint) → null (fail-closed)", async () => {
  const fetcher = createJwksFetcher("http://127.0.0.1:1/nonexistent")
  const pem = await fetcher("any-kid")
  assert.equal(pem, null)
})

// ============================================================
// LocalOidcServer + End-to-end signature verification
// ============================================================

test("P5.3 LocalOidcServer: JWKS endpoint serves correct key", async () => {
  const server = new LocalOidcServer({ issuer: "http://127.0.0.1", audience: "test-api" })
  await server.start()
  try {
    const response = await fetch(server.jwksEndpoint)
    assert.equal(response.status, 200)
    const jwks = (await response.json()) as { keys: Array<{ kid?: string; kty?: string; alg?: string }> }
    assert.equal(jwks.keys.length, 1)
    assert.equal(jwks.keys[0].kid, server.kid)
    assert.equal(jwks.keys[0].kty, "RSA")
    assert.equal(jwks.keys[0].alg, "RS256")
  } finally {
    await server.stop()
  }
})

test("P5.3 end-to-end: issue token → fetch JWKS → verify signature → true", async () => {
  const server = new LocalOidcServer({
    issuer: "http://127.0.0.1",
    audience: "kefu-rag-api",
    kid: "e2e-test-key",
  })
  await server.start()
  try {
    // 1. Issue a token
    const token = server.issueToken({
      sub: "user-123",
      tenant_id: "tenant-abc",
      groups: ["admin"],
      scope: "chat ingest",
    })

    // 2. Fetch the signing key via JWKS
    const fetcher = createJwksFetcher(server.jwksEndpoint)
    const pem = await fetcher("e2e-test-key")
    assert.ok(pem !== null, "JWKS fetch must succeed")

    // 3. Verify the signature
    assert.equal(verifyJwtSignature(token, pem!), true)
  } finally {
    await server.stop()
  }
})

test("P5.3 end-to-end: server.getJwksFetcher() delegates to createJwksFetcher correctly", async () => {
  const server = new LocalOidcServer({ issuer: "http://127.0.0.1", audience: "test-api" })
  await server.start()
  try {
    const fetcher = server.getJwksFetcher()
    const pem = await fetcher(server.kid)
    assert.ok(pem !== null, "getJwksFetcher must return PEM via delegation")
    assert.ok(pem!.startsWith("-----BEGIN PUBLIC KEY-----"))
  } finally {
    await server.stop()
  }
})

test("P5.3 end-to-end: token issued by server → verified with server-fetched key → true; tampered → false", async () => {
  const server = new LocalOidcServer({ issuer: "http://127.0.0.1", audience: "test-api" })
  await server.start()
  try {
    const token = server.issueToken({ sub: "user1" })
    const fetcher = server.getJwksFetcher()
    const pem = await fetcher(server.kid)
    assert.ok(pem !== null)

    // Valid token
    assert.equal(verifyJwtSignature(token, pem!), true)

    // Tampered token
    const parts = token.split(".")
    const tampered = `${parts[0]}.${parts[1].slice(0, -2)}xx.${parts[2]}`
    assert.equal(verifyJwtSignature(tampered, pem!), false)
  } finally {
    await server.stop()
  }
})

// ============================================================
// warmJwksCache (P5.3 composition root helper)
// ============================================================

test("P5.3 warmJwksCache: valid JWKS endpoint → warms cache with 1 key, returns 1", async () => {
  const server = new LocalOidcServer({
    issuer: "http://127.0.0.1",
    audience: "test-api",
    kid: "warm-test-key",
  })
  await server.start()
  try {
    const cache = new JwksKeyCache()
    const count = await warmJwksCache(server.jwksEndpoint, cache)
    assert.equal(count, 1, "must warm exactly 1 key")
    // Cache must contain the key
    const pem = cache.get("warm-test-key")
    assert.ok(pem !== null, "cache must contain the warmed key")
    assert.ok(pem!.startsWith("-----BEGIN PUBLIC KEY-----"))
  } finally {
    await server.stop()
  }
})

test("P5.3 warmJwksCache: network error (invalid endpoint) → returns 0 (fail-closed)", async () => {
  const cache = new JwksKeyCache()
  const count = await warmJwksCache("http://127.0.0.1:1/nonexistent", cache)
  assert.equal(count, 0, "must return 0 on network error")
  assert.equal(cache.get("any-kid"), null, "cache must remain empty")
})

test("P5.3 warmJwksCache: warmed cache + createCacheBackedSignatureVerifier → verifies token", async () => {
  const server = new LocalOidcServer({
    issuer: "http://127.0.0.1",
    audience: "kefu-rag-api",
    kid: "composition-root-key",
  })
  await server.start()
  try {
    // 1. Warm the cache (simulates composition root startup)
    const cache = new JwksKeyCache()
    const warmed = await warmJwksCache(server.jwksEndpoint, cache)
    assert.equal(warmed, 1)

    // 2. Create the verifier (simulates composition root wiring)
    const verifier = createCacheBackedSignatureVerifier(cache)

    // 3. Issue a token and verify it (simulates request-time verification)
    const token = server.issueToken({
      sub: "user-456",
      tenant_id: "tenant-prod",
      scope: "chat ingest",
    })
    assert.equal(verifier(token, "composition-root-key"), true, "warmed cache must verify valid token")

    // 4. Tampered token must fail
    const parts = token.split(".")
    const sigChars = parts[2].split("")
    const midIdx = Math.floor(sigChars.length / 2)
    sigChars[midIdx] = sigChars[midIdx] === "A" ? "B" : "A"
    const tamperedToken = `${parts[0]}.${parts[1]}.${sigChars.join("")}`
    assert.equal(verifier(tamperedToken, "composition-root-key"), false, "tampered token must fail")
  } finally {
    await server.stop()
  }
})

test("P5.3 warmJwksCache: empty cache (warming failed) → verifier rejects all tokens (fail-closed)", async () => {
  const server = new LocalOidcServer({
    issuer: "http://127.0.0.1",
    audience: "test-api",
    kid: "fail-closed-key",
  })
  await server.start()
  try {
    // Warm from a WRONG endpoint → cache stays empty
    const cache = new JwksKeyCache()
    const count = await warmJwksCache("http://127.0.0.1:1/wrong-endpoint", cache)
    assert.equal(count, 0)

    // Verifier with empty cache → all tokens rejected
    const verifier = createCacheBackedSignatureVerifier(cache)
    const token = server.issueToken({ sub: "user1" })
    assert.equal(verifier(token, "fail-closed-key"), false, "empty cache must reject all tokens")
  } finally {
    await server.stop()
  }
})
