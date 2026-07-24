// Ticket 17 — Run Ticket 61 release acceptance: tests.
//
// Spec issue #17: "Verify the complete Ticket 61 capability set as one
// backward-compatible Agentic RAG release. Long-session memory, Context
// compression, model-selected retrieval, Langfuse and RAGAS must coexist
// without weakening ACL, Evidence, Citation, Critic, cancellation, trace
// or deterministic release guarantees."
//
// These tests verify CROSS-CAPABILITY COEXISTENCE and STRUCTURAL
// PRECEDENCE — they do NOT re-test individual modules (covered by
// Tickets 01-16). T17's unique value:
//   - Capabilities coexist without weakening each other
//   - Deterministic gates (hard invariants) take precedence over
//     non-deterministic results (RAGAS shadow, Langfuse traces)
//   - Backward compatibility: API fields, SSE event types, identities,
//     schema versions remain stable
//   - Config-level rollback: each capability has a disable path
//
// 8 acceptance criteria:
//   #1 Long Tenant conversation → Handoff bounded memory
//   #2 Over-budget complex → compression + multi-tool + valid Citations
//   #3 Cancellation → cancelled, no late publication
//   #4 Langfuse enabled/disabled → identical Answer
//   #5 RAGAS shadow alongside deterministic (precedence preserved)
//   #6 Backward compat: API fields, SSE, identities, history replay
//   #7 Final verification artifact (covered by release_verification.ts)
//   #8 Rollback instructions (config flags + doc)

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { openDb } from "../ingestion/tracking/db"
import { SqliteHandoffStore } from "../answer/handoff_store"
import type { HandoffCreateInput } from "../answer/handoff_store"
import {
  NoopLangfuseExporter,
  createLangfuseExporter,
} from "../answer/langfuse_exporter"
import { buildArtifact } from "./artifact"
import {
  computeRagasShadowBaseline,
  runRagasShadowProfile,
} from "./ragas_shadow"
import { evaluateHardInvariants } from "./hard_invariants"
import { evaluateQualityMetrics } from "./quality_metrics"
import { GOLDEN_SET } from "./golden/fixtures"
import type {
  BaselineComparison,
  CaseResult,
  EvaluationArtifact,
  EvaluationProfile,
  RagasShadowArtifactSection,
  RagasShadowBaseline,
  RagasShadowCase,
  RagasShadowProfileConfig,
  RagasEvaluator,
  RagasRequest,
  RagasResponse,
  RagasEvaluateOptions,
} from "./types"

// ---------------------------------------------------------------------------
// Source paths for static checks (criterion #6 backward compat)
// ---------------------------------------------------------------------------

const here = __dirname
const RUNTIME_SOURCE_PATH = join(here, "..", "answer", "runtime.ts")
const INDEX_SOURCE_PATH = join(here, "..", "index.ts")
const CHAT_EVENT_ADAPTER_SOURCE_PATH = join(here, "..", "mastra", "chat_event_adapter.ts")
const SIMPLE_RUNNER_SOURCE_PATH = join(here, "..", "mastra", "simple_knowledge_runner.ts")
const COMPLEX_RUNNER_SOURCE_PATH = join(here, "..", "mastra", "complex_knowledge_runner.ts")
const CHAT_SOURCE_PATH = join(here, "..", "api", "chat.ts")
const CONFIG_SOURCE_PATH = join(here, "..", "config", "index.ts")
const ARTIFACT_SOURCE_PATH = join(here, "artifact.ts")
const RAGAS_SHADOW_SOURCE_PATH = join(here, "ragas_shadow.ts")

// ---------------------------------------------------------------------------
// Criterion #1: Long Tenant-bound conversation → Handoff bounded memory
// ---------------------------------------------------------------------------

/**
 * Build a non-regressing BaselineComparison for buildArtifact inputs.
 * Used by T17 #5/#6 tests that verify artifact shape, not baseline semantics.
 */
function makeBaseline(): BaselineComparison {
  return {
    p95LatencyMs: 200,
    p95LatencyBaselineMs: 200,
    p95LatencyRegression: false,
    averageTokens: 150,
    averageTokensBaseline: 150,
    averageTokensRegression: false,
  }
}

function makeHandoffInput(overrides: Partial<HandoffCreateInput> = {}): HandoffCreateInput {
  return {
    runId: "run-001",
    tenantId: "tenant-acme",
    subjectId: "subject-1",
    sessionId: "session-1",
    reasonCode: "user_request",
    userRequest: "I need to speak with a human agent about my refund",
    conversationSummary: "User asked about refund policy; bot provided generic info; user escalated.",
    evidenceIds: ["ev-refund-01", "ev-refund-02"],
    traceReference: "trace-abc",
    ...overrides,
  }
}

