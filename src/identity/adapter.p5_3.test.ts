/**
 * P5.3 Executor verification: signature verification wiring in OidcIdentityAdapter.
 *
 * These tests verify the Executor part of P5.3 — the signature verification
 * callback wiring. The Supervisor part (real issuer/JWKS probe) remains
 * blocked on D-002 (operator must provide real OIDC issuer config).
 *
 * Test categories:
 * 1. createCacheBackedSignatureVerifier unit tests (cache hit/miss + valid/invalid)
 * 2. Adapter with verifier: valid signature → accessContext
 * 3. Adapter with verifier: invalid signature → null (fail-closed)
 * 4. Adapter with verifier: kid missing from header → null (fail-closed)
 * 5. Adapter without verifier: backward compat (P5.2 behavior unchanged)
 * 6. End-to-end with LocalOidcServer: issue → warm cache → resolve → accessContext
 * 7. End-to-end: tampered token → null; wrong kid → null
 * 8. Express middleware integration: enforced + verifier + valid token → 204
 */

import assert from "node:assert/strict"
import test from "node:test"
import express from "express"
import type { Request, Response } from "express"
import {
  OidcIdentityAdapter,
  loadOidcConfig,
  createCacheBackedSignatureVerifier,
  JwksKeyCache,
  type OidcEnvSource,
} from "./index"
import { LocalOidcServer } from "./local_oidc_server"
import { createAccessMiddleware } from "../api/access_middleware"
import type { AccessContext } from "../access/context"

// ---------- helpers ----------

const NOW = 1_700_000_000_000 // fixed test clock (ms)
const NOW_SECONDS = Math.floor(NOW / 1000)

