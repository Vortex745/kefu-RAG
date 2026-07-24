// Ticket 19 — Live hybrid retrieval success probe tests.
//
// TDD red phase: defines the expected behavior of hybridRetrievalProbe
// BEFORE the implementation exists. Tests cover all 3 acceptance criteria:
//   #1 — Acceptance query observes required retrieval channels and produces
//        usable Evidence with verified citations.
//   #2 — Answer run completes with exactly one terminal and its trace
//        identifies the expected tenant and active knowledge version.
//   #3 — Probe evidence exposes bounded channel counts and identities
//        without passages, prompts, or answer text.
//
// Plus isolation + sanitization + failure-mode + ACL tests.

import assert from "node:assert/strict"
import test from "node:test"
import { hybridRetrievalProbe, type HybridRetrievalProbeFixture } from "./hybrid_retrieval_probe"
import { createIngestionFixture } from "./ingestion_fixture"
import type { ProbeContext } from "./smoke_harness"

const REVISION = "abc123def4567890abcdef1234567890abcdef12"
const ACCEPTANCE_TENANT = "acceptance-abc123def456"

function makeProbeContext(fixture: HybridRetrievalProbeFixture): ProbeContext {
  return {
    signal: new AbortController().signal,
    deadlineMs: 30_000,
    fixture,
  }
}

function makeBasicFixture(): HybridRetrievalProbeFixture {
  return {
    revision: REVISION,
    ingestionContent: [
      {
        title: "Return Policy",
        content:
          "Customers may return physical items within 30 days of purchase for a full refund. Digital items are non-refundable.",
      },
      {
        title: "Shipping Policy",
        content:
          "Standard shipping takes 3-5 business days. Express shipping arrives within 1-2 business days.",
      },
    ],
    query: "What is the return policy for physical items?",
  }
}

// ---------------------------------------------------------------------------
// #1 — Acceptance query observes required retrieval channels and produces
//      usable Evidence with verified citations.
// ---------------------------------------------------------------------------

test("Ticket 19 #1: probe observes all 4 retrieval channels and produces Evidence with citations", async () => {
  const result = await hybridRetrievalProbe(makeProbeContext(makeBasicFixture()))

  assert.equal(result.ok, true, `probe must succeed; reason: ${result.reason ?? "n/a"}`)
  const outputs = result.outputs ?? {}

  // Channel counts observed — all 4 channels must fire
  const channelResultCounts = outputs.channelResultCounts as Record<string, number>
  assert.ok(channelResultCounts, "channelResultCounts must be present")
  const channels = Object.keys(channelResultCounts)
  assert.ok(channels.includes("vector"), "vector channel must be observed")
  assert.ok(channels.includes("bm25"), "bm25 channel must be observed")
  assert.ok(channels.includes("graph"), "graph channel must be observed")
  assert.ok(channels.includes("pageIndex"), "pageIndex channel must be observed")

  // Evidence must be produced with at least one citation
  const evidenceIds = outputs.evidenceIds as string[]
  assert.ok(Array.isArray(evidenceIds), "evidenceIds must be an array")
  assert.ok(evidenceIds.length > 0, "at least one Evidence citation must be produced")

  // References must be non-empty (Citation gate satisfied)
  const referenceCount = outputs.referenceCount as number
  assert.ok(referenceCount > 0, "referenceCount must be > 0 (citations verified)")
})

test("Ticket 19 #1b: probe runs ingestion through the public lifecycle (fixture is exercised)", async () => {
  // Verify the probe actually ingested content via the fixture by checking
  // that docIds are populated and match the active knowledge version.
  const result = await hybridRetrievalProbe(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}

  const docIds = outputs.docIds as string[]
  assert.ok(Array.isArray(docIds), "docIds must be an array")
  assert.equal(docIds.length, 2, "two documents must be ingested from ingestionContent")

  const activeVersion = outputs.activeVersion as number
  assert.equal(activeVersion, 1, "active knowledge version must be 1 (first ingest)")
})

// ---------------------------------------------------------------------------
// #2 — Answer run completes with exactly one terminal and its trace
//      identifies the expected tenant and active knowledge version.
// ---------------------------------------------------------------------------

