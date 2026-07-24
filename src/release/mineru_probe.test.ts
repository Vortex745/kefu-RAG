// Ticket 23 — Live MinerU acceptance probe tests.
//
// TDD red phase: defines the expected behavior of mineruProbe
// BEFORE the implementation exists. Tests cover all 3 acceptance criteria:
//   #1 — The configured MinerU runtime returns non-empty OCR output with
//        expected media and page provenance.
//   #2 — Missing runtime, timeout, output quota, malformed output, missing
//        media reference, and cancellation fail explicitly.
//   #3 — Image bytes, OCR text, and provider payloads are excluded from
//        persisted smoke evidence.
//
// Plus isolation + sanitization + bounded-outputs + failure-mode tests.
//
// Candidate-mode (OP-04 unsatisfied): the real `mineru` CLI is unavailable.
// The probe uses `process.execPath` + `-e` flag as the OP-04 candidate-mode
// substitute that writes the expected MinerU JSON to
// outputPath/result_content_list.json — same pattern as Tickets 21/22 and
// consistent with T19/T20/T24 candidate-mode probes. When OP-04 is lifted,
// the fixture's command swap is the only change — the probe code, selectParser,
// MinerUParser, normalizeMinerU, runBoundedProcess, findBoundedArtifact, and
// verifyImageReferences are production code exercised end-to-end.

import assert from "node:assert/strict"
import test from "node:test"
import { mineruProbe, type MinerUProbeFixture } from "./mineru_probe"
import type { ProbeContext } from "./smoke_harness"

const REVISION = "abc123def4567890abcdef1234567890abcdef12"
const ACCEPTANCE_TENANT = "acceptance-abc123def456"

// Sample MinerU content_list.json array — a heading + paragraph on page 1.
// Used as the candidate-mode happy-path substitute output.
const SAMPLE_MINERU_JSON = JSON.stringify([
  {
    type: "text",
    text: "OCR Captured Title",
    page_idx: 0,
    text_level: 1,
    bbox: [0, 900, 1000, 950],
  },
  {
    type: "text",
    text: "OCR captured body text content on page one.",
    page_idx: 0,
    bbox: [0, 800, 1000, 900],
  },
])

function makeProbeContext(fixture: MinerUProbeFixture): ProbeContext {
  return {
    signal: new AbortController().signal,
    deadlineMs: 60_000,
    fixture,
  }
}

function makeBasicFixture(): MinerUProbeFixture {
  return {
    revision: REVISION,
    document: {
      fileName: "scanned.png",
      content: "raw image bytes placeholder",
      mimeType: "image/png",
    },
    expectedMinerUJson: SAMPLE_MINERU_JSON,
  }
}

// ============================================================
// #1 — Configured MinerU runtime returns non-empty OCR output with
//      expected media and page provenance
// ============================================================

test("Ticket 23 #1a: probe returns ok=true with non-empty normalized blocks", async () => {
  const result = await mineruProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true, `probe must succeed; reason: ${result.reason ?? "n/a"}`)
  const outputs = result.outputs ?? {}
  const blockCount = outputs.blockCount as number
  assert.equal(typeof blockCount, "number")
  assert.ok(blockCount > 0, "blockCount must be > 0")
})

test("Ticket 23 #1b: probe verifies parser identity is mineru", async () => {
  const result = await mineruProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true)
  const outputs = result.outputs ?? {}
  assert.equal(outputs.parserIdentity, "mineru")
})

test("Ticket 23 #1c: probe verifies block provenance is {parser:mineru, adapter:cli}", async () => {
  const result = await mineruProbe(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}
  assert.deepEqual(outputs.provenance, { parser: "mineru", adapter: "cli" })
})

test("Ticket 23 #1d: probe verifies block types include heading and paragraph", async () => {
  const result = await mineruProbe(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}
  const blockTypes = outputs.blockTypes as string[]
  assert.ok(Array.isArray(blockTypes))
  assert.ok(blockTypes.includes("heading"), "blockTypes must include heading")
  assert.ok(blockTypes.includes("paragraph"), "blockTypes must include paragraph")
})

test("Ticket 23 #1e: probe exercises production selectParser routing for image", async () => {
  const result = await mineruProbe(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}
  assert.equal(outputs.parserRoute, "mineru")
  assert.match(outputs.parserRouteReason as string, /image|OCR/i)
})

test("Ticket 23 #1f: probe verifies blocks have stable ids and types", async () => {
  const result = await mineruProbe(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}
  const blocks = outputs.blocks as Array<{ id: string; type: string }> | undefined
  assert.ok(Array.isArray(blocks), "blocks must be an array")
  assert.ok(blocks!.length > 0)
  const idSet = new Set(blocks!.map((b) => b.id))
  assert.equal(idSet.size, blocks!.length, "block ids must be unique")
  assert.ok(
    blocks!.every((b) => typeof b.id === "string" && typeof b.type === "string"),
    "every block must have id + type",
  )
})

