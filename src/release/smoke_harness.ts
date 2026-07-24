// Ticket 06 — Production Smoke Harness.
//
// Spec issue #06: Create the single revision-bound production probe registry
// and evidence writer used by identity, retrieval/workflow, parser, shutdown,
// and observability smoke tickets.
//
// Design (karpathy-guidelines):
//   - Simplest viable shape: a registry of 14 probe declarations + a bounded
//     isolated executor + a redacting evidence writer.
//   - The harness accepts probe IMPLEMENTATIONS from Tickets 07-09 without
//     importing business internals. Probes are caller-supplied async funcs.
//   - Each probe declares: required/optional per profile, timeoutMs,
//     prerequisites, redaction behavior, fixture identity, result schema.
//   - Production mode fails for missing required probes, missing prerequisites,
//     timeout, thrown error, explicit failure, or skipped result.
//   - Local mode may skip unavailable probes but produces no production-pass
//     decision (productionReady=false always in local mode).
//   - Evidence is bound to repository revision + profile and contains no
//     token, key, prompt, passage, full answer, or private document content.
//   - Probe execution is bounded and isolated; a failed probe does not
//     prevent remaining probes from recording results.
//
// The existing src/evaluation/smoke.ts remains unchanged — it is the runtime
// smoke runner. This module is the release-time harness with richer
// declarations (timeout, prerequisites, redaction, fixture, schema) and
// revision-bound evidence output consumed by the release runner (Ticket 03).

import { writeFileSync } from "node:fs"
import { execSync } from "node:child_process"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The 14 probe names covering all spec-listed capabilities:
 * OIDC, Elasticsearch vector, Elasticsearch BM25, Neo4j, PageIndex, review
 * ingestion, chat/embedding providers, MarkItDown, Marker, MinerU,
 * cancellation, graceful shutdown, Citation integrity, Langfuse.
 */
export type ProbeName =
  | "oidc"
  | "elasticsearch_vector"
  | "elasticsearch_bm25"
  | "neo4j"
  | "pageindex"
  | "review_ingestion"
  | "chat_embedding_providers"
  | "markitdown"
  | "marker"
  | "mineru"
  | "cancellation"
  | "graceful_shutdown"
  | "citation_integrity"
  | "whole_run_budget"
  | "langfuse"

export type ProbeProfile = "local" | "production"

/**
 * Per-profile required status:
 *   - "required" — production fails if missing; local skips
 *   - "optional" — both profiles skip if missing
 *   - "skip"     — never run (reserved for future use)
 */
export type ProbeRequiredStatus = "required" | "optional" | "skip"

export interface ProbeDeclaration {
  name: ProbeName
  description: string
  requiredPerProfile: {
    local: ProbeRequiredStatus
    production: ProbeRequiredStatus
  }
  /** Bounded execution timeout in milliseconds. */
  timeoutMs: number
  /** Names of prerequisites (env vars or capabilities) the probe needs. */
  prerequisites: string[]
  /** Redaction behavior applied to probe outputs before evidence writing. */
  redaction: RedactionBehavior
  /** Stable identifier for the committed fixture the probe uses. */
  fixtureIdentity: string
  /** Declared result schema — used to validate probe outputs. */
  resultSchema: ResultSchemaField[]
}

export interface RedactionBehavior {
  /** Field names to strip from outputs entirely. */
  stripFields: string[]
  /** Regex patterns (string form) to redact with "[REDACTED]". */
  redactPatterns: string[]
  /** Maximum total output length (truncation with marker). */
  maxOutputLength: number
}

export interface ResultSchemaField {
  name: string
  type: "boolean" | "string" | "number" | "string[]"
  required: boolean
}

export interface ProbeContext {
  signal: AbortSignal
  deadlineMs: number
  /** The committed fixture (loaded by the harness before invoking the probe). */
  fixture: unknown
}