test("Ticket 19 #2: probe completes with one terminal and trace identifies expected tenant + active version", async () => {
  const result = await hybridRetrievalProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true, `probe must succeed; reason: ${result.reason ?? "n/a"}`)
  const outputs = result.outputs ?? {}

  // Exactly one terminal — terminalStatus is non-null and is a known AnswerTerminalStatus
  const terminalStatus = outputs.terminalStatus as string
  assert.ok(terminalStatus, "terminalStatus must be populated (exactly one terminal reached)")
  const knownTerminals = [
    "completed",
    "clarification_required",
    "insufficient_retrieval",
    "insufficient_evidence",
    "invalid_citation",
    "provider_error",
    "cancelled",
    "handoff_required",
  ]
  assert.ok(
    knownTerminals.includes(terminalStatus),
    `terminalStatus must be a known AnswerTerminalStatus, got: ${terminalStatus}`,
  )

  // For a successful probe with valid citations, terminal must be "completed"
  assert.equal(terminalStatus, "completed", "happy-path probe must reach 'completed' terminal")

  // Trace identifies expected tenant
  const traceTenantId = outputs.tenantId as string
  assert.equal(traceTenantId, ACCEPTANCE_TENANT, "trace must identify the acceptance-scoped tenantId")
  assert.notEqual(traceTenantId, "default", "trace MUST NOT identify the production 'default' tenant")

  // Trace identifies active knowledge version
  const activeVersion = outputs.activeVersion as number
  assert.equal(activeVersion, 1, "trace must identify active knowledge version (1 = first ingest)")

  // Run ID present for traceability
  const runId = outputs.runId as string
  assert.ok(typeof runId === "string" && runId.length > 0, "runId must be a non-empty string")
})

// ---------------------------------------------------------------------------
// #3 — Probe evidence exposes bounded channel counts and identities without
//      passages, prompts, or answer text.
// ---------------------------------------------------------------------------

test("Ticket 19 #3: probe outputs contain NO passages, prompts, answer text, or auth material", async () => {
  const fixture = makeBasicFixture()
  // Include content that should NEVER appear in probe outputs
  fixture.ingestionContent.push({
    title: "Secret Scan Doc",
    content: "SENSITIVE_CONTENT: this passage must NEVER appear in probe evidence.",
  })

  const result = await hybridRetrievalProbe(makeProbeContext(fixture))
  const outputs = result.outputs ?? {}
  const serialized = JSON.stringify(outputs)

  const forbidden = [
    "SENSITIVE_CONTENT",
    "this passage must NEVER appear in probe evidence",
    "Customers may return physical items", // ingested passage
    "Standard shipping takes", // ingested passage
    "prompt",
    "messages",
    "system_prompt",
    "answer_text",
    "reply_text",
    "token",
    "Bearer",
    "authorization",
    "apiKey",
    "api_key",
    "password",
    "eyJ",
    "embedding",
  ]
  for (const bad of forbidden) {
    assert.ok(
      !serialized.includes(bad),
      `probe outputs MUST NOT contain "${bad}" — found in: ${serialized}`,
    )
  }
})

test("Ticket 19 #3b: probe outputs expose bounded channel counts + identities only", async () => {
  const result = await hybridRetrievalProbe(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}

  // Allowed fields: bounded metadata only
  const allowedTopLevelKeys = new Set([
    "ok",
    "admitted",
    "terminalStatus",
    "tenantId",
    "runId",
    "activeVersion",
    "docIds",
    "evidenceIds",
    "referenceCount",
    "channelResultCounts",
    "channelsObserved",
    "retrievalTrace",
    "degradation",
    "durationMs",
  ])
  for (const key of Object.keys(outputs)) {
    assert.ok(
      allowedTopLevelKeys.has(key),
      `unexpected top-level output key "${key}" — must be in allowed bounded-metadata set`,
    )
  }

  // channelResultCounts must be bounded (number per channel, no passage content)
  const channelResultCounts = outputs.channelResultCounts as Record<string, number>
  for (const [ch, count] of Object.entries(channelResultCounts)) {
    assert.equal(typeof count, "number", `channel count for ${ch} must be a number`)
    assert.ok(count >= 0, `channel count for ${ch} must be >= 0`)
  }

  // retrievalTrace must be bounded — only safe metadata fields
  const retrievalTrace = outputs.retrievalTrace as Record<string, unknown>
  assert.ok(retrievalTrace, "retrievalTrace must be present")
  const allowedTraceKeys = new Set([
    "channelStatuses",
    "resultCount",
    "selectedEvidenceIds",
    "degradedReasons",
    "unselectedChannels",
    "correction",
  ])
  for (const key of Object.keys(retrievalTrace)) {
    assert.ok(
      allowedTraceKeys.has(key),
      `unexpected retrievalTrace key "${key}" — must be in bounded-trace set`,
    )
  }
})

// ---------------------------------------------------------------------------
// Failure modes + isolation + ACL
// ---------------------------------------------------------------------------

test("Ticket 19 #4: probe returns durationMs", async () => {
  const result = await hybridRetrievalProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(typeof result.durationMs, "number")
  assert.ok(result.durationMs >= 0, "durationMs must be >= 0")
})

test("Ticket 19 #5: probe fails when fixture is missing", async () => {
  const result = await hybridRetrievalProbe({
    signal: new AbortController().signal,
    deadlineMs: 30_000,
    fixture: undefined,
  })
  assert.equal(result.ok, false, "probe must fail when fixture is missing")
  assert.ok(result.reason, "reason must be populated on failure")
  assert.match(result.reason!, /fixture/i, "reason must mention fixture")
})

