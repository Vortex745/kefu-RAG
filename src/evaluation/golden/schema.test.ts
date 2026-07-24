import assert from "node:assert/strict"
import test from "node:test"
import { validateGoldenCase, validateGoldenSet } from "./schema"
import type { GoldenCase, GoldenCaseCategory, GoldenSet } from "../types"
import { REQUIRED_CATEGORY_COUNTS } from "../types"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeCase(overrides: Partial<GoldenCase> = {}): GoldenCase {
  return {
    id: "simple-01",
    version: 1,
    category: "simple",
    userMessage: "What is the refund policy for orders placed within 30 days?",
    expectedRoute: "simple",
    expectedSourceIds: ["src-policy-refund-01"],
    acceptableEvidenceIds: [],
    requiredCoverageCriteria: ["refund window", "exceptions"],
    handoffAcceptable: false,
    notes: "Standard refund-policy question.",
    ...overrides,
  }
}

function makeCaseForCategory(category: GoldenCaseCategory, index: number): GoldenCase {
  const id = `${category}-${String(index).padStart(2, "0")}`
  const base: GoldenCase = {
    id,
    version: 1,
    category,
    userMessage: `Synthetic ${category} case ${index}`,
    expectedSourceIds: [],
    acceptableEvidenceIds: [],
  }
  if (category === "direct") {
    base.expectedRoute = "direct"
    base.userMessage = `Hello, case ${index}`
  } else if (category === "simple") {
    base.expectedRoute = "simple"
    base.expectedSourceIds = [`src-${id}`]
    base.requiredCoverageCriteria = ["coverage"]
  } else if (category === "complex") {
    base.expectedRoute = "complex"
    base.expectedSourceIds = [`src-${id}`]
    base.requiredCoverageCriteria = ["coverage-a", "coverage-b"]
  } else if (category === "ambiguous") {
    base.expectedRoute = "ambiguous"
    base.userMessage = `I need help with case ${index}`
  } else if (category === "insufficient") {
    base.expectedRoute = "simple"
    base.acceptableEvidenceIds = [`ev-${id}`]
    base.handoffAcceptable = true
  } else if (category === "correction") {
    base.expectedRoute = "complex"
    base.expectedSourceIds = [`src-${id}`]
    base.requiredCoverageCriteria = ["coverage-a"]
  }
  return base
}

function buildValidCases(): GoldenCase[] {
  const cases: GoldenCase[] = []
  const categories: GoldenCaseCategory[] = [
    "direct",
    "simple",
    "complex",
    "ambiguous",
    "insufficient",
    "correction",
  ]
  for (const cat of categories) {
    const count = REQUIRED_CATEGORY_COUNTS[cat]
    for (let i = 1; i <= count; i++) {
      cases.push(makeCaseForCategory(cat, i))
    }
  }
  return cases
}

function makeSet(cases?: GoldenCase[]): GoldenSet {
  return {
    version: "2026.07",
    cases: cases ?? buildValidCases(),
  }
}

// ===========================================================================
// validateGoldenCase
// ===========================================================================

test("Ticket 10 P1: validateGoldenCase accepts a valid case and returns it typed", () => {
  const input = makeCase()
  const result = validateGoldenCase(input)
  assert.equal(result.id, "simple-01")
  assert.equal(result.version, 1)
  assert.equal(result.category, "simple")
  assert.equal(result.expectedRoute, "simple")
  assert.deepEqual(result.expectedSourceIds, ["src-policy-refund-01"])
  assert.deepEqual(result.acceptableEvidenceIds, [])
})

test("Ticket 10 P1: validateGoldenCase accepts a direct case with empty source/evidence arrays (no retrieval)", () => {
  const input = makeCase({
    id: "direct-01",
    category: "direct",
    expectedRoute: "direct",
    userMessage: "Hello",
    expectedSourceIds: [],
    acceptableEvidenceIds: [],
  })
  const result = validateGoldenCase(input)
  assert.equal(result.category, "direct")
})

test("Ticket 10 P1: validateGoldenCase accepts an ambiguous case with empty source/evidence arrays (no retrieval until resumed)", () => {
  const input = makeCase({
    id: "ambiguous-01",
    category: "ambiguous",
    expectedRoute: "ambiguous",
    userMessage: "I need help",
    expectedSourceIds: [],
    acceptableEvidenceIds: [],
  })
  const result = validateGoldenCase(input)
  assert.equal(result.category, "ambiguous")
})

