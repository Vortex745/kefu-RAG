/**
 * Ticket 11 Phase E P3 (spec §11 L1573-1575, L1580): CandidateReviewStore
 *
 * Verifies the document candidate review state machine:
 *
 * State machine (spec L1573, L1575):
 *   pending_review → approved    (approve: activate via DocumentRepo.activate)
 *   pending_review → rejected    (reject: preserve previous active version)
 *   approved → approved         (idempotent: no-op, returns current state)
 *   rejected → rejected         (idempotent: no-op, returns current state)
 *   approved → rejected          (CONFLICT → throws InvalidReviewConflictError → 409)
 *   rejected → approved         (CONFLICT → throws InvalidReviewConflictError → 409)
 *
 * Activation (spec L1575 "Approval activates the newest eligible candidate
 * using the existing activation-order protection"):
 *   - approve calls DocumentRepo.activate(docId) which uses activation_order
 *     comparison to determine if this doc should become the active version.
 *   - Older approved candidates do NOT overwrite newer active versions.
 *
 * Cross-tenant isolation (spec L1582):
 *   - getCandidate and review both scoped by tenant_id.
 *   - Cross-tenant → null (404, never reveals existence).
 */
import assert from "node:assert/strict"
import test from "node:test"
import { openDb, type DB } from "../ingestion/tracking/db"
import { DocumentRepo } from "../ingestion/tracking/doc_repo"
import {
  InvalidReviewConflictError,
  SqliteCandidateReviewStore,
  type ReviewResult,
} from "./candidate_review_store"

interface SetupDocArgs {
  docId: string
  sourceId?: string
  tenantId?: string
  candidateState?: "pending_review" | "approved" | "rejected"
  activationOrder?: number
  version?: number
  reviewedBy?: string | null
  reviewedAt?: string | null
  reviewReason?: string | null
  createdAt?: string
}

function setupDoc(db: DB, args: SetupDocArgs): void {
  const sourceId = args.sourceId ?? `src-${args.docId}`
  const tenantId = args.tenantId ?? "default"
  const createdAt = args.createdAt ?? "2026-07-18T00:00:00.000Z"
  // Insert source if not exists
  db.prepare(
    `INSERT OR IGNORE INTO sources (
      source_id, source_key, source_kind, source_uri, namespace,
      created_at, updated_at, tenant_id, lifecycle_state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`
  ).run(
    sourceId,
    `key-${sourceId}`,
    "file",
    `file:///tmp/${sourceId}.txt`,
    "local",
    createdAt,
    createdAt,
    tenantId
  )
  // Insert document with optional candidate_state (default 'approved' from
  // SCHEMA, but tests can override)
  if (args.candidateState) {
    db.prepare(
      `INSERT INTO documents (
        doc_id, source_id, content_hash, version, activation_order,
        title, source, content, status, created_at, updated_at,
        tenant_id, candidate_state, reviewed_by, reviewed_at, review_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      args.docId,
      sourceId,
      `hash-${args.docId}`,
      args.version ?? 1,
      args.activationOrder ?? 1,
      `Doc ${args.docId}`,
      `file:///tmp/${sourceId}.txt`,
      `content-${args.docId}`,
      createdAt,
      createdAt,
      tenantId,
      args.candidateState,
      args.reviewedBy ?? null,
      args.reviewedAt ?? null,
      args.reviewReason ?? null
    )
  } else {
    db.prepare(
      `INSERT INTO documents (
        doc_id, source_id, content_hash, version, activation_order,
        title, source, content, status, created_at, updated_at,
        tenant_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)`
    ).run(
      args.docId,
      sourceId,
      `hash-${args.docId}`,
      args.version ?? 1,
      args.activationOrder ?? 1,
      `Doc ${args.docId}`,
      `file:///tmp/${sourceId}.txt`,
      `content-${args.docId}`,
      createdAt,
      createdAt,
      tenantId
    )
  }
}

