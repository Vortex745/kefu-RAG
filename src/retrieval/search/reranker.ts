import type OpenAI from "openai"
import type { RetrievalResult } from "../../types"

export async function rerank(
  client: OpenAI,
  model: string,
  query: string,
  results: RetrievalResult[]
): Promise<RetrievalResult[]> {
  if (results.length <= 3) return results

  const scored = await Promise.all(
    results.map(async (r) => {
      const res = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: "Rate relevance 0-10. Only output a number." },
          { role: "user", content: `Query: ${query}\nDocument: ${r.chunk.content.slice(0, 500)}\nRelevance:` },
        ],
      })
      const score = parseInt(res.choices[0]?.message?.content || "0", 10) || 0
      return { ...r, score }
    })
  )

  return scored.sort((a, b) => b.score - a.score)
}