test("Ticket 10 P1: validateGoldenCase rejects non-object input", () => {
  assert.throws(
    () => validateGoldenCase("not-an-object"),
    /must be an object/i,
  )
})

test("Ticket 10 P1: validateGoldenCase rejects null input", () => {
  assert.throws(
    () => validateGoldenCase(null),
    /must be an object/i,
  )
})

test("Ticket 10 P1: validateGoldenCase rejects missing id", () => {
  const { id: _omit, ...rest } = makeCase()
  void _omit
  assert.throws(
    () => validateGoldenCase(rest),
    /missing required field 'id'/i,
  )
})

test("Ticket 10 P1: validateGoldenCase rejects empty id", () => {
  assert.throws(
    () => validateGoldenCase(makeCase({ id: "" })),
    /'id' must be a non-empty string/i,
  )
})

test("Ticket 10 P1: validateGoldenCase rejects non-string id", () => {
  assert.throws(
    () => validateGoldenCase(makeCase({ id: 42 as unknown as string })),
    /'id' must be a non-empty string/i,
  )
})

test("Ticket 10 P1: validateGoldenCase rejects missing version", () => {
  const { version: _omit, ...rest } = makeCase()
  void _omit
  assert.throws(
    () => validateGoldenCase(rest),
    /missing required field 'version'/i,
  )
})

test("Ticket 10 P1: validateGoldenCase rejects non-positive version", () => {
  assert.throws(
    () => validateGoldenCase(makeCase({ version: 0 })),
    /'version' must be a positive integer/i,
  )
})

test("Ticket 10 P1: validateGoldenCase rejects non-integer version", () => {
  assert.throws(
    () => validateGoldenCase(makeCase({ version: 1.5 })),
    /'version' must be a positive integer/i,
  )
})

test("Ticket 10 P1: validateGoldenCase rejects missing category", () => {
  const { category: _omit, ...rest } = makeCase()
  void _omit
  assert.throws(
    () => validateGoldenCase(rest),
    /missing required field 'category'/i,
  )
})

test("Ticket 10 P1: validateGoldenCase rejects invalid category string", () => {
  assert.throws(
    () => validateGoldenCase(makeCase({ category: "chitchat" as unknown as GoldenCaseCategory })),
    /'category' must be one of/i,
  )
})

test("Ticket 10 P1: validateGoldenCase rejects missing userMessage", () => {
  const { userMessage: _omit, ...rest } = makeCase()
  void _omit
  assert.throws(
    () => validateGoldenCase(rest),
    /missing required field 'userMessage'/i,
  )
})

test("Ticket 10 P1: validateGoldenCase rejects empty userMessage", () => {
  assert.throws(
    () => validateGoldenCase(makeCase({ userMessage: "" })),
    /'userMessage' must be a non-empty string/i,
  )
})

test("Ticket 10 P1: validateGoldenCase rejects invalid expectedRoute string", () => {
  assert.throws(
    () => validateGoldenCase(makeCase({ expectedRoute: "chitchat" as unknown as GoldenCase["expectedRoute"] })),
    /'expectedRoute' must be one of/i,
  )
})

test("Ticket 10 P1: validateGoldenCase rejects non-array expectedSourceIds", () => {
  assert.throws(
    () => validateGoldenCase(makeCase({ expectedSourceIds: "src-1" as unknown as string[] })),
    /'expectedSourceIds' must be an array/i,
  )
})

test("Ticket 10 P1: validateGoldenCase rejects non-string element in expectedSourceIds", () => {
  assert.throws(
    () => validateGoldenCase(makeCase({ expectedSourceIds: [42 as unknown as string] })),
    /'expectedSourceIds\[\]' must contain only non-empty strings/i,
  )
})

test("Ticket 10 P1: validateGoldenCase rejects empty-string element in expectedSourceIds", () => {
  assert.throws(
    () => validateGoldenCase(makeCase({ expectedSourceIds: [""] })),
    /'expectedSourceIds\[\]' must contain only non-empty strings/i,
  )
})

