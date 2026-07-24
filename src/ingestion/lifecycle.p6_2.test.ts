import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { extname, join, relative, sep } from "node:path"

/**
 * P6.2 (spec §11 L73, L1574, L1575): HTTP/worker/pipeline caller wiring.
 *
 * P6.1 (accepted via D-016) already verified that ALL production callers
 * construct via `createIngestionLifecycle(db)` and that the lifecycle's
 * `runNext()` gates `activate()` on `activationMode`. P6.2 is Situation A
 * (test-only): it adds caller-audit + explicit-deny tests proving the
 * wiring is correct and tamper-proof. No production code is modified.
 *
 * Static-source checks (defense-in-depth against future regressions):
 *   1. No production file constructs `new IngestionLifecycle(...)` directly
 *      (only the factory in `pipeline.ts` may do so).
 *   2. HTTP/worker/CLI callers explicitly call `createIngestionLifecycle(db)`.
 *   3. `docRepo.activate()` appears ONLY in `lifecycle.ts` (auto branch)
 *      and `candidate_review_store.ts` (approve path — spec L1575).
 *   4. No production code hardcodes `SET candidate_state = 'approved'`
 *      (literal SQL) — the only path to `approved` is the review store's
 *      parameterized UPDATE.
 *   5. `SET active_doc_id =` appears ONLY in `doc_repo.ts` (activate method
 *      body) and `db.ts` (legacy schema migration) — never in HTTP/worker/
 *      CLI/pipeline/lifecycle code.
 *   6. The factory reads `loadConfig().activationMode` and passes it as the
 *      4th constructor arg — single source of truth for the review gate.
 */

const SRC_DIR = join(__dirname, "..", "..", "src")

/**
 * Recursively list all production .ts files under `rootDir`, excluding
 * `*.test.ts` files and the relative paths in `excludeRelPathParts`.
 * Paths are normalized to use forward slashes for cross-platform matching.
 */
function listProductionTsFiles(
  rootDir: string,
  excludeRelPathParts: string[] = []
): string[] {
  const results: string[] = []
  const stack: string[] = [rootDir]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const st = statSync(full)
      if (st.isDirectory()) {
        stack.push(full)
      } else if (
        st.isFile() &&
        extname(full) === ".ts" &&
        !full.endsWith(".test.ts")
      ) {
        const rel = relative(rootDir, full).split(sep).join("/")
        const excluded = excludeRelPathParts.some(
          (ex) => rel === ex || rel.endsWith("/" + ex) || rel.endsWith(ex)
        )
        if (!excluded) {
          results.push(full)
        }
      }
    }
  }
  return results
}

