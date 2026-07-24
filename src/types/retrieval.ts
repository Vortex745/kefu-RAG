import type { Chunk, Wikilink } from "./document"

export interface Query {
  text: string
  subQueries?: string[]
  context?: Record<string, unknown>
  coverageCriteria?: string[]
}

export interface RetrievalResult {
  chunk: Chunk
  parentChunk?: Chunk
  score: number
  source: "vector" | "bm25" | "graph" | "pageIndex"
  channels?: Array<"vector" | "bm25" | "graph" | "pageIndex">
  wikilinks: Wikilink[]
}

export interface RerankInput {
  query: string
  results: RetrievalResult[]
}

export interface RerankOutput {
  results: RetrievalResult[]
}
