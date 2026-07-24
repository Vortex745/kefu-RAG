import assert from "node:assert/strict"
import test from "node:test"
import { openDb } from "../ingestion/tracking/db"
import { SqliteConversationStore, type ConversationTurn } from "./conversation_store"

function makeTurn(
  overrides: Partial<ConversationTurn> & {
    sessionId: string
    tenantId: string
    role: "user" | "assistant"
    content: string
    runId: string
  }
): ConversationTurn {
  return {
    createdAt: "2026-07-18T00:00:00.000Z",
    ...overrides,
  }
}

test("Ticket 08 P1: saveValidatedTurn + loadRecentTurns round-trip", () => {
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  const userTurn = makeTurn({
    sessionId: "session-1",
    tenantId: "tenant-a",
    role: "user",
    content: "怎么用这个设备?",
    runId: "run-1",
    createdAt: "2026-07-18T00:00:00.000Z",
  })
  const assistantTurn = makeTurn({
    sessionId: "session-1",
    tenantId: "tenant-a",
    role: "assistant",
    content: "请参考以下步骤...",
    runId: "run-1",
    createdAt: "2026-07-18T00:00:01.000Z",
  })
  store.saveValidatedTurn(userTurn)
  store.saveValidatedTurn(assistantTurn)
  const loaded = store.loadRecentTurns("session-1", "tenant-a", 10)
  assert.equal(loaded.length, 2)
  assert.deepEqual(loaded[0], userTurn)
  assert.deepEqual(loaded[1], assistantTurn)
})

test("Ticket 08 P1: tenant-bound isolation — tenant-b cannot read tenant-a turns", () => {
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  store.saveValidatedTurn(
    makeTurn({
      sessionId: "session-1",
      tenantId: "tenant-a",
      role: "user",
      content: "tenant-a secret",
      runId: "run-1",
    })
  )
  const loaded = store.loadRecentTurns("session-1", "tenant-b", 10)
  assert.equal(loaded.length, 0, "cross-tenant load must return empty")
})

test("Ticket 08 P1: session-bound isolation — session-2 cannot read session-1 turns", () => {
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  store.saveValidatedTurn(
    makeTurn({
      sessionId: "session-1",
      tenantId: "tenant-a",
      role: "user",
      content: "session-1 message",
      runId: "run-1",
    })
  )
  const loaded = store.loadRecentTurns("session-2", "tenant-a", 10)
  assert.equal(loaded.length, 0, "cross-session load must return empty")
})

test("Ticket 08 P1: bounded limit — loadRecentTurns returns at most `limit` most-recent turns in chronological order", () => {
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  const baseTime = new Date("2026-07-18T00:00:00.000Z").getTime()
  for (let i = 0; i < 15; i += 1) {
    store.saveValidatedTurn(
      makeTurn({
        sessionId: "session-1",
        tenantId: "tenant-a",
        role: i % 2 === 0 ? "user" : "assistant",
        content: `msg ${i}`,
        runId: `run-${Math.floor(i / 2)}`,
        createdAt: new Date(baseTime + i * 1000).toISOString(),
      })
    )
  }
  const loaded = store.loadRecentTurns("session-1", "tenant-a", 10)
  assert.equal(loaded.length, 10, "limit=10 returns at most 10 turns")
  assert.equal(loaded[0].content, "msg 5", "oldest of the recent 10 comes first")
  assert.equal(loaded[9].content, "msg 14", "newest comes last")
})

test("Ticket 08 P6: deleteInactiveBefore purges sessions whose most recent activity predates the cutoff (session-level TTL)", () => {
  // Spec §7 L1535: "Conversation records expire after 30 days of inactivity."
  // Inactivity is session-level: if MAX(created_at) for a session is older
  // than the cutoff, ALL of that session's turns are deleted. A session with
  // any recent turn is preserved in full (no row-level TTL).
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  const now = new Date("2026-07-18T00:00:00.000Z")
  const dayMs = 86_400_000
  // session-old: all turns older than 30 days → expect purged
  store.saveValidatedTurn(makeTurn({
    sessionId: "session-old", tenantId: "tenant-a", role: "user",
    content: "old-1", runId: "run-old-1",
    createdAt: new Date(now.getTime() - 40 * dayMs).toISOString(),
  }))
  store.saveValidatedTurn(makeTurn({
    sessionId: "session-old", tenantId: "tenant-a", role: "assistant",
    content: "old-2", runId: "run-old-1",
    createdAt: new Date(now.getTime() - 39 * dayMs).toISOString(),
  }))
  // session-active: all turns within 30 days → expect preserved
  store.saveValidatedTurn(makeTurn({
    sessionId: "session-active", tenantId: "tenant-a", role: "user",
    content: "fresh-1", runId: "run-fresh-1",
    createdAt: new Date(now.getTime() - 10 * dayMs).toISOString(),
  }))
  // session-mixed: one old turn + one recent turn → MAX(created_at) is recent → expect preserved in full
  store.saveValidatedTurn(makeTurn({
    sessionId: "session-mixed", tenantId: "tenant-a", role: "user",
    content: "mixed-old", runId: "run-mixed-1",
    createdAt: new Date(now.getTime() - 40 * dayMs).toISOString(),
  }))
  store.saveValidatedTurn(makeTurn({
    sessionId: "session-mixed", tenantId: "tenant-a", role: "assistant",
    content: "mixed-fresh", runId: "run-mixed-1",
    createdAt: new Date(now.getTime() - 5 * dayMs).toISOString(),
  }))
  const cutoff = new Date(now.getTime() - 30 * dayMs).toISOString()
  const deleted = store.deleteInactiveBefore(cutoff)
  assert.equal(deleted, 2, "only session-old's 2 turns are deleted; session-mixed is preserved in full because its latest activity is recent")
  assert.equal(store.loadRecentTurns("session-old", "tenant-a", 100).length, 0, "session-old fully purged")
  assert.equal(store.loadRecentTurns("session-active", "tenant-a", 100).length, 1, "session-active preserved")
  assert.equal(store.loadRecentTurns("session-mixed", "tenant-a", 100).length, 2, "session-mixed preserved in full (both old and fresh turns)")
})

