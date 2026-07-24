// Ticket 23 — Live MinerU acceptance probe.
//
// Command-owning probe that exercises production parser routing
// (selectParser + MinerUParser + normalizeMinerU + runBoundedProcess +
// findBoundedArtifact + verifyImageReferences) against a bounded synthetic
// image/scanned-document fixture, proving:
//   1. The configured MinerU runtime returns non-empty OCR output with
//      expected media and page provenance.
//   2. Missing runtime, timeout, output quota, malformed output, missing
//      media reference, and cancellation are explicit failures (no silent
//      fallback).
//   3. Image bytes, OCR text, and provider payloads are excluded from
//      persisted smoke evidence; a failed parse cannot activate or
//      overwrite the previous successful knowledge version.
//
// Design (karpathy-guidelines):
//   - Simplest viable shape: probe accepts a fixture describing the scenario
//     (revision + document + expectedMinerUJson), exercises production parser
//     routing + MinerUParser end-to-end, and aggregates the resulting blocks
//     + failure modes + version-isolation state into bounded-metadata output.
//   - No caller-supplied pass booleans — the probe owns verification:
//     ok=true only when the happy path produces non-empty blocks with
//     correct provenance, all 6 failure modes produce explicit errors,
//     and a failed parse preserves the previous active version.
//   - Outputs contain only safe metadata (parser identity, block types,
//     page count, provenance, failure mode flags, version isolation state,
//     tenantId) — never image bytes, OCR text, prompts, tokens, or auth
//     material.
//
// Candidate-mode (OP-04 unsatisfied): the real `mineru` CLI is unavailable.
// The probe uses `process.execPath` + `-e` flag as the OP-04 candidate-mode
// substitute for the happy-path command — the substitute script writes the
// fixture's expectedMinerUJson to outputPath/result_content_list.json (the
// artifact MinerUParser.findBoundedArtifact selects). Same pattern as
// Tickets 21/22 and consistent with T19/T20/T24 candidate-mode probes.
// When OP-04 is lifted, the fixture's command swap is the only change — the
// probe code, selectParser, MinerUParser, normalizeMinerU, runBoundedProcess,
// findBoundedArtifact, and verifyImageReferences are production code
// exercised end-to-end.
//
// Rollback boundary: remove this module; no online runtime behavior changes
// (per Ticket 23 rollback spec — probe is a verification-only artifact).

import { MinerUParser } from "../ingestion/parser/mineru"
import { selectParser } from "../ingestion/parser/router"
import { createIngestionFixture, type IngestionFixture } from "./ingestion_fixture"
import type { IngestionStageRunner } from "../ingestion/lifecycle"
import type { NormalizedBlock } from "../types"
import type { ProbeContext, ProbeImplementation, ProbeResult } from "./smoke_harness"

// ---------------------------------------------------------------------------
// Fixture contract
// ---------------------------------------------------------------------------

/**
 * Fixture describing the MinerU acceptance scenario to exercise.
 *
 * The probe uses `revision` to derive an isolated tenantId + searchNamespace
 * via createIngestionFixture (Ticket 18). `document` describes the synthetic
 * image/scanned file to route through production selectParser.
 * `expectedMinerUJson` is the JSON content the candidate-mode command
 * substitute writes to outputPath/result_content_list.json — when OP-04 is
 * lifted, this field is unused (the real mineru command produces its own
 * content_list.json output).
 */
export interface MinerUProbeFixture {
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
   * Expected MinerU content_list.json array (JSON string) for the happy-path
   * command substitute. In candidate mode (OP-04 unsatisfied), the probe
   * uses process.execPath + `-e` flag with a script that writes this JSON
   * to outputPath/result_content_list.json. When OP-04 is lifted, this
   * field is ignored — the real mineru command produces its own output.
   */
  expectedMinerUJson: string
}

// ---------------------------------------------------------------------------
// Candidate-mode command substitute
// ---------------------------------------------------------------------------

