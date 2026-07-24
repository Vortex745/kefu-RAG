import type { AgentMessage, CriticVerdict } from "../../types"

export interface Validator {
  /**
   * P7.2: optional `signal` is forwarded to the underlying LLM client
   * (e.g. OpenAI `chat.completions.create({...}, { signal })`) so the
   * Critic LLM call honors cancellation. When the signal aborts mid-call,
   * the client throws an AbortError that propagates through the runner's
   * `abortable()` race. Backward compat: callers that omit `signal`
   * behave identically to pre-P7.2 (no client-level abort).
   */
  validate(answer: string, context: AgentMessage[], coverageCriteria?: string[], signal?: AbortSignal): Promise<CriticVerdict>
}
