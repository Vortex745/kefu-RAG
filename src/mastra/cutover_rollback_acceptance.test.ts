/**
 * Ticket 07 — Cutover / rollback acceptance tests (retired-baseline subset).
 *
 * The decision-document assertion that previously lived here verified the
 * wording of `.scratch/mastra-migration/decisions/07-cutover-rollback-acceptance.md`,
 * which the user deleted. That assertion is retired because it only tested
 * deleted planning history, not current runtime or source behavior.
 *
 * The four rollback-doc assertions that verified the content of
 * `docs/rollback-after-contraction.md` were retired in Ticket 01 when the
 * operator deleted that doc. They were document-level checks and protected
 * no runtime or source invariant.
 *
 * The live source-contract tests below are preserved because they verify
 * current production invariants that must remain enforced:
 * - runtime_mode.ts exposes only limited/default and normalizes retired values
 * - runtime boundary is Mastra-only (no legacy/shadow/RouteNotSupportedError)
 * - HTTP composition root injects the Mastra boundary directly
 * - retired generation test files remain absent
 *
 * Boundary: this test file is allowed to scan repository source files. It
 * MUST NOT be imported by src/answer/*, src/api/*, src/index.ts.
 */

import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"

const REPO_ROOT = path.resolve(__dirname, "..", "..")

function readSrc(relPath: string): string {
  return readFileSync(path.join(REPO_ROOT, ...relPath.split("/")), "utf8")
}

test("T07 contract: runtime_mode.ts exposes only limited/default and normalizes retired values to default", () => {
  const runtimeModeSrc = readSrc("src/mastra/runtime_mode.ts")
  assert.match(runtimeModeSrc, /"limited"\s*\|\s*"default"/)
  assert.equal(runtimeModeSrc.includes('"legacy"'), false)
  assert.equal(runtimeModeSrc.includes('"shadow"'), false)
  assert.equal(runtimeModeSrc.includes('"rollback"'), false)
  assert.match(runtimeModeSrc, /parseMastraRuntimeMode/)
})

test("T07 contract: runtime boundary is Mastra-only", () => {
  const boundarySrc = readSrc("src/mastra/runtime_boundary.ts")
  assert.match(boundarySrc, /mastraSource: MastraChatEventSource/)
  assert.equal(boundarySrc.includes("legacySource"), false)
  assert.equal(boundarySrc.includes("shadow"), false)
  assert.equal(boundarySrc.includes("RouteNotSupportedError"), false)
})

test("T07 contract: the HTTP composition root injects the Mastra boundary directly", () => {
  const indexSrc = readSrc("src/index.ts")
  const chatSrc = readSrc("src/api/chat.ts")
  assert.match(indexSrc, /createMastraRuntimeBoundary\(\{\s*mastraSource,/)
  assert.equal(indexSrc.includes("installAnswerGeneration"), false)
  assert.equal(indexSrc.includes("runAnswer"), false)
  assert.match(chatSrc, /eventsSource: AnswerEventsSource,/)
  assert.equal(chatSrc.includes("= runAnswer"), false)
})

test("T07 cleanup: retired generation test files are absent", () => {
  for (const relPath of [
    "src/answer/generation.test.ts",
    "src/answer/generation.t51.test.ts",
    "src/answer/generation_tool_selector.test.ts",
    "src/answer/generation_complex_loop.test.ts",
  ]) {
    assert.equal(existsSync(path.join(REPO_ROOT, ...relPath.split("/"))), false, `${relPath} must stay absent`)
  }
})
