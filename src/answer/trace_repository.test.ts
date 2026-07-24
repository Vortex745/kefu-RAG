import assert from "node:assert/strict"
import test from "node:test"
import { openDb } from "../ingestion/tracking/db"
import type { AnswerRunEvent } from "../types"
import { AnswerTraceRepository } from "./trace_repository"

function event(
  sequence: number
): Extract<AnswerRunEvent, { type: "progress" }> {
  const runId = "run-1"
  return {
    type: "progress",
    schemaVersion: 1,
    runId,
    eventId: `${runId}:${sequence}`,
    sequence,
    sessionId: "session-1",
    createdAt: `2026-07-15T00:00:0${sequence}.000Z`,
    stage: "retrieval",
    status: "completed",
    durationMs: 5,
    attempt: 1,
    round: 0,
    inputSummary: "query length: 4",
    outputSummary: "1 result",
    message: `step-${sequence}`,
    data: {},
  }
}

test("trace append is idempotent and replay preserves event order", () => {
  const db = openDb(":memory:")
  const repository = new AnswerTraceRepository(db)

  try {
    repository.append(event(2))
    repository.append(event(1))
    repository.append(event(1))

    const history = repository.getRun("run-1")
    assert.equal(history?.sessionId, "session-1")
    assert.deepEqual(history?.events, [event(1), event(2)])
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM answer_run_events").get() as { count: number }).count,
      2
    )
  } finally {
    db.close()
  }
})

test("trace append rejects conflicting reuse of an event identity", () => {
  const db = openDb(":memory:")
  const repository = new AnswerTraceRepository(db)

  try {
    const original = event(1)
    repository.append(original)
    assert.throws(
      () => repository.append({ ...original, message: "different" }),
      /conflicting trace event/i
    )
    assert.throws(
      () => repository.append({ ...event(2), sessionId: "session-2" }),
      /conflicting trace run session/i
    )
  } finally {
    db.close()
  }
})
