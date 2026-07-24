/**
 * Ticket 11 Phase E P4 (spec §11 L1576-1577, L1581): RetirementService.
 *
 * Verifies the Source retirement flow:
 *
 * Step 1 (spec L1576): "Removes the Source from active visibility in the
 *   authoritative local repository" → lifecycleStore.transition(retired).
 *   retired is terminal (spec L1593: never reactivates a retired Source).
 *
 * Step 2 (spec L1578): Tombstone audit record — retains source identity,
 *   retired version IDs, reason, actor, timestamps. Append-only.
 *
 * Step 3 (spec L1576-1577): "Enqueues idempotent cleanup for Elasticsearch,
 *   Neo4j, PageIndex and image assets. Cleanup uses the existing retry,
 *   dead-letter, stale-claim recovery, cancellation and fencing semantics."
 *   → reuses TaskRepo.enqueue() with 4 cleanup ops per doc.
 *
 * Safety property (spec L1577): "External partial failure cannot make retired
 *   content queryable again." → Step 3 happens AFTER Step 1; even if cleanup
 *   enqueue fails, the Source is already hidden (lifecycle_state=retired).
 *
 * Idempotency (spec L1581): "POST /api/sources/:sourceId/retire ... is
 *   idempotent." → re-calling retire on an already-retired Source:
 *     - Does NOT create a new tombstone (audit integrity)
 *     - Does NOT re-enqueue tasks that already exist (any status)
 *     - May enqueue MISSING tasks (handles interrupted previous retire)
 *
 * Cross-tenant isolation (spec L1582):
 *   - retire is scoped by tenant_id. Cross-tenant or missing Source → null (404).
 */
import assert from "node:assert/strict"
import test from "node:test"
import { openDb, type DB } from "../ingestion/tracking/db"
import { TaskRepo } from "../ingestion/tracking/task_repo"
import {
  SqliteSourceLifecycleStore,
  type SourceLifecycleStore,
} from "./source_lifecycle_store"
import {
  RetirementServiceImpl,
  type RetirementResult,
} from "./retirement"

interface SetupSourceArgs {
  sourceId: string
  tenantId?: string
  lifecycleState?: "active" | "quarantined" | "retired"
  docIds?: string[]
  createdAt?: string
}

/**
 * Insert a Source row with the given lifecycle_state and (optionally) a set
 * of Document rows belonging to it. Each doc gets a unique activation_order
 * so tombstone ordering is deterministic.
 */
function setupSource(db: DB, args: SetupSourceArgs): void {
  const tenantId = args.tenantId ?? "default"
  const createdAt = args.createdAt ?? "2026-07-18T00:00:00.000Z"
  const state = args.lifecycleState ?? "active"
  db.prepare(
    `INSERT INTO sources (
      source_id, source_key, source_kind, source_uri, namespace,
      created_at, updated_at, tenant_id, lifecycle_state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    args.sourceId,
    `key-${args.sourceId}`,
    "file",
    `file:///tmp/${args.sourceId}.txt`,
    "local",
    createdAt,
    createdAt,
    tenantId,
    state
  )
  const docIds = args.docIds ?? []
  docIds.forEach((docId, idx) => {
    db.prepare(
      `INSERT INTO documents (
        doc_id, source_id, content_hash, version, activation_order,
        title, source, content, status, created_at, updated_at, tenant_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)`
    ).run(
      docId,
      args.sourceId,
      `hash-${docId}`,
      idx + 1,
      idx + 1,
      `Doc ${docId}`,
      `file:///tmp/${args.sourceId}.txt`,
      `content-${docId}`,
      createdAt,
      createdAt,
      tenantId
    )
  })
}

function countTasksForDoc(db: DB, docId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM task_pending_ops WHERE doc_id = ?`
  ).get(docId) as { n: number }
  return row.n
}

function countTasksForSource(db: DB, sourceId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM task_pending_ops t
     JOIN documents d ON t.doc_id = d.doc_id
     WHERE d.source_id = ?`
  ).get(sourceId) as { n: number }
  return row.n
}