function getActiveDocId(db: DB, sourceId: string): string | null {
  const row = db.prepare(
    `SELECT active_doc_id FROM sources WHERE source_id = ?`
  ).get(sourceId) as { active_doc_id: string | null } | undefined
  return row?.active_doc_id ?? null
}

function setActiveDocId(db: DB, sourceId: string, docId: string | null): void {
  db.prepare(
    `UPDATE sources SET active_doc_id = ? WHERE source_id = ?`
  ).run(docId, sourceId)
}

test("P3 getCandidate: returns null for non-existent document", () => {
  const db = openDb(":memory:")
  try {
    const docRepo = new DocumentRepo(db)
    const store = new SqliteCandidateReviewStore(db, docRepo)
    assert.equal(store.getCandidate("missing-doc", "default"), null)
  } finally {
    db.close()
  }
})

test("P3 getCandidate: returns null for cross-tenant document", () => {
  const db = openDb(":memory:")
  try {
    setupDoc(db, { docId: "doc-a", tenantId: "tenant-a" })
    const docRepo = new DocumentRepo(db)
    const store = new SqliteCandidateReviewStore(db, docRepo)
    // Doc exists for tenant-a but we ask as tenant-b → null
    assert.equal(store.getCandidate("doc-a", "tenant-b"), null)
  } finally {
    db.close()
  }
})

test("P3 getCandidate: returns entry with default candidate_state='approved'", () => {
  const db = openDb(":memory:")
  try {
    setupDoc(db, { docId: "doc-1", tenantId: "default" })
    const docRepo = new DocumentRepo(db)
    const store = new SqliteCandidateReviewStore(db, docRepo)
    const entry = store.getCandidate("doc-1", "default")
    assert.ok(entry)
    assert.equal(entry!.docId, "doc-1")
    assert.equal(entry!.tenantId, "default")
    assert.equal(entry!.candidateState, "approved")
    assert.equal(entry!.reviewedBy, null)
    assert.equal(entry!.reviewedAt, null)
    assert.equal(entry!.reviewReason, null)
    assert.equal(entry!.activationOrder, 1)
  } finally {
    db.close()
  }
})

test("P3 review(approve) on pending_review: sets approved + reviewed fields", () => {
  const db = openDb(":memory:")
  try {
    setupDoc(db, { docId: "doc-2", tenantId: "default", candidateState: "pending_review" })
    const docRepo = new DocumentRepo(db)
    const store = new SqliteCandidateReviewStore(db, docRepo, () => new Date("2026-07-18T10:00:00.000Z"))
    const result = store.review("doc-2", "default", "approve", "LGTM", "reviewer@example.com")
    assert.ok(result)
    assert.equal(result!.docId, "doc-2")
    assert.equal(result!.tenantId, "default")
    assert.equal(result!.candidateState, "approved")
    assert.equal(result!.reviewedBy, "reviewer@example.com")
    assert.equal(result!.reviewedAt, "2026-07-18T10:00:00.000Z")
    assert.equal(result!.reviewReason, "LGTM")
  } finally {
    db.close()
  }
})

test("P3 review(reject) on pending_review: sets rejected + reviewed fields", () => {
  const db = openDb(":memory:")
  try {
    setupDoc(db, { docId: "doc-3", tenantId: "default", candidateState: "pending_review" })
    const docRepo = new DocumentRepo(db)
    const store = new SqliteCandidateReviewStore(db, docRepo, () => new Date("2026-07-18T11:00:00.000Z"))
    const result = store.review("doc-3", "default", "reject", "stale content", "reviewer@example.com")
    assert.ok(result)
    assert.equal(result!.candidateState, "rejected")
    assert.equal(result!.reviewedBy, "reviewer@example.com")
    assert.equal(result!.reviewedAt, "2026-07-18T11:00:00.000Z")
    assert.equal(result!.reviewReason, "stale content")
  } finally {
    db.close()
  }
})

