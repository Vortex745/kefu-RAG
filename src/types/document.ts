export interface Document {
  id: string
  sourceId: string
  contentHash: string
  version: number
  title: string
  source: string
  content: string
  rawContent?: Buffer | null
  fileName?: string | null
  mimeType?: string | null
  parserOverride?: string | null
  metadata: Record<string, unknown>
  createdAt: Date
  /**
   * Ticket 06 P2: access metadata inherited from the Source at insert time.
   * Optional on the type so existing test mocks don't break; the SQLite row
   * is NOT NULL DEFAULT so repo reads always populate these fields.
   */
  tenantId?: string
  allowedGroups?: string[]
}

export interface Chunk {
  id: string
  documentId: string
  content: string
  embedding?: number[]
  parentId?: string
  childrenIds: string[]
  metadata: Record<string, unknown>
  /** Ticket 06 P4: populated on Elasticsearch persistence and reads. */
  tenantId?: string
  allowedGroups?: string[]
}

export interface Entity {
  id: string
  name: string
  type: string
  aliases: string[]
  metadata: Record<string, unknown>
}

export interface Wikilink {
  sourceEntityId: string
  targetEntityId: string
  relation: string
  weight: number
  provenance?: Array<{
    documentId: string
    chunkId: string
    tenantId?: string
    allowedGroups?: string[]
  }>
}

export interface PageIndexNode {
  documentId: string
  nodeId: string
  title: string
  sectionPath: string[]
  pageStart: number | null
  pageEnd: number | null
  summary: string
  parentId: string | null
  childIds: string[]
  linkedChunkIds: string[]
  /**
   * Ticket 06 P3: access metadata inherited from the Document at insert time.
   * Optional on the type so existing test mocks don't break; the SQLite row
   * is NOT NULL DEFAULT so repo reads always populate these fields.
   */
  tenantId?: string
  allowedGroups?: string[]
}
