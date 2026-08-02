// Ticket 21 — Live MarkItDown acceptance probe.
//
// Command-owning probe that exercises production parser routing
// (selectParser + MarkItDownParser + normalizeMarkItDown + runBoundedProcess)
// against a bounded synthetic common-document fixture, proving:
//   1. The configured MarkItDown runtime produces the expected non-empty
//      normalized block structure and parser identity.
//   2. Missing runtime, ABI failure, timeout, output quota, malformed output,
//      and cancellation are explicit failures (no silent fallback).
//   3. A failed parse cannot activate or overwrite the previous successful
//      knowledge version (version isolation via IngestionLifecycle).
//
// Design (karpathy-guidelines):
//   - Simplest viable shape: probe accepts a fixture describing the scenario
//     (revision + document + expectedMarkdown), exercises production parser
//     routing + MarkItDownParser end-to-end, and aggregates the resulting
//     blocks + failure modes + version-isolation state into a bounded-
//     metadata output.
//   - No caller-supplied pass booleans — the probe owns verification:
//     ok=true only when the happy path produces non-empty blocks with
//     correct provenance, all 6 failure modes produce explicit errors,
//     and a failed parse preserves the previous active version.
//   - Outputs contain only safe metadata (parser identity, block types,
//     provenance, failure mode flags, version isolation state, tenantId) —
//     never raw content, prompts, tokens, or auth material.
//
// Real-mode (OP-04 lifted 2026-07-25): the `markitdown` runtime is now
// installed and verified (markitdown 0.1.5; miniconda3 path). The probe
// uses the real `markitdown` command for the happy-path parse — same
// selectParser + MarkItDownParser + normalizeMarkItDown + runBoundedProcess
// production code paths as before. Failure scenarios still use
// `process.execPath` + `-e` flag for deterministic synthetic failures
// (missingRuntime, abiFailure, timeout, outputQuota, malformed, cancellation)
// because those scenarios need precise control over process behavior.
//
// Rollback boundary: remove this module; no online runtime behavior changes
// (per Ticket 21 rollback spec — probe is a verification-only artifact).

import { MarkItDownParser } from "../ingestion/parser/markitdown"
import { selectParser } from "../ingestion/parser/router"
import { createIngestionFixture, type IngestionFixture } from "./ingestion_fixture"
import type { IngestionStageRunner } from "../ingestion/lifecycle"
import type { NormalizedBlock } from "../types"
import type { ProbeContext, ProbeImplementation, ProbeResult } from "./smoke_harness"

// ---------------------------------------------------------------------------
// Fixture contract
// ---------------------------------------------------------------------------

/**
 * Fixture describing the MarkItDown acceptance scenario to exercise.
 *
 * The probe uses `revision` to derive an isolated tenantId + searchNamespace
 * via createIngestionFixture (Ticket 18). The `document` describes the
 * synthetic file to route through production selectParser. `expectedMarkdown`
 * is the markdown output the candidate-mode command substitute produces —
 * when OP-04 is lifted, this field is unused (the real markitdown command
 * produces its own output).
 */
export interface MarkItDownProbeFixture {
  /** Trusted repository revision (drives tenant + namespace isolation). */
  revision: string
  /** Synthetic document to route through production selectParser. */
  document: {
    fileName: string
    /** Raw bytes placeholder (synthetic — never production content). */
    content: string
    mimeType?: string
  }
  /**
   * Expected markdown output for the happy-path command substitute.
   * In candidate mode (OP-04 unsatisfied), the probe uses process.execPath
   * + `-e` flag to produce this markdown. When OP-04 is lifted, this field
   * is ignored — the real markitdown command produces its own output.
   */
  expectedMarkdown: string
}

// ---------------------------------------------------------------------------
// Failure scenario helper
// ---------------------------------------------------------------------------