test("P3 review(approve) on approved: idempotent (no-op, returns current state)", () => {
  const db = openDb(":memory:")
  try {
    setupDoc(db, {
      docId: "doc-4",
      tenantId: "default",
      candidateState: "approved",
      reviewedBy: "first@example.com",
      reviewedAt: "2026-07-18T09:00:00.000Z",
      reviewReason: "first review",
    })
    const docRepo = new DocumentRepo(db)
    const store = new SqliteCandidateReviewStore(db, docRepo, () => new Date("2026-07-18T12:00:00.000Z"))
    // Second approve with DIFFERENT actor/reason — should still be idempotent
    // (preserve FIRST review's fields, not overwrite with second call's)
    const result = store.review("doc-4", "default", "approve", "second review", "second@example.com")
    assert.ok(result)
    assert.equal(result!.candidateState, "approved")
    assert.equal(result!.reviewedBy, "first@example.com")  // preserved, NOT overwritten
    assert.equal(result!.reviewedAt, "2026-07-18T09:00:00.000Z")
    assert.equal(result!.reviewReason, "first review")
    assert.equal(result!.activatedAsActive, false)  // no-op, no activation
  } finally {
    db.close()
  }
})

test("P3 review(reject) on rejected: idempotent (no-op, returns current state)", () => {
  const db = openDb(":memory:")
  try {
    setupDoc(db, {
      docId: "doc-5",
      tenantId: "default",
      candidateState: "rejected",
      reviewedBy: "first@example.com",
      reviewedAt: "2026-07-18T08:00:00.000Z",
      reviewReason: "first reject",
    })
    const docRepo = new DocumentRepo(db)
    const store = new SqliteCandidateReviewStore(db, docRepo, () => new Date("2026-07-18T13:00:00.000Z"))
    const result = store.review("doc-5", "default", "reject", "second reject", "second@example.com")
    assert.ok(result)
    assert.equal(result!.candidateState, "rejected")
    assert.equal(result!.reviewedBy, "first@example.com")  // preserved
    assert.equal(result!.reviewedAt, "2026-07-18T08:00:00.000Z")
    assert.equal(result!.reviewReason, "first reject")
  } finally {
    db.close()
  }
})

test("P3 review(approve) on rejected: throws InvalidReviewConflictError (409)", () => {
  const db = openDb(":memory:")
  try {
    setupDoc(db, { docId: "doc-6", tenantId: "default", candidateState: "rejected" })
    const docRepo = new DocumentRepo(db)
    const store = new SqliteCandidateReviewStore(db, docRepo)
    assert.throws(
      () => store.review("doc-6", "default", "approve", "try again", "r@example.com"),
      (err: unknown) => {
        assert.ok(err instanceof InvalidReviewConflictError)
        assert.equal(err.docId, "doc-6")
        assert.equal(err.currentCandidateState, "rejected")
        assert.equal(err.requestedDecision, "approve")
        return true
      }
    )
  } finally {
    db.close()
  }
})

test("P3 review(reject) on approved: throws InvalidReviewConflictError (409)", () => {
  const db = openDb(":memory:")
  try {
    setupDoc(db, { docId: "doc-7", tenantId: "default", candidateState: "approved" })
    const docRepo = new DocumentRepo(db)
    const store = new SqliteCandidateReviewStore(db, docRepo)
    assert.throws(
      () => store.review("doc-7", "default", "reject", "reconsidered", "r@example.com"),
      InvalidReviewConflictError
    )
  } finally {
    db.close()
  }
})

test("P3 review: returns null for non-existent document (404)", () => {
  const db = openDb(":memory:")
  try {
    const docRepo = new DocumentRepo(db)
    const store = new SqliteCandidateReviewStore(db, docRepo)
    assert.equal(store.review("missing-doc", "default", "approve", "x", "r@example.com"), null)
  } finally {
    db.close()
  }
})