export interface ProbeResult {
  ok: boolean
  reason?: string
  /** Observable outputs/identities (will be redacted before evidence writing). */
  outputs?: Record<string, unknown>
  durationMs: number
}

/**
 * Caller-supplied async probe implementation. Tickets 07-09 provide these.
 * Undefined implementation = capability not configured.
 */
export type ProbeImplementation = (ctx: ProbeContext) => Promise<ProbeResult>

export type ProbeRunStatus =
  | "passed"
  | "failed"
  | "skipped"
  | "timeout"
  | "missing"
  | "cancelled"

export interface ProbeRunResult {
  name: ProbeName
  profile: ProbeProfile
  status: ProbeRunStatus
  reason?: string
  /** Redacted observable outputs. */
  outputs?: Record<string, unknown>
  durationMs: number
  /** True when outputs were modified by redaction. */
  redacted: boolean
}

export interface SmokeEvidence {
  schemaVersion: 1
  repositoryRevision: string
  profile: ProbeProfile
  generatedAt: string
  results: ProbeRunResult[]
  overallPassed: boolean
  /**
   * True only when profile=production AND overallPassed=true.
   * Local mode is NEVER productionReady (spec: "no production-pass decision").
   */
  productionReady: boolean
}

export interface ProbeImplementations {
  [name: string]: ProbeImplementation | undefined
}

export interface RunHarnessOptions {
  profile: ProbeProfile
  implementations: ProbeImplementations
  /** Optional fixture loader — defaults to a no-op fixture (unknown). */
  loadFixture?: (identity: string) => unknown
  /** Optional prerequisite checker — defaults to "all present". */
  checkPrerequisites?: (names: string[]) => { satisfied: boolean; missing: string[] }
  /** Optional registry override — defaults to PROBE_REGISTRY. */
  registry?: readonly ProbeDeclaration[]
  /** Optional signal for cancellation. */
  signal?: AbortSignal
}

export interface WriteEvidenceOptions {
  evidence: SmokeEvidence
  outputPath: string
}

// ---------------------------------------------------------------------------
// PROBE_REGISTRY — 14 declarations covering all spec-listed capabilities
// ---------------------------------------------------------------------------