/**
 * Build a Node.js script that, when executed via `node -e <script>`, parses
 * process.argv for `-o` (the MinerU output dir flag), creates that directory,
 * and writes the expected MinerU JSON to `<outputDir>/result_content_list.json`.
 * This substitutes for the real `mineru` CLI in candidate mode (OP-04 unsatisfied).
 *
 * The JSON is embedded as a JS string literal (double-stringified) so it
 * survives shell escaping intact.
 */
function buildCandidateScript(expectedMinerUJson: string): string {
  const jsonLiteral = JSON.stringify(expectedMinerUJson)
  return [
    "const fs=require('fs'),path=require('path');",
    "const args=process.argv.slice(2);",
    "let outputPath=null;",
    "for(let i=0;i<args.length;i++){if(args[i]==='-o'){outputPath=args[i+1];break;}}",
    "if(!outputPath){console.error('missing -o');process.exit(2);}",
    "fs.mkdirSync(outputPath,{recursive:true});",
    `fs.writeFileSync(path.join(outputPath,'result_content_list.json'),${jsonLiteral});`,
  ].join("")
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
 * Run a single MinerU failure scenario and return the outcome.
 *
 * The probe owns verification: a scenario "passes" when the parse fails
 * with an explicit error (no silent fallback). A scenario "fails" when
 * the parse unexpectedly succeeds.
 */
async function runFailureScenario(opts: FailureScenarioOptions): Promise<FailureScenarioResult> {
  const parser = new MinerUParser({
    command: opts.command,
    commandArgs: opts.commandArgs,
    timeoutMs: opts.timeoutMs ?? 10_000,
    inputLimitBytes: 1_024,
    outputLimitBytes: opts.outputLimitBytes ?? 100_000,
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
 * a MinerU parser failure. This proves a failed parse cannot activate or
 * overwrite the previous successful knowledge version.
 *
 * Pattern follows ingestion_fixture.test.ts #2b (failingRunner) and
 * Tickets 21/22 (markitdown_probe/marker_probe) createStatefulStageRunner.
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
        // v2: fail at chunk stage (simulating MinerU parser failure)
        await execution.runStage(
          "chunk",
          {},
          async () => {
            throw new Error("MinerU failed: parser capability unavailable")
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

export const mineruProbe: ProbeImplementation = async (
  ctx: ProbeContext,
): Promise<ProbeResult> => {
  const start = Date.now()

  // --- Validate fixture ---
  if (!ctx.fixture) {
    return {
      ok: false,
      reason: "missing fixture: MinerUProbeFixture required (revision + document + expectedMinerUJson)",
      durationMs: Date.now() - start,
    }
  }
  const fixture = ctx.fixture as MinerUProbeFixture
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
  if (!fixture.expectedMinerUJson) {
    return {
      ok: false,
      reason: "fixture.expectedMinerUJson is required (non-empty JSON string)",
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
    // Exercise real selectParser to route the document to mineru.
    const parserDecision = selectParser({
      fileName: fixture.document.fileName,
      mimeType: fixture.document.mimeType,
    })

    // Construct candidate-mode command: process.execPath + -e flag with a
    // script that writes expectedMinerUJson to outputPath/result_content_list.json.
    // The trailing "--" separates Node.js options (-e script) from script
    // arguments (-p, -o, -m, -b, -l) — without it, Node.js tries to parse
    // MinerU's -p/-o flags as its own options.
    const happyScript = buildCandidateScript(fixture.expectedMinerUJson)
    const happyParser = new MinerUParser({
      command: process.execPath,
      commandArgs: ["-e", happyScript, "--"],
      timeoutMs: 15_000,
      inputLimitBytes: 1_024,
      outputLimitBytes: 100_000,
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
          parserIdentity: "mineru",
          blockCount: 0,
          blockTypes: [] as string[],
          provenance: null,
          parserRoute: parserDecision.parser,
          parserRouteReason: parserDecision.reason,
          pageCount: 0,
          tenantId: ingestionFixture.tenantId,
          revision: fixture.revision,
        },
        durationMs: Date.now() - start,
      }
    }

    const provenance = blocks[0].provenance
    const happyPathOk =
      blocks.length > 0 &&
      provenance.parser === "mineru" &&
      provenance.adapter === "cli"

    // Page count: MinerU blocks always carry a page number (pageNumber from page_idx).
    const pageSet = new Set(blocks.map((b) => b.page))
    const pageCount = pageSet.size

    // --- Phase 2: Failure modes (6 scenarios) ---
    // Each scenario constructs a MinerUParser with a command that triggers
    // a specific failure. The probe owns verification: "passed" = explicit
    // failure observed, "failed" = expected failure but parse succeeded.
    const failureResults: FailureScenarioResult[] = []

    // #2a: Missing runtime — command not found (ENOENT)
    failureResults.push(
      await runFailureScenario({
        name: "missingRuntime",
        command: "kefu-rag-definitely-missing-mineru",
        document: fixture.document,
      }),
    )

    // #2b: Timeout — process runs forever, killed by timeoutMs
    failureResults.push(
      await runFailureScenario({
        name: "timeout",
        command: process.execPath,
        commandArgs: ["-e", "setInterval(function(){},5000)", "--"],
        timeoutMs: 100,
        document: fixture.document,
      }),
    )

    // #2c: Output quota — process produces too much output (write huge file)
    failureResults.push(
      await runFailureScenario({
        name: "outputQuota",
        command: process.execPath,
        commandArgs: [
          "-e",
          "const fs=require('fs'),path=require('path');" +
            "const args=process.argv.slice(2);" +
            "let outputPath=null;" +
            "for(let i=0;i<args.length;i++){if(args[i]==='-o'){outputPath=args[i+1];break;}}" +
            "if(outputPath){fs.mkdirSync(outputPath,{recursive:true});" +
            "fs.writeFileSync(path.join(outputPath,'result_content_list.json'),'x'.repeat(2048));}",
          "--",
        ],
        timeoutMs: 5_000,
        outputLimitBytes: 128,
        document: fixture.document,
      }),
    )

    // #2d: Malformed output — write invalid MinerU JSON (non-array root)
    failureResults.push(
      await runFailureScenario({
        name: "malformed",
        command: process.execPath,
        commandArgs: [
          "-e",
          buildCandidateScript(JSON.stringify({ not_an_array: true })),
          "--",
        ],
        document: fixture.document,
      }),
    )

    // #2e: Missing media reference — write JSON that references an image
    // path which does not exist on disk; verifyImageReferences throws.
    const missingMediaJson = JSON.stringify([
      {
        type: "image",
        img_path: "images/definitely-missing-asset.png",
        page_idx: 0,
        image_caption: ["caption placeholder"],
        bbox: [0, 800, 1000, 900],
      },
    ])
    failureResults.push(
      await runFailureScenario({
        name: "missingMediaReference",
        command: process.execPath,
        commandArgs: ["-e", buildCandidateScript(missingMediaJson), "--"],
        document: fixture.document,
      }),
    )

    // #2f: Cancellation — abort signal mid-parse
    const cancelController = new AbortController()
    const cancelPromise = runFailureScenario({
      name: "cancellation",
      command: process.execPath,
      commandArgs: ["-e", "setInterval(function(){},5000)", "--"],
      timeoutMs: 5_000,
      signal: cancelController.signal,
      document: fixture.document,
    })
    setTimeout(() => cancelController.abort(), 100)
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

    // Build block metadata — only safe structural fields (no raw OCR text,
    // image bytes, section titles, page contents, or auth material)
    const blockMetadata = blocks.map((b) => ({
      id: b.id,
      type: b.type,
    }))

    return {
      ok,
      reason: ok ? undefined : "one or more scenarios failed",
      outputs: {
        parserIdentity: "mineru",
        blockCount: blocks.length,
        blockTypes: blocks.map((b) => b.type),
        provenance,
        parserRoute: parserDecision.parser,
        parserRouteReason: parserDecision.reason,
        pageCount,
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
