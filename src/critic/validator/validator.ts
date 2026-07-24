import type OpenAI from "openai"
import type { AgentMessage, CriticVerdict } from "../../types"
import {
  classifyCriticVerdict,
  CRITIC_VERDICT_SCHEMA_VERSION,
} from "../schema"

/**
 * P3.2 — Runtime validation and bounded fallback.
 *
 * `ValidatorImpl` is the production boundary where raw LLM output becomes
 * a `CriticVerdict`. P3.2 wires `classifyCriticVerdict` (P3.1) into this
 * boundary so that malformed JSON, schema mismatches, and unrecognized
 * responses NEVER reach the replanner or publish decision as valid Critic
 * output.
 *
 * Behavior:
 *   - The system prompt declares `schemaVersion: 1` so a well-behaved LLM
 *     emits a v1-shaped verdict.
 *   - The raw LLM response is classified by `classifyCriticVerdict`.
 *   - On `valid`: the validated verdict is returned (mapped to the
 *     existing `CriticVerdict` shape; `schemaVersion` is consumed at the
 *     schema boundary and not forwarded, since the existing
 *     `CriticVerdict` type is unversioned).
 *   - On `invalid` / `unknown`: a deterministic degraded verdict is
 *     returned. The degraded verdict carries NO field derived from the
 *     LLM output. It has `passed: false` so the existing runner
 *     validation loop treats it as a failed validation and enters
 *     bounded replan / degrade (the 3-round loop with
 *     `insufficient_evidence` terminal). The `missingGap` is derived
 *     deterministically from the user's original message (re-search the
 *     original query) so the existing replanner can produce a bounded
 *     correction query. If no user message is available, `missingGap`
 *     is omitted → the replanner returns no queries → the runner
 *     terminates.
 *
 * Red line: the raw LLM output is NEVER returned as a `CriticVerdict`
 * when classification fails. Only the deterministic degraded verdict is
 * returned. This guarantees "malformed JSON never publishes".
 *
 * Defense-in-depth: `classifyCriticVerdict` has a never-throws contract
 * (P3.1, tested with 14 adversarial inputs). If a future bug violates
 * that contract, the try/catch here still routes to the degraded verdict
 * so the runner converges to one terminal event instead of crashing —
 * satisfying the control rule "every invalid Critic response must
 * converge to one terminal event".
 */
export class ValidatorImpl {
  constructor(
    private client: OpenAI,
    private model: string
  ) {}

  async validate(answer: string, context: AgentMessage[], coverageCriteria?: string[], signal?: AbortSignal): Promise<CriticVerdict> {
    const contextStr = context.map((m) => `${m.role}: ${m.content}`).join("\n")
    const criteriaBlock = coverageCriteria && coverageCriteria.length > 0
      ? `\nThe answer must cover all of the following criteria:\n${coverageCriteria.map((c) => `- ${c}`).join("\n")}\n`
      : ""
    // P7.2: forward the signal to the OpenAI client so the Critic LLM
    // call honors cancellation. The client throws an AbortError that
    // propagates through the runner's `abortable()` race.
    const requestOptions = signal ? { signal } : undefined
    const res = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: "system",
          content: `You are a critic. Verify if the answer is supported by context and complete.${criteriaBlock}
Return JSON: { "schemaVersion": ${CRITIC_VERDICT_SCHEMA_VERSION}, "passed": bool, "hallucination": bool, "completeness": bool, "missingGap": string | null }`,
        },
        {
          role: "user",
          content: `Context:\n${contextStr}\n\nAnswer:\n${answer}\n\nVerdict:`,
        },
      ],
      response_format: { type: "json_object" },
    }, requestOptions)
    const raw = res.choices[0]?.message?.content ?? ""

    let classification
    try {
      classification = classifyCriticVerdict(raw)
    } catch {
      // Defense-in-depth: classifyCriticVerdict has a never-throws
      // contract (P3.1). If a bug violates it, route to the degraded
      // verdict so the runner converges to one terminal event instead
      // of crashing. The raw LLM output is still NOT published.
      return degradedCriticVerdict(context)
    }

    if (classification.kind === "valid" && classification.verdict) {
      const v = classification.verdict
      const verdict: CriticVerdict = {
        passed: v.passed,
        hallucination: v.hallucination,
        completeness: v.completeness,
      }
      // The v1 schema allows missingGap: string | null; the existing
      // CriticVerdict type is missingGap?: string (no null). Normalize
      // null → omitted (undefined). Semantically equivalent for the
      // replanner, which tests !verdict.missingGap (null/undefined/"" all
      // falsy). This keeps the forwarded verdict type-clean.
      if (v.missingGap !== undefined && v.missingGap !== null) {
        verdict.missingGap = v.missingGap
      }
      if (v.suggestion !== undefined) verdict.suggestion = v.suggestion
      return verdict
    }

    // Bounded fallback: invalid or unknown classification. Return a
    // deterministic degraded verdict that carries NO field from the LLM
    // output. `passed: false` routes through the existing 3-round
    // validation loop; the missingGap (derived from the user message)
    // lets the existing replanner produce a bounded correction query.
    return degradedCriticVerdict(context)
  }
}

/**
 * Build a deterministic degraded `CriticVerdict` for the bounded fallback
 * path. The verdict carries NO field derived from the LLM output.
 *
 * `missingGap` is set to the first user message in `context` (the
 * original user query) so the existing `RePlannerImpl.replan()` produces
 * a correction query that re-searches the original request. This is the
 * "bounded correction" path. The runner's `seenGapQueries` dedup
 * ensures the same query is not retried indefinitely, so the loop
 * converges to the `insufficient_evidence` terminal within the 3-round
 * budget.
 *
 * If no user message is available, `missingGap` is omitted → the
 * replanner returns no queries → the runner terminates immediately
 * (the "no budget → terminal" path).
 */
function degradedCriticVerdict(context: AgentMessage[]): CriticVerdict {
  const userMessage = context.find((m) => m.role === "user")?.content
  const verdict: CriticVerdict = {
    passed: false,
    hallucination: false,
    completeness: false,
  }
  if (userMessage && userMessage.trim().length > 0) {
    verdict.missingGap = userMessage
  }
  return verdict
}
