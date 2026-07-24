import "dotenv/config"
import * as fs from "fs"
import * as path from "path"
import type { TaskStatus } from "../types"
import { closeDriver, createDriver } from "../graph"
import type { IngestionLifecycle, IngestionStatus } from "./lifecycle"
import { createIngestionLifecycle } from "./pipeline"
import { closeDb, openDb } from "./tracking"

const TERMINAL_STATUSES: TaskStatus[] = ["completed", "failed", "cancelled"]

export interface IngestionCliRuntime {
  lifecycle: IngestionLifecycle
  initialize: () => Promise<void>
  close: () => Promise<void>
  writeLine: (line: string) => void
  writeError: (line: string) => void
  sleep: (delayMs: number) => Promise<void>
  now: () => number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

function nextPollDelay(status: IngestionStatus, now: number): number {
  const nextAttemptAt = status.task?.nextAttemptAt
  if (!nextAttemptAt) return 100

  const retryAt = Date.parse(nextAttemptAt)
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - now) : 100
}

async function runUntilTerminal(
  docId: string,
  runtime: IngestionCliRuntime
): Promise<IngestionStatus> {
  while (true) {
    const status = runtime.lifecycle.getStatus(docId)
    if (!status?.task) {
      throw new Error(`Ingestion task not found for document ${docId}`)
    }
    if (isTerminal(status.task.status)) return status

    await runtime.lifecycle.runNext()

    const current = runtime.lifecycle.getStatus(docId)
    if (!current?.task) {
      throw new Error(`Ingestion task not found for document ${docId}`)
    }
    if (isTerminal(current.task.status)) return current
    await runtime.sleep(nextPollDelay(current, runtime.now()))
  }
}

function printSummary(status: IngestionStatus, runtime: IngestionCliRuntime): void {
  runtime.writeLine(`[ingest] Task ${status.task!.id}: ${status.task!.status}`)

  const stageSpans = status.spanTree
    .flatMap((root) => root.children.map(({ span }) => span))
    .sort((left, right) => left.id - right.id)

  for (const span of stageSpans) {
    const duration = span.durationMs === null ? "-" : `${span.durationMs}ms`
    const error = span.errorMessage ? ` error=${span.errorMessage}` : ""
    runtime.writeLine(
      `[ingest] stage=${span.name} status=${span.status} duration=${duration}${error}`
    )
  }
}

export async function runIngestionCli(
  argv: string[],
  runtime: IngestionCliRuntime
): Promise<number> {
  try {
    const filePath = argv[2]
    if (!filePath) {
      runtime.writeError("Usage: npm run ingest -- <file-path>")
      return 1
    }

    await runtime.initialize()
    const resolvedFilePath = path.resolve(filePath)
    const content = fs.readFileSync(resolvedFilePath, "utf8")
    const title = path.basename(filePath)
    runtime.writeLine(`[ingest] Loaded ${title} (${content.length} chars)`)

    const submitted = runtime.lifecycle.submit({
      title,
      content,
      sourceIdentity: {
        kind: "file",
        uriOrExternalId: resolvedFilePath,
        namespace: "local",
      },
      legacySourceAliases: [filePath],
    })
    if (submitted.status === "unchanged") {
      runtime.writeLine(
        `[ingest] Unchanged doc=${submitted.docId} version=${submitted.version}`
      )
      return 0
    }
    runtime.writeLine(`[ingest] Queued task=${submitted.taskId} doc=${submitted.docId}`)

    const status = await runUntilTerminal(submitted.docId, runtime)
    printSummary(status, runtime)
    return status.task?.status === "completed" ? 0 : 1
  } catch (error) {
    runtime.writeError(`[ingest] Failed: ${errorMessage(error)}`)
    return 1
  } finally {
    await runtime.close()
  }
}

async function main(): Promise<void> {
  const lifecycle = createIngestionLifecycle(openDb())
  process.exitCode = await runIngestionCli(process.argv, {
    lifecycle,
    initialize: async () => {
      const driver = createDriver()
      await driver.verifyConnectivity()
      console.log("[ingest] Neo4j connected")
    },
    close: async () => {
      try {
        await closeDriver()
      } finally {
        closeDb()
      }
    },
    writeLine: (line) => console.log(line),
    writeError: (line) => console.error(line),
    sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    now: () => Date.now(),
  })
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[ingest] Failed: ${errorMessage(error)}`)
    process.exitCode = 1
  })
}
