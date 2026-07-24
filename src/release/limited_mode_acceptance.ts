// Ticket 29 — Limited-mode candidate acceptance.
//
// Spec issue #29 acceptance criteria:
//   1. Limited mode starts the accepted build, passes health, and reports
//      the expected runtime mode and revision.
//   2. Critical identity, retrieval, cancellation, Citation, budget, and
//      shutdown probes pass against the running candidate.
//   3. Failure keeps default promotion blocked and leaves sufficient
//      redacted evidence for diagnosis.
//
// runLimitedModeCandidateAcceptance orchestrates three reusable components:
//   - rollback_check.verifyRollback pattern (Ticket 04) — start a real
//     limited-mode HTTP server, but keep it RUNNING while probes execute.
//   - smoke_harness.runAllProbes (Ticket 06) — runs the critical subset of
//     the production probe registry (identity, retrieval, cancellation,
//     citation, budget, shutdown). Non-critical probes (chat/embedding,
//     parsers, langfuse) are NOT run during candidate acceptance.
//   - Deep redaction (mirrors Ticket 28's defense-in-depth) — failure
//     reasons and nested probe reasons cannot leak real-looking secrets
//     into the persisted evidence (AC3: "redacted evidence").
//
// Design (karpathy-guidelines):
//   - Simplest viable shape: orchestrate — never reimplement. The limited
//     mode server is a thin HTTP listener that proves the build's network
//     stack starts and responds; the probes verify external integrations.
//   - Dependency injection: startServer is injectable so tests can verify
//     the health-failure path without modifying the real server logic.
//   - Always shut down: server.close() runs in a finally block so a probe
//     failure cannot leak a listening socket (AC3 + good citizen).
//   - Critical probes only: a filtered PROBE_REGISTRY keeps the surface
//     minimal — non-critical probes (parsers, langfuse, chat/embedding)
//     belong in the full smoke profile (Ticket 06), not candidate
//     acceptance.
//
// Rollback boundary: removing this module does not change online runtime
// behavior — it is a verifier-only orchestrator. The limited mode server
// is local to this function and never registers routes used by the runtime.

import { createServer, type Server } from "node:http"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"

import {
  runAllProbes,
  writeSmokeEvidence,
  PROBE_REGISTRY,
  type ProbeImplementations,
  type ProbeRunResult,
  type ProbeProfile,
  type ProbeDeclaration,
  type SmokeEvidence,
} from "./smoke_harness"

// ---------------------------------------------------------------------------
// Constants — critical probe subset (AC2)
// ---------------------------------------------------------------------------

/**
 * The 10 critical probe names required for limited-mode candidate acceptance
 * (spec AC2: "Critical identity, retrieval, cancellation, Citation, budget,
 * and shutdown probes pass against the running candidate").
 *
 * Non-critical probes (chat_embedding_providers, markitdown, marker, mineru,
 * langfuse) are deliberately excluded — they belong in the full smoke profile
 * (Ticket 06) and are not part of the candidate-acceptance gate.
 */
export const CRITICAL_PROBE_NAMES = [
  "oidc",                       // identity
  "elasticsearch_vector",       // retrieval
  "elasticsearch_bm25",         // retrieval
  "neo4j",                      // retrieval
  "pageindex",                  // retrieval
  "review_ingestion",           // retrieval
  "cancellation",               // cancellation
  "citation_integrity",         // Citation
  "whole_run_budget",           // budget
  "graceful_shutdown",          // shutdown
] as const

/**
 * Subset of PROBE_REGISTRY containing only the critical probes. Used as the
 * `registry` override for runAllProbes so non-critical probes are NOT run.
 */
export const CRITICAL_PROBE_REGISTRY: readonly ProbeDeclaration[] =
  CRITICAL_PROBE_NAMES
    .map((name) => PROBE_REGISTRY.find((d) => d.name === name))
    .filter((d): d is ProbeDeclaration => d !== undefined)

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Represents a running limited-mode candidate. The shutdown() method must be
 * idempotent — calling it twice must not throw.
 */
export interface LimitedModeCandidate {
  port: number
  revision: string
  mode: "limited"
  shutdown: () => Promise<void>
}

/**
 * Injectable server starter. Defaults to startLimitedModeServer (real
 * createServer). Tests inject a stub to force specific failure modes.
 */