test("Ticket 08 P6: deleteInactiveBefore also purges pending clarifications for inactive sessions", () => {
  // Pending clarifications share the conversation_turns table (P5 kind
  // discriminator). A session inactive for 30+ days has stale pending state
  // that must be cleaned up alongside its validated turns.
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  const now = new Date("2026-07-18T00:00:00.000Z")
  const dayMs = 86_400_000
  store.savePendingClarification(
    "session-stale",
    "tenant-a",
    "Which policy?"
  )
  // Manually backdate the pending row by re-inserting via raw SQL since
  // savePendingClarification always uses now(). This simulates a session
  // whose pending clarification has been sitting for 40 days.
  db.prepare(
    `UPDATE conversation_turns
     SET created_at = ?
     WHERE session_id = ? AND kind = 'pending_clarification'`
  ).run(new Date(now.getTime() - 40 * dayMs).toISOString(), "session-stale")
  const cutoff = new Date(now.getTime() - 30 * dayMs).toISOString()
  const deleted = store.deleteInactiveBefore(cutoff)
  assert.equal(deleted, 1, "stale pending clarification row is purged")
  assert.equal(
    store.consumePendingClarification("session-stale", "tenant-a"),
    null,
    "no pending clarification remains for the inactive session"
  )
})

// ============================================================================
// Ticket 01 — Persist Rolling Conversation Memory (spec §2 L1740-1748)
// TDD red phase: these tests call saveRollingSummary / getRollingSummary /
// loadConversationMemory which currently throw. Real implementation follows.
// ============================================================================

test("Ticket 01: saveRollingSummary + getRollingSummary round-trip", () => {
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  store.saveRollingSummary("session-1", "tenant-a", "summary text", 5, 1)
  const record = store.getRollingSummary("session-1", "tenant-a")
  assert.ok(record, "summary must be retrievable after save")
  assert.equal(record!.sessionId, "session-1")
  assert.equal(record!.tenantId, "tenant-a")
  assert.equal(record!.summary, "summary text")
  assert.equal(record!.summarizedThroughTurnId, 5)
  assert.equal(record!.schemaVersion, 1)
  assert.ok(record!.createdAt, "createdAt must be set")
  assert.ok(record!.updatedAt, "updatedAt must be set")
})

test("Ticket 01: getRollingSummary returns null for non-existent session", () => {
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  const record = store.getRollingSummary("missing-session", "tenant-a")
  assert.equal(record, null, "non-existent summary must return null")
})

test("Ticket 01: getRollingSummary enforces tenant-bound isolation", () => {
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  store.saveRollingSummary("session-1", "tenant-a", "tenant-a summary", 3, 1)
  const crossTenant = store.getRollingSummary("session-1", "tenant-b")
  assert.equal(crossTenant, null, "cross-tenant read must return null")
})

test("Ticket 01: getRollingSummary enforces session-bound isolation", () => {
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  store.saveRollingSummary("session-1", "tenant-a", "session-1 summary", 3, 1)
  const crossSession = store.getRollingSummary("session-2", "tenant-a")
  assert.equal(crossSession, null, "cross-session read must return null")
})

test("Ticket 01: saveRollingSummary is idempotent when re-saving the same checkpoint", () => {
  // Spec §2 L1743: "Reprocessing the same validated turn range must not
  // change the checkpoint or duplicate facts." Re-saving with the same
  // summarizedThroughTurnId is a no-op — existing record preserved,
  // updatedAt unchanged.
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  store.saveRollingSummary("session-1", "tenant-a", "first summary", 5, 1)
  const first = store.getRollingSummary("session-1", "tenant-a")!
  // Re-save with same checkpoint but different summary text — must NOT change.
  store.saveRollingSummary("session-1", "tenant-a", "different summary text", 5, 1)
  const second = store.getRollingSummary("session-1", "tenant-a")!
  assert.equal(second.summary, "first summary", "idempotent re-save preserves original summary")
  assert.equal(second.updatedAt, first.updatedAt, "idempotent re-save does not bump updatedAt")
  assert.equal(second.createdAt, first.createdAt, "createdAt unchanged")
})

