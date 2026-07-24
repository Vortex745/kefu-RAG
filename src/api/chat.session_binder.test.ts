import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"
import { createChatRouter, type AnswerEventsSource } from "./chat"
import { AnswerTraceRepository } from "../answer/trace_repository"
import type { AnswerRunEvent, AnswerRunResult } from "../types"
import { openDb } from "../ingestion/tracking/db"
import { SqliteSessionBinder, type BindResult, type SessionBinding } from "../access/session_binder"
import { singleTenantAccessContext } from "../access/context"

/**
 * Ticket 05 follow-up wiring: SqliteSessionBinder is now plumbed into the
 * POST /api/chat handler. Tests cover (1) backward compat without a binder,
 * (2) first-sight bind returns 200, (3) consistent reuse returns 200, (4)
 * conflicting reuse returns 409 Conflict, (5) binder is called with the
 * single-tenant deterministic identity (default/local) when no access
 * middleware is mounted.
 */

const FIXED_RUN_ID = "run-binder-0001"

function makeTerminalResult(status: AnswerRunResult["status"], runId: string): AnswerRunResult {
  return {
    runId,
    status,
    reply: "hello world",
    references: [],
    degradation: { status: "none", unavailableChannels: [] },
  }
}

function makeEvents(runId: string, sessionId: string): AnswerRunEvent[] {
  const createdAt = "2026-07-17T00:00:00.000Z"
  const base = {
    schemaVersion: 1 as const,
    sessionId,
    runId,
    createdAt,
    status: "running" as const,
    durationMs: null,
    attempt: 1,
    round: 0,
    inputSummary: "",
    outputSummary: "",
  }
  return [
    {
      ...base,
      type: "progress",
      stage: "route",
      message: "",
      data: {},
      eventId: `${runId}:1`,
      sequence: 1,
    },
    {
      ...base,
      type: "answer_delta",
      stage: "answer",
      token: "hello",
      eventId: `${runId}:2`,
      sequence: 2,
    },
    {
      ...base,
      type: "done",
      stage: "done",
      result: makeTerminalResult("completed", runId),
      eventId: `${runId}:3`,
      sequence: 3,
      status: "completed",
      durationMs: 100,
    },
  ]
}

function stubEventsSource(): AnswerEventsSource {
  return async function* (message, options) {
    const runId = options.runId || FIXED_RUN_ID
    const sessionId = options.sessionId || "sess-binder-0001"
    for (const event of makeEvents(runId, sessionId)) yield event
  }
}

function buildApp(options: { binder?: SqliteSessionBinder; useRealBinder?: boolean } = {}) {
  const app = express()
  const db = openDb(":memory:")
  const traceRepository = new AnswerTraceRepository(db)
  const binder = options.binder ?? (options.useRealBinder ? new SqliteSessionBinder(db) : undefined)
  app.use(express.json())
  app.use("/api", createChatRouter(traceRepository, stubEventsSource(), binder))
  return { app, db, traceRepository }
}

async function listen(app: express.Express) {
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

async function postChat(port: number, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null }
}

test("Ticket 05 wiring: createChatRouter without sessionBinder is backward compatible (no 409, behavior unchanged)", async () => {
  const { app, db } = buildApp() // no binder
  const { server, port } = await listen(app)
  try {
    const res = await postChat(port, { message: "hi", stream: false, sessionId: "sess-compat-1" })
    assert.equal(res.status, 200, "without binder, request must succeed (backward compat)")
    assert.equal(res.json?.status, "completed")
  } finally {
    server.close()
    db.close()
  }
})

test("Ticket 05 wiring: first-sight bind returns 200 and binder records the binding", async () => {
  const { app, db } = buildApp({ useRealBinder: true })
  const { server, port } = await listen(app)
  try {
    const res = await postChat(port, { message: "hi", stream: false, sessionId: "sess-first-1" })
    assert.equal(res.status, 200, "first bind must succeed")
    // Verify the binding was persisted in the DB
    const row = db.prepare("SELECT session_id, tenant_id, subject_id FROM session_bindings WHERE session_id = ?").get("sess-first-1") as
      | { session_id: string; tenant_id: string; subject_id: string }
      | undefined
    assert.ok(row, "binder must persist the binding on first sight")
    assert.equal(row.tenant_id, "default", "single_tenant mode must bind tenant=default")
    assert.equal(row.subject_id, "local", "single_tenant mode must bind subject=local")
  } finally {
    server.close()
    db.close()
  }
})

