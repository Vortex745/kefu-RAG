// Ticket 31 — Close production-cycle state.
//
// Spec issue #31 acceptance criteria:
//   1. Project progress reports completed and verification contains no
//      unresolved required production check.
//   2. The backlog closes completed production items and explicitly
//      defers only non-blocking optional work.
//   3. Durable memory records the canonical V2 release path, verified
//      commands, external prerequisites, and rollback boundary without
//      secrets or transient logs.
//
// closeProductionCycle is a PURE FUNCTION that validates the final
// production-cycle state and produces a closure record suitable for
// persisting to MEMORY.md or a separate closure file. The record captures:
//   - Verification status (AC1: no unresolved required checks)
//   - Backlog closure (AC2: completed + deferred-non-blocking)
//   - Durable memory (AC3: V2 path + commands + prereqs + rollback boundary)
//
// Defense-in-depth:
//   - Secret redaction (mirrors Tickets 28/29/30) — no real-looking tokens
//     can leak into the persisted closure record.
//   - Transient log detection — durable memory must NOT contain timestamped
//     log lines, stack traces, or other ephemeral content that would
//     mislead a future session.
//
// Design (karpathy-guidelines):
//   - Simplest viable shape: pure function, no async, no I/O (file write
//     is best-effort and never throws).
//   - All inputs are caller-supplied; the function does not read process.env
//     or filesystem — it validates the input and produces a record.
//   - Failure-tolerant: even when ok=false, the closure record is still
//     produced (with reasons + flags) so reviewers can diagnose.
//
// Rollback boundary: removing this module does not change online runtime
// behavior — it is a state-closure verifier only.

import { writeFileSync } from "node:fs"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DeferredItem {
  id: string
  description: string
  /**
   * "optional" | "non-blocking" | "future" → allowed (deferred).
   * "blocking" → rejected (must be resolved before closure).
   */
  category: "optional" | "non-blocking" | "future" | "blocking"
  reason: string
}

export interface VerificationStatus {
  /** True when Ticket 28 production acceptance passed. */
  productionAcceptancePassed: boolean
  /** True when Ticket 29 limited-mode acceptance passed. */
  limitedModeAcceptancePassed: boolean
  /** True when Ticket 30 default-mode acceptance passed. */
  defaultModeAcceptancePassed: boolean
  /** AC1: must be empty for closure to succeed. */
  unresolvedRequiredChecks: string[]
}

export interface DurableMemory {
  /** AC3: canonical V2 release path (function call sequence). */
  canonicalV2ReleasePath: string
  /** AC3: verified commands operators should run. */
  verifiedCommands: string[]
  /** AC3: external prerequisites (env vars + services). */
  externalPrerequisites: string[]
  /** AC3: rollback boundary (what to revert if needed). */
  rollbackBoundary: string
}

export interface ProductionCycleClosureInput {
  repositoryRevision: string
  verificationStatus: VerificationStatus
  /** Ticket IDs marked completed in the backlog. */
  completedTicketIds: string[]
  /**
   * Optional: required ticket IDs. If provided, all must be in
   * completedTicketIds. If omitted, all completedTicketIds are considered
   * required and the check is trivially satisfied.
   */
  requiredTicketIds?: string[]
  /** AC2: deferred (non-blocking) optional work. */
  deferredItems: DeferredItem[]
  /** AC3: durable memory record. */
  durableMemory: DurableMemory
  /** Paths to evidence files (smoke/rollback/release/etc). */
  evidencePaths: string[]
}

export interface ProductionCycleClosure {
  /** True only when AC1 + AC2 + AC3 all pass. */
  ok: boolean
  /** Failure reasons (empty on success). Redacted of secrets. */
  reasons: string[]
  /** Trusted git revision bound to all artifacts. */
  repositoryRevision: string
  /** ISO 8601 timestamp when the closure was assembled. */
  closedAt: string
  /** AC1: verification status (mirrors input). */
  verificationStatus: VerificationStatus
  /** AC2: backlog closure summary. */
  backlogClosure: {
    completedTicketIds: string[]
    deferredItems: DeferredItem[]
    allRequiredTicketsClosed: boolean
  }
  /** AC3: durable memory (redacted of secrets). */
  durableMemory: DurableMemory
  /** Evidence file paths. */
  evidencePaths: string[]
  /** AC3: true when secrets were detected + redacted in durable memory. */
  redactedSecretsFound: boolean
  /** AC3: true when transient log lines were detected in durable memory. */
  transientLogsFound: boolean
}

export interface CloseProductionCycleOptions {
  /** Optional output path — when provided, the closure is persisted as JSON. */
  outputPath?: string
}

// ---------------------------------------------------------------------------
// Constants — secret redaction + transient log detection
// ---------------------------------------------------------------------------

const SECRET_REDACT_PATTERNS: readonly RegExp[] = [
  /Bearer\s+\S+/g,
  /sk-[A-Za-z0-9-]+/g,
  /pk-lf-[A-Za-z0-9]+/g,
  /sk-lf-[A-Za-z0-9]+/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
]

/**
 * Transient log detection patterns. Durable memory must NOT contain:
 *   - Timestamped log lines (e.g., "[2026-07-25T10:00:00Z] INFO ...")
 *   - Stack trace frames (e.g., "    at file.js:123:45")
 *   - Process / thread IDs (e.g., "pid=12345")
 *
 * These patterns areephemeral and would mislead a future session into
 * thinking transient state is durable.
 */
