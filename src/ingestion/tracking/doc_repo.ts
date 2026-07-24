import type { DB } from "./db"
import type { Document, DocumentStatus } from "../../types"

interface DocumentRow {
  doc_id: string
  source_id: string
  content_hash: string
  version: number
  activation_order: number
  title: string
  source: string
  content: string
  raw_content: Buffer | null
  file_name: string | null
  mime_type: string | null
  parser_override: string | null
  metadata: string
  status: string
  created_at: string
  updated_at: string
  tenant_id: string
  allowed_groups: string
}

function rowToDocument(row: DocumentRow): Document {
  return {
    id: row.doc_id,
    sourceId: row.source_id,
    contentHash: row.content_hash,
    version: row.version,
    title: row.title,
    source: row.source,
    content: row.content,
    rawContent: row.raw_content,
    fileName: row.file_name,
    mimeType: row.mime_type,
    parserOverride: row.parser_override,
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
    createdAt: new Date(row.created_at),
    tenantId: row.tenant_id,
    allowedGroups: JSON.parse(row.allowed_groups),
  }
}

export interface InsertDocumentInput {
  docId: string
  sourceId: string
  contentHash: string
  version: number
  title: string
  source: string
  content: string
  rawContent?: Buffer
  fileName?: string
  mimeType?: string
  parserOverride?: string
  metadata?: Record<string, unknown>
  /**
   * Ticket 06 P2: access metadata inherited from the Source. Optional so
   * legacy callers (e.g. pipeline.t54.test.ts) fall back to SCHEMA DEFAULT
   * 'default' / '[]' when omitted.
   */
  tenantId?: string
  allowedGroups?: string[]
}

export interface SourceIdentityInput {
  sourceId: string
  sourceKey: string
  kind: string
  uri: string
  namespace: string
}

export interface SourceRecord {
  sourceId: string
  /**
   * Ticket 06 P2: access metadata persisted on the sources row. Required on
   * the record because the SQLite columns are NOT NULL DEFAULT — repo reads
   * always populate these. New ingestion (lifecycle.submit) reads them from
   * the source row and passes them to DocumentRepo.insert.
   */
  tenantId: string
  allowedGroups: string[]
}

export interface LegacySourceRecord extends SourceRecord {
  uri: string
}

export interface DocumentVersionInfo {
  version: number
  contentHash: string
  active: boolean
}

export class DocumentRepo {
  constructor(private db: DB) {}

