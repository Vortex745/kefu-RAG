// Ticket 20 — Retrieval ACL and outage probe tests.
//
// TDD red phase: defines the expected behavior of retrievalAclOutageProbe
// BEFORE the implementation exists. Tests cover all 3 acceptance criteria:
//   #1 — Cross-tenant and unauthorized-group queries return no usable
//        Evidence across every retrieval channel.
//   #2 — A single Elasticsearch, Neo4j, or reranker failure reports explicit
//        degradation without bypassing ACL or Citation gates.
//   #3 — Total retrieval failure converges to one insufficient-evidence
//        terminal and never fabricates a grounded answer.
//
// Plus isolation + sanitization + failure-mode + live/deterministic split tests.

import assert from "node:assert/strict"
import test from "node:test"
import { retrievalAclOutageProbe, type RetrievalAclOutageProbeFixture } from "./retrieval_acl_outage_probe"
import { DETERMINISTIC_PROBE_IMPLEMENTATIONS } from "./deterministic_probes"
import type { ProbeContext } from "./smoke_harness"

const REVISION = "abc123def4567890abcdef1234567890abcdef12"
const ACCEPTANCE_TENANT = "acceptance-abc123def456"

function makeProbeContext(fixture: RetrievalAclOutageProbeFixture): ProbeContext {
  return {
    signal: new AbortController().signal,
    deadlineMs: 30_000,
    fixture,
  }
}

function makeBasicFixture(): RetrievalAclOutageProbeFixture {
  return {
    revision: REVISION,
    query: "What is the return policy for physical items?",
  }
}

// ---------------------------------------------------------------------------
// #1 — Cross-tenant and unauthorized-group queries return no usable Evidence
//      across every retrieval channel.
// ---------------------------------------------------------------------------

test("Ticket 20 #1: cross-tenant query returns no Evidence for foreign tenant docs", async () => {
  const result = await retrievalAclOutageProbe(makeProbeContext(makeBasicFixture()))

  assert.equal(result.ok, true, `probe must succeed; reason: ${result.reason ?? "n/a"}`)
  const outputs = result.outputs ?? {}
  const acl = outputs.acl as Record<string, unknown> | undefined
  assert.ok(acl, "acl scenario result must be present")

  // Cross-tenant isolation: no foreign tenant docIds in Evidence
  assert.equal(acl.crossTenantLeak, false, "no cross-tenant leak")
  const foreignDocIdsLeaked = acl.foreignDocIdsLeaked as string[]
  assert.ok(Array.isArray(foreignDocIdsLeaked), "foreignDocIdsLeaked must be an array")
  assert.equal(foreignDocIdsLeaked.length, 0, "no foreign tenant docIds leaked into Evidence")

  // Evidence docIds must all belong to the acceptance tenant
  const evidenceDocIds = acl.evidenceDocIds as string[]
  assert.ok(Array.isArray(evidenceDocIds), "evidenceDocIds must be an array")
  assert.ok(evidenceDocIds.length > 0, "authorized Evidence must be non-empty")
  for (const docId of evidenceDocIds) {
    assert.ok(docId.includes("tenant-a"), `Evidence docId '${docId}' must belong to tenant A`)
  }
})

test("Ticket 20 #2: unauthorized-group query returns no Evidence for group-restricted docs", async () => {
  const result = await retrievalAclOutageProbe(makeProbeContext(makeBasicFixture()))
  const acl = (result.outputs ?? {}).acl as Record<string, unknown>

  // Group filtering: group-restricted docs invisible to unauthorized group
  assert.equal(acl.groupFilterWorks, true, "group filtering must work")
  assert.equal(acl.unauthorizedGroupLeak, false, "no unauthorized-group leak")

  const groupRestrictedLeaked = acl.groupRestrictedLeaked as string[]
  assert.ok(Array.isArray(groupRestrictedLeaked), "groupRestrictedLeaked must be an array")
  assert.equal(groupRestrictedLeaked.length, 0, "no group-restricted docs leaked to unauthorized group")
})

// ---------------------------------------------------------------------------
// #3 — A single channel failure reports explicit degradation without
//      bypassing ACL or Citation gates.
// ---------------------------------------------------------------------------

