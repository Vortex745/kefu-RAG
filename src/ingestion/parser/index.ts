import type { NormalizedBlock, ParserType } from "../../types"
import type { ParseDocumentInput } from "./markitdown"

export interface Parser {
  type: ParserType
  parse(input: ParseDocumentInput): Promise<NormalizedBlock[]>
}

export type { ParserType } from "../../types"
export { MarkItDownParser } from "./markitdown"
export { MarkerParser, normalizeMarker } from "./marker"
export type { MarkerParserOptions } from "./marker"
export { MinerUParser, normalizeMinerU } from "./mineru"
export type { MinerUParserOptions } from "./mineru"
export type {
  MarkItDownParserOptions,
  ParseDocumentInput,
} from "./markitdown"
export { normalizeMarkItDown } from "./normalize"
export { runBoundedProcess } from "./process"
export type { BoundedProcessInput } from "./process"
export { selectParser } from "./router"
export type { ParserDecision, ParserSelectionInput } from "./router"
