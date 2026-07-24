import type { DB } from "./db"
import type { DeadLetter, IngestionTask, TaskStatus } from "../../types"

interface TaskRow {
  id: number
  doc_id: string
  op: string
  payload: string
  fail_count: number
  status: string
  claimed_at: string | null
  next_attempt_at: string | null
  enqueued_at: string
}

interface DeadLetterRow {
  id: number
  task_id: number
  doc_id: string
  op: string
  payload: string
  fail_count: number
  error_message: string
  error_stack: string | null
  failed_at: string
}

function rowToTask(row: TaskRow): IngestionTask {
  return {
    id: row.id,
    docId: row.doc_id,
    op: row.op,
    payload: row.payload ? JSON.parse(row.payload) : null,
    failCount: row.fail_count,
    status: row.status as TaskStatus,
    claimedAt: row.claimed_at,
    nextAttemptAt: row.next_attempt_at,
    enqueuedAt: row.enqueued_at,
  }
}

function rowToDeadLetter(row: DeadLetterRow): DeadLetter {
  return {
    id: row.id,
    taskId: row.task_id,
    docId: row.doc_id,
    op: row.op,
    payload: row.payload ? JSON.parse(row.payload) : null,
    failCount: row.fail_count,
    errorMessage: row.error_message,
    errorStack: row.error_stack,
    failedAt: row.failed_at,
  }
}

export interface EnqueueInput {
  docId: string
  op: string
  payload: Record<string, unknown>
}

export class TaskRepo {
  constructor(
    private db: DB,
    private now: () => Date = () => new Date()
  ) {}

  enqueue(input: EnqueueInput): number {
    const now = this.now().toISOString()
    const stmt = this.db.prepare(
      `INSERT INTO task_pending_ops (doc_id, op, payload, status, enqueued_at)
       VALUES (@docId, @op, @payload, 'pending', @enqueuedAt)`
    )
    const info = stmt.run({
      docId: input.docId,
      op: input.op,
      payload: JSON.stringify(input.payload),
      enqueuedAt: now,
    })
    return Number(info.lastInsertRowid)
  }

  claimNext(): IngestionTask | null {
    const now = this.now().toISOString()
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT * FROM task_pending_ops
         WHERE status = 'pending'
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY id ASC
         LIMIT 1`
      ).get(now) as TaskRow | undefined
      if (!row) return null
      const info = this.db.prepare(
        `UPDATE task_pending_ops
         SET status = 'running', claimed_at = ?, next_attempt_at = NULL
         WHERE id = ? AND status = 'pending'
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`
      ).run(now, row.id, now)
      if (info.changes !== 1) return null
      return {
        ...row,
        status: "running",
        claimed_at: now,
        next_attempt_at: null,
      }
    })
    const row = tx() as TaskRow | null
    return row ? rowToTask(row) : null
  }

  claimStale(cutoff: string): IngestionTask | null {
    const now = this.now().toISOString()
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT * FROM task_pending_ops
         WHERE status = 'running' AND claimed_at IS NOT NULL AND claimed_at <= ?
         ORDER BY claimed_at ASC, id ASC
         LIMIT 1`
      ).get(cutoff) as TaskRow | undefined
      if (!row) return null

      const info = this.db.prepare(
        `UPDATE task_pending_ops
         SET claimed_at = ?
         WHERE id = ? AND status = 'running' AND claimed_at = ?`
      ).run(now, row.id, row.claimed_at)
      if (info.changes !== 1) return null
      return { ...row, claimed_at: now }
    })
    const row = tx() as TaskRow | null
    return row ? rowToTask(row) : null
  }

  recordFailure(
    taskId: number,
    nextAttemptAt: string | null,
    claimedAt: string | null
  ): boolean {
    const info = this.db.prepare(
      `UPDATE task_pending_ops
       SET fail_count = fail_count + 1,
           status = CASE WHEN ? IS NULL THEN 'failed' ELSE 'pending' END,
           claimed_at = NULL,
           next_attempt_at = ?
       WHERE id = ? AND status = 'running' AND claimed_at = ?`
    ).run(nextAttemptAt, nextAttemptAt, taskId, claimedAt)
    return info.changes === 1
  }

  deadLetter(
    task: IngestionTask,
    errorMessage: string,
    errorStack: string | null,
    failedAt: string
  ): boolean {
    return this.db.transaction(() => {
      const failCount = task.failCount + 1
      const info = this.db.prepare(
        `UPDATE task_pending_ops
         SET fail_count = ?, status = 'failed', claimed_at = NULL, next_attempt_at = NULL
         WHERE id = ? AND status = 'running' AND claimed_at = ?`
      ).run(failCount, task.id, task.claimedAt)
      if (info.changes === 1) {
        this.db.prepare(
          `INSERT INTO task_dead_letters
            (task_id, doc_id, op, payload, fail_count, error_message, error_stack, failed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(task_id) DO NOTHING`
        ).run(
          task.id,
          task.docId,
          task.op,
          JSON.stringify(task.payload ?? {}),
          failCount,
          errorMessage,
          errorStack,
          failedAt
        )
        return true
      }

      const current = this.db.prepare(
        `SELECT status FROM task_pending_ops WHERE id = ?`
      ).get(task.id) as { status: string } | undefined
      return current?.status === "failed" && this.getDeadLetter(task.id) !== null
    })()
  }

  getDeadLetter(taskId: number): DeadLetter | null {
    const row = this.db.prepare(
      `SELECT * FROM task_dead_letters WHERE task_id = ?`
    ).get(taskId) as DeadLetterRow | undefined
    return row ? rowToDeadLetter(row) : null
  }

  cancel(taskId: number): boolean {
    const info = this.db.prepare(
      `UPDATE task_pending_ops
       SET status = 'cancelled', claimed_at = NULL, next_attempt_at = NULL
       WHERE id = ? AND status IN ('pending', 'running')`
    ).run(taskId)
    return info.changes === 1
  }

  finalize(
    taskId: number,
    status: "completed" | "failed",
    claimedAt: string | null
  ): boolean {
    const info = this.db.prepare(
      `UPDATE task_pending_ops
       SET status = ?, claimed_at = NULL, next_attempt_at = NULL
       WHERE id = ? AND status = 'running' AND claimed_at = ?`
    ).run(status, taskId, claimedAt)
    return info.changes === 1
  }

  getByDocId(docId: string): IngestionTask | null {
    const row = this.db.prepare(
      `SELECT * FROM task_pending_ops WHERE doc_id = ? ORDER BY id DESC LIMIT 1`
    ).get(docId) as TaskRow | undefined
    return row ? rowToTask(row) : null
  }

  getById(taskId: number): IngestionTask | null {
    const row = this.db.prepare(
      `SELECT * FROM task_pending_ops WHERE id = ?`
    ).get(taskId) as TaskRow | undefined
    return row ? rowToTask(row) : null
  }
}
