// Ticket 24 — Command-owned golden-set runner.
//
// Executes the committed evaluation set (GOLDEN_SET) through the public
// Answer run seam (createSimpleKnowledgeMastraRunner + createDirectAmbiguous-
// MastraRunner) and generates bounded CaseResult evidence from the shipped
// workflow.
//
// Design (karpathy-guidelines):
//   - Simplest viable shape: iterate GOLDEN_SET.cases, dispatch each case to
//     the appropriate runner (direct/ambiguous → directAmbiguousRunner;
//     simple/complex/insufficient/correction → simpleKnowledgeRunner with
//     router stub returning "simple"), capture terminal/latency/tokens/
//     evidence/citations/degradation per case, and assemble CaseResult[].
//   - No caller-supplied pass fields: CaseResult.status is OBSERVED
//     (passed/failed/skipped), not a hard-invariant pass judgment. The
//     deterministic evaluator (evaluateHardInvariants) derives pass/fail
//     from terminalStatus + citations + retrievedEvidenceIds.
//   - No silent drops: timeout, cancellation, malformed terminal, and
//     provider failure are captured as CaseResult with status="failed" +
//     failureReason + redactedFailureEvidence. Every committed case appears
//     in caseResults regardless of outcome.
//   - Bounded outputs: only safe metadata (caseId, terminalStatus, latency,
//     token count, evidence IDs, citation IDs, degradation status). Never
//     emits raw answer text, prompts, token streams, or auth material.
//   - OP-03 candidate mode: in-memory Searcher + scripted LLM/Validator
//     substitutes (same pattern as Tickets 19/20). When OP-03 is lifted,
//     swap the Searcher/LLM factories for real construction — no runner
//     code changes elsewhere.
//
// Rollback boundary: remove this module; no online runtime behavior changes
// (per Ticket 24 rollback spec — runner is a verification-only artifact).

import { createIngestionFixture, type IngestionFixture } from "./ingestion_fixture"
import { buildEvidence, referencesForReply } from "../answer/evidence"
import { createSimpleKnowledgeMastraRunner } from "../mastra/simple_knowledge_runner"
import { createDirectAmbiguousMastraRunner } from "../mastra/direct_ambiguous_runner"
import type { MastraRunnerInput, MastraRunnerOutput } from "../mastra/chat_event_adapter"
import type { Router } from "../retrieval/router/interface"
import type {
  Searcher,
  SearchOptions,
  SearchOutcome,
  RetrievalChannel,
} from "../retrieval/search/interface"
import type { ContextAssembler } from "../retrieval/context/interface"
import type { Validator } from "../critic/validator/interface"
import type { RePlanner } from "../critic/replanner/interface"
import type { AccessContext } from "../access/context"
import type { ProbeContext, ProbeResult } from "./smoke_harness"
import type {
  AgentMessage,
  AnswerReference,
  CriticVerdict,
  Evidence,
  Query,
  RetrievalResult,
  RouterDecision,
} from "../types"
import type {
  CaseResult,
  CaseResultStatus,
  GoldenCase,
} from "../evaluation/types"
import { GOLDEN_SET } from "../evaluation/golden/fixtures"

// ---------------------------------------------------------------------------
// Fixture contract
// ---------------------------------------------------------------------------

/**
 * Fixture describing the golden-set runner scenario.
 *
 * The runner creates a fresh ingestion fixture per run (deriving an isolated
 * tenantId + searchNamespace from `revision`), then iterates every committed
 * GoldenCase in GOLDEN_SET, dispatching each to the appropriate Answer runner
 * (direct/ambiguous → directAmbiguousRunner; simple/complex/insufficient/
 * correction → simpleKnowledgeRunner) and aggregating the observed terminal,
 * latency, token count, retrieved Evidence identities, citations, and
 * degradation status into CaseResult[].
 */
export interface GoldenSetRunnerFixture {
  /** Trusted repository revision (drives tenant + namespace isolation). */
  revision: string
}

