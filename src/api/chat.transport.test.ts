import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"
import { createChatRouter, type AnswerEventsSource } from "./chat"
import { AnswerTraceRepository } from "../answer/trace_repository"
import type { AnswerRunEvent, AnswerRunResult } from "../types"
import { openDb } from "../ingestion/tracking/db"

/**
 * T51: Transport parity tests. These tests inject a stub `eventsSource` so they
 * verify only SSE/JSON encoding shape — they do NOT depend on Answer behavior
 * or live providers. Answer behavior is covered by generation.t51.test.ts.
 */

const FIXED_RUN_ID = "run-fixed-0001"
const FIXED_SESSION_ID = "sess-fixed-0001"

function makeTerminalResult(status: AnswerRunResult["status"], runId: string): AnswerRunResult {
  return {
    runId,
    status,
    reply: "hello world",
    references: [],
    degradation: { status: "none", unavailableChannels: [] },
  }
}

/**
 * Build a fixed sequence of events that honor the runId/sessionId passed in
 * via options — this lets transport tests assert encoding parity without
 * depending on Answer behavior.
 */
function makeEvents(runId: string, sessionId: string): AnswerRunEvent[] {
  const createdAt = "2026-07-16T00:00:00.000Z"
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
      type: "answer_delta",
      stage: "answer",
      token: " world",
      eventId: `${runId}:3`,
      sequence: 3,
    },
    {
      ...base,
      type: "done",
      stage: "done",
      result: makeTerminalResult("completed", runId),
      eventId: `${runId}:4`,
      sequence: 4,
      status: "completed",
      durationMs: 100,
    },
  ]
}

function stubEventsSource(): AnswerEventsSource {
  return async function* (message, options) {
    const runId = options.runId || FIXED_RUN_ID
    const sessionId = options.sessionId || FIXED_SESSION_ID
    for (const event of makeEvents(runId, sessionId)) yield event
  }
}

function buildApp() {
  const app = express()
  const db = openDb(":memory:")
  const traceRepository = new AnswerTraceRepository(db)
  app.use(express.json())
  app.use("/api", createChatRouter(traceRepository, stubEventsSource()))
  return { app, db, traceRepository }
}

async function listen(app: express.Express) {
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

test("POST /api/chat with empty message returns 400", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "   ", stream: false }),
    })
    assert.equal(response.status, 400)
    const body = await response.json() as { error: string }
    assert.equal(body.error, "message is required")
  } finally {
    server.close()
    db.close()
  }
})

test("SSE transport encodes every event as `data: <json>\\n\\n` with correct fields", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "hi",
        stream: true,
        runId: FIXED_RUN_ID,
        sessionId: FIXED_SESSION_ID,
      }),
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("content-type"), "text/event-stream")

    const raw = await response.text()
    const lines = raw.split(/\r?\n/)
    const dataLines = lines.filter((line) => line.startsWith("data: "))
    // Each event is followed by a blank line — `data: ...\n\n`
    assert.ok(dataLines.length === 4, `expected 4 data lines, got ${dataLines.length}`)

    const payloads = dataLines.map((line) =>
      JSON.parse(line.slice(6)) as {
        sessionId: string
        runId: string
        event: { type: string; sequence: number; eventId: string; runId: string }
        token?: string
        done?: boolean
        status?: string
        references?: unknown[]
        degradation?: { status: string; unavailableChannels: string[] }
      }
    )

    // Every payload carries transport envelope fields.
    assert.equal(payloads.every((p) => p.sessionId === FIXED_SESSION_ID), true)
    assert.equal(payloads.every((p) => p.runId === FIXED_RUN_ID), true)
    assert.equal(
      payloads.every((p) => p.event.eventId === `${FIXED_RUN_ID}:${p.event.sequence}`),
      true
    )

    // Progress event: no token, no done.
    const progress = payloads[0]
    assert.equal(progress.event.type, "progress")
    assert.equal("token" in progress, false)
    assert.equal("done" in progress, false)

    // answer_delta events: token present, no done.
    const deltas = payloads.filter((p) => p.event.type === "answer_delta")
    assert.equal(deltas.length, 2)
    assert.equal(deltas[0].token, "hello")
    assert.equal(deltas[1].token, " world")
    assert.equal(deltas.every((p) => !("done" in p)), true)

    // done event: done=true, status/references/degradation present, no token.
    const done = payloads.at(-1)!
    assert.equal(done.event.type, "done")
    assert.equal(done.done, true)
    assert.equal(done.status, "completed")
    assert.deepEqual(done.references, [])
    assert.deepEqual(done.degradation, { status: "none", unavailableChannels: [] })
    assert.equal("token" in done, false)
  } finally {
    server.close()
    db.close()
  }
})

