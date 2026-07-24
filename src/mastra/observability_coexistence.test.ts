/**
 * Ticket 06 — Observability and evaluation coexistence tests (retired-baseline subset).
 *
 * The decision-document assertions that previously lived here verified the
 * wording of `.scratch/mastra-migration/decisions/06-observability-evaluation-coexistence.md`,
 * which the user deleted. Those assertions are retired because they only
 * tested deleted planning history, not current runtime or source behavior.
 *
 * The live source-contract tests below are preserved because they verify
 * current production source invariants that must remain enforced:
 * - AnswerTraceRepository authoritative persistence (INSERT OR IGNORE, ORDER BY sequence ASC)
 * - NoopLangfuseExporter default + safe export whitelist
 * - Fire-and-forget export contract (try/catch, never throw)
 * - Hard invariants deterministic + non-overridable + Mastra-independent
 * - RAGAS structural separation (top-level ragas?/ragasShadow?)
 * - EvaluationArtifact contract (schemaVersion + aggregateMetrics)
 * - Idempotent close() + bounded droppedCount/maxRuns queue
 * - Dependency direction (src/mastra/* → no src/api/* or src/index)
 *
 * Boundary: this test file is allowed to scan repository source files for
 * contract preservation. It MUST NOT be imported by src/answer/*, src/api/*,
 * src/index.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Criterion #2 — Local schema-versioned Answer events authoritative for
// product history and replay (live source checks).
// ---------------------------------------------------------------------------

test("T06 #2: AnswerTraceRepository is the authoritative source (live source check)", () => {
  const traceSrc = readFileSync(
    path.join(REPO_ROOT, "src", "answer", "trace_repository.ts"),
    "utf8"
  );
  assert.ok(
    traceSrc.includes("class AnswerTraceRepository"),
    "AnswerTraceRepository class must exist in source"
  );
  assert.ok(
    traceSrc.includes("INSERT OR IGNORE"),
    "append() must use INSERT OR IGNORE (idempotent publish)"
  );
});

test("T06 #2: replay compatibility preserved (getRun ORDER BY sequence ASC)", () => {
  const traceSrc = readFileSync(
    path.join(REPO_ROOT, "src", "answer", "trace_repository.ts"),
    "utf8"
  );
  assert.ok(
    traceSrc.includes("ORDER BY sequence ASC"),
    "getRun() must ORDER BY sequence ASC (replay contract)"
  );
});

// ---------------------------------------------------------------------------
// Criterion #3 — Privacy-safe default telemetry (live source checks).
// ---------------------------------------------------------------------------

test("T06 #3: Noop is the default when Langfuse config absent (live source check)", () => {
  const exporterSrc = readFileSync(
    path.join(REPO_ROOT, "src", "answer", "langfuse_exporter.ts"),
    "utf8"
  );
  assert.ok(
    exporterSrc.includes("if (!config) return new NoopLangfuseExporter()"),
    "createLangfuseExporter must return NoopLangfuseExporter when config is absent"
  );
  assert.ok(
    exporterSrc.includes("class NoopLangfuseExporter"),
    "NoopLangfuseExporter class must exist"
  );
});

test("T06 #3: safe whitelist per stage exists (live source check)", () => {
  const exporterSrc = readFileSync(
    path.join(REPO_ROOT, "src", "answer", "langfuse_exporter.ts"),
    "utf8"
  );
  assert.ok(
    exporterSrc.includes("safeKeysForStage"),
    "RealLangfuseExporter must have safeKeysForStage method"
  );
  // All 4 stages must have whitelist entries.
  for (const stage of ["route", "retrieval", "context", "validation"]) {
    assert.ok(
      exporterSrc.includes(`case "${stage}"`),
      `safeKeysForStage must have a case for ${stage}`
    );
  }
});

// ---------------------------------------------------------------------------
// Criterion #4 — Observability failure isolated (live source checks).
// ---------------------------------------------------------------------------

test("T06 #4: export() is fire-and-forget (never throws, live source check)", () => {
  const exporterSrc = readFileSync(
    path.join(REPO_ROOT, "src", "answer", "langfuse_exporter.ts"),
    "utf8"
  );
  assert.ok(
    exporterSrc.includes("try {") && exporterSrc.includes("} catch {"),
    "RealLangfuseExporter.export() must wrap client calls in try/catch"
  );
  assert.ok(
    exporterSrc.includes("never throw") || exporterSrc.includes("NEVER throws"),
    "exporter source must document the never-throw contract"
  );
});

// ---------------------------------------------------------------------------
// Criterion #5 — Mastra evaluation and RAGAS structurally separate from
// deterministic hard invariants (live source checks).
// ---------------------------------------------------------------------------

test("T06 #5: hard invariants are deterministic + non-overridable (live source check)", () => {
  const hardSrc = readFileSync(
    path.join(REPO_ROOT, "src", "evaluation", "hard_invariants.ts"),
    "utf8"
  );
  assert.ok(
    hardSrc.includes("DETERMINISTIC") && hardSrc.includes("NON-OVERRIDABLE"),
    "hard_invariants source must document DETERMINISTIC + NON-OVERRIDABLE"
  );
  assert.ok(
    hardSrc.includes("consume GoldenCase[] + CaseResult[]") ||
      hardSrc.includes("GoldenCase[] + CaseResult[]"),
    "hard_invariants must consume GoldenCase[] + CaseResult[] only"
  );
});

test("T06 #5: RAGAS structurally separate from hardInvariants (live source check)", () => {
  const typesSrc = readFileSync(
    path.join(REPO_ROOT, "src", "evaluation", "types.ts"),
    "utf8"
  );
  assert.ok(
    typesSrc.includes("ragas?: RagasArtifactSection"),
    "EvaluationArtifact must have ragas? as a separate top-level field"
  );
  assert.ok(
    typesSrc.includes("ragasShadow?: RagasShadowArtifactSection"),
    "EvaluationArtifact must have ragasShadow? as a separate top-level field"
  );
  assert.ok(
    typesSrc.includes("NON-BLOCKING"),
    "RAGAS shadow must be documented as NON-BLOCKING"
  );
});

test("T06 #5: EvaluationArtifact contract unchanged (live source check)", () => {
  const typesSrc = readFileSync(
    path.join(REPO_ROOT, "src", "evaluation", "types.ts"),
    "utf8"
  );
  assert.ok(
    typesSrc.includes("schemaVersion: 1") && typesSrc.includes("aggregateMetrics"),
    "EvaluationArtifact must have schemaVersion + aggregateMetrics"
  );
  assert.ok(
    typesSrc.includes("hardInvariants:") && typesSrc.includes("qualityMetrics:"),
    "aggregateMetrics must have hardInvariants + qualityMetrics"
  );
});

// ---------------------------------------------------------------------------
// Criterion #6 — Flush, shutdown, retry, and disabled-mode behavior (live
// source checks).
// ---------------------------------------------------------------------------

test("T06 #6: close() is idempotent (live source check)", () => {
  const exporterSrc = readFileSync(
    path.join(REPO_ROOT, "src", "answer", "langfuse_exporter.ts"),
    "utf8"
  );
  assert.ok(
    exporterSrc.includes("closePromise") && exporterSrc.includes("if (this.closePromise) return this.closePromise"),
    "RealLangfuseExporter.close() must cache closePromise (idempotent)"
  );
});

test("T06 #6: no retry — drop + warn (live source check)", () => {
  const exporterSrc = readFileSync(
    path.join(REPO_ROOT, "src", "answer", "langfuse_exporter.ts"),
    "utf8"
  );
  assert.ok(
    exporterSrc.includes("droppedCount"),
    "RealLangfuseExporter must have droppedCount"
  );
  assert.ok(
    exporterSrc.includes("maxRuns"),
    "RealLangfuseExporter must have bounded maxRuns queue"
  );
});

// ---------------------------------------------------------------------------
// Cross-ticket consistency — live source checks only.
// ---------------------------------------------------------------------------

test("cross: T04 trace independence — trace repository unchanged", () => {
  const traceSrc = readFileSync(
    path.join(REPO_ROOT, "src", "answer", "trace_repository.ts"),
    "utf8"
  );
  // T04 preserved trace independence; T06 must not change it.
  assert.ok(
    traceSrc.includes("class AnswerTraceRepository"),
    "AnswerTraceRepository class must still exist (T04 independence preserved)"
  );
  assert.ok(
    traceSrc.includes("answer_run_events"),
    "answer_run_events table must still be the persistence target"
  );
});

test("cross: T02 #5 — src/mastra/* does not import src/api/* or src/index (live source check)", () => {
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