test("Ticket 01: saveRollingSummary advances checkpoint when summarizedThroughTurnId is strictly greater", () => {
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  store.saveRollingSummary("session-1", "tenant-a", "v1 summary", 5, 1)
  const first = store.getRollingSummary("session-1", "tenant-a")!
  store.saveRollingSummary("session-1", "tenant-a", "v2 summary", 10, 1)
  const second = store.getRollingSummary("session-1", "tenant-a")!
  assert.equal(second.summary, "v2 summary", "advancing checkpoint updates summary text")
  assert.equal(second.summarizedThroughTurnId, 10, "checkpoint advances")
  assert.equal(second.createdAt, first.createdAt, "createdAt stable across updates")
  // updatedAt is refreshed by the UPDATE statement; same-millisecond
  // collisions are theoretically possible but the SQL always runs SET
  // updated_at=? on advance, so this assertion documents the contract.
  assert.ok(
    second.updatedAt >= first.updatedAt,
    "updatedAt must not go backwards on advance"
  )
})

test("Ticket 01: saveRollingSummary rejects strictly smaller summarizedThroughTurnId (regression)", () => {
  // Spec §2 L1743: checkpoint can only advance forward, never regress.
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  store.saveRollingSummary("session-1", "tenant-a", "summary", 10, 1)
  assert.throws(
    () => store.saveRollingSummary("session-1", "tenant-a", "regressed summary", 5, 1),
    /regress|smaller|checkpoint/i,
    "regressing checkpoint must throw"
  )
  // Verify the original record is preserved (no partial update).
  const record = store.getRollingSummary("session-1", "tenant-a")!
  assert.equal(record.summarizedThroughTurnId, 10, "original checkpoint preserved after rejected regression")
  assert.equal(record.summary, "summary", "original summary preserved after rejected regression")
})

test("Ticket 01: loadConversationMemory on empty session returns null summary + empty turns", () => {
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  const memory = store.loadConversationMemory("session-1", "tenant-a")
  assert.equal(memory.summary, null)
  assert.equal(memory.summarizedThroughTurnId, null)
  assert.equal(memory.schemaVersion, null)
  assert.deepEqual(memory.recentTurns, [])
})

test("Ticket 01: loadConversationMemory returns summary when no validated turns exist", () => {
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  store.saveRollingSummary("session-1", "tenant-a", "lone summary", 5, 1)
  const memory = store.loadConversationMemory("session-1", "tenant-a")
  assert.equal(memory.summary, "lone summary")
  assert.equal(memory.summarizedThroughTurnId, 5)
  assert.equal(memory.schemaVersion, 1)
  assert.deepEqual(memory.recentTurns, [], "no turns stored → empty recentTurns")
})

test("Ticket 01: loadConversationMemory returns turns when no summary exists", () => {
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  const userTurn = makeTurn({
    sessionId: "session-1", tenantId: "tenant-a", role: "user",
    content: "hello", runId: "run-1",
  })
  const assistantTurn = makeTurn({
    sessionId: "session-1", tenantId: "tenant-a", role: "assistant",
    content: "hi there", runId: "run-1",
    createdAt: "2026-07-18T00:00:01.000Z",
  })
  store.saveValidatedTurn(userTurn)
  store.saveValidatedTurn(assistantTurn)
  const memory = store.loadConversationMemory("session-1", "tenant-a")
  assert.equal(memory.summary, null, "no summary saved → null")
  assert.equal(memory.summarizedThroughTurnId, null)
  assert.equal(memory.schemaVersion, null)
  assert.equal(memory.recentTurns.length, 2)
  assert.deepEqual(memory.recentTurns[0], userTurn)
  assert.deepEqual(memory.recentTurns[1], assistantTurn)
})

test("Ticket 01: loadConversationMemory returns summary + recent turns together", () => {
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  // Save some early turns (already summarized) — these are still stored as
  // validated turns. Caller maintains the disjoint invariant; loadConversationMemory
  // does NOT filter turns by summarizedThroughTurnId (spec §2 L1741-1742 puts
  // the burden on the caller to summarize turns preceding the recent window).
  for (let i = 0; i < 4; i += 1) {
    store.saveValidatedTurn(makeTurn({
      sessionId: "session-1", tenantId: "tenant-a",
      role: i % 2 === 0 ? "user" : "assistant",
      content: `early-${i}`, runId: `early-${Math.floor(i / 2)}`,
      createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    }))
  }
  store.saveRollingSummary("session-1", "tenant-a", "early summary", 4, 1)
  // Recent turns
  const recentUser = makeTurn({
    sessionId: "session-1", tenantId: "tenant-a", role: "user",
    content: "recent question", runId: "recent-1",
    createdAt: "2026-07-18T00:00:00.000Z",
  })
  const recentAssistant = makeTurn({
    sessionId: "session-1", tenantId: "tenant-a", role: "assistant",
    content: "recent answer", runId: "recent-1",
    createdAt: "2026-07-18T00:00:01.000Z",
  })
  store.saveValidatedTurn(recentUser)
  store.saveValidatedTurn(recentAssistant)
  const memory = store.loadConversationMemory("session-1", "tenant-a")
  assert.equal(memory.summary, "early summary")
  assert.equal(memory.summarizedThroughTurnId, 4)
  assert.equal(memory.schemaVersion, 1)
  // 6 total turns ≤ 6 pairs cap → all 6 returned.
  assert.equal(memory.recentTurns.length, 6, "all turns returned when total ≤ 6 pairs")
})

