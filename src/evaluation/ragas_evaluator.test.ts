// Ticket 14 — RAGAS offline process evaluator tests.
//
// Spec issue #14 criterion #7: "Fake-process tests verify request shape,
// parsing, bounds, timeout and error propagation without installing RAGAS
// in the normal unit-test environment."
//
// Design: tests inject `pythonExecutable: process.execPath` (Node) and a fake
// `runnerScript` (ragas-fake-runner.mjs) so the suite runs without Python or
// RAGAS installed. The fixture dispatches on RAGAS_FAKE_MODE to simulate
// every contract path: happy path, malformed output, timeout, overflow,
// evaluator failure, etc.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

import {
  RagasEvaluatorImpl,
  DEFAULT_RAGAS_TIMEOUT_MS,
  DEFAULT_RAGAS_MAX_OUTPUT_BYTES,
  DEFAULT_RAGAS_MAX_STDERR_BYTES,
} from "./ragas_evaluator"
import type { RagasRequest, RagasRuntimeConfig } from "./types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const here = __dirname
const FAKE_RUNNER_PATH = join(here, "test-fixtures", "ragas-fake-runner.mjs")
const EVALUATOR_SOURCE_PATH = join(here, "ragas_evaluator.ts")
const REQUIREMENTS_PATH = join(here, "ragas_requirements.txt")
const RUNNER_PY_PATH = join(here, "ragas_runner.py")

function makeConfig(mode: string, capturePath?: string): RagasRuntimeConfig {
  const env: Record<string, string> = { RAGAS_FAKE_MODE: mode }
  if (capturePath) env.RAGAS_FAKE_CAPTURE_PATH = capturePath
  return {
    pythonExecutable: process.execPath,
    runnerScript: FAKE_RUNNER_PATH,
    env,
  }
}

function makeRequest(caseId = "case-1"): RagasRequest {
  return {
    schemaVersion: 1,
    caseId,
    question: "How do I reset my password?",
    approvedAnswer: "Click 'Forgot Password' on the login page to receive a reset email.",
    retrievedContexts: ["Reset password flow: click Forgot Password", "Account recovery via email"],
    referenceAnswer: "Use the Forgot Password link on the login page.",
    evaluatorModelIdentities: {
      chat: "gpt-4-0613",
      embedding: "text-embedding-3-small",
      evaluator: "gpt-4-0613",
    },
  }
}

function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ragas-test-"))
  return fn(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true })
  })
}

// ---------------------------------------------------------------------------
// Criterion #7 meta: all tests use the fake runner (no RAGAS install required)
// ---------------------------------------------------------------------------

test("T14 #7: fake runner is invokable via process.execPath without RAGAS installed", () => {
  // Smoke-test the fixture itself — proves the test environment does not
  // require Python or RAGAS. If this fails, every other test fails too.
  const result = spawnSync(process.execPath, [FAKE_RUNNER_PATH], {
    input: JSON.stringify(makeRequest("fixture-smoke")),
    env: { ...process.env, RAGAS_FAKE_MODE: "ok" },
    encoding: "utf8",
    timeout: 5_000,
  })
  assert.equal(result.status, 0, `fixture exited non-zero: ${result.stderr}`)
  const response = JSON.parse(result.stdout)
  assert.equal(response.schemaVersion, 1)
  assert.equal(response.caseId, "fixture-smoke")
  assert.equal(response.status, "ok")
  assert.ok(Array.isArray(response.metrics))
  assert.ok(response.metrics.length > 0)
})

// ---------------------------------------------------------------------------
// Criterion #2: versioned bounded JSON request shape
// ---------------------------------------------------------------------------

test("T14 #2: evaluator sends versioned bounded JSON request with all required fields", async () => {
  await withTempDir(async (dir) => {
    const capturePath = join(dir, "request.json")
    const evaluator = new RagasEvaluatorImpl(makeConfig("echo-request", capturePath))
    const request = makeRequest("req-shape-1")
    await evaluator.evaluate(request)

    const captured = JSON.parse(readFileSync(capturePath, "utf8"))
    assert.equal(captured.schemaVersion, 1)
    assert.equal(captured.caseId, "req-shape-1")
    assert.equal(captured.question, request.question)
    assert.equal(captured.approvedAnswer, request.approvedAnswer)
    assert.deepEqual(captured.retrievedContexts, request.retrievedContexts)
    assert.equal(captured.referenceAnswer, request.referenceAnswer)
    assert.deepEqual(captured.evaluatorModelIdentities, request.evaluatorModelIdentities)
  })
})