test("Ticket 23 #1g: probe verifies blocks carry page provenance", async () => {
  const result = await mineruProbe(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}
  const pageCount = outputs.pageCount as number
  assert.equal(typeof pageCount, "number")
  assert.ok(pageCount >= 1, "pageCount must be >= 1")
})

// ============================================================
// #2 — Missing runtime, timeout, output quota, malformed output,
//      missing media reference, and cancellation fail explicitly
// ============================================================

test("Ticket 23 #2a: all 6 failure modes are explicit and recorded", async () => {
  const result = await mineruProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true, `probe must succeed; reason: ${result.reason ?? "n/a"}`)
  const outputs = result.outputs ?? {}
  const failureModes = outputs.failureModes as Record<string, string>

  const expectedModes = [
    "missingRuntime",
    "timeout",
    "outputQuota",
    "malformed",
    "missingMediaReference",
    "cancellation",
  ]
  for (const mode of expectedModes) {
    assert.ok(mode in failureModes, `failureModes must include ${mode}`)
    assert.equal(
      failureModes[mode],
      "passed",
      `${mode} must produce explicit failure (status="passed" means failure was observed and explicit)`,
    )
  }
})

test("Ticket 23 #2b: failure mode errors are recorded as bounded evidence", async () => {
  const result = await mineruProbe(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}
  const failureErrors = outputs.failureErrors as Record<string, string>
  assert.ok(typeof failureErrors === "object")
  for (const [mode, err] of Object.entries(failureErrors)) {
    assert.ok(
      typeof err === "string" && err.length > 0,
      `${mode} error must be non-empty string`,
    )
    assert.ok(err.length <= 512, `${mode} error must be bounded (<= 512 chars)`)
  }
})

test("Ticket 23 #2c: missing runtime failure mentions unavailable", async () => {
  const result = await mineruProbe(makeProbeContext(makeBasicFixture()))
  const failureErrors = (result.outputs ?? {}).failureErrors as Record<string, string>
  assert.match(failureErrors.missingRuntime, /unavailable|ENOENT|missing/i)
})

test("Ticket 23 #2d: timeout failure mentions timeout", async () => {
  const result = await mineruProbe(makeProbeContext(makeBasicFixture()))
  const failureErrors = (result.outputs ?? {}).failureErrors as Record<string, string>
  assert.match(failureErrors.timeout, /timed out|timeout/i)
})

test("Ticket 23 #2e: malformed output failure mentions malformed", async () => {
  const result = await mineruProbe(makeProbeContext(makeBasicFixture()))
  const failureErrors = (result.outputs ?? {}).failureErrors as Record<string, string>
  assert.match(failureErrors.malformed, /malformed/i)
})

test("Ticket 23 #2f: cancellation failure mentions cancel", async () => {
  const result = await mineruProbe(makeProbeContext(makeBasicFixture()))
  const failureErrors = (result.outputs ?? {}).failureErrors as Record<string, string>
  assert.match(failureErrors.cancellation, /cancel/i)
})

test("Ticket 23 #2g: output quota failure mentions exceeded", async () => {
  const result = await mineruProbe(makeProbeContext(makeBasicFixture()))
  const failureErrors = (result.outputs ?? {}).failureErrors as Record<string, string>
  assert.match(failureErrors.outputQuota, /exceed|quota|limit/i)
})

test("Ticket 23 #2h: missing media reference failure mentions image or reference", async () => {
  const result = await mineruProbe(makeProbeContext(makeBasicFixture()))
  const failureErrors = (result.outputs ?? {}).failureErrors as Record<string, string>
  assert.match(failureErrors.missingMediaReference, /image|reference|does not exist/i)
})

// ============================================================
// #3 — Image bytes, OCR text, and provider payloads excluded
// ============================================================

test("Ticket 23 #3a: version isolation — failed parse preserves previous active version", async () => {
  const result = await mineruProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true)
  const outputs = result.outputs ?? {}
  const versionIsolation = outputs.versionIsolation as Record<string, unknown>
  assert.equal(
    versionIsolation.previousActivePreserved,
    true,
    "previous active version must be preserved after failed parse",
  )
  assert.equal(
    versionIsolation.failedVersionNotActivated,
    true,
    "failed version must NOT be activated",
  )
})

test("Ticket 23 #3b: version isolation — failed version status is recorded", async () => {
  const result = await mineruProbe(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}
  const versionIsolation = outputs.versionIsolation as Record<string, unknown>
  assert.ok(
    typeof versionIsolation.failedVersionStatus === "string",
    "failedVersionStatus must be a string",
  )
  assert.notEqual(
    versionIsolation.failedVersionStatus,
    "completed",
    "failed version must not be 'completed'",
  )
})

test("Ticket 23 #3c: version isolation — active version id is recorded", async () => {
  const result = await mineruProbe(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}
  const versionIsolation = outputs.versionIsolation as Record<string, unknown>
  assert.ok(
    typeof versionIsolation.activeVersionId === "string",
    "activeVersionId must be a string",
  )
})

