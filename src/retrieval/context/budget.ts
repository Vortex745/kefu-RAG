import type { Evidence } from "../../types"
import { CONTEXT_INTRO, CONTEXT_SUFFIX, modelTokenCount } from "./assembler"

/**
 * Ticket 61 / 04 (spec §2 L1748-1749): formats a single Evidence item as a
 * deterministic context block, mirroring the `ContextAssemblerImpl` output
 * shape — `[cite:ev_XXX] [来源: SOURCE]\nEXCERPT\n`. Used by BOTH:
 *   - `computeContextBudget` — to sum the uncompressed token count across
 *     all Evidence groups (the "would it fit without truncation?" check).
 *   - `ContextCompressorImpl` — to format each Evidence group's input block
 *     for the LLM compression call, and to generate the deterministic header
 *     (`[cite:ev_XXX] [来源: SOURCE]\n`) that wraps the LLM-produced
 *     compressed content.
 *
 * The block format is intentionally simpler than the assembler's per-parent-
 * chunk grouping (which can merge multiple child-chunk citations into one
 * header). Compression groups by Evidence ID (child chunk) — one block per
 * Evidence — so the compressed output never merges provenance across Evidence
 * identities (spec §2 L1749 acceptance criterion #2).
 */
export function formatEvidenceBlock(evidence: Evidence): string {
  const header = `[cite:${evidence.id}] [来源: ${evidence.source}]\n`
  return `${header}${evidence.excerpt}\n`
}

export interface ContextBudgetOptions {
  /**
   * Maximum context token budget. Defaults to `6_000` — the same default as
   * `ContextAssemblerImpl.maxContextTokens`. When the uncompressed token
   * count exceeds this value, the deterministic assembler would have to
   * truncate/drop groups, and semantic compression is triggered instead
   * (spec §2 L1748: "When authorized Evidence produces an over-budget
   * Context, compress it").
   */
  maxContextTokens?: number
  /**
   * Token-counting function. Defaults to `modelTokenCount` (exported from
   * `assembler.ts`) — the same function used by the deterministic assembler
   * for budget enforcement. Chinese text → UTF-8 byte length; ASCII text →
   * llamaindex tokenizer token count.
   */
  countTokens?: (text: string) => number
}

export interface ContextBudgetBreakdown {
  /**
   * Total token count of the uncompressed context — INTRO + all Evidence
   * blocks (full excerpts, no truncation/windowing) + SUFFIX. This is what
   * the context WOULD be if every Evidence group were included in full.
   * When this value exceeds `maxContextTokens`, the deterministic assembler
   * truncates/drops groups, and semantic compression is triggered instead.
   */
  uncompressedTokens: number
  /**
   * The maximum context token budget. Same value as
   * `ContextAssemblerImpl.maxContextTokens` (default `6_000`).
   */
  maxContextTokens: number
  /**
   * Whether the uncompressed context exceeds the budget. `true` → trigger
   * semantic compression (per-Evidence-group LLM calls); `false` → bypass
   * compression and use the deterministic assembler output as-is (byte-
   * compatible with current behavior, spec §2 L1748 acceptance criterion #1).
   */
  overBudget: boolean
  /**
   * All Evidence IDs in the input array, in insertion order. Used by the
   * compressor to validate that the compressed output does not create new
   * citation identities or retain an unknown Evidence ID (spec §2 L1749
   * acceptance criterion #4).
   */
  evidenceIds: string[]
}

/**
 * Ticket 61 / 04 (spec §2 L1748): computes the uncompressed context token
 * count for a set of Evidence, and determines whether semantic compression
 * should be triggered (over-budget) or bypassed (under-budget).
 *
 * The function does NOT call the deterministic assembler — it computes the
 * uncompressed size independently using `formatEvidenceBlock`. This is by
 * design: the deterministic assembler groups by parent chunk (which can
 * merge multiple child-chunk citations into one header), while the
 * compression path groups by Evidence ID (child chunk). The uncompressed
 * size is the sum of per-Evidence-ID blocks, which is an upper bound on the
 * deterministic assembler's output size (the assembler's grouping can only
 * reduce the size, never increase it).
 *
 * When `overBudget === false`, the caller MUST use the deterministic
 * assembler output as-is (byte-compatible with current behavior). When
 * `overBudget === true`, the caller MAY attempt semantic compression and
 * fall back to the deterministic assembler output on failure.
 */
export function computeContextBudget(
  evidence: Evidence[],
  options: ContextBudgetOptions = {}
): ContextBudgetBreakdown {
  const maxContextTokens = options.maxContextTokens ?? 6_000
  const countTokens = options.countTokens ?? modelTokenCount
  const overhead = countTokens(CONTEXT_INTRO + CONTEXT_SUFFIX)
  const blocksTokens = evidence.reduce(
    (sum, ev) => sum + countTokens(formatEvidenceBlock(ev)),
    0
  )
  const uncompressedTokens = overhead + blocksTokens
  return {
    uncompressedTokens,
    maxContextTokens,
    overBudget: uncompressedTokens > maxContextTokens,
    evidenceIds: evidence.map((ev) => ev.id),
  }
}
