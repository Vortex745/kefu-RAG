import type OpenAI from "openai"
import type { Query, RouterDecision } from "../../types"

export class RouterImpl {
  constructor(
    private client: OpenAI,
    private model: string
  ) {}

  async decide(query: Query): Promise<RouterDecision> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: "system",
          content:
            "Classify the query. Output exactly one word: direct (greetings, conversational acknowledgements, requests that do not claim knowledge-base facts), simple (factual, short answer), ambiguous (needs clarification), complex (multi-part, needs decomposition).",
        },
        { role: "user", content: query.text },
      ],
    })
    const d = (res.choices?.[0]?.message?.content || "simple").trim().toLowerCase()
    if (d.includes("direct")) return "direct"
    if (d.includes("ambiguous")) return "ambiguous"
    if (d.includes("complex")) return "complex"
    return "simple"
  }
}
