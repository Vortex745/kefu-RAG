import type OpenAI from "openai"
import type { AccessContext } from "../access/context"
import type { AgentMessage, AnswerRunEvent } from "../types"

export interface AnswerModel {
  stream(messages: AgentMessage[], signal?: AbortSignal): AsyncIterable<string>
}

export interface AnswerRunObserver {
  onEvent(event: AnswerRunEvent): void
}

export interface AnswerRunOptions {
  runId?: string
  sessionId?: string
  signal?: AbortSignal
  accessContext?: AccessContext
}

export class OpenAIAnswerModel implements AnswerModel {
  constructor(
    private client: OpenAI,
    private model: string
  ) {}

  async *stream(
    messages: AgentMessage[],
    signal?: AbortSignal
  ): AsyncGenerator<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      stream: true,
    }, { signal })

    for await (const chunk of response) {
      const token = chunk.choices[0]?.delta?.content || ""
      if (token) yield token
    }
  }
}