test("Ticket 10 P1: validateGoldenCase rejects non-array acceptableEvidenceIds", () => {
  assert.throws(
    () => validateGoldenCase(makeCase({ acceptableEvidenceIds: "ev-1" as unknown as string[] })),
    /'acceptableEvidenceIds' must be an array/i,
  )
})

test("Ticket 10 P1: validateGoldenCase rejects knowledge route 'simple' without any expected source or acceptable evidence", () => {
  assert.throws(
    () => validateGoldenCase(
      makeCase({
        expectedSourceIds: [],
        acceptableEvidenceIds: [],
      }),
    ),
    /knowledge route 'simple' requires at least one of expectedSourceIds or acceptableEvidenceIds/i,
  )
})

test("Ticket 10 P1: validateGoldenCase rejects knowledge route 'complex' without any expected source or acceptable evidence", () => {
  assert.throws(
    () => validateGoldenCase(
      makeCase({
        id: "complex-01",
        category: "complex",
        expectedRoute: "complex",
        expectedSourceIds: [],
        acceptableEvidenceIds: [],
      }),
    ),
    /knowledge route 'complex' requires at least one of expectedSourceIds or acceptableEvidenceIds/i,
  )
})

test("Ticket 10 P1: validateGoldenCase rejects knowledge route 'insufficient' without any expected source or acceptable evidence", () => {
  assert.throws(
    () => validateGoldenCase(
      makeCase({
        id: "insufficient-01",
        category: "insufficient",
        expectedRoute: "simple",
        expectedSourceIds: [],
        acceptableEvidenceIds: [],
      }),
    ),
    /knowledge route 'insufficient' requires at least one of expectedSourceIds or acceptableEvidenceIds/i,
  )
})

test("Ticket 10 P1: validateGoldenCase rejects knowledge route 'correction' without any expected source or acceptable evidence", () => {
  assert.throws(
    () => validateGoldenCase(
      makeCase({
        id: "correction-01",
        category: "correction",
        expectedRoute: "complex",
        expectedSourceIds: [],
        acceptableEvidenceIds: [],
      }),
    ),
    /knowledge route 'correction' requires at least one of expectedSourceIds or acceptableEvidenceIds/i,
  )
})

test("Ticket 10 P1: validateGoldenCase accepts knowledge route with expectedSourceIds but empty acceptableEvidenceIds", () => {
  const result = validateGoldenCase(makeCase({ expectedSourceIds: ["src-1"], acceptableEvidenceIds: [] }))
  assert.deepEqual(result.expectedSourceIds, ["src-1"])
})

test("Ticket 10 P1: validateGoldenCase accepts knowledge route with acceptableEvidenceIds but empty expectedSourceIds", () => {
  const result = validateGoldenCase(
    makeCase({ expectedSourceIds: [], acceptableEvidenceIds: ["ev-1"] }),
  )
  assert.deepEqual(result.acceptableEvidenceIds, ["ev-1"])
})

test("Ticket 10 P1: validateGoldenCase rejects non-array requiredCoverageCriteria", () => {
  assert.throws(
    () => validateGoldenCase(makeCase({ requiredCoverageCriteria: "coverage" as unknown as string[] })),
    /'requiredCoverageCriteria' must be an array/i,
  )
})

test("Ticket 10 P1: validateGoldenCase rejects non-boolean handoffAcceptable", () => {
  assert.throws(
    () => validateGoldenCase(makeCase({ handoffAcceptable: "yes" as unknown as boolean })),
    /'handoffAcceptable' must be a boolean/i,
  )
})

test("Ticket 10 P1: validateGoldenCase rejects non-string notes", () => {
  assert.throws(
    () => validateGoldenCase(makeCase({ notes: 42 as unknown as string })),
    /'notes' must be a string/i,
  )
})

// ===========================================================================
// validateGoldenSet
// ===========================================================================

test("Ticket 10 P1: validateGoldenSet accepts a valid 60-case set", () => {
  const set = makeSet()
  const result = validateGoldenSet(set)
  assert.equal(result.version, "2026.07")
  assert.equal(result.cases.length, 60)
})

test("Ticket 10 P1: validateGoldenSet rejects non-object input", () => {
  assert.throws(
    () => validateGoldenSet("not-an-object"),
    /must be an object/i,
  )
})