test("T14 #2: request includes evaluatorModelIdentities with chat, embedding and evaluator", async () => {
  await withTempDir(async (dir) => {
    const capturePath = join(dir, "req-identities.json")
    const evaluator = new RagasEvaluatorImpl(makeConfig("echo-request", capturePath))
    await evaluator.evaluate(makeRequest("ident-1"))
    const captured = JSON.parse(readFileSync(capturePath, "utf8"))
    assert.equal(typeof captured.evaluatorModelIdentities.chat, "string")
    assert.equal(typeof captured.evaluatorModelIdentities.embedding, "string")
    assert.equal(typeof captured.evaluatorModelIdentities.evaluator, "string")
  })
})

// ---------------------------------------------------------------------------
// Criterion #3: versioned JSON response parsing
// ---------------------------------------------------------------------------

test("T14 #3: parses ok response with four metrics and overrides durationMs with wall-clock", async () => {
  const evaluator = new RagasEvaluatorImpl(makeConfig("ok"))
  const response = await evaluator.evaluate(makeRequest("happy-1"))
  assert.equal(response.schemaVersion, 1)
  assert.equal(response.caseId, "happy-1")
  assert.equal(response.status, "ok")
  assert.ok(Array.isArray(response.metrics))
  assert.equal(response.metrics!.length, 4)
  const names = response.metrics!.map((m) => m.name)
  assert.deepEqual(names.sort(), ["answer_relevancy", "context_precision", "context_recall", "faithfulness"])
  assert.equal(response.metrics![0].name, "faithfulness")
  assert.equal(response.metrics![0].score, 0.95)
  const relevancy = response.metrics!.find((m) => m.name === "answer_relevancy")!
  assert.equal(relevancy.rationale, "highly relevant")
  assert.equal(typeof response.durationMs, "number")
  assert.ok(response.durationMs >= 0)
})

test("T14 #3: parses ok response with empty metrics array", async () => {
  const evaluator = new RagasEvaluatorImpl(makeConfig("ok-empty-metrics"))
  const response = await evaluator.evaluate(makeRequest("empty-1"))
  assert.equal(response.status, "ok")
  assert.deepEqual(response.metrics, [])
})

test("T14 #3: parses valid error response with error.kind and error.message", async () => {
  const evaluator = new RagasEvaluatorImpl(makeConfig("ok-error-status-with-fields"))
  const response = await evaluator.evaluate(makeRequest("err-fields-1"))
  assert.equal(response.status, "error")
  assert.equal(response.error!.kind, "evaluator_failure")
  assert.equal(response.error!.message, "simulated RAGAS internal error")
})

test("T14 #3: extracts JSON from stdout with log lines before it (extractLastJsonLine)", async () => {
  const evaluator = new RagasEvaluatorImpl(makeConfig("extra-stdout-before-json"))
  const response = await evaluator.evaluate(makeRequest("log-lines-1"))
  assert.equal(response.status, "ok")
  assert.equal(response.metrics!.length, 1)
  assert.equal(response.metrics![0].name, "faithfulness")
  assert.equal(response.metrics![0].score, 0.9)
})

// ---------------------------------------------------------------------------
// Criterion #4: bounded input, output, timeout, stderr, no shell
// ---------------------------------------------------------------------------

test("T14 #4: bounded stdout — kills when output exceeds maxOutputBytes", async () => {
  const evaluator = new RagasEvaluatorImpl(makeConfig("stdout-overflow"))
  const response = await evaluator.evaluate(makeRequest("overflow-1"), {
    maxOutputBytes: 1_000_000,
  })
  assert.equal(response.status, "error")
  assert.equal(response.error!.kind, "malformed_output")
  assert.match(response.error!.message, /stdout exceeded/)
})

