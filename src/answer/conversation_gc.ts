import type { ConversationStore } from "./conversation_store"

/**
 * Ticket 08 P6 (spec §7 L1535): scheduled conversation GC.
 *
 * Conversation records expire after `ttlDays` days of session inactivity.
 * The GC job deletes ALL turns (validated + pending clarification) for
 * sessions whose MAX(created_at) predates the cutoff. Answer run traces
 * (answer_run_events table) are NOT affected — they are long-lived audit
 * history.
 *
 * Pattern mirrors src/api/worker.ts: module-level timer + start/stop pair.
 * An eager sweep fires once at startConversationGc invocation so a freshly-
 * booted process cleans stale sessions without waiting for the first tick.
 * Periodic sweeps follow every `intervalMs`.
 *
 * The stop() method is idempotent — multiple calls return the same resolved
 * promise (mirrors worker.stop() contract). The shutdown controller invokes
 * stop() to clear the interval timer during graceful shutdown.
 */

const DAY_MS = 86_400_000

export interface ConversationGcOptions {
  store: ConversationStore
  ttlDays: number
  intervalMs: number
  /**
   * Injectable clock for tests. Defaults to () => new Date().
   * Production callers should omit this so the GC uses real wall-clock time.
   */
  now?: () => Date
}

export interface ConversationGcHandle {
  stop(): Promise<void>
}

export function startConversationGc(options: ConversationGcOptions): ConversationGcHandle {
  const { store, ttlDays, intervalMs } = options
  const now = options.now ?? (() => new Date())
  let timer: NodeJS.Timeout | null = null
  let stopped = false

  function runOnce(): void {
    if (stopped) return
    try {
      const cutoff = new Date(now().getTime() - ttlDays * DAY_MS).toISOString()
      const deleted = store.deleteInactiveBefore(cutoff)
      if (deleted > 0) {
        console.log(`[conversation-gc] Purged ${deleted} turns from inactive sessions (cutoff=${cutoff})`)
      }
    } catch (error) {
      // GC failures are non-fatal — log and continue. The next tick will retry.
      console.warn(
        "[conversation-gc] Sweep failed:",
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  // Eager sweep on next tick — lets the caller's startConversationGc() return
  // synchronously while still cleaning stale sessions before the first HTTP
  // request is answered in a fresh boot.
  setImmediate(runOnce)

  timer = setInterval(runOnce, intervalMs)

  let stopPromise: Promise<void> | null = null
  return {
    stop(): Promise<void> {
      if (stopPromise) return stopPromise
      stopPromise = (async () => {
        stopped = true
        if (timer) {
          clearInterval(timer)
          timer = null
        }
        // No in-flight work to await — deleteInactiveBefore is synchronous
        // (better-sqlite3). The timer is cleared; any pending setImmediate
        // sweep that fires after stop() is skipped because runOnce checks
        // the stopped flag at entry.
      })()
      return stopPromise
    },
  }
}