interface FailureScenarioOptions {
  name: string
  command: string
  commandArgs?: string[]
  timeoutMs?: number
  outputLimitBytes?: number
  signal?: AbortSignal
  document: { content: string; fileName: string; mimeType?: string }
}

interface FailureScenarioResult {
  mode: string
  /** "passed" = explicit failure observed; "failed" = expected failure but parse succeeded */
  status: string
  /** Bounded error message (<= 512 chars) */
  error: string
}

/**
 * Run a single MarkItDown failure scenario and return the outcome.
 *
 * The probe owns verification: a scenario "passes" when the parse fails
 * with an explicit error (no silent fallback). A scenario "fails" when
 * the parse unexpectedly succeeds.
 */
async function runFailureScenario(
  opts: FailureScenarioOptions,
): Promise<FailureScenarioResult> {
  const parser = new MarkItDownParser({
    command: opts.command,
    commandArgs: opts.commandArgs,
    timeoutMs: opts.timeoutMs ?? 5_000,
    inputLimitBytes: 1_024,
    outputLimitBytes: opts.outputLimitBytes ?? 10_000,
  })
  try {
    await parser.parse({
      content: Buffer.from(opts.document.content),
      fileName: opts.document.fileName,
      mimeType: opts.document.mimeType,
      documentId: `probe-doc-${opts.name}`,
      signal: opts.signal,
    })
    return {
      mode: opts.name,
      status: "failed",
      error: "expected failure but parse succeeded",
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return {
      mode: opts.name,
      status: "passed",
      error: msg.slice(0, 512),
    }
  }
}

// ---------------------------------------------------------------------------
// Stateful stage runner for version isolation test
// ---------------------------------------------------------------------------

/**
 * Create a stateful IngestionStageRunner that succeeds for the first document
 * (v1) and fails at the chunk stage for the second document (v2), simulating
 * a MarkItDown parser failure. This proves a failed parse cannot activate
 * or overwrite the previous successful knowledge version.
 *
 * Pattern follows ingestion_fixture.test.ts #2b (failingRunner).
 */
function createStatefulStageRunner(): IngestionStageRunner {
  let callCount = 0
  return {
    async close() {},
    async run(_document, execution) {
      callCount += 1
      if (callCount === 1) {
        // v1: succeed — run all stages as no-ops (same as DEFAULT_STAGE_RUNNER)
        for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
          await execution.runStage(
            stage,
            {},
            async () => undefined,
            () => ({ stage }),
          )
        }
      } else {
        // v2: fail at chunk stage (simulating MarkItDown parser failure)
        await execution.runStage(
          "chunk",
          {},
          async () => {
            throw new Error("MarkItDown failed: parser capability unavailable")
          },
          () => ({ stage: "chunk" }),
        )
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Probe implementation
// ---------------------------------------------------------------------------

export const markitdownProbe: ProbeImplementation = async (
  ctx: ProbeContext,
): Promise<ProbeResult> => {
  const start = Date.now()

  // --- Validate fixture ---
  if (!ctx.fixture) {
    return {
      ok: false,
      reason: "missing fixture: MarkItDownProbeFixture required (revision + document + expectedMarkdown)",
      durationMs: Date.now() - start,
    }
  }
  const fixture = ctx.fixture as MarkItDownProbeFixture
  if (!fixture.revision) {
    return {
      ok: false,
      reason: "fixture.revision is required (non-empty)",
      durationMs: Date.now() - start,
    }
  }
  if (!fixture.document) {
    return {
      ok: false,
      reason: "fixture.document is required (fileName + content + optional mimeType)",
      durationMs: Date.now() - start,
    }
  }

  // Check for pre-aborted signal — probe cannot run if already aborted
  if (ctx.signal.aborted) {
    return {
      ok: false,
      reason: "signal already aborted — probe cannot run",
      durationMs: Date.now() - start,
    }
  }

  // --- Create ingestion fixture for version isolation + tenant derivation ---
  // Uses a stateful stage runner that succeeds for v1 and fails for v2,
  // simulating a MarkItDown parser failure to prove version isolation.
  let ingestionFixture: IngestionFixture
  try {
    ingestionFixture = createIngestionFixture({
      revision: fixture.revision,
      stageRunner: createStatefulStageRunner(),
    })
  } catch (err) {
    return {
      ok: false,
      reason: `failed to create ingestion fixture: ${
        err instanceof Error ? err.message : String(err)
      }`,
      durationMs: Date.now() - start,
    }
  }

  try {
    // --- Phase 1: Happy path — production parser routing + parse ---
    // Exercise real selectParser to route the document to markitdown.
    const parserDecision = selectParser({
      fileName: fixture.document.fileName,
      mimeType: fixture.document.mimeType,
    })

    // Real markitdown command (OP-04 lifted): the fixture's document content
    // is real markdown text written to a .md temp file, so `markitdown` parses
    // it as-is. No commandArgs needed — markitdown accepts a file path
    // positional argument produced by MarkItDownParser.runBoundedProcess.
    const happyParser = new MarkItDownParser({
      command: "markitdown",
      timeoutMs: 5_000,
      inputLimitBytes: 1_024,
      outputLimitBytes: 10_000,
    })

    let blocks: NormalizedBlock[] = []
    let happyPathError: string | null = null
    try {
      blocks = await happyParser.parse({
        content: Buffer.from(fixture.document.content),
        fileName: fixture.document.fileName,
        mimeType: fixture.document.mimeType,
        documentId: "probe-doc-happy",
        signal: ctx.signal,
      })
    } catch (error) {
      happyPathError = error instanceof Error ? error.message : String(error)
    }

    if (happyPathError || blocks.length === 0) {
      return {
        ok: false,
        reason: `happy path failed: ${happyPathError ?? "no normalized blocks produced"}`,
        outputs: {
          parserIdentity: "markitdown",
          blockCount: 0,
          blockTypes: [] as string[],
          provenance: null,
          parserRoute: parserDecision.parser,
          parserRouteReason: parserDecision.reason,
          tenantId: ingestionFixture.tenantId,
          revision: fixture.revision,
        },
        durationMs: Date.now() - start,
      }
    }

    const provenance = blocks[0].provenance
    const happyPathOk =
      blocks.length > 0 &&
      provenance.parser === "markitdown" &&
      provenance.adapter === "cli"

    // --- Phase 2: Failure modes (6 scenarios) ---
    // Each scenario constructs a MarkItDownParser with a command that triggers
    // a specific failure. The probe owns verification: "passed" = explicit
    // failure observed, "failed" = expected failure but parse succeeded.
    const failureResults: FailureScenarioResult[] = []

    // #2a: Missing runtime — command not found (ENOENT)
    failureResults.push(
      await runFailureScenario({
        name: "missingRuntime",
        command: "kefu-rag-definitely-missing-markitdown",
        document: fixture.document,
      }),
    )

    // #2b: ABI failure — process starts, writes ModuleNotFoundError to stderr,
    // exits non-zero (simulates the real broken markitdown.exe ABI cascade)
    failureResults.push(
      await runFailureScenario({
        name: "abiFailure",
        command: process.execPath,
        commandArgs: [
          "-e",
          "process.stderr.write('ModuleNotFoundError: No module named numpy._core._multiarray_umath'); process.exit(1)",
        ],
        document: fixture.document,
      }),
    )

    // #2c: Timeout — process runs forever, killed by timeoutMs
    failureResults.push(
      await runFailureScenario({
        name: "timeout",
        command: process.execPath,
        commandArgs: ["-e", "setInterval(() => {}, 5000)"],
        timeoutMs: 100,
        outputLimitBytes: 1_024,
        document: fixture.document,
      }),
    )

    // #2d: Output quota — process produces too much output
    failureResults.push(
      await runFailureScenario({
        name: "outputQuota",
        command: process.execPath,
        commandArgs: ["-e", "process.stdout.write('x'.repeat(2048))"],
        timeoutMs: 5_000,
        outputLimitBytes: 128,
        document: fixture.document,
      }),
    )

    // #2e: Malformed output — unclosed fenced code block
    failureResults.push(
      await runFailureScenario({
        name: "malformed",
        command: process.execPath,
        commandArgs: ["-e", "process.stdout.write('```json\\n{')"],
        document: fixture.document,
      }),
    )

    // #2f: Cancellation — abort signal mid-parse
    const cancelController = new AbortController()
    const cancelPromise = runFailureScenario({
      name: "cancellation",
      command: process.execPath,
      commandArgs: ["-e", "setInterval(() => {}, 5000)"],
      timeoutMs: 5_000,
      outputLimitBytes: 1_024,
      signal: cancelController.signal,
      document: fixture.document,
    })
    setTimeout(() => cancelController.abort(), 50)
    failureResults.push(await cancelPromise)

    // Aggregate failure modes into output maps
    const failureModes: Record<string, string> = {}
    const failureErrors: Record<string, string> = {}
    for (const result of failureResults) {
      failureModes[result.mode] = result.status
      failureErrors[result.mode] = result.error
    }

    const allFailuresPassed = failureResults.every((r) => r.status === "passed")

    // --- Phase 3: Version isolation ---
    // Ingest v1 successfully (stateful stage runner succeeds for first call),
    // then ingest v2 which fails at chunk stage (simulating parser failure).
    // Verify v1 remains active and v2 is not activated.
    const v1 = ingestionFixture.ingestBounded({
      title: "Original Policy",
      content: "original content v1",
    })
    await ingestionFixture.lifecycle.runNext()

    const v1ActiveBefore = ingestionFixture.lifecycle.getStatus(v1.docId)
      ?.documentVersion.active

    const v2 = ingestionFixture.ingestBounded({
      title: "Replacement Policy",
      content: "replacement content v2",
    })
    const v2RunResult = await ingestionFixture.lifecycle.runNext()

    const v1StatusAfter = ingestionFixture.lifecycle.getStatus(v1.docId)
    const v2StatusAfter = ingestionFixture.lifecycle.getStatus(v2.docId)

    const v1StillActive = v1StatusAfter?.documentVersion.active === true
    const v2NotActive = v2StatusAfter?.documentVersion.active === false
    const v2FailedStatus = v2StatusAfter?.documentStatus ?? "unknown"
    const v2RunFailed = v2RunResult?.success === false

    const versionIsolation = {
      previousActivePreserved: v1StillActive,
      failedVersionNotActivated: v2NotActive,
      failedVersionStatus: v2FailedStatus,
      activeVersionId: v1StillActive ? v1.docId : null,
    }

    const versionIsolationOk = v1StillActive && v2NotActive && v2RunFailed

    // --- Aggregate final result ---
    const ok = happyPathOk && allFailuresPassed && versionIsolationOk

    // Build block metadata — only safe structural fields (no raw text or
    // section titles, which are derived from document content)
    const blockMetadata = blocks.map((b) => ({
      id: b.id,
      type: b.type,
    }))

    return {
      ok,
      reason: ok ? undefined : "one or more scenarios failed",
      outputs: {
        parserIdentity: "markitdown",
        blockCount: blocks.length,
        blockTypes: blocks.map((b) => b.type),
        provenance,
        parserRoute: parserDecision.parser,
        parserRouteReason: parserDecision.reason,
        blocks: blockMetadata,
        failureModes,
        failureErrors,
        versionIsolation,
        tenantId: ingestionFixture.tenantId,
        revision: fixture.revision,
      },
      durationMs: Date.now() - start,
    }
  } finally {
    // Always clean up the ingestion fixture — release the in-memory db
    // and any resources held by the stage runner.
    await ingestionFixture.cleanup()
  }
}
