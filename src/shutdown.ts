import type { Server } from "node:http"

/**
 * T22 graceful shutdown dependencies.
 *
 * Each field is optional — the controller skips missing resources gracefully.
 * This lets callers construct the controller with only the resources they have
 * (e.g. CLI might not have a server, tests might not have a driver).
 */
export interface ShutdownDeps {
  /** Background worker — stop() should wait for the active task to finish. */
  worker?: { stop(): Promise<void> }
  /**
   * Ticket 08 P6: conversation GC scheduled job. stop() clears the interval
   * timer so no further sweeps fire during the rest of shutdown. Stopped
   * before the server because it depends only on the SQLite db (closed last).
   */
  conversationGc?: { stop(): Promise<void> | void }
  /** HTTP server — close() stops accepting new connections and waits for active requests. */
  server?: Server
  /** Answer runtime — close() closes the ES client (and any runtime-managed resources). */
  runtime?: { close(): Promise<void> }
  /** Neo4j driver — close() closes the driver and its connection pool. */
  driver?: { close(): Promise<void> }
  /** SQLite database — close() is synchronous (better-sqlite3). */
  db?: { close(): void }
  /** Bounded shutdown timeout. If exceeded, onTimeout (or process.exit) is called. Default 30000ms. */
  timeoutMs?: number
  /** Called when shutdown exceeds timeoutMs. Default: process.exit(1). For tests. */
  onTimeout?: () => void
}

export interface ShutdownController {
  shutdown(): Promise<void>
}

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Create a graceful shutdown controller that closes resources in order:
 * worker → server → runtime → driver → db.
 *
 * Each step is best-effort: if one throws, the controller logs and continues
 * to the next step so that a single failing closer doesn't leak the rest.
 *
 * If the total shutdown exceeds timeoutMs, process.exit(1) is forced.
 * The returned shutdown() is idempotent — multiple calls return the same promise.
 */
export function createShutdownController(deps: ShutdownDeps): ShutdownController {
  let shutdownPromise: Promise<void> | null = null

  async function runStep(name: string, fn: () => unknown): Promise<void> {
    try {
      await fn()
    } catch (error) {
      console.warn(
        `[shutdown] ${name} failed:`,
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  async function doShutdown(): Promise<void> {
    console.log("[shutdown] Graceful shutdown starting")
    if (deps.worker) {
      await runStep("worker.stop", () => deps.worker!.stop())
    }
    if (deps.conversationGc) {
      await runStep("conversationGc.stop", () => deps.conversationGc!.stop())
    }
    if (deps.server) {
      await runStep("server.close", () =>
        new Promise<void>((resolve) => deps.server!.close(() => resolve()))
      )
    }
    if (deps.runtime) {
      await runStep("runtime.close", () => deps.runtime!.close())
    }
    if (deps.driver) {
      await runStep("driver.close", () => deps.driver!.close())
    }
    if (deps.db) {
      await runStep("db.close", () => deps.db!.close())
    }
    console.log("[shutdown] Graceful shutdown complete")
  }

  return {
    shutdown(): Promise<void> {
      if (shutdownPromise) return shutdownPromise
      const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
      let timer: NodeJS.Timeout | undefined
      shutdownPromise = Promise.race([
        doShutdown().finally(() => {
          if (timer) clearTimeout(timer)
        }),
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => {
            console.error(
              `[shutdown] Timeout after ${timeoutMs}ms — forcing exit`
            )
            if (deps.onTimeout) {
              deps.onTimeout()
              reject(new Error(`Shutdown timeout after ${timeoutMs}ms`))
            } else {
              process.exit(1)
            }
          }, timeoutMs)
        }),
      ])
      return shutdownPromise
    },
  }
}

/**
 * Install SIGINT and SIGTERM handlers that trigger graceful shutdown.
 * Returns a cleanup function to remove the handlers (useful for tests).
 */
export function installSignalHandlers(
  controller: ShutdownController,
  signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"]
): () => void {
  const handlers: Array<[NodeJS.Signals, () => void]> = []
  for (const signal of signals) {
    const handler = () => {
      console.log(`\n[shutdown] Received ${signal}`)
      controller.shutdown()
        .then(() => process.exit(0))
        .catch((err) => {
          console.error("[shutdown] Failed:", err)
          process.exit(1)
        })
    }
    process.on(signal, handler)
    handlers.push([signal, handler])
  }
  return () => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler)
    }
  }
}