test("P3 review: returns null for cross-tenant document (404, no leak)", () => {
  const db = openDb(":memory:")
  try {
    setupDoc(db, { docId: "doc-8", tenantId: "tenant-a", candidateState: "pending_review" })
    const docRepo = new DocumentRepo(db)
    const store = new SqliteCandidateReviewStore(db, docRepo)
    // Doc exists for tenant-a but we ask as tenant-b → null (not 409)
    assert.equal(store.review("doc-8", "tenant-b", "approve", "x", "r@example.com"), null)
  } finally {
    db.close()
  }
})

test("P3 review(approve) on pending_review with newer activation_order: activates as active_doc_id", () => {
  const db = openDb(":memory:")
  try {
    // Source has existing active_doc_id pointing to older doc (v1, order=1)
    setupDoc(db, {
      docId: "doc-old",
      sourceId: "src-active",
      tenantId: "default",
      candidateState: "approved",
      activationOrder: 1,
      version: 1,
      createdAt: "2026-07-01T00:00:00.000Z",
    })
    // Newer pending_review doc (v2, order=2)
    setupDoc(db, {
      docId: "doc-new",
      sourceId: "src-active",
      tenantId: "default",
      candidateState: "pending_review",
      activationOrder: 2,
      version: 2,
      createdAt: "2026-07-18T00:00:00.000Z",
    })
    setActiveDocId(db, "src-active", "doc-old")
    const docRepo = new DocumentRepo(db)
    const store = new SqliteCandidateReviewStore(db, docRepo, () => new Date("2026-07-18T10:00:00.000Z"))
    const result = store.review("doc-new", "default", "approve", "LGTM", "r@example.com")
    assert.ok(result)
    assert.equal(result!.activatedAsActive, true)
    // Verify active_doc_id was updated to the newly approved doc
    assert.equal(getActiveDocId(db, "src-active"), "doc-new")
  } finally {
    db.close()
  }
})

test("P3 review(approve) on pending_review with OLDER activation_order: does NOT activate (preserves newer active)", () => {
  const db = openDb(":memory:")
  try {
    // Newer approved doc is already active (v2, order=2)
    setupDoc(db, {
      docId: "doc-new",
      sourceId: "src-stable",
      tenantId: "default",
      candidateState: "approved",
      activationOrder: 2,
      version: 2,
      createdAt: "2026-07-18T00:00:00.000Z",
    })
    // Older pending_review doc (v1, order=1) — approving it should NOT overwrite active
    setupDoc(db, {
      docId: "doc-old",
      sourceId: "src-stable",
      tenantId: "default",
      candidateState: "pending_review",
      activationOrder: 1,
      version: 1,
      createdAt: "2026-07-01T00:00:00.000Z",
    })
    setActiveDocId(db, "src-stable", "doc-new")
    const docRepo = new DocumentRepo(db)
    const store = new SqliteCandidateReviewStore(db, docRepo, () => new Date("2026-07-18T10:00:00.000Z"))
    const result = store.review("doc-old", "default", "approve", "retroactively approved", "r@example.com")
    assert.ok(result)
    assert.equal(result!.candidateState, "approved")
    assert.equal(result!.activatedAsActive, false)  // no activation (older)
    // Verify active_doc_id is STILL the newer doc
    assert.equal(getActiveDocId(db, "src-stable"), "doc-new")
  } finally {
    db.close()
  }
})

test("P3 review(reject) on pending_review: does NOT change active_doc_id (preserve previous active)", () => {
  const db = openDb(":memory:")
  try {
    setupDoc(db, {
      docId: "doc-current",
      sourceId: "src-reject",
      tenantId: "default",
      candidateState: "approved",
      activationOrder: 1,
      version: 1,
    })
    setupDoc(db, {
      docId: "doc-rejected",
      sourceId: "src-reject",
      tenantId: "default",
      candidateState: "pending_review",
      activationOrder: 2,
      version: 2,
    })
    setActiveDocId(db, "src-reject", "doc-current")
    const docRepo = new DocumentRepo(db)
    const store = new SqliteCandidateReviewStore(db, docRepo, () => new Date("2026-07-18T10:00:00.000Z"))
    const result = store.review("doc-rejected", "default", "reject", "bad content", "r@example.com")
    assert.ok(result)
    assert.equal(result!.candidateState, "rejected")
    assert.equal(result!.activatedAsActive, false)
    // Verify active_doc_id is STILL doc-current (preserved)
    assert.equal(getActiveDocId(db, "src-reject"), "doc-current")
  } finally {
    db.close()
  }
})

