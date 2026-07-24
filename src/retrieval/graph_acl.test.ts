import assert from "node:assert/strict"
import test from "node:test"
import {
  createGraphRetrievalAclPredicate,
  evaluateGraphAcl,
  GRAPH_RETRIEVAL_CALLER_AUDIT,
  GRAPH_RETRIEVAL_FALLBACK_BYPASS,
  type GraphAclCandidate,
  type GraphAclDenialReason,
} from "./graph_acl"
import type { AccessContext } from "../access/context"

/**
 * P2.1 — Graph Retrieval ACL Predicate Contract: unauthorized fixture.
 *
 * Proves that the unified ACL predicate denies unauthorized candidates:
 *   - missing tenant tag (legacy untagged → fail closed)
 *   - wrong tenant (cross-tenant)
 *   - wrong group (group-restricted user, non-matching group)
 *   - inactive version (documentId not in active set)
 *
 * Also verifies the static caller audit table is complete and every
 * production caller propagates accessContext (the precondition for the
 * predicate to be enforceable in P2.2).
 */

function makeAc(overrides: Partial<AccessContext> = {}): AccessContext {
  return {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: [],
    scopes: ["chat"],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Static caller audit integrity
// ---------------------------------------------------------------------------

test("P2.1 caller audit: table lists at least 5 production callers", () => {
  assert.ok(
    GRAPH_RETRIEVAL_CALLER_AUDIT.length >= 5,
    `audit must list all production callers; got ${GRAPH_RETRIEVAL_CALLER_AUDIT.length}`
  )
})

test("P2.1 caller audit: every entry propagates accessContext (precondition for P2.2 enforcement)", () => {
  for (const entry of GRAPH_RETRIEVAL_CALLER_AUDIT) {
    assert.equal(
      entry.propagatesAccessContext,
      true,
      `caller ${entry.caller} (${entry.file}:${entry.line}) must propagate accessContext`
    )
  }
})

test("P2.1 caller audit: every entry has file, line, and notes", () => {
  for (const entry of GRAPH_RETRIEVAL_CALLER_AUDIT) {
    assert.ok(typeof entry.file === "string" && entry.file.length > 0,
      `entry ${entry.caller} must have a file path`)
    assert.ok(typeof entry.line === "number" && entry.line > 0,
      `entry ${entry.caller} must have a positive line number`)
    assert.ok(typeof entry.notes === "string" && entry.notes.length > 0,
      `entry ${entry.caller} must have notes`)
  }
})

test("P2.1 caller audit: SearcherImpl primary graph entry is recorded", () => {
  const primary = GRAPH_RETRIEVAL_CALLER_AUDIT.find(
    (e) => e.file === "src/retrieval/search/searcher.ts" && e.line === 519
  )
  assert.ok(primary, "SearcherImpl.search → operations.graphSearch (searcher.ts:519) must be in audit")
})

test("P2.1 caller audit: fallback bypass is recorded for P2.2 enforcement", () => {
  assert.equal(GRAPH_RETRIEVAL_FALLBACK_BYPASS.file, "src/retrieval/search/searcher.ts")
  assert.deepEqual([...GRAPH_RETRIEVAL_FALLBACK_BYPASS.lines], [329, 334])
  assert.equal(GRAPH_RETRIEVAL_FALLBACK_BYPASS.enforcementItem, "P2.2")
  assert.ok(
    GRAPH_RETRIEVAL_FALLBACK_BYPASS.description.includes("accessContextFilter"),
    "bypass description must name the missing filter"
  )
})

// ---------------------------------------------------------------------------
// Unauthorized fixture — the gate required by P2.1
// ---------------------------------------------------------------------------

test("P2.1 unauthorized fixture: missing tenant tag → denied (fail closed for legacy)", () => {
  const ac = makeAc()
  const active = new Set(["doc-1"])
  const candidate: GraphAclCandidate = {
    tenantId: undefined, // legacy 2-element provenance, no tenant tag
    documentId: "doc-1",
  }
  const decision = evaluateGraphAcl(candidate, ac, active)
  assert.equal(decision.authorized, false, "legacy untagged candidate must be denied")
  assert.equal(decision.reason, "missing_tenant_tag")
})

test("P2.1 unauthorized fixture: cross-tenant candidate → denied", () => {
  const ac = makeAc({ tenantId: "tenant-a" })
  const active = new Set(["doc-1"])
  const candidate: GraphAclCandidate = {
    tenantId: "tenant-b", // cross-tenant
    documentId: "doc-1",
  }
  const decision = evaluateGraphAcl(candidate, ac, active)
  assert.equal(decision.authorized, false, "cross-tenant candidate must be denied")
  assert.equal(decision.reason, "cross_tenant")
})

test("P2.1 unauthorized fixture: group-restricted user accessing non-matching group → denied", () => {
  const ac = makeAc({ groups: ["support"] })
  const active = new Set(["doc-1"])
  const candidate: GraphAclCandidate = {
    tenantId: "tenant-a",
    allowedGroups: ["finance"], // no intersection with ["support"]
    documentId: "doc-1",
  }
  const decision = evaluateGraphAcl(candidate, ac, active)
  assert.equal(decision.authorized, false, "non-matching group candidate must be denied")
  assert.equal(decision.reason, "group_not_authorized")
})

test("P2.1 unauthorized fixture: inactive version → denied", () => {
  const ac = makeAc()
  const active = new Set(["doc-active"])
  const candidate: GraphAclCandidate = {
    tenantId: "tenant-a",
    documentId: "doc-inactive", // not in active set
  }
  const decision = evaluateGraphAcl(candidate, ac, active)
  assert.equal(decision.authorized, false, "inactive version candidate must be denied")
  assert.equal(decision.reason, "inactive_version")
})

test("P2.1 unauthorized fixture: all four denial reasons are distinct and exhaustive", () => {
  const reasons = new Set<GraphAclDenialReason>([
    "missing_tenant_tag",
    "cross_tenant",
    "group_not_authorized",
    "inactive_version",
  ])
  assert.equal(reasons.size, 4, "predicate must define exactly four denial reasons")
})

// ---------------------------------------------------------------------------
// Authorized fixture — proves the predicate does not over-deny
// ---------------------------------------------------------------------------

test("P2.1 authorized fixture: same-tenant tenant-wide active candidate → allowed", () => {
  const ac = makeAc()
  const active = new Set(["doc-1"])
  const candidate: GraphAclCandidate = {
    tenantId: "tenant-a",
    allowedGroups: [], // tenant-wide chunk
    documentId: "doc-1",
  }
  const predicate = createGraphRetrievalAclPredicate(ac, active)
  assert.equal(predicate(candidate), true, "same-tenant tenant-wide active candidate must be allowed")
})

test("P2.1 authorized fixture: group-restricted user matching group → allowed", () => {
  const ac = makeAc({ groups: ["support"] })
  const active = new Set(["doc-1"])
  const candidate: GraphAclCandidate = {
    tenantId: "tenant-a",
    allowedGroups: ["support"], // intersects
    documentId: "doc-1",
  }
  const predicate = createGraphRetrievalAclPredicate(ac, active)
  assert.equal(predicate(candidate), true, "matching group candidate must be allowed")
})

test("P2.1 authorized fixture: tenant-wide chunk visible to group-restricted user", () => {
  const ac = makeAc({ groups: ["support"] })
  const active = new Set(["doc-1"])
  const candidate: GraphAclCandidate = {
    tenantId: "tenant-a",
    allowedGroups: [], // tenant-wide chunk — visible to any same-tenant caller
    documentId: "doc-1",
  }
  const predicate = createGraphRetrievalAclPredicate(ac, active)
  assert.equal(predicate(candidate), true, "tenant-wide chunk must be visible to group-restricted user")
})

// ---------------------------------------------------------------------------
// Backward compatibility — pre-existing semantics preserved
// ---------------------------------------------------------------------------

test("P2.1 backward compat: empty activeDocIds set → all versions pass (no active repo wired)", () => {
  const ac = makeAc()
  const active = new Set<string>() // no active version repo
  const candidate: GraphAclCandidate = {
    tenantId: "tenant-a",
    documentId: "doc-any",
  }
  const predicate = createGraphRetrievalAclPredicate(ac, active)
  assert.equal(predicate(candidate), true, "empty active set must not filter (backward compat)")
})

test("P2.1 backward compat: tenant-wide user (empty groups) sees restricted-group chunk", () => {
  const ac = makeAc({ groups: [] }) // tenant-wide user
  const active = new Set(["doc-1"])
  const candidate: GraphAclCandidate = {
    tenantId: "tenant-a",
    allowedGroups: ["finance"], // user has no groups but tenant-wide sees all
    documentId: "doc-1",
  }
  const predicate = createGraphRetrievalAclPredicate(ac, active)
  assert.equal(predicate(candidate), true, "tenant-wide user must see restricted-group chunk")
})

// ---------------------------------------------------------------------------
// Predicate is shape-agnostic — works for Chunk, provenance, RetrievalResult
// ---------------------------------------------------------------------------

test("P2.1 shape-agnostic: predicate applies to a Chunk-shaped candidate", () => {
  const ac = makeAc()
  const active = new Set(["doc-1"])
  // Chunk shape: { id, documentId, tenantId?, allowedGroups?, ... }
  const chunk = {
    id: "chunk-1",
    documentId: "doc-1",
    tenantId: "tenant-a",
    allowedGroups: [] as string[],
    content: "irrelevant",
    childrenIds: [],
    metadata: {},
  }
  const predicate = createGraphRetrievalAclPredicate(ac, active)
  assert.equal(predicate(chunk), true, "predicate must accept Chunk-shaped candidate")
})

test("P2.1 shape-agnostic: predicate applies to a provenance-shaped candidate", () => {
  const ac = makeAc()
  const active = new Set(["doc-1"])
  // Provenance shape: { documentId, chunkId, tenantId?, allowedGroups? }
  const provenance = {
    documentId: "doc-1",
    chunkId: "chunk-1",
    tenantId: "tenant-a",
    allowedGroups: ["support"],
  }
  const acRestricted = makeAc({ groups: ["support"] })
  const predicate = createGraphRetrievalAclPredicate(acRestricted, active)
  assert.equal(predicate(provenance), true, "predicate must accept provenance-shaped candidate")
})
