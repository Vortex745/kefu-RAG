import type { DB } from "./db"
import type { ProcessingSpan, SpanStatus } from "../../types"

interface SpanRow {
  id: number
  doc_id: string
  span_id: string
  parent_span_id: string | null
  name: string
  kind: string
  status: string
  input: string | null
  output: string | null
  error_message: string | null
  started_at: string | null
  finished_at: string | null
  duration_ms: number | null
}

function rowToSpan(row: SpanRow): ProcessingSpan {
  return {
    id: row.id,
    docId: row.doc_id,
    spanId: row.span_id,
    parentSpanId: row.parent_span_id,
    name: row.name,
    kind: row.kind as ProcessingSpan["kind"],
    status: row.status as SpanStatus,
    input: row.input ? JSON.parse(row.input) : null,
    output: row.output ? JSON.parse(row.output) : null,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
  }
}

export interface InsertSpanInput {
  docId: string
  spanId: string
  parentSpanId: string | null
  name: string
  kind: ProcessingSpan["kind"]
  status: SpanStatus
  input: Record<string, unknown> | null
  output: Record<string, unknown> | null
  errorMessage: string | null
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
}

export class SpanRepo {
  constructor(private db: DB) {}

  insert(span: InsertSpanInput): void {
    this.db.prepare(
      `INSERT INTO processing_spans
        (doc_id, span_id, parent_span_id, name, kind, status, input, output, error_message, started_at, finished_at, duration_ms)
       VALUES (@docId, @spanId, @parentSpanId, @name, @kind, @status, @input, @output, @errorMessage, @startedAt, @finishedAt, @durationMs)`
    ).run({
      docId: span.docId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      kind: span.kind,
      status: span.status,
      input: span.input ? JSON.stringify(span.input) : null,
      output: span.output ? JSON.stringify(span.output) : null,
      errorMessage: span.errorMessage,
      startedAt: span.startedAt,
      finishedAt: span.finishedAt,
      durationMs: span.durationMs,
    })
  }

  markRunning(spanId: string, input: Record<string, unknown> | null, startedAt: string): boolean {
    const info = this.db.prepare(
      `UPDATE processing_spans
       SET status = 'running', input = ?, started_at = ?
       WHERE span_id = ? AND status = 'pending'`
    ).run(input ? JSON.stringify(input) : null, startedAt, spanId)
    return info.changes === 1
  }

  markDone(spanId: string, output: Record<string, unknown> | null, finishedAt: string, durationMs: number): boolean {
    const info = this.db.prepare(
      `UPDATE processing_spans
       SET status = 'done', output = ?, finished_at = ?, duration_ms = ?
       WHERE span_id = ? AND status = 'running'`
    ).run(output ? JSON.stringify(output) : null, finishedAt, durationMs, spanId)
    return info.changes === 1
  }

  markFailed(
    spanId: string,
    errorMessage: string,
    finishedAt: string,
    durationMs: number,
    errorStack: string | null = null
  ): boolean {
    const info = this.db.prepare(
      `UPDATE processing_spans
       SET status = 'failed', error_message = ?, error_stack = ?, finished_at = ?, duration_ms = ?
       WHERE span_id = ? AND status = 'running'`
    ).run(errorMessage, errorStack, finishedAt, durationMs, spanId)
    return info.changes === 1
  }

  skipPendingChildren(parentSpanId: string, finishedAt: string): number {
    const info = this.db.prepare(
      `UPDATE processing_spans
       SET status = 'skipped', finished_at = ?, duration_ms = 0
       WHERE parent_span_id = ? AND status = 'pending'`
    ).run(finishedAt, parentSpanId)
    return info.changes
  }

  cancelOpen(docId: string, finishedAt: string): number {
    const info = this.db.prepare(
      `UPDATE processing_spans
       SET status = 'cancelled',
           finished_at = ?,
           duration_ms = CASE
             WHEN started_at IS NULL THEN 0
             ELSE MAX(0, CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER))
           END
       WHERE doc_id = ? AND status IN ('pending', 'running')`
    ).run(finishedAt, finishedAt, docId)
    return info.changes
  }

  listByDoc(docId: string): ProcessingSpan[] {
    const rows = this.db.prepare(
      `SELECT * FROM processing_spans WHERE doc_id = ? ORDER BY id ASC`
    ).all(docId) as SpanRow[]
    return rows.map(rowToSpan)
  }
}