test("Ticket 10 P1: validateGoldenSet rejects null input", () => {
  assert.throws(
    () => validateGoldenSet(null),
    /must be an object/i,
  )
})

test("Ticket 10 P1: validateGoldenSet rejects missing version", () => {
  const { version: _omit, ...rest } = makeSet()
  void _omit
  assert.throws(
    () => validateGoldenSet(rest),
    /missing required field 'version'/i,
  )
})

test("Ticket 10 P1: validateGoldenSet rejects empty version", () => {
  assert.throws(
    () => validateGoldenSet({ version: "", cases: buildValidCases() }),
    /'version' must be a non-empty string/i,
  )
})

test("Ticket 10 P1: validateGoldenSet rejects missing cases array", () => {
  const { cases: _omit, ...rest } = makeSet()
  void _omit
  assert.throws(
    () => validateGoldenSet(rest),
    /missing required field 'cases'/i,
  )
})

test("Ticket 10 P1: validateGoldenSet rejects fewer than 60 cases", () => {
  const shortCases = buildValidCases().slice(0, 59)
  assert.throws(
    () => validateGoldenSet({ version: "2026.07", cases: shortCases }),
    /at least 60/i,
  )
})

test("Ticket 10 P1: validateGoldenSet rejects direct category with fewer than 10 cases", () => {
  // Keep total >= 60 so the 60-case minimum does not fire first; instead
  // the per-category count check must catch the deficit.
  const cases = buildValidCases()
  const idx = cases.findIndex((c) => c.category === "direct")
  cases[idx] = makeCaseForCategory("simple", 99) // direct 10→9, simple 15→16
  assert.equal(cases.length, 60)
  assert.throws(
    () => validateGoldenSet({ version: "2026.07", cases }),
    /category 'direct' has 9 cases but requires at least 10/i,
  )
})

test("Ticket 10 P1: validateGoldenSet rejects simple category with fewer than 15 cases", () => {
  const cases = buildValidCases()
  const idx = cases.findIndex((c) => c.category === "simple")
  cases[idx] = makeCaseForCategory("direct", 99) // simple 15→14, direct 10→11
  assert.equal(cases.length, 60)
  assert.throws(
    () => validateGoldenSet({ version: "2026.07", cases }),
    /category 'simple' has 14 cases but requires at least 15/i,
  )
})

test("Ticket 10 P1: validateGoldenSet rejects correction category with fewer than 5 cases", () => {
  const cases = buildValidCases()
  const idx = cases.findIndex((c) => c.category === "correction")
  cases[idx] = makeCaseForCategory("direct", 99) // correction 5→4, direct 10→11
  assert.equal(cases.length, 60)
  assert.throws(
    () => validateGoldenSet({ version: "2026.07", cases }),
    /category 'correction' has 4 cases but requires at least 5/i,
  )
})

test("Ticket 10 P1: validateGoldenSet accepts more than the minimum per category", () => {
  const cases = buildValidCases()
  cases.push(makeCaseForCategory("direct", 99))
  assert.equal(cases.length, 61)
  const result = validateGoldenSet({ version: "2026.07", cases })
  assert.equal(result.cases.length, 61)
})

test("Ticket 10 P1: validateGoldenSet rejects duplicate case ids", () => {
  const cases = buildValidCases()
  // Replace second case's id with the first case's id — duplicate
  cases[1] = { ...cases[1], id: cases[0].id }
  assert.throws(
    () => validateGoldenSet({ version: "2026.07", cases }),
    /duplicate case id/i,
  )
})

test("Ticket 10 P1: validateGoldenSet propagates per-case validation errors", () => {
  const cases = buildValidCases()
  // Corrupt one case — empty userMessage
  cases[5] = { ...cases[5], userMessage: "" }
  assert.throws(
    () => validateGoldenSet({ version: "2026.07", cases }),
    /'userMessage' must be a non-empty string/i,
  )
})

test("Ticket 10 P1: validateGoldenSet error message includes the failing case id when possible", () => {
  const cases = buildValidCases()
  cases[7] = { ...cases[7], userMessage: "" }
  const failingId = cases[7].id
  assert.throws(
    () => validateGoldenSet({ version: "2026.07", cases }),
    new RegExp(`case '${failingId}'`, "i"),
  )
})
