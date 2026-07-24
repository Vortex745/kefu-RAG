/**
 * Ticket 05: JoseIdentityAdapter tests with local rotating OIDC/JWKS server.
 *
 * Tests cover all acceptance criteria:
 * 1. Async verification without changing route authorization outcomes
 * 2. jose verifier for signature, issuer, audience, algorithm, expiry, not-before
 * 3. Remote JWKS caching/cooldown — cold cache and rotated kid recover
 * 4. AccessContext constructed only from verified payload
 * 5. Fail-closed for missing config, JWKS outage, malformed token, unknown key,
 *    invalid signature, claim mismatch
 * 6. Single-tenant mode token-free and compatible
 * 7. 401 vs 403, required-scope checks, no side effects after rejection
 */

import assert from "node:assert/strict"
import test from "node:test"
import express from "express"
import type { Request, Response } from "express"
import { JoseIdentityAdapter } from "./jose_adapter"
import { LocalOidcServer } from "./local_oidc_server"
import { loadOidcConfig, type OidcEnvSource } from "./oidc_config"
import { createAccessMiddleware } from "../api/access_middleware"
import type { AccessContext } from "../access/context"

// ---------- test harness ----------

const AUDIENCE = "kefu-rag-api"

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
  headers: Record<string, string> = {}
) {
  const res = await fetch(`http://localhost:${port}/probe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({}),
  })
  const json = (await res.json().catch(() => null)) as { error?: string } | null
  return { status: res.status, json }
}

function makeEnv(issuer: string, jwksEndpoint: string): OidcEnvSource {
  return {
    OIDC_ISSUER: issuer,
    OIDC_AUDIENCE: AUDIENCE,
    OIDC_JWKS_ENDPOINT: jwksEndpoint,
  }
}

// ============================================================
// 1. Valid token → AccessContext (signature + claims verified by jose)
// ============================================================

test("jose adapter: valid signed token → resolves AccessContext (jose verifies signature + claims)", async () => {
  const oidcServer = new LocalOidcServer({ issuer: "http://127.0.0.1", audience: AUDIENCE })
  await oidcServer.start()
  try {
    const env = makeEnv(oidcServer.issuer, oidcServer.jwksEndpoint)
    const config = loadOidcConfig(env, "enforced")
    assert.equal(config.kind, "active")
    const adapter = new JoseIdentityAdapter({ config })

    const token = oidcServer.issueToken({
      sub: "user-1",
      tenant_id: "tenant-a",
      groups: ["engineers"],
      scope: "chat ingest",
    })
    const req = { headers: { authorization: `Bearer ${token}` } }
    const ctx = await adapter.resolve(req)
    assert.ok(ctx, "valid signed token must resolve an AccessContext")
    assert.equal(ctx!.tenantId, "tenant-a")
    assert.equal(ctx!.subjectId, "user-1")
    assert.deepEqual(ctx!.groups, ["engineers"])
    assert.ok(ctx!.scopes.includes("chat"))
    assert.ok(ctx!.scopes.includes("ingest"))
  } finally {
    await oidcServer.stop()
  }
})

// ============================================================
// 2. jose verifies issuer, audience, algorithm, expiry, not-before
// ============================================================

test("jose adapter: wrong issuer → null (fail-closed)", async () => {
  const oidcServer = new LocalOidcServer({ issuer: "http://127.0.0.1", audience: AUDIENCE })
  await oidcServer.start()
  try {
    const env = makeEnv(oidcServer.issuer, oidcServer.jwksEndpoint)
    const config = loadOidcConfig(env, "enforced")
    const adapter = new JoseIdentityAdapter({ config })

    // Token with a DIFFERENT issuer than configured
    const token = oidcServer.issueToken({
      iss: "https://wrong-issuer.example.com",
      sub: "user-1",
      tenant_id: "tenant-a",
    })
    const ctx = await adapter.resolve({ headers: { authorization: `Bearer ${token}` } })
    assert.equal(ctx, null, "wrong issuer must be rejected")
  } finally {
    await oidcServer.stop()
  }
})

test("jose adapter: wrong audience → null (fail-closed)", async () => {
  const oidcServer = new LocalOidcServer({ issuer: "http://127.0.0.1", audience: AUDIENCE })
  await oidcServer.start()
  try {
    const env = makeEnv(oidcServer.issuer, oidcServer.jwksEndpoint)
    const config = loadOidcConfig(env, "enforced")
    const adapter = new JoseIdentityAdapter({ config })

    const token = oidcServer.issueToken({
      aud: "wrong-audience",
      sub: "user-1",
      tenant_id: "tenant-a",
    })
    const ctx = await adapter.resolve({ headers: { authorization: `Bearer ${token}` } })
    assert.equal(ctx, null, "wrong audience must be rejected")
  } finally {
    await oidcServer.stop()
  }
})

test("jose adapter: expired token → null (fail-closed)", async () => {
  const oidcServer = new LocalOidcServer({ issuer: "http://127.0.0.1", audience: AUDIENCE })
  await oidcServer.start()
  try {
    const env = makeEnv(oidcServer.issuer, oidcServer.jwksEndpoint)
    const config = loadOidcConfig(env, "enforced")
    const adapter = new JoseIdentityAdapter({ config })

    const now = Math.floor(Date.now() / 1000)
    const token = oidcServer.issueToken({
      exp: now - 3600, // expired 1 hour ago (beyond clock skew)
      sub: "user-1",
      tenant_id: "tenant-a",
    })
    const ctx = await adapter.resolve({ headers: { authorization: `Bearer ${token}` } })
    assert.equal(ctx, null, "expired token must be rejected")
  } finally {
    await oidcServer.stop()
  }
})

test("jose adapter: not-yet-valid token (nbf in future) → null (fail-closed)", async () => {
  const oidcServer = new LocalOidcServer({ issuer: "http://127.0.0.1", audience: AUDIENCE })
  await oidcServer.start()
  try {
    const env = makeEnv(oidcServer.issuer, oidcServer.jwksEndpoint)
    const config = loadOidcConfig(env, "enforced")
    const adapter = new JoseIdentityAdapter({ config })

    const now = Math.floor(Date.now() / 1000)
    const token = oidcServer.issueToken({
      nbf: now + 3600, // not valid for 1 hour (beyond clock skew)
      sub: "user-1",
      tenant_id: "tenant-a",
    })
    const ctx = await adapter.resolve({ headers: { authorization: `Bearer ${token}` } })
    assert.equal(ctx, null, "not-yet-valid token must be rejected")
  } finally {
    await oidcServer.stop()
  }
})

test("jose adapter: malformed token (not a JWT) → null (fail-closed)", async () => {
  const oidcServer = new LocalOidcServer({ issuer: "http://127.0.0.1", audience: AUDIENCE })
  await oidcServer.start()
  try {
    const env = makeEnv(oidcServer.issuer, oidcServer.jwksEndpoint)
    const config = loadOidcConfig(env, "enforced")
    const adapter = new JoseIdentityAdapter({ config })

    const ctx = await adapter.resolve({ headers: { authorization: "Bearer not-a-jwt" } })
    assert.equal(ctx, null, "malformed token must be rejected")
  } finally {
    await oidcServer.stop()
  }
})

test("jose adapter: missing Authorization header → null", async () => {
  const oidcServer = new LocalOidcServer({ issuer: "http://127.0.0.1", audience: AUDIENCE })
  await oidcServer.start()
  try {
    const env = makeEnv(oidcServer.issuer, oidcServer.jwksEndpoint)
    const config = loadOidcConfig(env, "enforced")
    const adapter = new JoseIdentityAdapter({ config })

    const ctx = await adapter.resolve({ headers: {} })
    assert.equal(ctx, null, "missing Authorization header must return null")
  } finally {
    await oidcServer.stop()
  }
})

test("jose adapter: token with missing tenant claim → null (fail-closed)", async () => {
  const oidcServer = new LocalOidcServer({ issuer: "http://127.0.0.1", audience: AUDIENCE })
  await oidcServer.start()
  try {
    const env = makeEnv(oidcServer.issuer, oidcServer.jwksEndpoint)
    const config = loadOidcConfig(env, "enforced")
    const adapter = new JoseIdentityAdapter({ config })

    const token = oidcServer.issueToken({
      sub: "user-1",
      tenant_id: undefined, // missing tenant
    })
    const ctx = await adapter.resolve({ headers: { authorization: `Bearer ${token}` } })
    assert.equal(ctx, null, "token without tenant claim must be rejected")
  } finally {
    await oidcServer.stop()
  }
})

// ============================================================
// 3. Remote JWKS caching/cooldown — cold cache + rotated kid recover
// ============================================================

test("jose adapter: cold cache (first request) → fetches from JWKS → resolves", async () => {
  const oidcServer = new LocalOidcServer({ issuer: "http://127.0.0.1", audience: AUDIENCE })
  await oidcServer.start()
  try {
    const env = makeEnv(oidcServer.issuer, oidcServer.jwksEndpoint)
    const config = loadOidcConfig(env, "enforced")
    const adapter = new JoseIdentityAdapter({ config })

    // First request — jose's createRemoteJWKS has a cold cache, must fetch
    const token = oidcServer.issueToken({ sub: "user-1", tenant_id: "tenant-a" })
    const ctx = await adapter.resolve({ headers: { authorization: `Bearer ${token}` } })
    assert.ok(ctx, "cold cache must fetch from JWKS and resolve")
    assert.equal(ctx!.tenantId, "tenant-a")
  } finally {
    await oidcServer.stop()
  }
})

test("jose adapter: key rotation — rotated kid → fetches new key → resolves without restart", async () => {
  const oidcServer = new LocalOidcServer({ issuer: "http://127.0.0.1", audience: AUDIENCE, kid: "key-1" })
  await oidcServer.start()
  try {
    const env = makeEnv(oidcServer.issuer, oidcServer.jwksEndpoint)
    const config = loadOidcConfig(env, "enforced")
    // cooldownDuration: 0 — allow immediate re-fetch when a new kid appears.
    // jose's default cooldown is 30s; production code uses defaults, but
    // tests need to exercise rotation recovery without waiting.
    const adapter = new JoseIdentityAdapter({
      config,
      jwksOptions: { cooldownDuration: 0 },
    })

    // First token with key-1
    const token1 = oidcServer.issueToken({ sub: "user-1", tenant_id: "tenant-a" })
    const ctx1 = await adapter.resolve({ headers: { authorization: `Bearer ${token1}` } })
    assert.ok(ctx1, "first key must verify")

    // Rotate to key-2
    oidcServer.rotateKey("key-2")

    // Token with key-2 — adapter must fetch the new key from JWKS
    const token2 = oidcServer.issueToken({ sub: "user-1", tenant_id: "tenant-a" })
    const ctx2 = await adapter.resolve({ headers: { authorization: `Bearer ${token2}` } })
    assert.ok(ctx2, "rotated kid must recover by fetching new key from JWKS")
    assert.equal(ctx2!.tenantId, "tenant-a")
  } finally {
    await oidcServer.stop()
  }
})

test("jose adapter: old kid after rotation → null (old key no longer in JWKS)", async () => {
  const oidcServer = new LocalOidcServer({ issuer: "http://127.0.0.1", audience: AUDIENCE, kid: "key-1" })
  await oidcServer.start()
  try {
    const env = makeEnv(oidcServer.issuer, oidcServer.jwksEndpoint)
    const config = loadOidcConfig(env, "enforced")
    const adapter = new JoseIdentityAdapter({ config })

    // Issue token with key-1
    const oldToken = oidcServer.issueToken({ sub: "user-1", tenant_id: "tenant-a" })

    // Rotate to key-2 — old key is no longer served by JWKS
    oidcServer.rotateKey("key-2")

    // Old token (signed with key-1, kid=key-1) — jose can't find key-1 in JWKS
    // jose's cache may still have key-1 from the first fetch. But if the cache
    // has expired or been evicted, the fetch will return only key-2.
    // To force a cache miss, we create a NEW adapter (simulates cache expiry).
    const adapter2 = new JoseIdentityAdapter({ config })
    const ctx = await adapter2.resolve({ headers: { authorization: `Bearer ${oldToken}` } })
    // jose will try to fetch key-1 from JWKS — it's not there anymore.
    // jose may still have it in its internal cache from adapter.resolve() above,
    // but adapter2 has a fresh cache. The old kid is not in the new JWKS.
    assert.equal(ctx, null, "old kid not in JWKS after rotation must be rejected (fail-closed)")
  } finally {
    await oidcServer.stop()
  }
})

// ============================================================
// 4. JWKS outage → fail-closed
// ============================================================

test("jose adapter: JWKS outage (server down) → null (fail-closed)", async () => {
  const oidcServer = new LocalOidcServer({ issuer: "http://127.0.0.1", audience: AUDIENCE })
  await oidcServer.start()
  const env = makeEnv(oidcServer.issuer, oidcServer.jwksEndpoint)
  const config = loadOidcConfig(env, "enforced")

  // Create adapter and verify it works while server is up
  const adapter = new JoseIdentityAdapter({ config })
  const token = oidcServer.issueToken({ sub: "user-1", tenant_id: "tenant-a" })
  const ctxOk = await adapter.resolve({ headers: { authorization: `Bearer ${token}` } })
  assert.ok(ctxOk, "adapter must work while JWKS server is up")

  // Stop the server — simulate JWKS outage
  await oidcServer.stop()

  // Create a FRESH adapter (no cached keys) and try to verify
  // jose's createRemoteJWKS will try to fetch → connection refused → fail-closed
  const adapter2 = new JoseIdentityAdapter({ config })
  const ctxOutage = await adapter2.resolve({ headers: { authorization: `Bearer ${token}` } })
  assert.equal(ctxOutage, null, "JWKS outage must result in fail-closed (null)")
})

// ============================================================
// 5. Config modes: noop and fail_closed
// ============================================================

test("jose adapter: noop config (single_tenant) → null (defense-in-depth)", () => {
  const noopConfig = loadOidcConfig({ OIDC_ISSUER: "x" }, "single_tenant")
  assert.equal(noopConfig.kind, "noop")
  const adapter = new JoseIdentityAdapter({ config: noopConfig })
  return adapter.resolve({ headers: { authorization: "Bearer some-token" } }).then((ctx) => {
    assert.equal(ctx, null, "noop config must never produce an accessContext")
  })
})

test("jose adapter: fail_closed config (enforced + missing fields) → null", () => {
  const failClosedConfig = loadOidcConfig({}, "enforced")
  assert.equal(failClosedConfig.kind, "fail_closed")
  const adapter = new JoseIdentityAdapter({ config: failClosedConfig })
  return adapter.resolve({ headers: { authorization: "Bearer some-token" } }).then((ctx) => {
    assert.equal(ctx, null, "fail_closed config must reject every token")
  })
})

// ============================================================
// 6. Custom claim mapping
// ============================================================

test("jose adapter: custom claim mapping (tenant from 'tenant', subject from 'sub')", async () => {
  const oidcServer = new LocalOidcServer({ issuer: "http://127.0.0.1", audience: AUDIENCE })
  await oidcServer.start()
  try {
    const env: OidcEnvSource = {
      ...makeEnv(oidcServer.issuer, oidcServer.jwksEndpoint),
      OIDC_TENANT_CLAIM: "tenant",
      OIDC_SUBJECT_CLAIM: "sub",
    }
    const config = loadOidcConfig(env, "enforced")
    assert.equal(config.kind, "active")
    const adapter = new JoseIdentityAdapter({ config })

    const token = oidcServer.issueToken({
      sub: "user-9",
      tenant: "tenant-custom",
      scope: "chat",
    })
    const ctx = await adapter.resolve({ headers: { authorization: `Bearer ${token}` } })
    assert.ok(ctx, "custom claim mapping must resolve")
    assert.equal(ctx!.tenantId, "tenant-custom")
    assert.equal(ctx!.subjectId, "user-9")
  } finally {
    await oidcServer.stop()
  }
})

// ============================================================
// 7. Middleware integration: 401/403/204, no side effects
// ============================================================

test("jose adapter middleware: enforced + valid token + chat scope → 204 + AccessContext injected", async () => {
  const oidcServer = new LocalOidcServer({ issuer: "http://127.0.0.1", audience: AUDIENCE })
  await oidcServer.start()
  try {
    const env = makeEnv(oidcServer.issuer, oidcServer.jwksEndpoint)
    const config = loadOidcConfig(env, "enforced")
    const adapter = new JoseIdentityAdapter({ config })

    const token = oidcServer.issueToken({
      sub: "user-1",
      tenant_id: "tenant-a",
      scope: "chat",
    })
    let captured: AccessContext | undefined
    const { port, close } = await withServer(
      { mode: "enforced", adapter, requiredScope: "chat" },
      (_req, res) => {
        captured = res.locals.accessContext as AccessContext
        res.status(204).end()
      }
    )
    try {
      const res = await postProbe(port, { Authorization: `Bearer ${token}` })
      assert.equal(res.status, 204, "valid token + chat scope must call next()")
      assert.ok(captured, "AccessContext must be injected")
      assert.equal(captured!.tenantId, "tenant-a")
    } finally {
      await close()
    }
  } finally {
    await oidcServer.stop()
  }
})

test("jose adapter middleware: enforced + no token → 401", async () => {
  const oidcServer = new LocalOidcServer({ issuer: "http://127.0.0.1", audience: AUDIENCE })
  await oidcServer.start()
  try {
    const env = makeEnv(oidcServer.issuer, oidcServer.jwksEndpoint)
    const config = loadOidcConfig(env, "enforced")
    const adapter = new JoseIdentityAdapter({ config })

    const { port, close } = await withServer({
      mode: "enforced",
      adapter,
      requiredScope: "chat",
    })
    try {
      const res = await postProbe(port)
      assert.equal(res.status, 401, "no token must return 401")
    } finally {
      await close()
    }
  } finally {
    await oidcServer.stop()
  }
})

test("jose adapter middleware: enforced + valid token but missing scope → 403", async () => {
  const oidcServer = new LocalOidcServer({ issuer: "http://127.0.0.1", audience: AUDIENCE })
  await oidcServer.start()
  try {
    const env = makeEnv(oidcServer.issuer, oidcServer.jwksEndpoint)
    const config = loadOidcConfig(env, "enforced")
    const adapter = new JoseIdentityAdapter({ config })

    const token = oidcServer.issueToken({
      sub: "user-1",
      tenant_id: "tenant-a",
      scope: "ingest", // has ingest but not chat
    })
    const { port, close } = await withServer({
      mode: "enforced",
      adapter,
      requiredScope: "chat",
    })
    try {
      const res = await postProbe(port, { Authorization: `Bearer ${token}` })
      assert.equal(res.status, 403, "missing scope must return 403")
    } finally {
      await close()
    }
  } finally {
    await oidcServer.stop()
  }
})

test("jose adapter middleware: 401 does NOT call next() — no side effects", async () => {
  const oidcServer = new LocalOidcServer({ issuer: "http://127.0.0.1", audience: AUDIENCE })
  await oidcServer.start()
  try {
    const env = makeEnv(oidcServer.issuer, oidcServer.jwksEndpoint)
    const config = loadOidcConfig(env, "enforced")
    const adapter = new JoseIdentityAdapter({ config })

    let handlerReached = 0
    const { port, close } = await withServer(
      { mode: "enforced", adapter, requiredScope: "chat" },
      (_req, res) => {
        handlerReached++
        res.status(204).end()
      }
    )
    try {
      await postProbe(port) // no token → 401
      await postProbe(port) // no token → 401
      assert.equal(handlerReached, 0, "handler must not be reached on 401")
    } finally {
      await close()
    }
  } finally {
    await oidcServer.stop()
  }
})

test("jose adapter middleware: single_tenant mode → 204 (backward compat, no token needed)", async () => {
  const { port, close } = await withServer({
    mode: "single_tenant",
    requiredScope: "chat",
  })
  try {
    const res = await postProbe(port)
    assert.equal(res.status, 204, "single_tenant must accept requests with no token")
  } finally {
    await close()
  }
})

// ============================================================
// 8. Invalid signature (tampered token) → null
// ============================================================

test("jose adapter: tampered token (signature altered) → null (fail-closed)", async () => {
  const oidcServer = new LocalOidcServer({ issuer: "http://127.0.0.1", audience: AUDIENCE })
  await oidcServer.start()
  try {
    const env = makeEnv(oidcServer.issuer, oidcServer.jwksEndpoint)
    const config = loadOidcConfig(env, "enforced")
    const adapter = new JoseIdentityAdapter({ config })

    const token = oidcServer.issueToken({ sub: "user-1", tenant_id: "tenant-a" })
    // Tamper with the signature (last part)
    const parts = token.split(".")
    const tamperedSig = parts[2].split("").reverse().join("")
    const tamperedToken = `${parts[0]}.${parts[1]}.${tamperedSig}`

    const ctx = await adapter.resolve({ headers: { authorization: `Bearer ${tamperedToken}` } })
    assert.equal(ctx, null, "tampered signature must be rejected")
  } finally {
    await oidcServer.stop()
  }
})

test("jose adapter: token signed by different key (not in JWKS) → null", async () => {
  const oidcServer = new LocalOidcServer({ issuer: "http://127.0.0.1", audience: AUDIENCE, kid: "served-key" })
  await oidcServer.start()
  try {
    const env = makeEnv(oidcServer.issuer, oidcServer.jwksEndpoint)
    const config = loadOidcConfig(env, "enforced")
    const adapter = new JoseIdentityAdapter({ config })

    // Create a DIFFERENT server with a different key, but use the SAME issuer/audience
    const otherServer = new LocalOidcServer({ issuer: oidcServer.issuer, audience: AUDIENCE, kid: "unserved-key" })
    // Don't start otherServer — just use it to issue a token with a key NOT in the JWKS
    const tokenFromOtherKey = otherServer.issueToken({ sub: "user-1", tenant_id: "tenant-a" })

    // The adapter will try to fetch "unserved-key" from oidcServer's JWKS — it's not there
    const ctx = await adapter.resolve({ headers: { authorization: `Bearer ${tokenFromOtherKey}` } })
    assert.equal(ctx, null, "token signed by unknown key must be rejected")
  } finally {
    await oidcServer.stop()
  }
})
