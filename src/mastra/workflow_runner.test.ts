import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { singleTenantAccessContext } from "../access/context"
import type { MastraRunnerInput, MastraRunnerOutput } from "./chat_event_adapter"
import { createMastraWorkflowRunner } from "./workflow_runner"

function input(signal = new AbortController().signal): MastraRunnerInput {
  return {
    message: "hello",
    runId: "run-workflow",
    sessionId: "session-workflow",
    signal,
    accessContext: singleTenantAccessContext(),
  }
}

function output(): MastraRunnerOutput {
  return {
    reply: "ok",
    status: "completed",
    references: [],
    degradation: { status: "none", unavailableChannels: [] },
    tokens: ["ok"],
    routeTrace: { decision: "direct" },
    retrievalTrace: {},
    contextTrace: {},
    validationTrace: {},
  }
}

test("P1 regression: production dispatch executes through a real one-step Mastra Workflow", async () => {
  let calls = 0
  const runner = await createMastraWorkflowRunner(async () => {
    calls += 1
    return output()
  })

  assert.deepEqual(await runner(input()), output())
  assert.equal(calls, 1)

  const source = readFileSync(path.join(__dirname, "workflow_runner.ts"), "utf8")
  for (const api of ["createStep", "createWorkflow", "createRun", "start"]) {
    assert.match(source, new RegExp(`\\b${api}\\b`), `wrapper must use ${api}`)
  }

  const indexSource = readFileSync(path.join(__dirname, "..", "index.ts"), "utf8")
  assert.match(
    indexSource,
    /const runner = await createMastraWorkflowRunner\(dispatchRunner\)/,
    "production dispatch must be wrapped by the real Mastra Workflow"
  )
})

test("P1 regression: abort cancels the active Mastra Workflow run", async () => {
  const controller = new AbortController()
  const runner = await createMastraWorkflowRunner(
    async ({ signal }) => new Promise<MastraRunnerOutput>((_resolve, reject) => {
      const rejectAbort = () => {
        const error = new Error("dispatch aborted")
        error.name = "AbortError"
        reject(error)
      }
      if (signal.aborted) rejectAbort()
      else signal.addEventListener("abort", rejectAbort, { once: true })
    })
  )

  const pending = runner(input(controller.signal))
  controller.abort()
  await assert.rejects(pending, (error: unknown) => {
    assert.equal((error as Error).name, "AbortError")
    return true
  })

  const source = readFileSync(path.join(__dirname, "workflow_runner.ts"), "utf8")
  assert.match(source, /\.cancel\(/, "external abort must call Workflow Run.cancel()")
})
