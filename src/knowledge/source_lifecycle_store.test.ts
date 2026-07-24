/**
 * Ticket 11 Phase E P2 (spec §11 L1571-1578, L1593): SourceLifecycleStore
 *
 * Verifies the Source lifecycle state machine and tombstone CRUD:
 *
 * State machine (spec L1573, L1593):
 *   Legal transitions:
 *     active → quarantined     (start investigation)
 *     active → retired          (direct retirement)
 *     quarantined → active      (manual un-quarantine after investigation)
 *     quarantined → retired     (escalate from quarantine to retirement)
 *   Terminal:
 *     retired → * (forbidden — never reactivate a retired Source, L1593)
 *   Strict (same-state is NOT a no-op):
 *     active → active throws (use HTTP-layer idempotency check instead)
 *
 * Tombstones (spec L1578):
 *   - Append-only — createTombstone inserts a new row each time
 *   - getLatestTombstone returns the most recent by retired_at DESC
 *   - Cross-tenant isolation: tombstones are scoped by tenant_id
 */
import assert from "node:assert/strict"
import test from "node:test"
import { openDb, type DB } from "../ingestion/tracking/db"
import {
  InvalidSourceLifecycleTransitionError,
  SqliteSourceLifecycleStore,
  type SourceLifecycleEntry,
} from "./source_lifecycle_store"

function setupSource(
  db: DB,
  args: {
    sourceId: string
    sourceKey?: string
    tenantId?: string
    lifecycleState?: "active" | "quarantined" | "retired"
    createdAt?: string
    updatedAt?: string
  }
): void {
  const tenantId = args.tenantId ?? "default"
  const now = args.updatedAt ?? "2026-07-18T00:00:00.000Z"
  const created = args.createdAt ?? now
  // INSERT directly into sources — bypasses the ingestion flow which is out
  // of scope for P2 (lifecycle state machine only). Uses lifecycle_state
  // default if not specified.
  if (args.lifecycleState) {
    db.prepare(
      `INSERT INTO sources (
        source_id, source_key, source_kind, source_uri, namespace,
        created_at, updated_at, tenant_id, lifecycle_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      args.sourceId,
      args.sourceKey ?? `key-${args.sourceId}`,
      "file",
      `file:///tmp/${args.sourceId}.txt`,
      "local",
      created,
      now,
      tenantId,
      args.lifecycleState
    )
  } else {
    db.prepare(
      `INSERT INTO sources (
        source_id, source_key, source_kind, source_uri, namespace,
        created_at, updated_at, tenant_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      args.sourceId,
      args.sourceKey ?? `key-${args.sourceId}`,
      "file",
      `file:///tmp/${args.sourceId}.txt`,
      "local",
      created,
      now,
      tenantId
    )
  }
}

test("P2 getSource: returns null for non-existent source", () => {
  const db = openDb(":memory:")
  try {
    const store = new SqliteSourceLifecycleStore(db)
    assert.equal(store.getSource("missing-src", "default"), null)
  } finally {
    db.close()
  }
})

test("P2 getSource: returns null for cross-tenant source (no information leak)", () => {
  const db = openDb(":memory:")
  try {
    setupSource(db, { sourceId: "src-a", tenantId: "tenant-a" })
    const store = new SqliteSourceLifecycleStore(db)
    // Source exists for tenant-a, but we ask as tenant-b → null
    assert.equal(store.getSource("src-a", "tenant-b"), null)
  } finally {
    db.close()
  }
})

test("P2 getSource: returns entry with lifecycle_state='active' for new source", () => {
  const db = openDb(":memory:")
  try {
    setupSource(db, { sourceId: "src-1", tenantId: "default" })
    const store = new SqliteSourceLifecycleStore(db)
    const entry = store.getSource("src-1", "default")
    assert.ok(entry)
    assert.equal(entry!.sourceId, "src-1")
    assert.equal(entry!.tenantId, "default")
    assert.equal(entry!.lifecycleState, "active")
  } finally {
    db.close()
  }
})

test("P2 transition: active → quarantined succeeds", () => {
  const db = openDb(":memory:")
  try {
    setupSource(db, { sourceId: "src-2", tenantId: "default" })
    const store = new SqliteSourceLifecycleStore(db, () => new Date("2026-07-18T10:00:00.000Z"))
    const entry = store.transition("src-2", "default", "quarantined")
    assert.ok(entry)
    assert.equal(entry!.lifecycleState, "quarantined")
    assert.equal(entry!.updatedAt, "2026-07-18T10:00:00.000Z")
    // Verify persistence
    const reloaded = store.getSource("src-2", "default")
    assert.equal(reloaded!.lifecycleState, "quarantined")
  } finally {
    db.close()
  }
})

