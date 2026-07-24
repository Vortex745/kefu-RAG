import assert from "node:assert/strict"
import test from "node:test"
import type { Document } from "../types"
import type { Parser } from "./parser"
import { normalizeMarkItDown } from "./parser"
import { PipelineStageRunner } from "./pipeline"
import type { IngestionStageName, StageExecution } from "./lifecycle"
import type { IngestionStoreImpl } from "./storage"
import { openDb } from "./tracking"
import { DocumentRepo } from "./tracking/doc_repo"

class StopAfterChunk extends Error {}

test("the chunk stage records and persists the MarkItDown decision and normalized blocks", async () => {
  const db = openDb(":memory:")
  const documents = new DocumentRepo(db)
  documents.insert({
    docId: "doc-v1",
    sourceId: "source-v1",
    contentHash: "hash",
    version: 1,
    title: "Refund policy",
    source: "C:/knowledge/policy.docx",
    content: "",
    rawContent: Buffer.from("raw office bytes"),
    fileName: "policy.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  })
  const document = documents.get("doc-v1") as Document
  const parser: Parser = {
    type: "markitdown",
    async parse(input) {
      assert.deepEqual(input.content, Buffer.from("raw office bytes"))
      return normalizeMarkItDown(
        "# Refund policy\n\nRefunds are available within 30 days.",
        input.documentId
      )
    },
  }
  const runner = new PipelineStageRunner(db, (type) => {
    assert.equal(type, "markitdown")
    return parser
  })
  let chunkInput: Record<string, unknown> | undefined
  let chunkOutput: Record<string, unknown> | undefined
  const execution: StageExecution = {
    signal: new AbortController().signal,
    async runStage(name, input, operation, summarize) {
      const result = await operation()
      if (name === "chunk") {
        chunkInput = input
        chunkOutput = summarize(result)
        throw new StopAfterChunk("stop after chunk")
      }
      return result
    },
  }

  try {
    await assert.rejects(runner.run(document, execution), StopAfterChunk)
    assert.deepEqual(chunkInput, {
      contentLength: 16,
      fileName: "policy.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      parser: "markitdown",
      parserReason: "extension .docx is supported by MarkItDown",
    })
    assert.equal(chunkOutput?.parser, "markitdown")
    assert.equal(chunkOutput?.parserReason, "extension .docx is supported by MarkItDown")
    assert.equal(chunkOutput?.normalizedBlockCount, 2)
    assert.deepEqual(chunkOutput?.normalizedBlockTypes, ["heading", "paragraph"])
    assert.equal(chunkOutput?.chunkCount, 2)

    const metadata = documents.get("doc-v1")?.metadata as {
      system?: { parser?: Record<string, unknown> }
    }
    assert.deepEqual(metadata.system?.parser, {
      selected: "markitdown",
      reason: "extension .docx is supported by MarkItDown",
      normalizedBlockCount: 2,
      provenance: { parser: "markitdown", adapter: "cli" },
    })
  } finally {
    db.close()
  }
})

test("a parser failure still leaves its selection and reason in document metadata", async () => {
  const db = openDb(":memory:")
  const documents = new DocumentRepo(db)
  documents.insert({
    docId: "doc-failed",
    sourceId: "source-failed",
    contentHash: "hash",
    version: 1,
    title: "Broken policy",
    source: "C:/knowledge/broken.docx",
    content: "",
    rawContent: Buffer.from("broken"),
    fileName: "broken.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  })
  const parser: Parser = {
    type: "markitdown",
    async parse() {
      throw new Error("MarkItDown capability unavailable")
    },
  }
  const runner = new PipelineStageRunner(db, () => parser)
  const execution: StageExecution = {
    signal: new AbortController().signal,
    async runStage(_name, _input, operation) {
      return operation()
    },
  }

  try {
    await assert.rejects(
      runner.run(documents.get("doc-failed") as Document, execution),
      /capability unavailable/
    )
    const metadata = documents.get("doc-failed")?.metadata as {
      system?: { parser?: Record<string, unknown> }
    }
    assert.deepEqual(metadata.system?.parser, {
      selected: "markitdown",
      reason: "extension .docx is supported by MarkItDown",
    })
  } finally {
    db.close()
  }
})

test("the persistence stages inherit access metadata and reject missing metadata", async () => {
  const db = openDb(":memory:")
  const document: Document = {
    id: "doc-access",
    sourceId: "source-access",
    contentHash: "hash",
    version: 1,
    title: "Access policy",
    source: "memory",
    content: "Support policy content.",
    metadata: {},
    createdAt: new Date("2026-07-17T00:00:00.000Z"),
    tenantId: "tenant-a",
    allowedGroups: ["support"],
  }
  let chunkAccessMetadata: unknown
  let graphAccessMetadata: unknown
  const store = {
    async storeChunks(_chunks: unknown[], metadata: unknown) {
      chunkAccessMetadata = metadata
    },
    async storeEntities() {},
    async storeWikilinks(_wikilinks: unknown[], metadata: unknown) {
      graphAccessMetadata = metadata
    },
    async close() {},
  } as unknown as IngestionStoreImpl
  const runner = new PipelineStageRunner(db, undefined, store)
  const execution: StageExecution = {
    signal: new AbortController().signal,
    async runStage<T>(
      _name: IngestionStageName,
      _input: Record<string, unknown>,
      operation: () => Promise<T>
    ): Promise<T> {
      if (_name === "wikify") {
        return {
          entities: [],
          wikilinks: [{
            sourceEntityId: "refund",
            targetEntityId: "policy",
            relation: "DEFINED_BY",
            weight: 0.8,
            provenance: [{ documentId: document.id, chunkId: "chunk-1" }],
          }],
        } as T
      }
      return operation()
    },
  }

  try {
    await runner.run(document, execution)
    assert.deepEqual(chunkAccessMetadata, {
      tenantId: "tenant-a",
      allowedGroups: ["support"],
    })
    assert.deepEqual(graphAccessMetadata, {
      tenantId: "tenant-a",
      allowedGroups: ["support"],
    })
    await assert.rejects(
      runner.run({ ...document, tenantId: undefined, allowedGroups: undefined }, execution),
      /Document access metadata is required before chunk persistence/
    )
  } finally {
    db.close()
  }
})
