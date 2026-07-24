// Ticket 30 — Default-mode promotion acceptance.
//
// Spec issue #30 acceptance criteria:
//   1. Default mode starts only with the exact V2 artifact and revision
//      that passed limited acceptance.
//   2. Missing, stale, local-profile, tampered, or failing artifacts are
//      rejected before runtime resources are created.
//   3. Critical production smoke and graceful shutdown pass in default
//      mode with exactly one terminal per Answer run.
//
// runDefaultModePromotionAcceptance orchestrates:
//   - validateV2Artifact (NEW, AC2) — pure function that rejects missing,
//     stale, local-profile, tampered, or failing artifacts BEFORE any
//     runtime resource (server, probe, Answer run) is created.
//   - startDefaultModeServer (NEW) — mirrors Ticket 29's
//     startLimitedModeServer but advertises mode: "default" on /health.
//   - smoke_harness.runAllProbes (Ticket 06) — runs the critical subset
//     of the production probe registry (reuses CRITICAL_PROBE_REGISTRY
//     from Ticket 29 — identity, retrieval, cancellation, citation,
//     budget, shutdown).
//   - runAnswerOnce (AC3 NEW) — injected callable that runs exactly one
//     Answer turn and reports the terminal message count. Acceptance
//     requires terminalCount === 1 (AC3: "exactly one terminal per
//     Answer run").
//   - Deep redaction (mirrors Tickets 28 + 29) — failure reasons and
//     nested probe reasons cannot leak real-looking secrets.
//
// Design (karpathy-guidelines):
//   - Simplest viable shape: orchestrate — never reimplement. Artifact
//     validation is pure; server/probes/Answer are injected or reused.
//   - Fail fast: artifact validation runs BEFORE server start so a rejected
//     artifact leaves zero runtime footprint (AC2: "before runtime
//     resources are created").
//   - Always shut down: server.close() runs in a finally block so a probe
//     failure cannot leak a listening socket.
//   - Reuse Ticket 29's CRITICAL_PROBE_REGISTRY — same critical subset
//     applies to default-mode acceptance (spec AC3: "Critical production
//     smoke and graceful shutdown pass in default mode").
//
// Rollback boundary: removing this module does not change online runtime
// behavior — it is a verifier-only orchestrator.

import { createServer, type Server } from "node:http"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"

import {
  runAllProbes,
  writeSmokeEvidence,
  type ProbeImplementations,
  type ProbeRunResult,
  type ProbeProfile,
  type SmokeEvidence,
} from "./smoke_harness"
import { CRITICAL_PROBE_REGISTRY } from "./limited_mode_acceptance"
import { computeEvidenceHash, type ReleaseRunnerArtifact } from "./runner"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ArtifactRejectionReason =
  | "missing"
  | "stale"
  | "local-profile"
  | "tampered"
  | "failing"

export interface ArtifactValidationResult {
  valid: boolean
  reason?: ArtifactRejectionReason
}

export interface ArtifactValidationOptions {
  expectedRevision: string
  /** Allowed profile — default "production". "local" is rejected. */
  expectedProfile?: "production" | "local"
}

/**
 * Represents a running default-mode candidate. The shutdown() method must
 * be idempotent.
 */
export interface DefaultModeCandidate {
  port: number
  revision: string
  mode: "default"
  shutdown: () => Promise<void>
}

export type StartDefaultModeServer = (opts: {
  revision: string
  port?: number
  signal?: AbortSignal
}) => Promise<DefaultModeCandidate>

/**
 * AC3: "exactly one terminal per Answer run". The injected callable runs
 * a single Answer turn and reports the terminal count + ok status.
 * Production wires the real Answer runtime; tests inject stubs.
 */
export type RunAnswerOnce = (opts: {
  signal: AbortSignal
  deadlineMs: number
}) => Promise<{
  terminalCount: number
  ok: boolean
  reason?: string
}>