test("Ticket 20 #3: single channel failure reports explicit degradation", async () => {
  const result = await retrievalAclOutageProbe(makeProbeContext(makeBasicFixture()))
  const degradation = (result.outputs ?? {}).degradation as Record<string, unknown>
  assert.ok(degradation, "degradation scenario result must be present")

  const unavailableChannels = degradation.unavailableChannels as string[]
  assert.ok(Array.isArray(unavailableChannels), "unavailableChannels must be an array")
  assert.ok(unavailableChannels.length > 0, "at least one channel must be reported unavailable")
  assert.ok(
    unavailableChannels.includes("graph"),
    "graph channel must be reported as the failed channel",
  )

  const survivingChannels = degradation.survivingChannels as string[]
  assert.ok(Array.isArray(survivingChannels), "survivingChannels must be an array")
  assert.ok(survivingChannels.length > 0, "at least one channel must survive")
})

test("Ticket 20 #4: degradation does not bypass ACL (no cross-tenant leak through surviving channels)", async () => {
  const result = await retrievalAclOutageProbe(makeProbeContext(makeBasicFixture()))
  const degradation = (result.outputs ?? {}).degradation as Record<string, unknown>

  assert.equal(degradation.aclEnforced, true, "ACL must be enforced on surviving channels")
  const leakedForeignDocIds = degradation.foreignDocIdsLeaked as string[]
  assert.ok(Array.isArray(leakedForeignDocIds), "foreignDocIdsLeaked must be an array")
  assert.equal(
    leakedForeignDocIds.length,
    0,
    "no foreign tenant leak through surviving channels",
  )
})

test("Ticket 20 #5: degradation does not bypass Citation gate (answer has references)", async () => {
  const result = await retrievalAclOutageProbe(makeProbeContext(makeBasicFixture()))
  const degradation = (result.outputs ?? {}).degradation as Record<string, unknown>

  assert.equal(degradation.citationsPresent, true, "Citation gate must not be bypassed")
  assert.ok(
    (degradation.referenceCount as number) > 0,
    "references must be present during degradation",
  )
})

// ---------------------------------------------------------------------------
// #6 — Total retrieval failure converges to one insufficient-evidence
//      terminal and never fabricates a grounded answer.
// ---------------------------------------------------------------------------

test("Ticket 20 #6: total retrieval failure converges to insufficient_retrieval terminal", async () => {
  const result = await retrievalAclOutageProbe(makeProbeContext(makeBasicFixture()))
  const totalFailure = (result.outputs ?? {}).totalFailure as Record<string, unknown>
  assert.ok(totalFailure, "totalFailure scenario result must be present")

  assert.equal(
    totalFailure.terminalStatus,
    "insufficient_retrieval",
    "must converge to insufficient_retrieval terminal",
  )
})

test("Ticket 20 #7: total failure never fabricates a grounded answer (no references)", async () => {
  const result = await retrievalAclOutageProbe(makeProbeContext(makeBasicFixture()))
  const totalFailure = (result.outputs ?? {}).totalFailure as Record<string, unknown>

  assert.equal(
    totalFailure.referenceCount,
    0,
    "no references (no fabricated grounded answer)",
  )
  assert.equal(
    totalFailure.fabricatedAnswer,
    false,
    "must not fabricate a grounded answer",
  )
})

// ---------------------------------------------------------------------------
// #8 — durationMs
// ---------------------------------------------------------------------------

test("Ticket 20 #8: probe returns durationMs", async () => {
  const result = await retrievalAclOutageProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(typeof result.durationMs, "number")
  assert.ok(result.durationMs >= 0)
})

// ---------------------------------------------------------------------------
// #9 — Failure modes
// ---------------------------------------------------------------------------

test("Ticket 20 #9: probe fails when fixture is missing", async () => {
  const result = await retrievalAclOutageProbe({
    signal: new AbortController().signal,
    deadlineMs: 30_000,
    fixture: undefined,
  })
  assert.equal(result.ok, false)
  assert.match(result.reason ?? "", /fixture/i)
})

