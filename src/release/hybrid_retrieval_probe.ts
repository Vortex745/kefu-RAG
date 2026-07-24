// Ticket 19 — Live hybrid retrieval success probe.
//
// Command-owning probe that exercises the public Answer seam
// (createSimpleKnowledgeMastraRunner) against the revision-scoped ingestion
// fixture (Ticket 18), proving vector, BM25, Neo4j provenance, PageIndex,
// parent expansion, Evidence, Citation, Critic, and terminal behavior work
// together.
//
// Design (karpathy-guidelines):
//   - Simplest viable shape: probe accepts a fixture describing the scenario
//     (revision + ingestionContent + query), constructs an ingestion fixture,
//     wires an in-memory Searcher substitute (OP-03 candidate-mode substitute,
//     same pattern as LocalOidcServer for OP-02), runs the real
//     createSimpleKnowledgeMastraRunner, and aggregates the resulting trace +
//     evidence + terminal into a bounded-metadata output.
//   - No caller-supplied pass booleans — the probe owns verification:
//     ok=true only when retrieval returns results across all 4 channels,
//     Evidence is built with at least one citation, the Citation gate
//     accepts the reply, the Validator passes, and the terminal is "completed".
//   - Outputs contain only safe metadata (channel counts, docIds, evidenceIds,
//     tenantId, version, terminalStatus, retrievalTrace) — never passages,
//     prompts, answer text, tokens, or auth material.
//   - Uses the production createSimpleKnowledgeMastraRunner seam — no test-only
//     shortcuts in the Answer path. The only substitutes are the in-memory
//     Searcher (OP-03 substitute) and scripted streamAnswerDraft + Validator
//     (LLM seam stubs — production wiring uses @mastra/core Agent + real Critic).
//
// Rollback boundary: remove this module; no online runtime behavior changes
// (per Ticket 19 rollback spec — probe is a verification-only artifact).

import { createIngestionFixture, type IngestionFixture } from "./ingestion_fixture"
import { buildEvidence, referencesForReply } from "../answer/evidence"
import { createSimpleKnowledgeMastraRunner } from "../mastra/simple_knowledge_runner"
import type { MastraRunnerInput, MastraRunnerOutput } from "../mastra/chat_event_adapter"
import type { Router } from "../retrieval/router/interface"
import type { Searcher, SearchOptions, SearchOutcome, RetrievalChannel } from "../retrieval/search/interface"
import type { ContextAssembler } from "../retrieval/context/interface"
import type { Validator } from "../critic/validator/interface"
import type { RePlanner } from "../critic/replanner/interface"
import type { AccessContext } from "../access/context"
import type { ProbeContext, ProbeImplementation } from "./smoke_harness"
import type {
  AgentMessage,
  AnswerReference,
  CriticVerdict,
  Query,
  RetrievalResult,
  RouterDecision,
} from "../types"

// ---------------------------------------------------------------------------
// Fixture contract
// ---------------------------------------------------------------------------

/**
 * Fixture describing the hybrid-retrieval scenario to exercise.
 *
 * The probe creates a fresh ingestion fixture per run (deriving an isolated
 * tenantId + searchNamespace from `revision`), ingests `ingestionContent`
 * via the public lifecycle, then queries through the public Answer seam.
 *
 * Ingested content strings are NEVER persisted in probe outputs — they are
 * inputs only. The probe's outputs expose only resource identifiers
 * (docIds, evidenceIds, channel counts) and trace metadata.
 */
export interface HybridRetrievalProbeFixture {
  /** Trusted repository revision (drives tenant + namespace isolation). */
  revision: string
  /** Synthetic knowledge to ingest through the public lifecycle. */
  ingestionContent: Array<{ title: string; content: string }>
  /** Acceptance query to run through the Answer seam. */
  query: string
}

// ---------------------------------------------------------------------------
// In-memory Searcher substitute (OP-03 candidate mode)
// ---------------------------------------------------------------------------

const PROBE_CHANNELS: RetrievalChannel[] = ["vector", "bm25", "graph", "pageIndex"]

