// Ticket 14 — Fake RAGAS runner for RagasEvaluatorImpl tests.
//
// Spec issue #14 criterion #7: "Fake-process tests verify request shape,
// parsing, bounds, timeout and error propagation without installing RAGAS
// in the normal unit-test environment."
//
// This fixture is a Node ES module that mimics the Python RAGAS runner
// contract: read a versioned JSON request from stdin, dispatch on
// RAGAS_FAKE_MODE env var, write a versioned JSON response to stdout.
// The test suite spawns `node ragas-fake-runner.mjs` via RagasEvaluatorImpl
// with pythonExecutable=process.execPath — no Python or RAGAS install
// required.

import { writeFileSync } from "node:fs"

const mode = process.env.RAGAS_FAKE_MODE ?? "ok"
const capturePath = process.env.RAGAS_FAKE_CAPTURE_PATH

const chunks = []
process.stdin.on("data", (c) => chunks.push(c))
process.stdin.on("end", () => {
  const stdin = Buffer.concat(chunks).toString("utf8")

  // Capture the received stdin for request-shape verification (criterion #2).
  if (capturePath) {
    writeFileSync(capturePath, stdin)
  }

  let request
  try {
    request = JSON.parse(stdin)
  } catch {
    process.stderr.write("fake-runner: stdin is not valid JSON\n")
    process.exit(1)
  }

  const durationMs = 42

  switch (mode) {
    case "ok":
      writeJson({
        schemaVersion: 1,
        caseId: request.caseId,
        status: "ok",
        metrics: [
          { name: "faithfulness", score: 0.95 },
          { name: "answer_relevancy", score: 0.88, rationale: "highly relevant" },
          { name: "context_precision", score: 0.91 },
          { name: "context_recall", score: 0.83 },
        ],
        durationMs,
      })
      break

    case "ok-empty-metrics":
      writeJson({
        schemaVersion: 1,
        caseId: request.caseId,
        status: "ok",
        metrics: [],
        durationMs,
      })
      break

    case "ok-error-status-with-fields":
      // Valid error response — exercises the status="error" success path
      writeJson({
        schemaVersion: 1,
        caseId: request.caseId,
        status: "error",
        durationMs,
        error: { kind: "evaluator_failure", message: "simulated RAGAS internal error" },
      })
      break

    case "malformed-nonjson":
      process.stdout.write("this is not json {{")
      process.exit(0)
      break

    case "malformed-missing-fields":
      // Missing schemaVersion + caseId + durationMs
      process.stdout.write(JSON.stringify({ status: "ok", metrics: [] }))
      process.exit(0)
      break

    case "malformed-wrong-caseid":
      writeJson({
        schemaVersion: 1,
        caseId: "wrong-case-id",
        status: "ok",
        metrics: [],
        durationMs,
      })
      break

    case "malformed-wrong-schema":
      writeJson({
        schemaVersion: 2,
        caseId: request.caseId,
        status: "ok",
        metrics: [],
        durationMs,
      })
      break

    case "malformed-score-out-of-range":
      writeJson({
        schemaVersion: 1,
        caseId: request.caseId,
        status: "ok",
        metrics: [{ name: "faithfulness", score: 1.5 }],
        durationMs,
      })
      break

    case "malformed-metric-no-name":
      writeJson({
        schemaVersion: 1,
        caseId: request.caseId,
        status: "ok",
        metrics: [{ score: 0.5 }],
        durationMs,
      })
      break

    case "malformed-status-error-no-error-obj":
      writeJson({
        schemaVersion: 1,
        caseId: request.caseId,
        status: "error",
        metrics: [],
        durationMs,
      })
      break

    case "malformed-status-invalid":
      writeJson({
        schemaVersion: 1,
        caseId: request.caseId,
        status: "pending",
        metrics: [],
        durationMs,
      })
      break

    case "timeout":
      // Sleep longer than any reasonable test timeout. The wrapper should
      // SIGKILL before this resolves.
      setTimeout(() => {
        writeJson({
          schemaVersion: 1,
          caseId: request.caseId,
          status: "ok",
          metrics: [],
          durationMs,
        })
      }, 30_000)
      break

    case "evaluator-failure":
      process.stderr.write("fake-runner: simulated RAGAS failure\n")
      process.exit(1)
      break

    case "stdout-overflow":
      // Write >1MB of garbage to stdout. The wrapper should kill on overflow.
      process.stdout.write("x".repeat(2_000_000))
      process.exit(0)
      break

    case "stderr-overflow":
      // Write >100KB to stderr. The wrapper should kill on overflow.
      process.stderr.write("x".repeat(200_000))
      process.exit(1)
      break

    case "extra-stdout-before-json":
      // Write log lines before the JSON — exercises extractLastJsonLine.
      process.stdout.write("INFO starting ragas\nINFO evaluating case\n")
      writeJson({
        schemaVersion: 1,
        caseId: request.caseId,
        status: "ok",
        metrics: [{ name: "faithfulness", score: 0.9 }],
        durationMs,
      })
      break

    case "echo-request":
      // Return a valid response; the test verifies request shape via capturePath.
      writeJson({
        schemaVersion: 1,
        caseId: request.caseId,
        status: "ok",
        metrics: [{ name: "faithfulness", score: 0.9 }],
        durationMs,
      })
      break

    default:
      process.stderr.write(`fake-runner: unknown mode "${mode}"\n`)
      process.exit(1)
  }
})

function writeJson(obj) {
  process.stdout.write(JSON.stringify(obj))
  process.exit(0)
}