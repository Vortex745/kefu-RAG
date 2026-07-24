// Ticket 10 Phase D P1 — Golden set structural schema validation.
//
// Spec §9 L1556-1557: the golden set contains at least 60 versioned cases
// across 6 categories. Each knowledge case declares expected Source
// identities or acceptable Evidence IDs, required coverage criteria, and
// whether handoff is acceptable. It does not embed secrets or unrestricted
// production conversations.
//
// This module validates STRUCTURE only — content-level review (no secrets,
// no unrestricted production conversations) is the fixture author's
// responsibility and code review's responsibility at P2.
//
// Hand-written type guards (no ajv / no external schema library) per
// karpathy guideline #2 (simplicity first) — the schema is small and fixed.

import type {
  GoldenCase,
  GoldenCaseCategory,
  GoldenSet,
  ToolLoopScenario,
} from "../types"
import { REQUIRED_CATEGORY_COUNTS } from "../types"

const VALID_CATEGORIES: readonly GoldenCaseCategory[] = [
  "direct",
  "simple",
  "complex",
  "ambiguous",
  "insufficient",
  "correction",
]

const VALID_ROUTES: readonly string[] = [
  "direct",
  "simple",
  "ambiguous",
  "complex",
]

const VALID_SCENARIOS: readonly ToolLoopScenario[] = [
  "single-tool",
  "multi-tool",
  "duplicate-call",
  "budget-exhaustion",
  "cancellation",
  "deterministic-fallback",
]

/**
 * Categories that MUST declare at least one of expectedSourceIds or
 * acceptableEvidenceIds (i.e. knowledge routes per spec L1557).
 * `direct` bypasses retrieval; `ambiguous` does not retrieve until resumed.
 */
const KNOWLEDGE_ROUTE_CATEGORIES: readonly GoldenCaseCategory[] = [
  "simple",
  "complex",
  "insufficient",
  "correction",
]

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false
  return value.every((v) => typeof v === "string" && v.length > 0)
}

/**
 * Validate a single GoldenCase structurally. Throws on invalid input.
 * Returns the typed GoldenCase on success.
 */