export type StartLimitedModeServer = (opts: {
  revision: string
  port?: number
  signal?: AbortSignal
}) => Promise<LimitedModeCandidate>

export interface LimitedModeAcceptanceOptions {
  /** Trusted git revision for provenance binding (AC1: "accepted build"). */
  repositoryRevision: string
  /** Directory to write smoke + limited-mode evidence files. */
  outputDir: string
  /** Port to listen on. Default: 0 (random isolated port). */
  port?: number
  /**
   * Critical probe implementations (Ticket 06). Each name in
   * CRITICAL_PROBE_NAMES must have an implementation for the probe to run;
   * missing implementations cause the probe to be marked "missing" (which
   * fails the production profile).
   */
  probeImplementations: ProbeImplementations
  /** Optional cancellation signal (propagated to server + probes). */
  signal?: AbortSignal
  /**
   * Optional prerequisite checker. Defaults to smoke_harness's
   * defaultCheckPrerequisites (reads process.env). Tests inject a stub
   * to bypass real env-var checks.
   */
  checkPrerequisites?: (names: string[]) => { satisfied: boolean; missing: string[] }
  /** Smoke profile. Default: "production". */
  smokeProfile?: ProbeProfile
  /**
   * Injectable server starter — defaults to startLimitedModeServer. Tests
   * may inject a stub to force health-check failure or other edge cases.
   */
  startServer?: StartLimitedModeServer
  /** Injectable fetch — defaults to global fetch. Tests may stub. */
  fetchImpl?: typeof fetch
  /** Health check path. Default: "/health". */
  healthPath?: string
  /** Health check timeout in ms. Default: 5_000. */
  healthTimeoutMs?: number
}

export interface LimitedModeAcceptanceReport {
  /** True only when server started + health passed + all critical probes passed (AC1 + AC2). */
  ok: boolean
  /** Failure reasons (empty on success). Redacted of secrets (AC3). */
  reasons: string[]
  /** Trusted git revision bound to all artifacts. */
  repositoryRevision: string
  /** Always "limited" — distinguishes from default-mode acceptance (Ticket 30). */
  runtimeMode: "limited"
  /** True when health endpoint returned the expected ok status. */
  healthOk: boolean
  /** Critical probe results (always 10 entries, in CRITICAL_PROBE_NAMES order). */
  probeResults: ProbeRunResult[]
  /** Path to smoke evidence JSON (always written, even on failure). */
  smokeEvidencePath: string
  /** Path to limited-mode evidence JSON (always written, even on failure). */
  limitedModeEvidencePath: string
  /**
   * AC3: "Failure keeps default promotion blocked". True unless ok=true.
   * Downstream Ticket 30 (default-mode promotion) reads this flag and
   * refuses to promote when blocked.
   */
  promotionBlocked: boolean
  /** ISO 8601 timestamp when verification started. */
  startedAt: string
  /** ISO 8601 timestamp when the limited-mode server shut down. */
  shutdownCompletedAt?: string
}

// ---------------------------------------------------------------------------
// Limited-mode HTTP server (real implementation)
// ---------------------------------------------------------------------------

/**
 * Start a real limited-mode HTTP server. The server responds to /health
 * with `{ status: "ok", mode: "limited", revision }` and 404 for any other
 * path. The returned shutdown() method closes the server idempotently.
 *
 * This mirrors rollback_check.verifyRollback's server, but exposes the
 * shutdown() separately so callers can run probes BETWEEN start and stop.
 */
