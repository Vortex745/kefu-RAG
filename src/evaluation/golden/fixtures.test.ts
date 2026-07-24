// Ticket 10 Phase D P2 — Golden set fixtures acceptance tests.
//
// Spec §9 L1556-1557 acceptance:
//   - At least 60 versioned cases across 6 categories
//   - Each knowledge case declares expected Source identities or acceptable
//     Evidence IDs, required coverage criteria, and whether handoff is
//     acceptable.
//   - Bounded, synthetic, committed without private data (spec L1568).
//
// These tests verify the checked-in GOLDEN_SET against P1's schema validator
// and against per-category invariants that go beyond structural validation:
//   - Knowledge routes (simple/complex/insufficient/correction) MUST have
//     at least one source/evidence
//   - Correction cases MUST have >= 5 requiredCoverageCriteria (multi-turn
//     bounded correction needs detailed acceptance)
//   - Ambiguous cases MUST NOT declare sources/evidence (no retrieval until
//     resumed) and MUST set handoffAcceptable=true
//   - Dataset version MUST be a non-empty string

import test from "node:test"
import assert from "node:assert/strict"

import { GOLDEN_SET, FIXTURE_COUNTS } from "./fixtures"
import { validateGoldenSet } from "./schema"
import { REQUIRED_CATEGORY_COUNTS, type GoldenCaseCategory } from "../types"

const KNOWLEDGE_ROUTE_CATEGORIES: readonly GoldenCaseCategory[] = [
  "simple", "complex", "insufficient", "correction",
]

test("Ticket 10 P2: GOLDEN_SET passes validateGoldenSet (structural schema)", () => {
  // Red phase: throws if GOLDEN_SET missing / shape invalid.
  // Green phase: returns typed GoldenSet.
  const validated = validateGoldenSet(GOLDEN_SET)
  assert.equal(validated.version, GOLDEN_SET.version)
  assert.equal(validated.cases.length, GOLDEN_SET.cases.length)
})

test("Ticket 10 P2: GOLDEN_SET has dataset version matching YYYY.MM pattern", () => {
  // Ticket 10: version bumped to '2026.07.t10' to mark tool-loop case additions.
  // The pattern allows an optional '.tNN' suffix for ticket-scoped dataset bumps.
  assert.match(GOLDEN_SET.version, /^\d{4}\.\d{2}(\.t\d+)?$/)
})

test("Ticket 10 P2: GOLDEN_SET contains at least 60 cases (spec L1556)", () => {
  assert.ok(
    GOLDEN_SET.cases.length >= 60,
    `GOLDEN_SET must contain at least 60 cases (got ${GOLDEN_SET.cases.length})`,
  )
})

test("Ticket 10 P2: GOLDEN_SET meets per-category minimum counts (spec L1556)", () => {
  const counts: Record<GoldenCaseCategory, number> = {
    direct: 0, simple: 0, complex: 0, ambiguous: 0, insufficient: 0, correction: 0,
  }
  for (const c of GOLDEN_SET.cases) counts[c.category]++
  for (const cat of Object.keys(REQUIRED_CATEGORY_COUNTS) as GoldenCaseCategory[]) {
    assert.ok(
      counts[cat] >= REQUIRED_CATEGORY_COUNTS[cat],
      `category '${cat}' must contain at least ${REQUIRED_CATEGORY_COUNTS[cat]} cases (got ${counts[cat]})`,
    )
  }
})

test("Ticket 10 P2: FIXTURE_COUNTS helper matches actual counts", () => {
  const counts: Record<GoldenCaseCategory, number> = {
    direct: 0, simple: 0, complex: 0, ambiguous: 0, insufficient: 0, correction: 0,
  }
  for (const c of GOLDEN_SET.cases) counts[c.category]++
  for (const cat of Object.keys(FIXTURE_COUNTS) as GoldenCaseCategory[]) {
    assert.equal(FIXTURE_COUNTS[cat], counts[cat])
  }
})

test("Ticket 10 P2: case ids are unique and follow '<category>-<NN>' or '<category>-tool-<NN>[c]' format", () => {
  const seen = new Set<string>()
  // Tool-loop cases (Ticket 10) use '<category>-tool-<NN>' or '<category>-tool-<NN>c'
  // (compressed variant). The optional 'c' suffix marks compressed-context cases.
  const idPattern = /^(direct|simple|complex|ambiguous|insufficient|correction)(-tool)?-\d+[a-z]?$/
  for (const c of GOLDEN_SET.cases) {
    assert.ok(!seen.has(c.id), `duplicate case id: ${c.id}`)
    seen.add(c.id)
    assert.match(c.id, idPattern, `id '${c.id}' does not match '<category>-<NN>' or '<category>-tool-<NN>[c]' format`)
  }
})

test("Ticket 10 P2: knowledge route cases declare >=1 source or evidence (spec L1557)", () => {
  for (const c of GOLDEN_SET.cases) {
    if (!KNOWLEDGE_ROUTE_CATEGORIES.includes(c.category)) continue
    const total = c.expectedSourceIds.length + c.acceptableEvidenceIds.length
    assert.ok(
      total > 0,
      `knowledge route case '${c.id}' (category=${c.category}) must declare at least one expectedSourceId or acceptableEvidenceId`,
    )
  }
})