export function validateGoldenCase(input: unknown): GoldenCase {
  if (!isPlainObject(input)) {
    throw new Error("GoldenCase must be an object")
  }

  // id — required non-empty string
  if (!("id" in input)) {
    throw new Error("GoldenCase: missing required field 'id'")
  }
  if (!isNonEmptyString(input.id)) {
    throw new Error("GoldenCase: 'id' must be a non-empty string")
  }
  const id = input.id

  // version — required positive integer
  if (!("version" in input)) {
    throw new Error(`GoldenCase '${id}': missing required field 'version'`)
  }
  if (!isPositiveInteger(input.version)) {
    throw new Error(`GoldenCase '${id}': 'version' must be a positive integer`)
  }
  const version = input.version

  // category — required, must be one of the 6 valid values
  if (!("category" in input)) {
    throw new Error(`GoldenCase '${id}': missing required field 'category'`)
  }
  if (!isNonEmptyString(input.category) || !VALID_CATEGORIES.includes(input.category as GoldenCaseCategory)) {
    throw new Error(
      `GoldenCase '${id}': 'category' must be one of ${VALID_CATEGORIES.join("|")}`,
    )
  }
  const category = input.category as GoldenCaseCategory

  // userMessage — required non-empty string
  if (!("userMessage" in input)) {
    throw new Error(`GoldenCase '${id}': missing required field 'userMessage'`)
  }
  if (!isNonEmptyString(input.userMessage)) {
    throw new Error(`GoldenCase '${id}': 'userMessage' must be a non-empty string`)
  }
  const userMessage = input.userMessage

  // expectedRoute — optional, but if present must be a valid route
  let expectedRoute: GoldenCase["expectedRoute"]
  if ("expectedRoute" in input && input.expectedRoute !== undefined) {
    if (!isNonEmptyString(input.expectedRoute) || !VALID_ROUTES.includes(input.expectedRoute)) {
      throw new Error(
        `GoldenCase '${id}': 'expectedRoute' must be one of ${VALID_ROUTES.join("|")}`,
      )
    }
    expectedRoute = input.expectedRoute as GoldenCase["expectedRoute"]
  }

  // expectedSourceIds — required array of non-empty strings
  if (!("expectedSourceIds" in input)) {
    throw new Error(`GoldenCase '${id}': missing required field 'expectedSourceIds'`)
  }
  if (!Array.isArray(input.expectedSourceIds)) {
    throw new Error(`GoldenCase '${id}': 'expectedSourceIds' must be an array`)
  }
  if (!isNonEmptyStringArray(input.expectedSourceIds)) {
    throw new Error(`GoldenCase '${id}': 'expectedSourceIds[]' must contain only non-empty strings`)
  }
  const expectedSourceIds = input.expectedSourceIds

  // acceptableEvidenceIds — required array of non-empty strings
  if (!("acceptableEvidenceIds" in input)) {
    throw new Error(`GoldenCase '${id}': missing required field 'acceptableEvidenceIds'`)
  }
  if (!Array.isArray(input.acceptableEvidenceIds)) {
    throw new Error(`GoldenCase '${id}': 'acceptableEvidenceIds' must be an array`)
  }
  if (!isNonEmptyStringArray(input.acceptableEvidenceIds)) {
    throw new Error(`GoldenCase '${id}': 'acceptableEvidenceIds[]' must contain only non-empty strings`)
  }
  const acceptableEvidenceIds = input.acceptableEvidenceIds

  // Knowledge route invariant (spec L1557): simple/complex/insufficient/correction
  // must declare at least one of expectedSourceIds or acceptableEvidenceIds.
  if (
    KNOWLEDGE_ROUTE_CATEGORIES.includes(category) &&
    expectedSourceIds.length === 0 &&
    acceptableEvidenceIds.length === 0
  ) {
    throw new Error(
      `GoldenCase '${id}': knowledge route '${category}' requires at least one of expectedSourceIds or acceptableEvidenceIds`,
    )
  }

  // requiredCoverageCriteria — optional array of non-empty strings
  let requiredCoverageCriteria: string[] | undefined
  if ("requiredCoverageCriteria" in input && input.requiredCoverageCriteria !== undefined) {
    if (!Array.isArray(input.requiredCoverageCriteria)) {
      throw new Error(`GoldenCase '${id}': 'requiredCoverageCriteria' must be an array`)
    }
    if (!isNonEmptyStringArray(input.requiredCoverageCriteria)) {
      throw new Error(`GoldenCase '${id}': 'requiredCoverageCriteria[]' must contain only non-empty strings`)
    }
    requiredCoverageCriteria = input.requiredCoverageCriteria
  }

  // handoffAcceptable — optional boolean
  let handoffAcceptable: boolean | undefined
  if ("handoffAcceptable" in input && input.handoffAcceptable !== undefined) {
    if (typeof input.handoffAcceptable !== "boolean") {
      throw new Error(`GoldenCase '${id}': 'handoffAcceptable' must be a boolean`)
    }
    handoffAcceptable = input.handoffAcceptable
  }

  // notes — optional string
  let notes: string | undefined
  if ("notes" in input && input.notes !== undefined) {
    if (typeof input.notes !== "string") {
      throw new Error(`GoldenCase '${id}': 'notes' must be a string`)
    }
    notes = input.notes
  }

  // Ticket 10: scenario — optional, must be a valid ToolLoopScenario
  let scenario: GoldenCase["scenario"]
  if ("scenario" in input && input.scenario !== undefined) {
    if (!isNonEmptyString(input.scenario) || !VALID_SCENARIOS.includes(input.scenario as ToolLoopScenario)) {
      throw new Error(
        `GoldenCase '${id}': 'scenario' must be one of ${VALID_SCENARIOS.join("|")}`,
      )
    }
    scenario = input.scenario as ToolLoopScenario
  }

  // Ticket 10: expectedMaxIterations — optional positive integer
  let expectedMaxIterations: number | undefined
  if ("expectedMaxIterations" in input && input.expectedMaxIterations !== undefined) {
    if (!isPositiveInteger(input.expectedMaxIterations)) {
      throw new Error(`GoldenCase '${id}': 'expectedMaxIterations' must be a positive integer`)
    }
    expectedMaxIterations = input.expectedMaxIterations
  }

  // Ticket 10: expectedMaxToolCalls — optional positive integer
  let expectedMaxToolCalls: number | undefined
  if ("expectedMaxToolCalls" in input && input.expectedMaxToolCalls !== undefined) {
    if (!isPositiveInteger(input.expectedMaxToolCalls)) {
      throw new Error(`GoldenCase '${id}': 'expectedMaxToolCalls' must be a positive integer`)
    }
    expectedMaxToolCalls = input.expectedMaxToolCalls
  }

  // Ticket 10: expectedFallback — optional boolean
  let expectedFallback: boolean | undefined
  if ("expectedFallback" in input && input.expectedFallback !== undefined) {
    if (typeof input.expectedFallback !== "boolean") {
      throw new Error(`GoldenCase '${id}': 'expectedFallback' must be a boolean`)
    }
    expectedFallback = input.expectedFallback
  }

  // Ticket 10: compressed — optional boolean
  let compressed: boolean | undefined
  if ("compressed" in input && input.compressed !== undefined) {
    if (typeof input.compressed !== "boolean") {
      throw new Error(`GoldenCase '${id}': 'compressed' must be a boolean`)
    }
    compressed = input.compressed
  }

  // Ticket 15: referenceAnswer — optional non-empty string (bounded reference
  // answer for the subset of cases evaluated by RAGAS). When present, the case
  // is RAGAS-eligible (subject to CaseResult reaching `completed`).
  let referenceAnswer: string | undefined
  if ("referenceAnswer" in input && input.referenceAnswer !== undefined) {
    if (typeof input.referenceAnswer !== "string") {
      throw new Error(`GoldenCase '${id}': 'referenceAnswer' must be a string`)
    }
    if (input.referenceAnswer.length === 0) {
      throw new Error(`GoldenCase '${id}': 'referenceAnswer' must be a non-empty string when present`)
    }
    referenceAnswer = input.referenceAnswer
  }

  const result: GoldenCase = {
    id,
    version,
    category,
    userMessage,
    expectedSourceIds,
    acceptableEvidenceIds,
  }
  if (expectedRoute !== undefined) result.expectedRoute = expectedRoute
  if (requiredCoverageCriteria !== undefined) result.requiredCoverageCriteria = requiredCoverageCriteria
  if (handoffAcceptable !== undefined) result.handoffAcceptable = handoffAcceptable
  if (notes !== undefined) result.notes = notes
  if (scenario !== undefined) result.scenario = scenario
  if (expectedMaxIterations !== undefined) result.expectedMaxIterations = expectedMaxIterations
  if (expectedMaxToolCalls !== undefined) result.expectedMaxToolCalls = expectedMaxToolCalls
  if (expectedFallback !== undefined) result.expectedFallback = expectedFallback
  if (compressed !== undefined) result.compressed = compressed
  if (referenceAnswer !== undefined) result.referenceAnswer = referenceAnswer
  return result
}