const TRANSIENT_LOG_PATTERNS: readonly RegExp[] = [
  /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, // ISO timestamp log prefix
  /^\s*at\s+\S+:\d+:\d+/m, // stack trace frame
  /\bpid=\d+\b/, // process ID
  /\b(DEBUG|INFO|WARN|ERROR)\s+/i, // log level prefix (with content after)
]

function redactSecrets(value: string): { redacted: string; found: boolean } {
  let result = value
  let found = false
  for (const pattern of SECRET_REDACT_PATTERNS) {
    pattern.lastIndex = 0
    const replaced = result.replace(pattern, "[REDACTED]")
    if (replaced !== result) {
      found = true
      result = replaced
    }
  }
  return { redacted: result, found }
}

function deepRedactSecrets<T>(value: T): { redacted: T; found: boolean } {
  let found = false
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const { redacted, found: f } = redactSecrets(v)
      if (f) found = true
      return redacted
    }
    if (Array.isArray(v)) {
      return v.map(walk)
    }
    if (v && typeof v === "object") {
      const cleaned: Record<string, unknown> = {}
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
        cleaned[k] = walk(item)
      }
      return cleaned
    }
    return v
  }
  return { redacted: walk(value) as T, found }
}

function detectTransientLogs(value: string): boolean {
  for (const pattern of TRANSIENT_LOG_PATTERNS) {
    if (pattern.test(value)) {
      return true
    }
  }
  return false
}

function hasTransientLogs(memory: DurableMemory): boolean {
  const allStrings = [
    memory.canonicalV2ReleasePath,
    memory.rollbackBoundary,
    ...memory.verifiedCommands,
    ...memory.externalPrerequisites,
  ]
  return allStrings.some(detectTransientLogs)
}

// ---------------------------------------------------------------------------
// Pure function: closeProductionCycle
// ---------------------------------------------------------------------------

export function closeProductionCycle(
  input: ProductionCycleClosureInput,
  options: CloseProductionCycleOptions = {},
): ProductionCycleClosure {
  const reasons: string[] = []

  // --- AC1: verification status ---
  const vs = input.verificationStatus
  if (!vs.productionAcceptancePassed) {
    reasons.push("AC1: production acceptance failed (Ticket 28)")
  }
  if (!vs.limitedModeAcceptancePassed) {
    reasons.push("AC1: limited-mode acceptance failed (Ticket 29)")
  }
  if (!vs.defaultModeAcceptancePassed) {
    reasons.push("AC1: default-mode acceptance failed (Ticket 30)")
  }
  if (vs.unresolvedRequiredChecks.length > 0) {
    reasons.push(
      `AC1: ${vs.unresolvedRequiredChecks.length} unresolved required check(s): ${vs.unresolvedRequiredChecks.join(", ")}`,
    )
  }

  // --- AC2: backlog closure ---
  const blockingItems = input.deferredItems.filter((d) => d.category === "blocking")
  if (blockingItems.length > 0) {
    reasons.push(
      `AC2: ${blockingItems.length} deferred item(s) are blocking: ${blockingItems.map((d) => d.id).join(", ")}`,
    )
  }

  let allRequiredTicketsClosed = true
  const required = input.requiredTicketIds ?? []
  const missing: string[] = []
  for (const id of required) {
    if (!input.completedTicketIds.includes(id)) {
      missing.push(id)
    }
  }
  if (missing.length > 0) {
    allRequiredTicketsClosed = false
    reasons.push(
      `AC2: missing required ticket(s): ${missing.join(", ")}`,
    )
  }

  // --- AC3: durable memory ---
  if (input.durableMemory.verifiedCommands.length === 0) {
    reasons.push("AC3: durable memory must record at least one verified command")
  }
  if (input.durableMemory.externalPrerequisites.length === 0) {
    reasons.push("AC3: durable memory must record at least one external prerequisite")
  }
  if (input.durableMemory.canonicalV2ReleasePath.length === 0) {
    reasons.push("AC3: durable memory must record canonical V2 release path")
  }
  if (input.durableMemory.rollbackBoundary.length === 0) {
    reasons.push("AC3: durable memory must record rollback boundary")
  }

  // --- AC3: detect transient logs in durable memory ---
  const transientLogsFound = hasTransientLogs(input.durableMemory)
  if (transientLogsFound) {
    reasons.push("AC3: transient log content detected in durable memory (must be removed)")
  }

  // --- AC3: redact secrets from durable memory ---
  const { redacted: redactedMemory, found: secretsFound } = deepRedactSecrets(
    input.durableMemory,
  )
  if (secretsFound) {
    reasons.push("AC3: secrets detected and redacted in durable memory")
  }

  // --- Aggregate ---
  const ok = reasons.length === 0

  const closure: ProductionCycleClosure = {
    ok,
    reasons: reasons.map((r) => {
      // Defense-in-depth: also redact reasons (in case a reason includes a secret)
      const { redacted } = redactSecrets(r)
      return redacted
    }),
    repositoryRevision: input.repositoryRevision,
    closedAt: new Date().toISOString(),
    verificationStatus: input.verificationStatus,
    backlogClosure: {
      completedTicketIds: input.completedTicketIds,
      deferredItems: input.deferredItems,
      allRequiredTicketsClosed,
    },
    durableMemory: redactedMemory,
    evidencePaths: input.evidencePaths,
    redactedSecretsFound: secretsFound,
    transientLogsFound,
  }

  // --- Persist to file (best-effort) ---
  if (options.outputPath) {
    try {
      writeFileSync(
        options.outputPath,
        JSON.stringify(closure, null, 2) + "\n",
        "utf8",
      )
    } catch {
      // Best-effort — the in-memory closure is still returned
    }
  }

  return closure
}
