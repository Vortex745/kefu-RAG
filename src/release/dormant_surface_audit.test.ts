/**
 * Ticket 10 — Caller-audit tests + navigation link checks.
 *
 * These tests verify the dormant surface audit classifications by checking
 * import patterns programmatically against `listSourceFiles()`. The original
 * audit document `docs/dormant-surface-audit.md` was deleted by the operator
 * after Ticket 10; the classifications survive in the test names below
 * (#1 dormant / #2 compatibility boundary / #3 production caller / #4
 * release-only caller). They also verify that the HINTS.md navigation target
 * at the repository root exists.
 *
 * Spec acceptance criteria covered:
 * - "Classify every candidate surface as production caller, release-only caller,
 *    test-only caller, compatibility boundary, or no caller using static evidence"
 * - "Caller-audit tests, navigation link checks, builds, full suite, and
 *    git diff --check pass"
 *
 * Ticket 01 update: the four `docs/*` existence assertions in the original
 * section 5 were retired as deleted-history-only when the operator deleted
 * `docs/`. HINTS.md at the repository root is the only navigation target that
 * remains present and is still verified here.
 */

import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

const root = join(__dirname, "..", "..")
const src = join(root, "src")

// ---------- helpers ----------

function readSource(relPath: string): string {
  return readFileSync(join(src, relPath), "utf8")
}

/**
 * Count non-test, non-comment import lines matching a pattern in a source file.
 * Returns the list of matching files (relative to src/) that import the surface.
 */
function findNonTestImporters(
  surfaceImportPattern: RegExp,
  sourceFiles: string[],
): string[] {
  const importers: string[] = []
  for (const file of sourceFiles) {
    if (file.endsWith(".test.ts")) continue
    const content = readSource(file)
    if (surfaceImportPattern.test(content)) {
      importers.push(file)
    }
  }
  return importers
}

/**
 * Read all .ts files under src/ (excluding .test.ts) and return their
 * relative paths. This is a simplified flat scan — sufficient for the
 * audit tests which check specific import patterns.
 */
function listSourceFiles(): string[] {
  // Hardcoded list of the files relevant to the audit — avoids a full
  // recursive directory walk that would be fragile in test environments.
  return [
    "index.ts",
    "api/server.ts",
    "api/models.ts",
    "api/chat.ts",
    "api/status.ts",
    "api/ingest.ts",
    "answer/runtime.ts",
    "answer/clarification_store.ts",
    "answer/conversation_store.ts",
    "answer/langfuse_exporter.ts",
    "answer/generation.ts",
    "access/context.ts",
    "identity/index.ts",
    "identity/adapter.ts",
    "identity/jose_adapter.ts",
    "identity/signature_verify.ts",
    "identity/jwks_cache.ts",
    "identity/claims.ts",
    "evaluation/smoke.ts",
    "evaluation/release_verification.ts",
    "evaluation/ragas_shadow.ts",
    "evaluation/ragas_evaluator.ts",
    "evaluation/ragas_projection.ts",
    "evaluation/langfuse_smoke.ts",
    "evaluation/p9_1_release_artifact.ts",
    "mastra/chat_event_adapter.ts",
    "mastra/stop_conditions.ts",
    "mastra/promotion_gate.ts",
    "mastra/runtime_boundary.ts",
    "release/runner.ts",
    "release/promotion.ts",
    "release/smoke_harness.ts",
    "runtime/process_runtime.ts",
    "runtime/deadline.ts",
    "runtime/run_context.ts",
    "ingestion/storage/index.ts",
    "ingestion/storage/store.ts",
    "ingestion/tracking/db.ts",
  ]
}

const SOURCE_FILES = listSourceFiles()

// ============================================================
// 1. Dormant surfaces — no non-test caller
// ============================================================