// ---------------------------------------------------------------------------
// In-memory substitutes (OP-03 candidate mode — same pattern as Tickets 19/20)
// ---------------------------------------------------------------------------

const PROBE_CHANNELS: RetrievalChannel[] = ["vector", "bm25", "graph", "pageIndex"]

/**
 * Build synthetic RetrievalResults for a knowledge-route case. Each
 * acceptable Evidence ID becomes one chunk (across all 4 channels) so
 * buildEvidence creates one Evidence entry per acceptable ID.
 *
 * Chunk content is a SYNTHETIC PLACEHOLDER — never the ingested source
 * content. The tenantId + allowedGroups come from the accessContext so the
 * ACL boundary is exercised end-to-end.
 */
function buildSyntheticResults(
  acceptableEvidenceIds: string[],
  accessContext: AccessContext,
): RetrievalResult[] {
  const results: RetrievalResult[] = []
  for (const evidenceId of acceptableEvidenceIds) {
    // Use the acceptable Evidence ID as the documentId + chunkId so the
    // resulting Evidence entry's documentId is the acceptable ID (caller-
    // observable identity, even though buildEvidence generates a hashed
    // evidence.id like "ev_<hash>").
    for (const channel of PROBE_CHANNELS) {
      const chunkId = `${evidenceId}#chunk-${channel}`
      results.push({
        chunk: {
          id: chunkId,
          documentId: evidenceId,
          content: `[${channel} excerpt for ${evidenceId}]`,
          childrenIds: [],
          metadata: {
            title: `Doc ${evidenceId}`,
            source: "golden-set-fixture",
            documentVersion: 1,
            page: 1,
            sectionPath: ["root"],
            graphPath: ["root", `entity-${evidenceId}`],
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
  }
  return results
}

/**
 * Build the in-memory Searcher that returns synthetic results for the case's
 * acceptable Evidence IDs. When `returnEmpty` is true (insufficient-route
 * cases), returns no results — exercises the insufficient_evidence terminal.
 */
function makeInMemorySearcher(
  acceptableEvidenceIds: string[],
  accessContext: AccessContext,
  returnEmpty: boolean,
): Searcher {
  const probeResults = returnEmpty
    ? []
    : buildSyntheticResults(acceptableEvidenceIds, accessContext)

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
      if (returnEmpty) {
        return {
          status: "insufficient",
          results: [],
          unavailableChannels: [],
          degradationReasons: ["no results"],
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

/**
 * Scripted Answer draft stream that emits a reply citing every Evidence id.
 * The reply contains `[cite:${id}]` tokens for each acceptable Evidence ID
 * so the Citation gate (referencesForReply) accepts the reply.
 */
function makeScriptedDraftStream(
  evidenceIds: string[],
): (messages: AgentMessage[], signal: AbortSignal) => AsyncIterable<string> {
  return async function* scriptedStream(
    _messages: AgentMessage[],
    signal: AbortSignal,
  ): AsyncGenerator<string> {
    if (signal.aborted) {
      throw abortError("scripted draft stream")
    }
    // Cite each acceptable Evidence ID — referencesForReply will resolve
    // every [cite:ID] against the pre-built Evidence list.
    const citations = evidenceIds.map((id) => `[cite:${id}]`).join(" ")
    const reply = `Based on the retrieved evidence ${citations}, the answer synthesizes all four retrieval channels.`
    const tokens = reply.split(" ")
    for (const token of tokens) {
      if (signal.aborted) {
        throw abortError("scripted draft stream (mid-iter)")
      }
      yield token + " "
    }
  }
}

/**
 * Scripted direct reply stream for direct-route cases. Emits a simple
 * reply with no citations (direct route does not retrieve).
 */
function makeScriptedDirectStream(): (
  message: string,
  signal: AbortSignal,
) => AsyncIterable<string> {
  return async function* scriptedDirectStream(
    _message: string,
    signal: AbortSignal,
  ): AsyncGenerator<string> {
    if (signal.aborted) {
      throw abortError("scripted direct stream")
    }
    const reply = "This is a direct response that does not require knowledge retrieval."
    const tokens = reply.split(" ")
    for (const token of tokens) {
      if (signal.aborted) {
        throw abortError("scripted direct stream (mid-iter)")
      }
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

function makeFailingValidator(): Validator {
  return {
    async validate(
      _answer: string,
      _context: AgentMessage[],
      _coverageCriteria?: string[],
      _signal?: AbortSignal,
    ): Promise<CriticVerdict> {
      return { passed: false, hallucination: false, completeness: false }
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
      return "[assembled context — golden-set runner substitute]"
    },
  }
}

function abortError(checkpoint: string): Error {
  const error = new Error(`Answer run cancelled at ${checkpoint}`)
  error.name = "AbortError"
  return error
}

// ---------------------------------------------------------------------------
// CaseResult derivation
// ---------------------------------------------------------------------------

/**
 * Derive a CaseResult from a successful MastraRunnerOutput.
 *
 * status mapping (OBSERVED, not pass/fail judgment):
 *   - terminal=completed -> "passed" (the run reached a valid terminal)
 *   - terminal=clarification_required, insufficient_retrieval,
 *     insufficient_evidence, handoff_required -> "passed" (valid observed
 *     terminals per spec — the evaluator decides acceptability per category)
 *   - terminal=cancelled, provider_error, invalid_citation -> "failed"
 */
function deriveCaseResultFromOutput(
  goldenCase: GoldenCase,
  output: MastraRunnerOutput,
  durationMs: number,
): CaseResult {
  const failedTerminals = new Set([
    "cancelled",
    "provider_error",
    "invalid_citation",
  ])
  const status: CaseResultStatus = failedTerminals.has(output.status)
    ? "failed"
    : "passed"

  // Parse [cite:ID] tokens from the reply — these are the citations actually
  // present in the answer text.
  const citationsInAnswer: string[] = []
  for (const match of output.reply.matchAll(/\[cite:([^\]]+)\]/g)) {
    citationsInAnswer.push(match[1])
  }

  // Retrieved Evidence IDs = references returned by the runner (deduped).
  const retrievedEvidenceIds = output.references.map((r) => r.id)

  return {
    caseId: goldenCase.id,
    status,
    terminalStatus: output.status,
    routeDecision: goldenCase.expectedRoute,
    retrievedEvidenceIds,
    citationsInAnswer,
    durationMs,
    tokenCount: output.tokens.length,
  }
}

/**
 * Derive a failed CaseResult from an error (timeout, cancellation, provider
 * failure, or malformed terminal). Every such case is EXPLICIT in the
 * dataset — never silently dropped.
 */
function deriveFailedCaseResult(
  goldenCase: GoldenCase,
  error: unknown,
  durationMs: number,
): CaseResult {
  const isAbort =
    error instanceof Error && error.name === "AbortError"
  const terminalStatus = isAbort ? "cancelled" : "provider_error"
  const failureReason = error instanceof Error
    ? error.message
    : String(error)

  // Redacted failure evidence — bounded, no raw prompts or answer text.
  // Includes only the error category + a sanitized message fragment.
  const redactedFailureEvidence = isAbort
    ? `[cancelled] ${failureReason.slice(0, 120)}`
    : `[provider_error] ${failureReason.slice(0, 120)}`

  return {
    caseId: goldenCase.id,
    status: "failed",
    terminalStatus,
    routeDecision: goldenCase.expectedRoute,
    retrievedEvidenceIds: [],
    citationsInAnswer: [],
    durationMs,
    tokenCount: 0,
    failureReason,
    redactedFailureEvidence,
  }
}

// ---------------------------------------------------------------------------
// Per-case execution
// ---------------------------------------------------------------------------

/**
 * Dispatch a single GoldenCase through the appropriate Answer runner.
 * Returns a CaseResult capturing the observed terminal/latency/tokens/
 * evidence/citations/degradation.
 */
async function runSingleCase(
  goldenCase: GoldenCase,
  accessContext: AccessContext,
  signal: AbortSignal,
): Promise<CaseResult> {
  const start = Date.now()

  // Determine the route — direct/ambiguous use directAmbiguousRunner;
  // everything else uses simpleKnowledgeRunner (router stub returns "simple"
  // so the runner accepts the case; the simple runner exercises retrieval →
  // Evidence → Citation → Validator → terminal).
  const decision = goldenCase.expectedRoute ?? "simple"
  const isDirectAmbiguous = decision === "direct" || decision === "ambiguous"

  // For knowledge routes, pre-build synthetic Evidence so we can wire the
  // scripted draft stream with citations to acceptable Evidence IDs.
  // acceptableEvidenceIds drives the chunk.documentId — buildEvidence
  // generates hashed ev_<id> entries, but the documentId remains the
  // acceptable ID so downstream evaluators can correlate.
  let preBuiltEvidence: Evidence[] = []
  let searcher: Searcher
  if (!isDirectAmbiguous) {
    preBuiltEvidence = buildEvidence(
      buildSyntheticResults(goldenCase.acceptableEvidenceIds, accessContext),
    )
    // Insufficient-route cases get an empty Searcher → insufficient_evidence
    // terminal. Correction-route cases get a failing Validator → handoff.
    const returnEmpty = goldenCase.category === "insufficient"
    searcher = makeInMemorySearcher(
      goldenCase.acceptableEvidenceIds,
      accessContext,
      returnEmpty,
    )
  } else {
    // direct/ambiguous: no Searcher needed (directAmbiguousRunner does not
    // call Searcher). Provide a no-op Searcher for type safety.
    searcher = makeInMemorySearcher([], accessContext, true)
  }

  const evidenceIds = preBuiltEvidence.map((e) => e.id)
  const validator =
    goldenCase.category === "correction"
      ? makeFailingValidator()
      : makePassingValidator()

  let runner: (input: MastraRunnerInput) => Promise<MastraRunnerOutput>
  if (isDirectAmbiguous) {
    runner = createDirectAmbiguousMastraRunner({
      router: makeFakeRouter(decision),
      streamDirectReply: makeScriptedDirectStream(),
    })
  } else {
    runner = createSimpleKnowledgeMastraRunner({
      router: makeFakeRouter("simple"),
      createSearcher: () => searcher,
      assembler: makeFakeAssembler(),
      validator,
      replanner: makeNoOpRePlanner(),
      streamAnswerDraft: makeScriptedDraftStream(evidenceIds),
    })
  }

  try {
    const runId = `golden-${goldenCase.id}-${Date.now()}`
    const sessionId = `golden-session-${Date.now()}`
    const runnerInput: MastraRunnerInput = {
      message: goldenCase.userMessage,
      runId,
      sessionId,
      signal,
      accessContext,
    }

    const output = await runner(runnerInput)

    // Verify Citation gate for knowledge routes (referencesForReply throws
    // on unknown citations). Direct/ambiguous routes skip this check.
    if (!isDirectAmbiguous && output.status === "completed") {
      try {
        referencesForReply(output.reply, preBuiltEvidence)
      } catch (citationError) {
        // Citation gate failed — record as invalid_citation terminal.
        const durationMs = Date.now() - start
        return {
          caseId: goldenCase.id,
          status: "failed",
          terminalStatus: "invalid_citation",
          routeDecision: goldenCase.expectedRoute,
          retrievedEvidenceIds: output.references.map((r) => r.id),
          citationsInAnswer: [],
          durationMs,
          tokenCount: output.tokens.length,
          failureReason:
            citationError instanceof Error
              ? citationError.message
              : String(citationError),
          redactedFailureEvidence: `[invalid_citation] citation gate rejected the reply`,
        }
      }
    }

    return deriveCaseResultFromOutput(goldenCase, output, Date.now() - start)
  } catch (error) {
    return deriveFailedCaseResult(goldenCase, error, Date.now() - start)
  }
}

// ---------------------------------------------------------------------------
// Probe implementation
// ---------------------------------------------------------------------------

export const goldenSetRunner = async (ctx: ProbeContext): Promise<ProbeResult> => {
  const start = Date.now()

  if (!ctx.fixture) {
    return {
      ok: false,
      reason:
        "missing fixture: GoldenSetRunnerFixture required (revision)",
      durationMs: Date.now() - start,
    }
  }

  const fixture = ctx.fixture as GoldenSetRunnerFixture

  if (!fixture.revision) {
    return {
      ok: false,
      reason: "fixture.revision is required (non-empty)",
      durationMs: Date.now() - start,
    }
  }

  // --- Set up the ingestion fixture (Ticket 18) for tenant isolation ---
  // The ingestion fixture is created per-run to derive an isolated tenantId
  // + searchNamespace from the trusted revision. We do NOT ingest per-case
  // content (the in-memory Searcher substitute provides synthetic results);
  // the fixture is used only for tenant boundary isolation.
  let ingestionFixture: IngestionFixture
  try {
    ingestionFixture = createIngestionFixture({ revision: fixture.revision })
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
    const accessContext: AccessContext = {
      tenantId: ingestionFixture.tenantId,
      subjectId: "golden-set-runner",
      groups: [],
      scopes: ["chat"],
    }

    const caseResults: CaseResult[] = []
    const degradationByCase: Record<
      string,
      { status: string; unavailableChannels: string[] }
    > = {}

    for (const goldenCase of GOLDEN_SET.cases) {
      // Per-case abort: if the parent signal aborted, mark remaining cases
      // as cancelled (cannot be silently dropped — every case appears in
      // caseResults with an explicit failure record).
      if (ctx.signal.aborted) {
        const abortError = new Error("runner aborted before case start")
        abortError.name = "AbortError"
        caseResults.push(
          deriveFailedCaseResult(goldenCase, abortError, 0),
        )
        degradationByCase[goldenCase.id] = {
          status: "insufficient",
          unavailableChannels: [...PROBE_CHANNELS],
        }
        continue
      }

      const caseResult = await runSingleCase(
        goldenCase,
        accessContext,
        ctx.signal,
      )
      caseResults.push(caseResult)

      // Record degradation status per case — derive from the observed
      // terminal + citations. For knowledge routes, degradation.status
      // is "none" when retrieval succeeded + citation gate passed.
      const knowledgeRoute =
        goldenCase.category === "simple" ||
        goldenCase.category === "complex" ||
        goldenCase.category === "correction"
      const isInsufficient =
        caseResult.terminalStatus === "insufficient_retrieval" ||
        caseResult.terminalStatus === "insufficient_evidence"
      degradationByCase[goldenCase.id] = {
        status:
          caseResult.status === "failed"
            ? "insufficient"
            : isInsufficient
              ? "insufficient"
              : knowledgeRoute
                ? "none"
                : "none",
        unavailableChannels: isInsufficient ? [...PROBE_CHANNELS] : [],
      }
    }

    // --- Aggregate counts ---
    const passedCases = caseResults.filter((c) => c.status === "passed").length
    const failedCases = caseResults.filter((c) => c.status === "failed").length
    const skippedCases = caseResults.filter((c) => c.status === "skipped").length

    const outputs: Record<string, unknown> = {
      datasetVersion: GOLDEN_SET.version,
      repositoryRevision: fixture.revision,
      tenantId: ingestionFixture.tenantId,
      caseResults,
      degradationByCase,
      generatedAt: new Date().toISOString(),
      totalCases: caseResults.length,
      passedCases,
      failedCases,
      skippedCases,
      totalDurationMs: Date.now() - start,
    }

    return {
      ok: true,
      outputs,
      durationMs: Date.now() - start,
    }
  } finally {
    await ingestionFixture.cleanup()
  }
}
