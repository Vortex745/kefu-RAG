// Ticket 31 — Close production-cycle state tests.
//
// TDD red phase: defines the expected behavior of closeProductionCycle
// BEFORE the implementation exists. Tests cover all 3 acceptance criteria:
//   #1 — Project progress reports completed and verification contains no
//        unresolved required production check.
//   #2 — The backlog closes completed production items and explicitly
//        defers only non-blocking optional work.
//   #3 — Durable memory records the canonical V2 release path, verified
//        commands, external prerequisites, and rollback boundary without
//        secrets or transient logs.

import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  closeProductionCycle,
  type ProductionCycleClosureInput,
  type DeferredItem,
} from "./close_production_cycle"

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

function makePassingClosureInput(): ProductionCycleClosureInput {
  return {
    repositoryRevision: "rev-trusted-final-abc",
    verificationStatus: {
      productionAcceptancePassed: true,
      limitedModeAcceptancePassed: true,
      defaultModeAcceptancePassed: true,
      unresolvedRequiredChecks: [],
    },
    completedTicketIds: ["21", "22", "23", "24", "25", "26", "27", "28", "29", "30"],
    deferredItems: [
      {
        id: "OP-01",
        description: "Enable real RAGAS pipeline once dependency resolves",
        category: "optional",
        reason: "External dependency unavailable in candidate environment",
      },
    ],
    durableMemory: {
      canonicalV2ReleasePath:
        "runReleaseVerification → checkPromotion → runLimitedModeCandidateAcceptance → runDefaultModePromotionAcceptance",
      verifiedCommands: [
        "npm test",
        "npx tsc --noEmit",
        "node --import tsx scripts/release-verify.ts production",
        "node --import tsx scripts/production-acceptance.ts",
      ],
      externalPrerequisites: [
        "OIDC_ISSUER / OIDC_AUDIENCE / OIDC_JWKS_ENDPOINT",
        "ES_NODE / OPENAI_API_KEY / EMBEDDING_MODEL",
        "NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD",
        "SQLITE_PATH",
        "MARKITDOWN_COMMAND / MARKER_COMMAND / MINERU_COMMAND",
        "LANGFUSE_BASE_URL / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY",
      ],
      rollbackBoundary:
        "Revert to previous git revision; no business data migration/truncation required",
    },
    evidencePaths: [
      "/tmp/release-production.json",
      "/tmp/smoke-production.json",
      "/tmp/rollback.json",
      "/tmp/smoke-critical.json",
      "/tmp/limited-mode.json",
      "/tmp/smoke-default.json",
      "/tmp/default-mode.json",
    ],
  }
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `t31-${prefix}-`))
}

// ---------------------------------------------------------------------------
// AC1 — Verification contains no unresolved required production check
// ---------------------------------------------------------------------------

test("Ticket 31 #1a: ok=true when all required checks resolved", () => {
  const closure = closeProductionCycle(makePassingClosureInput())
  assert.equal(closure.ok, true, `must be ok; reasons: ${JSON.stringify(closure.reasons)}`)
  assert.equal(closure.reasons.length, 0, "no failure reasons on success")
})

test("Ticket 31 #1b: ok=false when productionAcceptancePassed=false", () => {
  const input = makePassingClosureInput()
  input.verificationStatus.productionAcceptancePassed = false
  input.verificationStatus.unresolvedRequiredChecks.push("production_acceptance_failed")
  const closure = closeProductionCycle(input)
  assert.equal(closure.ok, false, "must fail when production acceptance failed")
  assert.ok(
    closure.reasons.some((r) => /production.?acceptance/i.test(r)),
    `reasons must mention production acceptance; got: ${JSON.stringify(closure.reasons)}`,
  )
})

