import { v4 as uuid } from "uuid"
import type { SpanKind } from "../../types"
import type { SpanRepo } from "./span_repo"

export interface BeginSpanInput {
  docId: string
  parentSpanId: string | null
  name: string
  kind: SpanKind
  input?: Record<string, unknown>
}

export class SpanTracker {
  private startTimes = new Map<string, number>()

  constructor(private repo: SpanRepo) {}

  beginSpan(input: BeginSpanInput): string {
    const spanId = uuid()
    const now = new Date().toISOString()
    this.startTimes.set(spanId, Date.now())
    this.repo.insert({
      docId: input.docId,
      spanId,
      parentSpanId: input.parentSpanId,
      name: input.name,
      kind: input.kind,
      status: "running",
      input: input.input ?? null,
      output: null,
      errorMessage: null,
      startedAt: now,
      finishedAt: null,
      durationMs: null,
    })
    return spanId
  }

  endSpan(spanId: string, output?: Record<string, unknown>): void {
    const start = this.startTimes.get(spanId)
    const durationMs = start ? Date.now() - start : 0
    this.repo.markDone(spanId, output ?? null, new Date().toISOString(), durationMs)
    this.startTimes.delete(spanId)
  }

  failSpan(spanId: string, errorMessage: string): void {
    const start = this.startTimes.get(spanId)
    const durationMs = start ? Date.now() - start : 0
    this.repo.markFailed(spanId, errorMessage, new Date().toISOString(), durationMs)
    this.startTimes.delete(spanId)
  }
}
