import assert from "node:assert/strict"
import test from "node:test"
import type { Document, NormalizedBlock } from "../../types"
import { normalizeMarkItDown, normalizeMinerU } from "../parser"
import { RecursiveChunker } from "./chunker"

test("uses stable chunk ids when retrying the same document version", async () => {
  const chunker = new RecursiveChunker()
  const document: Document = {
    id: "doc-v1",
    sourceId: "source-1",
    contentHash: "hash-1",
    version: 1,
    title: "test",
    source: "test",
    content: "同一份客服知识库内容应当产生稳定的切片标识。",
    metadata: {},
    createdAt: new Date(0),
  }

  const first = await chunker.chunk(document)
  const second = await chunker.chunk(document)

  assert.deepEqual(first.map((chunk) => chunk.id), second.map((chunk) => chunk.id))
})

test("changed document versions receive distinct chunk ids", async () => {
  const chunker = new RecursiveChunker()
  const document = (id: string, version: number): Document => ({
    id,
    sourceId: "source-1",
    contentHash: `hash-${version}`,
    version,
    title: "test",
    source: "test",
    content: "同一规范化内容在新版本中必须具有新的切片身份。",
    metadata: {},
    createdAt: new Date(0),
  })

  const first = await chunker.chunk(document("doc-v1", 1))
  const second = await chunker.chunk(document("doc-v2", 2))

  assert.notDeepEqual(first.map(({ id }) => id), second.map(({ id }) => id))
})

test("does not reuse ids for a shared chunk in different content", async () => {
  const chunker = new RecursiveChunker()
  const shared = "a".repeat(1000)
  const document = (id: string, tail: string): Document => ({
    id,
    sourceId: `source-${id}`,
    contentHash: `hash-${id}`,
    version: 1,
    title: "test",
    source: "test",
    content: `${shared}\n\n${tail.repeat(1000)}`,
    metadata: {},
    createdAt: new Date(0),
  })

  const first = await chunker.chunk(document("first", "b"))
  const second = await chunker.chunk(document("second", "c"))

  assert.notEqual(first[0].id, second[0].id)
})

test("consumes normalized blocks without discarding their structure", async () => {
  const chunker = new RecursiveChunker()
  const document: Document = {
    id: "doc-v1",
    sourceId: "source-v1",
    contentHash: "hash-v1",
    version: 1,
    title: "Policy",
    source: "policy.docx",
    content: "",
    metadata: {},
    createdAt: new Date(0),
  }
  const blocks = normalizeMarkItDown(
    "# Policy\n\n| Region | Window |\n| --- | --- |\n| CN | 30 days |",
    document.id
  )
  const chunks = await chunker.chunk(document, blocks)
  const normalizedBlocks = chunks[0].metadata.normalizedBlocks as Array<{
    id: string
    type: string
    headingLevel?: number
    sectionPath: string[]
    table?: Record<string, unknown>
    metadata: Record<string, unknown>
    provenance: Record<string, unknown>
  }>

  assert.equal(chunks.filter((chunk) => chunk.metadata.kind === "child").length, 1)
  assert.equal(chunks[0].metadata.sourceId, document.sourceId)
  assert.equal(chunks[0].metadata.documentVersion, document.version)
  assert.deepEqual(normalizedBlocks.map(({ id }) => id), blocks.map(({ id }) => id))
  assert.deepEqual(normalizedBlocks.map(({ type }) => type), ["heading", "table"])
  assert.equal(normalizedBlocks[0].headingLevel, 1)
  assert.deepEqual(normalizedBlocks[1].sectionPath, ["Policy"])
  assert.deepEqual(normalizedBlocks[1].table, {
    headers: ["Region", "Window"],
    rows: [["CN", "30 days"]],
  })
  assert.deepEqual(normalizedBlocks[1].provenance, {
    parser: "markitdown",
    adapter: "cli",
  })
  assert.deepEqual(normalizedBlocks[1].metadata, blocks[1].metadata)

  const equationBlocks = normalizeMinerU([{
    type: "equation",
    img_path: "images/equation.jpg",
    page_idx: 0,
  }], document.id)
  const equationChunks = await chunker.chunk(document, equationBlocks)
  const equationMetadata = equationChunks[0].metadata.normalizedBlocks as Array<{
    metadata: Record<string, unknown>
  }>
  assert.deepEqual(equationMetadata[0].metadata, {
    mineruType: "equation",
    method: "ocr",
    ocr: true,
    sourceReference: "images/equation.jpg",
  })

  const longText = "x ".repeat(1_600)
  const longBlocks = normalizeMarkItDown(longText, document.id)
  const longChunks = await chunker.chunk(document, longBlocks)
  assert.equal(
    longChunks
      .filter((chunk) => chunk.metadata.kind === "child")
      .map(({ content }) => content)
      .join(""),
    longBlocks[0].text
  )
  assert.ok(longChunks
    .filter((chunk) => chunk.metadata.kind === "child")
    .every(({ content }) => content.length <= 1500))

  const boundaryFreeBlocks = normalizeMarkItDown("x".repeat(1_600), document.id)
  await assert.rejects(
    chunker.chunk(document, boundaryFreeBlocks),
    /safe semantic boundary/
  )

  const largeTable: NormalizedBlock = {
    ...longBlocks[0],
    type: "table",
    table: {
      headers: ["Value"],
      rows: Array.from({ length: 200 }, (_, index) => [`row-${index}`]),
    },
  }
  const tableChunks = await chunker.chunk(document, [largeTable])
  const tableMetadata = tableChunks.flatMap((chunk) =>
    chunk.metadata.normalizedBlocks as Array<{
      id: string
      continuation?: boolean
      table?: Record<string, unknown>
    }>
  )
  assert.equal(tableMetadata.filter(({ table }) => table).length, 1)
  assert.ok(tableMetadata.slice(1).every(({ id, continuation, table }) =>
    id === largeTable.id && continuation === true && table === undefined
  ))
})