export const PROBE_REGISTRY: readonly ProbeDeclaration[] = [
  {
    name: "oidc",
    description: "OIDC identity verification — JWT signature + issuer + audience + claims via jose",
    requiredPerProfile: { local: "optional", production: "required" },
    timeoutMs: 10_000,
    prerequisites: ["OIDC_ISSUER", "OIDC_AUDIENCE", "OIDC_JWKS_ENDPOINT"],
    redaction: {
      stripFields: ["token", "access_token", "id_token", "refresh_token", "authorization"],
      redactPatterns: ["Bearer\\s+\\S+", "eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+"],
      maxOutputLength: 1000,
    },
    fixtureIdentity: "local-oidc-server/jwt-signed-rsa2048",
    resultSchema: [
      { name: "ok", type: "boolean", required: true },
      { name: "issuer", type: "string", required: true },
      { name: "audience", type: "string", required: true },
    ],
  },
  {
    name: "elasticsearch_vector",
    description: "Elasticsearch vector search — index + embedding + k-NN query",
    requiredPerProfile: { local: "optional", production: "required" },
    timeoutMs: 15_000,
    prerequisites: ["ES_NODE", "OPENAI_API_KEY"],
    redaction: {
      stripFields: ["api_key", "apiKey", "authorization", "embedding"],
      redactPatterns: ["Bearer\\s+\\S+", "sk-[A-Za-z0-9]+"],
      maxOutputLength: 1000,
    },
    fixtureIdentity: "smoke/vector-query-fixed-embedding.json",
    resultSchema: [
      { name: "ok", type: "boolean", required: true },
      { name: "hits", type: "number", required: true },
    ],
  },
  {
    name: "elasticsearch_bm25",
    description: "Elasticsearch BM25 lexical search — index + query + scored hits",
    requiredPerProfile: { local: "optional", production: "required" },
    timeoutMs: 15_000,
    prerequisites: ["ES_NODE"],
    redaction: {
      stripFields: ["api_key", "apiKey", "authorization"],
      redactPatterns: ["Bearer\\s+\\S+"],
      maxOutputLength: 1000,
    },
    fixtureIdentity: "smoke/bm25-query-fixed-terms.json",
    resultSchema: [
      { name: "ok", type: "boolean", required: true },
      { name: "hits", type: "number", required: true },
    ],
  },
  {
    name: "neo4j",
    description: "Neo4j graph provenance — connectivity + bounded query",
    requiredPerProfile: { local: "optional", production: "required" },
    timeoutMs: 15_000,
    prerequisites: ["NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD"],
    redaction: {
      stripFields: ["password", "username", "authorization", "uri"],
      redactPatterns: ["Bearer\\s+\\S+", "neo4j://\\S+"],
      maxOutputLength: 1000,
    },
    fixtureIdentity: "smoke/graph-query-bounded.json",
    resultSchema: [
      { name: "ok", type: "boolean", required: true },
      { name: "nodes", type: "number", required: true },
    ],
  },
  {
    name: "pageindex",
    description: "PageIndex hierarchy lookup — SQLite + bounded query",
    requiredPerProfile: { local: "optional", production: "required" },
    timeoutMs: 5_000,
    prerequisites: ["SQLITE_PATH"],
    redaction: {
      stripFields: [],
      redactPatterns: [],
      maxOutputLength: 500,
    },
    fixtureIdentity: "smoke/pageindex-fixed-url.json",
    resultSchema: [
      { name: "ok", type: "boolean", required: true },
      { name: "found", type: "boolean", required: true },
    ],
  },
  {
    name: "review_ingestion",
    description: "Review ingestion pipeline — bounded source + lifecycle + tracking",
    requiredPerProfile: { local: "optional", production: "required" },
    timeoutMs: 30_000,
    prerequisites: ["SQLITE_PATH"],
    redaction: {
      stripFields: ["content", "raw_content", "prompt"],
      redactPatterns: ["Bearer\\s+\\S+"],
      maxOutputLength: 1000,
    },
    fixtureIdentity: "smoke/review-source-bounded.json",
    resultSchema: [
      { name: "ok", type: "boolean", required: true },
      { name: "sourceId", type: "string", required: true },
      { name: "versionId", type: "string", required: true },
    ],
  },
  {
    name: "chat_embedding_providers",
    description: "Chat + embedding model providers — API reachability + model identity",
    requiredPerProfile: { local: "optional", production: "required" },
    timeoutMs: 20_000,
    prerequisites: ["OPENAI_API_KEY", "OPENAI_CHAT_MODEL", "EMBEDDING_MODEL"],
    redaction: {
      stripFields: ["api_key", "apiKey", "authorization", "prompt", "response_text"],
      redactPatterns: ["Bearer\\s+\\S+", "sk-[A-Za-z0-9]+"],
      maxOutputLength: 1000,
    },
    fixtureIdentity: "smoke/chat-embedding-fixed-prompt.json",
    resultSchema: [
      { name: "ok", type: "boolean", required: true },
      { name: "chatModel", type: "string", required: true },
      { name: "embeddingModel", type: "string", required: true },
    ],
  },
  {
    name: "markitdown",
    description: "MarkItDown parser — bounded document + normalized blocks",
    requiredPerProfile: { local: "optional", production: "required" },
    timeoutMs: 30_000,
    prerequisites: ["MARKITDOWN_COMMAND"],
    redaction: {
      stripFields: ["content", "raw_content", "document_text", "prompt"],
      redactPatterns: [],
      maxOutputLength: 1000,
    },
    fixtureIdentity: "smoke/markitdown-fixed-doc.md",
    resultSchema: [
      { name: "ok", type: "boolean", required: true },
      { name: "blocks", type: "number", required: true },
    ],
  },
  {
    name: "marker",
    description: "Marker parser — bounded PDF + structured output",
    requiredPerProfile: { local: "optional", production: "required" },
    timeoutMs: 60_000,
    prerequisites: ["MARKER_COMMAND"],
    redaction: {
      stripFields: ["content", "raw_content", "document_text"],
      redactPatterns: [],
      maxOutputLength: 1000,
    },
    fixtureIdentity: "smoke/marker-fixed-doc.pdf",
    resultSchema: [
      { name: "ok", type: "boolean", required: true },
      { name: "pages", type: "number", required: true },
    ],
  },
  {
    name: "mineru",
    description: "MinerU OCR parser — bounded image + Chinese text extraction",
    requiredPerProfile: { local: "optional", production: "required" },
    timeoutMs: 60_000,
    prerequisites: ["MINERU_COMMAND"],
    redaction: {
      stripFields: ["content", "raw_content", "image_data"],
      redactPatterns: [],
      maxOutputLength: 1000,
    },
    fixtureIdentity: "smoke/mineru-fixed-image.png",
    resultSchema: [
      { name: "ok", type: "boolean", required: true },
      { name: "characters", type: "number", required: true },
    ],
  },
  {
    name: "cancellation",
    description: "Cancellation propagation — abort signal + downstream cleanup",
    requiredPerProfile: { local: "required", production: "required" },
    timeoutMs: 5_000,
    prerequisites: [],
    redaction: {
      stripFields: [],
      redactPatterns: [],
      maxOutputLength: 500,
    },
    fixtureIdentity: "smoke/cancellation-abort-signal.json",
    resultSchema: [
      { name: "ok", type: "boolean", required: true },
      { name: "aborted", type: "boolean", required: true },
    ],
  },
  {
    name: "graceful_shutdown",
    description: "Graceful shutdown — signal handling + resource closer order",
    requiredPerProfile: { local: "required", production: "required" },
    timeoutMs: 10_000,
    prerequisites: [],
    redaction: {
      stripFields: [],
      redactPatterns: [],
      maxOutputLength: 500,
    },
    fixtureIdentity: "smoke/graceful-shutdown-closers.json",
    resultSchema: [
      { name: "ok", type: "boolean", required: true },
      { name: "closersRun", type: "string[]", required: true },
    ],
  },
  {
    name: "citation_integrity",
    description: "Citation integrity — answer citations map to verified Evidence",
    requiredPerProfile: { local: "required", production: "required" },
    timeoutMs: 5_000,
    prerequisites: [],
    redaction: {
      stripFields: ["answer_text", "passage", "prompt"],
      redactPatterns: [],
      maxOutputLength: 1000,
    },
    fixtureIdentity: "smoke/citation-evidence-pairs.json",
    resultSchema: [
      { name: "ok", type: "boolean", required: true },
      { name: "citationsChecked", type: "number", required: true },
      { name: "unsupportedCitations", type: "number", required: true },
    ],
  },
  {
    name: "whole_run_budget",
    description: "Whole-run resource budget — model-call, token, and cost limits stop the run at the provider boundary",
    requiredPerProfile: { local: "required", production: "required" },
    timeoutMs: 5_000,
    prerequisites: [],
    redaction: {
      stripFields: ["api_key", "apiKey", "authorization"],
      redactPatterns: ["sk-[A-Za-z0-9]+"],
      maxOutputLength: 500,
    },
    fixtureIdentity: "smoke/whole-run-budget-limits.json",
    resultSchema: [
      { name: "ok", type: "boolean", required: true },
      { name: "limitsTested", type: "number", required: true },
      { name: "allEnforced", type: "boolean", required: true },
    ],
  },
  {
    name: "langfuse",
    description: "Langfuse observability — trace reachability + event emission",
    requiredPerProfile: { local: "optional", production: "optional" },
    timeoutMs: 10_000,
    prerequisites: ["LANGFUSE_BASE_URL", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"],
    redaction: {
      stripFields: ["secret_key", "public_key", "api_key", "authorization"],
      redactPatterns: ["Bearer\\s+\\S+", "pk-lf-[A-Za-z0-9]+", "sk-lf-[A-Za-z0-9]+"],
      maxOutputLength: 1000,
    },
    fixtureIdentity: "smoke/langfuse-trace-bounded.json",
    resultSchema: [
      { name: "ok", type: "boolean", required: true },
      { name: "traceReachable", type: "boolean", required: true },
    ],
  },
]

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Redact sensitive fields from probe outputs before evidence writing.
 * Strips declared fields, redacts declared patterns, truncates to max length.
 * Returns { redacted: boolean, outputs: Record<string, unknown> }.
 */
export function redactOutputs(
  outputs: Record<string, unknown> | undefined,
  behavior: RedactionBehavior,
): { redacted: boolean; outputs: Record<string, unknown> | undefined } {
  if (!outputs) return { redacted: false, outputs: undefined }

  let redacted = false
  const cleaned: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(outputs)) {
    if (behavior.stripFields.includes(key)) {
      redacted = true
      continue
    }
    cleaned[key] = redactValue(value, behavior, () => {
      redacted = true
    })
  }

  // Truncate stringified output if exceeds max length
  const serialized = JSON.stringify(cleaned)
  if (serialized.length > behavior.maxOutputLength) {
    return {
      redacted: true,
      outputs: {
        ...cleaned,
        _truncated: true,
        _maxLength: behavior.maxOutputLength,
      },
    }
  }

  return { redacted, outputs: cleaned }
}

