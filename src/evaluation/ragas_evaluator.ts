// Ticket 14 — RAGAS offline process evaluator.
//
// Spec issue #14 criteria:
//   2. TypeScript sends a versioned bounded JSON request containing question,
//      approved answer, retrieved contexts, reference answer and evaluator
//      model identities.
//   3. The Python evaluator returns a versioned JSON result with metric values,
//      duration and safe error information.
//   4. Process execution uses bounded input, output, timeout and stderr
//      handling and does not invoke a shell.
//   5. Malformed output, timeout, missing runtime and evaluator failure
//      produce explicit skipped or failed outcomes according to evaluation
//      profile.
//   6. The online chat runtime does not import, spawn or depend on the RAGAS
//      evaluator.
//   7. Fake-process tests verify request shape, parsing, bounds, timeout and
//      error propagation without installing RAGAS in the normal unit-test
//      environment.
//
// Design: `RagasEvaluatorImpl` spawns the configured `pythonExecutable` with
// the `runnerScript` as its first argument, NO shell (`shell: false`). It
// writes the serialized `RagasRequest` as a single JSON line to stdin, then
// collects stdout/stderr under byte bounds, enforces a wall-clock timeout,
// and parses the final stdout line as a `RagasResponse`. The wrapper never
// throws — every failure path produces a `RagasResponse` with `status: "error"`
// and a machine-readable `error.kind`.
//
// Testability: tests inject `pythonExecutable: process.execPath` (Node) and a
// fake `runnerScript` (a `.mjs` that mimics the Python contract) so the test
// suite runs without Python or RAGAS installed (criterion #7).

import { spawn } from "node:child_process"
import type {
  RagasEvaluator,
  RagasEvaluateOptions,
  RagasRequest,
  RagasResponse,
  RagasRuntimeConfig,
} from "./types"

/** Default bounded timeout (criterion #4). 30s is generous for one RAGAS case. */
export const DEFAULT_RAGAS_TIMEOUT_MS = 30_000

/** Default bounded max stdout bytes (criterion #4). ~1MB is plenty for one JSON response. */
export const DEFAULT_RAGAS_MAX_OUTPUT_BYTES = 1_000_000

/** Default bounded max stderr bytes (criterion #4). ~100KB is enough for a stack trace. */
export const DEFAULT_RAGAS_MAX_STDERR_BYTES = 100_000

/**
 * Ticket 14 (criterion #6): the RAGAS evaluator runs as a bounded subprocess
 * and does NOT touch the online chat runtime. The online Answer path remains
 * independent of Python — this class lives in `src/evaluation/` and is only
 * invoked from the offline evaluation runner.
 */
export class RagasEvaluatorImpl implements RagasEvaluator {
  constructor(private readonly config: RagasRuntimeConfig) {}

  async evaluate(
    request: RagasRequest,
    options: RagasEvaluateOptions = {},
  ): Promise<RagasResponse> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_RAGAS_TIMEOUT_MS
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_RAGAS_MAX_OUTPUT_BYTES
    const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_RAGAS_MAX_STDERR_BYTES
    const signal = options.signal

    // If the caller already aborted, return immediately without spawning.
    if (signal?.aborted) {
      return abortedResponse(request.caseId)
    }

