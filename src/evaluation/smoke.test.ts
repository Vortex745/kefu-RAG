// Ticket 10 Phase D P6 — Real dependency smoke gate tests.
//
// Spec §10 L1564-1569:
//   - Production readiness requires smoke cases for: MarkItDown, Marker,
//     MinerU, Elasticsearch vector + BM25 retrieval, Neo4j graph provenance,
//     PageIndex lookup, embedding provider, chat provider, cancellation,
//     and graceful shutdown (11 capabilities, +1 langfuse added by T13 = 12).
//   - Missing capabilities are allowed for local development but are not
//     accepted as a production release pass. The artifact records skipped
//     capability checks as failures for the production profile (L1567).
//   - Smoke fixtures are bounded, synthetic and committed without private
//     data. They verify observable outputs and identities, not provider-
//     internal logs (L1568).
//   - External outages must still produce the documented degraded or
//     insufficient terminal status and preserve trace convergence (L1569).
//
// Design: smoke.ts is a thin runner. It does NOT own fixtures or provider
// calls — callers inject a SmokeProbe per capability. The runner enforces
// profile semantics (local allows skip, production treats skip as failure).

import test from "node:test"
import assert from "node:assert/strict"

import type {
  EvaluationProfile,
  SmokeCapabilityKey,
  SmokeProbe,
  SmokeProbeBundle,
  SmokeResult,
} from "./types"
import { runSmokeCheck, runAllSmokeChecks, smokeGatePassed, CAPABILITY_ORDER } from "./smoke"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function passingProbe(): SmokeProbe {
  return async () => ({ ok: true, outputs: ["synthetic-output-id"] })
}

function failingProbe(reason: string): SmokeProbe {
  return async () => ({ ok: false, reason })
}

function failingProbeNoReason(): SmokeProbe {
  return async () => ({ ok: false })
}

function throwingProbe(message: string): SmokeProbe {
  return async () => {
    throw new Error(message)
  }
}

function throwingNonErrorProbe(value: string): SmokeProbe {
  // eslint-disable-next-line no-throw-literal
  return async () => {
    throw value // non-Error throw
  }
}

function slowProbe(delayMs: number): SmokeProbe {
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    return { ok: true }
  }
}

// ---------------------------------------------------------------------------
// runSmokeCheck — single capability
// ---------------------------------------------------------------------------

test("Ticket 10 P6: runSmokeCheck with passing probe returns status=passed and no reason", async () => {
  const result = await runSmokeCheck("markitdown", "local", passingProbe())
  assert.equal(result.capability, "markitdown")
  assert.equal(result.profile, "local")
  assert.equal(result.status, "passed")
  assert.equal(result.reason, undefined)
})

test("Ticket 10 P6: runSmokeCheck with failing probe (ok=false, reason) returns status=failed with reason", async () => {
  const result = await runSmokeCheck("neo4j", "local", failingProbe("connection refused"))
  assert.equal(result.status, "failed")
  assert.equal(result.reason, "connection refused")
})

test("Ticket 10 P6: runSmokeCheck with failing probe (ok=false, no reason) returns status=failed with default reason", async () => {
  const result = await runSmokeCheck("chat", "local", failingProbeNoReason())
  assert.equal(result.status, "failed")
  assert.equal(result.reason, "probe returned ok=false")
})

test("Ticket 10 P6: runSmokeCheck with throwing probe (Error) returns status=failed with error.message", async () => {
  const result = await runSmokeCheck("embedding", "local", throwingProbe("network timeout"))
  assert.equal(result.status, "failed")
  assert.equal(result.reason, "network timeout")
})

test("Ticket 10 P6: runSmokeCheck with throwing probe (non-Error) returns status=failed with String(value)", async () => {
  const result = await runSmokeCheck("pageindex", "local", throwingNonErrorProbe("string-throw"))
  assert.equal(result.status, "failed")
  assert.equal(result.reason, "string-throw")
})

test("Ticket 10 P6: runSmokeCheck with undefined probe + local profile returns status=skipped", async () => {
  const result = await runSmokeCheck("markitdown", "local", undefined)
  assert.equal(result.status, "skipped")
  assert.ok(result.reason !== undefined, "skipped result should include a reason")
  assert.match(result.reason!, /local/i)
})