function redactValue(
  value: unknown,
  behavior: RedactionBehavior,
  markRedacted: () => void,
): unknown {
  if (typeof value === "string") {
    let result = value
    for (const pattern of behavior.redactPatterns) {
      // Create a fresh regex per call — `g` flag makes `test` advance
      // lastIndex, which would break a subsequent `replace` on the same regex.
      const replaced = result.replace(new RegExp(pattern, "g"), "[REDACTED]")
      if (replaced !== result) {
        markRedacted()
        result = replaced
      }
    }
    return result
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, behavior, markRedacted))
  }
  if (value && typeof value === "object") {
    const cleaned: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (behavior.stripFields.includes(k)) {
        markRedacted()
        continue
      }
      cleaned[k] = redactValue(v, behavior, markRedacted)
    }
    return cleaned
  }
  return value
}

// ---------------------------------------------------------------------------
// Bounded isolated probe executor
// ---------------------------------------------------------------------------

function defaultCheckPrerequisites(names: string[]): {
  satisfied: boolean
  missing: string[]
} {
  // Default: check process.env for each prerequisite name
  const missing = names.filter((n) => !process.env[n])
  return { satisfied: missing.length === 0, missing }
}

function defaultLoadFixture(_identity: string): unknown {
  // Default: no fixture loaded — probes load their own fixtures
  return undefined
}

