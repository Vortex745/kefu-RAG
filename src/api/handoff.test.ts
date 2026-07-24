import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"
import type { Request, Response, NextFunction } from "express"
import { createHandoffRouter } from "./handoff"
import { SqliteHandoffStore } from "../answer/handoff_store"
import { singleTenantAccessContext, type AccessContext, type Scope } from "../access/context"
import { openDb } from "../ingestion/tracking/db"

/**
 * Ticket 09 P5 — Handoff HTTP API tests (spec §8 L1549-1552).
 *
 * Covers three endpoints with the full error matrix:
 *   POST   /chat/runs/:runId/handoff   — happy, idempotent, body.reason, 400, 404
 *   GET    /handoffs?status=<state>    — list, filter, cross-tenant, 400, 403
 *   PATCH  /handoffs/:caseId           — legal, illegal (409), 404, 400, 403
 *
 * Cross-tenant isolation is verified by mounting a header-switched multi-tenant
 * middleware on a single app backed by one in-memory DB. The OR scope semantic
 * (review OR admin) is verified by injecting contexts with restricted scopes.
 */

const ALL_SCOPES: Scope[] = ["chat", "ingest", "review", "admin"]

function buildApp(options: {
  handoffStore?: SqliteHandoffStore
  middleware?: (req: Request, res: Response, next: NextFunction) => void
} = {}) {
  const app = express()
  const db = openDb(":memory:")
  const handoffStore = options.handoffStore ?? new SqliteHandoffStore(db)
  app.use(express.json())
  if (options.middleware) {
    app.use(options.middleware)
  }
  // Without middleware mounted, createHandoffRouter falls back to
  // singleTenantAccessContext() via resolveContext() — backward compat for
  // bare-router mode.
  app.use("/api", createHandoffRouter(handoffStore))
  return { app, db, handoffStore }
}

