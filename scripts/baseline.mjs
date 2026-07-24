/**
 * P1.1 baseline — reproducible Agentic RAG validation baseline.
 *
 * Runs three deterministic command groups, classifies failures, checks that
 * user-deleted worktree artifacts are NOT restored, and emits a JSON artifact
 * to `data/baseline-2026-07-22.json`.
 *
 * Command groups:
 *   1. TypeScript typecheck: `npx tsc --noEmit`
 *   2. Core Answer tests:     `node --import tsx --test <focused files>`
 *   3. Minimal build:         `npm run build` (tsc emit to dist/, gitignored)
 *
 * Failure classification (Ticket 01):
 *   - product_regression       — assertion/type error in source under test
 *   - environment_blocked      — missing external dep (ES, Neo4j, network)
 *   - external_artifact_missing — deleted worktree artifact referenced
 *
 * Deleted artifact isolation (Directive D-001):
 *   The user deleted `tickets.md` and the `.scratch` issue/decision trees.
 *   This script verifies they remain deleted (NOT restored) and records them
 *   as intentionally absent. It never restores or overwrites them.
 *
 * Usage:  node scripts/baseline.mjs
 * Output: data/baseline-2026-07-22.json
 *
 * Determinism contract (P1.3 gate):
 *   The emitted JSON is byte-for-byte deterministic across runs on the same
 *   commit. Three sources of non-determinism are neutralized:
 *     1. `timestamp` is derived from the git HEAD committer date (stable per
 *        commit), NOT wall-clock time.
 *     2. `outputTail` values are sanitized to strip per-test timing values
 *        (e.g. "(0.1736ms)") and the `duration_ms N` summary line, which vary
 *        between runs. Test counts and pass/fail status are already stable.
 *     3. Sanitization runs on the FULL output BEFORE slicing, so the slice
 *        window does not shift when timing digit counts vary between runs.
 *   Verification: run twice, `diff` the two artifacts — output must be empty.
 */

import { spawnSync } from "node:child_process"
import { execSync } from "node:child_process"
import { writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, "..")
const ARTIFACT_PATH = join(REPO_ROOT, "data", "baseline-2026-07-22.json")
const RUN_ID = "2026-07-22-agentic-rag-optimization"

// ---------------------------------------------------------------------------
// Core Answer test files — the primary seam (Answer run event stream).
// ---------------------------------------------------------------------------

const CORE_ANSWER_TESTS = [
  "src/mastra/terminal_event_convergence.test.ts",
  "src/mastra/chat_event_adapter.test.ts",
]

// ---------------------------------------------------------------------------
// User-deleted artifacts that must NEVER be restored (Directive D-001).
// These are prefix patterns matched against `git status --short` deleted lines.
// ---------------------------------------------------------------------------

const DELETED_ARTIFACT_PREFIXES = [
  "tickets.md",
  ".scratch/agentic-rag-capability-upgrade/issues/",
  ".scratch/mastra-migration-wayfinder/issues/",
  ".scratch/mastra-migration/decisions/",
  ".scratch/mastra-migration/issues/",
]

// ---------------------------------------------------------------------------
// Open blockers from directives (D-002, D-003) and ops.md.
// ---------------------------------------------------------------------------

const OPEN_BLOCKERS = [
  {
    id: "D-002",
    target: "P5.3",
    severity: "stop",
    description: "OIDC issuer/JWKS, audience and claim mapping are deployment prerequisites; live identity smoke is operator-blocked.",
  },
  {
    id: "D-003",
    target: "P9.2",
    severity: "stop",
    description: "Elasticsearch and Neo4j disconnected; full hybrid retrieval release gate blocked until both are live.",
  },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 180000,
    ...options,
  })
  return {
    command: `${command} ${args.join(" ")}`,
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ? String(result.error) : null,
  }
}

function classifyFailure(stdout, stderr) {
  const combined = `${stdout}\n${stderr}`
  // Environment-blocked: external dependency unavailable.
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EADDRNOTAVAIL|ETIMEDOUT|ECONNRESET/i.test(combined)) {
    return "environment_blocked"
  }
  if (/elasticsearch|neo4j|connection refused|unable to connect/i.test(combined)) {
    return "environment_blocked"
  }
  // External-artifact-missing: deleted worktree artifact referenced.
  if (/tickets\.md|\.scratch[\\/].*issues|\.scratch[\\/].*decisions|Cannot find module.*issue/i.test(combined)) {
    return "external_artifact_missing"
  }
  // Default: product regression.
  return "product_regression"
}