/**
 * Validate a GoldenSet structurally. Throws on invalid input.
 * Returns the typed GoldenSet on success.
 *
 * Checks:
 *   - 60+ cases total (spec L1556)
 *   - Each category meets its minimum count (REQUIRED_CATEGORY_COUNTS)
 *   - No duplicate case ids
 *   - Each case passes validateGoldenCase
 */
export function validateGoldenSet(input: unknown): GoldenSet {
  if (!isPlainObject(input)) {
    throw new Error("GoldenSet must be an object")
  }

  // version — required non-empty string
  if (!("version" in input)) {
    throw new Error("GoldenSet: missing required field 'version'")
  }
  if (!isNonEmptyString(input.version)) {
    throw new Error("GoldenSet: 'version' must be a non-empty string")
  }
  const version = input.version

  // cases — required array
  if (!("cases" in input)) {
    throw new Error("GoldenSet: missing required field 'cases'")
  }
  if (!Array.isArray(input.cases)) {
    throw new Error("GoldenSet: 'cases' must be an array")
  }
  const rawCases = input.cases as unknown[]

  // 60-case minimum (spec L1556)
  if (rawCases.length < 60) {
    throw new Error(
      `GoldenSet: cases must contain at least 60 entries (got ${rawCases.length})`,
    )
  }

  // Per-case validation (catch id-missing errors via try/catch to include index)
  const validatedCases: GoldenCase[] = []
  const seenIds = new Set<string>()
  for (let i = 0; i < rawCases.length; i++) {
    const rawCase = rawCases[i]
    let caseIdForError: string
    try {
      const validated = validateGoldenCase(rawCase)
      caseIdForError = validated.id
      if (seenIds.has(validated.id)) {
        throw new Error(`GoldenSet: duplicate case id '${validated.id}'`)
      }
      seenIds.add(validated.id)
      validatedCases.push(validated)
    } catch (err) {
      const inner = err instanceof Error ? err.message : String(err)
      // Try to extract the id from the raw case for error context
      const rawId = isPlainObject(rawCase) && "id" in rawCase && isNonEmptyString(rawCase.id) ? rawCase.id : `<index ${i}>`
      caseIdForError = rawId
      if (inner.startsWith("GoldenSet: duplicate case id")) {
        throw err
      }
      throw new Error(`GoldenSet: case '${caseIdForError}': ${inner}`)
    }
  }

  // Category count check (spec L1556)
  const counts: Record<GoldenCaseCategory, number> = {
    direct: 0,
    simple: 0,
    complex: 0,
    ambiguous: 0,
    insufficient: 0,
    correction: 0,
  }
  for (const c of validatedCases) {
    counts[c.category]++
  }
  for (const cat of VALID_CATEGORIES) {
    const required = REQUIRED_CATEGORY_COUNTS[cat]
    if (counts[cat] < required) {
      throw new Error(
        `GoldenSet: category '${cat}' has ${counts[cat]} cases but requires at least ${required}`,
      )
    }
  }

  return {
    version,
    cases: validatedCases,
  }
}