test("P2 transition: active → retired succeeds", () => {
  const db = openDb(":memory:")
  try {
    setupSource(db, { sourceId: "src-3", tenantId: "default" })
    const store = new SqliteSourceLifecycleStore(db)
    const entry = store.transition("src-3", "default", "retired")
    assert.ok(entry)
    assert.equal(entry!.lifecycleState, "retired")
  } finally {
    db.close()
  }
})

test("P2 transition: quarantined → active succeeds (manual un-quarantine)", () => {
  const db = openDb(":memory:")
  try {
    setupSource(db, { sourceId: "src-4", tenantId: "default", lifecycleState: "quarantined" })
    const store = new SqliteSourceLifecycleStore(db)
    const entry = store.transition("src-4", "default", "active")
    assert.ok(entry)
    assert.equal(entry!.lifecycleState, "active")
  } finally {
    db.close()
  }
})

test("P2 transition: quarantined → retired succeeds (escalation)", () => {
  const db = openDb(":memory:")
  try {
    setupSource(db, { sourceId: "src-5", tenantId: "default", lifecycleState: "quarantined" })
    const store = new SqliteSourceLifecycleStore(db)
    const entry = store.transition("src-5", "default", "retired")
    assert.ok(entry)
    assert.equal(entry!.lifecycleState, "retired")
  } finally {
    db.close()
  }
})

test("P2 transition: retired → active throws InvalidSourceLifecycleTransitionError (L1593 non-reactivation)", () => {
  const db = openDb(":memory:")
  try {
    setupSource(db, { sourceId: "src-6", tenantId: "default", lifecycleState: "retired" })
    const store = new SqliteSourceLifecycleStore(db)
    assert.throws(
      () => store.transition("src-6", "default", "active"),
      (err: unknown) => {
        assert.ok(err instanceof InvalidSourceLifecycleTransitionError)
        assert.equal(err.fromState, "retired")
        assert.equal(err.toState, "active")
        return true
      }
    )
  } finally {
    db.close()
  }
})

test("P2 transition: retired → quarantined throws (retired is terminal)", () => {
  const db = openDb(":memory:")
  try {
    setupSource(db, { sourceId: "src-7", tenantId: "default", lifecycleState: "retired" })
    const store = new SqliteSourceLifecycleStore(db)
    assert.throws(
      () => store.transition("src-7", "default", "quarantined"),
      InvalidSourceLifecycleTransitionError
    )
  } finally {
    db.close()
  }
})

test("P2 transition: same-state transition throws (strict — HTTP layer handles idempotency)", () => {
  const db = openDb(":memory:")
  try {
    setupSource(db, { sourceId: "src-8", tenantId: "default", lifecycleState: "active" })
    const store = new SqliteSourceLifecycleStore(db)
    // active → active is NOT a no-op at the store level — the HTTP layer
    // must check current state first to implement POST /retire idempotency.
    assert.throws(
      () => store.transition("src-8", "default", "active"),
      InvalidSourceLifecycleTransitionError
    )
  } finally {
    db.close()
  }
})

test("P2 transition: returns null for non-existent source (404 semantics)", () => {
  const db = openDb(":memory:")
  try {
    const store = new SqliteSourceLifecycleStore(db)
    assert.equal(store.transition("missing-src", "default", "retired"), null)
  } finally {
    db.close()
  }
})

test("P2 transition: returns null for cross-tenant source (404, no leak)", () => {
  const db = openDb(":memory:")
  try {
    setupSource(db, { sourceId: "src-9", tenantId: "tenant-a" })
    const store = new SqliteSourceLifecycleStore(db)
    // Source exists for tenant-a but we ask as tenant-b → null (not 409)
    assert.equal(store.transition("src-9", "tenant-b", "retired"), null)
  } finally {
    db.close()
  }
})

test("P2 createTombstone: inserts row and returns SourceTombstone", () => {
  const db = openDb(":memory:")
  try {
    setupSource(db, { sourceId: "src-tomb-1", tenantId: "default" })
    const store = new SqliteSourceLifecycleStore(db, () => new Date("2026-07-18T10:00:00.000Z"))
    const tombstone = store.createTombstone({
      sourceId: "src-tomb-1",
      tenantId: "default",
      retiredVersionIds: ["doc-v1", "doc-v2"],
      reason: "stale content",
      actor: "reviewer@example.com",
    })
    assert.ok(tombstone.tombstoneId)
    assert.equal(tombstone.sourceId, "src-tomb-1")
    assert.equal(tombstone.tenantId, "default")
    assert.deepEqual(tombstone.retiredVersionIds, ["doc-v1", "doc-v2"])
    assert.equal(tombstone.reason, "stale content")
    assert.equal(tombstone.actor, "reviewer@example.com")
    assert.equal(tombstone.retiredAt, "2026-07-18T10:00:00.000Z")
    assert.equal(tombstone.createdAt, "2026-07-18T10:00:00.000Z")
  } finally {
    db.close()
  }
})

