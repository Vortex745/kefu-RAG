// Ticket 22 — Live Marker acceptance probe tests.
//
// TDD red phase: defines the expected behavior of markerProbe
// BEFORE the implementation exists. Tests cover all 3 acceptance criteria:
//   #1 — The configured Marker runtime returns structured output with
//        expected page and section provenance.
//   #2 — Missing runtime, timeout, output quota, malformed renderer output,
//        and cancellation fail explicitly.
//   #3 — Raw PDF content is excluded from persisted smoke evidence and
//        failed replacement output remains inactive.
//
// Plus isolation + sanitization + bounded-outputs + failure-mode tests.
//
// Candidate-mode (OP-04 unsatisfied): the real `marker` CLI is unavailable.
// The probe uses `process.execPath` + `-e` flag as the OP-04 candidate-mode
// substitute that writes the expected Marker JSON to outputPath/input.json —
// same pattern as Ticket 21 (markitdown_probe) and consistent with T19/T20/T24
// candidate-mode probes. When OP-04 is lifted, the fixture's command swap is
// the only change — the probe code, selectParser, MarkerParser,
// normalizeMarker, runBoundedProcess, and findBoundedArtifact are production
// code exercised end-to-end.

import assert from "node:assert/strict"
import test from "node:test"
import { markerProbe, type MarkerProbeFixture } from "./marker_probe"
import type { ProbeContext } from "./smoke_harness"

const REVISION = "abc123def4567890abcdef1234567890abcdef12"
const ACCEPTANCE_TENANT = "acceptance-abc123def456"

// Sample Marker JSON document tree (Document > Page > SectionHeader + Text)
// matching normalizeMarker's expected shape. Used as the candidate-mode
// happy-path substitute output.
// All blocks (including Page) MUST carry id/block_type/html/bbox/polygon per
// normalizeMarker's required-fields invariant.
const SAMPLE_MARKER_JSON = JSON.stringify({
  block_type: "Document",
  metadata: { pages: 1, type: "text" },
  children: [
    {
      block_type: "Page",
      id: "/page/0",
      html: "",
      bbox: [0, 0, 612, 792],
      polygon: [[0, 0], [612, 0], [612, 792], [0, 792]],
      children: [
        {
          block_type: "SectionHeader",
          id: "/page/0/SectionHeader/0",
          html: "<h1>Introduction</h1>",
          bbox: [0, 700, 612, 740],
          polygon: [[0, 700], [612, 700], [612, 740], [0, 740]],
          section_hierarchy: { "1": "/page/0/SectionHeader/0" },
          children: null,
        },
        {
          block_type: "Text",
          id: "/page/0/Text/0",
          html: "<p>This is the introduction body.</p>",
          bbox: [0, 600, 612, 700],
          polygon: [[0, 600], [612, 600], [612, 700], [0, 700]],
          section_hierarchy: { "1": "/page/0/SectionHeader/0" },
          children: null,
        },
      ],
    },
  ],
})

function makeProbeContext(fixture: MarkerProbeFixture): ProbeContext {
  return {
    signal: new AbortController().signal,
    deadlineMs: 60_000,
    fixture,
  }
}

function makeBasicFixture(): MarkerProbeFixture {
  return {
    revision: REVISION,
    document: {
      fileName: "paper.pdf",
      content: "raw pdf bytes placeholder",
      mimeType: "application/pdf",
    },
    expectedMarkerJson: SAMPLE_MARKER_JSON,
  }
}

// ============================================================
// #1 — Configured Marker runtime returns structured output with
//      expected page and section provenance
// ============================================================

test("Ticket 22 #1a: probe returns ok=true with non-empty normalized blocks", async () => {
  const result = await markerProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true, `probe must succeed; reason: ${result.reason ?? "n/a"}`)
  const outputs = result.outputs ?? {}
  const blockCount = outputs.blockCount as number
  assert.equal(typeof blockCount, "number")
  assert.ok(blockCount > 0, "blockCount must be > 0")
})

test("Ticket 22 #1b: probe verifies parser identity is marker", async () => {
  const result = await markerProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true)
  const outputs = result.outputs ?? {}
  assert.equal(outputs.parserIdentity, "marker")
})

test("Ticket 22 #1c: probe verifies block provenance is {parser:marker, adapter:cli}", async () => {
  const result = await markerProbe(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}
  assert.deepEqual(outputs.provenance, { parser: "marker", adapter: "cli" })
})

test("Ticket 22 #1d: probe verifies block types include heading and paragraph", async () => {
  const result = await markerProbe(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}
  const blockTypes = outputs.blockTypes as string[]
  assert.ok(Array.isArray(blockTypes))
  assert.ok(blockTypes.includes("heading"), "blockTypes must include heading")
  assert.ok(blockTypes.includes("paragraph"), "blockTypes must include paragraph")
})

test("Ticket 22 #1e: probe exercises production selectParser routing for .pdf", async () => {
  const result = await markerProbe(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}
  assert.equal(outputs.parserRoute, "marker")
  assert.match(outputs.parserRouteReason as string, /PDF/i)
})