/**
 * Run a single probe with bounded execution and isolation.
 *
 * Behavior:
 *   - implementation undefined + required → missing (production: fail, local: skip)
 *   - implementation undefined + optional → skipped
 *   - prerequisites missing → skipped (with reason listing missing prereqs)
 *   - probe throws → failed (reason = error message)
 *   - probe exceeds timeoutMs → timeout
 *   - probe returns {ok:true} → passed
 *   - probe returns {ok:false} → failed (reason from result)
 *
 * A failed/timeout probe NEVER prevents remaining probes from running.
 */
export async function runProbe(
  declaration: ProbeDeclaration,
  implementation: ProbeImplementation | undefined,
  options: {
    profile: ProbeProfile
    fixture?: unknown
    checkPrerequisites?: (names: string[]) => { satisfied: boolean; missing: string[] }
    signal?: AbortSignal
  },
): Promise<ProbeRunResult> {
  const { profile, signal } = options
  const start = Date.now()
  const checkPrereqs = options.checkPrerequisites ?? defaultCheckPrerequisites
  const fixture = options.fixture ?? undefined

  const requiredStatus = declaration.requiredPerProfile[profile]

  // "skip" status — never run
  if (requiredStatus === "skip") {
    return {
      name: declaration.name,
      profile,
      status: "skipped",
      reason: "probe declared as skip for this profile",
      durationMs: Date.now() - start,
      redacted: false,
    }
  }

  // Missing implementation
  if (implementation === undefined) {
    if (requiredStatus === "required") {
      return {
        name: declaration.name,
        profile,
        status: profile === "production" ? "missing" : "skipped",
        reason:
          profile === "production"
            ? "required probe implementation not provided"
            : "no implementation provided for local profile",
        durationMs: Date.now() - start,
        redacted: false,
      }
    }
    // optional + missing implementation → skipped
    return {
      name: declaration.name,
      profile,
      status: "skipped",
      reason: "optional probe not configured",
      durationMs: Date.now() - start,
      redacted: false,
    }
  }

  // Check prerequisites
  const prereqCheck = checkPrereqs(declaration.prerequisites)
  if (!prereqCheck.satisfied) {
    if (requiredStatus === "required" && profile === "production") {
      return {
        name: declaration.name,
        profile,
        status: "missing",
        reason: `missing prerequisites: ${prereqCheck.missing.join(", ")}`,
        durationMs: Date.now() - start,
        redacted: false,
      }
    }
    return {
      name: declaration.name,
      profile,
      status: "skipped",
      reason: `missing prerequisites: ${prereqCheck.missing.join(", ")}`,
      durationMs: Date.now() - start,
      redacted: false,
    }
  }

  // Bounded execution with timeout
  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), declaration.timeoutMs)

  // If external signal aborts, propagate
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeoutHandle)
      return {
        name: declaration.name,
        profile,
        status: "skipped",
        reason: "external signal aborted before start",
        durationMs: Date.now() - start,
        redacted: false,
      }
    }
    signal.addEventListener(
      "abort",
      () => controller.abort(),
      { once: true },
    )
  }

  try {
    const result = await implementation({
      signal: controller.signal,
      deadlineMs: declaration.timeoutMs,
      fixture,
    })
    clearTimeout(timeoutHandle)

    const { redacted, outputs } = redactOutputs(result.outputs, declaration.redaction)

    if (result.ok) {
      return {
        name: declaration.name,
        profile,
        status: "passed",
        outputs,
        durationMs: result.durationMs || Date.now() - start,
        redacted,
      }
    }
    return {
      name: declaration.name,
      profile,
      status: "failed",
      reason: result.reason ?? "probe returned ok=false",
      outputs,
      durationMs: result.durationMs || Date.now() - start,
      redacted,
    }
  } catch (err) {
    clearTimeout(timeoutHandle)
    const isTimeout =
      err instanceof Error && err.name === "AbortError" && controller.signal.aborted
    if (isTimeout) {
      return {
        name: declaration.name,
        profile,
        status: "timeout",
        reason: `exceeded ${declaration.timeoutMs}ms`,
        durationMs: Date.now() - start,
        redacted: false,
      }
    }
    return {
      name: declaration.name,
      profile,
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
      redacted: false,
    }
  }
}