function b64url(obj: unknown): string {
  const json = JSON.stringify(obj)
  return Buffer.from(json, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

/** Build an unsigned JWT (header.payload.signature) for testing. */
function makeToken(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  signature: string = "fake-signature"
): string {
  return `${b64url(header)}.${b64url(claims)}.${signature}`
}

// ============================================================
// 1. createCacheBackedSignatureVerifier unit tests
// ============================================================

test("P5.3 verifier: cache hit + valid signature → true", async () => {
  const server = new LocalOidcServer({
    issuer: "http://127.0.0.1",
    audience: "kefu-rag-api",
    kid: "verifier-unit-key",
  })
  await server.start()
  try {
    const cache = new JwksKeyCache()
    cache.set("verifier-unit-key", server.getPublicKeyPem())

    const verifier = createCacheBackedSignatureVerifier(cache)
    const token = server.issueToken({
      sub: "user-1",
      tenant_id: "tenant-a",
      scope: "chat",
    })
    assert.equal(verifier(token, "verifier-unit-key"), true)
  } finally {
    await server.stop()
  }
})

test("P5.3 verifier: cache hit + invalid signature → false (fail-closed)", async () => {
  const server = new LocalOidcServer({
    issuer: "http://127.0.0.1",
    audience: "kefu-rag-api",
    kid: "verifier-unit-key",
  })
  await server.start()
  try {
    const cache = new JwksKeyCache()
    cache.set("verifier-unit-key", server.getPublicKeyPem())

    const verifier = createCacheBackedSignatureVerifier(cache)
    // Tamper with the token (change payload but keep header+signature)
    const token = server.issueToken({ sub: "user-1", tenant_id: "tenant-a" })
    const parts = token.split(".")
    const tamperedPayload = b64url({ sub: "attacker", tenant_id: "tenant-a", iss: server.issuer, aud: "kefu-rag-api", exp: NOW_SECONDS + 3600 })
    const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`
    assert.equal(verifier(tamperedToken, "verifier-unit-key"), false)
  } finally {
    await server.stop()
  }
})

test("P5.3 verifier: cache miss (kid not in cache) → false (fail-closed)", () => {
  const cache = new JwksKeyCache()
  const verifier = createCacheBackedSignatureVerifier(cache)
  // No key in cache → fail-closed
  assert.equal(verifier("header.payload.signature", "unknown-kid"), false)
})

test("P5.3 verifier: empty token → false", async () => {
  const server = new LocalOidcServer({
    issuer: "http://127.0.0.1",
    audience: "kefu-rag-api",
  })
  await server.start()
  try {
    const cache = new JwksKeyCache()
    cache.set(server.kid, server.getPublicKeyPem())
    const verifier = createCacheBackedSignatureVerifier(cache)
    assert.equal(verifier("", server.kid), false)
  } finally {
    await server.stop()
  }
})

// ============================================================
// 2. Adapter with verifier: valid signature → accessContext
// ============================================================

test("P5.3 adapter: verifier + valid signature → accessContext returned", async () => {
  const server = new LocalOidcServer({
    issuer: "http://127.0.0.1",
    audience: "kefu-rag-api",
    kid: "adapter-valid-key",
  })
  await server.start()
  try {
    const env: OidcEnvSource = {
      OIDC_ISSUER: server.issuer,
      OIDC_AUDIENCE: "kefu-rag-api",
      OIDC_JWKS_ENDPOINT: server.jwksEndpoint,
    }
    const config = loadOidcConfig(env, "enforced")
    assert.equal(config.kind, "active")

    const cache = new JwksKeyCache()
    cache.set("adapter-valid-key", server.getPublicKeyPem())
    const verifier = createCacheBackedSignatureVerifier(cache)

    const adapter = new OidcIdentityAdapter({
      config,
      now: () => NOW,
      signatureVerifier: verifier,
    })

    const token = server.issueToken({
      sub: "user-42",
      tenant_id: "tenant-x",
      groups: ["engineers"],
      scope: "chat ingest",
    })

    const ctx = await adapter.resolve({
      headers: { authorization: `Bearer ${token}` },
    })
    assert.ok(ctx, "valid signature + valid claims → accessContext must be produced")
    assert.equal(ctx!.tenantId, "tenant-x")
    assert.equal(ctx!.subjectId, "user-42")
    assert.deepEqual(ctx!.groups, ["engineers"])
    assert.ok(ctx!.scopes.includes("chat"))
    assert.ok(ctx!.scopes.includes("ingest"))
  } finally {
    await server.stop()
  }
})

// ============================================================
// 3. Adapter with verifier: invalid signature → null (fail-closed)
// ============================================================

test("P5.3 adapter: verifier + tampered signature → null (fail-closed)", async () => {
  const server = new LocalOidcServer({
    issuer: "http://127.0.0.1",
    audience: "kefu-rag-api",
    kid: "adapter-tamper-key",
  })
  await server.start()
  try {
    const env: OidcEnvSource = {
      OIDC_ISSUER: server.issuer,
      OIDC_AUDIENCE: "kefu-rag-api",
      OIDC_JWKS_ENDPOINT: server.jwksEndpoint,
    }
    const config = loadOidcConfig(env, "enforced")

    const cache = new JwksKeyCache()
    cache.set("adapter-tamper-key", server.getPublicKeyPem())
    const verifier = createCacheBackedSignatureVerifier(cache)

    const adapter = new OidcIdentityAdapter({
      config,
      now: () => NOW,
      signatureVerifier: verifier,
    })

    // Issue a valid token, then tamper with the payload
    const token = server.issueToken({
      sub: "user-1",
      tenant_id: "tenant-a",
      scope: "chat",
    })
    const parts = token.split(".")
    // Replace payload with a different subject (signature won't match)
    const tamperedPayload = b64url({
      iss: server.issuer,
      aud: "kefu-rag-api",
      exp: NOW_SECONDS + 3600,
      iat: NOW_SECONDS,
      sub: "attacker",
      tenant_id: "tenant-a",
      scope: "chat",
    })
    const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`

    const ctx = await adapter.resolve({
      headers: { authorization: `Bearer ${tamperedToken}` },
    })
    // Claims are valid (iss/aud/exp match), but signature verification fails → null
    assert.equal(ctx, null, "tampered signature must be rejected even if claims are valid")
  } finally {
    await server.stop()
  }
})

test("P5.3 adapter: verifier returns false → null (fail-closed)", async () => {
  const server = new LocalOidcServer({
    issuer: "http://127.0.0.1",
    audience: "kefu-rag-api",
    kid: "adapter-reject-key",
  })
  await server.start()
  try {
    const env: OidcEnvSource = {
      OIDC_ISSUER: server.issuer,
      OIDC_AUDIENCE: "kefu-rag-api",
      OIDC_JWKS_ENDPOINT: server.jwksEndpoint,
    }
    const config = loadOidcConfig(env, "enforced")

    // Verifier that always rejects
    const alwaysReject = (): boolean => false

    const adapter = new OidcIdentityAdapter({
      config,
      now: () => NOW,
      signatureVerifier: alwaysReject,
    })

    const token = server.issueToken({
      sub: "user-1",
      tenant_id: "tenant-a",
      scope: "chat",
    })

    const ctx = await adapter.resolve({
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(ctx, null, "verifier returning false must reject the token")
  } finally {
    await server.stop()
  }
})

// ============================================================
// 4. Adapter with verifier: kid missing from header → null (fail-closed)
// ============================================================

test("P5.3 adapter: verifier + token without kid in header → null (fail-closed)", async () => {
  const server = new LocalOidcServer({
    issuer: "http://127.0.0.1",
    audience: "kefu-rag-api",
    kid: "adapter-nokid-key",
  })
  await server.start()
  try {
    const env: OidcEnvSource = {
      OIDC_ISSUER: server.issuer,
      OIDC_AUDIENCE: "kefu-rag-api",
      OIDC_JWKS_ENDPOINT: server.jwksEndpoint,
    }
    const config = loadOidcConfig(env, "enforced")

    const cache = new JwksKeyCache()
    cache.set("adapter-nokid-key", server.getPublicKeyPem())
    const verifier = createCacheBackedSignatureVerifier(cache)

    const adapter = new OidcIdentityAdapter({
      config,
      now: () => NOW,
      signatureVerifier: verifier,
    })

    // Build a token WITHOUT kid in the header
    const tokenWithoutKid = makeToken(
      { alg: "RS256", typ: "JWT" }, // no kid
      {
        iss: server.issuer,
        aud: "kefu-rag-api",
        exp: NOW_SECONDS + 3600,
        iat: NOW_SECONDS,
        sub: "user-1",
        tenant_id: "tenant-a",
        scope: "chat",
      },
      "fake-signature"
    )

    const ctx = await adapter.resolve({
      headers: { authorization: `Bearer ${tokenWithoutKid}` },
    })
    // Claims are valid, but kid is missing → cannot verify signature → null
    assert.equal(ctx, null, "token without kid in header must be rejected when verifier is present")
  } finally {
    await server.stop()
  }
})

test("P5.3 adapter: verifier + kid in cache but wrong key → null (fail-closed)", async () => {
  // Two servers with different keys — cache has server1's key but token is from server2
  const server1 = new LocalOidcServer({
    issuer: "http://127.0.0.1",
    audience: "kefu-rag-api",
    kid: "key-1",
  })
  const server2 = new LocalOidcServer({
    issuer: "http://127.0.0.1",
    audience: "kefu-rag-api",
    kid: "key-2",
  })
  await server1.start()
  await server2.start()
  try {
    // Use server2's issuer (both use 127.0.0.1 but different ports)
    const env: OidcEnvSource = {
      OIDC_ISSUER: server2.issuer,
      OIDC_AUDIENCE: "kefu-rag-api",
      OIDC_JWKS_ENDPOINT: server2.jwksEndpoint,
    }
    const config = loadOidcConfig(env, "enforced")

    // Cache has server1's key under "key-1"
    const cache = new JwksKeyCache()
    cache.set("key-1", server1.getPublicKeyPem())
    const verifier = createCacheBackedSignatureVerifier(cache)

    const adapter = new OidcIdentityAdapter({
      config,
      now: () => NOW,
      signatureVerifier: verifier,
    })

    // Token from server2 with kid="key-2" — cache doesn't have key-2
    const token = server2.issueToken({
      sub: "user-1",
      tenant_id: "tenant-a",
      scope: "chat",
    })

    const ctx = await adapter.resolve({
      headers: { authorization: `Bearer ${token}` },
    })
    // Claims valid (iss/aud match server2), kid="key-2" not in cache → null
    assert.equal(ctx, null, "kid not in cache must be rejected (fail-closed)")
  } finally {
    await server1.stop()
    await server2.stop()
  }
})

// ============================================================
// 5. Adapter without verifier: backward compat (P5.2 behavior unchanged)
// ============================================================

test("P5.3 backward compat: adapter without verifier still accepts unsigned tokens (P5.2 behavior)", async () => {
  const env: OidcEnvSource = {
    OIDC_ISSUER: "https://issuer.example.com",
    OIDC_AUDIENCE: "kefu-rag-api",
    OIDC_JWKS_ENDPOINT: "https://issuer.example.com/.well-known/jwks.json",
  }
  const config = loadOidcConfig(env, "enforced")
  assert.equal(config.kind, "active")

  // No signatureVerifier — P5.2 behavior (claims only, no signature check)
  const adapter = new OidcIdentityAdapter({ config, now: () => NOW })

  // Token with fake signature but valid claims
  const token = makeToken(
    { alg: "RS256", typ: "JWT", kid: "test-kid" },
    {
      iss: "https://issuer.example.com",
      aud: "kefu-rag-api",
      exp: NOW_SECONDS + 3600,
      sub: "user-1",
      tenant_id: "tenant-a",
      scope: "chat",
    },
    "fake-signature"
  )

  const ctx = await adapter.resolve({
    headers: { authorization: `Bearer ${token}` },
  })
  // Without verifier, the fake signature is NOT checked → accessContext produced
  assert.ok(ctx, "without verifier, P5.2 behavior must be preserved (claims-only)")
  assert.equal(ctx!.tenantId, "tenant-a")
  assert.equal(ctx!.subjectId, "user-1")
})

// ============================================================
// 6. End-to-end with LocalOidcServer: issue → warm cache → resolve
// ============================================================

test("P5.3 e2e: issue token → warm cache → adapter.resolve → accessContext", async () => {
  const server = new LocalOidcServer({
    issuer: "http://127.0.0.1",
    audience: "kefu-rag-api",
    kid: "e2e-full-flow-key",
  })
  await server.start()
  try {
    const env: OidcEnvSource = {
      OIDC_ISSUER: server.issuer,
      OIDC_AUDIENCE: "kefu-rag-api",
      OIDC_JWKS_ENDPOINT: server.jwksEndpoint,
    }
    const config = loadOidcConfig(env, "enforced")

    // Simulate composition root warming the cache at startup:
    // 1. Fetch JWKS (live fetch — this is what D-002 would provide in production)
    // 2. Store the PEM in the cache
    const fetcher = server.getJwksFetcher()
    const pem = await fetcher("e2e-full-flow-key")
    assert.ok(pem !== null, "JWKS fetch must succeed")

    const cache = new JwksKeyCache()
    cache.set("e2e-full-flow-key", pem!)

    const verifier = createCacheBackedSignatureVerifier(cache)
    const adapter = new OidcIdentityAdapter({
      config,
      now: () => NOW,
      signatureVerifier: verifier,
    })

    const token = server.issueToken({
      sub: "user-100",
      tenant_id: "tenant-production",
      groups: ["admins", "operators"],
      scope: "chat ingest review admin",
    })

    const ctx = await adapter.resolve({
      headers: { authorization: `Bearer ${token}` },
    })
    assert.ok(ctx, "full e2e flow must produce accessContext")
    assert.equal(ctx!.tenantId, "tenant-production")
    assert.equal(ctx!.subjectId, "user-100")
    assert.deepEqual(ctx!.groups, ["admins", "operators"])
    assert.deepEqual(ctx!.scopes, ["chat", "ingest", "review", "admin"])
  } finally {
    await server.stop()
  }
})

// ============================================================
// 7. End-to-end: tampered token → null; wrong kid → null
// ============================================================

test("P5.3 e2e: tampered token → null (signature mismatch)", async () => {
  const server = new LocalOidcServer({
    issuer: "http://127.0.0.1",
    audience: "kefu-rag-api",
    kid: "e2e-tamper-key",
  })
  await server.start()
  try {
    const env: OidcEnvSource = {
      OIDC_ISSUER: server.issuer,
      OIDC_AUDIENCE: "kefu-rag-api",
      OIDC_JWKS_ENDPOINT: server.jwksEndpoint,
    }
    const config = loadOidcConfig(env, "enforced")

    const cache = new JwksKeyCache()
    cache.set("e2e-tamper-key", server.getPublicKeyPem())
    const verifier = createCacheBackedSignatureVerifier(cache)
    const adapter = new OidcIdentityAdapter({
      config,
      now: () => NOW,
      signatureVerifier: verifier,
    })

    const token = server.issueToken({
      sub: "user-1",
      tenant_id: "tenant-a",
      scope: "chat",
    })

    // Tamper: change a MIDDLE character of the signature (not the last,
    // which may only encode 2 bits and not affect the decoded bytes).
    const parts = token.split(".")
    const sigChars = parts[2].split("")
    const midIdx = Math.floor(sigChars.length / 2)
    sigChars[midIdx] = sigChars[midIdx] === "A" ? "B" : "A"
    const tamperedSig = sigChars.join("")
    const tamperedToken = `${parts[0]}.${parts[1]}.${tamperedSig}`

    const ctx = await adapter.resolve({
      headers: { authorization: `Bearer ${tamperedToken}` },
    })
    assert.equal(ctx, null, "tampered signature must be rejected")
  } finally {
    await server.stop()
  }
})

test("P5.3 e2e: token with wrong kid (not in cache) → null", async () => {
  const server = new LocalOidcServer({
    issuer: "http://127.0.0.1",
    audience: "kefu-rag-api",
    kid: "e2e-wrong-kid-correct",
  })
  await server.start()
  try {
    const env: OidcEnvSource = {
      OIDC_ISSUER: server.issuer,
      OIDC_AUDIENCE: "kefu-rag-api",
      OIDC_JWKS_ENDPOINT: server.jwksEndpoint,
    }
    const config = loadOidcConfig(env, "enforced")

    // Cache is EMPTY — no keys warmed
    const cache = new JwksKeyCache()
    const verifier = createCacheBackedSignatureVerifier(cache)
    const adapter = new OidcIdentityAdapter({
      config,
      now: () => NOW,
      signatureVerifier: verifier,
    })

    const token = server.issueToken({
      sub: "user-1",
      tenant_id: "tenant-a",
      scope: "chat",
    })

    const ctx = await adapter.resolve({
      headers: { authorization: `Bearer ${token}` },
    })
    // Token has valid claims and valid signature, but cache is empty → fail-closed
    assert.equal(ctx, null, "empty cache must reject (fail-closed — no key to verify against)")
  } finally {
    await server.stop()
  }
})

// ============================================================
// 8. Express middleware integration: enforced + verifier + valid token → 204
// ============================================================

async function withServer(
  options: Parameters<typeof createAccessMiddleware>[0],
  handler: (req: Request, res: Response) => void = (_req, res) => {
    res.status(204).end()
  }
) {
  const app = express()
  app.use(express.json())
  app.post("/probe", createAccessMiddleware(options), (req, res) => {
    handler(req, res)
  })
  const server = app.listen(0)
  const port = (server.address() as { port: number }).port
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function postProbe(
  port: number,
  body: unknown = {},
  headers: Record<string, string> = {}
) {
  const res = await fetch(`http://localhost:${port}/probe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => null)) as { error?: string } | null
  return { status: res.status, json }
}

test("P5.3 middleware: enforced + verifier + valid signature → 204 + accessContext injected", async () => {
  const server = new LocalOidcServer({
    issuer: "http://127.0.0.1",
    audience: "kefu-rag-api",
    kid: "middleware-valid-key",
  })
  await server.start()
  try {
    const env: OidcEnvSource = {
      OIDC_ISSUER: server.issuer,
      OIDC_AUDIENCE: "kefu-rag-api",
      OIDC_JWKS_ENDPOINT: server.jwksEndpoint,
    }
    const config = loadOidcConfig(env, "enforced")

    const cache = new JwksKeyCache()
    cache.set("middleware-valid-key", server.getPublicKeyPem())
    const verifier = createCacheBackedSignatureVerifier(cache)
    const adapter = new OidcIdentityAdapter({
      config,
      now: () => NOW,
      signatureVerifier: verifier,
    })

    let captured: AccessContext | undefined
    const { port, close } = await withServer(
      {
        mode: "enforced",
        adapter,
        requiredScope: "chat",
      },
      (_req, res) => {
        captured = res.locals.accessContext as AccessContext
        res.status(204).end()
      }
    )

    try {
      const token = server.issueToken({
        sub: "user-mw",
        tenant_id: "tenant-mw",
        scope: "chat",
      })
      const res = await postProbe(port, {}, { Authorization: `Bearer ${token}` })
      assert.equal(res.status, 204, "valid signature + chat scope → 204")
      assert.ok(captured, "accessContext must be injected into res.locals")
      assert.equal(captured!.tenantId, "tenant-mw")
      assert.equal(captured!.subjectId, "user-mw")
    } finally {
      await close()
    }
  } finally {
    await server.stop()
  }
})

test("P5.3 middleware: enforced + verifier + tampered token → 401", async () => {
  const server = new LocalOidcServer({
    issuer: "http://127.0.0.1",
    audience: "kefu-rag-api",
    kid: "middleware-tamper-key",
  })
  await server.start()
  try {
    const env: OidcEnvSource = {
      OIDC_ISSUER: server.issuer,
      OIDC_AUDIENCE: "kefu-rag-api",
      OIDC_JWKS_ENDPOINT: server.jwksEndpoint,
    }
    const config = loadOidcConfig(env, "enforced")

    const cache = new JwksKeyCache()
    cache.set("middleware-tamper-key", server.getPublicKeyPem())
    const verifier = createCacheBackedSignatureVerifier(cache)
    const adapter = new OidcIdentityAdapter({
      config,
      now: () => NOW,
      signatureVerifier: verifier,
    })

    const { port, close } = await withServer({
      mode: "enforced",
      adapter,
      requiredScope: "chat",
    })

    try {
      const token = server.issueToken({
        sub: "user-1",
        tenant_id: "tenant-a",
        scope: "chat",
      })
      // Tamper: change a MIDDLE character of the signature (not the last,
      // which may only encode 2 bits and not affect the decoded bytes).
      const parts = token.split(".")
      const sigChars = parts[2].split("")
      const midIdx = Math.floor(sigChars.length / 2)
      sigChars[midIdx] = sigChars[midIdx] === "A" ? "B" : "A"
      const tamperedSig = sigChars.join("")
      const tamperedToken = `${parts[0]}.${parts[1]}.${tamperedSig}`

      const res = await postProbe(port, {}, { Authorization: `Bearer ${tamperedToken}` })
      assert.equal(res.status, 401, "tampered signature → 401 (fail-closed at middleware)")
    } finally {
      await close()
    }
  } finally {
    await server.stop()
  }
})

// ============================================================
// 9. 蓝军 self-checks (PUA Protocol)
// ============================================================

test("P5.3 蓝军 #1: verifier does not perform live network I/O (sync only — cache lookup)", async () => {
  // The verifier is a sync function — it CANNOT perform live JWKS fetch.
  // It only reads from the cache. If the cache is empty, it fails closed.
  // This is by design: live fetch is the composition root's responsibility.
  const server = new LocalOidcServer({
    issuer: "http://127.0.0.1",
    audience: "kefu-rag-api",
    kid: "blue-team-nonet-key",
  })
  await server.start()
  try {
    const cache = new JwksKeyCache()
    // Do NOT warm the cache
    const verifier = createCacheBackedSignatureVerifier(cache)

    const token = server.issueToken({
      sub: "user-1",
      tenant_id: "tenant-a",
      scope: "chat",
    })

    // Verifier returns false immediately — no network call, no blocking
    const start = Date.now()
    const result = verifier(token, "blue-team-nonet-key")
    const elapsed = Date.now() - start
    assert.equal(result, false, "empty cache → false (fail-closed)")
    assert.ok(elapsed < 50, `verifier must be near-instant (sync), took ${elapsed}ms`)
  } finally {
    await server.stop()
  }
})

test("P5.3 蓝军 #2: adapter without verifier is byte-identical to P5.2 (backward compat)", async () => {
  // An adapter constructed WITHOUT signatureVerifier must behave exactly
  // like P5.2 — claims validated, signature not checked.
  const env: OidcEnvSource = {
    OIDC_ISSUER: "https://issuer.example.com",
    OIDC_AUDIENCE: "kefu-rag-api",
    OIDC_JWKS_ENDPOINT: "https://issuer.example.com/.well-known/jwks.json",
  }
  const config = loadOidcConfig(env, "enforced")

  const adapterP52 = new OidcIdentityAdapter({ config, now: () => NOW })
  const adapterP53 = new OidcIdentityAdapter({ config, now: () => NOW /* no verifier */ })

  const token = makeToken(
    { alg: "RS256", typ: "JWT", kid: "test-kid" },
    {
      iss: "https://issuer.example.com",
      aud: "kefu-rag-api",
      exp: NOW_SECONDS + 3600,
      sub: "user-1",
      tenant_id: "tenant-a",
      scope: "chat",
    },
    "fake-sig"
  )

  const req = { headers: { authorization: `Bearer ${token}` } }
  const ctx1 = await adapterP52.resolve(req)
  const ctx2 = await adapterP53.resolve(req)
  assert.deepEqual(ctx1, ctx2, "P5.2 and P5.3-without-verifier must produce identical results")
})

test("P5.3 蓝军 #3: noop config + verifier → still null (defense-in-depth)", async () => {
  // Even if a verifier is accidentally wired to a noop (single_tenant) config,
  // the adapter must return null — noop means OIDC is disabled.
  const noopConfig = loadOidcConfig(
    {
      OIDC_ISSUER: "https://issuer.example.com",
      OIDC_AUDIENCE: "kefu-rag-api",
      OIDC_JWKS_ENDPOINT: "https://issuer.example.com/.well-known/jwks.json",
    },
    "single_tenant"
  )
  assert.equal(noopConfig.kind, "noop")

  const cache = new JwksKeyCache()
  const verifier = createCacheBackedSignatureVerifier(cache)
  const adapter = new OidcIdentityAdapter({
    config: noopConfig,
    now: () => NOW,
    signatureVerifier: verifier,
  })

  const req = { headers: { authorization: "Bearer some.token.here" } }
  assert.equal(await adapter.resolve(req), null, "noop config must return null even with verifier")
})

test("P5.3 蓝军 #4: fail_closed config + verifier → still null (defense-in-depth)", async () => {
  const failClosed = loadOidcConfig(
    { OIDC_ISSUER: undefined, OIDC_AUDIENCE: "x", OIDC_JWKS_ENDPOINT: "x" },
    "enforced"
  )
  assert.equal(failClosed.kind, "fail_closed")

  const cache = new JwksKeyCache()
  const verifier = createCacheBackedSignatureVerifier(cache)
  const adapter = new OidcIdentityAdapter({
    config: failClosed,
    now: () => NOW,
    signatureVerifier: verifier,
  })

  const req = { headers: { authorization: "Bearer some.token.here" } }
  assert.equal(await adapter.resolve(req), null, "fail_closed config must return null even with verifier")
})