async function listen(app: express.Express) {
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

async function postHandoff(
  port: number,
  runId: string,
  body: unknown = {},
  headers: Record<string, string> = {}
) {
  const res = await fetch(`http://127.0.0.1:${port}/api/chat/runs/${runId}/handoff`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null }
}

async function listHandoffs(port: number, status?: string, headers: Record<string, string> = {}) {
  const url = status
    ? `http://127.0.0.1:${port}/api/handoffs?status=${encodeURIComponent(status)}`
    : `http://127.0.0.1:${port}/api/handoffs`
  const res = await fetch(url, { headers })
  return { status: res.status, json: (await res.json().catch(() => null)) as unknown }
}

async function patchHandoff(
  port: number,
  caseId: string,
  body: unknown,
  headers: Record<string, string> = {}
) {
  const res = await fetch(`http://127.0.0.1:${port}/api/handoffs/${caseId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null }
}

/** Multi-tenant middleware: switches tenant by x-test-tenant header. */
function multiTenantMiddleware(req: Request, res: Response, next: NextFunction): void {
  const tenant = (req.headers["x-test-tenant"] as string | undefined) ?? "default"
  res.locals.accessContext = {
    tenantId: tenant,
    subjectId: `user-${tenant}`,
    groups: [],
    scopes: ALL_SCOPES,
  } satisfies AccessContext
  next()
}

/** Restricted-scope middleware: only the given scopes (for 403 tests). */
function scopedMiddleware(scopes: Scope[]): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    res.locals.accessContext = {
      tenantId: "default",
      subjectId: "local",
      groups: [],
      scopes,
    } satisfies AccessContext
    next()
  }
}

// ---------------------------------------------------------------------------
// POST /chat/runs/:runId/handoff
// ---------------------------------------------------------------------------

test("POST /handoff: happy path — default reasonCode is user_request, returns full case", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const res = await postHandoff(port, "run-happy-1")
    assert.equal(res.status, 200, "POST must return 200 on first create")
    assert.equal(res.json?.status, "open", "new case must start in 'open' state")
    assert.equal(res.json?.reasonCode, "user_request", "default reasonCode must be user_request")
    assert.equal(res.json?.runId, "run-happy-1")
    assert.equal(res.json?.traceReference, "run-happy-1", "traceReference must default to runId")
    assert.ok(res.json?.id, "case must have an id")
    assert.ok(res.json?.createdAt, "case must have createdAt")
  } finally {
    server.close()
    db.close()
  }
})

test("POST /handoff: idempotent — second call returns the same case unchanged", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const r1 = await postHandoff(port, "run-idem-1", { userRequest: "first request" })
    const r2 = await postHandoff(port, "run-idem-1", { userRequest: "different request" })
    assert.equal(r1.status, 200)
    assert.equal(r2.status, 200)
    assert.equal(r1.json?.id, r2.json?.id, "idempotent create must return the same case id")
    assert.equal(
      r2.json?.userRequest,
      "first request",
      "second POST must NOT overwrite the first creation's fields (INSERT OR IGNORE)"
    )
  } finally {
    server.close()
    db.close()
  }
})

test("POST /handoff: body.reason supplements the case reasonCode on first create", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const res = await postHandoff(port, "run-reason-1", { reason: "policy_review" })
    assert.equal(res.status, 200)
    assert.equal(res.json?.reasonCode, "policy_review", "body.reason must set reasonCode on first create")
  } finally {
    server.close()
    db.close()
  }
})

test("POST /handoff: invalid reason code returns 400", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const res = await postHandoff(port, "run-bad-reason-1", { reason: "totally_made_up_code" })
    assert.equal(res.status, 400, "invalid reason code must return 400 per spec L1552")
    assert.ok(res.json?.error && /reason/i.test(String(res.json.error)))
  } finally {
    server.close()
    db.close()
  }
})

test("POST /handoff: cross-tenant runId returns 404 (existence not revealed)", async () => {
  // Mount multi-tenant middleware so tenant-a creates a case, then tenant-b
  // POSTs the same runId. The UNIQUE(run_id) constraint means tenant-b's INSERT
  // is IGNORE'd, and the SELECT by (run_id, tenant-b) returns null → 404.
  const { app, db } = buildApp({ middleware: multiTenantMiddleware })
  const { server, port } = await listen(app)
  try {
    const r1 = await postHandoff(port, "run-xt-1", {}, { "x-test-tenant": "tenant-a" })
    assert.equal(r1.status, 200, "tenant-a must create the case")
    const r2 = await postHandoff(port, "run-xt-1", {}, { "x-test-tenant": "tenant-b" })
    assert.equal(r2.status, 404, "tenant-b POSTing tenant-a's runId must 404 (cross-tenant)")
  } finally {
    server.close()
    db.close()
  }
})

// ---------------------------------------------------------------------------
// GET /handoffs
// ---------------------------------------------------------------------------

test("GET /handoffs: returns tenant-scoped list (newest first)", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    await postHandoff(port, "run-list-1")
    await postHandoff(port, "run-list-2")
    const res = await listHandoffs(port)
    assert.equal(res.status, 200)
    const cases = res.json as Array<Record<string, unknown>>
    assert.equal(cases.length, 2, "both cases must be listed")
    // Ordered by created_at DESC — second-created comes first
    assert.equal(cases[0].runId, "run-list-2")
    assert.equal(cases[1].runId, "run-list-1")
  } finally {
    server.close()
    db.close()
  }
})

test("GET /handoffs?status=open: filters by status", async () => {
  const { app, db, handoffStore } = buildApp()
  const { server, port } = await listen(app)
  try {
    await postHandoff(port, "run-filter-1")
    // Manually transition one case to 'claimed' so the status filter has something to exclude
    const created = handoffStore.getByRunId("run-filter-1", singleTenantAccessContext().tenantId)
    assert.ok(created, "case must exist before manual transition")
    handoffStore.updateStatus(created.id, created.tenantId, "claimed")

    const res = await listHandoffs(port, "open")
    assert.equal(res.status, 200)
    const cases = res.json as Array<Record<string, unknown>>
    assert.equal(cases.length, 0, "case in 'claimed' state must not appear in status=open filter")
  } finally {
    server.close()
    db.close()
  }
})

test("GET /handoffs: cross-tenant isolation — tenant-b sees empty list", async () => {
  const { app, db } = buildApp({ middleware: multiTenantMiddleware })
  const { server, port } = await listen(app)
  try {
    await postHandoff(port, "run-iso-1", {}, { "x-test-tenant": "tenant-a" })
    const res = await listHandoffs(port, undefined, { "x-test-tenant": "tenant-b" })
    assert.equal(res.status, 200)
    const cases = res.json as Array<Record<string, unknown>>
    assert.equal(cases.length, 0, "tenant-b must see zero cases (cross-tenant isolation)")
  } finally {
    server.close()
    db.close()
  }
})

test("GET /handoffs?status=invalid: returns 400", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const res = await listHandoffs(port, "totally_invalid_state")
    assert.equal(res.status, 400, "invalid status filter must return 400 per spec L1552")
    assert.ok(res.json && /status/i.test(String((res.json as Record<string, unknown>).error || "")))
  } finally {
    server.close()
    db.close()
  }
})

test("GET /handoffs: 403 when scopes lack both review and admin", async () => {
  // Enforced-mode-like context: only "chat" scope — no review/admin.
  const { app, db } = buildApp({ middleware: scopedMiddleware(["chat"]) })
  const { server, port } = await listen(app)
  try {
    const res = await listHandoffs(port)
    assert.equal(res.status, 403, "missing review+admin scope must return 403 per spec L1550")
  } finally {
    server.close()
    db.close()
  }
})

test("GET /handoffs: 'review' alone passes the OR scope check (spec L1550)", async () => {
  // OR semantic: review alone (no admin) must pass.
  const { app, db } = buildApp({ middleware: scopedMiddleware(["review"]) })
  const { server, port } = await listen(app)
  try {
    const res = await listHandoffs(port)
    assert.equal(res.status, 200, "review scope alone must satisfy requireReviewOrAdmin")
  } finally {
    server.close()
    db.close()
  }
})

// ---------------------------------------------------------------------------
// PATCH /handoffs/:caseId
// ---------------------------------------------------------------------------

test("PATCH /handoffs/:caseId: legal transition open→claimed returns 200", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const created = await postHandoff(port, "run-patch-1")
    const caseId = String(created.json?.id)
    const res = await patchHandoff(port, caseId, { status: "claimed" })
    assert.equal(res.status, 200, "legal transition open→claimed must return 200")
    assert.equal(res.json?.status, "claimed")
  } finally {
    server.close()
    db.close()
  }
})

test("PATCH /handoffs/:caseId: illegal transition open→resolved returns 409 with from/to", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const created = await postHandoff(port, "run-illegal-1")
    const caseId = String(created.json?.id)
    const res = await patchHandoff(port, caseId, { status: "resolved" })
    assert.equal(res.status, 409, "illegal transition must return 409 per spec L1552")
    assert.equal(res.json?.from, "open", "409 body must include from status")
    assert.equal(res.json?.to, "resolved", "409 body must include target status")
  } finally {
    server.close()
    db.close()
  }
})

test("PATCH /handoffs/:caseId: cross-tenant returns 404 (NOT 409)", async () => {
  // tenant-a creates a case, tenant-b tries to PATCH it. Cross-tenant must
  // return 404 — never 409 — per spec L1552 (don't reveal existence).
  const { app, db } = buildApp({ middleware: multiTenantMiddleware })
  const { server, port } = await listen(app)
  try {
    const created = await postHandoff(port, "run-xt-patch-1", {}, { "x-test-tenant": "tenant-a" })
    const caseId = String(created.json?.id)
    const res = await patchHandoff(port, caseId, { status: "claimed" }, { "x-test-tenant": "tenant-b" })
    assert.equal(res.status, 404, "cross-tenant PATCH must return 404, not 409")
  } finally {
    server.close()
    db.close()
  }
})

test("PATCH /handoffs/:caseId: non-existent caseId returns 404", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const res = await patchHandoff(port, "never-existed-uuid", { status: "claimed" })
    assert.equal(res.status, 404, "non-existent caseId must return 404")
  } finally {
    server.close()
    db.close()
  }
})

test("PATCH /handoffs/:caseId: invalid target status returns 400", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const created = await postHandoff(port, "run-bad-status-1")
    const caseId = String(created.json?.id)
    const res = await patchHandoff(port, caseId, { status: "totally_invalid" })
    assert.equal(res.status, 400, "invalid target status must return 400 per spec L1552")
  } finally {
    server.close()
    db.close()
  }
})

test("PATCH /handoffs/:caseId: 403 when scopes lack both review and admin", async () => {
  const { app, db } = buildApp({ middleware: scopedMiddleware(["chat"]) })
  const { server, port } = await listen(app)
  try {
    const created = await postHandoff(port, "run-scope-1")
    // POST /chat/runs/:runId/handoff requires only 'chat' scope (no review/admin gate),
    // so the create succeeds. The PATCH then fails the in-handler scope check.
    const caseId = String(created.json?.id)
    const res = await patchHandoff(port, caseId, { status: "claimed" })
    assert.equal(res.status, 403, "PATCH without review/admin scope must return 403")
  } finally {
    server.close()
    db.close()
  }
})