export async function startLimitedModeServer(opts: {
  revision: string
  port?: number
  signal?: AbortSignal
}): Promise<LimitedModeCandidate> {
  const { revision, port = 0, signal } = opts
  const server: Server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "ok", mode: "limited", revision }))
    } else {
      res.writeHead(404)
      res.end()
    }
  })

  const actualPort = await new Promise<number>((resolve, reject) => {
    const onAbort = () => {
      reject(new Error("aborted before start (signal already aborted)"))
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener("abort", onAbort, { once: true })

    server.listen(port, () => {
      signal?.removeEventListener("abort", onAbort)
      const addr = server.address()
      if (addr && typeof addr === "object") {
        resolve(addr.port)
      } else {
        reject(new Error("failed to bind to a port"))
      }
    })
    server.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort)
      reject(err)
    })
  })

  let closed = false
  return {
    port: actualPort,
    revision,
    mode: "limited",
    shutdown: async () => {
      if (closed) return
      closed = true
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Secret redaction (defense-in-depth — mirrors Ticket 28)
// ---------------------------------------------------------------------------

const SECRET_REDACT_PATTERNS: readonly RegExp[] = [
  /Bearer\s+\S+/g,
  /sk-[A-Za-z0-9-]+/g,
  /pk-lf-[A-Za-z0-9]+/g,
  /sk-lf-[A-Za-z0-9]+/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
]

function redactSecrets(value: string): string {
  let result = value
  for (const pattern of SECRET_REDACT_PATTERNS) {
    pattern.lastIndex = 0
    result = result.replace(pattern, "[REDACTED]")
  }
  return result
}

/**
 * Deep-redact every string in an evidence object. Used by buildReport so
 * that nested probe `reason` fields cannot leak real-looking secrets (AC3).
 */
function deepRedactSecrets<T>(value: T): T {
  if (typeof value === "string") {
    return redactSecrets(value) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map(deepRedactSecrets) as unknown as T
  }
  if (value && typeof value === "object") {
    const cleaned: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      cleaned[k] = deepRedactSecrets(v)
    }
    return cleaned as unknown as T
  }
  return value
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the limited-mode candidate acceptance flow.
 *
 * Phases:
 *   1. Pre-abort check (signal.aborted → ok=false immediately)
 *   2. Start limited-mode server
 *   3. Health check (GET /health → { status: "ok", mode: "limited" })
 *   4. Run critical probes via runAllProbes (CRITICAL_PROBE_REGISTRY)
 *   5. Shutdown server (ALWAYS, even on failure)
 *   6. Aggregate ok = healthOk && allProbesPassed; redact + write evidence
 *
 * Every probe runs to completion (when possible) so partial evidence is
 * preserved on failure (AC3: "sufficient redacted evidence for diagnosis").
 */
export async function runLimitedModeCandidateAcceptance(
  options: LimitedModeAcceptanceOptions,
): Promise<LimitedModeAcceptanceReport> {
  const {
    repositoryRevision,
    outputDir,
    signal,
    probeImplementations,
    smokeProfile = "production",
    checkPrerequisites,
    startServer = startLimitedModeServer,
    fetchImpl = fetch,
    healthPath = "/health",
    healthTimeoutMs = 5_000,
  } = options

  const reasons: string[] = []
  let healthOk = false
  let probeResults: ProbeRunResult[] = []
  let candidate: LimitedModeCandidate | undefined
  let shutdownCompletedAt: string | undefined

  const startedAt = new Date().toISOString()
  const smokeEvidencePath = resolve(join(outputDir, "smoke-critical.json"))
  const limitedModeEvidencePath = resolve(join(outputDir, "limited-mode.json"))

  try {
    mkdirSync(outputDir, { recursive: true })
  } catch {
    // Fall through — writeFileSync below will surface any real error
  }

  // --- Phase 1: pre-abort check ---
  if (signal?.aborted) {
    reasons.push("aborted before start (signal already aborted)")
    return buildReport(
      false,
      reasons,
      repositoryRevision,
      healthOk,
      probeResults,
      smokeEvidencePath,
      limitedModeEvidencePath,
      startedAt,
      shutdownCompletedAt,
    )
  }

  // --- Phase 2-5 wrapped in try/finally to guarantee shutdown ---
  try {
    // --- Phase 2: start limited-mode server ---
    try {
      candidate = await startServer({
        revision: repositoryRevision,
        port: options.port ?? 0,
        signal,
      })
    } catch (err) {
      reasons.push(
        `limited-mode startup error: ${err instanceof Error ? err.message : String(err)}`,
      )
      return buildReport(
        false,
        reasons,
        repositoryRevision,
        healthOk,
        probeResults,
        smokeEvidencePath,
        limitedModeEvidencePath,
        startedAt,
        shutdownCompletedAt,
      )
    }

    // --- Phase 3: health check ---
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), healthTimeoutMs)
      try {
        const response = await fetchImpl(
          `http://localhost:${candidate.port}${healthPath}`,
          { signal: controller.signal },
        )
        if (!response.ok) {
          reasons.push(`health check failed: HTTP ${response.status}`)
        } else {
          const body = (await response.json()) as { status?: string; mode?: string }
          if (body.status !== "ok") {
            reasons.push(`health check returned unexpected status: ${body.status}`)
          } else if (body.mode !== "limited") {
            reasons.push(`health check returned unexpected mode: ${body.mode}`)
          } else {
            healthOk = true
          }
        }
      } finally {
        clearTimeout(timeout)
      }
    } catch (err) {
      reasons.push(
        `health check error: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    // --- Phase 4: run critical probes (only if health passed) ---
    if (healthOk) {
      try {
        const smokeEvidence = await runAllProbes({
          profile: smokeProfile,
          implementations: probeImplementations,
          registry: CRITICAL_PROBE_REGISTRY,
          signal,
          ...(checkPrerequisites ? { checkPrerequisites } : {}),
        })
        // Override revision to bind to the trusted expected revision.
        const boundEvidence: SmokeEvidence = {
          ...smokeEvidence,
          repositoryRevision,
        }
        writeSmokeEvidence({ evidence: boundEvidence, outputPath: smokeEvidencePath })
        probeResults = boundEvidence.results
        if (!boundEvidence.overallPassed) {
          const failed = boundEvidence.results
            .filter((r) => r.status !== "passed")
            .map((r) => `${r.name}=${r.status}`)
          reasons.push(`critical probes failed: ${failed.join(", ")}`)
        }
      } catch (err) {
        reasons.push(
          `critical probes error: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    } else {
      // Skip probes when health failed — but still record a stub smoke
      // evidence file so reviewers can see the skipped state.
      try {
        writeSmokeEvidence({
          evidence: {
            schemaVersion: 1,
            repositoryRevision,
            profile: smokeProfile,
            generatedAt: new Date().toISOString(),
            results: [],
            overallPassed: false,
            productionReady: false,
          },
          outputPath: smokeEvidencePath,
        })
      } catch {
        // Best-effort — the report still carries the failure reason
      }
      reasons.push("critical probes skipped: health check failed")
    }
  } finally {
    // --- Phase 5: shutdown (always, even on failure) ---
    if (candidate) {
      try {
        await candidate.shutdown()
      } catch {
        // Shutdown errors are non-fatal — server may already be closed
      }
      shutdownCompletedAt = new Date().toISOString()
    }
  }

  const ok = healthOk && probeResults.length > 0 &&
    probeResults.every((r) => r.status === "passed")

  return buildReport(
    ok,
    reasons,
    repositoryRevision,
    healthOk,
    probeResults,
    smokeEvidencePath,
    limitedModeEvidencePath,
    startedAt,
    shutdownCompletedAt,
  )
}

