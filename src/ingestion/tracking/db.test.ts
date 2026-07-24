import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, sep } from "node:path"
import test from "node:test"
import Database from "better-sqlite3"
import { openDb } from "./db"
import { SpanRepo } from "./span_repo"
import { TaskRepo } from "./task_repo"
import {
  resolveSourceIdentity,
  resolveStoredSourceIdentity,
  sourceIdentityKey,
} from "../source_identity"
import { IngestionLifecycle } from "../lifecycle"

test("dead-lettering the same exhausted task is idempotent", () => {
  const db = openDb(":memory:")
  const now = new Date("2026-07-15T00:00:00.000Z")
  const repo = new TaskRepo(db, () => now)

  try {
    const taskId = repo.enqueue({ docId: "doc-1", op: "ingest", payload: {} })
    let task = repo.claimNext()!
    for (let failure = 0; failure < 3; failure += 1) {
      assert.equal(
        repo.recordFailure(task.id, now.toISOString(), task.claimedAt),
        true
      )
      task = repo.claimNext()!
    }
    assert.equal(task.failCount, 3)

    assert.equal(repo.deadLetter(task, "failed", "stack", now.toISOString()), true)
    assert.equal(repo.deadLetter(task, "failed", "stack", now.toISOString()), true)
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM task_dead_letters WHERE task_id = ?")
        .get(taskId) as { count: number }).count,
      1
    )
    assert.equal(repo.getDeadLetter(taskId)?.failCount, 4)
  } finally {
    db.close()
  }
})