test("Ticket 10 P2: knowledge route cases declare requiredCoverageCriteria", () => {
  for (const c of GOLDEN_SET.cases) {
    if (!KNOWLEDGE_ROUTE_CATEGORIES.includes(c.category)) continue
    assert.ok(
      c.requiredCoverageCriteria && c.requiredCoverageCriteria.length > 0,
      `knowledge route case '${c.id}' (category=${c.category}) must declare requiredCoverageCriteria`,
    )
  }
})

test("Ticket 10 P2: ambiguous cases do NOT declare sources/evidence (no retrieval until resumed)", () => {
  for (const c of GOLDEN_SET.cases) {
    if (c.category !== "ambiguous") continue
    assert.equal(c.expectedSourceIds.length, 0, `ambiguous case '${c.id}' must not declare expectedSourceIds`)
    assert.equal(c.acceptableEvidenceIds.length, 0, `ambiguous case '${c.id}' must not declare acceptableEvidenceIds`)
    assert.equal(c.expectedRoute, "ambiguous", `ambiguous case '${c.id}' must have expectedRoute=ambiguous`)
  }
})

test("Ticket 10 P2: ambiguous cases set handoffAcceptable=true (terminal=clarification_required)", () => {
  for (const c of GOLDEN_SET.cases) {
    if (c.category !== "ambiguous") continue
    assert.equal(c.handoffAcceptable, true, `ambiguous case '${c.id}' must set handoffAcceptable=true`)
  }
})

test("Ticket 10 P2: direct cases have no sources/evidence (no Retrieval needed)", () => {
  for (const c of GOLDEN_SET.cases) {
    if (c.category !== "direct") continue
    assert.equal(c.expectedSourceIds.length, 0, `direct case '${c.id}' must not declare expectedSourceIds`)
    assert.equal(c.acceptableEvidenceIds.length, 0, `direct case '${c.id}' must not declare acceptableEvidenceIds`)
    assert.equal(c.expectedRoute, "direct", `direct case '${c.id}' must have expectedRoute=direct`)
  }
})

test("Ticket 10 P2: correction cases have >=5 requiredCoverageCriteria (multi-turn bounded correction)", () => {
  for (const c of GOLDEN_SET.cases) {
    if (c.category !== "correction") continue
    const n = c.requiredCoverageCriteria?.length ?? 0
    assert.ok(
      n >= 5,
      `correction case '${c.id}' must declare >=5 requiredCoverageCriteria (got ${n}) — multi-turn bounded correction requires detailed acceptance`,
    )
    assert.equal(c.handoffAcceptable, true, `correction case '${c.id}' must set handoffAcceptable=true`)
  }
})

test("Ticket 10 P2: insufficient cases set handoffAcceptable=true (terminal=insufficient_evidence or handoff_required)", () => {
  for (const c of GOLDEN_SET.cases) {
    if (c.category !== "insufficient") continue
    assert.equal(c.handoffAcceptable, true, `insufficient case '${c.id}' must set handoffAcceptable=true`)
  }
})

test("Ticket 10 P2: complex cases set handoffAcceptable=true (legitimate handoff when evidence incomplete)", () => {
  for (const c of GOLDEN_SET.cases) {
    if (c.category !== "complex") continue
    assert.equal(c.handoffAcceptable, true, `complex case '${c.id}' must set handoffAcceptable=true`)
  }
})

test("Ticket 10 P2: all userMessage strings are non-empty and bounded (no secrets / no PII)", () => {
  for (const c of GOLDEN_SET.cases) {
    assert.ok(c.userMessage.length > 0, `case '${c.id}' has empty userMessage`)
    assert.ok(
      c.userMessage.length <= 500,
      `case '${c.id}' userMessage too long (${c.userMessage.length} > 500 chars) — keep fixtures bounded`,
    )
    // No phone numbers, emails, or obvious PII patterns.
    assert.doesNotMatch(c.userMessage, /\b\d{11}\b/, `case '${c.id}' userMessage looks like a phone number`)
    assert.doesNotMatch(c.userMessage, /\b[\w.+-]+@[\w-]+\.\w+\b/, `case '${c.id}' userMessage looks like an email`)
  }
})

test("Ticket 10 P2: case version is always 1 (initial dataset)", () => {
  for (const c of GOLDEN_SET.cases) {
    assert.equal(c.version, 1, `case '${c.id}' must start at version 1`)
  }
})

test("Ticket 10 P2: all source IDs follow 'source-<slug>' convention", () => {
  for (const c of GOLDEN_SET.cases) {
    for (const sid of c.expectedSourceIds) {
      assert.match(sid, /^source-[a-z0-9-]+$/, `case '${c.id}': source id '${sid}' must follow 'source-<slug>' convention`)
    }
  }
})

test("Ticket 10 P2: all evidence IDs follow 'evidence-<slug>' convention", () => {
  for (const c of GOLDEN_SET.cases) {
    for (const eid of c.acceptableEvidenceIds) {
      assert.match(eid, /^evidence-[a-z0-9-]+$/, `case '${c.id}': evidence id '${eid}' must follow 'evidence-<slug>' convention`)
    }
  }
})
