/**
 * Ticket 04 — Choose Conversation Memory ownership tests (retired-baseline subset).
 *
 * The decision-document assertions that previously lived here verified the
 * wording of `.scratch/mastra-migration/decisions/04-memory-ownership.md`,
 * which the user deleted. Those assertions are retired because they only
 * tested deleted planning history, not current runtime or source behavior.
 *
 * The live source-contract tests below are preserved because they verify
 * current production source invariants that must remain enforced:
 * - ConversationStore enforces tenant + session filters + validated-turn-only
 * - ConversationStore has all 9 documented methods
 * - ConversationStore interface is unchanged
 * - HandoffStore interface is unchanged
 * - Summarizer interface is unchanged
 *
 * Boundary: this test file is allowed to scan repository source files for
 * invariant preservation. It MUST NOT be imported by src/answer/*, src/api/*,
 * src/index.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Criterion #2 — Preserve Tenant and session isolation and validated-turn-
// only history (live source check).
// ---------------------------------------------------------------------------

test("T04 #2: live source check — ConversationStore enforces tenant + session filters", () => {
  const storeSrc = readFileSync(
    path.join(REPO_ROOT, "src", "answer", "conversation_store.ts"),
    "utf8"
  );
  // loadRecentTurns must filter by both sessionId AND tenantId
  assert.ok(
    /loadRecentTurns[\s\S]*?session_id\s*=\s*\?[\s\S]*?tenant_id\s*=\s*\?/.test(storeSrc),
    "loadRecentTurns must filter by session_id AND tenant_id"
  );
  // loadConversationMemory must filter by both sessionId AND tenantId
  assert.ok(
    /loadConversationMemory[\s\S]*?session_id\s*=\s*\?[\s\S]*?tenant_id\s*=\s*\?/.test(storeSrc),
    "loadConversationMemory must filter by session_id AND tenant_id"
  );
  // Validated-turn-only: SQL must filter kind = 'validated'
  assert.ok(
    storeSrc.includes("kind = 'validated'") || storeSrc.includes("kind='validated'"),
    "ConversationStore must filter kind='validated' (validated-turn-only)"
  );
});

// ---------------------------------------------------------------------------
// Criterion #3 — Preserve rolling-summary checkpoints, bounded recent turns,
// Handoff projection, and TTL cleanup (live source check).
// ---------------------------------------------------------------------------

test("T04 #3: live source check — ConversationStore has all 9 documented methods", () => {
  const storeSrc = readFileSync(
    path.join(REPO_ROOT, "src", "answer", "conversation_store.ts"),
    "utf8"
  );
  const expectedMethods = [
    "saveValidatedTurn",
    "loadRecentTurns",
    "savePendingClarification",
    "consumePendingClarification",
    "deleteInactiveBefore",
    "saveRollingSummary",
    "getRollingSummary",
    "loadConversationMemory",
    "loadOlderTurnsForSummarization",
  ];
  for (const method of expectedMethods) {
    assert.ok(
      storeSrc.includes(method),
      `ConversationStore must define method: ${method}`
    );
  }
});

// ---------------------------------------------------------------------------
// Cross-ticket consistency — live source checks only.
// ---------------------------------------------------------------------------

test("T04 live source check — ConversationStore interface is unchanged", () => {
  // The ConversationStore interface must still exist and export all expected
  // types (this ticket is decision-only; no source modifications).
  const storeSrc = readFileSync(
    path.join(REPO_ROOT, "src", "answer", "conversation_store.ts"),
    "utf8"
  );
  assert.ok(
    storeSrc.includes("export interface ConversationStore"),
    "ConversationStore interface must still be exported"
  );
  assert.ok(
    storeSrc.includes("export class SqliteConversationStore"),
    "SqliteConversationStore class must still be exported"
  );
  assert.ok(
    storeSrc.includes("export interface ConversationTurn"),
    "ConversationTurn type must still be exported"
  );
  assert.ok(
    storeSrc.includes("export interface RollingSummaryRecord"),
    "RollingSummaryRecord type must still be exported"
  );
  assert.ok(
    storeSrc.includes("export interface ConversationMemory"),
    "ConversationMemory type must still be exported"
  );
});

test("T04 live source check — HandoffStore interface is unchanged", () => {
  const handoffSrc = readFileSync(
    path.join(REPO_ROOT, "src", "answer", "handoff_store.ts"),
    "utf8"
  );
  assert.ok(
    handoffSrc.includes("export interface HandoffStore"),
    "HandoffStore interface must still be exported"
  );
  assert.ok(
    handoffSrc.includes("export class SqliteHandoffStore"),
    "SqliteHandoffStore class must still be exported"
  );
  // The 5 HandoffStore methods must still be present.
  const expectedMethods = ["create", "getById", "getByRunId", "listByTenant", "updateStatus"];
  for (const method of expectedMethods) {
    assert.ok(
      handoffSrc.includes(`${method}(`),
      `HandoffStore must define method: ${method}`
    );
  }
});

test("T04 live source check — Summarizer interface is unchanged", () => {
  const summarizerSrc = readFileSync(
    path.join(REPO_ROOT, "src", "answer", "summarizer.ts"),
    "utf8"
  );
  assert.ok(
    summarizerSrc.includes("export interface Summarizer"),
    "Summarizer interface must still be exported"
  );
  assert.ok(
    summarizerSrc.includes("export class SummarizerImpl"),
    "SummarizerImpl class must still be exported"
  );
  // The summarize() method must still be present.
  assert.ok(
    summarizerSrc.includes("summarize("),
    "Summarizer must define summarize() method"
  );
});