test("Ticket 05 wiring: consistent reuse (same sessionId + same tenant/subject) returns 200, not 409", async () => {
  const { app, db } = buildApp({ useRealBinder: true })
  const { server, port } = await listen(app)
  try {
    const r1 = await postChat(port, { message: "hi", stream: false, sessionId: "sess-reuse-1" })
    const r2 = await postChat(port, { message: "again", stream: false, sessionId: "sess-reuse-1" })
    assert.equal(r1.status, 200, "first request must succeed")
    assert.equal(r2.status, 200, "consistent reuse must NOT 409 — same tenant/subject is idempotent")
  } finally {
    server.close()
    db.close()
  }
})

test("Ticket 05 wiring: conflicting reuse returns 409 Conflict with existing binding preserved", async () => {
  // Use a fake binder that always returns a conflict on the second call to
  // simulate an enforced-mode tenant/subject mismatch (which can't be
  // triggered in single_tenant mode where tenant/subject are deterministic).
  let callCount = 0
  const existing: SessionBinding = {
    sessionId: "sess-conflict-1",
    tenantId: "tenant-a",
    subjectId: "user-1",
    createdAt: "2026-07-17T00:00:00.000Z",
  }
  const fakeBinder: SqliteSessionBinder = {
    bindOrCheck: (sessionId: string): BindResult => {
      callCount++
      if (callCount === 1) {
        return { ok: true, bound: true, binding: { ...existing, sessionId } }
      }
      return { ok: false, conflict: { existing } }
    },
  } as unknown as SqliteSessionBinder

  const { app, db } = buildApp({ binder: fakeBinder })
  const { server, port } = await listen(app)
  try {
    const r1 = await postChat(port, { message: "hi", stream: false, sessionId: "sess-conflict-1" })
    const r2 = await postChat(port, { message: "again", stream: false, sessionId: "sess-conflict-1" })
    assert.equal(r1.status, 200, "first bind must succeed")
    assert.equal(r2.status, 409, "conflicting reuse must return 409 Conflict")
    assert.ok(
      r2.json && /conflict/i.test(String(r2.json.error || "")),
      `409 body must mention 'conflict', got: ${JSON.stringify(r2.json)}`
    )
  } finally {
    server.close()
    db.close()
  }
})

test("Ticket 05 wiring: 409 conflict does NOT call eventsSource (no Answer run created — side-effect gating)", async () => {
  let eventsSourceCalled = 0
  const fakeEventsSource: AnswerEventsSource = async function* () {
    eventsSourceCalled++
    yield* [] // empty — should never be reached on 409
  }
  const existing: SessionBinding = {
    sessionId: "sess-gate-1",
    tenantId: "tenant-a",
    subjectId: "user-1",
    createdAt: "2026-07-17T00:00:00.000Z",
  }
  const fakeBinder: SqliteSessionBinder = {
    bindOrCheck: () => ({ ok: false, conflict: { existing } }),
  } as unknown as SqliteSessionBinder

  const app = express()
  const db = openDb(":memory:")
  const traceRepository = new AnswerTraceRepository(db)
  app.use(express.json())
  app.use("/api", createChatRouter(traceRepository, fakeEventsSource, fakeBinder))
  const { server, port } = await listen(app)
  try {
    const res = await postChat(port, { message: "hi", stream: false, sessionId: "sess-gate-1" })
    assert.equal(res.status, 409)
    assert.equal(
      eventsSourceCalled,
      0,
      "eventsSource must NOT be called on 409 — no Answer run may be created on a rejected binding"
    )
  } finally {
    server.close()
    db.close()
  }
})

test("Ticket 05 wiring: single-tenant deterministic identity is used when no access middleware is mounted", async () => {
  // Without createAccessMiddleware mounted, chat.ts must fall back to
  // singleTenantAccessContext() for tenantId/subjectId — this guarantees
  // the binder always gets a non-empty identity even in bare-router mode.
  const expected = singleTenantAccessContext()
  let capturedArgs: { sessionId: string; tenantId: string; subjectId: string } | undefined
  const fakeBinder: SqliteSessionBinder = {
    bindOrCheck: (sessionId: string, tenantId: string, subjectId: string): BindResult => {
      capturedArgs = { sessionId, tenantId, subjectId }
      return { ok: true, bound: true, binding: { sessionId, tenantId, subjectId, createdAt: "2026-07-17T00:00:00.000Z" } }
    },
  } as unknown as SqliteSessionBinder

  const { app, db } = buildApp({ binder: fakeBinder })
  const { server, port } = await listen(app)
  try {
    await postChat(port, { message: "hi", stream: false, sessionId: "sess-identity-1" })
    assert.ok(capturedArgs, "binder.bindOrCheck must be called")
    assert.equal(capturedArgs!.tenantId, expected.tenantId, "tenantId must be single-tenant default")
    assert.equal(capturedArgs!.subjectId, expected.subjectId, "subjectId must be single-tenant default")
  } finally {
    server.close()
    db.close()
  }
})