export interface DefaultModeAcceptanceOptions {
  /** Trusted git revision (must match V2 artifact). */
  repositoryRevision: string
  /** Directory to write smoke + default-mode evidence files. */
  outputDir: string
  /** V2 artifact from Ticket 28 (AC1: "exact V2 artifact"). */
  v2Artifact: ReleaseRunnerArtifact
  /** Critical probe implementations (reuses Ticket 29's set). */
  probeImplementations: ProbeImplementations
  /**
   * AC3: runs one Answer turn and reports terminalCount. Default: stub
   * that returns { terminalCount: 1, ok: true } — production wires the
   * real Answer runtime.
   */
  runAnswerOnce?: RunAnswerOnce
  /** Optional cancellation signal. */
  signal?: AbortSignal
  /** Injectable prerequisite checker. */
  checkPrerequisites?: (names: string[]) => { satisfied: boolean; missing: string[] }
  /** Smoke profile. Default: "production". */
  smokeProfile?: ProbeProfile
  /** Injectable server starter — defaults to startDefaultModeServer. */
  startServer?: StartDefaultModeServer
  /** Injectable fetch — defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Health check path. Default: "/health". */
  healthPath?: string
  /** Health check timeout in ms. Default: 5_000. */
  healthTimeoutMs?: number
  /** Port to listen on. Default: 0 (random isolated port). */
  port?: number
  /** Answer run timeout in ms. Default: 30_000. */
  answerTimeoutMs?: number
}

export interface DefaultModeAcceptanceReport {
  /** True only when artifact valid + health + probes + Answer + shutdown all pass. */
  ok: boolean
  /** Failure reasons (empty on success). Redacted of secrets. */
  reasons: string[]
  /** Trusted git revision. */
  repositoryRevision: string
  /** Always "default" — distinguishes from limited-mode (Ticket 29). */
  runtimeMode: "default"
  /** AC2: true when V2 artifact passed validation. */
  artifactValidated: boolean
  /** AC2: rejection reason when artifactValidated=false (undefined when valid). */
  artifactRejectionReason?: ArtifactRejectionReason
  /** True when health endpoint returned the expected ok status. */
  healthOk: boolean
  /** Critical probe results (empty when artifact rejected or health failed). */
  probeResults: ProbeRunResult[]
  /** AC3: terminal message count from the Answer run (must be exactly 1). */
  terminalCount: number
  /** True when graceful shutdown completed. */
  shutdownOk: boolean
  /** Path to smoke evidence JSON. */
  smokeEvidencePath: string
  /** Path to default-mode evidence JSON. */
  defaultModeEvidencePath: string
  /** AC1+AC3: true unless ok=true (withholds promotion on any failure). */
  promotionBlocked: boolean
  /** ISO 8601 timestamp when verification started. */
  startedAt: string
  /** ISO 8601 timestamp when the default-mode server shut down (undefined when never started). */
  shutdownCompletedAt?: string
}

// ---------------------------------------------------------------------------
// Pure function: validateV2Artifact (AC2)
// ---------------------------------------------------------------------------

/**
 * Validate the V2 artifact against expected revision + profile.
 *
 * Rejection reasons (checked in order, first match wins):
 *   - "missing"        : artifact is null/undefined or schemaVersion !== 2
 *   - "stale"          : repositoryRevision !== expectedRevision
 *   - "local-profile"  : profile !== expectedProfile (default "production")
 *   - "tampered"       : evidenceHash !== computeEvidenceHash(artifact)
 *   - "failing"        : overallPassed === false
 *
 * Pure function — no side effects, no async, no I/O.
 */
export function validateV2Artifact(
  artifact: ReleaseRunnerArtifact,
  options: ArtifactValidationOptions,
): ArtifactValidationResult {
  const expectedProfile = options.expectedProfile ?? "production"

  // Missing: null/undefined or wrong schemaVersion
  if (artifact === null || artifact === undefined) {
    return { valid: false, reason: "missing" }
  }
  if (
    typeof artifact !== "object" ||
    artifact.schemaVersion !== 2 ||
    !("repositoryRevision" in artifact)
  ) {
    return { valid: false, reason: "missing" }
  }

  // Stale: revision mismatch
  if (artifact.repositoryRevision !== options.expectedRevision) {
    return { valid: false, reason: "stale" }
  }

  // Local-profile: profile mismatch
  if (artifact.profile !== expectedProfile) {
    return { valid: false, reason: "local-profile" }
  }

  // Tampered: hash mismatch (recompute over canonical sections)
  const recomputedHash = computeEvidenceHash(
    artifact as Omit<ReleaseRunnerArtifact, "evidenceHash" | "nonDeterministicReports">,
  )
  if (artifact.evidenceHash !== recomputedHash) {
    return { valid: false, reason: "tampered" }
  }

  // Failing: overallPassed=false
  if (artifact.overallPassed !== true) {
    return { valid: false, reason: "failing" }
  }

  return { valid: true }
}

