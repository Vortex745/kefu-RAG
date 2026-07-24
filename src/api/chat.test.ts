import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"
import { AnswerTraceRepository } from "../answer/trace_repository"
import type { AnswerReference, AnswerRunEvent } from "../types"
import { openDb } from "../ingestion/tracking/db"
import { createApp } from "./server"
import type { AnswerEventsSource } from "./chat"

const reference: AnswerReference = {
  id: "ref-1",
  documentId: "doc-json",
  documentVersionId: "doc-json",
  documentVersion: 2,
  chunkId: "chunk-json",
  title: "退款政策",
  source: "policy.pdf",
  page: 4,
  sectionPath: ["售后", "退款"],
  image: {
    assetId: `sha256:${"a".repeat(64)}`,
    assetPath: `${"a".repeat(64)}.jpg`,
    sourceReference: "images/refund.jpg",
    captions: ["退款流程图"],
  },
  excerpt: "退款申请应在三十日内提交。",
  channels: ["bm25"],
  score: 0.9,
  wikilinks: [],
}

function events(runId: string, sessionId: string): AnswerRunEvent[] {
  const base = {
    schemaVersion: 1 as const,
    sessionId,
    runId,
    createdAt: "2026-07-20T00:00:00.000Z",
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
      eventId: `${runId}:1`,
      sequence: 1,
      message: "",
      data: {},
    },
    {
      ...base,
      type: "answer_delta",
      stage: "answer",
      eventId: `${runId}:2`,
      sequence: 2,
      token: "三十日内",
    },
    {
      ...base,
      type: "done",
      stage: "done",
      eventId: `${runId}:3`,
      sequence: 3,
      status: "completed",
      durationMs: 5,
      result: {
        runId,
        status: "completed",
        reply: "三十日内",
        references: [reference],
        degradation: { status: "none", unavailableChannels: [] },
      },
    },
  ]
}

test("complete chat JSON and SSE preserve the Answer event contract", async (t) => {
  const db = openDb(":memory:")
  const traceRepository = new AnswerTraceRepository(db)
  const eventsSource: AnswerEventsSource = async function* (_message, options) {
    const runId = options.runId || "run"
    const sessionId = options.sessionId || "session"
    for (const event of events(runId, sessionId)) {
      traceRepository.onEvent(event)
      yield event
    }
  }
  const server = createApp({ db, eventsSource }).listen(0)
  t.after(() => server.close())
  t.after(() => db.close())
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const { port } = server.address() as AddressInfo

  const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "退款期限？", stream: false }),
  })
  const body = await response.json() as Record<string, unknown>
  assert.equal(response.status, 200)
  assert.equal(body.reply, "三十日内")
  assert.equal(body.status, "completed")
  assert.deepEqual(body.references, [reference])

  const streamResponse = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "退款期限？", stream: true }),
  })
  const payloads = (await streamResponse.text())
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as {
      token?: string
      sessionId: string
      done?: boolean
      event: { type: string; runId: string; eventId: string; sequence: number }
    })
  assert.equal(payloads.some(({ token }) => token === "三十日内"), true)
  assert.equal(payloads.at(-1)?.done, true)
  assert.equal("token" in payloads.at(-1)!, false)

  const runId = payloads[0].event.runId
  const historyResponse = await fetch(`http://127.0.0.1:${port}/api/chat/runs/${runId}`)
  const history = await historyResponse.json() as {
    events: Array<{ eventId: string; sequence: number }>
  }
  assert.equal(historyResponse.status, 200)
  assert.deepEqual(
    history.events.map(({ eventId }) => eventId),
    payloads.map(({ event }) => event.eventId)
  )
})
