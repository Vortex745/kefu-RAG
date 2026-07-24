/**
 * T59: Contract — DOM and HTTP are thin adapters over Conversation.
 *
 * These tests pin the invariant that app.js does NOT own thread state,
 * run race state, or trace merge logic. All such concerns live in
 * Conversation (src/frontend/conversation.ts). app.js only owns:
 *   - DOM rendering (renders Conversation's projected state)
 *   - HTTP/SSE transport (fetch + ReadableStream line parsing)
 *   - UI-only state (attachments, sidebarCollapsed, streamEnabled,
 *     abortController, listening, toastTimer)
 *
 * If these tests fail, someone added state ownership back into app.js.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const here = __dirname
const root = join(here, "..", "..")
const appJsPath = join(here, "..", "..", "frontend", "js", "app.js")
const appJs = readFileSync(appJsPath, "utf8")
const html = readFileSync(join(root, "frontend", "index.html"), "utf8")
const css = readFileSync(join(root, "frontend", "css", "styles.css"), "utf8")
const tailwindInputPath = join(root, "frontend", "css", "tailwind.css")
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))

test("main frontend owns the simplified answer path and RAGAS window", () => {
  for (const id of [
    "insight-open",
    "insight-dialog",
    "insight-close",
    "insight-tabs",
    "insight-path-panel",
    "insight-path-chain",
    "insight-evaluation-panel",
    "ragas-refresh",
    "ragas-content",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`))
  }
  assert.match(html, /回答路径/)
  assert.match(html, /质量评估/)
  assert.match(appJs, /showModal\s*\(/)
  assert.match(appJs, /\/observability\/ragas/)
  assert.equal(/\/observability\/runs/.test(appJs), false)
  assert.equal(/\.result\.reply\b/.test(appJs), false)
})

test("frontend styling is built with Tailwind CSS CLI", () => {
  assert.match(packageJson.scripts["build:css"], /@tailwindcss\/cli/)
  assert.match(packageJson.scripts["build:frontend"], /build:css/)
  assert.match(packageJson.scripts["watch:css"], /@tailwindcss\/cli/)
  assert.ok(packageJson.devDependencies.tailwindcss)
  assert.ok(packageJson.devDependencies["@tailwindcss/cli"])
  assert.equal(existsSync(tailwindInputPath), true, "Tailwind input stylesheet must exist")

  const tailwindInput = readFileSync(tailwindInputPath, "utf8")
  assert.match(tailwindInput, /@import\s+"tailwindcss"\s+source\(none\)/)
  assert.match(tailwindInput, /@source\s+"\.\.\/index\.html"/)
  assert.match(tailwindInput, /@source\s+"\.\.\/js\/app\.js"/)
  assert.match(css, /tailwindcss v4\./)
})

test("frontend uses statically detectable Tailwind utility classes", () => {
  assert.match(html, /\bmin-h-dvh\b/)
  assert.match(html, /\bmax-md:/)
  assert.match(appJs, /\brounded-/)
  assert.equal(
    /className\s*=\s*`[^`]*\$\{/.test(appJs),
    false,
    "Tailwind className values must not be constructed with interpolation",
  )

  const runtimeStyleProperties = [...appJs.matchAll(/\.style\.([A-Za-z]+)/g)]
    .map((match) => match[1])
  assert.deepEqual(
    [...new Set(runtimeStyleProperties)].sort(),
    ["height", "width"],
    "Only textarea auto-height and RAGAS percentage width may use runtime inline styles",
  )
})

test("citation navigation resolves the enclosing message article", () => {
  assert.match(appJs, /button\.closest\("article\[data-message-id\]"\)/)
  assert.match(appJs, /panel\.open\s*=\s*true/)
})

test("standalone observability dashboard assets are removed", () => {
  for (const path of [
    join(root, "frontend", "observability.html"),
    join(root, "frontend", "css", "observability.css"),
    join(root, "frontend", "js", "observability.js"),
  ]) {
    assert.equal(existsSync(path), false, `${path} should not exist`)
  }
})

test("app.js does not own thread state (no state.threads / state.activeThreadId)", () => {
  assert.equal(
    /state\.threads\b/.test(appJs),
    false,
    "state.threads must not appear in app.js — owned by Conversation",
  )
  assert.equal(
    /state\.activeThreadId\b/.test(appJs),
    false,
    "state.activeThreadId must not appear in app.js — owned by Conversation",
  )
  assert.equal(
    /loadPersistedState\b/.test(appJs),
    false,
    "loadPersistedState must not appear in app.js — owned by Conversation",
  )
  assert.equal(
    /ensureActiveThread\b/.test(appJs),
    false,
    "ensureActiveThread must not appear in app.js — owned by Conversation",
  )
})

test("app.js does not own run race state (no state.running)", () => {
  assert.equal(
    /state\.running\b/.test(appJs),
    false,
    "state.running must not appear in app.js — owned by Conversation.isRunning/startRun/completeRun/cancelRun",
  )
})

test("app.js does not directly merge trace events (no bare normalizeTraceEvents / mergeTraceEvent calls)", () => {
  // `import { ... mergeTraceEvent ... }` would be a local call site. app.js
  // must delegate to conversation.mergeTraceEvent via processSseEvent or
  // applyRunHistory / applyCompleteReply instead.
  assert.equal(
    /\bmergeTraceEvent\s*\(/.test(appJs),
    false,
    "mergeTraceEvent( must not be called directly in app.js — use conversation.processSseEvent or applyRunHistory",
  )
  assert.equal(
    /\bnormalizeTraceEvents\s*\(/.test(appJs),
    false,
    "normalizeTraceEvents( must not be called directly in app.js — owned by Conversation.applyRunHistory / applyCompleteReply",
  )
})

test("app.js delegates run lifecycle to Conversation (startRun / completeRun / isRunning)", () => {
  assert.ok(
    /conversation\.isRunning\s*\(/.test(appJs),
    "app.js must call conversation.isRunning() instead of tracking state.running",
  )
  assert.ok(
    /conversation\.startRun\s*\(/.test(appJs),
    "app.js must call conversation.startRun() at the start of submitPrompt",
  )
  assert.ok(
    /conversation\.completeRun\s*\(/.test(appJs),
    "app.js must call conversation.completeRun() in the finally block of submitPrompt",
  )
})

test("app.js delegates SSE stream merge to Conversation (processSseEvent + finalizeStreamRun)", () => {
  assert.ok(
    /conversation\.processSseEvent\s*\(/.test(appJs),
    "app.js must delegate SSE chunk merge to conversation.processSseEvent",
  )
  assert.ok(
    /conversation\.finalizeStreamRun\s*\(/.test(appJs),
    "app.js must delegate stream completion status policy to conversation.finalizeStreamRun",
  )
})

test("app.js delegates run history restore to Conversation (applyRunHistory)", () => {
  assert.ok(
    /conversation\.applyRunHistory\s*\(/.test(appJs),
    "app.js must delegate run history restore to conversation.applyRunHistory",
  )
})

test("app.js delegates non-stream reply merge to Conversation (applyCompleteReply)", () => {
  assert.ok(
    /conversation\.applyCompleteReply\s*\(/.test(appJs),
    "app.js must delegate complete-reply merge + status policy to conversation.applyCompleteReply",
  )
})

test("app.js delegates abort / connection-error status policy to Conversation", () => {
  assert.ok(
    /conversation\.finalizeAbortedRun\s*\(/.test(appJs),
    "app.js must delegate abort status policy to conversation.finalizeAbortedRun",
  )
  assert.ok(
    /conversation\.finalizeConnectionError\s*\(/.test(appJs),
    "app.js must delegate connection-error status policy to conversation.finalizeConnectionError",
  )
})

test("app.js delegates thread state mutation to Conversation (createThread / deleteThread / setActiveThread)", () => {
  assert.ok(/conversation\.createThread\s*\(/.test(appJs), "createThread must go through Conversation")
  assert.ok(/conversation\.deleteThread\s*\(/.test(appJs), "deleteThread must go through Conversation")
  assert.ok(/conversation\.setActiveThread\s*\(/.test(appJs), "setActiveThread must go through Conversation")
})

test("app.js keeps only UI-only state in the `state` object", () => {
  // Extract `const state = { ... }` block (non-greedy up to the closing `}`)
  const stateBlock = /const\s+state\s*=\s*\{[^]*?\n\}/.exec(appJs)
  assert.ok(stateBlock, "app.js must define a `state` object for UI-only concerns")
  const body = stateBlock[0]
  const forbidden = ["threads:", "activeThreadId:", "running:"]
  for (const key of forbidden) {
    assert.equal(
      body.includes(key),
      false,
      `state object must not contain "${key}" — it is a Conversation concern`,
    )
  }
})

test("app.js references DOM render targets (薄 adapter must still own DOM)", () => {
  // DOM is app.js's primary responsibility — rendering must remain here.
  assert.ok(/document\.getElementById/.test(appJs), "app.js must own DOM element lookups")
  assert.ok(/replaceChildren|appendChild/.test(appJs), "app.js must own DOM mutations")
  assert.ok(/addEventListener/.test(appJs), "app.js must own event binding")
})

test("app.js owns fetch transport (薄 adapter must still own HTTP/SSE)", () => {
  assert.ok(/fetch\s*\(/.test(appJs), "app.js must own fetch transport")
  assert.ok(/response\.body\.getReader/.test(appJs), "app.js must own ReadableStream reading")
  assert.ok(/AbortController/.test(appJs), "app.js must own AbortController for fetch cancellation")
})

test("app.js does not reference window.ReferenceUi (removed in T57)", () => {
  assert.equal(
    /window\.ReferenceUi/.test(appJs),
    false,
    "window.ReferenceUi was removed in T57 — references must come from imported functions",
  )
})