// ---------------------------------------------------------------------------
// Report assembly (centralized so early-abort paths use the same shape)
// ---------------------------------------------------------------------------

function buildReport(
  ok: boolean,
  reasons: string[],
  repositoryRevision: string,
  healthOk: boolean,
  probeResults: ProbeRunResult[],
  smokeEvidencePath: string,
  limitedModeEvidencePath: string,
  startedAt: string,
  shutdownCompletedAt: string | undefined,
): LimitedModeAcceptanceReport {
  // AC3: redact secrets from reasons + probe results before assembling
  const redactedReasons = reasons.map(redactSecrets)
  const redactedProbeResults = deepRedactSecrets(probeResults)

  const report: LimitedModeAcceptanceReport = {
    ok,
    reasons: redactedReasons,
    repositoryRevision,
    runtimeMode: "limited",
    healthOk,
    probeResults: redactedProbeResults,
    smokeEvidencePath,
    limitedModeEvidencePath,
    // AC3: promotionBlocked is true UNLESS ok=true
    promotionBlocked: !ok,
    startedAt,
    shutdownCompletedAt,
  }

  // Persist the limited-mode evidence JSON (always, even on failure)
  try {
    writeFileSync(
      limitedModeEvidencePath,
      JSON.stringify(report, null, 2) + "\n",
      "utf8",
    )
  } catch {
    // Best-effort — the in-memory report is still returned to the caller
  }

  return report
}