    return new Promise<RagasResponse>((resolve) => {
      const startedAt = Date.now()
      let stdoutBytes = 0
      let stderrBytes = 0
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let settled = false
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined

      const finish = (response: RagasResponse) => {
        if (settled) return
        settled = true
        if (timeoutHandle) clearTimeout(timeoutHandle)
        if (signal && onAbort) signal.removeEventListener("abort", onAbort)
        child.kill("SIGKILL")
        resolve(response)
      }

      const buildErrorResponse = (
        kind: "timeout" | "malformed_output" | "evaluator_failure" | "unknown",
        message: string,
      ): RagasResponse => ({
        schemaVersion: 1,
        caseId: request.caseId,
        status: "error",
        durationMs: Date.now() - startedAt,
        error: { kind, message },
      })

      // Criterion #4: spawn WITHOUT a shell. The first arg is the executable,
      // the rest are argv. No shell injection surface.
      const child = spawn(
        this.config.pythonExecutable,
        [this.config.runnerScript],
        {
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, ...this.config.env },
        },
      )

      child.on("error", (err) => {
        // spawn() itself failed — most likely ENOENT (missing runtime).
        // Criterion #5: missing runtime produces an explicit error outcome.
        const message = err.message
        const errnoErr = err as NodeJS.ErrnoException
        const kind: "missing_runtime" | "unknown" =
          errnoErr.code === "ENOENT" ? "missing_runtime" : "unknown"
        finish({
          schemaVersion: 1,
          caseId: request.caseId,
          status: "error",
          durationMs: Date.now() - startedAt,
          error: { kind, message },
        })
      })

      child.stdout!.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length
        // Criterion #4: bounded output — kill on overflow.
        if (stdoutBytes > maxOutputBytes) {
          finish(
            buildErrorResponse(
              "malformed_output",
              `stdout exceeded ${maxOutputBytes} bytes (got ${stdoutBytes})`,
            ),
          )
          return
        }
        stdoutChunks.push(chunk)
      })

      child.stderr!.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length
        // Criterion #4: bounded stderr — kill on overflow.
        if (stderrBytes > maxStderrBytes) {
          finish(
            buildErrorResponse(
              "evaluator_failure",
              `stderr exceeded ${maxStderrBytes} bytes (got ${stderrBytes})`,
            ),
          )
          return
        }
        stderrChunks.push(chunk)
      })

      child.on("close", (code, signalTerm) => {
        if (settled) return
        const durationMs = Date.now() - startedAt
        const stdout = Buffer.concat(stdoutChunks).toString("utf8")
        const stderr = Buffer.concat(stderrChunks).toString("utf8")

        // If aborted while running, surface as a cancellation-flavored timeout.
        if (signal?.aborted) {
          finish(abortedResponse(request.caseId, durationMs))
          return
        }

        // If killed by a signal (e.g. SIGKILL from timeout), treat as timeout
        // when we triggered it; otherwise treat as evaluator_failure.
        if (signalTerm) {
          const kind: "timeout" | "evaluator_failure" =
            signalTerm === "SIGKILL" && timeoutHandle === undefined ? "timeout" : "evaluator_failure"
          finish({
            schemaVersion: 1,
            caseId: request.caseId,
            status: "error",
            durationMs,
            error: {
              kind,
              message: `process terminated by signal ${signalTerm}`,
            },
          })
          return
        }

        // Non-zero exit — evaluator failure. Include a truncated, safe stderr
        // snippet (no secrets — RAGAS stderr is its own trace, not user data).
        if (code !== 0) {
          const stderrSnippet = truncate(stderr, 500)
          finish({
            schemaVersion: 1,
            caseId: request.caseId,
            status: "error",
            durationMs,
            error: {
              kind: "evaluator_failure",
              message: `process exited with code ${code}${stderrSnippet ? `: ${stderrSnippet}` : ""}`,
            },
          })
          return
        }

        // Parse the final stdout line as a RagasResponse. Criterion #5:
        // malformed output produces an explicit error outcome.
        const lastLine = extractLastJsonLine(stdout)
        if (!lastLine) {
          finish({
            schemaVersion: 1,
            caseId: request.caseId,
            status: "error",
            durationMs,
            error: {
              kind: "malformed_output",
              message: `stdout did not contain a JSON line (got ${stdout.length} bytes)`,
            },
          })
          return
        }

        let parsed: unknown
        try {
          parsed = JSON.parse(lastLine)
        } catch (err) {
          finish({
            schemaVersion: 1,
            caseId: request.caseId,
            status: "error",
            durationMs,
            error: {
              kind: "malformed_output",
              message: `stdout JSON parse failed: ${(err as Error).message}`,
            },
          })
          return
        }

        const validation = validateRagasResponse(parsed, request.caseId)
        if (!validation.ok) {
          finish({
            schemaVersion: 1,
            caseId: request.caseId,
            status: "error",
            durationMs,
            error: {
              kind: "malformed_output",
              message: validation.message,
            },
          })
          return
        }

        // Success — surface the parsed response but override durationMs with
        // the wrapper's wall-clock measurement (more reliable than the script's
        // self-report).
        finish({ ...validation.value, durationMs })
      })

      // Criterion #4: bounded timeout. Wall-clock kill at timeoutMs.
      timeoutHandle = setTimeout(() => {
        timeoutHandle = undefined
        // The close handler will see SIGKILL and classify as timeout.
        child.kill("SIGKILL")
      }, timeoutMs)

      // Criterion #4: respect caller abort signal.
      if (signal) {
        onAbort = () => {
          child.kill("SIGKILL")
        }
        signal.addEventListener("abort", onAbort, { once: true })
      }

      // Criterion #2: write the versioned bounded JSON request to stdin.
      // Errors on stdin (e.g. EPIPE if the child exited early) are ignored —
      // the close handler will classify the exit.
      try {
        child.stdin!.write(JSON.stringify(request))
        child.stdin!.end()
      } catch {
        // stdin write failed — the close handler will surface the failure.
      }
    })
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `... (${s.length - max} more bytes truncated)`
}