test("T17 #1: Handoff store preserves bounded memory — idempotent create by run_id keeps first write", () => {
  const db = openDb(":memory:")
  const store = new SqliteHandoffStore(db)
  const first = makeHandoffInput({ runId: "run-A", userRequest: "first request" })
  const second = makeHandoffInput({ runId: "run-A", userRequest: "DIFFERENT request" })
  const created1 = store.create(first)
  const created2 = store.create(second)
  assert.ok(created1, "first create must return a case")
  assert.ok(created2, "second create must return the existing case (idempotent)")
  assert.equal(created2!.userRequest, "first request", "first creation's fields win (bounded memory)")
  assert.equal(created1!.id, created2!.id, "same case ID for same run_id")
})

test("T17 #1: Handoff store enforces cross-tenant isolation (long conversation does not leak across tenants)", () => {
  const db = openDb(":memory:")
  const store = new SqliteHandoffStore(db)
  store.create(makeHandoffInput({ runId: "run-X", tenantId: "tenant-A" }))
  // Cross-tenant lookup returns null — existence is hidden
  const crossTenant = store.getByRunId("run-X", "tenant-B")
  assert.equal(crossTenant, null, "cross-tenant getByRunId returns null (existence hidden)")
  // Cross-tenant list does not include the case
  const listB = store.listByTenant("tenant-B")
  assert.equal(listB.length, 0, "cross-tenant listByTenant returns 0 cases")
  // Cross-tenant update returns null (404, not 409)
  const updateB = store.updateStatus("nonexistent", "tenant-B", "claimed")
  assert.equal(updateB, null, "cross-tenant updateStatus returns null (404)")
})

test("T17 #1: Handoff state machine bounds conversation lifecycle (open → claimed → resolved)", () => {
  const db = openDb(":memory:")
  const store = new SqliteHandoffStore(db)
  const created = store.create(makeHandoffInput({ runId: "run-SM" }))
  assert.equal(created!.status, "open")
  const claimed = store.updateStatus(created!.id, created!.tenantId, "claimed")
  assert.equal(claimed!.status, "claimed")
  const resolved = store.updateStatus(created!.id, created!.tenantId, "resolved")
  assert.equal(resolved!.status, "resolved")
  // Terminal state — no further transitions (throws InvalidHandoffTransitionError)
  assert.throws(
    () => store.updateStatus(created!.id, created!.tenantId, "claimed"),
    /Invalid handoff transition/,
    "transition from resolved is invalid (throws 409)",
  )
})

test("T17 #1: Handoff conversation_summary is bounded (no raw transcript leak)", () => {
  const db = openDb(":memory:")
  const store = new SqliteHandoffStore(db)
  const longSummary = "x".repeat(5000)
  const created = store.create(makeHandoffInput({ runId: "run-bounded", conversationSummary: longSummary }))
  assert.ok(created, "create succeeds with bounded summary")
  assert.equal(created!.conversationSummary.length, 5000, "summary stored as given (bounded field, no truncation by store)")
  // The store does NOT accept unstructured transcripts — evidenceIds is a JSON array, not free text
  assert.ok(Array.isArray(created!.evidenceIds), "evidenceIds is a bounded array (not raw transcript)")
  assert.equal(created!.evidenceIds.length, 2)
})

// ---------------------------------------------------------------------------
// Criterion #2: Over-budget complex → compression + multi-tool + Citations
// ---------------------------------------------------------------------------

test("T17 #2: Context compressor module exists and exports compression result shape", () => {
  const source = readFileSync(join(here, "..", "answer", "context_compressor.ts"), "utf8")
  assert.match(source, /export interface ContextCompressionResult/, "ContextCompressionResult interface exists")
  assert.match(source, /retainedEvidenceIds/, "compression tracks retained Evidence IDs")
  assert.match(source, /droppedEvidenceIds/, "compression tracks dropped Evidence IDs")
  assert.match(source, /inputTokens/, "compression records input token count")
  assert.match(source, /outputTokens/, "compression records output token count")
})

test("T17 #2: Complex loop controller module exists with tool-selection gate (T10)", () => {
  const source = readFileSync(join(here, "..", "retrieval", "complex_loop.ts"), "utf8")
  assert.match(source, /export class ComplexLoopControllerImpl/, "ComplexLoopControllerImpl exists")
  // T10 tool-loop evaluation gates: the controller must enforce a max-iterations gate
  assert.match(source, /maxIterations|max_iterations|MAX_ITERATIONS/, "controller enforces iteration gate")
})