test("T14 #4: bounded stderr — kills when stderr exceeds maxStderrBytes", async () => {
  const evaluator = new RagasEvaluatorImpl(makeConfig("stderr-overflow"))
  const response = await evaluator.evaluate(makeRequest("stderr-overflow-1"), {
    maxStderrBytes: 100_000,
  })
  assert.equal(response.status, "error")
  assert.equal(response.error!.kind, "evaluator_failure")
  assert.match(response.error!.message, /stderr exceeded/)
})

test("T14 #4: bounded timeout — kills at timeoutMs and classifies as timeout", async () => {
  const evaluator = new RagasEvaluatorImpl(makeConfig("timeout"))
  const start = Date.now()
  const response = await evaluator.evaluate(makeRequest("timeout-1"), {
    timeoutMs: 150,
  })
  const elapsed = Date.now() - start
  assert.equal(response.status, "error")
  assert.equal(response.error!.kind, "timeout")
  // Should return well before the fixture's 30s sleep.
  assert.ok(elapsed < 2_000, `elapsed=${elapsed}ms should be < 2000ms`)
})

test("T14 #4: default timeout constant is exported and bounded", () => {
  assert.equal(DEFAULT_RAGAS_TIMEOUT_MS, 30_000)
  assert.ok(DEFAULT_RAGAS_TIMEOUT_MS > 0)
  assert.ok(DEFAULT_RAGAS_TIMEOUT_MS < 120_000, "default timeout must be bounded < 120s")
})

test("T14 #4: default max output/stderr byte constants are exported and bounded", () => {
  assert.equal(DEFAULT_RAGAS_MAX_OUTPUT_BYTES, 1_000_000)
  assert.equal(DEFAULT_RAGAS_MAX_STDERR_BYTES, 100_000)
  assert.ok(DEFAULT_RAGAS_MAX_OUTPUT_BYTES > 0)
  assert.ok(DEFAULT_RAGAS_MAX_STDERR_BYTES > 0)
  assert.ok(
    DEFAULT_RAGAS_MAX_STDERR_BYTES < DEFAULT_RAGAS_MAX_OUTPUT_BYTES,
    "stderr bound should be smaller than stdout bound",
  )
})

test("T14 #4: no shell — source spawns with shell:false (no shell injection surface)", () => {
  const source = readFileSync(EVALUATOR_SOURCE_PATH, "utf8")
  assert.match(source, /shell:\s*false/, "RagasEvaluatorImpl must spawn with shell:false")
  assert.doesNotMatch(source, /shell:\s*true/, "RagasEvaluatorImpl must NOT spawn with shell:true")
})

// ---------------------------------------------------------------------------
// Criterion #5: error handling — malformed/timeout/missing-runtime/failure
// ---------------------------------------------------------------------------

test("T14 #5: malformed non-JSON stdout → malformed_output", async () => {
  const evaluator = new RagasEvaluatorImpl(makeConfig("malformed-nonjson"))
  const response = await evaluator.evaluate(makeRequest("malformed-1"))
  assert.equal(response.status, "error")
  assert.equal(response.error!.kind, "malformed_output")
})

test("T14 #5: malformed response missing required fields → malformed_output", async () => {
  const evaluator = new RagasEvaluatorImpl(makeConfig("malformed-missing-fields"))
  const response = await evaluator.evaluate(makeRequest("malformed-2"))
  assert.equal(response.status, "error")
  assert.equal(response.error!.kind, "malformed_output")
  assert.match(response.error!.message, /schemaVersion|caseId|durationMs/)
})

test("T14 #5: malformed response with wrong caseId → malformed_output", async () => {
  const evaluator = new RagasEvaluatorImpl(makeConfig("malformed-wrong-caseid"))
  const response = await evaluator.evaluate(makeRequest("malformed-3"))
  assert.equal(response.status, "error")
  assert.equal(response.error!.kind, "malformed_output")
  assert.match(response.error!.message, /caseId mismatch/)
})

test("T14 #5: malformed response with wrong schemaVersion → malformed_output", async () => {
  const evaluator = new RagasEvaluatorImpl(makeConfig("malformed-wrong-schema"))
  const response = await evaluator.evaluate(makeRequest("malformed-4"))
  assert.equal(response.status, "error")
  assert.equal(response.error!.kind, "malformed_output")
  assert.match(response.error!.message, /schemaVersion/)
})

