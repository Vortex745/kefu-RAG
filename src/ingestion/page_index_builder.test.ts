import assert from "node:assert/strict"
import test from "node:test"
import { buildPageIndex } from "./page_index_builder"
import type { Chunk, Document } from "../types"

function makeDocument(overrides: Partial<Document> = {}): Document {
  return {
    id: "doc-v1",
    sourceId: "src-1",
    contentHash: "hash-1",
    version: 1,
    title: "Test Document",
    source: "test",
    content: "full content",
    metadata: {},
    createdAt: new Date(),
    ...overrides,
  }
}

function parentChunk(
  id: string,
  sectionPath: string[],
  childrenIds: string[],
  content: string
): Chunk {
  return {
    id,
    documentId: "doc-v1",
    content,
    childrenIds,
    metadata: {
      kind: "parent",
      title: sectionPath[sectionPath.length - 1] || "Root",
      sectionPath,
    },
  }
}

function childChunk(
  id: string,
  parentId: string,
  sectionPath: string[],
  page?: number
): Chunk {
  return {
    id,
    documentId: "doc-v1",
    content: `child ${id}`,
    parentId,
    childrenIds: [],
    metadata: {
      kind: "child",
      sectionPath,
      ...(page !== undefined ? { page } : {}),
    },
  }
}

test("buildPageIndex creates nodes from parent chunks with linked child IDs and page range", () => {
  const doc = makeDocument()
  const child1 = childChunk("c1", "p1", ["Chapter 1"], 1)
  const child2 = childChunk("c2", "p1", ["Chapter 1"], 3)
  const parent1 = parentChunk("p1", ["Chapter 1"], ["c1", "c2"], "Chapter 1 content here")
  const nodes = buildPageIndex(doc, [parent1, child1, child2])
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].title, "Chapter 1")
  assert.deepEqual(nodes[0].sectionPath, ["Chapter 1"])
  assert.deepEqual(nodes[0].linkedChunkIds, ["c1", "c2"])
  assert.equal(nodes[0].pageStart, 1)
  assert.equal(nodes[0].pageEnd, 3)
  assert.equal(nodes[0].parentId, null)
  assert.ok(nodes[0].summary.length <= 200)
})

test("buildPageIndex derives parent IDs from section path hierarchy", () => {
  const doc = makeDocument()
  const child1 = childChunk("c1", "p1", ["Chapter 1"])
  const child2 = childChunk("c2", "p2", ["Chapter 1", "Section 1.1"])
  const parent1 = parentChunk("p1", ["Chapter 1"], ["c1"], "Chapter 1")
  const parent2 = parentChunk("p2", ["Chapter 1", "Section 1.1"], ["c2"], "Section 1.1")
  const nodes = buildPageIndex(doc, [parent1, parent2, child1, child2])
  assert.equal(nodes.length, 2)
  const root = nodes.find((n) => n.sectionPath.length === 1)!
  const child = nodes.find((n) => n.sectionPath.length === 2)!
  assert.equal(root.parentId, null)
  assert.equal(child.parentId, root.nodeId)
})

test("buildPageIndex returns empty when no parent chunks exist", () => {
  const doc = makeDocument()
  const child = childChunk("c1", "p1", ["Chapter 1"])
  const nodes = buildPageIndex(doc, [child])
  assert.equal(nodes.length, 0)
})

test("buildPageIndex isolates nodes by document identity", () => {
  const doc1 = makeDocument({ id: "doc-v1" })
  const doc2 = makeDocument({ id: "doc-v2" })
  const parent1 = parentChunk("p1", ["Chapter 1"], ["c1"], "content 1")
  const parent2 = parentChunk("p2", ["Chapter 1"], ["c2"], "content 2")
  const nodes1 = buildPageIndex(doc1, [parent1])
  const nodes2 = buildPageIndex(doc2, [parent2])
  assert.notEqual(nodes1[0].documentId, nodes2[0].documentId)
  assert.notEqual(nodes1[0].nodeId, nodes2[0].nodeId)
})