test("low-similarity normalized blocks form separate child passages", async () => {
  const chunker = new RecursiveChunker()
  const document: Document = {
    id: "doc-similarity-v1",
    sourceId: "source-similarity",
    contentHash: "hash-similarity",
    version: 1,
    title: "Policy",
    source: "policy.md",
    content: "",
    metadata: {},
    createdAt: new Date(0),
  }
  const blocks = normalizeMarkItDown(
    `# Policy\n\n${"refund order window ".repeat(15)}\n\n${"shipping carrier route ".repeat(15)}`,
    document.id
  )

  const chunks = await chunker.chunk(document, blocks)
  const children = chunks.filter((chunk) => chunk.metadata.kind === "child")

  assert.equal(children.length, 2)
  assert.equal(children[0].content.includes("refund order window"), true)
  assert.equal(children[0].content.includes("shipping carrier route"), false)
  assert.equal(children[1].content.includes("shipping carrier route"), true)
})

test("creates stable image chunks linked to nearby text and document location", async () => {
  const chunker = new RecursiveChunker()
  const document: Document = {
    id: "scan-v1",
    sourceId: "scan-source",
    contentHash: "scan-hash",
    version: 1,
    title: "Refund guide",
    source: "refund.pdf",
    content: "",
    metadata: {},
    createdAt: new Date(0),
  }
  const blocks = normalizeMinerU([
    { type: "text", text: "退款流程", text_level: 1, page_idx: 0 },
    { type: "text", text: "用户先提交订单号。", page_idx: 1 },
    {
      type: "image",
      img_path: "images/refund.jpg",
      image_caption: ["退款流程图"],
      content: "审核通过后原路退款。",
      page_idx: 1,
    },
    { type: "text", text: "退款通常在三个工作日到账。", page_idx: 1 },
  ], document.id)
  Object.assign(blocks[2].image!, {
    assetId: "sha256:abc123",
    assetPath: "abc123.jpg",
  })

  const first = await chunker.chunk(document, blocks)
  const second = await chunker.chunk(document, blocks)
  const image = first.find((chunk) => chunk.metadata.kind === "image")

  assert.ok(image)
  assert.deepEqual(second.find((chunk) => chunk.metadata.kind === "image"), image)
  assert.equal(image.parentId, first.find((chunk) => chunk.metadata.kind === "parent")?.id)
  assert.match(image.content, /用户先提交订单号/)
  assert.match(image.content, /退款流程图/)
  assert.match(image.content, /三个工作日到账/)
  assert.deepEqual(image.metadata.image, {
    assetId: "sha256:abc123",
    assetPath: "abc123.jpg",
    sourceReference: "images/refund.jpg",
    captions: ["退款流程图"],
  })
  assert.equal(image.metadata.page, 2)
  assert.deepEqual(image.metadata.sectionPath, ["退款流程"])
})

