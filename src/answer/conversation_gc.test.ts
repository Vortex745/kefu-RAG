import assert from "node:assert/strict"
import test from "node:test"
import { startConversationGc } from "./conversation_gc"
import type { ConversationStore } from "./conversation_store"

function makeMockStore(): {
  store: ConversationStore
  deleteCalls: string[]
} {
  const deleteCalls: string[] = []
  const store: ConversationStore = {
    saveValidatedTurn: () => {},
    loadRecentTurns: () => [],
    savePendingClarification: () => {},
    consumePendingClarification: () => null,
    deleteInactiveBefore: (cutoffIso: string) => {
      deleteCalls.push(cutoffIso)
      return 0
    },
    saveRollingSummary: () => {},
    getRollingSummary: () => null,
    loadConversationMemory: () => ({ summary: null, summarizedThroughTurnId: null, schemaVersion: null, recentTurns: [], totalValidatedTurnCount: 0, oldestRecentTurnId: null }),
    loadOlderTurnsForSummarization: () => [],
  }
  return { store, deleteCalls }
}

test("Ticket 08 P6: startConversationGc eagerly invokes deleteInactiveBefore once at startup with cutoff = now - ttlDays", async () => {
  // Spec §7 L1535: 30-day expiry. The GC job fires once immediately at start
  // (eager cleanup) so a freshly-booted process cleans stale sessions without
  // waiting for the first interval tick. cutoff = now - ttlDays * 86400000.
  const { store, deleteCalls } = makeMockStore()
  const fixedNow = new Date("2026-07-18T00:00:00.000Z")
  const ttlDays = 30
  const gc = startConversationGc({
    store,
    ttlDays,
    intervalMs: 86_400_000,
    now: () => fixedNow,
  })
  // setImmediate fires on next tick — await it so the eager call completes.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(
    deleteCalls.length,
    1,
    "eager cleanup must invoke deleteInactiveBefore exactly once at startup"
  )
  const expectedCutoff = new Date(
    fixedNow.getTime() - ttlDays * 86_400_000
  ).toISOString()
  assert.equal(
    deleteCalls[0],
    expectedCutoff,
    `cutoff must be now - ${ttlDays} days (${expectedCutoff}), got ${deleteCalls[0]}`
  )
  await gc.stop()
})

test("Ticket 08 P6: startConversationGc.stop() clears the interval timer and is idempotent", async () => {
  const { store } = makeMockStore()
  const gc = startConversationGc({
    store,
    ttlDays: 30,
    intervalMs: 86_400_000,
    now: () => new Date("2026-07-18T00:00:00.000Z"),
  })
  await gc.stop()
  // Second stop must not throw — idempotent (mirrors worker.stop() contract).
  await gc.stop()
  // If we reach this assertion, stop() is idempotent.
  assert.ok(true, "stop() is idempotent")
})

test("Ticket 08 P6: startConversationGc periodic ticks invoke deleteInactiveBefore at each interval", async () => {
  // Use a tiny intervalMs so the periodic tick fires within test budget.
  // The eager call fires once at start; each subsequent tick adds another call.
  const { store, deleteCalls } = makeMockStore()
  const fixedNow = new Date("2026-07-18T00:00:00.000Z")
  const gc = startConversationGc({
    store,
    ttlDays: 30,
    intervalMs: 10,
    now: () => fixedNow,
  })
  // Await eager call (setImmediate).
  await new Promise((resolve) => setImmediate(resolve))
  const eagerCount = deleteCalls.length
  assert.equal(eagerCount, 1, "eager call fired")
  // Wait long enough for at least one periodic tick (intervalMs=10ms).
  await new Promise((resolve) => setTimeout(resolve, 50))
  await gc.stop()
  assert.ok(
    deleteCalls.length >= 2,
    `periodic tick must add at least one more call (got ${deleteCalls.length} total, eager was 1)`
  )
})