test("P6.2 caller audit: no production file constructs new IngestionLifecycle(...) directly", () => {
  // Spec L73: ACTIVATION_MODE=review 由 IngestionLifecycle 统一拥有，HTTP、
  // worker、pipeline、repository 不得各自实现隐式成功转移。All production
  // callers must go through the `createIngestionLifecycle(db)` factory —
  // direct construction bypasses the review state machine.
  //
  // The factory itself lives in `pipeline.ts` and is the ONLY production
  // file permitted to construct `new IngestionLifecycle(...)`.
  const files = listProductionTsFiles(SRC_DIR, ["pipeline.ts"])
  const offenders: string[] = []
  for (const file of files) {
    const source = readFileSync(file, "utf8")
    if (/new\s+IngestionLifecycle\s*\(/.test(source)) {
      offenders.push(relative(SRC_DIR, file).split(sep).join("/"))
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Production files must NOT construct new IngestionLifecycle(...) directly ` +
      `(bypasses review gate per spec L73). Offenders: ${offenders.join(", ")}`
  )
})

test("P6.2 caller audit: HTTP/worker/CLI callers explicitly use createIngestionLifecycle factory", () => {
  // The three real production caller entry points (per D-016) must each
  // call `createIngestionLifecycle(db)` — proving they go through the
  // factory's `loadConfig().activationMode` wiring.
  const callerFiles: Record<string, string> = {
    "src/api/worker.ts": join(SRC_DIR, "api", "worker.ts"),
    "src/api/ingest.ts": join(SRC_DIR, "api", "ingest.ts"),
    "src/ingestion/cli.ts": join(SRC_DIR, "ingestion", "cli.ts"),
  }
  for (const [relPath, fullPath] of Object.entries(callerFiles)) {
    const source = readFileSync(fullPath, "utf8")
    assert.ok(
      /createIngestionLifecycle\s*\(/.test(source),
      `${relPath} must call createIngestionLifecycle(db) factory (spec L73)`
    )
  }
})

test("P6.2 explicit-deny: docRepo.activate() only in lifecycle auto-branch and review approve path", () => {
  // The ONLY legitimate `docRepo.activate()` / `documentRepo.activate()`
  // call sites in production code are:
  //   1. src/ingestion/lifecycle.ts — auto mode branch (P6.1: else of
  //      `activationMode === "review"`)
  //   2. src/knowledge/candidate_review_store.ts — approve path (spec L1575:
  //      "approve-activates" is the single legitimate terminal activation)
  // No HTTP/worker/CLI/pipeline code may call activate() directly.
  const files = listProductionTsFiles(SRC_DIR)
  const offenders: string[] = []
  for (const file of files) {
    const source = readFileSync(file, "utf8")
    if (/(?:docRepo|documentRepo)\.activate\s*\(/.test(source)) {
      offenders.push(relative(SRC_DIR, file).split(sep).join("/"))
    }
  }
  const expected = ["ingestion/lifecycle.ts", "knowledge/candidate_review_store.ts"].sort()
  assert.deepEqual(
    offenders.sort(),
    expected,
    `docRepo.activate() must ONLY appear in lifecycle.ts (auto branch) and ` +
      `candidate_review_store.ts (approve path). Found in: ${offenders.join(", ")}`
  )
})

test("P6.2 explicit-deny: no production code hardcodes SET candidate_state = 'approved'", () => {
  // The ONLY legitimate path that sets candidate_state to 'approved' is
  // `CandidateReviewStore.review(approve)` (spec L1575), which uses a
  // parameterized query (`SET candidate_state = ?` with a bound value).
  // No production code may hardcode `SET candidate_state = 'approved'`
  // as literal SQL — that would bypass the review store's audit trail
  // (reviewed_by, reviewed_at, review_reason).
  //
  // Note: `db.ts` schema migration uses `DEFAULT 'approved'` (column
  // default), NOT `SET candidate_state = 'approved'` — the regex below
  // requires the SQL `SET` keyword and does not match `DEFAULT`.
  // Comment in `candidate_review_store.ts:91` uses title-case `Set` —
  // case-sensitive `SET` does not match it.
  const files = listProductionTsFiles(SRC_DIR)
  const offenders: string[] = []
  for (const file of files) {
    const source = readFileSync(file, "utf8")
    // Case-sensitive SET (SQL convention) — excludes the title-case
    // comment in candidate_review_store.ts:91 ("Set candidate_state='approved'")
    if (/SET\s+candidate_state\s*=\s*'approved'/.test(source)) {
      offenders.push(relative(SRC_DIR, file).split(sep).join("/"))
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `No production code may hardcode SET candidate_state = 'approved' as ` +
      `literal SQL — must go through CandidateReviewStore.review(approve) ` +
      `parameterized path. Offenders: ${offenders.join(", ")}`
  )
})

test("P6.2 explicit-deny: SET active_doc_id only in doc_repo.ts and db.ts migration", () => {
  // The ONLY legitimate paths that UPDATE sources SET active_doc_id are:
  //   1. src/ingestion/tracking/doc_repo.ts — DocumentRepo.activate()
  //      method body (conditional UPDATE based on activation_order)
  //   2. src/ingestion/tracking/db.ts — legacy schema migration (one-time
  //      upgrade for pre-Phase-E databases)
  // No HTTP/worker/CLI/pipeline/lifecycle code may directly UPDATE
  // sources SET active_doc_id — that would bypass the activation_order
  // protection in DocumentRepo.activate().
  const files = listProductionTsFiles(SRC_DIR, [
    "tracking/doc_repo.ts",
    "tracking/db.ts",
  ])
  const offenders: string[] = []
  for (const file of files) {
    const source = readFileSync(file, "utf8")
    if (/SET\s+active_doc_id\s*=/.test(source)) {
      offenders.push(relative(SRC_DIR, file).split(sep).join("/"))
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `No production code may SET active_doc_id outside DocumentRepo.activate() ` +
      `(doc_repo.ts) and legacy migration (db.ts). Offenders: ${offenders.join(", ")}`
  )
})

test("P6.2 factory wiring: createIngestionLifecycle reads activationMode from config and passes to constructor", () => {
  // Static-source check: the factory MUST read `loadConfig().activationMode`
  // and pass it as the 4th constructor arg. This proves the factory is the
  // single source of truth for activationMode — callers cannot bypass the
  // review state machine by omitting the mode.
  const factorySource = readFileSync(
    join(SRC_DIR, "ingestion", "pipeline.ts"),
    "utf8"
  )
  // Extract from `export function createIngestionLifecycle` through the
  // closing `cfg.activationMode)` of the return statement. The non-greedy
  // match up to `cfg.activationMode)` ensures we capture the full
  // constructor call including nested parentheses in PipelineStageRunner.
  const factoryMatch = factorySource.match(
    /export function createIngestionLifecycle[\s\S]*?cfg\.activationMode\)/
  )
  assert.ok(
    factoryMatch,
    "createIngestionLifecycle factory must exist in pipeline.ts and pass cfg.activationMode to the constructor"
  )
  const factoryBody = factoryMatch[0]
  // The factory reads config into a local `cfg` variable, then passes
  // `cfg.activationMode` as the 4th constructor arg. Both must be present.
  assert.match(
    factoryBody,
    /loadConfig\(\)/,
    "factory must call loadConfig() to read the runtime config (single source of truth for activationMode)"
  )
  assert.match(
    factoryBody,
    /new IngestionLifecycle\([\s\S]*cfg\.activationMode\)/,
    "factory must pass cfg.activationMode as the 4th constructor arg"
  )
})
