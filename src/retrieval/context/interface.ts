import type { RetrievalResult } from "../../types"

export interface ContextAssembler {
  assemble(
    results: RetrievalResult[],
    citationIds?: ReadonlyMap<string, string>
  ): Promise<string>
}
