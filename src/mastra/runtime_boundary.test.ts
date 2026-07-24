import assert from "node:assert/strict"
import test from "node:test"
import type { AnswerRunEvent } from "../types"
import {
  createMastraRuntimeBoundary,
  createModeAwareEventsSource,
} from "./runtime_boundary"
import {
  MASTRA_RUNTIME_MODES,
  parseMastraRuntimeMode,
  readMastraRuntimeMode,
  type MastraRuntimeMode,
} from "./runtime_mode"

function done(runId: string, sessionId: string): AnswerRunEvent {
  return {
    type: "done",
    schemaVersion: 1,
    sessionId,
    runId,
    eventId: `${runId}:1`,
    sequence: 1,
    createdAt: "2026-07-20T00:00:00.000Z",
    stage: "done",
    status: "completed",
    durationMs: 1,
    attempt: 1,
    round: 0,
    inputSummary: "",
    outputSummary: "",
    result: {
      runId,
      status: "completed",
      reply: "ok",
      references: [],
      degradation: { status: "none", unavailableChannels: [] },
    },
  }
}

function source(events: AnswerRunEvent[]) {
  return async function* () {
    yield* events
  }
}

async function collect(stream: AsyncIterable<AnswerRunEvent>) {
  const events: AnswerRunEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

test("runtime modes contain only limited and default", () => {
  assert.deepEqual(MASTRA_RUNTIME_MODES, ["limited", "default"])
})

test("missing, blank, invalid, and retired modes resolve to default", () => {
  for (const raw of [undefined, "", " ", "legacy", "rollback", "shadow", "typo"]) {
    assert.equal(parseMastraRuntimeMode(raw), "default")
  }
})

test("mode parsing is case-insensitive and trims whitespace", () => {
  assert.equal(parseMastraRuntimeMode(" LIMITED "), "limited")
  assert.equal(parseMastraRuntimeMode("DEFAULT"), "default")
})

test("readMastraRuntimeMode reads the environment on every call", () => {
  const previous = process.env.MASTRA_RUNTIME_MODE
  try {
    process.env.MASTRA_RUNTIME_MODE = "limited"
    assert.equal(readMastraRuntimeMode(), "limited")
    process.env.MASTRA_RUNTIME_MODE = "default"
    assert.equal(readMastraRuntimeMode(), "default")
  } finally {
    if (previous === undefined) delete process.env.MASTRA_RUNTIME_MODE
    else process.env.MASTRA_RUNTIME_MODE = previous
  }
})

test("boundary requires a Mastra source at composition time", () => {
  assert.throws(
    () => createModeAwareEventsSource({ mastraSource: undefined as never }),
    /mastraSource must be a function/
  )
})

for (const mode of ["limited", "default"] as const) {
  test(`${mode} delegates directly to the Mastra source`, async () => {
    const event = done(`run-${mode}`, `session-${mode}`)
    const eventsSource = createModeAwareEventsSource({
      mastraSource: source([event]),
      modeReader: () => mode,
    })
    assert.deepEqual(await collect(eventsSource("hello", {})), [event])
  })
}

test("mode is read for every request without changing the publisher", async () => {
  let mode: MastraRuntimeMode = "limited"
  let reads = 0
  const eventsSource = createModeAwareEventsSource({
    mastraSource: source([done("run", "session")]),
    modeReader: () => {
      reads += 1
      return mode
    },
  })
  await collect(eventsSource("one", {}))
  mode = "default"
  await collect(eventsSource("two", {}))
  assert.equal(reads, 2)
})

test("Mastra errors propagate without legacy fallback", async () => {
  const eventsSource = createModeAwareEventsSource({
    mastraSource: async function* () {
      throw new Error("RouteNotSupportedError")
    },
  })
  await assert.rejects(async () => collect(eventsSource("hello", {})), /RouteNotSupportedError/)
})

test("runtime boundary reports a mandatory source and closes idempotently", async () => {
  const boundary = createMastraRuntimeBoundary({
    mastraSource: source([done("run", "session")]),
  })
  assert.equal(boundary.hasMastraSource, true)
  await boundary.close()
  await boundary.close()
})
