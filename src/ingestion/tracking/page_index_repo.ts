import type { DB } from "./db"
import type { PageIndexNode } from "../../types"

interface StoredRow {
  document_id: string
  node_id: string
  title: string
  section_path: string
  page_start: number | null
  page_end: number | null
  summary: string
  parent_id: string | null
  child_ids: string
  linked_chunk_ids: string
  tenant_id: string
  allowed_groups: string
}

/**
 * Ticket 06 P3: optional access metadata passed by the pipeline caller.
 * When omitted, SQLite NOT NULL DEFAULT kicks in ('default' / '[]').
 */
export interface PageIndexAccessMetadata {
  tenantId?: string
  allowedGroups?: string[]
}

function parsePath(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function toNode(row: StoredRow): PageIndexNode {
  return {
    documentId: row.document_id,
    nodeId: row.node_id,
    title: row.title,
    sectionPath: parsePath(row.section_path),
    pageStart: row.page_start,
    pageEnd: row.page_end,
    summary: row.summary,
    parentId: row.parent_id,
    childIds: parsePath(row.child_ids),
    linkedChunkIds: parsePath(row.linked_chunk_ids),
    tenantId: row.tenant_id,
    allowedGroups: parsePath(row.allowed_groups),
  }
}

export class PageIndexRepository {
  constructor(private db: DB) {}

  replaceNodes(
    documentId: string,
    nodes: PageIndexNode[],
    accessMetadata?: PageIndexAccessMetadata
  ): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM page_index_nodes WHERE document_id = ?").run(documentId)
      const insert = this.db.prepare(
        `INSERT INTO page_index_nodes (
          document_id, node_id, title, section_path, page_start, page_end,
          summary, parent_id, child_ids, linked_chunk_ids,
          tenant_id, allowed_groups
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      const tenantId = accessMetadata?.tenantId ?? "default"
      const allowedGroups = JSON.stringify(accessMetadata?.allowedGroups ?? [])
      for (const node of nodes) {
        insert.run(
          node.documentId,
          node.nodeId,
          node.title,
          JSON.stringify(node.sectionPath),
          node.pageStart,
          node.pageEnd,
          node.summary,
          node.parentId,
          JSON.stringify(node.childIds),
          JSON.stringify(node.linkedChunkIds),
          tenantId,
          allowedGroups
        )
      }
    })
    tx()
  }

  getNodesByDocument(documentId: string): PageIndexNode[] {
    const rows = this.db.prepare(
      "SELECT * FROM page_index_nodes WHERE document_id = ? ORDER BY node_id"
    ).all(documentId) as StoredRow[]
    return rows.map(toNode)
  }

  searchNodes(query: string, limit: number): PageIndexNode[] {
    const pattern = `%${query.replace(/[%_]/g, "\\$&")}%`
    const rows = this.db.prepare(
      `SELECT * FROM page_index_nodes
       WHERE title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\'
       ORDER BY document_id, node_id
       LIMIT ?`
    ).all(pattern, pattern, limit) as StoredRow[]
    return rows.map(toNode)
  }
}