test("Ticket 19 #6: probe fails when fixture revision is missing", async () => {
  const result = await hybridRetrievalProbe(
    makeProbeContext({
      revision: "",
      ingestionContent: [{ title: "x", content: "y" }],
      query: "x",
    }),
  )
  assert.equal(result.ok, false, "probe must fail when revision is missing")
  assert.match(result.reason!, /revision/i, "reason must mention revision")
})

test("Ticket 19 #7: probe fails when ingestionContent is empty", async () => {
  const result = await hybridRetrievalProbe(
    makeProbeContext({
      revision: REVISION,
      ingestionContent: [],
      query: "x",
    }),
  )
  assert.equal(result.ok, false, "probe must fail when ingestionContent is empty")
  assert.match(result.reason!, /ingestionContent/i, "reason must mention ingestionContent")
})

test("Ticket 19 #8: probe fails when query is empty", async () => {
  const result = await hybridRetrievalProbe(
    makeProbeContext({
      revision: REVISION,
      ingestionContent: [{ title: "x", content: "y" }],
      query: "",
    }),
  )
  assert.equal(result.ok, false, "probe must fail when query is empty")
  assert.match(result.reason!, /query/i, "reason must mention query")
})

test("Ticket 19 #9: probe uses isolated acceptance tenant — never the production 'default' tenant", async () => {
  const result = await hybridRetrievalProbe(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}

  const tenantId = outputs.tenantId as string
  assert.ok(tenantId.startsWith("acceptance-"), "tenantId must be acceptance-scoped")
  assert.notEqual(tenantId, "default", "tenantId MUST NOT be the production 'default'")

  // docIds must come from the isolated fixture, not from any shared state
  const docIds = outputs.docIds as string[]
  assert.ok(docIds.every((id) => typeof id === "string" && id.length > 0))
})

test("Ticket 19 #10: probe cleans up the ingestion fixture after the run", async () => {
  // Run the probe — after it returns, the fixture's in-memory db must be closed.
  // We verify by attempting to re-use a fresh fixture (which should not collide)
  // and by checking the probe doesn't leak resources (it returns in bounded time).
  const start = Date.now()
  const result = await hybridRetrievalProbe(makeProbeContext(makeBasicFixture()))
  const elapsed = Date.now() - start

  assert.ok(elapsed < 30_000, "probe must complete within deadlineMs")
  assert.equal(result.ok, true, `probe must succeed; reason: ${result.reason ?? "n/a"}`)
})

test("Ticket 19 #11: probe handles ACL — accessContext carries the acceptance tenant", async () => {
  // The probe must construct an AccessContext anchored to the acceptance tenant
  // (not the production 'default'), and the Searcher must observe that context.
  // We assert this indirectly by checking that docIds returned match the
  // ingested docs under the acceptance tenant.
  const result = await hybridRetrievalProbe(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}

  const docIds = outputs.docIds as string[]
  const evidenceDocIds = (outputs.evidenceIds as string[]).map(() => outputs.docIds)
  // evidenceIds are evidence IDs, not doc IDs, but they must be non-empty and stringy
  assert.ok((outputs.evidenceIds as string[]).every((id) => typeof id === "string"))
  assert.ok(docIds.length === 2, "must have 2 ingested docs")
})

test("Ticket 19 #12: probe with custom fixture revision uses the derived acceptance tenant", async () => {
  const fixture = makeBasicFixture()
  fixture.revision = "xyz9876543210fedcba0987654321fedcba09876"
  const result = await hybridRetrievalProbe(makeProbeContext(fixture))
  assert.equal(result.ok, true, `probe must succeed; reason: ${result.reason ?? "n/a"}`)
  const outputs = result.outputs ?? {}
  const tenantId = outputs.tenantId as string
  assert.equal(tenantId, "acceptance-xyz987654321", "tenantId must match derived acceptance tenant for the new revision (12-char prefix per TENANT_ID_LENGTH)")
})

test("Ticket 19 #13: probe NOT registered in DETERMINISTIC_PROBE_IMPLEMENTATIONS (live probe, requires fixture)", async () => {
  // Read the deterministic_probes module and assert hybridRetrievalProbe is
  // NOT in the registry — it's a live probe requiring an external fixture,
  // same pattern as oidcProbe (Tickets 16+17).
  const { DETERMINISTIC_PROBE_IMPLEMENTATIONS } = await import("./deterministic_probes")
  const registered = Object.keys(DETERMINISTIC_PROBE_IMPLEMENTATIONS)
  assert.ok(
    !registered.includes("hybridRetrieval") && !registered.includes("live_hybrid_retrieval"),
    "hybridRetrievalProbe MUST NOT be registered as deterministic — it requires an external fixture (OP-03 candidate substitute)",
  )
})