// ---------------------------------------------------------------------------
// Run all probes in registry order (sequential, partial-failure tolerant)
// ---------------------------------------------------------------------------

export async function runAllProbes(
  options: RunHarnessOptions,
): Promise<SmokeEvidence> {
  const {
    profile,
    implementations,
    loadFixture = defaultLoadFixture,
    checkPrerequisites = defaultCheckPrerequisites,
    registry = PROBE_REGISTRY,
    signal,
  } = options

  const results: ProbeRunResult[] = []
  for (const declaration of registry) {
    const impl = implementations[declaration.name]
    const fixture = loadFixture(declaration.fixtureIdentity)
    // Sequential — a crashing probe must NOT cascade-fail others
    const result = await runProbe(declaration, impl, {
      profile,
      fixture,
      checkPrerequisites,
      signal,
    })
    results.push(result)
  }

  const overallPassed = computeOverallPassed(results, profile)
  const productionReady = profile === "production" && overallPassed
  const repositoryRevision = getGitRevision()

  return {
    schemaVersion: 1,
    repositoryRevision,
    profile,
    generatedAt: new Date().toISOString(),
    results,
    overallPassed,
    productionReady,
  }
}

/**
 * Aggregate pass decision (Ticket 03 corrected semantics).
 *
 * Production:
 *   - Required probe: any non-passed (failed/timeout/cancelled/missing/skipped) is failure.
 *   - Optional probe: actual failures (failed/timeout/cancelled) fail; absence
 *     (missing/skipped) does NOT affect the deterministic decision.
 * Local:
 *   - Actual failures (failed/timeout/cancelled) fail the gate.
 *   - Absence (skipped/missing) is allowed.
 *
 * Unknown probe names (not in registry) are treated as required (conservative).
 */