test("Ticket 10 P6: runSmokeCheck with undefined probe + production profile returns status=failed (L1567)", async () => {
  const result = await runSmokeCheck("markitdown", "production", undefined)
  assert.equal(result.status, "failed", "production profile treats missing probe as failure (spec L1567)")
  assert.ok(result.reason !== undefined)
  assert.match(result.reason!, /production/i)
})

test("Ticket 10 P6: runSmokeCheck preserves capability + profile in result", async () => {
  const result = await runSmokeCheck("elasticsearch_vector", "production", passingProbe())
  assert.equal(result.capability, "elasticsearch_vector")
  assert.equal(result.profile, "production")
})

test("Ticket 10 P6: runSmokeCheck records durationMs >= 0 (non-negative)", async () => {
  const result = await runSmokeCheck("markitdown", "local", passingProbe())
  assert.ok(result.durationMs >= 0, `durationMs should be non-negative, got ${result.durationMs}`)
})

test("Ticket 10 P6: runSmokeCheck awaits async probe (slow probe)", async () => {
  const start = Date.now()
  const result = await runSmokeCheck("markitdown", "local", slowProbe(20))
  const elapsed = Date.now() - start
  assert.equal(result.status, "passed")
  assert.ok(elapsed >= 20, `elapsed ${elapsed}ms should be >= 20ms probe delay`)
})

// ---------------------------------------------------------------------------
// runAllSmokeChecks — capabilities (11 originals + 1 langfuse from T13 = 12)
// ---------------------------------------------------------------------------

test("Ticket 10 P6: CAPABILITY_ORDER contains all 12 capabilities in spec L1566 order (+ langfuse from T13)", () => {
  assert.equal(CAPABILITY_ORDER.length, 12)
  assert.deepEqual(CAPABILITY_ORDER, [
    "markitdown",
    "marker",
    "mineru",
    "elasticsearch_vector",
    "elasticsearch_bm25",
    "neo4j",
    "pageindex",
    "embedding",
    "chat",
    "cancellation",
    "graceful_shutdown",
    "langfuse",
  ])
})

test("Ticket 10 P6: runAllSmokeChecks returns exactly 12 results in CAPABILITY_ORDER", async () => {
  const results = await runAllSmokeChecks("local", {})
  assert.equal(results.length, 12)
  for (let i = 0; i < CAPABILITY_ORDER.length; i++) {
    assert.equal(results[i].capability, CAPABILITY_ORDER[i])
  }
})

test("Ticket 10 P6: runAllSmokeChecks local profile with no probes → 12 skipped", async () => {
  const results = await runAllSmokeChecks("local", {})
  assert.equal(results.length, 12)
  for (const r of results) {
    assert.equal(r.status, "skipped", `${r.capability} should be skipped on local with no probe`)
    assert.equal(r.profile, "local")
  }
})

test("Ticket 10 P6: runAllSmokeChecks production profile with no probes → 12 failed (L1567)", async () => {
  const results = await runAllSmokeChecks("production", {})
  assert.equal(results.length, 12)
  for (const r of results) {
    assert.equal(r.status, "failed", `${r.capability} should be failed on production with no probe`)
    assert.equal(r.profile, "production")
  }
})

test("Ticket 10 P6: runAllSmokeChecks production profile with all passing probes → 12 passed", async () => {
  const probes: SmokeProbeBundle = {}
  for (const cap of CAPABILITY_ORDER) {
    probes[cap] = passingProbe()
  }
  const results = await runAllSmokeChecks("production", probes)
  assert.equal(results.length, 12)
  for (const r of results) {
    assert.equal(r.status, "passed", `${r.capability} should pass with passing probe`)
  }
})

test("Ticket 10 P6: runAllSmokeChecks local profile mixed (some probes provided, some missing)", async () => {
  const probes: SmokeProbeBundle = {
    markitdown: passingProbe(),
    neo4j: failingProbe("connection refused"),
    // others undefined → skipped on local
  }
  const results = await runAllSmokeChecks("local", probes)
  const byCap = new Map<SmokeCapabilityKey, SmokeResult>()
  for (const r of results) byCap.set(r.capability, r)

  assert.equal(byCap.get("markitdown")!.status, "passed")
  assert.equal(byCap.get("neo4j")!.status, "failed")
  assert.equal(byCap.get("neo4j")!.reason, "connection refused")
  assert.equal(byCap.get("marker")!.status, "skipped")
  assert.equal(byCap.get("mineru")!.status, "skipped")
  assert.equal(byCap.get("elasticsearch_vector")!.status, "skipped")
  assert.equal(byCap.get("elasticsearch_bm25")!.status, "skipped")
  assert.equal(byCap.get("pageindex")!.status, "skipped")
  assert.equal(byCap.get("embedding")!.status, "skipped")
  assert.equal(byCap.get("chat")!.status, "skipped")
  assert.equal(byCap.get("cancellation")!.status, "skipped")
  assert.equal(byCap.get("graceful_shutdown")!.status, "skipped")
})