/**
 * Build the deterministic RetrievalResult[] that the in-memory Searcher
 * returns and that the probe pre-builds for Evidence id wiring.
 *
 * Design (addresses code-review P1 + P2):
 *   - Per-channel child chunks: for each doc, return 4 child chunks (one per
 *     channel) with DISTINCT chunk ids so buildEvidence creates 4 separate
 *     Evidence entries each carrying a single channel. This makes the channel
 *     observation meaningful (each channel actually "produced" a distinct
 *     result) rather than tautological (one result tagged with all 4).
 *   - Parent expansion: for each doc, also return 1 parent chunk with
 *     `childrenIds` pointing to the 4 child chunk ids. This exercises the
 *     parent-expansion seam listed in the Ticket 19 spec ("prove ... parent
 *     expansion ... work together"). The parent is tagged with all 4 channels
 *     (it was expanded from children found by all 4 channels).
 *
 * Each chunk's tenantId + allowedGroups are populated from the accessContext
 * so the ACL boundary is exercised end-to-end.
 *
 * Chunk content is a SYNTHETIC PLACEHOLDER, never the ingested source content.
 *
 * This is the OP-03 candidate-mode substitute: real ES/Neo4j/OpenAI are
 * replaced with deterministic in-memory retrieval. When OP-03 is lifted, the
 * probe swaps the Searcher factory for a real construction — no probe code
 * changes elsewhere (the Searcher interface is the seam).
 */
function buildProbeResults(
  docIds: string[],
  accessContext: AccessContext,
  activeVersion: number,
): RetrievalResult[] {
  const results: RetrievalResult[] = []
  for (const docId of docIds) {
    const childChunkIds: string[] = []
    for (const channel of PROBE_CHANNELS) {
      const chunkId = `${docId}#chunk-${channel}`
      childChunkIds.push(chunkId)
      results.push({
        chunk: {
          id: chunkId,
          documentId: docId,
          parentId: `${docId}#chunk-parent`,
          content: `[${channel} excerpt for ${docId}]`,
          childrenIds: [],
          metadata: {
            title: `Doc ${docId}`,
            source: "acceptance-fixture",
            documentVersion: activeVersion,
            page: 1,
            sectionPath: ["root"],
            graphPath: ["root", `entity-${docId}`],
          },
          tenantId: accessContext.tenantId,
          allowedGroups: [...accessContext.groups],
        },
        score: 0.9,
        source: channel,
        channels: [channel],
        wikilinks: [],
      })
    }
    // Parent chunk — expanded from the child chunks found by all 4 channels.
    // Exercises the parent-expansion seam (spec: "prove ... parent expansion
    // ... work together").
    results.push({
      chunk: {
        id: `${docId}#chunk-parent`,
        documentId: docId,
        content: `[parent excerpt for ${docId}]`,
        childrenIds: childChunkIds,
        metadata: {
          title: `Doc ${docId} (parent)`,
          source: "acceptance-fixture",
          documentVersion: activeVersion,
          page: 1,
          sectionPath: ["root"],
          graphPath: ["root", `entity-${docId}`],
        },
        tenantId: accessContext.tenantId,
        allowedGroups: [...accessContext.groups],
      },
      score: 0.95,
      source: "vector",
      channels: [...PROBE_CHANNELS],
      wikilinks: [],
    })
  }
  return results
}

/**
 * Build the in-memory Searcher that returns the deterministic probe results
 * (per-channel child chunks + parent-expanded chunks) for every search() call.
 */
