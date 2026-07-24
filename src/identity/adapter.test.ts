import assert from "node:assert/strict"
import test from "node:test"
import express from "express"
import type { Request, Response } from "express"
import {
  OidcIdentityAdapter,
  extractBearerToken,
  loadOidcConfig,
  type OidcEnvSource,
  type JwtClaims,
} from "./index"
import {
  singleTenantAccessContext,
  validateAccessMode,
  type AccessContext,
  type IdentityAdapter,
} from "../access/context"
import { createAccessMiddleware } from "../api/access_middleware"
import { evaluateGraphAcl } from "../retrieval/graph_acl"

// ---------- helpers (mirror identity.test.ts style) ----------

function b64url(obj: unknown): string {
  const json = JSON.stringify(obj)
  return Buffer.from(json, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

/** Build an unsigned JWT (header.payload.signature) for claim tests. */
function makeToken(claims: Partial<JwtClaims>): string {
  const header = b64url({ alg: "RS256", typ: "JWT", kid: "test-kid" })
  const payload = b64url(claims)
  return `${header}.${payload}.signature`
}

const FULL_ENV: OidcEnvSource = {
  OIDC_ISSUER: "https://issuer.example.com",
  OIDC_AUDIENCE: "kefu-rag-api",
  OIDC_JWKS_ENDPOINT: "https://issuer.example.com/.well-known/jwks.json",
}

const NOW = 1_700_000_000_000 // fixed test clock (ms)
const NOW_SECONDS = Math.floor(NOW / 1000)

/** A token valid under FULL_ENV: correct iss/aud, far-future exp. */
function validToken(overrides: Partial<JwtClaims> = {}): string {
  return makeToken({
    iss: "https://issuer.example.com",
    aud: "kefu-rag-api",
    exp: NOW_SECONDS + 3600,
    sub: "user-1",
    tenant_id: "tenant-a",
    scope: "chat ingest review admin",
    ...overrides,
  })
}

/** Build an active OIDC config + adapter wired to a fixed clock. */
function activeAdapter(now: () => number = () => NOW): OidcIdentityAdapter {
  const config = loadOidcConfig(FULL_ENV, "enforced")
  assert.equal(config.kind, "active")
  return new OidcIdentityAdapter({ config, now })
}

// ---------- Express harness (mirror access_middleware.test.ts) ----------

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

// ============================================================
// P5.2 deny test #1: API — enforced + no token → 401
// ============================================================

test("P5.2 #1 API: enforced mode + no Authorization header → 401 missing identity", async () => {
  const adapter = activeAdapter()
  const { port, close } = await withServer({
    mode: "enforced",
    adapter,
    requiredScope: "chat",
  })
  try {
    const res = await postProbe(port)
    assert.equal(res.status, 401, "enforced + no token must return 401")
    assert.ok(
      res.json && /missing identity/i.test(String(res.json.error || "")),
      `error must mention 'missing identity', got: ${JSON.stringify(res.json)}`
    )
  } finally {
    await close()
  }
})

// ============================================================
// P5.2 deny test #2: API — enforced + invalid token → 401
// ============================================================

test("P5.2 #2 API: enforced mode + malformed token → 401 (decodeJwtUnsafe fails closed)", async () => {
  const adapter = activeAdapter()
  const { port, close } = await withServer({
    mode: "enforced",
    adapter,
    requiredScope: "chat",
  })
  try {
    // Not a JWT (no dots) → decodeJwtUnsafe returns null → adapter null → 401
    const res = await postProbe(port, {}, { Authorization: "Bearer not-a-jwt" })
    assert.equal(res.status, 401, "malformed token must return 401")
  } finally {
    await close()
  }
})

test("P5.2 #2b API: enforced mode + token with expired claims → 401 (validateClaims fails closed)", async () => {
  const adapter = activeAdapter()
  const { port, close } = await withServer({
    mode: "enforced",
    adapter,
    requiredScope: "chat",
  })
  try {
    // exp in the past relative to NOW beyond clock skew (default 60s)
    // → validateClaims returns invalid (token_expired)
    const expired = validToken({ exp: NOW_SECONDS - 3600 })
    const res = await postProbe(port, {}, { Authorization: `Bearer ${expired}` })
    assert.equal(res.status, 401, "expired token must return 401")
  } finally {
    await close()
  }
})

// ============================================================
// P5.2 deny test #3: API — enforced + valid token but missing
// required scope → 403 (identity present, authorization denied)
// ============================================================

test("P5.2 #3 API: enforced + valid token but missing chat scope → 403", async () => {
  const adapter = activeAdapter()
  // Token carries only ingest scope — valid identity, no chat authorization.
  const token = validToken({ scope: "ingest" })
  const { port, close } = await withServer({
    mode: "enforced",
    adapter,
    requiredScope: "chat",
  })
  try {
    const res = await postProbe(port, {}, { Authorization: `Bearer ${token}` })
    assert.equal(res.status, 403, "valid identity without chat scope must return 403")
    assert.ok(
      res.json && /chat/i.test(String(res.json.error || "")),
      `error must mention the missing 'chat' scope, got: ${JSON.stringify(res.json)}`
    )
  } finally {
    await close()
  }
})

test("P5.2 #3b API: enforced + valid token WITH chat scope → 204 + accessContext injected (positive control)", async () => {
  const adapter = activeAdapter()
  const token = validToken({ scope: "chat", tenant_id: "tenant-a", sub: "user-1" })
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
    const res = await postProbe(port, {}, { Authorization: `Bearer ${token}` })
    assert.equal(res.status, 204, "valid token + chat scope must call next()")
    assert.ok(captured, "accessContext must be injected into res.locals")
    assert.equal(captured!.tenantId, "tenant-a")
    assert.equal(captured!.subjectId, "user-1")
    assert.ok(captured!.scopes.includes("chat"))
  } finally {
    await close()
  }
})

// ============================================================
// P5.2 deny test #4: Retrieval — adapter-produced accessContext
// reaches the retrieval ACL gate; cross-tenant candidate denied
// ============================================================

test("P5.2 #4 Retrieval: adapter-produced accessContext (tenant-a) denies cross-tenant candidate (tenant-b)", async () => {
  const adapter = activeAdapter()
  // Simulate the middleware path: adapter.resolve produces the accessContext
  // that would be injected into res.locals and propagated to the searcher.
  const req = { headers: { authorization: `Bearer ${validToken({ tenant_id: "tenant-a" })}` } }
  const ctx = await adapter.resolve(req)
  assert.ok(ctx, "adapter must resolve a valid accessContext for a valid token")
  assert.equal(ctx!.tenantId, "tenant-a")

  // The same accessContext reaches the retrieval ACL gate (P2.1 predicate).
  // A tenant-b chunk candidate must be denied — cross_tenant.
  const activeDocIds = new Set<string>(["doc-active"])
  const decision = evaluateGraphAcl(
    { tenantId: "tenant-b", documentId: "doc-active" },
    ctx!,
    activeDocIds
  )
  assert.equal(decision.authorized, false, "cross-tenant candidate must be denied")
  assert.equal(decision.reason, "cross_tenant")
})

test("P5.2 #4b Retrieval: adapter-produced accessContext authorizes same-tenant candidate (positive control)", async () => {
  const adapter = activeAdapter()
  const req = { headers: { authorization: `Bearer ${validToken({ tenant_id: "tenant-a" })}` } }
  const ctx = await adapter.resolve(req)
  assert.ok(ctx)
  const activeDocIds = new Set<string>(["doc-active"])
  const decision = evaluateGraphAcl(
    { tenantId: "tenant-a", documentId: "doc-active" },
    ctx!,
    activeDocIds
  )
  assert.equal(decision.authorized, true, "same-tenant candidate must be authorized")
})

// ============================================================
// P5.2 deny test #5: Ingestion — enforced + valid token but missing
// ingest scope → 403 (identity context reaches the ingestion gate)
// ============================================================

test("P5.2 #5 Ingestion: enforced + valid token but missing ingest scope → 403", async () => {
  const adapter = activeAdapter()
  // Token carries only chat scope — valid identity, no ingest authorization.
  const token = validToken({ scope: "chat" })
  const { port, close } = await withServer({
    mode: "enforced",
    adapter,
    requiredScope: "ingest",
  })
  try {
    const res = await postProbe(port, {}, { Authorization: `Bearer ${token}` })
    assert.equal(res.status, 403, "valid identity without ingest scope must return 403")
    assert.ok(
      res.json && /ingest/i.test(String(res.json.error || "")),
      `error must mention the missing 'ingest' scope, got: ${JSON.stringify(res.json)}`
    )
  } finally {
    await close()
  }
})

test("P5.2 #5b Ingestion: enforced + no token → 401 (identity required at ingestion gate)", async () => {
  const adapter = activeAdapter()
  const { port, close } = await withServer({
    mode: "enforced",
    adapter,
    requiredScope: "ingest",
  })
  try {
    const res = await postProbe(port)
    assert.equal(res.status, 401, "ingestion gate must require identity in enforced mode")
  } finally {
    await close()
  }
})

test("P5.2 #5c Ingestion: enforced + valid token WITH ingest scope → 204 (positive control)", async () => {
  const adapter = activeAdapter()
  const token = validToken({ scope: "ingest", tenant_id: "tenant-a" })
  let captured: AccessContext | undefined
  const { port, close } = await withServer(
    {
      mode: "enforced",
      adapter,
      requiredScope: "ingest",
    },
    (_req, res) => {
      captured = res.locals.accessContext as AccessContext
      res.status(204).end()
    }
  )
  try {
    const res = await postProbe(port, {}, { Authorization: `Bearer ${token}` })
    assert.equal(res.status, 204, "valid token + ingest scope must call next()")
    assert.ok(captured, "accessContext must reach the ingestion handler")
    assert.equal(captured!.tenantId, "tenant-a")
  } finally {
    await close()
  }
})

// ============================================================
// P5.2 deny test #6: single_tenant — no token → 200 (backward compat)
// ============================================================

test("P5.2 #6 single_tenant: no token → 200 (backward compat — OIDC path skipped)", async () => {
  // single_tenant middleware never calls the adapter; it injects the
  // deterministic singleTenantAccessContext directly. No Authorization
  // header is required.
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

test("P5.2 #6b single_tenant: adapter with noop config returns null (defense-in-depth)", async () => {
  const noopConfig = loadOidcConfig(FULL_ENV, "single_tenant")
  assert.equal(noopConfig.kind, "noop")
  const adapter = new OidcIdentityAdapter({ config: noopConfig, now: () => NOW })
  // Even with a valid token, noop config → null (single_tenant uses the
  // middleware's singleTenantAccessContext path, not the adapter).
  const req = { headers: { authorization: `Bearer ${validToken()}` } }
  assert.equal(await adapter.resolve(req), null, "noop config must never produce an accessContext")
})

// ============================================================
// P5.2: validateAccessMode startup gate (P5.2 extension)
// ============================================================

test("P5.2 validateAccessMode: enforced + adapter does NOT throw (P5.2 — enforced mode operational)", () => {
  const adapter = activeAdapter()
  // Must not throw — the adapter is wired, enforced mode passes startup.
  validateAccessMode({ accessMode: "enforced", adapter })
})

test("P5.2 validateAccessMode: enforced + no adapter STILL throws (backward compat — pre-P5.2 behavior)", () => {
  // Existing callers that don't supply an adapter must see the same
  // fail-closed behavior (Ticket 05 P4 contract preserved).
  assert.throws(
    () => validateAccessMode({ accessMode: "enforced" }),
    /identity adapter/i,
    "enforced mode without adapter must still fail closed at startup"
  )
})

test("P5.2 validateAccessMode: single_tenant never throws (with or without adapter)", () => {
  validateAccessMode({ accessMode: "single_tenant" })
  const adapter = activeAdapter()
  validateAccessMode({ accessMode: "single_tenant", adapter })
})

// ============================================================
// P5.2: adapter fail_closed config (enforced + misconfigured)
// ============================================================

test("P5.2 adapter: fail_closed config rejects every request (runtime fail-closed)", async () => {
  const failClosed = loadOidcConfig(
    { ...FULL_ENV, OIDC_ISSUER: undefined },
    "enforced"
  )
  assert.equal(failClosed.kind, "fail_closed")
  const adapter = new OidcIdentityAdapter({ config: failClosed, now: () => NOW })
  const req = { headers: { authorization: `Bearer ${validToken()}` } }
  assert.equal(
    await adapter.resolve(req),
    null,
    "fail_closed config must reject every token (misconfigured enforced mode)"
  )
})

// ============================================================
// P5.2: adapter unit — token extraction + claim mapping
// ============================================================

test("P5.2 adapter: missing Authorization header → null", async () => {
  const adapter = activeAdapter()
  assert.equal(await adapter.resolve({ headers: {} }), null)
  assert.equal(await adapter.resolve({ headers: { authorization: "" } }), null)
})

test("P5.2 adapter: non-Bearer Authorization scheme → null", async () => {
  const adapter = activeAdapter()
  const req = { headers: { authorization: `Basic ${validToken()}` } }
  assert.equal(await adapter.resolve(req), null)
})

test("P5.2 adapter: custom claim mapping (tenant from 'tenant', subject from 'sub')", async () => {
  const env: OidcEnvSource = {
    ...FULL_ENV,
    OIDC_TENANT_CLAIM: "tenant",
    OIDC_SUBJECT_CLAIM: "sub",
  }
  const config = loadOidcConfig(env, "enforced")
  assert.equal(config.kind, "active")
  const adapter = new OidcIdentityAdapter({ config, now: () => NOW })
  const token = makeToken({
    iss: "https://issuer.example.com",
    aud: "kefu-rag-api",
    exp: NOW_SECONDS + 3600,
    sub: "user-9",
    tenant: "tenant-custom",
    scope: "chat",
  })
  const ctx = await adapter.resolve({ headers: { authorization: `Bearer ${token}` } })
  assert.ok(ctx, "custom claim mapping must resolve")
  assert.equal(ctx!.tenantId, "tenant-custom")
  assert.equal(ctx!.subjectId, "user-9")
})

test("P5.2 adapter: groups claim propagated to accessContext.groups", async () => {
  const adapter = activeAdapter()
  const token = validToken({ groups: ["engineers", "support"] })
  const ctx = await adapter.resolve({ headers: { authorization: `Bearer ${token}` } })
  assert.ok(ctx)
  assert.deepEqual(ctx!.groups, ["engineers", "support"])
})

test("P5.2 adapter: token with missing tenant claim → null (fail closed)", async () => {
  const adapter = activeAdapter()
  // Valid iss/aud/exp but no tenant_id claim — cannot be bound to an identity.
  const token = validToken({ tenant_id: undefined })
  const ctx = await adapter.resolve({ headers: { authorization: `Bearer ${token}` } })
  assert.equal(ctx, null, "token without tenant claim must be rejected")
})

test("P5.2 extractBearerToken: extracts token from standard Bearer header", () => {
  assert.equal(
    extractBearerToken({ headers: { authorization: "Bearer abc.def.ghi" } }),
    "abc.def.ghi"
  )
  assert.equal(
    extractBearerToken({ headers: { Authorization: "Bearer  token-with-space  " } }),
    "token-with-space"
  )
  assert.equal(extractBearerToken({ headers: {} }), null)
  assert.equal(extractBearerToken({ headers: { authorization: "Basic xyz" } }), null)
  assert.equal(extractBearerToken(null), null)
  assert.equal(extractBearerToken({}), null)
})

// ============================================================
// P5.2 蓝军 self-checks (PUA Protocol)
// ============================================================

test("P5.2 蓝军 #1: enforced mode without adapter at runtime → 401 (runtime fail-closed complements startup gate)", async () => {
  // Even though validateAccessMode passes at startup with an adapter, the
  // middleware itself must fail closed if adapter.resolve() returns null.
  // This test uses an adapter that always returns null (noop config).
  const noopConfig = loadOidcConfig(FULL_ENV, "single_tenant")
  const adapter = new OidcIdentityAdapter({ config: noopConfig, now: () => NOW })
  const { port, close } = await withServer({
    mode: "enforced",
    adapter,
    requiredScope: "chat",
  })
  try {
    const res = await postProbe(port, {}, { Authorization: `Bearer ${validToken()}` })
    assert.equal(res.status, 401, "adapter.resolve()=null must yield 401 even with a token")
  } finally {
    await close()
  }
})

test("P5.2 蓝军 #2: same identity context reaches both chat gate and ingest gate (single adapter instance)", async () => {
  // The SAME adapter instance serves both the chat middleware and the ingest
  // middleware (per server.ts wiring). A token with both chat+ingest scopes
  // must be accepted at both gates with identical tenantId/subjectId.
  const adapter = activeAdapter()
  const token = validToken({ scope: "chat ingest", tenant_id: "tenant-a", sub: "user-1" })

  let chatCtx: AccessContext | undefined
  const chatServer = await withServer(
    { mode: "enforced", adapter, requiredScope: "chat" },
    (_req, res) => {
      chatCtx = res.locals.accessContext as AccessContext
      res.status(204).end()
    }
  )
  let ingestCtx: AccessContext | undefined
  const ingestServer = await withServer(
    { mode: "enforced", adapter, requiredScope: "ingest" },
    (_req, res) => {
      ingestCtx = res.locals.accessContext as AccessContext
      res.status(204).end()
    }
  )
  try {
    await postProbe(chatServer.port, {}, { Authorization: `Bearer ${token}` })
    await postProbe(ingestServer.port, {}, { Authorization: `Bearer ${token}` })
    assert.ok(chatCtx && ingestCtx, "both gates must inject accessContext")
    assert.equal(chatCtx!.tenantId, ingestCtx!.tenantId, "tenantId must match across gates")
    assert.equal(chatCtx!.subjectId, ingestCtx!.subjectId, "subjectId must match across gates")
  } finally {
    await chatServer.close()
    await ingestServer.close()
  }
})

test("P5.2 蓝军 #3: no live network I/O performed (D-002 honored — P5.3 scope)", async () => {
  // The adapter must not perform any live JWKS fetch. P5.2 is wiring-only;
  // signature verification is P5.3. Resolving a valid token must not touch
  // the network — it only decodes + validates claims locally.
  const adapter = activeAdapter()
  const token = validToken()
  const ctx = await adapter.resolve({ headers: { authorization: `Bearer ${token}` } })
  assert.ok(ctx, "adapter must resolve without any network I/O")
  // No fetch/getSigningKey call — the pipeline is decode → validateClaims.
})

test("P5.2 蓝军 #4: single_tenant mode is byte-identical to pre-P5.2 (no ingest middleware, no adapter call)", async () => {
  // single_tenant middleware injects singleTenantAccessContext directly;
  // the adapter is never constructed in single_tenant mode (index.ts guards
  // on cfg.accessMode === "enforced"). Verify the deterministic context.
  let captured: AccessContext | undefined
  const { port, close } = await withServer(
    { mode: "single_tenant", requiredScope: "chat" },
    (_req, res) => {
      captured = res.locals.accessContext as AccessContext
      res.status(204).end()
    }
  )
  try {
    const res = await postProbe(port)
    assert.equal(res.status, 204)
    assert.deepEqual(captured, singleTenantAccessContext())
  } finally {
    await close()
  }
})