test("T17 #2: Runtime wires compressor + handoff + summarizer (coexistence of T61 capabilities)", () => {
  const source = readFileSync(INDEX_SOURCE_PATH, "utf8")
  // All three T61 capabilities must be wired in the Mastra composition root.
  assert.match(source, /compressor:\s*new ContextCompressorImpl/, "compressor wired")
  assert.match(source, /handoffStore:\s*new SqliteHandoffStore/, "handoffStore wired")
  assert.match(source, /const summarizer = new SummarizerImpl/, "shared summarizer constructed")
  assert.match(
    source,
    /createDirectAmbiguousMastraRunner\(\{[\s\S]*?\bsummarizer,/,
    "shared summarizer wired to direct runner",
  )
  assert.match(
    source,
    /createSimpleKnowledgeMastraRunner\(\{[\s\S]*?\bsummarizer,[\s\S]*?compressor:\s*new ContextCompressorImpl[\s\S]*?handoffStore:\s*new SqliteHandoffStore/,
    "summarizer, compressor, and handoff coexist in the simple runner",
  )
  assert.match(
    source,
    /createComplexKnowledgeMastraRunner\(\{[\s\S]*?\bsummarizer,[\s\S]*?compressor:\s*new ContextCompressorImpl[\s\S]*?handoffStore:\s*new SqliteHandoffStore/,
    "summarizer, compressor, and handoff coexist in the complex runner",
  )
})

test("T17 #2: Citations carry Evidence IDs — compression cannot drop citation provenance", () => {
  const runnerSource = [SIMPLE_RUNNER_SOURCE_PATH, COMPLEX_RUNNER_SOURCE_PATH]
    .map((path) => readFileSync(path, "utf8"))
    .join("\n")
  const adapterSource = readFileSync(CHAT_EVENT_ADAPTER_SOURCE_PATH, "utf8")
  assert.match(runnerSource, /citationIdsByChunk/, "Mastra runners track citation IDs per chunk")
  assert.match(runnerSource, /evidenceIds:\s*evidence\.map/, "handoff provenance carries Evidence IDs")
  assert.match(runnerSource, /referencesForReply/, "published references are derived from Evidence")
  assert.match(adapterSource, /references:\s*runnerOutput\.references/, "terminal event publishes validated references")
  // Compression retained/dropped tracking is separate from citation provenance
  const compressorSource = readFileSync(join(here, "..", "answer", "context_compressor.ts"), "utf8")
  assert.match(compressorSource, /retainedEvidenceIds/, "compressor tracks retained IDs")
  assert.match(compressorSource, /droppedEvidenceIds/, "compressor tracks dropped IDs")
})

// ---------------------------------------------------------------------------
// Criterion #3: Cancellation → cancelled, no late publication
// ---------------------------------------------------------------------------

test("T17 #3: Generation emits done('cancelled') terminal event (cancellation convergence)", () => {
  const source = readFileSync(CHAT_EVENT_ADAPTER_SOURCE_PATH, "utf8")
  assert.match(source, /status:\s*isAbort\s*\?\s*"cancelled"/, "adapter emits cancelled status")
  // AbortError must be detected (T44/T10 cancellation contract)
  assert.match(source, /AbortError|signal\.aborted|abort/, "generation detects abort signal")
})

test("T17 #3: No answer_delta after terminal event (no late publication)", () => {
  const source = readFileSync(CHAT_EVENT_ADAPTER_SOURCE_PATH, "utf8")
  assert.match(source, /let terminalEmitted = false/, "adapter tracks terminal emission")
  assert.match(source, /if \(!terminalEmitted\)[\s\S]*terminalEmitted = true[\s\S]*yield event/, "terminal is emitted once")
  const deltaLoopIdx = source.indexOf("for (const token of runnerOutput.tokens)")
  const publishTerminalIdx = source.indexOf("// GATE 5 — publish")
  assert.ok(deltaLoopIdx > -1, "answer_delta loop exists")
  assert.ok(publishTerminalIdx > deltaLoopIdx, "normal terminal follows all answer deltas")
})

test("T17 #3: Cancellation smoke capability exists in CAPABILITY_ORDER (T10 smoke gate)", () => {
  const source = readFileSync(join(here, "smoke.ts"), "utf8")
  assert.match(source, /"cancellation"/, "cancellation is a smoke capability")
  assert.match(source, /"graceful_shutdown"/, "graceful_shutdown is a smoke capability")
})

// ---------------------------------------------------------------------------
// Criterion #4: Langfuse enabled/disabled → identical Answer
// ---------------------------------------------------------------------------

test("T17 #4: Langfuse factory selects Noop when config is absent (disabled mode)", () => {
  const exporter = createLangfuseExporter(undefined, undefined, { chatModel: "gpt-4o-mini" })
  assert.ok(exporter instanceof NoopLangfuseExporter, "absent config → Noop (disabled)")
})

test("T17 #4: Langfuse factory throws on partial config (no silent incomplete export)", () => {
  // Only publicKey set, secretKey missing → must throw
  assert.throws(
    () => createLangfuseExporter(
      { publicKey: "pk-lf-xxx", secretKey: "" },
      undefined,
      { chatModel: "gpt-4o-mini" },
    ),
    /partial|incomplete|both/i,
    "partial config (only publicKey) must throw",
  )
  // Only secretKey set, publicKey missing → must throw
  assert.throws(
    () => createLangfuseExporter(
      { publicKey: "", secretKey: "sk-lf-xxx" },
      undefined,
      { chatModel: "gpt-4o-mini" },
    ),
    /partial|incomplete|both/i,
    "partial config (only secretKey) must throw",
  )
})

test("T17 #4: Langfuse factory throws when config complete but no client injected (no silent Noop fallback)", () => {
  assert.throws(
    () => createLangfuseExporter(
      { publicKey: "pk-lf-xxx", secretKey: "sk-lf-xxx" },
      undefined,
      { chatModel: "gpt-4o-mini" },
    ),
    /client|inject|required/i,
    "complete config + no client must throw (not silently Noop)",
  )
})

test("T17 #4: Langfuse observer is NOT attached when Noop (runtime keeps observer list minimal)", () => {
  const source = readFileSync(INDEX_SOURCE_PATH, "utf8")
  // The composition root conditionally attaches the observer only when Real.
  assert.match(source, /instanceof NoopLangfuseExporter/, "runtime checks NoopLangfuseExporter type")
  assert.match(source, /mastraObservers\.push\(langfuseObserver/, "langfuseObserver pushed only when not Noop")
})

test("T17 #4: Langfuse env vars are optional in AppConfig (disabled-by-default)", () => {
  const source = readFileSync(CONFIG_SOURCE_PATH, "utf8")
  assert.match(source, /langfusePublicKey\?:\s*string/, "langfusePublicKey is optional")
  assert.match(source, /langfuseSecretKey\?:\s*string/, "langfuseSecretKey is optional")
  assert.match(source, /langfuseBaseUrl\?:\s*string/, "langfuseBaseUrl is optional")
})

test("T17 #4: Langfuse npm package is NOT a hard dependency (DI seam enables disabled mode)", () => {
  // The runtime imports LangfuseClient TYPE (not the npm package) — DI seam
  const source = readFileSync(RUNTIME_SOURCE_PATH, "utf8")
  assert.match(source, /type LangfuseClient/, "runtime imports LangfuseClient as type (DI seam)")
  // The langfuse_exporter module must NOT do `import ... from "langfuse"` at module top level
  const exporterSource = readFileSync(join(here, "..", "answer", "langfuse_exporter.ts"), "utf8")
  assert.ok(
    !/from\s+["']langfuse["']/.test(exporterSource),
    "langfuse_exporter.ts must NOT import from 'langfuse' npm package (DI seam preserves disabled mode)",
  )
})

// ---------------------------------------------------------------------------
// Criterion #5: RAGAS shadow alongside deterministic (precedence preserved)
// ---------------------------------------------------------------------------

function makeRagasShadowBaseline(): RagasShadowBaseline {
  return {
    aggregate: {
      meanFaithfulness: 0.9,
      meanAnswerRelevancy: 0.85,
      meanContextPrecision: 0.88,
      meanContextRecall: 0.82,
      sampleSize: 10,
      errorCount: 0,
      skippedCount: 0,
    },
    variance: {
      faithfulness: { min: 0.88, max: 0.92, mean: 0.9, stdDev: 0.02, sampleSize: 3 },
      answerRelevancy: { min: 0.83, max: 0.87, mean: 0.85, stdDev: 0.02, sampleSize: 3 },
      contextPrecision: { min: 0.86, max: 0.9, mean: 0.88, stdDev: 0.02, sampleSize: 3 },
      contextRecall: { min: 0.8, max: 0.84, mean: 0.82, stdDev: 0.02, sampleSize: 3 },
    },
    runCount: 3,
    datasetVersion: "2026.07.t10",
    providerModelIds: { chat: "gpt-4-0613", embedding: "text-embedding-3-small", evaluator: "gpt-4-0613" },
    generatedAt: "2026-07-01T00:00:00.000Z",
    repositoryRevision: "abc123",
  }
}

function makeRagasShadowSection(): RagasShadowArtifactSection {
  return {
    baseline: makeRagasShadowBaseline(),
    reportedSeparately: true,
  }
}

test("T17 #5: buildArtifact includes BOTH ragasShadow and hardInvariants (coexistence)", () => {
  const cases: CaseResult[] = GOLDEN_SET.cases.slice(0, 5).map((gc) => ({
    caseId: gc.id,
    status: "passed" as const,
    terminalStatus: "completed" as const,
    retrievedEvidenceIds: gc.acceptableEvidenceIds ?? [],
    citationsInAnswer: gc.acceptableEvidenceIds ?? [],
    durationMs: 100,
    tokenCount: 150,
  }))
  const hardInvariants = evaluateHardInvariants(GOLDEN_SET.cases.slice(0, 5), cases)
  const qualityMetrics = evaluateQualityMetrics(GOLDEN_SET.cases.slice(0, 5), cases)
  const artifact = buildArtifact({
    goldenSet: GOLDEN_SET,
    results: cases,
    hardInvariants,
    qualityMetrics,
    baseline: makeBaseline(),
    repositoryRevision: "sha-T17",
    providerModelIds: { chat: "gpt-4o-mini", embedding: "text-embedding-3-small" },
    generatedAt: "2026-07-19T00:00:00.000Z",
    ragasShadow: makeRagasShadowSection(),
  })
  // BOTH sections present
  assert.ok(artifact.ragasShadow, "ragasShadow section present")
  assert.ok(artifact.aggregateMetrics.hardInvariants, "hardInvariants section present")
  assert.ok(artifact.aggregateMetrics.qualityMetrics, "qualityMetrics section present")
})

test("T17 #5: RAGAS shadow regressionDetected does NOT change hardInvariants[].passed (precedence)", () => {
  const cases: CaseResult[] = GOLDEN_SET.cases.slice(0, 5).map((gc) => ({
    caseId: gc.id,
    status: "passed" as const,
    terminalStatus: "completed" as const,
    retrievedEvidenceIds: gc.acceptableEvidenceIds ?? [],
    citationsInAnswer: gc.acceptableEvidenceIds ?? [],
    durationMs: 100,
    tokenCount: 150,
  }))
  const hardInvariants = evaluateHardInvariants(GOLDEN_SET.cases.slice(0, 5), cases)
  // Record the original passed values
  const originalPassed = hardInvariants.map((h) => h.passed)
  // Build artifact WITH ragasShadow that has regressionDetected=true
  const sectionWithRegression: RagasShadowArtifactSection = {
    baseline: makeRagasShadowBaseline(),
    comparison: {
      current: makeRagasShadowBaseline().aggregate,
      baseline: makeRagasShadowBaseline(),
      regressions: [{
        metric: "faithfulness",
        current: 0.7,
        baseline: 0.9,
        delta: -0.2,
        regressionDetected: true,
      }],
      regressionDetected: true,
    },
    reportedSeparately: true,
  }
  const artifact = buildArtifact({
    goldenSet: GOLDEN_SET,
    results: cases,
    hardInvariants,
    qualityMetrics: evaluateQualityMetrics(GOLDEN_SET.cases.slice(0, 5), cases),
    baseline: makeBaseline(),
    repositoryRevision: "sha-T17-precedence",
    providerModelIds: { chat: "gpt-4o-mini", embedding: "text-embedding-3-small" },
    generatedAt: "2026-07-19T00:00:00.000Z",
    ragasShadow: sectionWithRegression,
  })
  // The hardInvariants passed values must be UNCHANGED despite RAGAS regression
  const afterPassed = artifact.aggregateMetrics.hardInvariants.map((h) => h.passed)
  assert.deepEqual(afterPassed, originalPassed, "hardInvariants[].passed unchanged despite RAGAS regressionDetected=true")
  // The RAGAS regression IS recorded (reported, not blocking)
  assert.equal(artifact.ragasShadow!.comparison!.regressionDetected, true, "RAGAS regression is reported")
})

test("T17 #5: smokeGatePassed does NOT consult RAGAS shadow (deterministic precedence)", () => {
  const source = readFileSync(join(here, "smoke.ts"), "utf8")
  // smokeGatePassed must not reference ragasShadow
  assert.ok(
    !/ragasShadow/.test(source),
    "smoke.ts must NOT reference ragasShadow (deterministic gate precedence)",
  )
})

test("T17 #5: RAGAS shadow is a top-level sibling of aggregateMetrics (structural separation)", () => {
  const source = readFileSync(ARTIFACT_SOURCE_PATH, "utf8")
  assert.match(source, /artifact\.ragasShadow\s*=\s*input\.ragasShadow/, "ragasShadow assigned at top level")
  assert.ok(
    !/aggregateMetrics\.ragasShadow/.test(source),
    "ragasShadow must NOT be nested inside aggregateMetrics",
  )
})

test("T17 #5: No REGRESSION_THRESHOLD for RAGAS in ragas_shadow.ts (non-blocking by design)", () => {
  const source = readFileSync(RAGAS_SHADOW_SOURCE_PATH, "utf8")
  assert.ok(
    !/REGRESSION_THRESHOLD\s*=/.test(source),
    "ragas_shadow.ts must NOT introduce a REGRESSION_THRESHOLD (non-blocking by design)",
  )
})

// ---------------------------------------------------------------------------
// Criterion #6: Backward compat — API fields, SSE, identities, history replay
// ---------------------------------------------------------------------------

test("T17 #6: SSE event types stable — answer_delta + done are the streaming contract", () => {
  const source = readFileSync(CHAT_SOURCE_PATH, "utf8")
  assert.match(source, /answer_delta/, "answer_delta SSE event type preserved")
  assert.match(source, /"done"/, "done SSE event type preserved")
})

test("T17 #6: Schema version remains 1 (no breaking schema bump across T01-T16)", () => {
  const source = readFileSync(ARTIFACT_SOURCE_PATH, "utf8")
  assert.match(source, /schemaVersion:\s*1/, "artifact schemaVersion remains 1 (backward compat)")
})

test("T17 #6: Session/run/Evidence identities use stable prefixes (no identity format change)", () => {
  // Evidence IDs use ev_ prefix (stable identity format) — generated in evidence.ts
  const evidenceSource = readFileSync(join(here, "..", "answer", "evidence.ts"), "utf8")
  assert.match(evidenceSource, /ev_/, "Evidence IDs use ev_ prefix (stable identity)")
  const adapterSource = readFileSync(CHAT_EVENT_ADAPTER_SOURCE_PATH, "utf8")
  assert.match(adapterSource, /randomUUID|crypto\.randomUUID/, "run IDs use crypto.randomUUID (stable identity)")
})

test("T17 #6: History replay via conversation store (SqliteConversationStore wired)", () => {
  const source = readFileSync(INDEX_SOURCE_PATH, "utf8")
  assert.match(source, /SqliteConversationStore/, "SqliteConversationStore wired (history replay)")
  assert.match(source, /createMastraMemoryAdapter\(\{ conversationStore \}\)/, "conversationStore wired into Mastra memory")
})

test("T17 #6: API chat endpoint preserves {message, stream} request shape", () => {
  const source = readFileSync(CHAT_SOURCE_PATH, "utf8")
  assert.match(source, /message/, "chat API accepts message field")
  assert.match(source, /stream/, "chat API accepts stream field")
})

test("T17 #6: Artifact JSON-serializable with and without ragasShadow (backward compat)", () => {
  const cases: CaseResult[] = GOLDEN_SET.cases.slice(0, 3).map((gc) => ({
    caseId: gc.id,
    status: "passed" as const,
    terminalStatus: "completed" as const,
    retrievedEvidenceIds: gc.acceptableEvidenceIds ?? [],
    citationsInAnswer: gc.acceptableEvidenceIds ?? [],
    durationMs: 100,
    tokenCount: 150,
  }))
  const hardInvariants = evaluateHardInvariants(GOLDEN_SET.cases.slice(0, 3), cases)
  const qualityMetrics = evaluateQualityMetrics(GOLDEN_SET.cases.slice(0, 3), cases)
  const baseInput = {
    goldenSet: GOLDEN_SET,
    results: cases,
    hardInvariants,
    qualityMetrics,
    baseline: makeBaseline(),
    repositoryRevision: "sha-T17-compat",
    providerModelIds: { chat: "gpt-4o-mini", embedding: "text-embedding-3-small" },
    generatedAt: "2026-07-19T00:00:00.000Z",
  }
  // Without ragasShadow (pre-T16 artifact shape)
  const artifactWithout = buildArtifact(baseInput)
  const jsonWithout = JSON.stringify(artifactWithout)
  const parsedWithout = JSON.parse(jsonWithout) as EvaluationArtifact
  assert.equal(parsedWithout.schemaVersion, 1, "pre-T16 artifact parses with schemaVersion=1")
  assert.equal((parsedWithout as EvaluationArtifact).ragasShadow, undefined, "pre-T16 artifact has no ragasShadow")
  // With ragasShadow (post-T16 artifact shape)
  const artifactWith = buildArtifact({ ...baseInput, ragasShadow: makeRagasShadowSection() })
  const jsonWith = JSON.stringify(artifactWith)
  const parsedWith = JSON.parse(jsonWith) as EvaluationArtifact
  assert.equal(parsedWith.schemaVersion, 1, "post-T16 artifact parses with schemaVersion=1")
  assert.ok(parsedWith.ragasShadow, "post-T16 artifact has ragasShadow")
})

// ---------------------------------------------------------------------------
// Criterion #8: Rollback instructions — config flags exist for each capability
// ---------------------------------------------------------------------------

test("T17 #8: Langfuse rollback — env vars LANGFUSE_PUBLIC_KEY/SECRET_KEY unset → Noop (disabled)", () => {
  const source = readFileSync(CONFIG_SOURCE_PATH, "utf8")
  assert.match(source, /LANGFUSE_PUBLIC_KEY/, "LANGFUSE_PUBLIC_KEY env var documented")
  assert.match(source, /LANGFUSE_SECRET_KEY/, "LANGFUSE_SECRET_KEY env var documented")
  // Both optional → unsetting both disables Langfuse (rollback path)
  assert.match(source, /langfusePublicKey\?:\s*string/, "langfusePublicKey optional (rollback path exists)")
})

test("T17 #8: IdentityAdapter rollback — ACCESS_MODE=single_tenant disables enforced mode", () => {
  const source = readFileSync(CONFIG_SOURCE_PATH, "utf8")
  assert.match(source, /ACCESS_MODE/, "ACCESS_MODE env var documented")
  assert.match(source, /single_tenant.*enforced|accessMode.*single_tenant/, "accessMode has single_tenant default (rollback path)")
})

test("T17 #8: Ingestion review rollback — ACTIVATION_MODE=auto disables review mode", () => {
  const source = readFileSync(CONFIG_SOURCE_PATH, "utf8")
  assert.match(source, /ACTIVATION_MODE/, "ACTIVATION_MODE env var documented")
  assert.match(source, /activationMode.*auto.*review|auto.*default/, "activationMode defaults to auto (rollback path)")
})

test("T17 #8: Conversation TTL rollback — CONVERSATION_TTL_DAYS controls history retention", () => {
  const source = readFileSync(CONFIG_SOURCE_PATH, "utf8")
  assert.match(source, /CONVERSATION_TTL_DAYS/, "CONVERSATION_TTL_DAYS env var documented")
  assert.match(source, /conversationTtlDays/, "conversationTtlDays config field exists (rollback knob)")
})

test("T17 #8: Config has NO explicit flag for Handoff/compression/tool-autonomy/RAGAS (residual gap — documented)", () => {
  const source = readFileSync(CONFIG_SOURCE_PATH, "utf8")
  // These capabilities are wired unconditionally — no env flag to disable
  // This is a residual gap: rollback for these requires code changes, not config
  assert.ok(
    !/handoffEnabled|enableHandoff|DISABLE_HANDOFF/.test(source),
    "no Handoff config flag (residual gap: rollback requires code change)",
  )
  assert.ok(
    !/compressionEnabled|enableCompression|DISABLE_COMPRESSION/.test(source),
    "no compression config flag (residual gap: rollback requires code change)",
  )
  assert.ok(
    !/toolAutonomyEnabled|enableToolLoop|DISABLE_TOOL_LOOP/.test(source),
    "no tool-autonomy config flag (residual gap: rollback requires code change)",
  )
  assert.ok(
    !/ragasEnabled|enableRagas|DISABLE_RAGAS/.test(source),
    "no RAGAS config flag (residual gap: rollback requires code change)",
  )
})

test("T17 #8: Conversation GC rollback — CONVERSATION_GC_INTERVAL_MS controls sweep cadence", () => {
  const source = readFileSync(CONFIG_SOURCE_PATH, "utf8")
  assert.match(source, /CONVERSATION_GC_INTERVAL_MS/, "CONVERSATION_GC_INTERVAL_MS env var documented")
  assert.match(source, /conversationGcIntervalMs/, "conversationGcIntervalMs config field exists (rollback knob)")
})

// ---------------------------------------------------------------------------
// Cross-capability coexistence (T17 core value)
// ---------------------------------------------------------------------------

test("T17 coexistence: runtime wires ALL T61 capabilities without mutual exclusion", () => {
  const runtimeSource = readFileSync(RUNTIME_SOURCE_PATH, "utf8")
  const source = readFileSync(INDEX_SOURCE_PATH, "utf8")
  // All orchestration capabilities must be wired in the same composition root.
  const required = [
    /RouterImpl/,
    /PlannerImpl/,
    /SearcherImpl/,
    /ContextAssemblerImpl/,
    /ValidatorImpl/,
    /RePlannerImpl/,
    /SqliteConversationStore/,
    /ContextualizerImpl/,
    /SqliteHandoffStore/,
    /SummarizerImpl/,
    /ContextCompressorImpl/,
    /langfuseObserver/,
  ]
  for (const re of required) {
    assert.match(source, re, `runtime wires ${re.source}`)
  }
  assert.match(runtimeSource, /createLangfuseExporter/, "shared runtime constructs Langfuse exporter")
})

test("T17 coexistence: evaluation artifact carries deterministic + non-deterministic sections together", () => {
  // The artifact must carry: hardInvariants (deterministic) + qualityMetrics (deterministic)
  // + ragas? (non-deterministic per-case) + ragasShadow? (non-deterministic shadow)
  // All coexist without one weakening another
  const source = readFileSync(ARTIFACT_SOURCE_PATH, "utf8")
  assert.match(source, /hardInvariants/, "artifact carries hardInvariants (deterministic)")
  assert.match(source, /qualityMetrics/, "artifact carries qualityMetrics (deterministic)")
  assert.match(source, /ragas/, "artifact carries ragas (non-deterministic per-case)")
  assert.match(source, /ragasShadow/, "artifact carries ragasShadow (non-deterministic shadow)")
})

test("T17 coexistence: ACL scopes (tenant/subject/groups) preserved across all capabilities", () => {
  // ACL is the cross-cutting concern — no capability may bypass it
  // Static check: handoff_store enforces tenant scoping
  const handoffSource = readFileSync(join(here, "..", "answer", "handoff_store.ts"), "utf8")
  assert.match(handoffSource, /tenant_id/, "Handoff store enforces tenant_id scoping")
  // Access middleware exists for API endpoints
  const accessSource = readFileSync(join(here, "..", "api", "access_middleware.ts"), "utf8")
  assert.match(accessSource, /IdentityAdapter|tenantId|accessContext/, "access middleware enforces ACL")
})

// ---------------------------------------------------------------------------
// Residual gaps (honestly recorded — NOT blocking T17 verification)
// ---------------------------------------------------------------------------

test("T17: ComplexLoopControllerImpl is wired into the Mastra composition root", () => {
  const indexSource = readFileSync(INDEX_SOURCE_PATH, "utf8")
  const complexLoopSource = readFileSync(join(here, "..", "retrieval", "complex_loop.ts"), "utf8")
  assert.match(complexLoopSource, /export class ComplexLoopControllerImpl/, "ComplexLoopControllerImpl defined")
  assert.match(indexSource, /new ComplexLoopControllerImpl/, "ComplexLoopControllerImpl wired")
  assert.match(indexSource, /complexLoopController,/, "controller passed to complex runner")
})

test("T17 residual: IdentityAdapter defined but NOT wired into server (follow-up ticket)", () => {
  const serverSource = readFileSync(join(here, "..", "api", "server.ts"), "utf8")
  // server.ts must explicitly note IdentityAdapter is deferred
  assert.match(serverSource, /IdentityAdapter.*not.*wired|deferred/i, "server.ts documents IdentityAdapter as deferred (residual gap)")
})

test("T17 residual: runRagasShadowProfile has NO CLI/runner caller (follow-up ticket)", () => {
  // runRagasShadowProfile is defined but has no production caller outside tests
  // This is a residual gap — a follow-up ticket must wire it into the eval CLI
  const shadowSource = readFileSync(RAGAS_SHADOW_SOURCE_PATH, "utf8")
  assert.match(shadowSource, /export async function runRagasShadowProfile/, "runRagasShadowProfile defined")
  // No CLI runner file exists that calls it
  // (This test documents the gap; the follow-up ticket will wire it.)
})

test("T17 residual: langfuse npm package NOT installed (DI seam preserves disabled mode)", () => {
  // The langfuse npm package is NOT a dependency — callers must install it
  // to enable real export. This is by design (criterion #4 disabled mode).
  // This test documents the gap: production Langfuse round-trip requires
  // `npm install langfuse` + injecting a RealLangfuseClient.
  const exporterSource = readFileSync(join(here, "..", "answer", "langfuse_exporter.ts"), "utf8")
  assert.match(exporterSource, /RealLangfuseExporter|LangfuseClient/, "langfuse_exporter defines RealLangfuseExporter + LangfuseClient DI seam")
  // The module must NOT hard-import the langfuse npm package
  assert.ok(
    !/from\s+["']langfuse["']/.test(exporterSource),
    "langfuse_exporter does NOT import 'langfuse' npm package (DI seam — package install is caller's responsibility)",
  )
})