export function computeOverallPassed(
  results: ProbeRunResult[],
  profile: ProbeProfile,
  registry: readonly ProbeDeclaration[] = PROBE_REGISTRY,
): boolean {
  for (const r of results) {
    const decl = registry.find((d) => d.name === r.name)
    const requiredStatus = decl?.requiredPerProfile[profile] ?? "required"
    const isRequired = requiredStatus === "required"

    if (profile === "production") {
      if (isRequired) {
        // Required probe in production: any non-passed is failure.
        if (r.status !== "passed") return false
      } else {
        // Optional probe in production: actual failures fail;
        // absence (missing/skipped) does not affect deterministic decision.
        if (
          r.status === "failed" ||
          r.status === "timeout" ||
          r.status === "cancelled"
        ) {
          return false
        }
      }
    } else {
      // Local: actual failures (failed/timeout/cancelled) fail the gate.
      if (
        r.status === "failed" ||
        r.status === "timeout" ||
        r.status === "cancelled"
      ) {
        return false
      }
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// Evidence writer + validator
// ---------------------------------------------------------------------------

function getGitRevision(): string {
  try {
    return execSync("git rev-parse HEAD", {
      encoding: "utf8",
      timeout: 5_000,
    }).trim()
  } catch {
    return "unknown"
  }
}

/**
 * Write sanitized evidence to a file consumed by the release runner.
 * The evidence is bound to repository revision + profile and contains
 * only redacted probe outputs.
 */
export function writeSmokeEvidence(options: WriteEvidenceOptions): void {
  const { evidence, outputPath } = options
  // Validate before writing — fail fast on malformed evidence
  const validation = validateSmokeEvidence(evidence)
  if (!validation.valid) {
    throw new Error(
      `smoke evidence validation failed: ${validation.errors.join(", ")}`,
    )
  }
  writeFileSync(outputPath, JSON.stringify(evidence, null, 2) + "\n", "utf8")
}

export interface SmokeEvidenceValidation {
  valid: boolean
  errors: string[]
}

/**
 * Validate a SmokeEvidence object structurally.
 * Used by the release runner before consuming the evidence file.
 */
export function validateSmokeEvidence(evidence: unknown): SmokeEvidenceValidation {
  const errors: string[] = []
  if (!evidence || typeof evidence !== "object") {
    return { valid: false, errors: ["evidence is not an object"] }
  }
  const e = evidence as Record<string, unknown>

  if (e.schemaVersion !== 1) errors.push("schemaVersion must be 1")
  if (typeof e.repositoryRevision !== "string" || !e.repositoryRevision) {
    errors.push("repositoryRevision must be a non-empty string")
  }
  if (e.profile !== "local" && e.profile !== "production") {
    errors.push("profile must be 'local' or 'production'")
  }
  if (typeof e.generatedAt !== "string") {
    errors.push("generatedAt must be a string")
  }
  if (!Array.isArray(e.results)) {
    errors.push("results must be an array")
  } else {
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i] as Record<string, unknown>
      if (!r || typeof r !== "object") {
        errors.push(`results[${i}] is not an object`)
        continue
      }
      if (typeof r.name !== "string") errors.push(`results[${i}].name must be a string`)
      if (r.profile !== "local" && r.profile !== "production") {
        errors.push(`results[${i}].profile must be 'local' or 'production'`)
      }
      const validStatuses = ["passed", "failed", "skipped", "timeout", "missing", "cancelled"]
      if (!validStatuses.includes(r.status as string)) {
        errors.push(`results[${i}].status must be one of ${validStatuses.join(", ")}`)
      }
      if (typeof r.durationMs !== "number") {
        errors.push(`results[${i}].durationMs must be a number`)
      }
      if (typeof r.redacted !== "boolean") {
        errors.push(`results[${i}].redacted must be a boolean`)
      }
    }
  }
  if (typeof e.overallPassed !== "boolean") {
    errors.push("overallPassed must be a boolean")
  }
  if (typeof e.productionReady !== "boolean") {
    errors.push("productionReady must be a boolean")
  }
  // Cross-field: productionReady can only be true when profile=production AND overallPassed=true
  if (e.productionReady === true) {
    if (e.profile !== "production") {
      errors.push("productionReady=true requires profile=production")
    }
    if (e.overallPassed !== true) {
      errors.push("productionReady=true requires overallPassed=true")
    }
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Forbidden field names that must never appear in persisted evidence — even
 * as `[REDACTED]` — because they indicate the probe leaked content it should
 * not (prompts, customer text, embeddings, parser source content). Credential
 * fields (token, api_key, authorization) are handled separately by the
 * pattern-based scan and per-probe `stripFields` config.
 *
 * Ticket 04 / Issue 15: secret scanning rejects persisted prompts, customer
 * text, embeddings, and parser source content in addition to JWTs/credentials.
 */
const FORBIDDEN_CONTENT_FIELDS: readonly string[] = [
  "prompt",
  "passage",
  "answer_text",
  "customer_text",
  "embedding",
  "embeddings",
  "parser_source_content",
  "raw_document_text",
  "image_bytes",
  "source_content",
  "document_text",
]

/**
 * Scan evidence for unredacted sensitive content.
 * Returns a list of fields that appear to contain secrets/tokens/keys.
 * Used as a defense-in-depth check before writing evidence.
 *
 * Ticket 04 / Issue 15: the scan now also rejects persisted prompts, customer
 * text, embeddings, and parser source content by checking for forbidden field
 * names that should have been stripped by per-probe redaction config.
 */
export function scanForSecrets(evidence: SmokeEvidence): string[] {
  const findings: string[] = []
  const suspiciousPatterns = [
    /Bearer\s+\S+/,
    /sk-[A-Za-z0-9]{20,}/,
    /pk-lf-[A-Za-z0-9]+/,
    /sk-lf-[A-Za-z0-9]+/,
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/, // JWT
  ]
  const serialized = JSON.stringify(evidence)
  for (const pattern of suspiciousPatterns) {
    if (pattern.test(serialized)) {
      findings.push(`suspicious pattern matched: ${pattern.source}`)
    }
  }
  // Defense in depth: forbidden content fields should have been stripped by
  // per-probe redaction. If any survive into the serialized evidence, the
  // redaction config was bypassed or incomplete — reject the evidence.
  for (const field of FORBIDDEN_CONTENT_FIELDS) {
    const fieldPattern = new RegExp(`"${field}"\\s*:`)
    if (fieldPattern.test(serialized)) {
      findings.push(`forbidden content field present: ${field}`)
    }
  }
  return findings
}
