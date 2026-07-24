import assert from "node:assert/strict"
import test from "node:test"
import { openDb } from "./db"
import { PageIndexRepository } from "./page_index_repo"
import type { PageIndexNode } from "../../types"

/**
 * Ticket 06 P3: page_index_nodes carries access metadata (tenantId/allowedGroups)
 * inherited from the Document. SQLite columns are NOT NULL DEFAULT so legacy
 * callers that omit the fields still get 'default' / '[]'; the pipeline passes
 * real values from document.tenantId/allowedGroups.
 */

function makeRepo() {
  const db = openDb(":memory:")
  return { db, repo: new PageIndexRepository(db) }
}

function sampleNode(documentId: string, nodeId = "node-1"): PageIndexNode {
  return {
    documentId,
    nodeId,
    title: `Section ${nodeId}`,
    sectionPath: ["root", nodeId],
    pageStart: 1,
    pageEnd: 2,
    summary: "summary",
    parentId: null,
    childIds: [],
    linkedChunkIds: ["chunk-1"],
  }
}

test("Ticket 06 P3: openDb migration adds tenant_id/allowed_groups columns to page_index_nodes with correct DEFAULTs", () => {
  const db = openDb(":memory:")
  try {
    const columns = db.pragma("table_info(page_index_nodes)") as Array<{
      name: string
      notnull: number
      dflt_value: string | null
    }>
    const tenantCol = columns.find((col) => col.name === "tenant_id")
    const groupsCol = columns.find((col) => col.name === "allowed_groups")
    assert.ok(tenantCol, "tenant_id column must exist after openDb migration")
    assert.ok(groupsCol, "allowed_groups column must exist after openDb migration")
    assert.equal(tenantCol!.notnull, 1, "tenant_id must be NOT NULL")
    assert.equal(groupsCol!.notnull, 1, "allowed_groups must be NOT NULL")
    assert.equal(tenantCol!.dflt_value, "'default'", "tenant_id DEFAULT must be 'default'")
    assert.equal(groupsCol!.dflt_value, "'[]'", "allowed_groups DEFAULT must be '[]'")
  } finally {
    db.close()
  }
})

test("Ticket 06 P3: replaceNodes() without accessMetadata falls back to DEFAULT 'default' / '[]'", () => {
  const { db, repo } = makeRepo()
  try {
    repo.replaceNodes("doc-p3-defaults", [sampleNode("doc-p3-defaults")])
    const row = db.prepare(
      `SELECT tenant_id, allowed_groups FROM page_index_nodes WHERE document_id = ?`
    ).get("doc-p3-defaults") as { tenant_id: string; allowed_groups: string }
    assert.equal(row.tenant_id, "default")
    assert.equal(row.allowed_groups, "[]")
  } finally {
    db.close()
  }
})

test("Ticket 06 P3: replaceNodes() with accessMetadata writes the provided tenantId/allowedGroups", () => {
  const { db, repo } = makeRepo()
  try {
    repo.replaceNodes("doc-p3-explicit", [sampleNode("doc-p3-explicit")], {
      tenantId: "tenant-acme",
      allowedGroups: ["ops", "support"],
    })
    const row = db.prepare(
      `SELECT tenant_id, allowed_groups FROM page_index_nodes WHERE document_id = ?`
    ).get("doc-p3-explicit") as { tenant_id: string; allowed_groups: string }
    assert.equal(row.tenant_id, "tenant-acme")
    assert.deepEqual(JSON.parse(row.allowed_groups), ["ops", "support"])
  } finally {
    db.close()
  }
})

test("Ticket 06 P3: replaceNodes() applies accessMetadata to every node in the batch", () => {
  const { db, repo } = makeRepo()
  try {
    repo.replaceNodes(
      "doc-p3-batch",
      [
        sampleNode("doc-p3-batch", "node-a"),
        sampleNode("doc-p3-batch", "node-b"),
        sampleNode("doc-p3-batch", "node-c"),
      ],
      { tenantId: "tenant-batch", allowedGroups: ["readers"] }
    )
    const rows = db.prepare(
      `SELECT tenant_id, allowed_groups FROM page_index_nodes WHERE document_id = ? ORDER BY node_id`
    ).all("doc-p3-batch") as Array<{ tenant_id: string; allowed_groups: string }>
    assert.equal(rows.length, 3)
    for (const row of rows) {
      assert.equal(row.tenant_id, "tenant-batch")
      assert.deepEqual(JSON.parse(row.allowed_groups), ["readers"])
    }
  } finally {
    db.close()
  }
})

test("Ticket 06 P3: getNodesByDocument() returns PageIndexNode with tenantId/allowedGroups populated", () => {
  const { repo, db } = makeRepo()
  try {
    repo.replaceNodes("doc-p3-get", [sampleNode("doc-p3-get")], {
      tenantId: "tenant-beta",
      allowedGroups: ["readers", "writers"],
    })
    const nodes = repo.getNodesByDocument("doc-p3-get")
    assert.equal(nodes.length, 1)
    assert.equal(nodes[0].tenantId, "tenant-beta")
    assert.deepEqual(nodes[0].allowedGroups, ["readers", "writers"])
  } finally {
    db.close()
  }
})

test("Ticket 06 P3: getNodesByDocument() returns DEFAULT access metadata when replaceNodes omitted it", () => {
  const { repo, db } = makeRepo()
  try {
    repo.replaceNodes("doc-p3-get-defaults", [sampleNode("doc-p3-get-defaults")])
    const nodes = repo.getNodesByDocument("doc-p3-get-defaults")
    assert.equal(nodes.length, 1)
    assert.equal(nodes[0].tenantId, "default")
    assert.deepEqual(nodes[0].allowedGroups, [])
  } finally {
    db.close()
  }
})

test("Ticket 06 P3: searchNodes() returns PageIndexNode with access metadata populated", () => {
  const { repo, db } = makeRepo()
  try {
    repo.replaceNodes("doc-p3-search", [sampleNode("doc-p3-search")], {
      tenantId: "tenant-gamma",
      allowedGroups: ["searchers"],
    })
    const nodes = repo.searchNodes("Section", 10)
    assert.ok(nodes.length >= 1, "search must find the seeded node")
    const found = nodes.find((n) => n.documentId === "doc-p3-search")
    assert.ok(found, "seeded node must be in search results")
    assert.equal(found!.tenantId, "tenant-gamma")
    assert.deepEqual(found!.allowedGroups, ["searchers"])
  } finally {
    db.close()
  }
})

test("Ticket 06 P3: replaceNodes() overwrites previous access metadata on re-replace (immutability = no UPDATE, but DELETE+INSERT is allowed)", () => {
  const { repo, db } = makeRepo()
  try {
    repo.replaceNodes("doc-p3-replace", [sampleNode("doc-p3-replace")], {
      tenantId: "tenant-old",
      allowedGroups: ["old"],
    })
    repo.replaceNodes("doc-p3-replace", [sampleNode("doc-p3-replace", "node-2")], {
      tenantId: "tenant-new",
      allowedGroups: ["new"],
    })
    const nodes = repo.getNodesByDocument("doc-p3-replace")
    assert.equal(nodes.length, 1)
    assert.equal(nodes[0].nodeId, "node-2")
    assert.equal(nodes[0].tenantId, "tenant-new")
    assert.deepEqual(nodes[0].allowedGroups, ["new"])
  } finally {
    db.close()
  }
})