test("Ticket 10 P6: runAllSmokeChecks production profile mixed (some probes provided, some missing)", async () => {
  const probes: SmokeProbeBundle = {
    markitdown: passingProbe(),
    chat: passingProbe(),
    // others undefined → failed on production
  }
  const results = await runAllSmokeChecks("production", probes)
  const byCap = new Map<SmokeCapabilityKey, SmokeResult>()
  for (const r of results) byCap.set(r.capability, r)

  assert.equal(byCap.get("markitdown")!.status, "passed")
  assert.equal(byCap.get("chat")!.status, "passed")
  // 9 missing probes → failed on production
  for (const cap of CAPABILITY_ORDER) {
    if (cap === "markitdown" || cap === "chat") continue
    const r = byCap.get(cap)!
    assert.equal(r.status, "failed", `${cap} should be failed on production with missing probe`)
  }
})

// ---------------------------------------------------------------------------
// smokeGatePassed — aggregate gate
// ---------------------------------------------------------------------------

test("Ticket 10 P6: smokeGatePassed returns true when all 12 results are passed (production)", () => {
  const results: SmokeResult[] = CAPABILITY_ORDER.map((cap) => ({
    capability: cap,
    profile: "production" as EvaluationProfile,
    status: "passed" as const,
    durationMs: 10,
  }))
  assert.equal(smokeGatePassed(results), true)
})

test("Ticket 10 P6: smokeGatePassed returns false when any result is failed", () => {
  const results: SmokeResult[] = CAPABILITY_ORDER.map((cap, i) => ({
    capability: cap,
    profile: "production" as EvaluationProfile,
    status: i === 5 ? ("failed" as const) : ("passed" as const),
    durationMs: 10,
    ...(i === 5 ? { reason: "connection refused" } : {}),
  }))
  assert.equal(smokeGatePassed(results), false)
})

test("Ticket 10 P6: smokeGatePassed returns true for local profile with skips (no failures)", () => {
  const results: SmokeResult[] = CAPABILITY_ORDER.map((cap) => ({
    capability: cap,
    profile: "local" as EvaluationProfile,
    status: "skipped" as const,
    durationMs: 0,
    reason: "no probe provided for local profile",
  }))
  assert.equal(smokeGatePassed(results), true, "local profile allows skips (spec L1567)")
})

test("Ticket 10 P6: smokeGatePassed returns false for production profile with any skip (L1567)", () => {
  const results: SmokeResult[] = CAPABILITY_ORDER.map((cap, i) => ({
    capability: cap,
    profile: "production" as EvaluationProfile,
    status: i === 3 ? ("skipped" as const) : ("passed" as const),
    durationMs: 10,
    ...(i === 3 ? { reason: "missing probe" } : {}),
  }))
  assert.equal(smokeGatePassed(results), false, "production profile treats skip as failure (spec L1567)")
})

test("Ticket 10 P6: smokeGatePassed returns true for empty results (vacuous pass)", () => {
  assert.equal(smokeGatePassed([]), true)
})

test("Ticket 10 P6: smokeGatePassed returns false for local profile when any probe failed (broken ≠ missing)", () => {
  const results: SmokeResult[] = [
    { capability: "markitdown", profile: "local", status: "passed", durationMs: 10 },
    { capability: "marker", profile: "local", status: "failed", durationMs: 10, reason: "crash" },
  ]
  assert.equal(smokeGatePassed(results), false, "local allows missing but not broken")
})

test("Ticket 10 P6: smokeGatePassed mixed profile (local skips OK + production skips fail)", () => {
  const localResults: SmokeResult[] = [
    { capability: "markitdown", profile: "local", status: "skipped", durationMs: 0, reason: "local" },
  ]
  const productionResults: SmokeResult[] = [
    { capability: "markitdown", profile: "production", status: "skipped", durationMs: 0, reason: "production" },
  ]
  assert.equal(smokeGatePassed(localResults), true)
  assert.equal(smokeGatePassed(productionResults), false)
})