test("T14 #5: malformed metric with score out of [0,1] range → malformed_output", async () => {
  const evaluator = new RagasEvaluatorImpl(makeConfig("malformed-score-out-of-range"))
  const response = await evaluator.evaluate(makeRequest("malformed-5"))
  assert.equal(response.status, "error")
  assert.equal(response.error!.kind, "malformed_output")
  assert.match(response.error!.message, /score/)
})

test("T14 #5: malformed metric without name → malformed_output", async () => {
  const evaluator = new RagasEvaluatorImpl(makeConfig("malformed-metric-no-name"))
  const response = await evaluator.evaluate(makeRequest("malformed-6"))
  assert.equal(response.status, "error")
  assert.equal(response.error!.kind, "malformed_output")
  assert.match(response.error!.message, /name/)
})

test("T14 #5: status=error response without error object → malformed_output", async () => {
  const evaluator = new RagasEvaluatorImpl(makeConfig("malformed-status-error-no-error-obj"))
  const response = await evaluator.evaluate(makeRequest("malformed-7"))
  assert.equal(response.status, "error")
  assert.equal(response.error!.kind, "malformed_output")
  assert.match(response.error!.message, /error object/)
})

test("T14 #5: invalid status value → malformed_output", async () => {
  const evaluator = new RagasEvaluatorImpl(makeConfig("malformed-status-invalid"))
  const response = await evaluator.evaluate(makeRequest("malformed-8"))
  assert.equal(response.status, "error")
  assert.equal(response.error!.kind, "malformed_output")
  assert.match(response.error!.message, /status/)
})

test("T14 #5: missing runtime (ENOENT) → missing_runtime kind", async () => {
  const config: RagasRuntimeConfig = {
    pythonExecutable: "/definitely/not/a/real/python/path",
    runnerScript: FAKE_RUNNER_PATH,
  }
  const evaluator = new RagasEvaluatorImpl(config)
  const response = await evaluator.evaluate(makeRequest("missing-runtime-1"))
  assert.equal(response.status, "error")
  assert.equal(response.error!.kind, "missing_runtime")
  assert.ok(response.error!.message.length > 0)
})

test("T14 #5: evaluator failure (non-zero exit) → evaluator_failure with stderr snippet", async () => {
  const evaluator = new RagasEvaluatorImpl(makeConfig("evaluator-failure"))
  const response = await evaluator.evaluate(makeRequest("eval-fail-1"))
  assert.equal(response.status, "error")
  assert.equal(response.error!.kind, "evaluator_failure")
  assert.match(response.error!.message, /code 1/)
  assert.match(response.error!.message, /simulated RAGAS failure/)
})

test("T14 #5: every error response preserves schemaVersion=1 and the original caseId", async () => {
  const evaluator = new RagasEvaluatorImpl(makeConfig("malformed-nonjson"))
  const response = await evaluator.evaluate(makeRequest("preserve-case-1"))
  assert.equal(response.schemaVersion, 1)
  assert.equal(response.caseId, "preserve-case-1")
  assert.equal(response.status, "error")
  assert.equal(typeof response.durationMs, "number")
  assert.ok(response.durationMs >= 0)
})

// ---------------------------------------------------------------------------
// Criterion #6: online chat runtime does NOT import/spawn/depend on RAGAS
// ---------------------------------------------------------------------------

test("T14 #6: src/answer/ does not import ragas_evaluator", () => {
  const answerDir = join(here, "..", "answer")
  const answerSource = readFileSync(join(answerDir, "runtime.ts"), "utf8")
  assert.equal(
    /ragas_evaluator/.test(answerSource),
    false,
    "src/answer/runtime.ts must not import ragas_evaluator",
  )
})

test("T14 #6: src/answer/ does not import the RAGAS runner script", () => {
  const answerDir = join(here, "..", "answer")
  const answerSource = readFileSync(join(answerDir, "runtime.ts"), "utf8")
  assert.equal(
    /ragas_runner/.test(answerSource),
    false,
    "src/answer/runtime.ts must not reference ragas_runner",
  )
})

test("T14 #6: src/answer/ does not spawn a Python process for RAGAS", () => {
  const answerDir = join(here, "..", "answer")
  const answerSource = readFileSync(join(answerDir, "runtime.ts"), "utf8")
  assert.equal(
    /RagasEvaluator/.test(answerSource),
    false,
    "src/answer/runtime.ts must not reference RagasEvaluator",
  )
})