test("Ticket 20 #10: probe fails when revision is missing", async () => {
  const result = await retrievalAclOutageProbe(
    makeProbeContext({
      revision: "",
      query: "test",
    }),
  )
  assert.equal(result.ok, false)
  assert.match(result.reason ?? "", /revision/i)
})

test("Ticket 20 #11: probe fails when query is empty", async () => {
  const result = await retrievalAclOutageProbe(
    makeProbeContext({
      revision: REVISION,
      query: "",
    }),
  )
  assert.equal(result.ok, false)
  assert.match(result.reason ?? "", /query/i)
})

// ---------------------------------------------------------------------------
// #12 — Isolation: acceptance tenant, never production default
// ---------------------------------------------------------------------------

test("Ticket 20 #12: probe uses isolated acceptance tenant — never production default", async () => {
  const result = await retrievalAclOutageProbe(makeProbeContext(makeBasicFixture()))
  const tenantId = (result.outputs ?? {}).tenantId as string
  assert.ok(tenantId.startsWith("acceptance-"), "tenantId must start with acceptance-")
  assert.notEqual(tenantId, "default", "must never use the production default tenant")
  assert.equal(tenantId, ACCEPTANCE_TENANT, "must use the revision-derived acceptance tenant")
})

// ---------------------------------------------------------------------------
// #13 — Live/deterministic split
// ---------------------------------------------------------------------------

test("Ticket 20 #13: probe NOT registered in DETERMINISTIC_PROBE_IMPLEMENTATIONS (live probe)", async () => {
  const keys = Object.keys(DETERMINISTIC_PROBE_IMPLEMENTATIONS)
  assert.ok(
    !keys.includes("retrievalAclOutage"),
    "retrievalAclOutage must not be a deterministic probe key",
  )
  assert.ok(
    !keys.includes("retrieval_acl_outage"),
    "retrieval_acl_outage must not be a deterministic probe key",
  )
})

// ---------------------------------------------------------------------------
// #14 — Outputs contain no passages/prompts/answer text/auth material
// ---------------------------------------------------------------------------

test("Ticket 20 #14: probe outputs contain NO passages, prompts, answer text, or auth material", async () => {
  const result = await retrievalAclOutageProbe(
    makeProbeContext({
      revision: REVISION,
      query: "SENSITIVE_QUERY_MARKER",
    }),
  )
  const json = JSON.stringify(result.outputs ?? {})
  assert.equal(
    json.includes("SENSITIVE_QUERY_MARKER"),
    false,
    "query text must not leak into outputs",
  )
  const forbidden = [
    "prompt",
    "passage",
    "answer_text",
    "reply_text",
    "Bearer",
    "authorization",
    "apiKey",
    "api_key",
    "password",
    "eyJ",
    "embedding",
  ]
  for (const term of forbidden) {
    assert.equal(
      json.toLowerCase().includes(term.toLowerCase()),
      false,
      `outputs must not contain '${term}'`,
    )
  }
})

// ---------------------------------------------------------------------------
// #15 — Outputs expose bounded keys only
// ---------------------------------------------------------------------------

test("Ticket 20 #15: probe outputs expose bounded keys only", async () => {
  const result = await retrievalAclOutageProbe(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}
  const allowedKeys = new Set([
    "ok",
    "acl",
    "degradation",
    "totalFailure",
    "tenantId",
  ])
  for (const key of Object.keys(outputs)) {
    assert.ok(allowedKeys.has(key), `unexpected output key: ${key}`)
  }
})

// ---------------------------------------------------------------------------
// #16 — Custom fixture revision derives a different acceptance tenant
// ---------------------------------------------------------------------------

test("Ticket 20 #16: probe with custom fixture revision uses the derived acceptance tenant", async () => {
  const result = await retrievalAclOutageProbe(
    makeProbeContext({
      revision: "xyz9876543210fedcba0987654321fedcba09876",
      query: "test query",
    }),
  )
  assert.equal(result.ok, true, `probe must succeed; reason: ${result.reason ?? "n/a"}`)
  const tenantId = (result.outputs ?? {}).tenantId as string
  assert.equal(tenantId, "acceptance-xyz987654321", "12-char prefix per TENANT_ID_LENGTH")
})