test("Ticket 01: loadConversationMemory caps at six completed pairs (≤12 turns)", () => {
  // Spec §2 L1741: "the most recent six completed user/assistant pairs
  // verbatim" — at most 12 turns returned.
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  const baseTime = new Date("2026-07-18T00:00:00.000Z").getTime()
  // Save 15 pairs (30 turns).
  for (let i = 0; i < 30; i += 1) {
    store.saveValidatedTurn(makeTurn({
      sessionId: "session-1", tenantId: "tenant-a",
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg-${i}`, runId: `run-${Math.floor(i / 2)}`,
      createdAt: new Date(baseTime + i * 1000).toISOString(),
    }))
  }
  const memory = store.loadConversationMemory("session-1", "tenant-a")
  assert.equal(memory.recentTurns.length, 12, "must cap at 12 turns (6 pairs)")
  // The 12 most recent are msg-18 through msg-29 (oldest of the recent 6 pairs first).
  assert.equal(memory.recentTurns[0].content, "msg-18", "oldest of the 6 recent pairs first")
  assert.equal(memory.recentTurns[11].content, "msg-29", "newest last")
})

test("Ticket 01: loadConversationMemory drops trailing unpaired user turn", () => {
  // Spec §2 L1741: only *completed* user/assistant pairs returned. A
  // trailing user turn with no validated assistant reply is excluded.
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  const baseTime = new Date("2026-07-18T00:00:00.000Z").getTime()
  // 6 complete pairs + 1 trailing user turn = 13 turns total.
  for (let i = 0; i < 13; i += 1) {
    store.saveValidatedTurn(makeTurn({
      sessionId: "session-1", tenantId: "tenant-a",
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg-${i}`, runId: `run-${Math.floor(i / 2)}`,
      createdAt: new Date(baseTime + i * 1000).toISOString(),
    }))
  }
  // i=12 is even → role='user' → unpaired (no i=13 assistant reply).
  const memory = store.loadConversationMemory("session-1", "tenant-a")
  assert.equal(memory.recentTurns.length, 12, "trailing unpaired user turn dropped → 12 turns (6 pairs)")
  assert.equal(memory.recentTurns[0].content, "msg-0", "first pair user")
  assert.equal(memory.recentTurns[11].content, "msg-11", "last pair assistant — trailing msg-12 dropped")
  assert.equal(
    memory.recentTurns[11].role,
    "assistant",
    "last turn must be assistant (completed pair) — not the trailing user"
  )
})

