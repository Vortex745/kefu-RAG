/**
 * Ticket 03 — Mastra Answer workflow topology tests (retired-baseline subset).
 *
 * The decision-document assertions that previously lived here verified the
 * wording of `.scratch/mastra-migration/decisions/03-workflow-topology.md`,
 * which the user deleted. Those assertions are retired because they only
 * tested deleted planning history, not current runtime or source behavior.
 *
 * The live source-contract test below is preserved because it verifies
 * current production budget constants that must remain unchanged.
 *
 * Boundary: this test file is allowed to scan repository source files for
 * budget constants. It MUST NOT be imported by src/answer/*, src/api/*,
 * src/index.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Criterion #4 — Preserve existing retrieval, iteration, token, and
// duration budgets (live source check only — decision-doc assertions retired).
// ---------------------------------------------------------------------------

test("T03 #4: live source check — budget constants unchanged", () => {
  // The repository's budget constants must still have their original values
  // (this ticket is decision-only; no source modifications).
  const plannerSrc = readFileSync(
    path.join(REPO_ROOT, "src", "retrieval", "planner", "planner.ts"),
    "utf8"
  );
  assert.ok(
    /MAX_SUB_QUERIES\s*=\s*4/.test(plannerSrc),
    "MAX_SUB_QUERIES must still equal 4 in planner.ts"
  );
  const loopSrc = readFileSync(
    path.join(REPO_ROOT, "src", "retrieval", "complex_loop.ts"),
    "utf8"
  );
  assert.ok(
    /COMPLEX_LOOP_MAX_ITERATIONS\s*=\s*3/.test(loopSrc),
    "COMPLEX_LOOP_MAX_ITERATIONS must still equal 3 in complex_loop.ts"
  );
  assert.ok(
    /COMPLEX_LOOP_MAX_TOOL_CALLS\s*=\s*4/.test(loopSrc),
    "COMPLEX_LOOP_MAX_TOOL_CALLS must still equal 4 in complex_loop.ts"
  );
});