  insert(input: InsertDocumentInput): void {
    const now = new Date().toISOString()
    this.db.prepare(
      `INSERT INTO documents (
        doc_id, source_id, content_hash, version, activation_order,
        title, source, content, raw_content, file_name, mime_type, parser_override,
        metadata, status, created_at, updated_at,
        tenant_id, allowed_groups
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
    ).run(
      input.docId,
      input.sourceId,
      input.contentHash,
      input.version,
      input.version,
      input.title,
      input.source,
      input.content,
      input.rawContent ?? null,
      input.fileName ?? null,
      input.mimeType ?? null,
      input.parserOverride ?? null,
      input.metadata ? JSON.stringify(input.metadata) : "{}",
      now,
      now,
      input.tenantId ?? "default",
      JSON.stringify(input.allowedGroups ?? [])
    )
  }

  get(docId: string): Document | null {
    const row = this.db.prepare(
      `SELECT * FROM documents WHERE doc_id = ?`
    ).get(docId) as DocumentRow | undefined
    return row ? rowToDocument(row) : null
  }

  exists(docId: string): boolean {
    const row = this.db.prepare(
      `SELECT 1 FROM documents WHERE doc_id = ?`
    ).get(docId) as { 1: number } | undefined
    return !!row
  }

  createSource(input: SourceIdentityInput): SourceRecord {
    const now = new Date().toISOString()
    this.db.prepare(
      `INSERT INTO sources (
        source_id, source_key, source_kind, source_uri, namespace,
        active_doc_id, last_doc_id, last_outcome, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`
    ).run(
      input.sourceId,
      input.sourceKey,
      input.kind,
      input.uri,
      input.namespace,
      now,
      now
    )
    // Ticket 06 P2: read back access metadata — sources row relies on SCHEMA
    // DEFAULT 'default' / '[]' for tenant_id/allowed_groups when callers
    // don't supply them (single-tenant mode; multi-tenant wiring is downstream).
    const row = this.db.prepare(
      `SELECT tenant_id, allowed_groups FROM sources WHERE source_id = ?`
    ).get(input.sourceId) as { tenant_id: string; allowed_groups: string }
    return {
      sourceId: input.sourceId,
      tenantId: row.tenant_id,
      allowedGroups: JSON.parse(row.allowed_groups),
    }
  }

  updateSourceIdentity(
    sourceId: string,
    input: Omit<SourceIdentityInput, "sourceId">
  ): void {
    const info = this.db.prepare(
      `UPDATE sources
       SET source_key = ?, source_kind = ?, source_uri = ?, namespace = ?, updated_at = ?
       WHERE source_id = ?`
    ).run(
      input.sourceKey,
      input.kind,
      input.uri,
      input.namespace,
      new Date().toISOString(),
      sourceId
    )
    if (info.changes !== 1) {
      throw new Error(`Source ${sourceId} could not adopt its canonical identity`)
    }
  }

  getSourceByKey(sourceKey: string): SourceRecord | null {
    const row = this.db.prepare(
      `SELECT COALESCE(canonical_source_id, source_id) AS source_id,
              tenant_id, allowed_groups
       FROM sources WHERE source_key = ?`
    ).get(sourceKey) as
      | { source_id: string; tenant_id: string; allowed_groups: string }
      | undefined
    return row
      ? {
          sourceId: row.source_id,
          tenantId: row.tenant_id,
          allowedGroups: JSON.parse(row.allowed_groups),
        }
      : null
  }

  listLegacySources(): LegacySourceRecord[] {
    const rows = this.db.prepare(
      `SELECT source_id, source_uri, tenant_id, allowed_groups
       FROM sources
       WHERE source_kind = 'legacy' AND namespace = 'default'
         AND canonical_source_id IS NULL`
    ).all() as Array<{
      source_id: string
      source_uri: string
      tenant_id: string
      allowed_groups: string
    }>
    return rows.map((row) => ({
      sourceId: row.source_id,
      uri: row.source_uri,
      tenantId: row.tenant_id,
      allowedGroups: JSON.parse(row.allowed_groups),
    }))
  }

  adoptCanonicalSource(
    sourceId: string,
    aliasSourceIds: string[],
    input: Omit<SourceIdentityInput, "sourceId">,
    activeDocId: string | null
  ): void {
    if (activeDocId) {
      const active = this.get(activeDocId)
      if (active && active.sourceId !== sourceId) {
        const history = this.db.prepare(
          `SELECT doc_id
           FROM documents
           WHERE source_id = ? OR doc_id = ?
           ORDER BY created_at ASC, doc_id ASC`
        ).all(sourceId, activeDocId) as Array<{ doc_id: string }>
        this.db.prepare(
          `UPDATE documents
           SET source_id = ?, version = ?, activation_order = 0, updated_at = ?
           WHERE doc_id = ?`
        ).run(
          sourceId,
          this.getNextVersion(sourceId),
          new Date().toISOString(),
          activeDocId
        )
        const updateActivationOrder = this.db.prepare(
          `UPDATE documents SET activation_order = ? WHERE doc_id = ?`
        )
        history.forEach((document, index) => {
          updateActivationOrder.run(index + 1, document.doc_id)
        })
      }
    }
    this.updateSourceIdentity(sourceId, input)
    if (activeDocId) {
      this.db.prepare(
        `UPDATE sources
         SET active_doc_id = ?, last_doc_id = ?, last_outcome = 'completed', updated_at = ?
         WHERE source_id = ?`
      ).run(activeDocId, activeDocId, new Date().toISOString(), sourceId)
    }
    const updateAlias = this.db.prepare(
      `UPDATE sources
       SET canonical_source_id = ?, active_doc_id = NULL, updated_at = ?
       WHERE source_id = ?`
    )
    for (const aliasSourceId of aliasSourceIds) {
      updateAlias.run(sourceId, new Date().toISOString(), aliasSourceId)
    }
  }

  getActive(sourceId: string): Document | null {
    const row = this.db.prepare(
      `SELECT d.*
       FROM sources s
       JOIN documents d ON d.doc_id = s.active_doc_id
       WHERE s.source_id = ?`
    ).get(sourceId) as DocumentRow | undefined
    return row ? rowToDocument(row) : null
  }

  updateMetadata(docId: string, metadata: Record<string, unknown>): void {
    const info = this.db.prepare(
      "UPDATE documents SET metadata = ?, updated_at = ? WHERE doc_id = ?"
    ).run(JSON.stringify(metadata), new Date().toISOString(), docId)
    if (info.changes !== 1) {
      throw new Error(`Document metadata could not be updated: ${docId}`)
    }
  }

  getInFlightByHash(sourceId: string, contentHash: string): Document | null {
    const row = this.db.prepare(
      `SELECT d.*
       FROM documents d
       JOIN task_pending_ops t ON t.doc_id = d.doc_id
       WHERE d.source_id = ? AND d.content_hash = ?
         AND t.status IN ('pending', 'running')
       ORDER BY d.version DESC
       LIMIT 1`
    ).get(sourceId, contentHash) as DocumentRow | undefined
    return row ? rowToDocument(row) : null
  }

  getNextVersion(sourceId: string): number {
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(version), 0) + 1 AS version
       FROM documents WHERE source_id = ?`
    ).get(sourceId) as { version: number }
    return row.version
  }

  recordOutcome(
    sourceId: string,
    docId: string,
    outcome: DocumentStatus | "unchanged"
  ): void {
    this.db.prepare(
      `UPDATE sources
       SET last_doc_id = ?, last_outcome = ?, updated_at = ?
       WHERE source_id = ?`
    ).run(docId, outcome, new Date().toISOString(), sourceId)
  }

  activate(docId: string): void {
    this.db.prepare(
      `UPDATE sources
       SET active_doc_id = ?, updated_at = ?
       WHERE source_id = (SELECT source_id FROM documents WHERE doc_id = ?)
         AND canonical_source_id IS NULL
         AND (
           active_doc_id IS NULL OR
           (SELECT activation_order FROM documents WHERE doc_id = active_doc_id) <
             (SELECT activation_order FROM documents WHERE doc_id = ?)
         )`
    ).run(docId, new Date().toISOString(), docId, docId)
  }

  getStatus(docId: string): DocumentStatus | null {
    const row = this.db.prepare(
      `SELECT status FROM documents WHERE doc_id = ?`
    ).get(docId) as { status: string } | undefined
    return (row?.status as DocumentStatus | undefined) ?? null
  }

  getLifecycleOutcome(docId: string): DocumentStatus | "unchanged" | null {
    const row = this.db.prepare(
      `SELECT d.status,
              CASE WHEN s.last_doc_id = d.doc_id THEN s.last_outcome END AS latest_outcome
       FROM documents d
       JOIN sources s ON s.source_id = d.source_id
       WHERE d.doc_id = ?`
    ).get(docId) as { status: string; latest_outcome: string | null } | undefined
    return (row?.latest_outcome ?? row?.status ?? null) as
      | DocumentStatus
      | "unchanged"
      | null
  }

  getVersionInfo(docId: string): DocumentVersionInfo | null {
    const row = this.db.prepare(
      `SELECT d.version, d.content_hash, s.active_doc_id = d.doc_id AS active
       FROM documents d
       JOIN sources s ON s.source_id = d.source_id
       WHERE d.doc_id = ?`
    ).get(docId) as {
      version: number
      content_hash: string
      active: number
    } | undefined
    return row
      ? {
          version: row.version,
          contentHash: row.content_hash,
          active: row.active === 1,
        }
      : null
  }

  updateStatus(docId: string, status: "completed" | "failed" | "cancelled"): void {
    const info = this.db.prepare(
      `UPDATE documents SET status = ?, updated_at = ? WHERE doc_id = ?`
    ).run(status, new Date().toISOString(), docId)
    if (info.changes !== 1) return
    this.db.prepare(
      `UPDATE sources
       SET last_outcome = ?, updated_at = ?
       WHERE last_doc_id = ?`
    ).run(status, new Date().toISOString(), docId)
  }

  /**
   * P6.1 (spec §11 L1574, L73): Mark a completed candidate as
   * `pending_review`. Called by IngestionLifecycle.runNext() when
   * `ACTIVATION_MODE=review` — the candidate is queryable for review but
   * does NOT become the active version. Terminal activation is deferred to
   * `CandidateReviewStore.review()` on approve (spec L1575).
   *
   * Silent no-op if the doc doesn't exist (matches `activate`'s contract) —
   * callers always operate on a confirmed-existing doc within a transaction.
   */
  markPendingReview(docId: string): void {
    this.db.prepare(
      `UPDATE documents SET candidate_state = 'pending_review', updated_at = ?
       WHERE doc_id = ?`
    ).run(new Date().toISOString(), docId)
  }
}
