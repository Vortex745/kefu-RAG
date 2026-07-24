import { tokenizers } from "@llamaindex/env/tokenizers"
import type { RetrievalResult } from "../../types"

/**
 * Ticket 61 / 04 (spec §2 L1748): shared block framing used by BOTH the
 * deterministic `ContextAssemblerImpl` and the LLM-backed `ContextCompressor`.
 * Exported so the compressor produces byte-compatible INTRO/SUFFIX wrappers
 * when it assembles compressed blocks, and so the `ContextBudget` helper
 * computes the uncompressed token count using the same overhead constants.
 */
export const CONTEXT_INTRO = "以下是从知识库中找到的相关文档片段：\n"
export const CONTEXT_SUFFIX = "\n请基于以上文档片段回答用户的问题。如果信息不足，请明确说明。"

/** Backward-compat aliases used inside `assembler.ts` itself. */
const INTRO = CONTEXT_INTRO
const SUFFIX = CONTEXT_SUFFIX

const MODEL_TOKENIZER = tokenizers.tokenizer()

export interface ContextAssemblerOptions {
  maxContextTokens?: number
  maxParentTokens?: number
  countTokens?: (text: string) => number
}

export class ContextAssemblerImpl {
  private maxContextTokens: number
  private maxParentTokens: number
  private countTokens: (text: string) => number

  constructor(options: ContextAssemblerOptions = {}) {
    this.maxContextTokens = options.maxContextTokens ?? 6_000
    this.maxParentTokens = options.maxParentTokens ?? 4_500
    this.countTokens = options.countTokens ?? modelTokenCount
  }

  async assemble(
    results: RetrievalResult[],
    citationIds?: ReadonlyMap<string, string>
  ): Promise<string> {
    const groups = new Map<string, {
      content: string
      source: string
      matches: Array<{ content: string; citationId?: string }>
    }>()
    const parts: string[] = [INTRO]

    for (const r of results) {
      const contextChunk = r.parentChunk ?? r.chunk
      const key = `${contextChunk.documentId}\0${contextChunk.id}`
      const citationId = citationIds?.get(
        `${r.chunk.documentId}\0${r.chunk.id}`
      )
      const group = groups.get(key) ?? {
        content: contextChunk.content,
        source: (contextChunk.metadata?.source as string) || "unknown",
        matches: [],
      }
      if (!group.matches.some((match) =>
        match.content === r.chunk.content && match.citationId === citationId
      )) {
        group.matches.push({ content: r.chunk.content, citationId })
      }
      groups.set(key, group)
    }

    let remaining = this.maxContextTokens - this.countTokens(INTRO + SUFFIX)
    for (const group of groups.values()) {
      if (remaining <= 0) break
      const provisionalCitations = group.matches
        .flatMap(({ citationId }) => citationId ? [`[cite:${citationId}]`] : [])
        .join(" ")
      const provisionalHeader = `${provisionalCitations}${provisionalCitations ? " " : ""}[来源: ${group.source}]\n`
      const wrapperTokens = this.countTokens(`${provisionalHeader}\n`)
      const contentBudget = Math.min(
        this.maxParentTokens,
        Math.max(0, remaining - wrapperTokens)
      )
      if (contentBudget <= 0) break
      const window = this.parentWindow(
        group.content,
        group.matches.map(({ content: match }) => match),
        contentBudget
      )
      const included = new Set(window.includedMatches)
      const citations = group.matches
        .flatMap(({ content: match, citationId }) =>
          included.has(match) && citationId ? [`[cite:${citationId}]`] : []
        )
        .join(" ")
      const header = `${citations}${citations ? " " : ""}[来源: ${group.source}]\n`
      const part = `${header}${window.content}\n`
      const partTokens = this.countTokens(part)
      if (partTokens > remaining) break
      parts.push(part)
      remaining -= partTokens
    }

    parts.push(SUFFIX)
    return parts.join("")
  }