test("Ticket 31 #1c: ok=false when limitedModeAcceptancePassed=false", () => {
  const input = makePassingClosureInput()
  input.verificationStatus.limitedModeAcceptancePassed = false
  input.verificationStatus.unresolvedRequiredChecks.push("limited_mode_failed")
  const closure = closeProductionCycle(input)
  assert.equal(closure.ok, false)
  assert.ok(
    closure.reasons.some((r) => /limited.?mode/i.test(r)),
    `reasons must mention limited mode; got: ${JSON.stringify(closure.reasons)}`,
  )
})

test("Ticket 31 #1d: ok=false when defaultModeAcceptancePassed=false", () => {
  const input = makePassingClosureInput()
  input.verificationStatus.defaultModeAcceptancePassed = false
  input.verificationStatus.unresolvedRequiredChecks.push("default_mode_failed")
  const closure = closeProductionCycle(input)
  assert.equal(closure.ok, false)
  assert.ok(
    closure.reasons.some((r) => /default.?mode/i.test(r)),
    `reasons must mention default mode; got: ${JSON.stringify(closure.reasons)}`,
  )
})

test("Ticket 31 #1e: unresolvedRequiredChecks is empty on success", () => {
  const closure = closeProductionCycle(makePassingClosureInput())
  assert.equal(
    closure.verificationStatus.unresolvedRequiredChecks.length,
    0,
    "no unresolved checks on success",
  )
})

test("Ticket 31 #1f: closure records verification status booleans", () => {
  const closure = closeProductionCycle(makePassingClosureInput())
  assert.equal(closure.verificationStatus.productionAcceptancePassed, true)
  assert.equal(closure.verificationStatus.limitedModeAcceptancePassed, true)
  assert.equal(closure.verificationStatus.defaultModeAcceptancePassed, true)
})

// ---------------------------------------------------------------------------
// AC2 — Backlog closes completed items + defers only non-blocking optional
// ---------------------------------------------------------------------------

test("Ticket 31 #2a: closure records completedTicketIds", () => {
  const closure = closeProductionCycle(makePassingClosureInput())
  assert.ok(
    closure.backlogClosure.completedTicketIds.length > 0,
    "must record completed tickets",
  )
  for (const id of closure.backlogClosure.completedTicketIds) {
    assert.equal(typeof id, "string")
    assert.ok(id.length > 0)
  }
})

test("Ticket 31 #2b: closure records deferredItems with non-blocking category", () => {
  const closure = closeProductionCycle(makePassingClosureInput())
  assert.ok(closure.backlogClosure.deferredItems.length > 0, "must record deferred items")
  for (const item of closure.backlogClosure.deferredItems) {
    assert.ok(
      item.category === "optional" || item.category === "non-blocking" || item.category === "future",
      `deferred item category must be non-blocking; got: ${item.category}`,
    )
    assert.equal(typeof item.reason, "string")
    assert.ok(item.reason.length > 0, "deferred item must have a reason")
  }
})

test("Ticket 31 #2c: ok=false when a deferred item has blocking category", () => {
  const input = makePassingClosureInput()
  input.deferredItems.push({
    id: "BL-01",
    description: "Required blocking work not done",
    category: "blocking" as DeferredItem["category"],
    reason: "should have been done",
  })
  const closure = closeProductionCycle(input)
  assert.equal(closure.ok, false, "must fail when a deferred item is blocking")
  assert.ok(
    closure.reasons.some((r) => /blocking/i.test(r)),
    `reasons must mention blocking; got: ${JSON.stringify(closure.reasons)}`,
  )
})

test("Ticket 31 #2d: allRequiredTicketsClosed=true on happy path", () => {
  const closure = closeProductionCycle(makePassingClosureInput())
  assert.equal(closure.backlogClosure.allRequiredTicketsClosed, true)
})

