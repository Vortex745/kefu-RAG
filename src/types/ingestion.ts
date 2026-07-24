// 知识处理追踪相关类型（T6 tracer bullet 范围）
// DeadLetter 类型留待 T8（失败处理 + 死信）时新增
// "cancelled" span/task 状态和 "subspan" kind 留待后续取消 ticket 新增

export type SpanStatus = "pending" | "running" | "done" | "failed" | "skipped" | "cancelled"

export type SpanKind = "root" | "stage"

export interface ProcessingSpan {
  id: number
  docId: string
  spanId: string
  parentSpanId: string | null
  name: string
  kind: SpanKind
  status: SpanStatus
  input: Record<string, unknown> | null
  output: Record<string, unknown> | null
  errorMessage: string | null
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
}

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled"

export type DocumentStatus = "pending" | "completed" | "failed" | "cancelled"

export interface IngestionTask {
  id: number
  docId: string
  op: string
  payload: Record<string, unknown> | null
  failCount: number
  status: TaskStatus
  claimedAt: string | null
  nextAttemptAt: string | null
  enqueuedAt: string
}

export interface DeadLetter {
  id: number
  taskId: number
  docId: string
  op: string
  payload: Record<string, unknown> | null
  failCount: number
  errorMessage: string
  errorStack: string | null
  failedAt: string
}
