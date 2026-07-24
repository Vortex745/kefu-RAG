import type { Query, TokenUsage } from "../../types"

export interface DecomposeResult {
  queries: Query[]
  usage?: TokenUsage
}

export interface RewriteResult {
  query: Query
  usage?: TokenUsage
}

export interface HypothesisResult {
  text: string
  usage?: TokenUsage
}

export interface Planner {
  decompose(query: Query): Promise<DecomposeResult>
  rewrite(query: Query): Promise<RewriteResult>
  navigate(query: Query): Promise<string[]>
  generateHypothesis(query: Query): Promise<HypothesisResult>
}
