import type { Query } from "./retrieval"

export type RouterDecision = "direct" | "simple" | "ambiguous" | "complex"

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface AgentMessage {
  role: "user" | "assistant" | "system"
  content: string
}

export interface CriticVerdict {
  passed: boolean
  hallucination: boolean
  completeness: boolean
  missingGap?: string
  suggestion?: Query
}