test("Ticket 31 #2e: allRequiredTicketsClosed=false when requiredTickets are missing", () => {
  const input = makePassingClosureInput()
  input.requiredTicketIds = ["21", "22", "23", "24", "25", "26", "27", "28", "29", "30", "31"]
  input.completedTicketIds = ["21", "22", "23", "24", "25", "26", "27", "28", "29", "30"] // missing 31
  const closure = closeProductionCycle(input)
  assert.equal(closure.backlogClosure.allRequiredTicketsClosed, false)
  assert.ok(
    closure.reasons.some((r) => /missing.*31|31.*missing/i.test(r)),
    `reasons must mention missing ticket 31; got: ${JSON.stringify(closure.reasons)}`,
  )
})

// ---------------------------------------------------------------------------
// AC3 — Durable memory records V2 path + commands + prereqs + rollback
// ---------------------------------------------------------------------------

test("Ticket 31 #3a: closure records canonicalV2ReleasePath", () => {
  const closure = closeProductionCycle(makePassingClosureInput())
  assert.ok(
    closure.durableMemory.canonicalV2ReleasePath.length > 0,
    "must record canonical V2 release path",
  )
  assert.ok(
    /runReleaseVerification|checkPromotion|runLimitedMode|runDefaultMode/i.test(
      closure.durableMemory.canonicalV2ReleasePath,
    ),
    "V2 release path must reference key functions",
  )
})

test("Ticket 31 #3b: closure records verifiedCommands", () => {
  const closure = closeProductionCycle(makePassingClosureInput())
  assert.ok(
    closure.durableMemory.verifiedCommands.length > 0,
    "must record verified commands",
  )
  for (const cmd of closure.durableMemory.verifiedCommands) {
    assert.equal(typeof cmd, "string")
    assert.ok(cmd.length > 0)
  }
})

test("Ticket 31 #3c: closure records externalPrerequisites", () => {
  const closure = closeProductionCycle(makePassingClosureInput())
  assert.ok(
    closure.durableMemory.externalPrerequisites.length > 0,
    "must record external prerequisites",
  )
})

test("Ticket 31 #3d: closure records rollbackBoundary", () => {
  const closure = closeProductionCycle(makePassingClosureInput())
  assert.ok(
    closure.durableMemory.rollbackBoundary.length > 0,
    "must record rollback boundary",
  )
  assert.ok(
    /revert|rollback/i.test(closure.durableMemory.rollbackBoundary),
    "rollback boundary must reference revert/rollback",
  )
})

test("Ticket 31 #3e: no secrets in serialized closure", () => {
  const input = makePassingClosureInput()
  input.durableMemory.canonicalV2ReleasePath =
    "path with Bearer eyJabc.def.ghi and sk-test-probe leaked"
  input.durableMemory.rollbackBoundary = "Revert with sk-secret-key-12345"
  const closure = closeProductionCycle(input)
  const json = JSON.stringify(closure)
  assert.ok(!json.includes("sk-test-probe"), "must not leak sk- prefixes")
  assert.ok(!json.includes("Bearer eyJabc.def.ghi"), "must not leak Bearer JWT tokens")
  assert.ok(!json.includes("sk-secret-key-12345"), "must not leak sk- secrets")
})

test("Ticket 31 #3f: no transient logs in durable memory (no timestamped log lines)", () => {
  const input = makePassingClosureInput()
  input.durableMemory.canonicalV2ReleasePath =
    "[2026-07-25T10:00:00Z] INFO starting release\n[2026-07-25T10:00:01Z] DEBUG hash=abc"
  const closure = closeProductionCycle(input)
  assert.equal(
    closure.transientLogsFound,
    true,
    "must detect transient log lines in durable memory",
  )
  // The closure should still be produced but flag the issue
  assert.ok(
    closure.reasons.some((r) => /transient|log/i.test(r)),
    `reasons must mention transient logs; got: ${JSON.stringify(closure.reasons)}`,
  )
})

test("Ticket 31 #3g: transientLogsFound=false on clean input", () => {
  const closure = closeProductionCycle(makePassingClosureInput())
  assert.equal(closure.transientLogsFound, false, "must not flag clean input as transient")
})

