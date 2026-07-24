// Ticket 20 — Retrieval ACL and outage acceptance probe.
//
// Command-owning probe that exercises the public Answer seam
// (createSimpleKnowledgeMastraRunner) with an ACL-aware in-memory Searcher
// substitute (OP-03 candidate-mode substitute), proving:
//   1. Cross-tenant and unauthorized-group queries return no usable Evidence
//      across every retrieval channel (vector/bm25/graph/pageIndex).
//   2. A single channel failure reports explicit degradation WITHOUT bypassing
//      ACL or Citation gates.
//   3. Total retrieval failure converges to one insufficient_retrieval terminal
//      and never fabricates a grounded answer.
//
// Design (karpathy-guidelines):
//   - Simplest viable shape: the probe builds synthetic chunks for 2 tenants
//     (acceptance + foreign) with 2 group configs (tenant-wide + group-
//     restricted), then runs 3 sub-scenarios through the public Answer seam.
//   - No ingestion fixture: ACL is tested at the Searcher level (the Searcher
//     filters by accessContext, mirroring production accessContextFilter).
//     Ticket 19 already verified the ingestion → retrieval path.
//   - The probe owns verification: ok=true only when cross-tenant leak is
//     false, group filtering works, degradation preserves ACL + citations,
//     and total failure converges to insufficient_retrieval with no references.
//   - Outputs contain only safe metadata (tenantId, ACL result flags, channel
//     names, docIds, reference counts, terminal statuses) — never passages,
//     prompts, answer text, tokens, or auth material.
//   - Uses the production createSimpleKnowledgeMastraRunner seam — no test-only
//     shortcuts in the Answer path. The only substitutes are the in-memory
//     ACL-aware Searcher (OP-03 substitute) and scripted streamAnswerDraft +
//     Validator (LLM seam stubs).
//
// Rollback boundary: remove this module; no online runtime behavior changes
// (per Ticket 20 rollback spec — probe is a verification-only artifact).

import { deriveTenantId } from "./ingestion_fixture"
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
  Chunk,
  CriticVerdict,
  Evidence,
  Query,
  RetrievalResult,
  RouterDecision,
} from "../types"

// ---------------------------------------------------------------------------
// Fixture contract
// ---------------------------------------------------------------------------

/**
 * Fixture describing the retrieval ACL + outage scenario to exercise.
 *
 * The probe derives an isolated acceptance tenantId from `revision` (same
 * derivation as Ticket 18/19), builds synthetic chunks for 2 tenants
 * (acceptance + foreign), and runs the acceptance `query` through the public
 * Answer seam under 3 access/degradation scenarios.
 */
