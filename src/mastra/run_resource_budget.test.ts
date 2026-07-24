import assert from "node:assert/strict"
import test from "node:test"
import type { AnswerRunEvent } from "../types"
import {
  getCurrentRunContext,
  reserveModelCall,
} from "../runtime/run_context"
import { createMastraChatEventAdapter } from "./chat_event_adapter"
import { createMastraWorkflowRunner } from "./workflow_runner"

test("one resource authority crosses the Mastra Workflow and budget failure emits one terminal", async () => {
  let observedContext = getCurrentRunContext()
  const workflowRunner = await createMastraWorkflowRunner(async () => {
    observedContext = getCurrentRunContext()
    assert.ok(observedContext)
    reserveModelCall(observedContext, { kind: "chat", model: "first" })
    reserveModelCall(observedContext, { kind: "chat", model: "second" })
    throw new Error("unreachable")
  })
  const source = createMastraChatEventAdapter({
    runner: workflowRunner,
    resourceBudget: { limits: { maxModelCalls: 1 } },
  })
  const events: AnswerRunEvent[] = []

  for await (const event of source("hello", {
    runId: "run-resource-budget",
    sessionId: "session-resource-budget",
  })) {
    events.push(event)
  }

  assert.ok(observedContext)
  const terminals = events.filter((event) => event.type === "done")
  assert.equal(terminals.length, 1)
  assert.equal(terminals[0]?.status, "cancelled")
  if (terminals[0]?.type !== "done") assert.fail("expected done event")
  assert.equal(terminals[0].result.status, "cancelled")
  assert.equal(
    terminals[0].result.degradation.reason,
    "resource_budget_exceeded"
  )
})
