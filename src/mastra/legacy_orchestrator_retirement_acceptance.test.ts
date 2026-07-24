import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"

function read(path: string): string {
  return readFileSync(path, "utf8")
}

test("T15 keeps only the shared generation contracts", () => {
  const source = read("src/answer/generation.ts")
  for (const symbol of [
    "AnswerModel",
    "AnswerRunObserver",
    "AnswerRunOptions",
    "OpenAIAnswerModel",
  ]) {
    assert.match(source, new RegExp(`export (?:interface|class) ${symbol}`))
  }
  for (const retired of [
    "AnswerGeneration",
    "AnswerGenerationDependencies",
    "installAnswerGeneration",
    "generateAnswer",
    "runAnswer",
    "defaultGeneration",
  ]) {
    assert.equal(source.includes(retired), false, `${retired} must be retired`)
  }
})

test("T15 makes the HTTP event source mandatory", () => {
  const chat = read("src/api/chat.ts")
  const server = read("src/api/server.ts")
  assert.match(chat, /eventsSource: AnswerEventsSource,/)
  assert.equal(chat.includes("= runAnswer"), false)
  assert.match(server, /eventsSource: AnswerEventsSource/)
})

test("T15 composition root wires Mastra without a legacy fallback", () => {
  const source = read("src/index.ts")
  assert.equal(source.includes("installAnswerGeneration"), false)
  assert.equal(source.includes("runAnswer"), false)
  assert.equal(source.includes("legacySource"), false)
  assert.match(source, /createMastraRuntimeBoundary\(\{\s*mastraSource,/)
})

test("T15 AnswerRuntime preserves shared resources and exporters only", () => {
  const source = read("src/answer/runtime.ts")
  assert.match(source, /readonly processRuntime: ProcessRuntime/)
  assert.match(source, /AnswerTraceRepository/)
  assert.match(source, /LangfuseExporter/)
  assert.equal(source.includes("AnswerGeneration"), false)
})

test("T15 runtime modes contain only limited and default", () => {
  const source = read("src/mastra/runtime_mode.ts")
  assert.match(source, /"limited" \| "default"/)
  assert.equal(source.includes('"legacy"'), false)
  assert.equal(source.includes('"rollback"'), false)
  assert.equal(source.includes('"shadow"'), false)
})

test("T15 runtime boundary is Mastra-only", () => {
  const source = read("src/mastra/runtime_boundary.ts")
  assert.match(source, /mastraSource: MastraChatEventSource/)
  assert.equal(source.includes("legacySource"), false)
  assert.equal(source.includes("RouteNotSupportedError"), false)
  assert.equal(source.includes("shadow"), false)
})

test("T15 deletes shadow implementation and acceptance assets", () => {
  for (const path of [
    "src/mastra/shadow_observer.ts",
    "src/mastra/shadow_parity.ts",
    "src/mastra/shadow_parity.test.ts",
    "src/mastra/shadow_cutover_acceptance.test.ts",
  ]) {
    assert.equal(existsSync(path), false, `${path} must be deleted`)
  }
})

test("T15 deletes legacy orchestrator-only tests", () => {
  for (const path of [
    "src/answer/generation.test.ts",
    "src/answer/generation.t51.test.ts",
    "src/answer/generation_tool_selector.test.ts",
    "src/answer/generation_complex_loop.test.ts",
  ]) {
    assert.equal(existsSync(path), false, `${path} must be deleted`)
  }
})

test("T15 moves Mastra core to runtime dependencies", () => {
  const pkg = JSON.parse(read("package.json")) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  assert.ok(pkg.dependencies?.["@mastra/core"])
  assert.equal(pkg.devDependencies?.["@mastra/core"], undefined)
})

test("T15 preserves repository-owned product data modules", () => {
  for (const path of [
    "src/answer/conversation_store.ts",
    "src/answer/summarizer.ts",
    "src/answer/handoff_store.ts",
    "src/answer/trace_repository.ts",
    "src/answer/feedback_store.ts",
    "src/answer/evidence.ts",
    "src/evaluation/release_verification.ts",
    "src/ingestion/tracking/page_index_repo.ts",
  ]) {
    assert.equal(existsSync(path), true, `${path} must be preserved`)
  }
})