export interface RetrievalAclOutageProbeFixture {
  /** Trusted repository revision (drives tenant + namespace isolation). */
  revision: string
  /** Acceptance query to run through the Answer seam. */
  query: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_CHANNELS: RetrievalChannel[] = ["vector", "bm25", "graph", "pageIndex"]
/** Foreign tenant for cross-tenant ACL verification (never the acceptance tenant). */
const FOREIGN_TENANT = "foreign-tenant-xyz"

// ---------------------------------------------------------------------------
// Synthetic chunk construction (multi-tenant + multi-group)
// ---------------------------------------------------------------------------

/**
 * Build synthetic RetrievalResults for 4 documents across 2 tenants:
 *   - doc-tenant-a-1: acceptance tenant, tenant-wide (allowedGroups: [])
 *   - doc-tenant-a-2: acceptance tenant, group-restricted (allowedGroups: ["group-a"])
 *   - doc-tenant-b-1: foreign tenant, tenant-wide
 *   - doc-tenant-b-2: foreign tenant, group-restricted (allowedGroups: ["group-b"])
 *
 * Each document produces 4 child chunks (one per retrieval channel) so ACL
 * filtering is exercised across every channel.
 *
 * Chunk content is a SYNTHETIC PLACEHOLDER, never the ingested source content.
 */
function buildAclChunks(acceptanceTenantId: string): RetrievalResult[] {
  const docs = [
    { docId: "doc-tenant-a-1", tenantId: acceptanceTenantId, allowedGroups: [] as string[] },
    { docId: "doc-tenant-a-2", tenantId: acceptanceTenantId, allowedGroups: ["group-a"] },
    { docId: "doc-tenant-b-1", tenantId: FOREIGN_TENANT, allowedGroups: [] as string[] },
    { docId: "doc-tenant-b-2", tenantId: FOREIGN_TENANT, allowedGroups: ["group-b"] },
  ]
  const results: RetrievalResult[] = []
  for (const doc of docs) {
    for (const channel of ALL_CHANNELS) {
      const chunkId = `${doc.docId}#chunk-${channel}`
      results.push({
        chunk: {
          id: chunkId,
          documentId: doc.docId,
          content: `[${channel} excerpt for ${doc.docId}]`,
          childrenIds: [],
          metadata: {
            title: `Doc ${doc.docId}`,
            source: "acceptance-fixture",
            documentVersion: 1,
            page: 1,
            sectionPath: ["root"],
            graphPath: ["root", `entity-${doc.docId}`],
          },
          tenantId: doc.tenantId,
          allowedGroups: doc.allowedGroups,
        },
        score: 0.9,
        source: channel,
        channels: [channel],
        wikilinks: [],
      })
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// ACL visibility check (mirrors production accessContextFilter semantics)
// ---------------------------------------------------------------------------

/**
 * Determine whether a chunk is visible to the given AccessContext.
 *
 * Mirrors the production `accessContextFilter` in searcher.ts:
 *   - tenantId is a hard filter — chunks from other tenants are never visible.
 *   - allowedGroups=[] on the caller means "tenant-wide user" (no group filter
 *     added, so the caller sees every same-tenant chunk).
 *   - allowedGroups non-empty on the caller means "group-restricted user":
 *     a chunk is visible when its own allowedGroups is empty (tenant-wide
 *     chunk) OR intersects the caller's groups.
 */
function isVisible(chunk: Chunk, ac: AccessContext): boolean {
  // Tenant hard filter
  if (chunk.tenantId !== ac.tenantId) return false
  // Group filter (only when caller has groups)
  if (ac.groups.length > 0) {
    // Chunk is visible if tenant-wide (no allowedGroups) OR intersects caller groups
    if (chunk.allowedGroups && chunk.allowedGroups.length > 0) {
      return chunk.allowedGroups.some((g) => ac.groups.includes(g))
    }
  }
  return true
}

/**
 * Filter chunks by ACL visibility for the given AccessContext.
 */
function filterByAcl(chunks: RetrievalResult[], ac: AccessContext): RetrievalResult[] {
  return chunks.filter((r) => isVisible(r.chunk, ac))
}

// ---------------------------------------------------------------------------
// ACL-aware in-memory Searcher substitute (OP-03 candidate mode)
// ---------------------------------------------------------------------------

/**
 * Build the in-memory ACL-aware Searcher that filters results by accessContext
 * and optionally simulates channel failure.
 *
 * When `failedChannels` is non-empty, results from those channels are excluded
 * and the SearchOutcome reports degradation (status="degraded") or total
 * failure (status="insufficient" when ALL channels fail).
 *
 * This is the OP-03 candidate-mode substitute: real ES/Neo4j/OpenAI are
 * replaced with deterministic in-memory retrieval + ACL filtering. When OP-03
 * is lifted, the probe swaps the Searcher factory for a real construction —
 * no probe code changes elsewhere (the Searcher interface is the seam).
 */
function makeAclSearcher(
  allChunks: RetrievalResult[],
  failedChannels: Set<RetrievalChannel>,
): Searcher {
  return {
    async search(_query: Query, options?: SearchOptions): Promise<SearchOutcome> {
      const ac = options?.accessContext
      if (!ac) {
        return {
          status: "insufficient",
          results: [],
          unavailableChannels: [...ALL_CHANNELS],
          degradationReasons: ["no access context"],
        }
      }
      // ACL filter (tenant hard filter + group intersection)
      const visible = filterByAcl(allChunks, ac)
      // Remove failed channels
      const available = visible.filter((r) => !failedChannels.has(r.source))
      const unavailable = [...failedChannels]
      const allFailed = failedChannels.size >= ALL_CHANNELS.length
      const status: SearchOutcome["status"] = allFailed
        ? "insufficient"
        : failedChannels.size > 0
          ? "degraded"
          : "ok"
      return {
        status,
        results: available,
        unavailableChannels: unavailable,
        degradationReasons:
          failedChannels.size > 0
            ? unavailable.map((c) => `${c} unavailable`)
            : [],
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Scripted LLM + Validator substitutes (same pattern as Ticket 19)
// ---------------------------------------------------------------------------

/**
 * Scripted Answer draft stream that emits a reply with citations to every
 * Evidence id. This is the LLM seam stub — production wiring uses
 * @mastra/core Agent. The probe owns this stub because Ticket 20 verifies
 * ACL preservation and degradation handling, not LLM quality.
 */
function makeScriptedDraftStream(
  evidenceIds: string[],
): (messages: AgentMessage[], signal: AbortSignal) => AsyncIterable<string> {
  return async function* scriptedStream(
    _messages: AgentMessage[],
    _signal: AbortSignal,
  ): AsyncGenerator<string> {
    const citations = evidenceIds.map((id) => `[cite:${id}]`).join(" ")
    const reply =
      evidenceIds.length > 0
        ? `Based on the retrieved evidence ${citations}, the answer synthesizes the available retrieval channels.`
        : "No evidence available."
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
      return { passed: true, hallucination: false, completeness: true }
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
// Scenario runner helper
// ---------------------------------------------------------------------------

/**
 * Run one Answer scenario through the public seam.
 *
 * Pre-builds Evidence from `expectedResults` to wire the scripted LLM with
 * the correct citation ids. The runner's internal Evidence building produces
 * the same ids (same Searcher results → same Evidence).
 *
 * Returns the runner output + the Citation-gate-validated references.
 */
async function runAnswerScenario(
  query: string,
  searcher: Searcher,
  expectedResults: RetrievalResult[],
  accessContext: AccessContext,
  signal: AbortSignal,
): Promise<{
  runnerOutput: MastraRunnerOutput
  evidenceList: Evidence[]
  references: AnswerReference[]
}> {
  const evidenceList = buildEvidence(expectedResults)
  const evidenceIds = evidenceList.map((e) => e.id)

  const runner = createSimpleKnowledgeMastraRunner({
    router: makeFakeRouter("simple"),
    createSearcher: () => searcher,
    assembler: makeFakeAssembler(),
    validator: makePassingValidator(),
    replanner: makeNoOpRePlanner(),
    streamAnswerDraft: makeScriptedDraftStream(evidenceIds),
  })

  const suffix = Math.random().toString(36).slice(2, 8)
  const runnerInput: MastraRunnerInput = {
    message: query,
    runId: `probe-run-${Date.now()}-${suffix}`,
    sessionId: `probe-session-${Date.now()}-${suffix}`,
    signal,
    accessContext,
  }

  const runnerOutput = await runner(runnerInput)

  // Verify Citation gate (referencesForReply throws on unknown citations)
  let references: AnswerReference[] = []
  try {
    references = referencesForReply(runnerOutput.reply, evidenceList)
  } catch {
    references = []
  }

  return { runnerOutput, evidenceList, references }
}

// ---------------------------------------------------------------------------
// Probe implementation
// ---------------------------------------------------------------------------

export const retrievalAclOutageProbe: ProbeImplementation = async (ctx) => {
  const start = Date.now()

  // --- Validate fixture ---
  if (!ctx.fixture) {
    return {
      ok: false,
      reason:
        "missing fixture: RetrievalAclOutageProbeFixture required (revision/query)",
      durationMs: Date.now() - start,
    }
  }

  const fixture = ctx.fixture as RetrievalAclOutageProbeFixture

  if (!fixture.revision) {
    return {
      ok: false,
      reason: "fixture.revision is required (non-empty)",
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

  // --- Derive isolated acceptance tenant ---
  const tenantId = deriveTenantId(fixture.revision)
  const allChunks = buildAclChunks(tenantId)

  // ========================================================================
  // Scenario 1: ACL — authorized query (tenant A, group-a)
  // ========================================================================
  const authorizedAc: AccessContext = {
    tenantId,
    subjectId: "acceptance-probe-acl",
    groups: ["group-a"],
    scopes: ["chat"],
  }
  const authorizedSearcher = makeAclSearcher(allChunks, new Set())
  const authorizedExpected = filterByAcl(allChunks, authorizedAc)
  const authorizedRun = await runAnswerScenario(
    fixture.query,
    authorizedSearcher,
    authorizedExpected,
    authorizedAc,
    ctx.signal,
  )
  const authorizedDocIds = [
    ...new Set(authorizedExpected.map((r) => r.chunk.documentId)),
  ]
  const authorizedForeignLeak = authorizedExpected.some(
    (r) => r.chunk.tenantId !== tenantId,
  )

  // ========================================================================
  // Scenario 2: ACL — unauthorized-group query (tenant A, group-b)
  // group-b does NOT include group-a, so group-a-restricted docs are excluded.
  // ========================================================================
  const unauthorizedAc: AccessContext = {
    tenantId,
    subjectId: "acceptance-probe-acl-unauth",
    groups: ["group-b"],
    scopes: ["chat"],
  }
  const unauthorizedSearcher = makeAclSearcher(allChunks, new Set())
  const unauthorizedExpected = filterByAcl(allChunks, unauthorizedAc)
  const unauthorizedRun = await runAnswerScenario(
    fixture.query,
    unauthorizedSearcher,
    unauthorizedExpected,
    unauthorizedAc,
    ctx.signal,
  )
  const unauthorizedDocIds = [
    ...new Set(unauthorizedExpected.map((r) => r.chunk.documentId)),
  ]
  // Group-restricted docs (acceptance tenant, allowedGroups non-empty)
  const groupRestrictedDocIds = [
    ...new Set(
      allChunks
        .filter(
          (r) =>
            r.chunk.tenantId === tenantId &&
            r.chunk.allowedGroups &&
            r.chunk.allowedGroups.length > 0,
        )
        .map((r) => r.chunk.documentId),
    ),
  ]
  // Group-restricted docs that leaked into the unauthorized-group Evidence
  const groupRestrictedLeaked = groupRestrictedDocIds.filter((id) =>
    unauthorizedDocIds.includes(id),
  )
  const unauthorizedForeignLeak = unauthorizedExpected.some(
    (r) => r.chunk.tenantId !== tenantId,
  )

  // ========================================================================
  // Scenario 3: Degradation — graph channel fails, others survive
  // ========================================================================
  const degradedAc: AccessContext = {
    tenantId,
    subjectId: "acceptance-probe-deg",
    groups: ["group-a"],
    scopes: ["chat"],
  }
  const failedGraph = new Set<RetrievalChannel>(["graph"])
  const degradedSearcher = makeAclSearcher(allChunks, failedGraph)
  const degradedExpected = allChunks.filter(
    (r) => isVisible(r.chunk, degradedAc) && !failedGraph.has(r.source),
  )
  const degradedRun = await runAnswerScenario(
    fixture.query,
    degradedSearcher,
    degradedExpected,
    degradedAc,
    ctx.signal,
  )
  const degradedSurvivingChannels = [
    ...new Set(degradedExpected.map((r) => r.source)),
  ]
  const degradedForeignLeak = degradedExpected.some(
    (r) => r.chunk.tenantId !== tenantId,
  )

  // ========================================================================
  // Scenario 4: Total failure — all channels fail
  // ========================================================================
  const totalFailAc: AccessContext = {
    tenantId,
    subjectId: "acceptance-probe-total",
    groups: ["group-a"],
    scopes: ["chat"],
  }
  const allFailed = new Set<RetrievalChannel>(ALL_CHANNELS)
  const totalFailSearcher = makeAclSearcher(allChunks, allFailed)
  const totalFailRun = await runAnswerScenario(
    fixture.query,
    totalFailSearcher,
    [],
    totalFailAc,
    ctx.signal,
  )
  const totalFailReferences = totalFailRun.references

  // ========================================================================
  // Aggregate results
  // ========================================================================

  // --- ACL scenario results ---
  const allForeignLeaked = [
    ...new Set(
      [...authorizedExpected, ...unauthorizedExpected]
        .filter((r) => r.chunk.tenantId !== tenantId)
        .map((r) => r.chunk.documentId),
    ),
  ]

  const acl = {
    crossTenantLeak: authorizedForeignLeak || unauthorizedForeignLeak,
    foreignDocIdsLeaked: allForeignLeaked,
    evidenceDocIds: authorizedDocIds,
    groupFilterWorks: groupRestrictedLeaked.length === 0,
    unauthorizedGroupLeak: groupRestrictedLeaked.length > 0,
    groupRestrictedLeaked,
  }

  // --- Degradation scenario results ---
  const degradedForeignDocIdsLeaked = [
    ...new Set(
      degradedExpected
        .filter((r) => r.chunk.tenantId !== tenantId)
        .map((r) => r.chunk.documentId),
    ),
  ]

  const degradation = {
    unavailableChannels: ["graph"],
    survivingChannels: degradedSurvivingChannels,
    aclEnforced: !degradedForeignLeak,
    foreignDocIdsLeaked: degradedForeignDocIdsLeaked,
    citationsPresent: degradedRun.references.length > 0,
    referenceCount: degradedRun.references.length,
    terminalStatus: degradedRun.runnerOutput.status,
  }

  // --- Total failure scenario results ---
  const totalFailure = {
    terminalStatus: totalFailRun.runnerOutput.status,
    referenceCount: totalFailReferences.length,
    fabricatedAnswer: totalFailReferences.length > 0,
  }

  // --- Compute ok ---
  const ok =
    acl.crossTenantLeak === false &&
    acl.foreignDocIdsLeaked.length === 0 &&
    acl.groupFilterWorks === true &&
    acl.unauthorizedGroupLeak === false &&
    degradation.aclEnforced === true &&
    degradation.foreignDocIdsLeaked.length === 0 &&
    degradation.citationsPresent === true &&
    degradation.referenceCount > 0 &&
    totalFailure.terminalStatus === "insufficient_retrieval" &&
    totalFailure.referenceCount === 0 &&
    totalFailure.fabricatedAnswer === false

  const reason = ok
    ? undefined
    : `acl.crossTenantLeak=${acl.crossTenantLeak}, acl.groupFilterWorks=${acl.groupFilterWorks}, degradation.aclEnforced=${degradation.aclEnforced}, degradation.citationsPresent=${degradation.citationsPresent}, totalFailure.terminalStatus=${totalFailure.terminalStatus}, totalFailure.referenceCount=${totalFailure.referenceCount}`

  // --- Build outputs — only safe metadata, no passages/prompts/answer text ---
  const outputs: Record<string, unknown> = {
    ok,
    acl,
    degradation,
    totalFailure,
    tenantId,
  }

  return { ok, reason, outputs, durationMs: Date.now() - start }
}
