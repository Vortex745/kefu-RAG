import Database from "better-sqlite3"
import { createHash } from "node:crypto"
import * as fs from "fs"
import * as path from "path"
import { loadConfig } from "../../config"
import { resolveStoredSourceIdentity, sourceIdentityKey } from "../source_identity"

export type DB = Database.Database

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sources (
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
    allowed_groups TEXT NOT NULL DEFAULT '[]',
    lifecycle_state TEXT NOT NULL DEFAULT 'active'
  )`,
  `CREATE TABLE IF NOT EXISTS documents (
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
    allowed_groups TEXT NOT NULL DEFAULT '[]',
    candidate_state TEXT NOT NULL DEFAULT 'approved',
    reviewed_by TEXT,
    reviewed_at TEXT,
    review_reason TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS task_pending_ops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL,
    op TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    fail_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    claimed_at TEXT,
    next_attempt_at TEXT,
    enqueued_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_task_status ON task_pending_ops(status)`,
  `CREATE TABLE IF NOT EXISTS task_dead_letters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL UNIQUE,
    doc_id TEXT NOT NULL,
    op TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    fail_count INTEGER NOT NULL,
    error_message TEXT NOT NULL,
    error_stack TEXT,
    failed_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS processing_spans (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_spans_doc ON processing_spans(doc_id)`,
  `CREATE TABLE IF NOT EXISTS answer_run_events (
    run_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    event_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, event_id),
    UNIQUE (run_id, sequence)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_answer_run_events_session
    ON answer_run_events(session_id, run_id, sequence)`,
  `CREATE TABLE IF NOT EXISTS page_index_nodes (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_page_index_doc ON page_index_nodes(document_id)`,
  `CREATE TABLE IF NOT EXISTS clarification_pending (
    session_id TEXT PRIMARY KEY,
    original_message TEXT NOT NULL,
    missing_fields_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS session_bindings (
    session_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS conversation_turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    run_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'validated' CHECK(kind IN ('validated', 'pending_clarification'))
  )`,
  // Ticket 61 / 01 (spec §2 L1740): One rolling summary record per Tenant-bound
  // session. PRIMARY KEY (session_id, tenant_id) enforces "one record per
  // Tenant-bound session". `summarized_through_turn_id` references
  // conversation_turns.id (no FK — TTL deletes both together per L1747, and
  // tombstone-style retention is not needed for summaries). `schema_version`
  // supports forward-compatible summary format evolution (current = 1).
  `CREATE TABLE IF NOT EXISTS conversation_rolling_summaries (
    session_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    summarized_through_turn_id INTEGER NOT NULL,
    schema_version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (session_id, tenant_id)
  )`,
  // Ticket 09 P1 (spec §8 L1543-1544): Handoff cases — idempotent by run_id
  // (one case per Answer run). State machine: open → claimed → resolved,
  // or open/claimed → cancelled. Cross-tenant isolation via tenant_id filter.
  `CREATE TABLE IF NOT EXISTS handoff_cases (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    user_request TEXT NOT NULL,
    conversation_summary TEXT NOT NULL,
    evidence_ids TEXT NOT NULL DEFAULT '[]',
    trace_reference TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'claimed', 'resolved', 'cancelled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_handoff_cases_tenant_status
    ON handoff_cases(tenant_id, status)`,
  // Ticket 09 P1 (spec §8 L1546-1548): Feedback — one current record per
  // (tenant_id, subject_id, run_id). Upsert via UNIQUE constraint.
  // reason_code is nullable (null for 'up' ratings; required for 'down').
  `CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    rating TEXT NOT NULL CHECK(rating IN ('up', 'down')),
    reason_code TEXT,
    comment TEXT,
    evidence_ids TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(tenant_id, subject_id, run_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_feedback_tenant_subject_run
    ON feedback(tenant_id, subject_id, run_id)`,
  // Ticket 11 P1 (spec §11 L1578): Source tombstones — append-only audit
  // records of Source retirements. Tombstones retain Source identity (via
  // source_id reference), retired version IDs (JSON array), reason, actor
  // and timestamps. No FK constraint since tombstones must outlive any
  // physical deletion of the sources row. The source_id is preserved (with
  // lifecycle_state='retired') — physical deletion follows retention policy
  // and does not reuse old IDs (spec L1578).
  `CREATE TABLE IF NOT EXISTS source_tombstones (
    tombstone_id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    retired_version_ids TEXT NOT NULL DEFAULT '[]',
    reason TEXT NOT NULL,
    actor TEXT NOT NULL,
    retired_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_source_tombstones_source
    ON source_tombstones(source_id, retired_at)`,
  `CREATE INDEX IF NOT EXISTS idx_source_tombstones_tenant
    ON source_tombstones(tenant_id, created_at)`,
].join(";\n")

let _db: DB | null = null

export function openDb(dbPath?: string): DB {
  if (_db && !dbPath) return _db
  const resolved = dbPath ?? loadConfig().sqlitePath
  const dir = path.dirname(resolved)
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const db = new Database(resolved)
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  db.exec(SCHEMA)
  const sourceColumns = db.pragma("table_info(sources)") as Array<{ name: string }>
  if (!sourceColumns.some(({ name }) => name === "canonical_source_id")) {
    db.exec("ALTER TABLE sources ADD COLUMN canonical_source_id TEXT")
  }
  // Ticket 05 P2: additive migration — default to single-tenant identity for existing rows.
  if (!sourceColumns.some(({ name }) => name === "tenant_id")) {
    db.exec("ALTER TABLE sources ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'")
  }
  if (!sourceColumns.some(({ name }) => name === "allowed_groups")) {
    db.exec("ALTER TABLE sources ADD COLUMN allowed_groups TEXT NOT NULL DEFAULT '[]'")
  }
  const documentColumns = db.pragma("table_info(documents)") as Array<{ name: string }>
  // Ticket 06 P1: additive migration — default to single-tenant identity for existing rows.
  if (!documentColumns.some(({ name }) => name === "tenant_id")) {
    db.exec("ALTER TABLE documents ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'")
  }
  if (!documentColumns.some(({ name }) => name === "allowed_groups")) {
    db.exec("ALTER TABLE documents ADD COLUMN allowed_groups TEXT NOT NULL DEFAULT '[]'")
  }
  if (!documentColumns.some(({ name }) => name === "source_id")) {
    db.exec("ALTER TABLE documents ADD COLUMN source_id TEXT")
  }
  if (!documentColumns.some(({ name }) => name === "content_hash")) {
    db.exec("ALTER TABLE documents ADD COLUMN content_hash TEXT")
  }
  if (!documentColumns.some(({ name }) => name === "version")) {
    db.exec("ALTER TABLE documents ADD COLUMN version INTEGER")
  }
  if (!documentColumns.some(({ name }) => name === "activation_order")) {
    db.exec("ALTER TABLE documents ADD COLUMN activation_order INTEGER")
  }
  if (!documentColumns.some(({ name }) => name === "raw_content")) {
    db.exec("ALTER TABLE documents ADD COLUMN raw_content BLOB")
  }
  if (!documentColumns.some(({ name }) => name === "file_name")) {
    db.exec("ALTER TABLE documents ADD COLUMN file_name TEXT")
  }
  if (!documentColumns.some(({ name }) => name === "mime_type")) {
    db.exec("ALTER TABLE documents ADD COLUMN mime_type TEXT")
  }
  if (!documentColumns.some(({ name }) => name === "parser_override")) {
    db.exec("ALTER TABLE documents ADD COLUMN parser_override TEXT")
  }
  // Ticket 11 P1 (spec §11 L1571-1578): additive migration — Source governance
  // lifecycle columns. Defaults preserve backward compatibility:
  //   - sources.lifecycle_state = 'active' (existing Sources remain queryable)
  //   - documents.candidate_state = 'approved' (existing completed candidates
  //     remain active without requiring review)
  //   - reviewed_by / reviewed_at / review_reason are nullable — only set
  //     when a human review occurs (ACTIVATION_MODE=review, spec L1574)
  if (!sourceColumns.some(({ name }) => name === "lifecycle_state")) {
    db.exec("ALTER TABLE sources ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active'")
  }
  if (!documentColumns.some(({ name }) => name === "candidate_state")) {
    db.exec("ALTER TABLE documents ADD COLUMN candidate_state TEXT NOT NULL DEFAULT 'approved'")
  }
  if (!documentColumns.some(({ name }) => name === "reviewed_by")) {
    db.exec("ALTER TABLE documents ADD COLUMN reviewed_by TEXT")
  }
  if (!documentColumns.some(({ name }) => name === "reviewed_at")) {
    db.exec("ALTER TABLE documents ADD COLUMN reviewed_at TEXT")
  }
  if (!documentColumns.some(({ name }) => name === "review_reason")) {
    db.exec("ALTER TABLE documents ADD COLUMN review_reason TEXT")
  }
  // Ticket 06 P3: additive migration — page_index_nodes access metadata.
  const pageIndexColumns = db.pragma("table_info(page_index_nodes)") as Array<{ name: string }>
  if (!pageIndexColumns.some(({ name }) => name === "tenant_id")) {
    db.exec("ALTER TABLE page_index_nodes ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'")
  }
  if (!pageIndexColumns.some(({ name }) => name === "allowed_groups")) {
    db.exec("ALTER TABLE page_index_nodes ADD COLUMN allowed_groups TEXT NOT NULL DEFAULT '[]'")
  }
  // Ticket 08 P5: additive migration — kind discriminator absorbs pending
  // clarification into the same Conversation state (spec §7 L1538). Existing
  // P1 rows default to 'validated' so loadRecentTurns behavior is unchanged.
  const conversationColumns = db.pragma("table_info(conversation_turns)") as Array<{ name: string }>
  if (!conversationColumns.some(({ name }) => name === "kind")) {
    db.exec("ALTER TABLE conversation_turns ADD COLUMN kind TEXT NOT NULL DEFAULT 'validated'")
  }
  const legacyDocuments = db.prepare(
    `SELECT doc_id, source, content, status, created_at, updated_at
     FROM documents
     WHERE source_id IS NULL OR content_hash IS NULL OR version IS NULL
     ORDER BY created_at ASC, doc_id ASC`
  ).all() as Array<{
    doc_id: string
    source: string
    content: string
    status: string
    created_at: string
    updated_at: string
  }>
  const upgradeLegacyDocuments = db.transaction(() => {
    for (const document of legacyDocuments) {
      const identity = resolveStoredSourceIdentity(document.source, document.doc_id)
      const sourceKey = sourceIdentityKey(identity)
      const sourceId = `legacy:${sourceKey}`
      db.prepare(
        `INSERT INTO sources (
          source_id, source_key, source_kind, source_uri, namespace,
          active_doc_id, last_doc_id, last_outcome, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
        ON CONFLICT(source_key) DO NOTHING`
      ).run(
        sourceId,
        sourceKey,
        identity.kind,
        identity.uri,
        identity.namespace,
        document.created_at,
        document.updated_at
      )
      const storedSource = db.prepare(
        `SELECT source_id FROM sources WHERE source_key = ?`
      ).get(sourceKey) as { source_id: string }
      const nextVersion = db.prepare(
        `SELECT COALESCE(MAX(version), 0) + 1 AS version
         FROM documents WHERE source_id = ?`
      ).get(storedSource.source_id) as { version: number }
      db.prepare(
        `UPDATE documents
         SET source_id = ?, content_hash = ?, version = ?, activation_order = ?
         WHERE doc_id = ?`
      ).run(
        storedSource.source_id,
        createHash("sha256").update(document.content, "utf8").digest("hex"),
        nextVersion.version,
        nextVersion.version,
        document.doc_id
      )
      db.prepare(
        `UPDATE sources
         SET active_doc_id = CASE
               WHEN ? = 'completed' AND (
                 active_doc_id IS NULL OR
                 (SELECT created_at FROM documents WHERE doc_id = active_doc_id) <= ?
               ) THEN ?
               ELSE active_doc_id
             END,
             last_doc_id = CASE
               WHEN last_doc_id IS NULL OR
                 (SELECT created_at FROM documents WHERE doc_id = last_doc_id) <= ?
               THEN ?
               ELSE last_doc_id
             END,
             last_outcome = CASE
               WHEN last_doc_id IS NULL OR
                 (SELECT created_at FROM documents WHERE doc_id = last_doc_id) <= ?
               THEN ?
               ELSE last_outcome
             END,
             updated_at = CASE WHEN updated_at <= ? THEN ? ELSE updated_at END
         WHERE source_id = ?`
      ).run(
        document.status,
        document.created_at,
        document.doc_id,
        document.created_at,
        document.doc_id,
        document.created_at,
        document.status,
        document.updated_at,
        document.updated_at,
        storedSource.source_id
      )
    }
  })
  upgradeLegacyDocuments()
  db.exec(
    "UPDATE documents SET activation_order = version WHERE activation_order IS NULL"
  )
  const taskColumns = db.pragma("table_info(task_pending_ops)") as Array<{ name: string }>
  if (!taskColumns.some(({ name }) => name === "next_attempt_at")) {
    db.exec("ALTER TABLE task_pending_ops ADD COLUMN next_attempt_at TEXT")
  }
  const spanColumns = db.pragma("table_info(processing_spans)") as Array<{ name: string }>
  if (!spanColumns.some(({ name }) => name === "error_stack")) {
    db.exec("ALTER TABLE processing_spans ADD COLUMN error_stack TEXT")
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_task_claimable ON task_pending_ops(status, next_attempt_at, id)"
  )
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_source_version ON documents(source_id, version)"
  )
  if (!dbPath) _db = db
  return db
}

export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}
