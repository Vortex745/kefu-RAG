export type ParserType = "markitdown" | "marker" | "mineru"

export type NormalizedBlockType =
  | "heading"
  | "paragraph"
  | "table"
  | "code"
  | "image"
  | "equation"

export interface ParserProvenance {
  parser: ParserType
  adapter: "cli"
}

export interface NormalizedBlock {
  id: string
  index: number
  type: NormalizedBlockType
  text: string
  headingLevel?: number
  page?: number
  sectionPath: string[]
  boundingBox?: [number, number, number, number]
  table?: Record<string, unknown>
  image?: Record<string, unknown>
  metadata: Record<string, unknown>
  provenance: ParserProvenance
}
