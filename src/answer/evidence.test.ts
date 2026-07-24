import assert from "node:assert/strict"
import test from "node:test"
import type { RetrievalResult } from "../types"
import { buildEvidence } from "./evidence"

function result(source: RetrievalResult["source"], weight: number): RetrievalResult {
  return {
    chunk: {
      id: "shared",
      documentId: "doc-v1",
      content: "shared evidence",
      childrenIds: [],
      metadata: { source: "policy.pdf" },
    },
    score: 1,
    source,
    wikilinks: [{
      sourceEntityId: "refund",
      targetEntityId: "policy",
      relation: "DEFINED_BY",
      weight,
    }],
  }
}

test("cross-query Evidence merging preserves later graph provenance", () => {
  const vector = result("vector", 0.2)
  const graph = result("graph", 0.9)
  graph.chunk.metadata.graphPath = ["Refund", "DEFINED_BY", "Policy"]

  const evidence = buildEvidence([vector, graph])
  assert.equal(evidence.length, 1)
  assert.deepEqual(evidence[0].channels, ["vector", "graph"])
  assert.deepEqual(evidence[0].graphPath, graph.chunk.metadata.graphPath)
  assert.equal(evidence[0].wikilinks[0].weight, 0.9)
})

test("image evidence preserves asset identity and exact document location", () => {
  const digest = "a".repeat(64)
  const image = result("vector", 0.5)
  image.chunk.id = "image-chunk"
  image.chunk.content = "退款流程图：审核通过后原路退款。"
  image.chunk.tenantId = "tenant-a"
  image.chunk.allowedGroups = ["support", "billing"]
  image.chunk.metadata = {
    kind: "image",
    title: "退款指南",
    source: "refund.pdf",
    documentVersion: 2,
    page: 4,
    sectionPath: ["售后", "退款"],
    image: {
      assetId: `sha256:${digest}`,
      assetPath: `${digest}.jpg`,
      sourceReference: "images/refund.jpg",
      captions: ["退款流程图"],
    },
  }

  const [evidence] = buildEvidence([image])

  assert.equal(evidence.page, 4)
  assert.deepEqual(evidence.sectionPath, ["售后", "退款"])
  assert.deepEqual(evidence.image, image.chunk.metadata.image)
  assert.equal(evidence.tenantId, "tenant-a")
  assert.deepEqual(evidence.allowedGroups, ["support", "billing"])
})