test("Ticket 31 #3h: redactedSecretsFound=false on clean input", () => {
  const closure = closeProductionCycle(makePassingClosureInput())
  assert.equal(closure.redactedSecretsFound, false)
})

test("Ticket 31 #3i: redactedSecretsFound=true when secrets present", () => {
  const input = makePassingClosureInput()
  input.durableMemory.rollbackBoundary = "Revert with Bearer eyJabc.def.ghi"
  const closure = closeProductionCycle(input)
  assert.equal(closure.redactedSecretsFound, true)
})

// ---------------------------------------------------------------------------
// Closure record structure
// ---------------------------------------------------------------------------

test("Ticket 31 #4a: closure records repositoryRevision", () => {
  const closure = closeProductionCycle(makePassingClosureInput())
  assert.equal(closure.repositoryRevision, "rev-trusted-final-abc")
})

test("Ticket 31 #4b: closure records closedAt as ISO 8601", () => {
  const closure = closeProductionCycle(makePassingClosureInput())
  assert.equal(typeof closure.closedAt, "string")
  assert.ok(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(closure.closedAt),
    "closedAt must be ISO 8601",
  )
})

test("Ticket 31 #4c: closure records evidencePaths", () => {
  const closure = closeProductionCycle(makePassingClosureInput())
  assert.ok(closure.evidencePaths.length > 0, "must record evidence paths")
  for (const p of closure.evidencePaths) {
    assert.equal(typeof p, "string")
  }
})

// ---------------------------------------------------------------------------
// Output file persistence
// ---------------------------------------------------------------------------

test("Ticket 31 #5a: writeClosureToFile persists JSON when outputPath provided", () => {
  const dir = makeTempDir("5a")
  try {
    const input = makePassingClosureInput()
    const outputPath = join(dir, "closure.json")
    const closure = closeProductionCycle(input, { outputPath })
    const json = readFileSync(outputPath, "utf8")
    const parsed = JSON.parse(json)
    assert.equal(parsed.repositoryRevision, "rev-trusted-final-abc")
    assert.equal(parsed.ok, true)
    assert.equal(parsed.runtimeMode, undefined, "closure record must not be runtime-specific")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Ticket 31 #5b: written closure file contains no secrets", () => {
  const dir = makeTempDir("5b")
  try {
    const input = makePassingClosureInput()
    input.durableMemory.rollbackBoundary = "Revert with sk-test-probe leaked"
    const outputPath = join(dir, "closure.json")
    closeProductionCycle(input, { outputPath })
    const json = readFileSync(outputPath, "utf8")
    assert.ok(!json.includes("sk-test-probe"), "persisted file must not leak secrets")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("Ticket 31 #6a: empty deferredItems is allowed (no optional work to defer)", () => {
  const input = makePassingClosureInput()
  input.deferredItems = []
  const closure = closeProductionCycle(input)
  assert.equal(closure.ok, true, "empty deferred items must not fail")
  assert.equal(closure.backlogClosure.deferredItems.length, 0)
})

test("Ticket 31 #6b: empty verifiedCommands fails (must record at least one)", () => {
  const input = makePassingClosureInput()
  input.durableMemory.verifiedCommands = []
  const closure = closeProductionCycle(input)
  assert.equal(closure.ok, false, "must fail when no verified commands recorded")
  assert.ok(
    closure.reasons.some((r) => /command/i.test(r)),
    `reasons must mention commands; got: ${JSON.stringify(closure.reasons)}`,
  )
})

test("Ticket 31 #6c: empty externalPrerequisites fails (must record prerequisites)", () => {
  const input = makePassingClosureInput()
  input.durableMemory.externalPrerequisites = []
  const closure = closeProductionCycle(input)
  assert.equal(closure.ok, false)
  assert.ok(
    closure.reasons.some((r) => /prerequisit|prerequisite/i.test(r)),
    `reasons must mention prerequisites; got: ${JSON.stringify(closure.reasons)}`,
  )
})
