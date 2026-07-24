import { z } from "zod"
import type {
  MastraRunner,
  MastraRunnerInput,
  MastraRunnerOutput,
} from "./chat_event_adapter"

type WorkflowInput = Omit<MastraRunnerInput, "signal">

function abortError(): Error {
  const error = new Error("Answer run cancelled in Mastra Workflow")
  error.name = "AbortError"
  return error
}

export async function createMastraWorkflowRunner(
  runner: MastraRunner
): Promise<MastraRunner> {
  const { createStep, createWorkflow } = await import("@mastra/core/workflows")

  const dispatchStep = createStep({
    id: "answer-route-dispatch",
    inputSchema: z.custom<WorkflowInput>(),
    outputSchema: z.custom<MastraRunnerOutput>(),
    execute: async ({ inputData, abortSignal }) => runner({
      ...inputData,
      signal: abortSignal,
    }),
  })

  const workflow = createWorkflow({
    id: "answer-runtime",
    inputSchema: z.custom<WorkflowInput>(),
    outputSchema: z.custom<MastraRunnerOutput>(),
  }).then(dispatchStep).commit()

  return async function mastraWorkflowRunner(
    input: MastraRunnerInput
  ): Promise<MastraRunnerOutput> {
    if (input.signal.aborted) throw abortError()

    const { signal, ...inputData } = input
    const run = await workflow.createRun({
      runId: input.runId,
      resourceId: input.sessionId,
    })
    const cancelRun = () => {
      void run.cancel()
    }
    signal.addEventListener("abort", cancelRun, { once: true })

    try {
      if (signal.aborted) {
        await run.cancel()
        throw abortError()
      }

      const result = await run.start({ inputData })
      if (signal.aborted || run.workflowRunStatus === "canceled") {
        throw abortError()
      }
      if (result.status === "success") return result.result
      if (result.status === "failed") throw result.error
      throw new Error(`Mastra Workflow ended with status "${result.status}"`)
    } finally {
      signal.removeEventListener("abort", cancelRun)
    }
  }
}
