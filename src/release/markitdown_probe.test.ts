// Ticket 21 — Live MarkItDown acceptance probe tests.
//
// TDD red phase: defines the expected behavior of markitdownProbe
// BEFORE the implementation exists. Tests cover all 3 acceptance criteria:
//   #1 — The configured MarkItDown runtime produces the expected non-empty
//        normalized block structure and parser identity.
//   #2 — Missing runtime, ABI failure, timeout, output quota, malformed
//        output, and cancellation are explicit failures.
//   #3 — A failed parse cannot activate or overwrite the previous
//        successful knowledge version.
//
// Plus isolation + sanitization + bounded-outputs + failure-mode tests.
//
// Candidate-mode (OP-04 unsatisfied): the real `markitdown.exe` is broken
// (Python 3.14 loads cp313 NumPy binaries; documented in MEMORY.md
// 2026-07-15). The probe uses `process.execPath` + `-e` flag as the
// OP-04 candidate-mode substitute for the happy-path command — same pattern
// as parser.test.ts and consistent with T19/T20/T24 candidate-mode probes
// (in-memory Searcher, scripted LLM/Validator). When OP-04 is lifted, the
// fixture's command swap is the only change — the probe code, selectParser,
// MarkItDownParser, normalizeMarkItDown, and runBoundedProcess are
// production code exercised end-to-end.

import assert from "node:assert/strict"
import test from "node:test"
import { markitdownProbe, type MarkItDownProbeFixture } from "./markitdown_probe"
import type { ProbeContext } from "./smoke_harness"

const REVISION = "abc123def4567890abcdef1234567890abcdef12"
const ACCEPTANCE_TENANT = "acceptance-abc123def456"

function makeProbeContext(fixture: MarkItDownProbeFixture): ProbeContext {
  return {
    signal: new AbortController().signal,
    deadlineMs: 30_000,
    fixture,
  }
}

function makeBasicFixture(): MarkItDownProbeFixture {
  return {
    revision: REVISION,
    document: {
      fileName: "policy.docx",
      content: "raw office bytes placeholder",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
    expectedMarkdown:
      "# Refund policy\n\nRefunds are available within 30 days.",
  }
}

// ============================================================
// #1 — Configured MarkItDown runtime produces expected non-empty
//      normalized block structure and parser identity
// ============================================================

test("Ticket 21 #1a: probe returns ok=true with non-empty normalized blocks", async () => {
  const result = await markitdownProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true, `probe must succeed; reason: ${result.reason ?? "n/a"}`)
  const outputs = result.outputs ?? {}
  const blockCount = outputs.blockCount as number
  assert.equal(typeof blockCount, "number")
  assert.ok(blockCount > 0, "blockCount must be > 0")
})

test("Ticket 21 #1b: probe verifies parser identity is markitdown", async () => {
  const result = await markitdownProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true)
  const outputs = result.outputs ?? {}
  assert.equal(outputs.parserIdentity, "markitdown")
})

test("Ticket 21 #1c: probe verifies block provenance is {parser:markitdown, adapter:cli}", async () => {
  const result = await markitdownProbe(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}
  assert.deepEqual(outputs.provenance, { parser: "markitdown", adapter: "cli" })
})

test("Ticket 21 #1d: probe verifies block types include heading and paragraph", async () => {
  const result = await markitdownProbe(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}
  const blockTypes = outputs.blockTypes as string[]
  assert.ok(Array.isArray(blockTypes))
  assert.ok(blockTypes.includes("heading"), "blockTypes must include heading")
  assert.ok(blockTypes.includes("paragraph"), "blockTypes must include paragraph")
})

test("Ticket 21 #1e: probe exercises production selectParser routing for .docx", async () => {
  const result = await markitdownProbe(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}
  assert.equal(outputs.parserRoute, "markitdown")
  assert.match(outputs.parserRouteReason as string, /\.docx/)
})