test("Ticket 01: loadConversationMemory returns recentTurns in chronological (oldest-first) order", () => {
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  const baseTime = new Date("2026-07-18T00:00:00.000Z").getTime()
  for (let i = 0; i < 6; i += 1) {
    store.saveValidatedTurn(makeTurn({
      sessionId: "session-1", tenantId: "tenant-a",
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn-${i}`, runId: `run-${Math.floor(i / 2)}`,
      createdAt: new Date(baseTime + i * 1000).toISOString(),
    }))
  }
  const memory = store.loadConversationMemory("session-1", "tenant-a")
  const timestamps = memory.recentTurns.map((t) => t.createdAt)
  const sorted = [...timestamps].sort()
  assert.deepEqual(timestamps, sorted, "recentTurns must be in chronological order (oldest first)")
})

test("Ticket 01: loadConversationMemory enforces tenant-bound isolation", () => {
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  store.saveRollingSummary("session-1", "tenant-a", "tenant-a summary", 3, 1)
  store.saveValidatedTurn(makeTurn({
    sessionId: "session-1", tenantId: "tenant-a", role: "user",
    content: "tenant-a turn", runId: "run-1",
  }))
  const crossTenant = store.loadConversationMemory("session-1", "tenant-b")
  assert.equal(crossTenant.summary, null, "cross-tenant summary must be null")
  assert.equal(crossTenant.summarizedThroughTurnId, null)
  assert.equal(crossTenant.schemaVersion, null)
  assert.deepEqual(crossTenant.recentTurns, [], "cross-tenant recentTurns must be empty")
})

test("Ticket 01: loadConversationMemory enforces session-bound isolation", () => {
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  store.saveRollingSummary("session-1", "tenant-a", "session-1 summary", 3, 1)
  store.saveValidatedTurn(makeTurn({
    sessionId: "session-1", tenantId: "tenant-a", role: "user",
    content: "session-1 turn", runId: "run-1",
  }))
  const crossSession = store.loadConversationMemory("session-2", "tenant-a")
  assert.equal(crossSession.summary, null, "cross-session summary must be null")
  assert.deepEqual(crossSession.recentTurns, [], "cross-session recentTurns must be empty")
})

test("Ticket 01: loadConversationMemory excludes pending clarifications from recentTurns", () => {
  // Pending clarifications share the conversation_turns table with kind=
  // 'pending_clarification'. They are transient and must NOT appear in
  // recentTurns (only validated turns feed the contextualizer per spec §7).
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  store.savePendingClarification("session-1", "tenant-a", "ambiguous pending message")
  store.saveValidatedTurn(makeTurn({
    sessionId: "session-1", tenantId: "tenant-a", role: "user",
    content: "validated user", runId: "run-1",
  }))
  store.saveValidatedTurn(makeTurn({
    sessionId: "session-1", tenantId: "tenant-a", role: "assistant",
    content: "validated assistant", runId: "run-1",
    createdAt: "2026-07-18T00:00:01.000Z",
  }))
  const memory = store.loadConversationMemory("session-1", "tenant-a")
  assert.equal(memory.recentTurns.length, 2, "pending clarification must NOT be in recentTurns")
  assert.equal(memory.recentTurns[0].content, "validated user")
  assert.equal(memory.recentTurns[1].content, "validated assistant")
  assert.ok(
    !memory.recentTurns.some((t) => t.content === "ambiguous pending message"),
    "pending clarification must be excluded"
  )
})

test("Ticket 01: deleteInactiveBefore also deletes rolling summaries for inactive sessions", () => {
  // Spec §2 L1747: "Conversation TTL deletes both raw contextualization
  // turns and their summary." A session inactive for 30+ days loses BOTH.
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  const now = new Date("2026-07-18T00:00:00.000Z")
  const dayMs = 86_400_000
  // Save a turn + summary for an old session (all activity > 30 days ago).
  store.saveValidatedTurn(makeTurn({
    sessionId: "session-old", tenantId: "tenant-a", role: "user",
    content: "old turn", runId: "run-old",
    createdAt: new Date(now.getTime() - 40 * dayMs).toISOString(),
  }))
  store.saveRollingSummary("session-old", "tenant-a", "old summary", 1, 1)
  // Session activity is determined by conversation_turns MAX(created_at);
  // the summary's own created_at does NOT factor into the TTL decision.
  const cutoff = new Date(now.getTime() - 30 * dayMs).toISOString()
  const deleted = store.deleteInactiveBefore(cutoff)
  assert.equal(deleted, 1, "1 turn row deleted (summary deletions not counted per L1747 contract)")
  assert.equal(store.getRollingSummary("session-old", "tenant-a"), null, "rolling summary also purged")
  assert.equal(store.loadRecentTurns("session-old", "tenant-a", 100).length, 0, "turns also purged")
})

test("Ticket 01: deleteInactiveBefore preserves rolling summaries for active sessions", () => {
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  const now = new Date("2026-07-18T00:00:00.000Z")
  const dayMs = 86_400_000
  store.saveValidatedTurn(makeTurn({
    sessionId: "session-active", tenantId: "tenant-a", role: "user",
    content: "fresh turn", runId: "run-fresh",
    createdAt: new Date(now.getTime() - 5 * dayMs).toISOString(),
  }))
  store.saveRollingSummary("session-active", "tenant-a", "fresh summary", 1, 1)
  const cutoff = new Date(now.getTime() - 30 * dayMs).toISOString()
  store.deleteInactiveBefore(cutoff)
  assert.ok(store.getRollingSummary("session-active", "tenant-a"), "active session's summary preserved")
  assert.equal(store.loadRecentTurns("session-active", "tenant-a", 100).length, 1, "active session's turns preserved")
})

test("Ticket 01: deleteInactiveBefore preserves summaries for mixed-age sessions (session-level TTL)", () => {
  // A session with any turn newer than the cutoff is preserved in full —
  // both old turns and the rolling summary survive.
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  const now = new Date("2026-07-18T00:00:00.000Z")
  const dayMs = 86_400_000
  store.saveValidatedTurn(makeTurn({
    sessionId: "session-mixed", tenantId: "tenant-a", role: "user",
    content: "old turn", runId: "run-mixed-1",
    createdAt: new Date(now.getTime() - 40 * dayMs).toISOString(),
  }))
  store.saveValidatedTurn(makeTurn({
    sessionId: "session-mixed", tenantId: "tenant-a", role: "assistant",
    content: "fresh turn", runId: "run-mixed-1",
    createdAt: new Date(now.getTime() - 3 * dayMs).toISOString(),
  }))
  store.saveRollingSummary("session-mixed", "tenant-a", "mixed summary", 1, 1)
  const cutoff = new Date(now.getTime() - 30 * dayMs).toISOString()
  store.deleteInactiveBefore(cutoff)
  assert.ok(store.getRollingSummary("session-mixed", "tenant-a"), "mixed session's summary preserved (latest activity is fresh)")
  assert.equal(store.loadRecentTurns("session-mixed", "tenant-a", 100).length, 2, "both old + fresh turns preserved")
})

// ============================================================
// Ticket 61 / 02 P1 — ConversationMemory extension + loadOlderTurnsForSummarization
// ============================================================

test("Ticket 02 P1: loadConversationMemory reports totalValidatedTurnCount=0 for empty session", () => {
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  const memory = store.loadConversationMemory("session-empty", "tenant-a")
  assert.equal(memory.totalValidatedTurnCount, 0)
  assert.equal(memory.oldestRecentTurnId, null)
  assert.equal(memory.recentTurns.length, 0)
})

test("Ticket 02 P1: loadConversationMemory reports totalValidatedTurnCount + oldestRecentTurnId for 1 pair", () => {
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  store.saveValidatedTurn(makeTurn({
    sessionId: "session-1", tenantId: "tenant-a", role: "user",
    content: "u1", runId: "run-1",
  }))
  store.saveValidatedTurn(makeTurn({
    sessionId: "session-1", tenantId: "tenant-a", role: "assistant",
    content: "a1", runId: "run-1",
  }))
  const memory = store.loadConversationMemory("session-1", "tenant-a")
  assert.equal(memory.totalValidatedTurnCount, 2)
  assert.equal(memory.oldestRecentTurnId, 1, "oldest recent turn id is the first inserted row id")
  assert.equal(memory.recentTurns.length, 2)
})

test("Ticket 02 P1: totalValidatedTurnCount counts ALL validated turns, not just the recent window", () => {
  // Spec §2 L1744: caller triggers summarization when "history exceeds the
  // recent-pair window" — the count must reflect ALL validated turns so the
  // caller can detect overflow even when the recent window is capped at 12.
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  // Insert 30 validated turns (15 pairs). The recent window caps at 12
  // (6 pairs), but totalValidatedTurnCount must report 30.
  for (let i = 0; i < 15; i++) {
    store.saveValidatedTurn(makeTurn({
      sessionId: "session-1", tenantId: "tenant-a", role: "user",
      content: `u${i}`, runId: `run-${i}`,
      createdAt: new Date(Date.parse("2026-07-18T00:00:00.000Z") + i * 2000).toISOString(),
    }))
    store.saveValidatedTurn(makeTurn({
      sessionId: "session-1", tenantId: "tenant-a", role: "assistant",
      content: `a${i}`, runId: `run-${i}`,
      createdAt: new Date(Date.parse("2026-07-18T00:00:01.000Z") + i * 2000).toISOString(),
    }))
  }
  const memory = store.loadConversationMemory("session-1", "tenant-a")
  assert.equal(memory.recentTurns.length, 12, "recent window capped at 12 (6 pairs)")
  assert.equal(memory.totalValidatedTurnCount, 30, "total count is uncapped")
  // oldestRecentTurnId points to turn #19 (the 7th pair's user turn, since
  // 30 - 12 = 18 → first retained id is 19). This is the new checkpoint
  // candidate (oldestRecentTurnId - 1 = 18) for the summarizer.
  assert.equal(memory.oldestRecentTurnId, 19, "oldest in recent window is turn 19 (ids 1..30, last 12 = 19..30)")
})

test("Ticket 02 P1: totalValidatedTurnCount excludes pending clarifications", () => {
  // Spec §2 L1744: pending clarifications are NOT counted — only validated
  // turns drive the "history exceeds window" check.
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  // Insert one completed pair (user + assistant validated turns).
  store.saveValidatedTurn(makeTurn({
    sessionId: "session-1", tenantId: "tenant-a", role: "user",
    content: "validated-user", runId: "run-1",
  }))
  store.saveValidatedTurn(makeTurn({
    sessionId: "session-1", tenantId: "tenant-a", role: "assistant",
    content: "validated-assistant", runId: "run-1",
  }))
  // A pending clarification must NOT inflate the count.
  store.savePendingClarification("session-1", "tenant-a", "pending message")
  const memory = store.loadConversationMemory("session-1", "tenant-a")
  assert.equal(memory.totalValidatedTurnCount, 2, "pending clarification not counted")
  assert.equal(memory.recentTurns.length, 2, "pending clarification excluded from recentTurns")
  assert.ok(
    !memory.recentTurns.some((t) => t.content === "pending message"),
    "pending clarification content must not leak into recentTurns"
  )
})

test("Ticket 02 P1: loadOlderTurnsForSummarization round-trip loads turns in id-ascending order", () => {
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  // Insert 5 validated turns (ids 1..5).
  for (let i = 0; i < 5; i++) {
    store.saveValidatedTurn(makeTurn({
      sessionId: "session-1", tenantId: "tenant-a", role: i % 2 === 0 ? "user" : "assistant",
      content: `t${i}`, runId: `run-${i}`,
      createdAt: new Date(Date.parse("2026-07-18T00:00:00.000Z") + i * 1000).toISOString(),
    }))
  }
  // Load turns with id in (1, 3] → ids 2, 3 (fromIdExclusive=1, toIdInclusive=3).
  const older = store.loadOlderTurnsForSummarization("session-1", "tenant-a", 1, 3)
  assert.equal(older.length, 2)
  assert.deepEqual(older.map((t) => t.content), ["t1", "t2"], "ascending by id")
})

test("Ticket 02 P1: loadOlderTurnsForSummarization returns empty when toIdInclusive <= fromIdExclusive", () => {
  // Caller computes newCheckpoint = oldestRecentTurnId - 1. When the recent
  // window's oldest is id=1, newCheckpoint=0; caller passes (fromIdExclusive=
  // summarizedThroughTurnId ?? 0=0, toIdInclusive=0) → empty (no work).
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  store.saveValidatedTurn(makeTurn({
    sessionId: "session-1", tenantId: "tenant-a", role: "user",
    content: "only", runId: "run-1",
  }))
  assert.deepEqual(
    store.loadOlderTurnsForSummarization("session-1", "tenant-a", 0, 0),
    [],
    "empty range when toIdInclusive == fromIdExclusive"
  )
  assert.deepEqual(
    store.loadOlderTurnsForSummarization("session-1", "tenant-a", 5, 3),
    [],
    "empty range when toIdInclusive < fromIdExclusive"
  )
})

test("Ticket 02 P1: loadOlderTurnsForSummarization enforces tenant-bound isolation", () => {
  // Cross-tenant or cross-session reads must return empty — the (sessionId,
  // tenantId) boundary is the isolation key.
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  for (let i = 0; i < 4; i++) {
    store.saveValidatedTurn(makeTurn({
      sessionId: "session-a", tenantId: "tenant-a", role: "user",
      content: `a${i}`, runId: `run-a-${i}`,
    }))
  }
  // Wrong tenant — empty.
  assert.deepEqual(
    store.loadOlderTurnsForSummarization("session-a", "tenant-b", 0, 100),
    [],
    "cross-tenant read returns empty"
  )
  // Wrong session — empty.
  assert.deepEqual(
    store.loadOlderTurnsForSummarization("session-b", "tenant-a", 0, 100),
    [],
    "cross-session read returns empty"
  )
})

test("Ticket 02 P1: loadOlderTurnsForSummarization excludes pending clarifications", () => {
  // Spec §2 L1744: only validated turns are folded into the summary.
  // Pending clarifications are transient and must not leak into the
  // summarizer input.
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  store.saveValidatedTurn(makeTurn({
    sessionId: "session-1", tenantId: "tenant-a", role: "user",
    content: "validated-1", runId: "run-1",
  }))
  store.savePendingClarification("session-1", "tenant-a", "pending-2")
  store.saveValidatedTurn(makeTurn({
    sessionId: "session-1", tenantId: "tenant-a", role: "assistant",
    content: "validated-3", runId: "run-3",
  }))
  // Range covers all ids 1..3, but pending clarification (id=2) must be
  // excluded by the `kind = 'validated'` filter.
  const older = store.loadOlderTurnsForSummarization("session-1", "tenant-a", 0, 100)
  assert.equal(older.length, 2, "pending clarification excluded")
  assert.deepEqual(older.map((t) => t.content), ["validated-1", "validated-3"])
})

test("Ticket 02 P1: loadOlderTurnsForSummarization returns empty for unknown session", () => {
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  assert.deepEqual(
    store.loadOlderTurnsForSummarization("unknown-session", "tenant-a", 0, 100),
    []
  )
})

// ============================================================================
// Ticket 03 — Unify Handoff and memory retention (spec §2 L1748-1749)
// Verify that conversation TTL cleanup removes validated turns, pending
// clarifications and rolling summaries together; trace history is preserved;
// cleanup is idempotent. Implementation was delivered by Tickets 01/02/08;
// these tests close the focused-coverage gap for the unified retention contract.
// ============================================================================

test("Ticket 03: deleteInactiveBefore removes validated turns, pending clarification and rolling summary together", () => {
  // Spec §2 L1747: "Conversation TTL deletes both raw contextualization
  // turns and their summary." Pending clarifications share the conversation_turns
  // table (Ticket 08 P5 kind discriminator) and must also be purged in the same
  // call so no orphaned conversation-memory rows survive TTL cleanup.
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  const now = new Date("2026-07-18T00:00:00.000Z")
  const dayMs = 86_400_000
  const oldDate = new Date(now.getTime() - 40 * dayMs).toISOString()

  // Build a session with all three retention entities.
  store.saveValidatedTurn(makeTurn({
    sessionId: "session-stale", tenantId: "tenant-a", role: "user",
    content: "old question", runId: "run-stale",
    createdAt: oldDate,
  }))
  store.saveValidatedTurn(makeTurn({
    sessionId: "session-stale", tenantId: "tenant-a", role: "assistant",
    content: "old answer", runId: "run-stale",
    createdAt: oldDate,
  }))
  store.savePendingClarification("session-stale", "tenant-a", "Which policy?")
  // Backdate the pending clarification row (savePendingClarification uses now()).
  db.prepare(
    `UPDATE conversation_turns SET created_at = ? WHERE session_id = ? AND kind = 'pending_clarification'`
  ).run(oldDate, "session-stale")
  store.saveRollingSummary("session-stale", "tenant-a", "old summary", 1, 1)

  const cutoff = new Date(now.getTime() - 30 * dayMs).toISOString()
  const deleted = store.deleteInactiveBefore(cutoff)

  // 3 conversation_turns rows deleted (2 validated + 1 pending clarification).
  assert.equal(deleted, 3, "all conversation_turns rows purged (validated + pending)")
  assert.equal(store.loadRecentTurns("session-stale", "tenant-a", 100).length, 0, "validated turns purged")
  assert.equal(store.consumePendingClarification("session-stale", "tenant-a"), null, "pending clarification purged")
  assert.equal(store.getRollingSummary("session-stale", "tenant-a"), null, "rolling summary purged")
})

test("Ticket 03: deleteInactiveBefore does not touch immutable answer_run_events trace history", () => {
  // Spec §2 L1749: "Immutable Answer-run trace history remains untouched by
  // conversation-memory retention." The answer_run_events table is a separate
  // concern from conversation memory and must survive TTL cleanup intact.
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  const now = new Date("2026-07-18T00:00:00.000Z")
  const dayMs = 86_400_000
  const oldDate = new Date(now.getTime() - 40 * dayMs).toISOString()

  // Create an inactive session with a validated turn.
  store.saveValidatedTurn(makeTurn({
    sessionId: "session-traced", tenantId: "tenant-a", role: "user",
    content: "old traced turn", runId: "run-traced",
    createdAt: oldDate,
  }))
  // Insert a trace event for the same session/run.
  db.prepare(
    `INSERT INTO answer_run_events (run_id, event_id, sequence, session_id, event_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run("run-traced", "run-traced:1", 1, "session-traced", '{"type":"route"}', oldDate)

  const cutoff = new Date(now.getTime() - 30 * dayMs).toISOString()
  store.deleteInactiveBefore(cutoff)

  // Conversation memory is purged.
  assert.equal(store.loadRecentTurns("session-traced", "tenant-a", 100).length, 0, "conversation turns purged")
  // Trace history is preserved.
  const traceRow = db.prepare(
    `SELECT COUNT(*) AS n FROM answer_run_events WHERE session_id = ?`
  ).get("session-traced") as { n: number }
  assert.equal(traceRow.n, 1, "answer_run_events trace history preserved — not touched by TTL cleanup")
})

test("Ticket 03: deleteInactiveBefore is idempotent — second call returns 0 and does not error", () => {
  // Spec §2 L1748: "Cleanup is idempotent and reports the affected session or
  // record count consistently." Calling deleteInactiveBefore twice with the
  // same cutoff must not error and must return 0 on the second call (nothing
  // left to delete).
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  const now = new Date("2026-07-18T00:00:00.000Z")
  const dayMs = 86_400_000
  store.saveValidatedTurn(makeTurn({
    sessionId: "session-old", tenantId: "tenant-a", role: "user",
    content: "old turn", runId: "run-old",
    createdAt: new Date(now.getTime() - 40 * dayMs).toISOString(),
  }))
  store.saveRollingSummary("session-old", "tenant-a", "old summary", 1, 1)

  const cutoff = new Date(now.getTime() - 30 * dayMs).toISOString()
  const firstDeleted = store.deleteInactiveBefore(cutoff)
  assert.equal(firstDeleted, 1, "first call deletes 1 turn row")

  const secondDeleted = store.deleteInactiveBefore(cutoff)
  assert.equal(secondDeleted, 0, "second call deletes 0 rows (idempotent)")
})

test("P1 regression: peekPendingClarification is tenant-bound and non-destructive", () => {
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  store.savePendingClarification("session-peek", "tenant-a", "Which policy?")

  assert.equal(
    store.peekPendingClarification("session-peek", "tenant-a"),
    "Which policy?"
  )
  assert.equal(
    store.peekPendingClarification("session-peek", "tenant-a"),
    "Which policy?",
    "repeated peeks must not consume the pending clarification"
  )
  assert.equal(
    store.peekPendingClarification("session-peek", "tenant-b"),
    null,
    "pending clarification must not cross tenant boundaries"
  )
  assert.equal(
    store.consumePendingClarification("session-peek", "tenant-a"),
    "Which policy?"
  )
  assert.equal(store.peekPendingClarification("session-peek", "tenant-a"), null)
})

test("P1 regression: claimPendingClarification atomically returns a pending message once", () => {
  const db = openDb(":memory:")
  const store = new SqliteConversationStore(db)
  store.savePendingClarification("session-claim", "tenant-a", "Which policy?")

  assert.equal(
    store.claimPendingClarification("session-claim", "tenant-a"),
    "Which policy?"
  )
  assert.equal(
    store.claimPendingClarification("session-claim", "tenant-a"),
    null,
    "a concurrent claimant must not observe the same pending message"
  )
})
