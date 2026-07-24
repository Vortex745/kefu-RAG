import assert from "node:assert/strict"
import test from "node:test"
import { openDb } from "./db"
import { DocumentRepo } from "./doc_repo"

/**
 * Ticket 06 P2: DocumentRepo writes access metadata (tenantId/allowedGroups)
 * inherited from the Source. SQLite columns are NOT NULL DEFAULT so legacy
 * callers that omit the fields still get 'default' / '[]'; new ingestion
 * passes real values queried from the source row.
 */

function makeRepo() {
  const db = openDb(":memory:")
  return { db, repo: new DocumentRepo(db) }
}

test("Ticket 06 P2: insert() without tenantId/allowedGroups falls back to DEFAULT 'default' / '[]'", () => {
  const { db, repo } = makeRepo()
  try {
    repo.insert({
      docId: "doc-p2-defaults",
      sourceId: "source-p2",
      contentHash: "hash-1",
      version: 1,
      title: "Defaults",
      source: "api",
      content: "content",
    })
    const row = db.prepare(
      `SELECT tenant_id, allowed_groups FROM documents WHERE doc_id = ?`
    ).get("doc-p2-defaults") as { tenant_id: string; allowed_groups: string }
    assert.equal(row.tenant_id, "default")
    assert.equal(row.allowed_groups, "[]")
  } finally {
    db.close()
  }
})

test("Ticket 06 P2: insert() with tenantId/allowedGroups writes the provided values", () => {
  const { db, repo } = makeRepo()
  try {
    repo.insert({
      docId: "doc-p2-explicit",
      sourceId: "source-p2-explicit",
      contentHash: "hash-2",
      version: 1,
      title: "Explicit",
      source: "api",
      content: "content",
      tenantId: "tenant-acme",
      allowedGroups: ["ops", "support"],
    })
    const row = db.prepare(
      `SELECT tenant_id, allowed_groups FROM documents WHERE doc_id = ?`
    ).get("doc-p2-explicit") as { tenant_id: string; allowed_groups: string }
    assert.equal(row.tenant_id, "tenant-acme")
    assert.deepEqual(JSON.parse(row.allowed_groups), ["ops", "support"])
  } finally {
    db.close()
  }
})

test("Ticket 06 P2: get() returns Document with tenantId/allowedGroups populated", () => {
  const { db, repo } = makeRepo()
  try {
    repo.insert({
      docId: "doc-p2-get",
      sourceId: "source-p2-get",
      contentHash: "hash-3",
      version: 1,
      title: "Get",
      source: "api",
      content: "content",
      tenantId: "tenant-beta",
      allowedGroups: ["readers"],
    })
    const document = repo.get("doc-p2-get")
    assert.ok(document, "document must exist")
    assert.equal(document!.tenantId, "tenant-beta")
    assert.deepEqual(document!.allowedGroups, ["readers"])
  } finally {
    db.close()
  }
})

test("Ticket 06 P2: getSourceByKey() returns SourceRecord with tenantId/allowedGroups", () => {
  const { db, repo } = makeRepo()
  try {
    repo.createSource({
      sourceId: "source-p2-key",
      sourceKey: "key-p2",
      kind: "submission",
      uri: "api://test",
      namespace: "default",
    })
    const source = repo.getSourceByKey("key-p2")
    assert.ok(source, "source must exist")
    assert.equal(source!.sourceId, "source-p2-key")
    assert.equal(source!.tenantId, "default")
    assert.deepEqual(source!.allowedGroups, [])
  } finally {
    db.close()
  }
})

test("Ticket 06 P2: createSource() returns SourceRecord with tenantId/allowedGroups from DEFAULT", () => {
  const { repo, db } = makeRepo()
  try {
    const source = repo.createSource({
      sourceId: "source-p2-create",
      sourceKey: "key-create",
      kind: "submission",
      uri: "api://create",
      namespace: "default",
    })
    assert.equal(source.sourceId, "source-p2-create")
    assert.equal(source.tenantId, "default")
    assert.deepEqual(source.allowedGroups, [])
  } finally {
    db.close()
  }
})