// ---------------------------------------------------------------------------
// Criterion #1: pinned Python/RAGAS dependency versions
// ---------------------------------------------------------------------------

test("T14 #1: ragas_requirements.txt exists and pins all dependency versions", () => {
  const content = readFileSync(REQUIREMENTS_PATH, "utf8")
  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
  assert.ok(lines.length >= 5, "requirements must pin at least 5 packages")
  for (const line of lines) {
    assert.match(
      line,
      /^[\w-]+==[\d.]+/,
      `dependency "${line}" must be pinned with ==VERSION`,
    )
  }
  const packageNames = lines.map((l) => l.split("==")[0])
  assert.ok(packageNames.includes("ragas"), "requirements must pin ragas")
  assert.ok(packageNames.includes("langchain"), "requirements must pin langchain")
  assert.ok(packageNames.includes("langchain-openai"), "requirements must pin langchain-openai")
  assert.ok(packageNames.includes("numpy"), "requirements must pin numpy")
  assert.ok(packageNames.includes("pandas"), "requirements must pin pandas")
})

test("T14 #1: ragas_runner.py exists and documents the versioned contract", () => {
  const content = readFileSync(RUNNER_PY_PATH, "utf8")
  assert.match(content, /schemaVersion/, "runner must reference schemaVersion")
  assert.match(content, /SCHEMA_VERSION\s*=\s*1/, "runner must pin SCHEMA_VERSION=1")
  assert.match(content, /missing_runtime/, "runner must emit missing_runtime error kind")
  assert.match(content, /evaluator_failure/, "runner must emit evaluator_failure error kind")
})

// ---------------------------------------------------------------------------
// Abort signal handling (criterion #4 + #5 — caller cancellation)
// ---------------------------------------------------------------------------

test("T14 abort: caller abort signal mid-execution → timeout error response", async () => {
  const evaluator = new RagasEvaluatorImpl(makeConfig("timeout"))
  const controller = new AbortController()
  const promise = evaluator.evaluate(makeRequest("abort-1"), {
    timeoutMs: 5_000,
    signal: controller.signal,
  })
  // Abort after 100ms — well before the 30s fixture sleep.
  setTimeout(() => controller.abort(), 100)
  const response = await promise
  assert.equal(response.status, "error")
  assert.equal(response.error!.kind, "timeout")
  assert.equal(response.error!.message, "aborted before completion")
})

test("T14 abort: already-aborted signal → immediate response without spawning", async () => {
  const evaluator = new RagasEvaluatorImpl(makeConfig("ok"))
  const controller = new AbortController()
  controller.abort()
  const start = Date.now()
  const response = await evaluator.evaluate(makeRequest("pre-abort-1"), {
    signal: controller.signal,
  })
  const elapsed = Date.now() - start
  assert.equal(response.status, "error")
  assert.equal(response.error!.kind, "timeout")
  assert.equal(response.error!.message, "aborted before completion")
  assert.ok(elapsed < 50, `elapsed=${elapsed}ms should be < 50ms (no spawn)`)
})

// ---------------------------------------------------------------------------
// Wrapper never throws — all failures surface as RagasResponse
// ---------------------------------------------------------------------------

test("T14 #5: evaluator never throws — every failure path returns a RagasResponse", async () => {
  // Exercise multiple failure paths and confirm none of them reject.
  const evaluator = new RagasEvaluatorImpl(makeConfig("malformed-nonjson"))
  const responses = await Promise.all([
    evaluator.evaluate(makeRequest("no-throw-1")),
    new RagasEvaluatorImpl(makeConfig("evaluator-failure")).evaluate(makeRequest("no-throw-2")),
    new RagasEvaluatorImpl({
      pythonExecutable: "/nonexistent/path",
      runnerScript: FAKE_RUNNER_PATH,
    }).evaluate(makeRequest("no-throw-3")),
  ])
  for (const r of responses) {
    assert.equal(r.status, "error")
    assert.equal(r.schemaVersion, 1)
    assert.ok(r.error && r.error.kind.length > 0)
    assert.ok(r.error && r.error.message.length > 0)
  }
})