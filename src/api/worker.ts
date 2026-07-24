import { loadConfig } from "../config"
import { createIngestionLifecycle } from "../ingestion/pipeline"
import { type DB, openDb } from "../ingestion/tracking"

let timer: NodeJS.Timeout | null = null
let isBusy = false

/**
 * T45: startWorker accepts a shared SQLite adapter from ProcessRuntime.
 * If no db is provided, falls back to the global openDb() cache (backward
 * compat for tests and CLI). The worker does not close the db — the caller
 * that owns ProcessRuntime is responsible for closing shared resources.
 */
export function startWorker(options: {
  db?: DB
  pollIntervalMs?: number
  claimedTimeoutMs?: number
} = {}): { stop(): Promise<void> } {
  const cfg = loadConfig()
  const db = options.db ?? openDb()
  const lifecycle = createIngestionLifecycle(db)

  const pollIntervalMs = options.pollIntervalMs ?? cfg.pollIntervalMs
  const claimedTimeoutMs = options.claimedTimeoutMs ?? cfg.claimedTimeoutMs

  console.log(`[worker] Polling every ${pollIntervalMs}ms`)

  timer = setInterval(async () => {
    if (isBusy) return
    isBusy = true
    try {
      lifecycle.recoverStaleClaims(claimedTimeoutMs)
      const result = await lifecycle.runNext()
      if (!result) return

      if (result.success) {
        console.log(`[worker] Task ${result.taskId} completed`)
      } else if (result.cancelled) {
        console.log(`[worker] Task ${result.taskId} cancelled`)
      } else {
        console.error(`[worker] Task ${result.taskId} failed: ${result.error}`)
      }
    } catch (error) {
      console.error("[worker] Error:", error)
    } finally {
      isBusy = false
    }
  }, pollIntervalMs)

  return {
    async stop(): Promise<void> {
      stopWorker()
      // Wait for the active task to finish so that graceful shutdown doesn't
      // interrupt an in-flight ingestion. Bounded by the caller's shutdown timeout.
      while (isBusy) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      try {
        await lifecycle.close()
      } catch (error) {
        console.warn(
          "[worker] Failed to close ingestion lifecycle:",
          error instanceof Error ? error.message : String(error)
        )
      }
    },
  }
}

export function stopWorker(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