test("image chunk identity ignores provider-local filenames for the same asset", async () => {
  const chunker = new RecursiveChunker()
  const document: Document = {
    id: "scan-stable-v1",
    sourceId: "scan-stable",
    contentHash: "scan-stable-hash",
    version: 1,
    title: "Refund guide",
    source: "refund.pdf",
    content: "",
    metadata: {},
    createdAt: new Date(0),
  }
  const createBlocks = (sourceReference: string, assetPath: string) => {
    const blocks = normalizeMinerU([{
      type: "image",
      img_path: sourceReference,
      image_caption: ["退款流程图"],
      page_idx: 0,
    }], document.id)
    Object.assign(blocks[0].image!, {
      assetId: `sha256:${"a".repeat(64)}`,
      assetPath,
    })
    return blocks
  }

  const first = await chunker.chunk(
    document,
    createBlocks("images/diagram.jpg", `${"a".repeat(64)}.jpg`)
  )
  const second = await chunker.chunk(
    document,
    createBlocks("images/renamed.png", `${"a".repeat(64)}.png`)
  )

  assert.equal(
    first.find(({ metadata }) => metadata.kind === "image")?.id,
    second.find(({ metadata }) => metadata.kind === "image")?.id
  )
})

test("parent child order keeps text passages on their side of an image", async () => {
  const chunker = new RecursiveChunker()
  const document: Document = {
    id: "scan-order-v1",
    sourceId: "scan-order",
    contentHash: "scan-order-hash",
    version: 1,
    title: "Refund guide",
    source: "refund.pdf",
    content: "",
    metadata: {},
    createdAt: new Date(0),
  }
  const blocks = normalizeMinerU([
    { type: "text", text: "图片前的说明。", page_idx: 0 },
    { type: "image", image_caption: ["退款流程图"], page_idx: 0 },
    { type: "text", text: "图片后的说明。", page_idx: 0 },
  ], document.id)

  const chunks = await chunker.chunk(document, blocks)
  const parent = chunks.find(({ metadata }) => metadata.kind === "parent")!
  const orderedKinds = parent.childrenIds.map((id) =>
    chunks.find((chunk) => chunk.id === id)?.metadata.kind
  )
  const textBlockIndexes = parent.childrenIds
    .map((id) => chunks.find((chunk) => chunk.id === id)!)
    .filter(({ metadata }) => metadata.kind === "child")
    .map(({ metadata }) =>
      (metadata.normalizedBlocks as Array<{ index: number }>).map(({ index }) => index)
    )

  assert.deepEqual(orderedKinds, ["child", "image", "child"])
  assert.deepEqual(textBlockIndexes, [[0], [2]])
})

test("semantic sections produce stable linked parent and child chunks", async () => {
  const chunker = new RecursiveChunker()
  const document: Document = {
    id: "doc-semantic-v1",
    sourceId: "source-semantic",
    contentHash: "hash-semantic",
    version: 1,
    title: "Refund policy",
    source: "policy.md",
    content: "",
    metadata: {},
    createdAt: new Date(0),
  }
  const blocks = normalizeMarkItDown(
    `# 退款\n\n${"退款申请需要订单号。".repeat(100)}\n\n# 换货\n\n换货申请需要商品照片。`,
    document.id
  )

  const first = await chunker.chunk(document, blocks)
  const second = await chunker.chunk(document, blocks)
  const parents = first.filter((chunk) => chunk.metadata.kind === "parent")
  const children = first.filter((chunk) => chunk.metadata.kind === "child")

  assert.equal(parents.length, 2)
  assert.equal(children.length >= 3, true)
  assert.deepEqual(first.map(({ id }) => id), second.map(({ id }) => id))
  for (const parent of parents) {
    const linked = children.filter((child) => child.parentId === parent.id)
    assert.deepEqual(parent.childrenIds, linked.map(({ id }) => id))
    assert.equal(linked.length > 0, true)
    assert.equal(linked.every((child) => child.content.length <= 1500), true)
    assert.equal(linked.every((child) =>
      JSON.stringify(child.metadata.sectionPath) === JSON.stringify(parent.metadata.sectionPath)
    ), true)
  }
  assert.equal(
    children.some((child) => child.content.includes("退款") && child.content.includes("换货")),
    false
  )
})

test("repeated non-consecutive sections keep unique parent identities", async () => {
  const chunker = new RecursiveChunker()
  const document: Document = {
    id: "doc-repeated-v1",
    sourceId: "source-repeated",
    contentHash: "hash-repeated",
    version: 1,
    title: "Repeated sections",
    source: "repeated.md",
    content: "",
    metadata: {},
    createdAt: new Date(0),
  }
  const blocks = normalizeMarkItDown(
    "# A\n\nsame section\n\n# B\n\nmiddle\n\n# A\n\nsame section",
    document.id
  )

  const chunks = await chunker.chunk(document, blocks)
  const parents = chunks.filter((chunk) => chunk.metadata.kind === "parent")

  assert.equal(parents.length, 3)
  assert.equal(new Set(parents.map(({ id }) => id)).size, 3)
  assert.ok(parents.every((parent) => parent.childrenIds.every((childId) =>
    chunks.some((child) => child.id === childId && child.parentId === parent.id)
  )))
})