/**
 * Extract the last JSON-looking line from stdout. The Python runner may emit
 * logging on earlier lines (we redirect stderr, but be defensive) — only the
 * final line must be the JSON response.
 */
function extractLastJsonLine(stdout: string): string | undefined {
  const trimmed = stdout.trimEnd()
  if (trimmed.length === 0) return undefined
  const lastNewline = trimmed.lastIndexOf("\n")
  const lastLine = lastNewline === -1 ? trimmed : trimmed.slice(lastNewline + 1)
  if (!lastLine.startsWith("{")) return undefined
  return lastLine
}

type ValidationResult =
  | { ok: true; value: RagasResponse }
  | { ok: false; message: string }

/**
 * Validate that `parsed` is a well-formed RagasResponse for `expectedCaseId`.
 * Criterion #5: malformed output (wrong shape, wrong caseId, wrong schema
 * version) produces an explicit error outcome.
 */
function validateRagasResponse(parsed: unknown, expectedCaseId: string): ValidationResult {
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, message: "response is not an object" }
  }
  const obj = parsed as Record<string, unknown>
  if (obj.schemaVersion !== 1) {
    return { ok: false, message: `schemaVersion !== 1 (got ${String(obj.schemaVersion)})` }
  }
  if (obj.caseId !== expectedCaseId) {
    return {
      ok: false,
      message: `caseId mismatch (expected ${expectedCaseId}, got ${String(obj.caseId)})`,
    }
  }
  if (obj.status !== "ok" && obj.status !== "error") {
    return {
      ok: false,
      message: `status must be "ok" or "error" (got ${String(obj.status)})`,
    }
  }
  if (typeof obj.durationMs !== "number" || obj.durationMs < 0) {
    return {
      ok: false,
      message: `durationMs must be a non-negative number (got ${String(obj.durationMs)})`,
    }
  }
  if (obj.status === "ok") {
    if (!Array.isArray(obj.metrics)) {
      return { ok: false, message: 'status="ok" requires a metrics array' }
    }
    for (const m of obj.metrics) {
      const mr = validateMetric(m)
      if (!mr.ok) return mr
    }
  } else {
    if (typeof obj.error !== "object" || obj.error === null) {
      return { ok: false, message: 'status="error" requires an error object' }
    }
    const err = obj.error as Record<string, unknown>
    if (typeof err.kind !== "string" || typeof err.message !== "string") {
      return { ok: false, message: "error.kind and error.message must be strings" }
    }
  }
  return { ok: true, value: obj as unknown as RagasResponse }
}

type MetricValidationResult = { ok: true } | { ok: false; message: string }

function validateMetric(m: unknown): MetricValidationResult {
  if (typeof m !== "object" || m === null) {
    return { ok: false, message: "metric is not an object" }
  }
  const mr = m as Record<string, unknown>
  if (typeof mr.name !== "string" || mr.name.length === 0) {
    return { ok: false, message: "metric.name must be a non-empty string" }
  }
  if (typeof mr.score !== "number" || mr.score < 0 || mr.score > 1) {
    return {
      ok: false,
      message: `metric.score must be in [0,1] (got ${String(mr.score)})`,
    }
  }
  return { ok: true }
}

function abortedResponse(caseId: string, durationMs = 0): RagasResponse {
  return {
    schemaVersion: 1,
    caseId,
    status: "error",
    durationMs,
    error: { kind: "timeout", message: "aborted before completion" },
  }
}