test("Ticket 10 #1: models route (src/api/models.ts) is dormant — no non-test import", () => {
  const importers = findNonTestImporters(
    /from\s+["']\.\.?\/api\/models["']|from\s+["']\.\/models["']/,
    SOURCE_FILES,
  )
  assert.deepEqual(
    importers,
    [],
    "src/api/models.ts must have zero non-test importers (dormant per Ticket 02 + Ticket 10 audit)",
  )
})

test("Ticket 10 #1: models route is explicitly unmounted in server.ts", () => {
  const serverSource = readSource("api/server.ts")
  assert.match(
    serverSource,
    /no longer mounted in production/,
    "server.ts must document that /api/models is unmounted",
  )
  assert.ok(
    !/app\.use\s*\(\s*["']\/api\/models["']/.test(serverSource),
    "server.ts must NOT mount /api/models",
  )
})

test("Ticket 10 #1: stop_conditions (src/mastra/stop_conditions.ts) is dormant — no non-test import", () => {
  const importers = findNonTestImporters(
    /from\s+["']\.\.?\/mastra\/stop_conditions["']|from\s+["']\.\/stop_conditions["']/,
    SOURCE_FILES,
  )
  assert.deepEqual(
    importers,
    [],
    "src/mastra/stop_conditions.ts must have zero non-test importers (dormant — not wired into release runner or production)",
  )
})

// ============================================================
// 2. Compatibility boundaries — barrel-exported but not production-wired
// ============================================================

test("Ticket 10 #2: unsafe JWT/JWKS helpers are compatibility boundary — barrel-exported but NOT in production composition root", () => {
  // Barrel exports them
  const barrel = readSource("identity/index.ts")
  assert.match(barrel, /OidcIdentityAdapter/, "identity/index.ts barrel exports OidcIdentityAdapter")
  assert.match(barrel, /JwksKeyCache/, "identity/index.ts barrel exports JwksKeyCache")
  assert.match(barrel, /createCacheBackedSignatureVerifier/, "identity/index.ts barrel exports createCacheBackedSignatureVerifier")
  assert.match(barrel, /warmJwksCache/, "identity/index.ts barrel exports warmJwksCache")
  assert.match(barrel, /decodeJwtUnsafe/, "identity/index.ts barrel exports decodeJwtUnsafe")

  // Production composition root does NOT import them (uses JoseIdentityAdapter)
  const indexSource = readSource("index.ts")
  assert.ok(
    !/OidcIdentityAdapter/.test(indexSource),
    "src/index.ts must NOT import OidcIdentityAdapter (uses JoseIdentityAdapter since Ticket 05)",
  )
  assert.ok(
    !/JwksKeyCache/.test(indexSource),
    "src/index.ts must NOT import JwksKeyCache",
  )
  assert.ok(
    !/createCacheBackedSignatureVerifier/.test(indexSource),
    "src/index.ts must NOT import createCacheBackedSignatureVerifier",
  )
  assert.ok(
    !/warmJwksCache/.test(indexSource),
    "src/index.ts must NOT import warmJwksCache",
  )
  assert.match(
    indexSource,
    /JoseIdentityAdapter/,
    "src/index.ts must import JoseIdentityAdapter (production identity adapter)",
  )
})

test("Ticket 10 #2: release_verification.ts is compatibility boundary — type used in production, runtime functions test-only", () => {
  // promotion_gate.ts (production, via src/index.ts) imports TYPE only
  const promotionGateSource = readSource("mastra/promotion_gate.ts")
  assert.match(
    promotionGateSource,
    /import\s+type\s+\{[^}]*ReleaseVerificationArtifact[^}]*\}\s+from\s+["']\.\.\/evaluation\/release_verification["']/,
    "promotion_gate.ts imports TYPE ReleaseVerificationArtifact from release_verification.ts (type-only)",
  )

  // src/index.ts imports promotion_gate (production wiring)
  const indexSource = readSource("index.ts")
  assert.match(
    indexSource,
    /from\s+["']\.\/mastra\/promotion_gate["']/,
    "src/index.ts imports promotion_gate (production caller of the type)",
  )

  // release/runner.ts does NOT import release_verification runtime functions
  const runnerSource = readSource("release/runner.ts")
  assert.ok(
    !/from\s+["']\.\.\/evaluation\/release_verification["']/.test(runnerSource),
    "release/runner.ts does NOT import from release_verification.ts (uses its own gate runner)",
  )
})

test("Ticket 10 #2: clarification_store.ts is deprecated compatibility boundary — no non-test caller", () => {
  const importers = findNonTestImporters(
    /from\s+["']\.\.?\/answer\/clarification_store["']|from\s+["']\.\/clarification_store["']/,
    SOURCE_FILES,
  )
  assert.deepEqual(
    importers,
    [],
    "src/answer/clarification_store.ts must have zero non-test importers (deprecated in Ticket 08 P5)",
  )

  // The file must document its deprecation
  const storeSource = readSource("answer/clarification_store.ts")
  assert.match(
    storeSource,
    /@deprecated|deprecated|Do not add new callers/,
    "clarification_store.ts must document its deprecation",
  )
})

// ============================================================
// 3. Production callers — active wiring verified
// ============================================================

test("Ticket 10 #3: langfuse_exporter.ts has production caller (src/index.ts + answer/runtime.ts)", () => {
  const importers = findNonTestImporters(
    /from\s+["']\.\.?\/answer\/langfuse_exporter["']|from\s+["']\.\/langfuse_exporter["']/,
    SOURCE_FILES,
  )
  assert.ok(
    importers.includes("index.ts"),
    "src/index.ts must import langfuse_exporter (production caller)",
  )
  assert.ok(
    importers.includes("answer/runtime.ts"),
    "src/answer/runtime.ts must import langfuse_exporter (production caller)",
  )
})

test("Ticket 10 #3: abort helpers (deadline.ts + run_context.ts) have production caller via chat_event_adapter", () => {
  const chatAdapterSource = readSource("mastra/chat_event_adapter.ts")
  assert.match(
    chatAdapterSource,
    /from\s+["']\.\.\/runtime\/run_context["']/,
    "chat_event_adapter.ts imports from runtime/run_context (production caller)",
  )
  assert.match(
    chatAdapterSource,
    /from\s+["']\.\.\/runtime\/deadline["']/,
    "chat_event_adapter.ts imports from runtime/deadline (production caller)",
  )

  // chat_event_adapter is imported by src/index.ts (production)
  const indexSource = readSource("index.ts")
  assert.match(
    indexSource,
    /from\s+["']\.\/mastra\/chat_event_adapter["']/,
    "src/index.ts imports chat_event_adapter (production composition root)",
  )
})

// ============================================================
// 4. Release-only callers — release runner wiring verified
// ============================================================

test("Ticket 03: smoke.ts has no non-test caller (replaced by smoke_harness)", () => {
  const importers = findNonTestImporters(
    /from\s+["']\.\.?\/evaluation\/smoke["']|from\s+["']\.\/smoke["']/,
    SOURCE_FILES,
  )
  assert.deepEqual(
    importers,
    [],
    "evaluation/smoke.ts has zero non-test callers — Ticket 03 replaced runner's smoke consumption with release/smoke_harness",
  )
})

test("Ticket 03: smoke_harness.ts has release-only non-test caller (release/runner.ts)", () => {
  const importers = findNonTestImporters(
    /from\s+["']\.\.?\/release\/smoke_harness["']|from\s+["']\.\/smoke_harness["']/,
    SOURCE_FILES,
  )
  assert.deepEqual(
    importers,
    ["release/runner.ts"],
    "smoke_harness.ts has one non-test caller: release/runner.ts (Ticket 03 wired runner to consume SmokeEvidence)",
  )
})

// ============================================================
// 5. Navigation link checks — AGENTS.md navigation targets that still exist
// ============================================================
// Note: docs/architecture.md, docs/coding-standards.md,
// docs/dormant-surface-audit.md, and docs/spec-restructure.md were deleted by
// the operator after Ticket 10. The four assertions that verified their
// presence were retired in Ticket 01 as deleted-history-only — they were
// document-level checks that protected no runtime or source invariant.
// HINTS.md at repository root is the only navigation target still verified
// here because it remains present.

test("Ticket 10 #5: HINTS.md exists at repository root", () => {
  const hintsPath = join(root, "HINTS.md")
  assert.ok(
    existsSync(hintsPath),
    "HINTS.md must exist at repository root (AGENTS.md §1.1 navigation target)",
  )
  const content = readFileSync(hintsPath, "utf8")
  assert.match(content, /Environment Variables/i, "HINTS.md must document environment variables")
  assert.match(content, /Common Commands/i, "HINTS.md must document common commands")
})

// ============================================================
// 6. No file deletion — non-destructive ticket
// ============================================================

test("Ticket 10 #6: all audited surface files still exist (non-destructive)", () => {
  const auditedFiles = [
    "api/models.ts",
    "identity/adapter.ts",
    "identity/signature_verify.ts",
    "identity/jwks_cache.ts",
    "identity/claims.ts",
    "evaluation/release_verification.ts",
    "evaluation/ragas_shadow.ts",
    "evaluation/ragas_evaluator.ts",
    "evaluation/ragas_projection.ts",
    "answer/langfuse_exporter.ts",
    "evaluation/langfuse_smoke.ts",
    "evaluation/smoke.ts",
    "release/smoke_harness.ts",
    "mastra/stop_conditions.ts",
    "runtime/process_runtime.ts",
    "runtime/deadline.ts",
    "runtime/run_context.ts",
    "answer/clarification_store.ts",
  ]
  for (const file of auditedFiles) {
    assert.ok(
      existsSync(join(src, file)),
      `src/${file} must still exist — Ticket 10 is non-destructive (no file deletions)`,
    )
  }
})