  private parentWindow(
    parent: string,
    matches: string[],
    budget: number
  ): { content: string; includedMatches: string[] } {
    const uniqueMatches = [...new Set(matches)].filter(Boolean)
    const estimatedParentTokens = estimatedTokenCount(parent)
    if (estimatedParentTokens <= budget
      && this.countTokens(parent) <= budget) {
      return { content: parent, includedMatches: uniqueMatches }
    }
    if (uniqueMatches.length === 0) {
      return { content: this.truncate(parent, budget), includedMatches: [] }
    }

    const separator = "\n...\n"
    const separatorTokens = this.countTokens(separator)
    const selected: string[] = []
    let selectedTokens = 0
    for (const match of uniqueMatches) {
      const nextTokens = this.countTokens(match)
        + (selected.length > 0 ? separatorTokens : 0)
      if (selectedTokens + nextTokens > budget) continue
      selected.push(match)
      selectedTokens += nextTokens
    }
    if (selected.length === 0) {
      return { content: this.truncate(parent, budget), includedMatches: [] }
    }

    const extraPerMatch = Math.floor((budget - selectedTokens) / selected.length)
    const windows = selected.map((match) => this.windowAround(
      parent,
      match,
      this.countTokens(match) + extraPerMatch,
      estimatedParentTokens
    ))
    return { content: windows.join(separator), includedMatches: selected }
  }

  private windowAround(
    parent: string,
    match: string,
    budget: number,
    parentTokens: number
  ): string {
    const matchIndex = parent.indexOf(match)
    if (matchIndex < 0) return this.truncate(match, budget)
    if (this.countTokens(match) > budget) return this.truncate(match, budget)

    let targetLength = Math.max(
      match.length,
      Math.floor(parent.length * budget / parentTokens)
    )
    let best = match
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const radius = Math.max(0, Math.floor((targetLength - match.length) / 2))
      const start = Math.max(0, matchIndex - radius)
      const end = Math.min(parent.length, matchIndex + match.length + radius)
      const candidate = parent.slice(start, end)
      const candidateTokens = this.countTokens(candidate)
      if (candidateTokens <= budget) {
        best = candidate
        if (candidateTokens === budget || end - start === parent.length) break
      }
      targetLength = Math.max(
        match.length,
        Math.floor(targetLength * budget / Math.max(1, candidateTokens))
      )
    }
    return best
  }

  private truncate(text: string, budget: number): string {
    const estimatedTotal = estimatedTokenCount(text)
    if (estimatedTotal <= budget && this.countTokens(text) <= budget) return text
    let targetLength = Math.max(
      1,
      Math.floor(text.length * budget / Math.max(1, estimatedTotal))
    )
    let best = ""
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = text.slice(0, targetLength)
      const candidateTokens = this.countTokens(candidate)
      if (candidateTokens <= budget) best = candidate
      if (candidateTokens === budget) break
      targetLength = Math.max(
        1,
        Math.floor(targetLength * budget / Math.max(1, candidateTokens))
      )
    }
    return best
  }
}

/**
 * Ticket 61 / 04 (spec §2 L1748): shared token-counting function used by
 * the deterministic assembler, the `ContextBudget` helper, and the
 * `ContextCompressor`. Chinese text → UTF-8 byte length (matches the
 * determinstic assembler's behavior); ASCII text → llamaindex tokenizer
 * token count. Exported so the compressor and budget helper compute token
 * counts consistent with the assembler's budget enforcement.
 */
export function modelTokenCount(text: string): number {
  if (/[^\x00-\x7f]/.test(text)) return Buffer.byteLength(text, "utf8")
  return MODEL_TOKENIZER.encode(text).length
}

function estimatedTokenCount(text: string): number {
  let tokens = 0
  let asciiRun = 0
  const flushAscii = (): void => {
    if (asciiRun > 0) tokens += Math.ceil(asciiRun / 4)
    asciiRun = 0
  }
  for (const character of text) {
    if (/^[\x20-\x7e]$/.test(character)) {
      asciiRun += 1
    } else {
      flushAscii()
      if (!/\s/u.test(character)) tokens += 1
    }
  }
  flushAscii()
  return tokens
}
