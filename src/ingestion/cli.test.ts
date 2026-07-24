import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, relative } from "node:path"
import test from "node:test"
import {
  runIngestionCli,
  type IngestionCliRuntime,
} from "./cli"
import {
  IngestionLifecycle,
  type IngestionStageRunner,
} from "./lifecycle"
import { openDb } from "./tracking"

test("the CLI ingests a file through the lifecycle and prints stage summaries", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "kefu-rag-cli-"))
  const filePath = join(tempDir, "policy.txt")
  const content = "Refunds are available within 30 days."
  writeFileSync(filePath, content, "utf8")
  const db = openDb(":memory:")
  const resourceEvents: string[] = []
  const runner: IngestionStageRunner = {
    close: async () => {},
    async run(_document, execution): Promise<void> {
      resourceEvents.push("run")
      for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
        await execution.runStage(stage, {}, async () => undefined, () => ({ stage }))
      }
    },
  }
  const lifecycle = new IngestionLifecycle(db, runner)
  const lines: string[] = []
  const errors: string[] = []
  const runtime: IngestionCliRuntime = {
    lifecycle,
    initialize: async () => {
      resourceEvents.push("initialize")
    },
    close: async () => {
      resourceEvents.push("close")
    },
    writeLine: (line) => lines.push(line),
    writeError: (line) => errors.push(line),
    sleep: async () => {},
    now: () => Date.now(),
  }

  try {
    const exitCode = await runIngestionCli(["node", "cli", filePath], runtime)

    assert.equal(exitCode, 0)
    assert.deepEqual(resourceEvents, ["initialize", "run", "close"])
    assert.deepEqual(errors, [])
    assert.equal(lines[0], `[ingest] Loaded ${basename(filePath)} (${content.length} chars)`)
    assert.match(lines[1], /^\[ingest\] Queued task=\d+ doc=/)
    assert.match(lines[2], /^\[ingest\] Task \d+: completed$/)
    assert.deepEqual(
      lines.slice(3).map((line) => line.match(/stage=(\w+)/)?.[1]),
      ["chunk", "wikify", "storeChunks", "storeGraph"]
    )
    assert.ok(lines.slice(3).every((line) => /status=done duration=\d+ms$/.test(line)))
  } finally {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test("the CLI reports an unchanged file without running ingestion again", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "kefu-rag-cli-"))
  const filePath = join(tempDir, "policy.txt")
  writeFileSync(filePath, "same content", "utf8")
  const db = openDb(":memory:")
  let runs = 0
  const lifecycle = new IngestionLifecycle(db, {
    close: async () => {},
    async run(_document, execution): Promise<void> {
      runs += 1
      for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
        await execution.runStage(stage, {}, async () => undefined, () => ({ stage }))
      }
    },
  })
  const lines: string[] = []
  const runtime: IngestionCliRuntime = {
    lifecycle,
    initialize: async () => {},
    close: async () => {},
    writeLine: (line) => lines.push(line),
    writeError: () => {},
    sleep: async () => {},
    now: () => Date.now(),
  }

  try {
    assert.equal(await runIngestionCli(["node", "cli", filePath], runtime), 0)
    lines.length = 0
    const relativeFilePath = relative(process.cwd(), filePath)
    assert.equal(await runIngestionCli(["node", "cli", relativeFilePath], runtime), 0)
    assert.equal(runs, 1)
    assert.match(lines[1], /^\[ingest\] Unchanged doc=.+ version=1$/)
  } finally {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test("the CLI retries to a failed terminal summary and exits non-zero", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "kefu-rag-cli-"))
  const filePath = join(tempDir, "broken.txt")
  writeFileSync(filePath, "content", "utf8")
  const db = openDb(":memory:")
  let now = Date.parse("2026-07-15T00:00:00.000Z")
  const runner: IngestionStageRunner = {
    close: async () => {},
    async run(_document, execution): Promise<void> {
      await execution.runStage("chunk", {}, async () => undefined, () => ({}))
      await execution.runStage(
        "wikify",
        {},
        async () => {
          throw new Error("wikify unavailable")
        },
        () => ({})
      )
    },
  }
  const lifecycle = new IngestionLifecycle(db, runner, () => new Date(now))
  const lines: string[] = []
  const errors: string[] = []
  const runtime: IngestionCliRuntime = {
    lifecycle,
    initialize: async () => {},
    close: async () => {},
    writeLine: (line) => lines.push(line),
    writeError: (line) => errors.push(line),
    sleep: async (delayMs) => {
      now += delayMs
    },
    now: () => now,
  }

  try {
    const exitCode = await runIngestionCli(["node", "cli", filePath], runtime)
    const output = lines.join("\n")

    assert.equal(exitCode, 1)
    assert.deepEqual(errors, [])
    assert.match(output, /^\[ingest\] Loaded/m)
    assert.match(output, /^\[ingest\] Task \d+: failed$/m)
    assert.match(output, /stage=wikify status=failed duration=\d+ms error=wikify unavailable/)
    assert.equal(output.match(/stage=wikify status=failed/g)?.length, 4)
    assert.doesNotMatch(output, /at Object\.run/)
  } finally {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  }
})