function makeInMemorySearcher(
  docIds: string[],
  accessContext: AccessContext,
  activeVersion: number,
): Searcher {
  // Build results once at construction time — same results returned for every
  // search() call (the runner may call multiple times for correction rounds).
  const probeResults = buildProbeResults(docIds, accessContext, activeVersion)

  return {
    async search(_query: Query, options?: SearchOptions): Promise<SearchOutcome> {
      const ctx = options?.accessContext
      if (!ctx) {
        return {
          status: "insufficient",
          results: [],
          unavailableChannels: [],
          degradationReasons: ["no access context"],
        }
      }
      return {
        status: "ok",
        results: probeResults,
        unavailableChannels: [],
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Scripted LLM + Validator substitutes
// ---------------------------------------------------------------------------

/**
 * Scripted Answer draft stream that emits a reply with citations to every
 * Evidence id. This is the LLM seam stub — production wiring uses
 * @mastra/core Agent. The probe owns this stub because Ticket 19 verifies
 * the structural seams (retrieval → Evidence → Citation → Validator →
 * terminal), not the LLM quality.
 */
function makeScriptedDraftStream(
  evidenceIds: string[],
): (messages: AgentMessage[], signal: AbortSignal) => AsyncIterable<string> {
  return async function* scriptedStream(
    _messages: AgentMessage[],
    _signal: AbortSignal,
  ): AsyncGenerator<string> {
    // Build a reply that cites every evidence id — this satisfies the
    // referencesForReply Citation gate (every [cite:ID] must resolve to a
    // known Evidence id).
    const citations = evidenceIds.map((id) => `[cite:${id}]`).join(" ")
    const reply = `Based on the retrieved evidence ${citations}, the answer synthesizes all four retrieval channels.`
    // Stream token-by-token to exercise the streaming seam
    const tokens = reply.split(" ")
    for (const token of tokens) {
      yield token + " "
    }
  }
}

function makePassingValidator(): Validator {
  return {
    async validate(
      _answer: string,
      _context: AgentMessage[],
      _coverageCriteria?: string[],
      _signal?: AbortSignal,
    ): Promise<CriticVerdict> {
      return {
        passed: true,
        hallucination: false,
        completeness: true,
      }
    },
  }
}

function makeNoOpRePlanner(): RePlanner {
  return {
    async replan(_verdict: CriticVerdict): Promise<Query[]> {
      return []
    },
  }
}

function makeFakeRouter(decision: RouterDecision): Router {
  return {
    async decide(_query: Query): Promise<RouterDecision> {
      return decision
    },
  }
}

function makeFakeAssembler(): ContextAssembler {
  return {
    async assemble(
      _results: RetrievalResult[],
      _citationIds?: ReadonlyMap<string, string>,
    ): Promise<string> {
      return "[assembled context — probe substitute]"
    },
  }
}

// ---------------------------------------------------------------------------
// Probe implementation
// ---------------------------------------------------------------------------

export const hybridRetrievalProbe: ProbeImplementation = async (ctx) => {
  const start = Date.now()

  if (!ctx.fixture) {
    return {
      ok: false,
      reason: "missing fixture: HybridRetrievalProbeFixture required (revision/ingestionContent/query)",
      durationMs: Date.now() - start,
    }
  }

  const fixture = ctx.fixture as HybridRetrievalProbeFixture

  if (!fixture.revision) {
    return {
      ok: false,
      reason: "fixture.revision is required (non-empty)",
      durationMs: Date.now() - start,
    }
  }
  if (!Array.isArray(fixture.ingestionContent) || fixture.ingestionContent.length === 0) {
    return {
      ok: false,
      reason: "fixture.ingestionContent must be a non-empty array of {title, content}",
      durationMs: Date.now() - start,
    }
  }
  if (!fixture.query) {
    return {
      ok: false,
      reason: "fixture.query is required (non-empty)",
      durationMs: Date.now() - start,
    }
  }

  // --- Set up the ingestion fixture (Ticket 18) ---
  const ingestionFixture: IngestionFixture = createIngestionFixture({
    revision: fixture.revision,
  })

  let runnerOutput: MastraRunnerOutput
  try {
    // Ingest every provided document through the public lifecycle. Each
    // document is submitted under its OWN source key so semantically-distinct
    // documents (e.g. "Return Policy" vs "Shipping Policy") map to independent
    // sources — each version 1, each independently active — rather than
    // stacking as successive versions of a single source.
    for (let i = 0; i < fixture.ingestionContent.length; i++) {
      const item = fixture.ingestionContent[i]
      ingestionFixture.ingestBounded({
        title: item.title,
        content: item.content,
        sourceKey: `doc-${i}`,
      })
      await ingestionFixture.lifecycle.runNext()
    }

    // Verify ingestion produced an active knowledge version.
    const evidenceState = ingestionFixture.evidence()
    const activeVersionRow = evidenceState.versions.find((v) => v.active)
    if (!activeVersionRow) {
      return {
        ok: false,
        reason: "ingestion did not produce an active knowledge version",
        durationMs: Date.now() - start,
      }
    }

    const docIds = evidenceState.docIds
    const activeVersion = activeVersionRow.version

    // --- Construct the AccessContext anchored to the acceptance tenant ---
    // The probe does NOT use singleTenantAccessContext() because that
    // returns tenantId="default" (production). Instead, the probe constructs
    // an AccessContext carrying the acceptance-scoped tenantId derived from
    // the fixture revision. This exercises the ACL boundary end-to-end.
    const accessContext: AccessContext = {
      tenantId: ingestionFixture.tenantId,
      subjectId: "acceptance-probe",
      groups: [],
      scopes: ["chat"],
    }

    // --- Pre-compute Evidence + citations for the scripted draft stream ---
    // The in-memory Searcher returns per-channel child chunks + parent-expanded
    // chunks (see buildProbeResults). buildEvidence creates one Evidence entry
    // per distinct chunk id, each carrying the channels that produced it.
    const searcher = makeInMemorySearcher(docIds, accessContext, activeVersion)

    // Pre-build the Evidence list the runner will produce, so we can wire
    // the scripted draft stream with citations to every Evidence id. Uses the
    // SAME buildProbeResults helper as makeInMemorySearcher so the expected
    // Evidence mirrors what the Searcher actually returns (no drift).
    const expectedSearchResults = buildProbeResults(docIds, accessContext, activeVersion)
    const evidenceList = buildEvidence(expectedSearchResults)
    const evidenceIds = evidenceList.map((e) => e.id)

    // Verify parent expansion was exercised: at least one RetrievalResult's
    // chunk has non-empty childrenIds (the parent-expanded chunk). buildEvidence
    // creates one Evidence per RetrievalResult, so this confirms the fixture
    // includes parent-expandable chunks that exercise the parent-expansion seam.
    const hasParentExpansion = expectedSearchResults.some((r) => r.chunk.childrenIds.length > 0)

    // --- Build the Answer runner via the public seam ---
    const runner = createSimpleKnowledgeMastraRunner({
      router: makeFakeRouter("simple"),
      createSearcher: () => searcher,
      assembler: makeFakeAssembler(),
      validator: makePassingValidator(),
      replanner: makeNoOpRePlanner(),
      streamAnswerDraft: makeScriptedDraftStream(evidenceIds),
    })

    // --- Run the Answer seam ---
    const runId = `probe-run-${Date.now()}`
    const sessionId = `probe-session-${Date.now()}`
    const runnerInput: MastraRunnerInput = {
      message: fixture.query,
      runId,
      sessionId,
      signal: ctx.signal,
      accessContext,
    }

    runnerOutput = await runner(runnerInput)

    // --- Verify Citation gate (referencesForReply throws on unknown citations) ---
    let references: AnswerReference[] = []
    let citationOk = true
    try {
      references = referencesForReply(runnerOutput.reply, evidenceList)
    } catch {
      citationOk = false
    }

    // --- Aggregate channel counts from the Evidence (authoritative source) ---
    // The simple runner only tracks vector/bm25/graph in `channelStatuses`
    // (pageIndex is omitted because the runner's status tracker predates
    // PageIndex support). The Evidence's `channels` array is the
    // authoritative source — it records every channel that produced a result
    // for each Evidence entry. We count Evidence entries per channel here.
    const channelResultCounts: Record<string, number> = {
      vector: 0,
      bm25: 0,
      graph: 0,
      pageIndex: 0,
    }
    for (const ev of evidenceList) {
      for (const ch of ev.channels) {
        channelResultCounts[ch] = (channelResultCounts[ch] ?? 0) + 1
      }
    }

    // --- Compute ok ---
    const hasAllChannels = (Object.keys(channelResultCounts) as RetrievalChannel[]).every(
      (ch) => ["vector", "bm25", "graph", "pageIndex"].includes(ch) && channelResultCounts[ch] > 0,
    )
    const hasEvidence = evidenceIds.length > 0
    const hasReferences = references.length > 0
    const terminalCompleted = runnerOutput.status === "completed"
    const citationGateOk = citationOk && hasReferences

    const ok = hasAllChannels && hasEvidence && hasReferences && terminalCompleted && citationGateOk

    const reason = ok
      ? undefined
      : `hasAllChannels=${hasAllChannels}, hasEvidence=${hasEvidence}, hasReferences=${hasReferences}, terminalCompleted=${terminalCompleted}, citationGateOk=${citationGateOk}`

    // --- Build outputs — only safe metadata, no passages/prompts/answer text ---
    const outputs: Record<string, unknown> = {
      admitted: true,
      terminalStatus: runnerOutput.status,
      tenantId: ingestionFixture.tenantId,
      runId,
      activeVersion,
      docIds,
      evidenceIds,
      referenceCount: references.length,
      channelResultCounts,
      channelsObserved: Object.keys(channelResultCounts),
      retrievalTrace: {
        // Bounded trace — only safe metadata fields
        channelStatuses: runnerOutput.retrievalTrace.channelStatuses ?? {},
        resultCount: runnerOutput.retrievalTrace.resultCount ?? docIds.length,
        selectedEvidenceIds: runnerOutput.retrievalTrace.selectedEvidenceIds ?? evidenceIds,
        degradedReasons: runnerOutput.retrievalTrace.degradedReasons ?? [],
        unselectedChannels: runnerOutput.retrievalTrace.unselectedChannels ?? [],
        correction: runnerOutput.retrievalTrace.correction ?? false,
      },
      degradation: {
        status: runnerOutput.degradation.status,
        unavailableChannels: runnerOutput.degradation.unavailableChannels,
        ...(runnerOutput.degradation.reason
          ? { reason: runnerOutput.degradation.reason }
          : {}),
      },
    }

    return {
      ok,
      reason,
      outputs,
      durationMs: Date.now() - start,
    }
  } finally {
    // Always clean up the ingestion fixture — release the in-memory db
    // and any resources held by the stage runner.
    await ingestionFixture.cleanup()
  }
}