function getTombstones(db: DB, sourceId: string, tenantId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM source_tombstones
     WHERE source_id = ? AND tenant_id = ?`
  ).get(sourceId, tenantId) as { n: number }
  return row.n
}

function makeService(
  db: DB,
  now: () => Date = () => new Date("2026-07-18T10:00:00.000Z")
): { service: RetirementServiceImpl; lifecycle: SourceLifecycleStore; tasks: TaskRepo } {
  const lifecycle = new SqliteSourceLifecycleStore(db, now)
  const tasks = new TaskRepo(db, now)
  const service = new RetirementServiceImpl(db, lifecycle, tasks, now)
  return { service, lifecycle, tasks }
}

// ─────────────────────────────────────────────────────────────────────────────
// 404 / cross-tenant
// ─────────────────────────────────────────────────────────────────────────────

test("P4 retire: returns null for non-existent source (404)", () => {
  const db = openDb(":memory:")
  try {
    const { service } = makeService(db)
    const result = service.retire("missing-src", "default", "reason", "actor")
    assert.equal(result, null)
  } finally {
    db.close()
  }
})

test("P4 retire: returns null for cross-tenant source (404)", () => {
  const db = openDb(":memory:")
  try {
    setupSource(db, { sourceId: "src-a", tenantId: "tenant-a", docIds: ["doc-a1"] })
    const { service } = makeService(db)
    // Source exists for tenant-a but we ask as tenant-b → null
    const result = service.retire("src-a", "tenant-b", "reason", "actor")
    assert.equal(result, null)
  } finally {
    db.close()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Happy path: active source → retired + tombstone + cleanup tasks
// ─────────────────────────────────────────────────────────────────────────────

test("P4 retire on active source: transitions to retired + creates tombstone + enqueues 4 cleanup tasks per doc", () => {
  const db = openDb(":memory:")
  try {
    setupSource(db, { sourceId: "src-1", tenantId: "default", docIds: ["doc-1"] })
    const { service, lifecycle } = makeService(db)
    const result = service.retire("src-1", "default", "stale content", "admin@example.com")
    assert.ok(result)
    assert.equal(result!.sourceId, "src-1")
    assert.equal(result!.tenantId, "default")
    assert.equal(result!.lifecycleState, "retired")
    assert.equal(result!.idempotent, false)
    assert.ok(result!.tombstoneId.length > 0)

    // Source lifecycle_state is now retired
    const src = lifecycle.getSource("src-1", "default")
    assert.ok(src)
    assert.equal(src!.lifecycleState, "retired")

    // One tombstone was created with retired_version_ids = ["doc-1"]
    assert.equal(getTombstones(db, "src-1", "default"), 1)
    const tombstone = lifecycle.getLatestTombstone("src-1", "default")
    assert.ok(tombstone)
    assert.deepEqual(tombstone!.retiredVersionIds, ["doc-1"])
    assert.equal(tombstone!.reason, "stale content")
    assert.equal(tombstone!.actor, "admin@example.com")

    // 4 cleanup tasks enqueued for doc-1
    assert.equal(countTasksForDoc(db, "doc-1"), 4)
  } finally {
    db.close()
  }
})

test("P4 retire on quarantined source: quarantined → retired is legal", () => {
  const db = openDb(":memory:")
  try {
    setupSource(db, {
      sourceId: "src-q",
      tenantId: "default",
      lifecycleState: "quarantined",
      docIds: ["doc-q1"],
    })
    const { service, lifecycle } = makeService(db)
    const result = service.retire("src-q", "default", "escalate", "admin@example.com")
    assert.ok(result)
    assert.equal(result!.lifecycleState, "retired")
    assert.equal(result!.idempotent, false)
    const src = lifecycle.getSource("src-q", "default")
    assert.equal(src!.lifecycleState, "retired")
  } finally {
    db.close()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Multi-doc: 4 cleanup tasks per doc
// ─────────────────────────────────────────────────────────────────────────────

test("P4 retire with multiple docs: enqueues 4*N tasks + tombstone records all doc_ids", () => {
  const db = openDb(":memory:")
  try {
    setupSource(db, {
      sourceId: "src-multi",
      tenantId: "default",
      docIds: ["doc-a", "doc-b", "doc-c"],
    })
    const { service, lifecycle } = makeService(db)
    const result = service.retire("src-multi", "default", "bulk retire", "admin")
    assert.ok(result)
    // 3 docs × 4 ops = 12 tasks
    assert.equal(result!.enqueuedCleanupTasks, 12)
    assert.equal(countTasksForSource(db, "src-multi"), 12)
    // Each doc has exactly 4 tasks
    assert.equal(countTasksForDoc(db, "doc-a"), 4)
    assert.equal(countTasksForDoc(db, "doc-b"), 4)
    assert.equal(countTasksForDoc(db, "doc-c"), 4)
    // Tombstone records all 3 doc_ids
    const tombstone = lifecycle.getLatestTombstone("src-multi", "default")
    assert.ok(tombstone)
    assert.deepEqual(tombstone!.retiredVersionIds, ["doc-a", "doc-b", "doc-c"])
  } finally {
    db.close()
  }
})

test("P4 retire with zero docs: enqueues zero tasks + tombstone with empty retired_version_ids", () => {
  const db = openDb(":memory:")
  try {
    setupSource(db, { sourceId: "src-empty", tenantId: "default", docIds: [] })
    const { service, lifecycle } = makeService(db)
    const result = service.retire("src-empty", "default", "no docs", "admin")
    assert.ok(result)
    assert.equal(result!.enqueuedCleanupTasks, 0)
    assert.equal(result!.idempotent, false)
    // Source is still retired (safety property: retire doesn't depend on docs)
    const src = lifecycle.getSource("src-empty", "default")
    assert.equal(src!.lifecycleState, "retired")
    // Tombstone exists with empty retired_version_ids
    const tombstone = lifecycle.getLatestTombstone("src-empty", "default")
    assert.ok(tombstone)
    assert.deepEqual(tombstone!.retiredVersionIds, [])
  } finally {
    db.close()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency: re-calling retire on already-retired source
// ─────────────────────────────────────────────────────────────────────────────

test("P4 retire on already-retired source: idempotent (no new tombstone, no duplicate tasks)", () => {
  const db = openDb(":memory:")
  try {
    setupSource(db, { sourceId: "src-idem", tenantId: "default", docIds: ["doc-idem"] })
    const { service } = makeService(db)
    // First retire: enqueues 4 tasks, creates 1 tombstone
    const r1 = service.retire("src-idem", "default", "first", "admin-a")
    assert.ok(r1)
    assert.equal(r1!.idempotent, false)
    assert.equal(r1!.enqueuedCleanupTasks, 4)
    // Second retire: idempotent — no new tombstone, no duplicate tasks
    const r2 = service.retire("src-idem", "default", "second", "admin-b")
    assert.ok(r2)
    assert.equal(r2!.idempotent, true)
    assert.equal(r2!.tombstoneId, "")  // no new tombstone
    assert.equal(r2!.enqueuedCleanupTasks, 0)  // all tasks already exist
    assert.equal(getTombstones(db, "src-idem", "default"), 1)
    assert.equal(countTasksForDoc(db, "doc-idem"), 4)
  } finally {
    db.close()
  }
})

test("P4 idempotent retire: enqueues MISSING tasks only (handles interrupted previous retire)", () => {
  const db = openDb(":memory:")
  try {
    setupSource(db, {
      sourceId: "src-partial",
      tenantId: "default",
      docIds: ["doc-1", "doc-2"],
    })
    // Simulate an interrupted previous retire: source already retired + tombstone
    // exists, but only doc-1's cleanup tasks were enqueued.
    db.exec(
      `UPDATE sources SET lifecycle_state = 'retired', updated_at = '2026-07-18T09:00:00.000Z'
       WHERE source_id = 'src-partial'`
    )
    db.exec(
      `INSERT INTO source_tombstones (
        tombstone_id, source_id, tenant_id, retired_version_ids,
        reason, actor, retired_at, created_at
      ) VALUES ('tb-prev', 'src-partial', 'default', '["doc-1","doc-2"]',
                'first', 'admin', '2026-07-18T09:00:00.000Z', '2026-07-18T09:00:00.000Z')`
    )
    // Only doc-1's tasks were enqueued (4 tasks)
    const tasks = new TaskRepo(db)
    tasks.enqueue({ docId: "doc-1", op: "cleanup_es", payload: {} })
    tasks.enqueue({ docId: "doc-1", op: "cleanup_neo4j", payload: {} })
    tasks.enqueue({ docId: "doc-1", op: "cleanup_pageindex", payload: {} })
    tasks.enqueue({ docId: "doc-1", op: "cleanup_images", payload: {} })

    const { service } = makeService(db)
    const result = service.retire("src-partial", "default", "retry", "admin")
    assert.ok(result)
    assert.equal(result!.idempotent, true)
    assert.equal(result!.tombstoneId, "")  // no new tombstone
    // Only doc-2's 4 tasks were missing — those should be enqueued now
    assert.equal(result!.enqueuedCleanupTasks, 4)
    assert.equal(countTasksForDoc(db, "doc-1"), 4)  // unchanged
    assert.equal(countTasksForDoc(db, "doc-2"), 4)  // newly enqueued
    // Still only 1 tombstone
    assert.equal(getTombstones(db, "src-partial", "default"), 1)
  } finally {
    db.close()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Tombstone content
// ─────────────────────────────────────────────────────────────────────────────

test("P4 tombstone: records reason and actor verbatim", () => {
  const db = openDb(":memory:")
  try {
    setupSource(db, { sourceId: "src-tb", tenantId: "default", docIds: ["doc-tb"] })
    const { service, lifecycle } = makeService(db)
    service.retire("src-tb", "default", "legal hold: case-12345", "compliance@example.com")
    const tombstone = lifecycle.getLatestTombstone("src-tb", "default")
    assert.ok(tombstone)
    assert.equal(tombstone!.reason, "legal hold: case-12345")
    assert.equal(tombstone!.actor, "compliance@example.com")
  } finally {
    db.close()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup op coverage: exactly the 4 ops spec L1576 mandates
// ─────────────────────────────────────────────────────────────────────────────

test("P4 cleanup ops: enqueues exactly cleanup_es, cleanup_neo4j, cleanup_pageindex, cleanup_images per doc", () => {
  const db = openDb(":memory:")
  try {
    setupSource(db, { sourceId: "src-ops", tenantId: "default", docIds: ["doc-ops"] })
    const { service } = makeService(db)
    service.retire("src-ops", "default", "test", "admin")
    const rows = db.prepare(
      `SELECT op FROM task_pending_ops WHERE doc_id = ? ORDER BY op`
    ).all("doc-ops") as { op: string }[]
    const ops = rows.map(r => r.op)
    assert.deepEqual(ops, ["cleanup_es", "cleanup_images", "cleanup_neo4j", "cleanup_pageindex"])
  } finally {
    db.close()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Safety property: retired state persists across idempotent re-calls
// ─────────────────────────────────────────────────────────────────────────────

test("P4 safety property: retired state persists across idempotent re-calls (no reactivation)", () => {
  const db = openDb(":memory:")
  try {
    setupSource(db, { sourceId: "src-safety", tenantId: "default", docIds: ["doc-s"] })
    const { service, lifecycle } = makeService(db)
    service.retire("src-safety", "default", "first", "admin")
    // Re-call multiple times — state must remain retired (spec L1593)
    for (let i = 0; i < 3; i++) {
      const r = service.retire("src-safety", "default", `retry-${i}`, "admin")
      assert.ok(r)
      assert.equal(r!.idempotent, true)
      const src = lifecycle.getSource("src-safety", "default")
      assert.equal(src!.lifecycleState, "retired")
    }
    // Still only 1 tombstone (first one — reason="first")
    const tombstone = lifecycle.getLatestTombstone("src-safety", "default")
    assert.ok(tombstone)
    assert.equal(tombstone!.reason, "first")
  } finally {
    db.close()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Result shape
// ─────────────────────────────────────────────────────────────────────────────

test("P4 RetirementResult shape: first call returns idempotent=false + tombstoneId", () => {
  const db = openDb(":memory:")
  try {
    setupSource(db, { sourceId: "src-shape", tenantId: "default", docIds: ["doc-shape"] })
    const { service } = makeService(db)
    const r: RetirementResult = service.retire("src-shape", "default", "r", "a")!
    assert.equal(r.sourceId, "src-shape")
    assert.equal(r.tenantId, "default")
    assert.equal(r.lifecycleState, "retired")
    assert.equal(typeof r.tombstoneId, "string")
    assert.ok(r.tombstoneId.length > 0)
    assert.equal(r.enqueuedCleanupTasks, 4)
    assert.equal(r.idempotent, false)
  } finally {
    db.close()
  }
})