// ============================================================
// #4 — Probe returns durationMs
// ============================================================

test("Ticket 23 #4: probe returns durationMs", async () => {
  const result = await mineruProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(typeof result.durationMs, "number")
  assert.ok(result.durationMs >= 0, "durationMs must be >= 0")
  assert.ok(result.durationMs < 60_000, "durationMs must be bounded (< 60s)")
})

// ============================================================
// #5 — Probe handles missing/invalid fixture
// ============================================================

test("Ticket 23 #5a: probe fails when fixture is missing", async () => {
  const result = await mineruProbe({
    signal: new AbortController().signal,
    deadlineMs: 60_000,
    fixture: undefined,
  })
  assert.equal(result.ok, false)
  assert.match(result.reason!, /fixture/i)
})

test("Ticket 23 #5b: probe fails when revision is missing", async () => {
  const result = await mineruProbe(
    makeProbeContext({
      ...makeBasicFixture(),
      revision: "",
    }),
  )
  assert.equal(result.ok, false)
  assert.match(result.reason!, /revision/i)
})

test("Ticket 23 #5c: probe fails when document is missing", async () => {
  const result = await mineruProbe(
    makeProbeContext({
      ...makeBasicFixture(),
      document: undefined as never,
    }),
  )
  assert.equal(result.ok, false)
  assert.match(result.reason!, /document/i)
})

// ============================================================
// #6 — Probe uses isolated acceptance tenant — never 'default'
// ============================================================

test("Ticket 23 #6: probe uses isolated acceptance tenant — never 'default'", async () => {
  const result = await mineruProbe(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}
  const tenantId = outputs.tenantId as string
  assert.ok(tenantId.startsWith("acceptance-"), "tenantId must be acceptance-scoped")
  assert.notEqual(tenantId, "default", "tenantId MUST NOT be the production 'default'")
  assert.equal(tenantId, ACCEPTANCE_TENANT)
})

// ============================================================
// #7 — Outputs are sanitized (no image bytes, OCR text, or provider payloads)
// ============================================================

test("Ticket 23 #7: outputs contain no image bytes, OCR text, or provider payloads", async () => {
  const result = await mineruProbe(makeProbeContext(makeBasicFixture()))
  const serialized = JSON.stringify(result.outputs ?? {})

  const forbidden = [
    "raw image bytes", // raw input content
    "OCR Captured Title", // OCR heading text from SAMPLE_MINERU_JSON
    "OCR captured body text", // OCR paragraph text from SAMPLE_MINERU_JSON
    "prompt",
    "apiKey",
    "authorization",
    "Bearer",
    "token",
    "provider",
  ]
  for (const bad of forbidden) {
    assert.ok(
      !serialized.includes(bad),
      `outputs MUST NOT contain "${bad}" — found in: ${serialized}`,
    )
  }
})

// ============================================================
// #8 — Bounded outputs (only safe metadata)
// ============================================================

test("Ticket 23 #8: outputs carry bounded metadata only", async () => {
  const result = await mineruProbe(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}

  const required = [
    "parserIdentity",
    "blockCount",
    "blockTypes",
    "provenance",
    "parserRoute",
    "parserRouteReason",
    "failureModes",
    "failureErrors",
    "versionIsolation",
    "tenantId",
    "revision",
    "pageCount",
  ]
  for (const field of required) {
    assert.ok(field in outputs, `outputs must include ${field}`)
  }

  const allowed = new Set([...required, "blocks"])
  for (const key of Object.keys(outputs)) {
    assert.ok(allowed.has(key), `unexpected output key: ${key}`)
  }
})

// ============================================================
// #9 — Custom fixture revision derives different acceptance tenant
// ============================================================

test("Ticket 23 #9: custom fixture revision derives different acceptance tenant", async () => {
  const result = await mineruProbe(
    makeProbeContext({
      ...makeBasicFixture(),
      revision: "xyz9876543210fedcba0987654321fedcba09876",
    }),
  )
  assert.equal(result.ok, true, `probe must succeed; reason: ${result.reason ?? "n/a"}`)
  const tenantId = (result.outputs ?? {}).tenantId as string
  assert.equal(tenantId, "acceptance-xyz987654321")
})

// ============================================================
// #10 — Cancellation propagation
// ============================================================

test("Ticket 23 #10: probe handles pre-aborted signal gracefully", async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await mineruProbe({
    signal: controller.signal,
    deadlineMs: 60_000,
    fixture: makeBasicFixture(),
  })
  assert.ok(
    result.ok === false ||
      ((result.outputs?.failureModes as Record<string, string>)?.cancellation === "passed"),
    "probe must handle pre-aborted signal without hanging",
  )
  assert.ok(result.durationMs < 5_000, "probe must return promptly even when aborted")
})