test("P2 getLatestTombstone: returns null when no tombstone exists", () => {
  const db = openDb(":memory:")
  try {
    setupSource(db, { sourceId: "src-no-tomb", tenantId: "default" })
    const store = new SqliteSourceLifecycleStore(db)
    assert.equal(store.getLatestTombstone("src-no-tomb", "default"), null)
  } finally {
    db.close()
  }
})

test("P2 getLatestTombstone: returns null for cross-tenant source", () => {
  const db = openDb(":memory:")
  try {
    setupSource(db, { sourceId: "src-cross-tomb", tenantId: "tenant-a" })
    const store = new SqliteSourceLifecycleStore(db)
    // Create a tombstone as tenant-a
    store.createTombstone({
      sourceId: "src-cross-tomb",
      tenantId: "tenant-a",
      retiredVersionIds: [],
      reason: "test",
      actor: "a@example.com",
    })
    // Asking as tenant-b → null (no leak)
    assert.equal(store.getLatestTombstone("src-cross-tomb", "tenant-b"), null)
  } finally {
    db.close()
  }
})

test("P2 getLatestTombstone: returns most recent tombstone when multiple exist for same source", () => {
  const db = openDb(":memory:")
  try {
    setupSource(db, { sourceId: "src-multi-tomb", tenantId: "default" })
    let currentTime = new Date("2026-07-18T10:00:00.000Z")
    const store = new SqliteSourceLifecycleStore(db, () => currentTime)
    // First tombstone at T=10:00
    store.createTombstone({
      sourceId: "src-multi-tomb",
      tenantId: "default",
      retiredVersionIds: ["v1"],
      reason: "first retirement",
      actor: "a@example.com",
    })
    // Second tombstone at T=11:00 (should be the latest)
    currentTime = new Date("2026-07-18T11:00:00.000Z")
    store.createTombstone({
      sourceId: "src-multi-tomb",
      tenantId: "default",
      retiredVersionIds: ["v2"],
      reason: "second retirement",
      actor: "b@example.com",
    })
    // Third tombstone at T=09:00 the next day
    currentTime = new Date("2026-07-19T09:00:00.000Z")
    store.createTombstone({
      sourceId: "src-multi-tomb",
      tenantId: "default",
      retiredVersionIds: ["v3"],
      reason: "third retirement",
      actor: "c@example.com",
    })
    const latest = store.getLatestTombstone("src-multi-tomb", "default")
    assert.ok(latest)
    assert.equal(latest!.reason, "third retirement")
    assert.equal(latest!.actor, "c@example.com")
    assert.equal(latest!.retiredAt, "2026-07-19T09:00:00.000Z")
    assert.deepEqual(latest!.retiredVersionIds, ["v3"])
  } finally {
    db.close()
  }
})

test("P2 transition: updatedAt is refreshed on every successful transition", () => {
  const db = openDb(":memory:")
  try {
    setupSource(db, { sourceId: "src-time", tenantId: "default", updatedAt: "2026-07-01T00:00:00.000Z" })
    const store = new SqliteSourceLifecycleStore(db, () => new Date("2026-07-18T12:34:56.000Z"))
    const entry = store.transition("src-time", "default", "quarantined")
    assert.ok(entry)
    assert.equal(entry!.updatedAt, "2026-07-18T12:34:56.000Z")
    // Verify DB row also has the new updated_at
    const row = db.prepare(
      "SELECT updated_at FROM sources WHERE source_id = ?"
    ).get("src-time") as { updated_at: string }
    assert.equal(row.updated_at, "2026-07-18T12:34:56.000Z")
  } finally {
    db.close()
  }
})

test("P2 SourceLifecycleEntry: returned entry shape matches interface", () => {
  const db = openDb(":memory:")
  try {
    setupSource(db, { sourceId: "src-shape", tenantId: "default" })
    const store = new SqliteSourceLifecycleStore(db, () => new Date("2026-07-18T00:00:00.000Z"))
    const entry: SourceLifecycleEntry | null = store.getSource("src-shape", "default")
    assert.ok(entry)
    // Type-narrowing smoke test — if the shape is wrong, tsc fails
    const _staticCheck: SourceLifecycleEntry = {
      sourceId: entry!.sourceId,
      tenantId: entry!.tenantId,
      lifecycleState: entry!.lifecycleState,
      updatedAt: entry!.updatedAt,
    }
    assert.deepEqual(entry, _staticCheck)
  } finally {
    db.close()
  }
})