test("opening a legacy database adds tracking and version columns without losing rows", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "kefu-rag-schema-"))
  const dbPath = join(tempDir, "legacy.db")
  const legacy = new Database(dbPath)

  legacy.exec(`
    CREATE TABLE documents (
      doc_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE task_pending_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id TEXT NOT NULL,
      op TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      fail_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      claimed_at TEXT,
      enqueued_at TEXT NOT NULL
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
      started_at TEXT,
      finished_at TEXT,
      duration_ms INTEGER
    );
    INSERT INTO task_pending_ops
      (doc_id, op, payload, status, enqueued_at)
      VALUES ('legacy-doc', 'ingest', '{}', 'pending', '2026-07-15T00:00:00.000Z');
    INSERT INTO documents
      (doc_id, title, source, content, status, created_at, updated_at)
      VALUES (
        'legacy-doc',
        'Legacy policy',
        'legacy-source',
        'legacy content',
        'completed',
        '2026-07-15T00:00:00.000Z',
        '2026-07-15T00:00:00.000Z'
      );
    INSERT INTO documents
      (doc_id, title, source, content, status, created_at, updated_at)
      VALUES (
        'legacy-replacement',
        'Legacy policy replacement',
        'legacy-source',
        'failed replacement',
        'failed',
        '2026-07-15T01:00:00.000Z',
        '2026-07-15T01:00:00.000Z'
      );
    INSERT INTO processing_spans
      (doc_id, span_id, name, kind, status)
      VALUES ('legacy-doc', 'legacy-span', 'ingest', 'root', 'running');
  `)
  legacy.close()

  let db = openDb(dbPath)
  try {
    assert.equal(new TaskRepo(db).getByDocId("legacy-doc")?.nextAttemptAt, null)
    assert.equal(new SpanRepo(db).listByDoc("legacy-doc")[0].spanId, "legacy-span")
    const upgraded = db.prepare(
      `SELECT d.content_hash, d.version, s.active_doc_id
       FROM documents d
       JOIN sources s ON s.source_id = d.source_id
       WHERE d.doc_id = 'legacy-doc'`
    ).get() as { content_hash: string; version: number; active_doc_id: string }
    assert.equal(
      upgraded.content_hash,
      "5842e8c261c6f246f2e1819da7ff4a214ba86853f4a7a42f26d7eddd48d2b98d"
    )
    assert.equal(upgraded.version, 1)
    assert.equal(upgraded.active_doc_id, "legacy-doc")
    assert.equal(
      (db.prepare("SELECT version FROM documents WHERE doc_id = 'legacy-replacement'")
        .get() as { version: number }).version,
      2
    )
    db.close()
    db = openDb(dbPath)
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM sources").get() as { count: number }).count,
      1
    )
    assert.equal(
      (db.prepare("SELECT version FROM documents WHERE doc_id = 'legacy-doc'")
        .get() as { version: number }).version,
      1
    )
    assert.equal(
      (db.pragma("table_info(processing_spans)") as Array<{ name: string }>)
        .some(({ name }) => name === "error_stack"),
      true
    )
  } finally {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test("a legacy CLI file source upgrades to the canonical file identity", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "kefu-rag-file-upgrade-"))
  const filePath = join(tempDir, "policy.txt")
  const dbPath = join(tempDir, "legacy.db")
  writeFileSync(filePath, "legacy file content", "utf8")
  const legacy = new Database(dbPath)
  legacy.exec(`
    CREATE TABLE documents (
      doc_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  legacy.prepare(
    `INSERT INTO documents
      (doc_id, title, source, content, status, created_at, updated_at)
     VALUES ('legacy-file', 'Policy', ?, 'legacy file content', 'completed', ?, ?)`
  ).run(filePath, "2026-07-15T00:00:00.000Z", "2026-07-15T00:00:00.000Z")
  legacy.close()
  rmSync(filePath)

  const db = openDb(dbPath)
  try {
    const expectedIdentity = resolveSourceIdentity(
      { kind: "file", uriOrExternalId: filePath, namespace: "local" },
      undefined,
      "unused"
    )
    const source = db.prepare(
      `SELECT source_key, source_kind, source_uri, namespace
       FROM sources WHERE active_doc_id = 'legacy-file'`
    ).get() as {
      source_key: string
      source_kind: string
      source_uri: string
      namespace: string
    }
    assert.deepEqual(source, {
      source_key: sourceIdentityKey(expectedIdentity),
      source_kind: "file",
      source_uri: expectedIdentity.uri,
      namespace: "local",
    })
    assert.equal(resolveStoredSourceIdentity("src", "external-id").kind, "legacy")
    assert.equal(
      resolveStoredSourceIdentity("https://internal policy", "invalid-url").kind,
      "legacy"
    )
  } finally {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test("a canonical CLI submission consolidates aliases before an in-flight version", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "kefu-rag-relative-upgrade-"))
  const filePath = join(tempDir, "policy.txt")
  const legacySource = relative(process.cwd(), filePath)
  const dbPath = join(tempDir, "legacy.db")
  writeFileSync(filePath, "legacy file content", "utf8")
  const legacy = new Database(dbPath)
  legacy.exec(`
    CREATE TABLE documents (
      doc_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  const insertLegacyDocument = legacy.prepare(
    `INSERT INTO documents
      (doc_id, title, source, content, status, created_at, updated_at)
     VALUES (?, 'Policy', ?, ?, 'completed', ?, ?)`
  )
  insertLegacyDocument.run(
    "legacy-relative-old",
    filePath,
    "old file content",
    "2000-01-01T00:00:00.000Z",
    "2000-01-01T00:00:00.000Z"
  )
  insertLegacyDocument.run(
    "legacy-relative-current",
    `.${sep}${legacySource}`,
    "legacy file content",
    "2000-01-01T01:00:00.000Z",
    "2000-01-01T01:00:00.000Z"
  )
  legacy.close()

  const db = openDb(dbPath)
  try {
    const lifecycle = new IngestionLifecycle(db, {
      close: async () => {},
      async run(_document, execution): Promise<void> {
        for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
          await execution.runStage(stage, {}, async () => undefined, () => ({ stage }))
        }
      },
    })
    const pending = lifecycle.submit({
      title: "Policy replacement",
      content: "new replacement content",
      sourceIdentity: {
        kind: "file",
        uriOrExternalId: filePath,
        namespace: "local",
      },
    })
    assert.equal(pending.status, "pending")
    assert.equal(pending.version, 2)
    const submission = lifecycle.submit({
      title: "Policy",
      content: "legacy file content",
      sourceIdentity: {
        kind: "file",
        uriOrExternalId: filePath,
        namespace: "local",
      },
      legacySourceAliases: [`.${sep}${legacySource}`],
    })

    assert.equal(submission.status, "unchanged")
    assert.equal(submission.docId, "legacy-relative-current")
    assert.equal(lifecycle.getStatus(submission.docId)?.documentVersion.version, 3)
    assert.equal(lifecycle.getStatus(pending.docId)?.documentVersion.version, 2)
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM sources").get() as { count: number }).count,
      2
    )
    assert.equal(
      (db.prepare(
        "SELECT COUNT(*) AS count FROM sources WHERE active_doc_id IS NOT NULL"
      ).get() as { count: number }).count,
      1
    )
    assert.equal((await lifecycle.runNext())?.success, true)
    assert.equal(lifecycle.getStatus(pending.docId)?.documentVersion.active, true)
    assert.equal(
      (db.prepare(
        "SELECT COUNT(*) AS count FROM sources WHERE canonical_source_id IS NOT NULL"
      ).get() as { count: number }).count,
      1
    )
  } finally {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test("Ticket 06 P1: documents table has tenant_id and allowed_groups columns with correct defaults after openDb migration", () => {
  const db = openDb(":memory:")
  try {
    const columns = db.pragma("table_info(documents)") as Array<{ name: string }>
    assert.ok(
      columns.some((c) => c.name === "tenant_id"),
      "documents table must have tenant_id column after migration"
    )
    assert.ok(
      columns.some((c) => c.name === "allowed_groups"),
      "documents table must have allowed_groups column after migration"
    )

    // Insert a document without supplying tenant_id/allowed_groups — DEFAULT must apply.
    db.prepare(
      `INSERT INTO documents (
        doc_id, source_id, content_hash, version, activation_order,
        title, source, content, metadata, status, created_at, updated_at
       ) VALUES (?, NULL, ?, 1, 1, ?, ?, '{}', '{}', 'pending', ?, ?)`
    ).run(
      "doc-p1-defaults",
      "hash-1",
      "Title",
      "api",
      "2026-07-17T00:00:00.000Z",
      "2026-07-17T00:00:00.000Z"
    )
    const row = db.prepare(
      `SELECT tenant_id, allowed_groups FROM documents WHERE doc_id = ?`
    ).get("doc-p1-defaults") as { tenant_id: string; allowed_groups: string }
    assert.equal(row.tenant_id, "default", "default tenant_id must be 'default'")
    assert.equal(row.allowed_groups, "[]", "default allowed_groups must be '[]'")
  } finally {
    db.close()
  }
})

test("Ticket 06 P6: legacy access migration preserves identities and defaults to tenant-wide visibility", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "kefu-rag-access-upgrade-"))
  const dbPath = join(tempDir, "legacy.db")
  const legacy = new Database(dbPath)

  legacy.exec(`
    CREATE TABLE sources (
      source_id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL UNIQUE,
      source_kind TEXT NOT NULL,
      source_uri TEXT NOT NULL,
      namespace TEXT NOT NULL,
      active_doc_id TEXT,
      last_doc_id TEXT,
      last_outcome TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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
      metadata TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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
      PRIMARY KEY (document_id, node_id)
    );
    INSERT INTO sources (
      source_id, source_key, source_kind, source_uri, namespace,
      active_doc_id, last_doc_id, last_outcome, created_at, updated_at
    ) VALUES (
      'source-legacy-acl', 'legacy-key', 'legacy', 'legacy://policy', 'legacy-space',
      'doc-legacy-acl-v7', 'doc-legacy-acl-v7', 'completed',
      '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z'
    );
    INSERT INTO documents (
      doc_id, source_id, content_hash, version, activation_order,
      title, source, content, metadata, status, created_at, updated_at
    ) VALUES (
      'doc-legacy-acl-v7', 'source-legacy-acl', 'legacy-hash', 7, 7,
      'Legacy ACL policy', 'legacy://policy', 'legacy content', '{}', 'completed',
      '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z'
    );
    INSERT INTO page_index_nodes (
      document_id, node_id, title, section_path, summary
    ) VALUES (
      'doc-legacy-acl-v7', 'node-legacy-acl', 'Legacy section', '[]', 'Legacy summary'
    );
  `)
  legacy.close()

  const db = openDb(dbPath)
  try {
    const source = db.prepare(
      `SELECT source_id, tenant_id, allowed_groups FROM sources WHERE source_id = ?`
    ).get("source-legacy-acl") as {
      source_id: string
      tenant_id: string
      allowed_groups: string
    }
    const document = db.prepare(
      `SELECT doc_id, version, tenant_id, allowed_groups FROM documents WHERE doc_id = ?`
    ).get("doc-legacy-acl-v7") as {
      doc_id: string
      version: number
      tenant_id: string
      allowed_groups: string
    }
    const node = db.prepare(
      `SELECT document_id, node_id, tenant_id, allowed_groups
       FROM page_index_nodes WHERE document_id = ? AND node_id = ?`
    ).get("doc-legacy-acl-v7", "node-legacy-acl") as {
      document_id: string
      node_id: string
      tenant_id: string
      allowed_groups: string
    }

    assert.deepEqual(source, {
      source_id: "source-legacy-acl",
      tenant_id: "default",
      allowed_groups: "[]",
    })
    assert.deepEqual(document, {
      doc_id: "doc-legacy-acl-v7",
      version: 7,
      tenant_id: "default",
      allowed_groups: "[]",
    })
    assert.deepEqual(node, {
      document_id: "doc-legacy-acl-v7",
      node_id: "node-legacy-acl",
      tenant_id: "default",
      allowed_groups: "[]",
    })
  } finally {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test("Ticket 09 P1: handoff_cases table exists with correct columns and UNIQUE(run_id) after openDb", () => {
  const db = openDb(":memory:")
  try {
    const columns = db.pragma("table_info(handoff_cases)") as Array<{ name: string }>
    const colNames = columns.map((c) => c.name)
    for (const expected of [
      "id", "run_id", "tenant_id", "subject_id", "session_id",
      "reason_code", "user_request", "conversation_summary",
      "evidence_ids", "trace_reference", "status",
      "created_at", "updated_at",
    ]) {
      assert.ok(
        colNames.includes(expected),
        `handoff_cases table must have '${expected}' column (got: ${colNames.join(", ")})`
      )
    }

    // Insert a handoff case
    const now = "2026-07-18T00:00:00.000Z"
    db.prepare(
      `INSERT INTO handoff_cases (
        id, run_id, tenant_id, subject_id, session_id,
        reason_code, user_request, conversation_summary,
        evidence_ids, trace_reference, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
    ).run(
      "case-1", "run-1", "tenant-a", "user-1", "session-1",
      "insufficient_evidence", "help me", "[]", "[]", "run-1", now, now
    )

    // UNIQUE(run_id) — second insert with same run_id must throw
    assert.throws(
      () => db.prepare(
        `INSERT INTO handoff_cases (id, run_id, tenant_id, subject_id, session_id,
          reason_code, user_request, conversation_summary, evidence_ids,
          trace_reference, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
      ).run(
        "case-2", "run-1", "tenant-a", "user-1", "session-1",
        "user_request", "help again", "[]", "[]", "run-1", now, now
      ),
      /UNIQUE constraint failed: handoff_cases\.run_id/,
      "run_id UNIQUE constraint must prevent duplicate handoff cases for the same run"
    )

    // CHECK(status) — invalid status must throw
    assert.throws(
      () => db.prepare(
        `INSERT INTO handoff_cases (id, run_id, tenant_id, subject_id, session_id,
          reason_code, user_request, conversation_summary, evidence_ids,
          trace_reference, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'invalid_state', ?, ?)`
      ).run(
        "case-3", "run-2", "tenant-a", "user-1", "session-1",
        "user_request", "help", "[]", "[]", "run-2", now, now
      ),
      /CHECK constraint failed/,
      "status CHECK constraint must reject invalid state values"
    )
  } finally {
    db.close()
  }
})

test("Ticket 09 P1: feedback table exists with correct columns and UNIQUE(tenant_id, subject_id, run_id) after openDb", () => {
  const db = openDb(":memory:")
  try {
    const columns = db.pragma("table_info(feedback)") as Array<{ name: string }>
    const colNames = columns.map((c) => c.name)
    for (const expected of [
      "id", "run_id", "tenant_id", "subject_id",
      "rating", "reason_code", "comment", "evidence_ids",
      "created_at", "updated_at",
    ]) {
      assert.ok(
        colNames.includes(expected),
        `feedback table must have '${expected}' column (got: ${colNames.join(", ")})`
      )
    }

    const now = "2026-07-18T00:00:00.000Z"
    // Insert a feedback row (down rating with reason_code)
    db.prepare(
      `INSERT INTO feedback (
        id, run_id, tenant_id, subject_id, rating,
        reason_code, comment, evidence_ids, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'down', ?, ?, '[]', ?, ?)`
    ).run(
      "fb-1", "run-1", "tenant-a", "user-1",
      "wrong_answer", "the answer was incorrect", now, now
    )

    // UNIQUE(tenant_id, subject_id, run_id) — same combo must throw
    assert.throws(
      () => db.prepare(
        `INSERT INTO feedback (id, run_id, tenant_id, subject_id, rating,
          reason_code, comment, evidence_ids, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'up', NULL, NULL, '[]', ?, ?)`
      ).run(
        "fb-2", "run-1", "tenant-a", "user-1", now, now
      ),
      /UNIQUE constraint failed: feedback\.(tenant_id|subject_id|run_id)/,
      "UNIQUE(tenant_id, subject_id, run_id) must prevent duplicate feedback for the same run+subject"
    )

    // Different subject for same run is allowed (different person can give feedback)
    db.prepare(
      `INSERT INTO feedback (id, run_id, tenant_id, subject_id, rating,
        reason_code, comment, evidence_ids, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'up', NULL, NULL, '[]', ?, ?)`
    ).run(
      "fb-3", "run-1", "tenant-a", "user-2", now, now
    )

    // CHECK(rating) — invalid rating must throw
    assert.throws(
      () => db.prepare(
        `INSERT INTO feedback (id, run_id, tenant_id, subject_id, rating,
          reason_code, comment, evidence_ids, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'neutral', NULL, NULL, '[]', ?, ?)`
      ).run(
        "fb-4", "run-3", "tenant-a", "user-1", now, now
      ),
      /CHECK constraint failed/,
      "rating CHECK constraint must reject non-up/down values"
    )
  } finally {
    db.close()
  }
})