test("P3 review: persists reviewed fields in documents table (verify via SQL)", () => {
  const db = openDb(":memory:")
  try {
    setupDoc(db, { docId: "doc-persist", tenantId: "default", candidateState: "pending_review" })
    const docRepo = new DocumentRepo(db)
    const store = new SqliteCandidateReviewStore(db, docRepo, () => new Date("2026-07-18T14:30:00.000Z"))
    store.review("doc-persist", "default", "approve", "looks good", "reviewer@x.com")
    const row = db.prepare(
      `SELECT candidate_state, reviewed_by, reviewed_at, review_reason
       FROM documents WHERE doc_id = ?`
    ).get("doc-persist") as {
      candidate_state: string
      reviewed_by: string | null
      reviewed_at: string | null
      review_reason: string | null
    }
    assert.equal(row.candidate_state, "approved")
    assert.equal(row.reviewed_by, "reviewer@x.com")
    assert.equal(row.reviewed_at, "2026-07-18T14:30:00.000Z")
    assert.equal(row.review_reason, "looks good")
  } finally {
    db.close()
  }
})

test("P3 review: idempotent approve does NOT overwrite first review's fields", () => {
  const db = openDb(":memory:")
  try {
    setupDoc(db, {
      docId: "doc-idem",
      tenantId: "default",
      candidateState: "approved",
      reviewedBy: "first@x.com",
      reviewedAt: "2026-07-18T09:00:00.000Z",
      reviewReason: "first",
    })
    const docRepo = new DocumentRepo(db)
    const store = new SqliteCandidateReviewStore(db, docRepo, () => new Date("2026-07-18T15:00:00.000Z"))
    // Second approve with different actor/reason — should NOT overwrite
    store.review("doc-idem", "default", "approve", "second", "second@x.com")
    const row = db.prepare(
      `SELECT reviewed_by, reviewed_at, review_reason FROM documents WHERE doc_id = ?`
    ).get("doc-idem") as {
      reviewed_by: string | null
      reviewed_at: string | null
      review_reason: string | null
    }
    assert.equal(row.reviewed_by, "first@x.com")  // preserved
    assert.equal(row.reviewed_at, "2026-07-18T09:00:00.000Z")
    assert.equal(row.review_reason, "first")
  } finally {
    db.close()
  }
})

test("P3 ReviewResult: shape matches interface", () => {
  const db = openDb(":memory:")
  try {
    setupDoc(db, { docId: "doc-shape", tenantId: "default", candidateState: "pending_review" })
    const docRepo = new DocumentRepo(db)
    const store = new SqliteCandidateReviewStore(db, docRepo, () => new Date("2026-07-18T00:00:00.000Z"))
    const result: ReviewResult | null = store.review(
      "doc-shape",
      "default",
      "approve",
      "reason",
      "actor"
    )
    assert.ok(result)
    // Static type check — if shape is wrong, tsc fails
    const _staticCheck: ReviewResult = {
      docId: result!.docId,
      tenantId: result!.tenantId,
      candidateState: result!.candidateState,
      reviewedBy: result!.reviewedBy,
      reviewedAt: result!.reviewedAt,
      reviewReason: result!.reviewReason,
      activatedAsActive: result!.activatedAsActive,
    }
    assert.deepEqual(result, _staticCheck)
  } finally {
    db.close()
  }
})
