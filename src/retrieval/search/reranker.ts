import type OpenAI from "openai"
import type { RetrievalResult } from "../../types"

/**
 * Per-rerank hard ceiling independent of the run deadline: if the provider
 * hangs mid-rerank, `AbortSignal.any` fires this timer and every in-flight
 * per-result call rejects instead of occupying connections for the SDK
 * default 10-minute timeout.
 */
const RERANK_TIMEOUT_MS = 30_000

export async function rerank(
  client: OpenAI,
  model: string,
  query: string,
  results: RetrievalResult[],
  signal?: AbortSignal
): Promise<RetrievalResult[]> {
  if (results.length <= 3) return results

  // Combine an optional external cancel with an independent ceiling so a
  // hung provider cannot hold the retrieval stage open past RERANK_TIMEOUT_MS
  // even when the run deadline is not wired (e.g. ingestion-side callers).
  const effectiveSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(RERANK_TIMEOUT_MS)])
    : AbortSignal.timeout(RERANK_TIMEOUT_MS)

  const scored = await Promise.all(
    results.map(async (r) => {
      const res = await client.chat.completions.create(
        {
          model,
          messages: [
            { role: "system", content: "Rate relevance 0-10. Only output a number." },
            { role: "user", content: `Query: ${query}\nDocument: ${r.chunk.content.slice(0, 500)}\nRelevance:` },
          ],
        },
        { signal: effectiveSignal }
      )
      const score = parseInt(res.choices[0]?.message?.content || "0", 10) || 0
      return { ...r, score }
    })
  )

  return scored.sort((a, b) => b.score - a.score)
}
