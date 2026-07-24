import { v5 as uuid } from "uuid"
import type { Chunk, Document, PageIndexNode } from "../types"

const SUMMARY_MAX = 200

function sectionKey(path: string[]): string {
  return path.join("\0")
}

function deriveParentId(
  docId: string,
  sectionPath: string[],
  nodeIdByPath: Map<string, string>
): string | null {
  if (sectionPath.length <= 1) return null
  const parentPath = sectionPath.slice(0, -1)
  return nodeIdByPath.get(sectionKey(parentPath)) ?? null
}

function aggregatePageRange(chunks: Chunk[]): {
  pageStart: number | null
  pageEnd: number | null
} {
  const pages = chunks
    .map((chunk) => chunk.metadata.page)
    .filter((page): page is number => typeof page === "number" && Number.isFinite(page))
    .sort((a, b) => a - b)
  if (pages.length === 0) return { pageStart: null, pageEnd: null }
  return { pageStart: pages[0], pageEnd: pages[pages.length - 1] }
}

export function buildPageIndex(doc: Document, chunks: Chunk[]): PageIndexNode[] {
  const parents = chunks.filter((chunk) => chunk.metadata.kind === "parent")
  const childById = new Map(chunks.map((chunk) => [chunk.id, chunk]))
  const nodeIdByPath = new Map<string, string>()

  for (const parent of parents) {
    const sectionPath = Array.isArray(parent.metadata.sectionPath)
      ? (parent.metadata.sectionPath as string[]).map(String)
      : []
    const nodeId = uuid(
      `kefu-rag:page-index:${doc.id}:${sectionKey(sectionPath)}`,
      uuid.URL
    )
    nodeIdByPath.set(sectionKey(sectionPath), nodeId)
  }

  const nodes: PageIndexNode[] = []
  for (const parent of parents) {
    const sectionPath = Array.isArray(parent.metadata.sectionPath)
      ? (parent.metadata.sectionPath as string[]).map(String)
      : []
    const nodeId = nodeIdByPath.get(sectionKey(sectionPath))!
    const linkedChildren = parent.childrenIds
      .map((id) => childById.get(id))
      .filter((child): child is Chunk => !!child)
    const { pageStart, pageEnd } = aggregatePageRange(linkedChildren)
    const childNodeIds = parent.childrenIds
      .map((id) => nodeIdByPath.get(sectionKey(
        Array.isArray(childById.get(id)?.metadata.sectionPath)
          ? (childById.get(id)!.metadata.sectionPath as string[]).map(String)
          : []
      )))
      .filter((id): id is string => !!id)
    nodes.push({
      documentId: doc.id,
      nodeId,
      title: (parent.metadata.title as string) || doc.title,
      sectionPath,
      pageStart,
      pageEnd,
      summary: parent.content.slice(0, SUMMARY_MAX),
      parentId: deriveParentId(doc.id, sectionPath, nodeIdByPath),
      childIds: childNodeIds,
      linkedChunkIds: parent.childrenIds,
    })
  }
  return nodes
}