test("JSON transport encodes terminal fields and echoes full event stream", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "hi",
        stream: false,
        runId: FIXED_RUN_ID,
        sessionId: FIXED_SESSION_ID,
      }),
    })
    assert.equal(response.status, 200)
    const body = await response.json() as {
      reply: string
      sessionId: string
      runId: string
      status: string
      references: unknown[]
      degradation: { status: string; unavailableChannels: string[] }
      events: Array<{ type: string; sequence: number; eventId: string }>
    }
    // Terminal fields come from the done event's result.
    assert.equal(body.reply, "hello world")
    assert.equal(body.sessionId, FIXED_SESSION_ID)
    assert.equal(body.runId, FIXED_RUN_ID)
    assert.equal(body.status, "completed")
    assert.deepEqual(body.references, [])
    assert.deepEqual(body.degradation, { status: "none", unavailableChannels: [] })
    // Full event stream is echoed in order.
    assert.equal(body.events.length, 4)
    assert.deepEqual(
      body.events.map((e) => e.type),
      ["progress", "answer_delta", "answer_delta", "done"]
    )
    assert.deepEqual(
      body.events.map((e) => e.sequence),
      [1, 2, 3, 4]
    )
    assert.deepEqual(
      body.events.map((e) => e.eventId),
      [`${FIXED_RUN_ID}:1`, `${FIXED_RUN_ID}:2`, `${FIXED_RUN_ID}:3`, `${FIXED_RUN_ID}:4`]
    )
  } finally {
    server.close()
    db.close()
  }
})

test("GET /api/chat/runs/:runId returns 404 when run not in trace repository", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/chat/runs/nonexistent`)
    assert.equal(response.status, 404)
    const body = await response.json() as { error: string }
    assert.equal(body.error, "Answer run not found")
  } finally {
    server.close()
    db.close()
  }
})

test("GET /api/chat/runs/:runId returns trace when events were persisted directly", async () => {
  const { app, db, traceRepository } = buildApp()
  const { server, port } = await listen(app)
  try {
    // Transport test: persist events directly (no observer side-effect from runAnswer).
    for (const event of makeEvents(FIXED_RUN_ID, FIXED_SESSION_ID)) traceRepository.append(event)

    const historyResponse = await fetch(`http://127.0.0.1:${port}/api/chat/runs/${FIXED_RUN_ID}`)
    assert.equal(historyResponse.status, 200)
    const history = await historyResponse.json() as {
      sessionId: string
      events: Array<{ type: string; sequence: number; eventId: string }>
    }
    assert.equal(history.sessionId, FIXED_SESSION_ID)
    assert.equal(history.events.length, 4)
    assert.deepEqual(
      history.events.map((e) => e.type),
      ["progress", "answer_delta", "answer_delta", "done"]
    )
    assert.deepEqual(
      history.events.map((e) => e.eventId),
      [`${FIXED_RUN_ID}:1`, `${FIXED_RUN_ID}:2`, `${FIXED_RUN_ID}:3`, `${FIXED_RUN_ID}:4`]
    )
  } finally {
    server.close()
    db.close()
  }
})
