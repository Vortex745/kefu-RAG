/**
 * Ticket 02 — Framework/domain ownership boundary tests (retired-baseline subset).
 *
 * The decision-document assertions that previously lived here verified the
 * wording of `.scratch/mastra-migration/decisions/02-framework-domain-ownership.md`,
 * which the user deleted. Those assertions are retired because they only
 * tested deleted planning history, not current runtime or source behavior.
 *
 * The live source-contract test below is preserved because it verifies the
 * one-way dependency direction that must remain enforced in source.
 *
 * Boundary: this test file is allowed to scan repository source files for
 * forbidden import patterns. It MUST NOT be imported by src/answer/*,
 * src/api/*, src/index.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Criterion #5 — Matrix checked against the one-way dependency direction
// (live source check only — decision-doc assertions retired).
// ---------------------------------------------------------------------------

test("T02 #5: src/mastra does not import src/api or src/index (live source check)", () => {
  const mastraDir = path.join(REPO_ROOT, "src", "mastra");
  const offenders = listFilesRecursively(mastraDir, ".ts").filter((f) => {
    if (f.endsWith(".test.ts")) return false;
    const src = readFileSync(f, "utf8");
    return /from\s+["'].*\/api\//.test(src) || /from\s+["'].*\/index["']/.test(src);
  });
  assert.deepEqual(
    offenders,
    [],
    "src/mastra/* must not import src/api/* or src/index (dependency direction)"
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listFilesRecursively(dir: string, ext: string): string[] {
  const fs = require("node:fs") as typeof import("node:fs");
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursively(full, ext));
    } else if (entry.name.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}
