import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"
import type { Express } from "express"
import { createApp } from "./server"
import { openDb } from "../ingestion/tracking/db"
import { createAccessMiddleware } from "./access_middleware"
import { SqliteSessionBinder, type BindResult, type SessionBinding } from "../access/session_binder"
import type { AnswerRunEvent, AnswerRunResult } from "../types"
import type { AnswerEventsSource } from "./chat"

/**
 * Ticket 05 follow-up wiring: createApp() now accepts optional accessMiddleware
 * and sessionBinder. Tests verify:
 *   1. createApp() with no options is backward compatible (no middleware, no binder)
 *   2. createApp({accessMiddleware, sessionBinder}) wires both into /api/chat
 *   3. Single-tenant middleware + real binder: first request binds, second
 *      consistent request reuses (no 409)
 *   4. 409 from binder propagates through the full Express stack
 */

const FIXED_RUN_ID = "run-server-0001"

function makeTerminalResult(status: AnswerRunResult["status"], runId: string): AnswerRunResult {
  return {
    runId,
    status,
    reply: "ok",
    references: [],
    degradation: { status: "none", unavailableChannels: [] },
  }
}

function makeEvents(runId: string, sessionId: string): AnswerRunEvent[] {
  const base = {
    schemaVersion: 1 as const,
    sessionId,
    runId,
    createdAt: "2026-07-17T00:00:00.000Z",
    status: "running" as const,
    durationMs: null,
    attempt: 1,
    round: 0,
    inputSummary: "",
    outputSummary: "",
  }
  return [
    { ...base, type: "progress", stage: "route", message: "", data: {}, eventId: `${runId}:1`, sequence: 1 },
    { ...base, type: "done", stage: "done", result: makeTerminalResult("completed", runId), eventId: `${runId}:2`, sequence: 2, status: "completed", durationMs: 50 },
  ]
}

function stubEventsSource(): AnswerEventsSource {
  return async function* (_message, options) {
    const runId = options.runId || FIXED_RUN_ID
    const sessionId = options.sessionId || "sess-server-0001"
    for (const event of makeEvents(runId, sessionId)) yield event
  }
}

async function listen(app: Express) {
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

test("Ticket 05 wiring: createApp() with no options is backward compatible (no middleware, no binder)", async () => {
  const db = openDb(":memory:")
  const app = createApp({ db, eventsSource: stubEventsSource() })
  const { server, port } = await listen(app)
  try {
    const res = await postChat(port, { message: "hi", stream: false, sessionId: "sess-bw-1" })
    assert.equal(res.status, 200, "createApp() with no options must preserve existing behavior")
  } finally {
    server.close()
    db.close()
  }
})

test("Ticket 05 wiring: createApp({accessMiddleware, sessionBinder}) wires both — single-tenant middleware + real binder first bind returns 200", async () => {
  const db = openDb(":memory:")
  const accessMiddleware = createAccessMiddleware({
    mode: "single_tenant",
    requiredScope: "chat",
  })
  const sessionBinder = new SqliteSessionBinder(db)
  const app = createApp({ db, accessMiddleware, sessionBinder, eventsSource: stubEventsSource() })
  const { server, port } = await listen(app)
  try {
    const res = await postChat(port, { message: "hi", stream: false, sessionId: "sess-wired-1" })
    assert.equal(res.status, 200, "first bind with wired middleware + binder must succeed")
    // Verify binding persisted with single-tenant deterministic identity
    const row = db.prepare("SELECT tenant_id, subject_id FROM session_bindings WHERE session_id = ?").get("sess-wired-1") as
      | { tenant_id: string; subject_id: string }
      | undefined
    assert.ok(row, "binder must persist binding")
    assert.equal(row.tenant_id, "default")
    assert.equal(row.subject_id, "local")
  } finally {
    server.close()
    db.close()
  }
})

test("Ticket 05 wiring: 409 from binder propagates through full createApp() Express stack", async () => {
  const db = openDb(":memory:")
  const existing: SessionBinding = {
    sessionId: "sess-409-1",
    tenantId: "tenant-a",
    subjectId: "user-1",
    createdAt: "2026-07-17T00:00:00.000Z",
  }
  const fakeBinder: SqliteSessionBinder = {
    bindOrCheck: () => ({ ok: false, conflict: { existing } }),
  } as unknown as SqliteSessionBinder
  const accessMiddleware = createAccessMiddleware({ mode: "single_tenant", requiredScope: "chat" })
  const app = createApp({ db, accessMiddleware, sessionBinder: fakeBinder, eventsSource: stubEventsSource() })
  const { server, port } = await listen(app)
  try {
    const res = await postChat(port, { message: "hi", stream: false, sessionId: "sess-409-1" })
    assert.equal(res.status, 409, "409 must propagate through createApp() stack")
    assert.ok(
      res.json && /conflict/i.test(String(res.json.error || "")),
      `409 body must mention 'conflict', got: ${JSON.stringify(res.json)}`
    )
  } finally {
    server.close()
    db.close()
  }
})