test("Ticket 21 #1f: probe verifies blocks have stable ids and types", async () => {
  const result = await markitdownProbe(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}
  const blocks = outputs.blocks as Array<{
    id: string
    type: string
  }> | undefined
  assert.ok(Array.isArray(blocks), "blocks must be an array")
  assert.ok(blocks!.length > 0)
  const idSet = new Set(blocks!.map((b) => b.id))
  assert.equal(idSet.size, blocks!.length, "block ids must be unique")
  assert.ok(
    blocks!.every((b) => typeof b.id === "string" && typeof b.type === "string"),
    "every block must have id + type",
  )
})

// ============================================================
// #2 — Missing runtime, ABI failure, timeout, output quota, malformed
//      output, and cancellation are explicit failures
// ============================================================

test("Ticket 21 #2a: all 6 failure modes are explicit and recorded", async () => {
  const result = await markitdownProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(result.ok, true, `probe must succeed; reason: ${result.reason ?? "n/a"}`)
  const outputs = result.outputs ?? {}
  const failureModes = outputs.failureModes as Record<string, string>

  const expectedModes = [
    "missingRuntime",
    "abiFailure",
    "timeout",
    "outputQuota",
    "malformed",
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

test("Ticket 21 #2b: failure mode errors are recorded as bounded evidence", async () => {
  const result = await markitdownProbe(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}
  const failureErrors = outputs.failureErrors as Record<string, string>
  assert.ok(typeof failureErrors === "object")
  for (const [mode, err] of Object.entries(failureErrors)) {
    assert.ok(
      typeof err === "string" && err.length > 0,
      `${mode} error must be non-empty string`,
    )
    // Error messages must be bounded (not full stderr dump)
    assert.ok(err.length <= 512, `${mode} error must be bounded (<= 512 chars)`)
  }
})

test("Ticket 21 #2c: missing runtime failure mentions unavailable", async () => {
  const result = await markitdownProbe(makeProbeContext(makeBasicFixture()))
  const failureErrors = (result.outputs ?? {}).failureErrors as Record<string, string>
  assert.match(failureErrors.missingRuntime, /unavailable|ENOENT|missing/i)
})

test("Ticket 21 #2d: timeout failure mentions timeout", async () => {
  const result = await markitdownProbe(makeProbeContext(makeBasicFixture()))
  const failureErrors = (result.outputs ?? {}).failureErrors as Record<string, string>
  assert.match(failureErrors.timeout, /timed out|timeout/i)
})

test("Ticket 21 #2e: malformed output failure mentions malformed", async () => {
  const result = await markitdownProbe(makeProbeContext(makeBasicFixture()))
  const failureErrors = (result.outputs ?? {}).failureErrors as Record<string, string>
  assert.match(failureErrors.malformed, /malformed/i)
})

test("Ticket 21 #2f: cancellation failure mentions cancel", async () => {
  const result = await markitdownProbe(makeProbeContext(makeBasicFixture()))
  const failureErrors = (result.outputs ?? {}).failureErrors as Record<string, string>
  assert.match(failureErrors.cancellation, /cancel/i)
})

test("Ticket 21 #2g: output quota failure mentions exceeded", async () => {
  const result = await markitdownProbe(makeProbeContext(makeBasicFixture()))
  const failureErrors = (result.outputs ?? {}).failureErrors as Record<string, string>
  assert.match(failureErrors.outputQuota, /exceed|quota|limit/i)
})

test("Ticket 21 #2h: ABI failure mentions the import error", async () => {
  const result = await markitdownProbe(makeProbeContext(makeBasicFixture()))
  const failureErrors = (result.outputs ?? {}).failureErrors as Record<string, string>
  // ABI failure: process starts, writes ModuleNotFoundError to stderr, exits non-zero
  assert.match(
    failureErrors.abiFailure,
    /exited with code|ModuleNotFoundError|import|ABI/i,
  )
})

// ============================================================
// #3 — A failed parse cannot activate or overwrite the previous
//      successful knowledge version
// ============================================================

test("Ticket 21 #3a: version isolation — failed parse preserves previous active version", async () => {
  const result = await markitdownProbe(makeProbeContext(makeBasicFixture()))
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

test("Ticket 21 #3b: version isolation — failed version status is recorded", async () => {
  const result = await markitdownProbe(makeProbeContext(makeBasicFixture()))
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

test("Ticket 21 #3c: version isolation — active version id is recorded", async () => {
  const result = await markitdownProbe(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}
  const versionIsolation = outputs.versionIsolation as Record<string, unknown>
  assert.ok(
    typeof versionIsolation.activeVersionId === "string" ||
      typeof versionIsolation.activeDocId === "string",
    "active version id must be recorded",
  )
})

// ============================================================
// #4 — Probe returns durationMs
// ============================================================

test("Ticket 21 #4: probe returns durationMs", async () => {
  const result = await markitdownProbe(makeProbeContext(makeBasicFixture()))
  assert.equal(typeof result.durationMs, "number")
  assert.ok(result.durationMs >= 0, "durationMs must be >= 0")
  assert.ok(result.durationMs < 30_000, "durationMs must be bounded (< 30s)")
})

// ============================================================
// #5 — Probe handles missing/invalid fixture
// ============================================================

test("Ticket 21 #5a: probe fails when fixture is missing", async () => {
  const result = await markitdownProbe({
    signal: new AbortController().signal,
    deadlineMs: 30_000,
    fixture: undefined,
  })
  assert.equal(result.ok, false)
  assert.match(result.reason!, /fixture/i)
})

test("Ticket 21 #5b: probe fails when revision is missing", async () => {
  const result = await markitdownProbe(
    makeProbeContext({
      ...makeBasicFixture(),
      revision: "",
    }),
  )
  assert.equal(result.ok, false)
  assert.match(result.reason!, /revision/i)
})

test("Ticket 21 #5c: probe fails when document is missing", async () => {
  const result = await markitdownProbe(
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

test("Ticket 21 #6: probe uses isolated acceptance tenant — never 'default'", async () => {
  const result = await markitdownProbe(makeProbeContext(makeBasicFixture()))
  const outputs = result.outputs ?? {}
  const tenantId = outputs.tenantId as string
  assert.ok(tenantId.startsWith("acceptance-"), "tenantId must be acceptance-scoped")
  assert.notEqual(tenantId, "default", "tenantId MUST NOT be the production 'default'")
  assert.equal(tenantId, ACCEPTANCE_TENANT)
})

// ============================================================
// #7 — Outputs are sanitized (no raw content, prompts, tokens)
// ============================================================

test("Ticket 21 #7: outputs contain no raw content, prompts, or tokens", async () => {
  const result = await markitdownProbe(makeProbeContext(makeBasicFixture()))
  const serialized = JSON.stringify(result.outputs ?? {})

  const forbidden = [
    "raw office bytes", // raw input content
    "Refund policy", // raw markdown heading
    "Refunds are available", // raw markdown body
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

test("Ticket 21 #8: outputs carry bounded metadata only", async () => {
  const result = await markitdownProbe(makeProbeContext(makeBasicFixture()))
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
  ]
  for (const field of required) {
    assert.ok(field in outputs, `outputs must include ${field}`)
  }

  const allowed = new Set([
    ...required,
    "blocks",
    "durationMs",
  ])
  for (const key of Object.keys(outputs)) {
    assert.ok(allowed.has(key), `unexpected output key: ${key}`)
  }
})

// ============================================================
// #9 — Custom fixture revision derives different acceptance tenant
// ============================================================

test("Ticket 21 #9: custom fixture revision derives different acceptance tenant", async () => {
  const result = await markitdownProbe(
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

test("Ticket 21 #10: probe handles pre-aborted signal gracefully", async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await markitdownProbe({
    signal: controller.signal,
    deadlineMs: 30_000,
    fixture: makeBasicFixture(),
  })
  // Pre-aborted signal: probe must not hang. Either returns ok=false with
  // abort-related reason, OR returns ok=true with cancellation failure mode
  // recorded as "passed" (cancellation was observed and explicit).
  assert.ok(
    result.ok === false ||
      ((result.outputs?.failureModes as Record<string, string>)?.cancellation ===
        "passed"),
    "probe must handle pre-aborted signal without hanging",
  )
  assert.ok(result.durationMs < 5_000, "probe must return promptly even when aborted")
})