function parseTestCounts(stdout) {
  const counts = { tests: null, pass: null, fail: null, skipped: null }
  // Node's test runner prints summary as "ℹ tests N" (U+2139 prefix).
  // Older versions use "# tests N". Match both for portability.
  const patterns = {
    tests: /(?:#|ℹ)\s+tests\s+(\d+)/,
    pass: /(?:#|ℹ)\s+pass\s+(\d+)/,
    fail: /(?:#|ℹ)\s+fail\s+(\d+)/,
    skipped: /(?:#|ℹ)\s+skipped\s+(\d+)/,
  }
  for (const [key, re] of Object.entries(patterns)) {
    const m = stdout.match(re)
    if (m) counts[key] = Number(m[1])
  }
  return counts
}

function gitRevision() {
  try {
    return execSync("git rev-parse HEAD", { cwd: REPO_ROOT, encoding: "utf8" }).trim()
  } catch {
    return null
  }
}

// Deterministic timestamp: git HEAD committer date in ISO 8601 (stable per commit).
// Falls back to null if git is unavailable — never falls back to wall-clock time,
// which would break the determinism contract.
function gitCommitDate() {
  try {
    return execSync("git show -s --format=%cI HEAD", { cwd: REPO_ROOT, encoding: "utf8" }).trim()
  } catch {
    return null
  }
}

// Strip volatile per-test timing values and the duration_ms summary line so the
// outputTail is byte-for-byte stable across runs. Test counts and pass/fail
// status are not touched (they are already deterministic integers).
function sanitizeForDeterminism(text) {
  if (!text) return text
  return text
    .replace(/\s*\(\d+\.?\d*\s*ms\)/gi, "")
    .replace(/duration_ms\s+\d+\.?\d*/gi, "duration_ms 0")
}

function gitStatusShort() {
  try {
    return execSync("git status --short", { cwd: REPO_ROOT, encoding: "utf8" }).trim()
  } catch {
    return ""
  }
}

function gitDiffCheck() {
  const result = run("git", ["diff", "--check"])
  return {
    exitCode: result.exitCode,
    passed: result.exitCode === 0,
    output: (result.stdout + result.stderr).trim(),
  }
}

// ---------------------------------------------------------------------------
// Deleted artifact isolation check (Directive D-001)
// ---------------------------------------------------------------------------

function checkDeletedArtifactIsolation(gitStatus) {
  const deletedLines = gitStatus
    .split(/\r?\n/)
    .filter((line) => /^\s*D\s+/.test(line) || /^D\s+/.test(line))
    .map((line) => line.replace(/^\s*[A-Z?]+\s+/, "").trim())

  // For each expected-deleted prefix, check at least one deleted path matches.
  const acknowledgements = DELETED_ARTIFACT_PREFIXES.map((prefix) => {
    const matches = deletedLines.filter((p) => p.replace(/\\/g, "/").startsWith(prefix))
    return {
      prefix,
      intentionallyAbsent: matches.length > 0,
      samplePaths: matches.slice(0, 3),
    }
  })

  const violations = acknowledgements.filter((a) => !a.intentionallyAbsent)
  const allAbsent = violations.length === 0

  return {
    allIntentionallyAbsent: allAbsent,
    acknowledgements,
    violations: violations.map((v) => v.prefix),
    note: "Directive D-001: deleted issue/decision/tickets files must not be restored, overwritten, or faked as passing.",
  }
}

// ---------------------------------------------------------------------------
// Run baseline
// ---------------------------------------------------------------------------

function runBaseline() {
  const revision = gitRevision()
  const gitStatus = gitStatusShort()
  const timestamp = gitCommitDate()
  const commands = []

  // 1. TypeScript typecheck
  const tscResult = run("npx", ["tsc", "--noEmit"])
  commands.push({
    name: "typescript",
    description: "TypeScript typecheck (npx tsc --noEmit)",
    command: tscResult.command,
    exitCode: tscResult.exitCode,
    passed: tscResult.exitCode === 0,
    classification: tscResult.exitCode === 0 ? "passed" : classifyFailure(tscResult.stdout, tscResult.stderr),
    testCounts: null,
    outputTail: sanitizeForDeterminism(tscResult.stderr || tscResult.stdout).slice(-800),
  })

  // 2. Core Answer tests
  const testArgs = ["--import", "tsx", "--test", ...CORE_ANSWER_TESTS]
  const testResult = run("node", testArgs)
  commands.push({
    name: "core_answer_tests",
    description: "Core Answer event-stream tests (focused)",
    command: testResult.command,
    files: CORE_ANSWER_TESTS,
    exitCode: testResult.exitCode,
    passed: testResult.exitCode === 0,
    classification: testResult.exitCode === 0 ? "passed" : classifyFailure(testResult.stdout, testResult.stderr),
    testCounts: parseTestCounts(testResult.stdout),
    outputTail: sanitizeForDeterminism(testResult.stdout).slice(-1200),
  })

  // 3. Minimal build (tsc emit to dist/, gitignored)
  const buildResult = run("npm", ["run", "build"])
  commands.push({
    name: "minimal_build",
    description: "Minimal build (npm run build = tsc emit)",
    command: buildResult.command,
    exitCode: buildResult.exitCode,
    passed: buildResult.exitCode === 0,
    classification: buildResult.exitCode === 0 ? "passed" : classifyFailure(buildResult.stdout, buildResult.stderr),
    testCounts: null,
    outputTail: sanitizeForDeterminism(buildResult.stderr || buildResult.stdout).slice(-800),
  })

  // Diff hygiene
  const diffCheck = gitDiffCheck()

  // Deleted artifact isolation
  const deletedArtifacts = checkDeletedArtifactIsolation(gitStatus)

  // Failure inventory
  const failures = commands.filter((c) => !c.passed)
  const failureInventory = {
    product_regression: failures.filter((f) => f.classification === "product_regression").length,
    environment_blocked: failures.filter((f) => f.classification === "environment_blocked").length,
    external_artifact_missing: failures.filter((f) => f.classification === "external_artifact_missing").length,
  }

  const artifact = {
    schemaVersion: 1,
    runId: RUN_ID,
    ledgerItem: "P1.1",
    ticket: "01",
    timestamp,
    gitRevision: revision,
    commands,
    diffCheck: {
      command: "git diff --check",
      passed: diffCheck.passed,
      output: diffCheck.output || "(clean)",
    },
    deletedArtifacts,
    failureInventory,
    openBlockers: OPEN_BLOCKERS,
    summary: {
      allPassed: failures.length === 0 && diffCheck.passed && deletedArtifacts.allIntentionallyAbsent,
      totalCommands: commands.length,
      passedCommands: commands.filter((c) => c.passed).length,
      failedCommands: failures.length,
      coreAnswerTestCounts: commands.find((c) => c.name === "core_answer_tests")?.testCounts ?? null,
    },
  }

  return artifact
}

// ---------------------------------------------------------------------------
// Emit artifact
// ---------------------------------------------------------------------------

function main() {
  mkdirSync(dirname(ARTIFACT_PATH), { recursive: true })
  const artifact = runBaseline()
  writeFileSync(ARTIFACT_PATH, JSON.stringify(artifact, null, 2) + "\n", "utf8")

  // Console summary (deterministic, for operator inspection)
  console.log(`Baseline artifact written: ${ARTIFACT_PATH}`)
  console.log(`  git revision: ${artifact.gitRevision}`)
  console.log(`  all passed:   ${artifact.summary.allPassed}`)
  console.log(`  commands:     ${artifact.summary.passedCommands}/${artifact.summary.totalCommands} passed`)
  const tc = artifact.summary.coreAnswerTestCounts
  if (tc) {
    console.log(`  core tests:   ${tc.pass}/${tc.tests} pass, ${tc.fail} fail, ${tc.skipped} skipped`)
  }
  console.log(`  failure inventory: product_regression=${artifact.failureInventory.product_regression} environment_blocked=${artifact.failureInventory.environment_blocked} external_artifact_missing=${artifact.failureInventory.external_artifact_missing}`)
  console.log(`  deleted artifacts isolated: ${artifact.deletedArtifacts.allIntentionallyAbsent}`)
  console.log(`  diff --check: ${artifact.diffCheck.passed ? "passed" : "FAILED"}`)
  console.log(`  open blockers: ${artifact.openBlockers.map((b) => b.id).join(", ")}`)

  // Exit non-zero if any hard gate failed (so the baseline is honest).
  const hardGateOk = artifact.commands.every((c) => c.passed) && artifact.diffCheck.passed && artifact.deletedArtifacts.allIntentionallyAbsent
  process.exit(hardGateOk ? 0 : 1)
}

main()