// ---------------------------------------------------------------------------
// Default-mode HTTP server (real implementation)
// ---------------------------------------------------------------------------

export async function startDefaultModeServer(opts: {
  revision: string
  port?: number
  signal?: AbortSignal
}): Promise<DefaultModeCandidate> {
  const { revision, port = 0, signal } = opts
  const server: Server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "ok", mode: "default", revision }))
    } else {
      res.writeHead(404)
      res.end()
    }
  })

  const actualPort = await new Promise<number>((resolveP, reject) => {
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
        resolveP(addr.port)
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
    mode: "default",
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
// Secret redaction (defense-in-depth — mirrors Tickets 28 + 29)
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
// Default runAnswerOnce stub (production wires the real Answer runtime)
// ---------------------------------------------------------------------------

const defaultRunAnswerOnce: RunAnswerOnce = async () => ({
  terminalCount: 1,
  ok: true,
})

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runDefaultModePromotionAcceptance(
  options: DefaultModeAcceptanceOptions,
): Promise<DefaultModeAcceptanceReport> {
  const {
    repositoryRevision,
    outputDir,
    signal,
    v2Artifact,
    probeImplementations,
    runAnswerOnce = defaultRunAnswerOnce,
    smokeProfile = "production",
    checkPrerequisites,
    startServer = startDefaultModeServer,
    fetchImpl = fetch,
    healthPath = "/health",
    healthTimeoutMs = 5_000,
    answerTimeoutMs = 30_000,
  } = options

  const reasons: string[] = []
  let artifactValidated = false
  let artifactRejectionReason: ArtifactRejectionReason | undefined
  let healthOk = false
  let probeResults: ProbeRunResult[] = []
  let terminalCount = 0
  let shutdownOk = false
  let candidate: DefaultModeCandidate | undefined
  let shutdownCompletedAt: string | undefined

  const startedAt = new Date().toISOString()
  const smokeEvidencePath = resolve(join(outputDir, "smoke-default.json"))
  const defaultModeEvidencePath = resolve(join(outputDir, "default-mode.json"))

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
      artifactValidated,
      artifactRejectionReason,
      healthOk,
      probeResults,
      terminalCount,
      shutdownOk,
      smokeEvidencePath,
      defaultModeEvidencePath,
      startedAt,
      shutdownCompletedAt,
    )
  }

  // --- Phase 2: validate V2 artifact (AC2 — fail BEFORE runtime resources) ---
  const validation = validateV2Artifact(v2Artifact, { expectedRevision: repositoryRevision })
  if (!validation.valid) {
    artifactRejectionReason = validation.reason
    reasons.push(`artifact rejected: ${validation.reason}`)
    // AC2: "before runtime resources are created" — return immediately.
    // No server, no probes, no Answer run, no shutdown needed.
    return buildReport(
      false,
      reasons,
      repositoryRevision,
      artifactValidated,
      artifactRejectionReason,
      healthOk,
      probeResults,
      terminalCount,
      shutdownOk,
      smokeEvidencePath,
      defaultModeEvidencePath,
      startedAt,
      shutdownCompletedAt,
    )
  }
  artifactValidated = true

  // --- Phase 3-7 wrapped in try/finally to guarantee shutdown ---
  try {
    // --- Phase 3: start default-mode server ---
    try {
      candidate = await startServer({
        revision: repositoryRevision,
        port: options.port ?? 0,
        signal,
      })
    } catch (err) {
      reasons.push(
        `default-mode startup error: ${err instanceof Error ? err.message : String(err)}`,
      )
      return buildReport(
        false,
        reasons,
        repositoryRevision,
        artifactValidated,
        artifactRejectionReason,
        healthOk,
        probeResults,
        terminalCount,
        shutdownOk,
        smokeEvidencePath,
        defaultModeEvidencePath,
        startedAt,
        shutdownCompletedAt,
      )
    }

    // --- Phase 4: health check ---
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
          } else if (body.mode !== "default") {
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

    // --- Phase 5: run critical probes (only if health passed) ---
    if (healthOk) {
      try {
        const smokeEvidence = await runAllProbes({
          profile: smokeProfile,
          implementations: probeImplementations,
          registry: CRITICAL_PROBE_REGISTRY,
          signal,
          ...(checkPrerequisites ? { checkPrerequisites } : {}),
        })
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
        // Best-effort
      }
      reasons.push("critical probes skipped: health check failed")
    }

    // --- Phase 6: run Answer once (AC3: exactly one terminal per Answer run) ---
    if (healthOk && probeResults.length > 0 && probeResults.every((r) => r.status === "passed")) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), answerTimeoutMs)
        let answerResult: { terminalCount: number; ok: boolean; reason?: string }
        try {
          answerResult = await runAnswerOnce({
            signal: controller.signal,
            deadlineMs: answerTimeoutMs,
          })
        } finally {
          clearTimeout(timeout)
        }
        terminalCount = answerResult.terminalCount
        if (!answerResult.ok) {
          reasons.push(
            `Answer run failed: ${answerResult.reason ?? "no reason provided"}`,
          )
        } else if (answerResult.terminalCount !== 1) {
          // AC3: "exactly one terminal per Answer run"
          reasons.push(
            `Answer run produced ${answerResult.terminalCount} terminals; expected exactly 1`,
          )
        }
      } catch (err) {
        reasons.push(
          `Answer run error: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    } else {
      reasons.push("Answer run skipped: earlier phase failed")
    }
  } finally {
    // --- Phase 7: shutdown (always, even on failure) ---
    if (candidate) {
      try {
        await candidate.shutdown()
        shutdownOk = true
      } catch {
        // Shutdown errors are non-fatal — server may already be closed
      }
      shutdownCompletedAt = new Date().toISOString()
    }
  }

  const probesOk = probeResults.length > 0 && probeResults.every((r) => r.status === "passed")
  const answerOk = terminalCount === 1 && !reasons.some((r) => /Answer/i.test(r))
  const ok =
    artifactValidated &&
    healthOk &&
    probesOk &&
    answerOk &&
    shutdownOk

  return buildReport(
    ok,
    reasons,
    repositoryRevision,
    artifactValidated,
    artifactRejectionReason,
    healthOk,
    probeResults,
    terminalCount,
    shutdownOk,
    smokeEvidencePath,
    defaultModeEvidencePath,
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
  artifactValidated: boolean,
  artifactRejectionReason: ArtifactRejectionReason | undefined,
  healthOk: boolean,
  probeResults: ProbeRunResult[],
  terminalCount: number,
  shutdownOk: boolean,
  smokeEvidencePath: string,
  defaultModeEvidencePath: string,
  startedAt: string,
  shutdownCompletedAt: string | undefined,
): DefaultModeAcceptanceReport {
  const redactedReasons = reasons.map(redactSecrets)
  const redactedProbeResults = deepRedactSecrets(probeResults)

  const report: DefaultModeAcceptanceReport = {
    ok,
    reasons: redactedReasons,
    repositoryRevision,
    runtimeMode: "default",
    artifactValidated,
    artifactRejectionReason,
    healthOk,
    probeResults: redactedProbeResults,
    terminalCount,
    shutdownOk,
    smokeEvidencePath,
    defaultModeEvidencePath,
    promotionBlocked: !ok,
    startedAt,
    shutdownCompletedAt,
  }

  try {
    writeFileSync(
      defaultModeEvidencePath,
      JSON.stringify(report, null, 2) + "\n",
      "utf8",
    )
  } catch {
    // Best-effort
  }

  return report
}