test("Ticket 22 #1f: probe verifies blocks have stable ids and types", async () => {
  const result = await markerProbe(makeProbeContext(makeBasicFixture()))
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

test("Ticket 22 #1g: probe verifies blocks carry page provenance", async () => {
  const result = await markerProbe(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}
  // Marker blocks always carry page numbers (markerPage from /page/N/...).
  const pageCount = outputs.pageCount as number
  assert.equal(typeof pageCount, "number")
  assert.ok(pageCount >= 1, "pageCount must be >= 1")
})

// ============================================================
// #2 — Missing runtime, timeout, output quota, malformed renderer
//      output, and cancellation fail explicitly
// ============================================================

test("Ticket 22 #2a: all 5 failure modes are explicit and recorded", async () => {
  const result = await markerProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true, `probe must succeed; reason: ${result.reason ?? "n/a"}`)
  const outputs = result.outputs ?? {}
  const failureModes = outputs.failureModes as Record<string, string>

  const expectedModes = ["missingRuntime", "timeout", "outputQuota", "malformed", "cancellation"]
  for (const mode of expectedModes) {
    assert.ok(mode in failureModes, `failureModes must include ${mode}`)
    assert.equal(
      failureModes[mode],
      "passed",
      `${mode} must produce explicit failure (status="passed" means failure was observed and explicit)`,
    )
  }
})

test("Ticket 22 #2b: failure mode errors are recorded as bounded evidence", async () => {
  const result = await markerProbe(makeProbeContext(makeBasicFixture()))
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

test("Ticket 22 #2c: missing runtime failure mentions unavailable", async () => {
  const result = await markerProbe(makeProbeContext(makeBasicFixture()))
  const failureErrors = (result.outputs ?? {}).failureErrors as Record<string, string>
  assert.match(failureErrors.missingRuntime, /unavailable|ENOENT|missing/i)
})

test("Ticket 22 #2d: timeout failure mentions timeout", async () => {
  const result = await markerProbe(makeProbeContext(makeBasicFixture()))
  const failureErrors = (result.outputs ?? {}).failureErrors as Record<string, string>
  assert.match(failureErrors.timeout, /timed out|timeout/i)
})

test("Ticket 22 #2e: malformed output failure mentions malformed", async () => {
  const result = await markerProbe(makeProbeContext(makeBasicFixture()))
  const failureErrors = (result.outputs ?? {}).failureErrors as Record<string, string>
  assert.match(failureErrors.malformed, /malformed/i)
})

test("Ticket 22 #2f: cancellation failure mentions cancel", async () => {
  const result = await markerProbe(makeProbeContext(makeBasicFixture()))
  const failureErrors = (result.outputs ?? {}).failureErrors as Record<string, string>
  assert.match(failureErrors.cancellation, /cancel/i)
})

test("Ticket 22 #2g: output quota failure mentions exceeded", async () => {
  const result = await markerProbe(makeProbeContext(makeBasicFixture()))
  const failureErrors = (result.outputs ?? {}).failureErrors as Record<string, string>
  assert.match(failureErrors.outputQuota, /exceed|quota|limit/i)
})

// ============================================================
// #3 — Raw PDF content excluded + failed replacement inactive
// ============================================================

test("Ticket 22 #3a: version isolation — failed parse preserves previous active version", async () => {
  const result = await markerProbe(makeProbeContext(makeBasicFixture()))
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

test("Ticket 22 #3b: version isolation — failed version status is recorded", async () => {
  const result = await markerProbe(makeProbeContext(makeBasicFixture()))
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

test("Ticket 22 #3c: version isolation — active version id is recorded", async () => {
  const result = await markerProbe(makeProbeContext(makeBasicFixture()))
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

test("Ticket 22 #4: probe returns durationMs", async () => {
  const result = await markerProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(typeof result.durationMs, "number")
  assert.ok(result.durationMs >= 0, "durationMs must be >= 0")
  assert.ok(result.durationMs < 60_000, "durationMs must be bounded (< 60s)")
})

// ============================================================
// #5 — Probe handles missing/invalid fixture
// ============================================================

test("Ticket 22 #5a: probe fails when fixture is missing", async () => {
  const result = await markerProbe({
    signal: new AbortController().signal,
    deadlineMs: 60_000,
    fixture: undefined,
  })
  assert.equal(result.ok, false)
  assert.match(result.reason!, /fixture/i)
})

test("Ticket 22 #5b: probe fails when revision is missing", async () => {
  const result = await markerProbe(
    makeProbeContext({
      ...makeBasicFixture(),
      revision: "",
    }),
  )
  assert.equal(result.ok, false)
  assert.match(result.reason!, /revision/i)
})

test("Ticket 22 #5c: probe fails when document is missing", async () => {
  const result = await markerProbe(
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

test("Ticket 22 #6: probe uses isolated acceptance tenant — never 'default'", async () => {
  const result = await markerProbe(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}
  const tenantId = outputs.tenantId as string
  assert.ok(tenantId.startsWith("acceptance-"), "tenantId must be acceptance-scoped")
  assert.notEqual(tenantId, "default", "tenantId MUST NOT be the production 'default'")
  assert.equal(tenantId, ACCEPTANCE_TENANT)
})

// ============================================================
// #7 — Outputs are sanitized (no raw PDF content, prompts, tokens)
// ============================================================

test("Ticket 22 #7: outputs contain no raw PDF content, prompts, or tokens", async () => {
  const result = await markerProbe(makeProbeContext(makeBasicFixture()))
  const serialized = JSON.stringify(result.outputs ?? {})

  const forbidden = [
    "raw pdf bytes", // raw input content
    "Introduction", // heading text from SAMPLE_MARKER_JSON
    "introduction body", // paragraph text from SAMPLE_MARKER_JSON
    "prompt",
    "apiKey",
    "authorization",
    "Bearer",
    "token",
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

test("Ticket 22 #8: outputs carry bounded metadata only", async () => {
  const result = await markerProbe(makeProbeContext(makeBasicFixture()))
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

test("Ticket 22 #9: custom fixture revision derives different acceptance tenant", async () => {
  const result = await markerProbe(
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

test("Ticket 22 #10: probe handles pre-aborted signal gracefully", async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await markerProbe({
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
