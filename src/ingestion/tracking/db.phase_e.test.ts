/**
 * Ticket 11 Phase E P1 (spec §11 L1571-1583): Source governance schema
 * migration tests.
 *
 * Verifies that openDb applies the additive Phase E migrations:
 *   - sources.lifecycle_state TEXT NOT NULL DEFAULT 'active'
 *   - documents.candidate_state TEXT NOT NULL DEFAULT 'approved'
 *   - documents.reviewed_by / reviewed_at / review_reason TEXT (nullable)
 *   - source_tombstones table exists with required columns
 *
 * Also verifies:
 *   - Legacy DBs (pre-Phase E) can be opened and migration adds columns
 *     without losing existing rows.
 *   - Migration is idempotent — re-opening an already-migrated DB does not
 *     error and preserves column defaults.
 *   - source_tombstones INSERT/SELECT round-trip preserves all fields,
 *     including JSON-array retired_version_ids.
 */
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import Database from "better-sqlite3"
import { openDb } from "./db"

const CLEANUP_OPS = new Set([
  "cleanup_es",
  "cleanup_neo4j",
  "cleanup_pageindex",
  "cleanup_images",
])

function columnNames(db: Database.Database, table: string): string[] {
  const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }>
  return rows.map((r) => r.name)
}

test("Phase E P1: openDb(:memory:) adds sources.lifecycle_state column with default 'active'", () => {
  const db = openDb(":memory:")
  try {
    const cols = columnNames(db, "sources")
    assert.ok(
      cols.includes("lifecycle_state"),
      `sources should have lifecycle_state column; got ${cols.join(", ")}`
    )
    // Insert a sources row without specifying lifecycle_state → default applies
    db.prepare(
      `INSERT INTO sources (
        source_id, source_key, source_kind, source_uri, namespace,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "src-test-1",
      "test-key-1",
      "file",
      "file:///tmp/test.txt",
      "local",
      "2026-07-18T00:00:00.000Z",
      "2026-07-18T00:00:00.000Z"
    )
    const row = db.prepare(
      "SELECT lifecycle_state FROM sources WHERE source_id = ?"
    ).get("src-test-1") as { lifecycle_state: string }
    assert.equal(row.lifecycle_state, "active")
  } finally {
    db.close()
  }
})

test("Phase E P1: openDb(:memory:) adds documents.candidate_state column with default 'approved'", () => {
  const db = openDb(":memory:")
  try {
    const cols = columnNames(db, "documents")
    assert.ok(
      cols.includes("candidate_state"),
      `documents should have candidate_state column; got ${cols.join(", ")}`
    )
    assert.ok(
      cols.includes("reviewed_by"),
      `documents should have reviewed_by column; got ${cols.join(", ")}`
    )
    assert.ok(
      cols.includes("reviewed_at"),
      `documents should have reviewed_at column; got ${cols.join(", ")}`
    )
    assert.ok(
      cols.includes("review_reason"),
      `documents should have review_reason column; got ${cols.join(", ")}`
    )
    // Insert a sources row + a documents row without specifying candidate_state
    db.prepare(
      `INSERT INTO sources (
        source_id, source_key, source_kind, source_uri, namespace,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "src-test-2",
      "test-key-2",
      "file",
      "file:///tmp/test2.txt",
      "local",
      "2026-07-18T00:00:00.000Z",
      "2026-07-18T00:00:00.000Z"
    )
    db.prepare(
      `INSERT INTO documents (
        doc_id, source_id, content_hash, version, activation_order,
        title, source, content, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "doc-test-2",
      "src-test-2",
      "hash-2",
      1,
      1,
      "Test Doc",
      "file:///tmp/test2.txt",
      "test content",
      "completed",
      "2026-07-18T00:00:00.000Z",
      "2026-07-18T00:00:00.000Z"
    )
    const row = db.prepare(
      "SELECT candidate_state, reviewed_by, reviewed_at, review_reason FROM documents WHERE doc_id = ?"
    ).get("doc-test-2") as {
      candidate_state: string
      reviewed_by: string | null
      reviewed_at: string | null
      review_reason: string | null
    }
    assert.equal(row.candidate_state, "approved")
    assert.equal(row.reviewed_by, null)
    assert.equal(row.reviewed_at, null)
    assert.equal(row.review_reason, null)
  } finally {
    db.close()
  }
})

test("Phase E P1: openDb(:memory:) creates source_tombstones table with required columns", () => {
  const db = openDb(":memory:")
  try {
    const cols = columnNames(db, "source_tombstones")
    const expected = [
      "tombstone_id",
      "source_id",
      "tenant_id",
      "retired_version_ids",
      "reason",
      "actor",
      "retired_at",
      "created_at",
    ]
    for (const col of expected) {
      assert.ok(
        cols.includes(col),
        `source_tombstones should have ${col} column; got ${cols.join(", ")}`
      )
    }
  } finally {
    db.close()
  }
})

test("Phase E P1: source_tombstones INSERT/SELECT round-trip preserves all fields", () => {
  const db = openDb(":memory:")
  try {
    // Pre-create a sources row so source_id exists (no FK constraint, but
    // for realism)
    db.prepare(
      `INSERT INTO sources (
        source_id, source_key, source_kind, source_uri, namespace,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "src-tomb-1",
      "tomb-key-1",
      "file",
      "file:///tmp/tomb.txt",
      "local",
      "2026-07-18T00:00:00.000Z",
      "2026-07-18T00:00:00.000Z"
    )
    const tombstoneId = "tomb-uuid-1"
    const retiredVersionIds = ["doc-v1", "doc-v2", "doc-v3"]
    db.prepare(
      `INSERT INTO source_tombstones (
        tombstone_id, source_id, tenant_id, retired_version_ids,
        reason, actor, retired_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      tombstoneId,
      "src-tomb-1",
      "default",
      JSON.stringify(retiredVersionIds),
      "stale content",
      "reviewer@example.com",
      "2026-07-18T10:00:00.000Z",
      "2026-07-18T10:00:00.000Z"
    )
    const row = db.prepare(
      `SELECT tombstone_id, source_id, tenant_id, retired_version_ids,
              reason, actor, retired_at, created_at
       FROM source_tombstones WHERE tombstone_id = ?`
    ).get(tombstoneId) as {
      tombstone_id: string
      source_id: string
      tenant_id: string
      retired_version_ids: string
      reason: string
      actor: string
      retired_at: string
      created_at: string
    }
    assert.equal(row.tombstone_id, tombstoneId)
    assert.equal(row.source_id, "src-tomb-1")
    assert.equal(row.tenant_id, "default")
    assert.deepEqual(JSON.parse(row.retired_version_ids), retiredVersionIds)
    assert.equal(row.reason, "stale content")
    assert.equal(row.actor, "reviewer@example.com")
    assert.equal(row.retired_at, "2026-07-18T10:00:00.000Z")
    assert.equal(row.created_at, "2026-07-18T10:00:00.000Z")
  } finally {
    db.close()
  }
})

test("Phase E P1: migration is idempotent — re-opening an already-migrated DB does not error", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "kefu-rag-phase-e-idempotent-"))
  const dbPath = join(tempDir, "idempotent.db")
  try {
    // First open — applies migrations
    const db1 = openDb(dbPath)
    db1.close()
    // Second open — should not error, columns should still exist
    const db2 = openDb(dbPath)
    try {
      const sourcesCols = columnNames(db2, "sources")
      assert.ok(sourcesCols.includes("lifecycle_state"))
      const docsCols = columnNames(db2, "documents")
      assert.ok(docsCols.includes("candidate_state"))
      assert.ok(docsCols.includes("reviewed_by"))
      const tombCols = columnNames(db2, "source_tombstones")
      assert.ok(tombCols.includes("tombstone_id"))
    } finally {
      db2.close()
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test("Phase E P1: legacy DB (pre-Phase E schema) can be opened and migration adds columns without losing rows", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "kefu-rag-phase-e-legacy-"))
  const dbPath = join(tempDir, "legacy.db")
  try {
    // Create a pre-Phase E schema (no lifecycle_state, no candidate_state,
    // no source_tombstones table)
    const legacy = new Database(dbPath)
    legacy.exec(`
      CREATE TABLE sources (
        source_id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL UNIQUE,
        source_kind TEXT NOT NULL,
        source_uri TEXT NOT NULL,
        namespace TEXT NOT NULL,
        canonical_source_id TEXT,
        active_doc_id TEXT,
        last_doc_id TEXT,
        last_outcome TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        allowed_groups TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE documents (
        doc_id TEXT PRIMARY KEY,
        source_id TEXT,
        content_hash TEXT,
        version INTEGER,
        activation_order INTEGER,
        title TEXT NOT NULL,
        source TEXT NOT NULL,
        content TEXT NOT NULL,
        raw_content BLOB,
        file_name TEXT,
        mime_type TEXT,
        parser_override TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        allowed_groups TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE task_pending_ops (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id TEXT NOT NULL,
        op TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        fail_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        claimed_at TEXT,
        next_attempt_at TEXT,
        enqueued_at TEXT NOT NULL
      );
      CREATE TABLE task_dead_letters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL UNIQUE,
        doc_id TEXT NOT NULL,
        op TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        fail_count INTEGER NOT NULL,
        error_message TEXT NOT NULL,
        error_stack TEXT,
        failed_at TEXT NOT NULL
      );
      CREATE TABLE processing_spans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id TEXT NOT NULL,
        span_id TEXT NOT NULL UNIQUE,
        parent_span_id TEXT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        input TEXT,
        output TEXT,
        error_message TEXT,
        error_stack TEXT,
        started_at TEXT,
        finished_at TEXT,
        duration_ms INTEGER
      );
      CREATE TABLE answer_run_events (
        run_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, event_id),
        UNIQUE (run_id, sequence)
      );
      CREATE TABLE page_index_nodes (
        document_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        title TEXT NOT NULL,
        section_path TEXT NOT NULL,
        page_start INTEGER,
        page_end INTEGER,
        summary TEXT NOT NULL,
        parent_id TEXT,
        child_ids TEXT NOT NULL DEFAULT '[]',
        linked_chunk_ids TEXT NOT NULL DEFAULT '[]',
        tenant_id TEXT NOT NULL DEFAULT 'default',
        allowed_groups TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (document_id, node_id)
      );
      CREATE TABLE clarification_pending (
        session_id TEXT PRIMARY KEY,
        original_message TEXT NOT NULL,
        missing_fields_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE TABLE session_bindings (
        session_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE conversation_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        run_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'validated'
      );
    `)
    // Insert legacy rows that must be preserved across migration
    legacy.prepare(
      `INSERT INTO sources (
        source_id, source_key, source_kind, source_uri, namespace,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "legacy-src-1",
      "legacy-key-1",
      "file",
      "file:///tmp/legacy.txt",
      "local",
      "2026-07-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z"
    )
    legacy.prepare(
      `INSERT INTO documents (
        doc_id, source_id, content_hash, version, activation_order,
        title, source, content, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "legacy-doc-1",
      "legacy-src-1",
      "legacy-hash",
      1,
      1,
      "Legacy Doc",
      "file:///tmp/legacy.txt",
      "legacy content",
      "completed",
      "2026-07-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z"
    )
    legacy.close()

    // Now openDb should migrate — add lifecycle_state / candidate_state /
    // reviewed_* / source_tombstones — without losing the legacy rows
    const db = openDb(dbPath)
    try {
      // Legacy source preserved + lifecycle_state default applied
      const src = db.prepare(
        "SELECT lifecycle_state FROM sources WHERE source_id = ?"
      ).get("legacy-src-1") as { lifecycle_state: string }
      assert.equal(src.lifecycle_state, "active")

      // Legacy document preserved + candidate_state default applied
      const doc = db.prepare(
        "SELECT candidate_state, reviewed_by FROM documents WHERE doc_id = ?"
      ).get("legacy-doc-1") as {
        candidate_state: string
        reviewed_by: string | null
      }
      assert.equal(doc.candidate_state, "approved")
      assert.equal(doc.reviewed_by, null)

      // source_tombstones table now exists
      const tombCols = columnNames(db, "source_tombstones")
      assert.ok(tombCols.includes("tombstone_id"))
    } finally {
      db.close()
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test("Phase E P1: cleanup op values are reserved for task_pending_ops (Phase E P4 contract)", () => {
  // Sanity check — Phase E P4 will enqueue cleanup tasks using these op
  // values. P1 only verifies the task_pending_ops table accepts them (no
  // CHECK constraint on op). This test documents the contract so a future
  // schema change doesn't silently break Phase E cleanup enqueue.
  const db = openDb(":memory:")
  try {
    for (const op of CLEANUP_OPS) {
      const result = db.prepare(
        `INSERT INTO task_pending_ops (doc_id, op, payload, enqueued_at)
         VALUES (?, ?, ?, ?)`
      ).run("doc-cleanup-test", op, "{}", "2026-07-18T00:00:00.000Z")
      assert.ok(result.changes > 0, `INSERT for op=${op} should succeed`)
    }
    const rows = db.prepare(
      `SELECT op FROM task_pending_ops WHERE doc_id = ? ORDER BY id`
    ).all("doc-cleanup-test") as Array<{ op: string }>
    assert.equal(rows.length, CLEANUP_OPS.size)
    const ops = new Set(rows.map((r) => r.op))
    for (const expected of CLEANUP_OPS) {
      assert.ok(ops.has(expected), `cleanup op ${expected} should be present`)
    }
  } finally {
    db.close()
  }
})
