import assert from "node:assert/strict"
import test from "node:test"
import express from "express"
import type { Request, Response } from "express"
import {
  createAccessMiddleware,
  type AccessMiddlewareOptions,
} from "./access_middleware"
import {
  singleTenantAccessContext,
  type AccessContext,
  type IdentityAdapter,
} from "../access/context"

/**
 * Mini harness: builds an Express app with the middleware under test plus a
 * sentinel handler that records whether next() was reached. Returns a fetch-
 * ready server so tests can issue real HTTP requests and observe status codes.
 */
async function withServer(
  options: AccessMiddlewareOptions,
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

async function postProbe(port: number, body: unknown = {}) {
  const res = await fetch(`http://localhost:${port}/probe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => null)) as { error?: string } | null
  return { status: res.status, json }
}

test("Ticket 05 P4: single_tenant mode calls next() and injects deterministic AccessContext into res.locals", async () => {
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
    assert.equal(res.status, 204, "single_tenant middleware must call next()")
    assert.ok(captured, "res.locals.accessContext must be set")
    assert.deepEqual(captured, singleTenantAccessContext())
  } finally {
    await close()
  }
})

test("Ticket 05 P4: enforced mode without adapter returns 401 missing identity (runtime guard)", async () => {
  const { port, close } = await withServer({
    mode: "enforced",
    requiredScope: "chat",
    // no adapter — runtime must reject every request with 401
  })
  try {
    const res = await postProbe(port)
    assert.equal(res.status, 401, "enforced mode without adapter must return 401")
    assert.ok(
      res.json && /missing identity/i.test(String(res.json.error || "")),
      `error message must mention 'missing identity', got: ${JSON.stringify(res.json)}`
    )
  } finally {
    await close()
  }
})

test("Ticket 05 P4: enforced mode with adapter returning null returns 401 missing identity", async () => {
  const adapter: IdentityAdapter = {
    resolve: async () => null,
  }
  const { port, close } = await withServer({
    mode: "enforced",
    adapter,
    requiredScope: "chat",
  })
  try {
    const res = await postProbe(port)
    assert.equal(res.status, 401, "adapter.resolve()=null must return 401")
    assert.ok(
      res.json && /missing identity/i.test(String(res.json.error || "")),
      "error message must mention 'missing identity'"
    )
  } finally {
    await close()
  }
})

test("Ticket 05 P4: enforced mode with identity but missing required scope returns 403", async () => {
  const adapter: IdentityAdapter = {
    resolve: async () => ({
      tenantId: "tenant-a",
      subjectId: "user-1",
      groups: [],
      scopes: ["ingest"], // has 'ingest' but not 'chat'
    }),
  }
  const { port, close } = await withServer({
    mode: "enforced",
    adapter,
    requiredScope: "chat",
  })
  try {
    const res = await postProbe(port)
    assert.equal(res.status, 403, "missing scope must return 403")
    assert.ok(
      res.json && /chat/i.test(String(res.json.error || "")),
      `error message must mention the missing scope 'chat', got: ${JSON.stringify(res.json)}`
    )
  } finally {
    await close()
  }
})

test("Ticket 05 P4: enforced mode with identity and required scope calls next() and injects AccessContext", async () => {
  const ctx: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: ["engineers"],
    scopes: ["chat", "review"],
  }
  const adapter: IdentityAdapter = {
    resolve: async () => ctx,
  }
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
    const res = await postProbe(port)
    assert.equal(res.status, 204, "valid identity + scope must call next()")
    assert.deepEqual(captured, ctx, "res.locals.accessContext must be the adapter-resolved ctx")
  } finally {
    await close()
  }
})

test("Ticket 05 P4: 401/403 responses do NOT call next() — side-effect gating (no Answer run/Ingestion task created)", async () => {
  // Counter tracks whether the handler was reached. 401/403 must keep it at 0.
  let handlerReached = 0
  const adapter: IdentityAdapter = {
    resolve: async () => null, // forces 401
  }
  const { port, close } = await withServer(
    {
      mode: "enforced",
      adapter,
      requiredScope: "chat",
    },
    (_req, res) => {
      handlerReached++
      res.status(204).end()
    }
  )
  try {
    await postProbe(port)
    await postProbe(port)
    await postProbe(port)
    assert.equal(
      handlerReached,
      0,
      "handler must not be reached on 401 — no Answer run/Ingestion task/Handoff case/Feedback row may be created"
    )
  } finally {
    await close()
  }
})

test("Ticket 05 P4: 403 response does NOT call next() — side-effect gating for missing scope", async () => {
  let handlerReached = 0
  const adapter: IdentityAdapter = {
    resolve: async () => ({
      tenantId: "t",
      subjectId: "u",
      groups: [],
      scopes: [], // no scopes at all
    }),
  }
  const { port, close } = await withServer(
    {
      mode: "enforced",
      adapter,
      requiredScope: "chat",
    },
    (_req, res) => {
      handlerReached++
      res.status(204).end()
    }
  )
  try {
    await postProbe(port)
    assert.equal(handlerReached, 0, "handler must not be reached on 403")
  } finally {
    await close()
  }
})
