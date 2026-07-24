import { v4 as uuid } from "uuid"
import { createHash } from "node:crypto"
import type {
  Document,
  DocumentStatus,
  DeadLetter,
  IngestionTask,
  ProcessingSpan,
  ActivationMode,
} from "../types"
import type { DB } from "./tracking/db"
import { DocumentRepo } from "./tracking/doc_repo"
import type { DocumentVersionInfo } from "./tracking/doc_repo"
import { SpanRepo } from "./tracking/span_repo"
import { TaskRepo } from "./tracking/task_repo"
import {
  resolveSourceIdentity,
  sourceIdentityKey,
  type SourceIdentityInput,
} from "./source_identity"

export const INGESTION_STAGE_NAMES = [
  "chunk",
  "wikify",
  "storeChunks",
  "storeGraph",
] as const

const RETRY_DELAYS_MS = [2_000, 4_000, 8_000] as const
const RUNNING_ABORT_CONTROLLERS = new Map<string, AbortController>()

export type IngestionStageName = (typeof INGESTION_STAGE_NAMES)[number]

export interface StageExecution {
  readonly signal: AbortSignal
  runStage<T>(
    name: IngestionStageName,
    input: Record<string, unknown>,
    operation: () => Promise<T>,
    summarize: (result: T) => Record<string, unknown>
  ): Promise<T>
}

export interface IngestionStageRunner {
  run(
    document: Document,
    execution: StageExecution
  ): Promise<Record<string, unknown> | void>
  /**
   * T53: Typed close — releases shared resources owned by the stage runner
   * (e.g. ES/Neo4j/OpenAI clients). No longer duck-typed.
   */
  close(): Promise<void>
}

export interface SubmitIngestionInput {
  title: string
  content: string
  rawContent?: Buffer
  fileName?: string
  mimeType?: string
  parserOverride?: string
  source?: string
  sourceIdentity?: SourceIdentityInput
  legacySourceAliases?: string[]
}

export type IngestionSubmission = {
  docId: string
  taskId: number
  status: "pending"
  version: number
} | {
  docId: string
  taskId: null
  status: "unchanged"
  version: number
}

export interface SpanNode {
  span: ProcessingSpan
  children: SpanNode[]
}

export interface IngestionStatus {
  docId: string
  task: IngestionTask | null
  documentStatus: DocumentStatus | null
  lifecycleOutcome: DocumentStatus | "unchanged" | null
  documentVersion: DocumentVersionInfo
  spanTree: SpanNode[]
}

export interface IngestionExecutionResult {
  taskId: number
  docId: string
  rootSpanId: string
  success: boolean
  cancelled?: boolean
  error?: string
}

export interface IngestionCancellationResult {
  docId: string
  taskId: number
  status: IngestionTask["status"]
  changed: boolean
}

function buildSpanTree(spans: ProcessingSpan[]): SpanNode[] {
  const byId = new Map<string, SpanNode>()
  const roots: SpanNode[] = []

  for (const span of spans) {
    byId.set(span.spanId, { span, children: [] })
  }
  for (const span of spans) {
    const node = byId.get(span.spanId)!
    if (span.parentSpanId && byId.has(span.parentSpanId)) {
      byId.get(span.parentSpanId)!.children.push(node)
    } else {
      roots.push(node)
    }
  }

  return roots
}

class TrackedStageExecution implements StageExecution {
  private nextStageIndex = 0

  constructor(
    private spanRepo: SpanRepo,
    private stageSpanIds: Map<IngestionStageName, string>,
    private now: () => Date,
    readonly signal: AbortSignal
  ) {}

  async runStage<T>(
    name: IngestionStageName,
    input: Record<string, unknown>,
    operation: () => Promise<T>,
    summarize: (result: T) => Record<string, unknown>
  ): Promise<T> {
    const expectedStage = INGESTION_STAGE_NAMES[this.nextStageIndex]
    if (name !== expectedStage) {
      throw new Error(
        expectedStage
          ? `Expected ingestion stage ${expectedStage}, received ${name}`
          : `Ingestion stage ${name} was already completed`
      )
    }

    const spanId = this.stageSpanIds.get(name)
    if (!spanId) {
      throw new Error(`Unknown ingestion stage: ${name}`)
    }

    const startedAt = this.now()
    if (!this.spanRepo.markRunning(spanId, input, startedAt.toISOString())) {
      throw new Error(`Ingestion stage ${name} is not pending`)
    }
    try {
      const result = await operation()
      const finishedAt = this.now()
      if (
        !this.spanRepo.markDone(
          spanId,
          summarize(result),
          finishedAt.toISOString(),
          finishedAt.getTime() - startedAt.getTime()
        )
      ) {
        throw new Error(`Ingestion stage ${name} could not be completed`)
      }
      this.nextStageIndex += 1
      return result
    } catch (error) {
      const finishedAt = this.now()
      this.spanRepo.markFailed(
        spanId,
        error instanceof Error ? error.message : String(error),
        finishedAt.toISOString(),
        finishedAt.getTime() - startedAt.getTime(),
        error instanceof Error ? error.stack ?? null : null
      )
      throw error
    }
  }

  assertComplete(): void {
    if (this.nextStageIndex !== INGESTION_STAGE_NAMES.length) {
      throw new Error(
        `Ingestion execution stopped before ${INGESTION_STAGE_NAMES[this.nextStageIndex]}`
      )
    }
  }
}

export class IngestionLifecycle {
  private docRepo: DocumentRepo
  private spanRepo: SpanRepo
  private taskRepo: TaskRepo

  constructor(
    private db: DB,
    private stageRunner: IngestionStageRunner,
    private now: () => Date = () => new Date(),
    private activationMode: ActivationMode = "auto"
  ) {
    this.docRepo = new DocumentRepo(db)
    this.spanRepo = new SpanRepo(db)
    this.taskRepo = new TaskRepo(db, now)
  }

  /**
   * T21: close the deepmodule's shared resources (ES/OpenAI/Neo4j clients).
   * T53: Now a typed close — IngestionStageRunner.close() is part of the
   * interface, no longer duck-typed. Full graceful shutdown wiring is T22's scope.
   */
  async close(): Promise<void> {
    await this.stageRunner.close()
  }

  submit(input: SubmitIngestionInput): IngestionSubmission {
    const docId = uuid()
    const sourceBytes = input.rawContent ?? Buffer.from(input.content, "utf8")
    const contentHash = createHash("sha256").update(sourceBytes).digest("hex")
    const identity = resolveSourceIdentity(
      input.sourceIdentity,
      input.source,
      docId
    )
    const sourceKey = sourceIdentityKey(identity)

    return this.db.transaction((): IngestionSubmission => {
      let source = this.docRepo.getSourceByKey(sourceKey)
      if (identity.kind === "file" && input.legacySourceAliases?.length) {
        const matches = this.docRepo.listLegacySources().filter((candidate) =>
          resolveSourceIdentity(
            { kind: "file", uriOrExternalId: candidate.uri, namespace: "local" },
            undefined,
            docId
          ).uri === identity.uri
        )
        const candidates = source ? [source, ...matches] : matches
        const ranked = candidates
          .map((candidate) => ({
            candidate,
            active: this.docRepo.getActive(candidate.sourceId),
          }))
          .sort((left, right) => {
            const timeDifference = (right.active?.createdAt.getTime() ?? 0) -
              (left.active?.createdAt.getTime() ?? 0)
            return timeDifference ||
              left.candidate.sourceId.localeCompare(right.candidate.sourceId)
          })
        const preferred = ranked[0] ?? null
        const canonicalSource = source ?? preferred?.candidate ?? null
        if (canonicalSource && matches.length) {
          this.docRepo.adoptCanonicalSource(
            canonicalSource.sourceId,
            matches
              .filter((candidate) => candidate.sourceId !== canonicalSource.sourceId)
              .map((candidate) => candidate.sourceId),
            {
              sourceKey,
              kind: identity.kind,
              uri: identity.uri,
              namespace: identity.namespace,
            },
            preferred?.active?.id ?? null
          )
        }
        source = canonicalSource
      }
      if (!source) {
        source = this.docRepo.createSource({
          sourceId: uuid(),
          sourceKey,
          kind: identity.kind,
          uri: identity.uri,
          namespace: identity.namespace,
        })
      }

      const active = this.docRepo.getActive(source.sourceId)
      if (active?.contentHash === contentHash) {
        this.docRepo.recordOutcome(source.sourceId, active.id, "unchanged")
        return {
          docId: active.id,
          taskId: null,
          status: "unchanged",
          version: active.version,
        }
      }

      const inFlight = this.docRepo.getInFlightByHash(source.sourceId, contentHash)
      if (inFlight) {
        const task = this.taskRepo.getByDocId(inFlight.id)
        if (task) {
          return {
            docId: inFlight.id,
            taskId: task.id,
            status: "pending",
            version: inFlight.version,
          }
        }
      }

      const version = this.docRepo.getNextVersion(source.sourceId)
      this.docRepo.insert({
        docId,
        sourceId: source.sourceId,
        contentHash,
        version,
        title: input.title,
        source: identity.kind === "submission" ? "api" : identity.uri,
        content: input.content,
        rawContent: input.rawContent,
        fileName: input.fileName,
        mimeType: input.mimeType,
        parserOverride: input.parserOverride,
        // Ticket 06 P2: inherit access metadata from the resolved Source row.
        // Sources table columns are NOT NULL DEFAULT so this always carries
        // real values — 'default' / '[]' in single-tenant mode.
        tenantId: source.tenantId,
        allowedGroups: source.allowedGroups,
      })
      const taskId = this.taskRepo.enqueue({
        docId,
        op: "ingest",
        payload: {
          title: input.title,
          contentLength: sourceBytes.length,
          ...(input.fileName ? { fileName: input.fileName } : {}),
          ...(input.mimeType ? { mimeType: input.mimeType } : {}),
          ...(input.parserOverride ? { parserOverride: input.parserOverride } : {}),
        },
      })
      this.docRepo.recordOutcome(source.sourceId, docId, "pending")
      return { docId, taskId, status: "pending", version }
    })()
  }

  getStatus(docId: string): IngestionStatus | null {
    if (!this.docRepo.exists(docId)) return null

    const documentVersion = this.docRepo.getVersionInfo(docId)
    if (!documentVersion) return null

    return {
      docId,
      task: this.taskRepo.getByDocId(docId),
      documentStatus: this.docRepo.getStatus(docId),
      lifecycleOutcome: this.docRepo.getLifecycleOutcome(docId),
      documentVersion,
      spanTree: buildSpanTree(this.spanRepo.listByDoc(docId)),
    }
  }

  getDeadLetter(taskId: number): DeadLetter | null {
    return this.taskRepo.getDeadLetter(taskId)
  }

  cancel(docId: string): IngestionCancellationResult | null {
    const task = this.taskRepo.getByDocId(docId)
    if (!task) return null
    if (task.status !== "pending" && task.status !== "running") {
      return { docId, taskId: task.id, status: task.status, changed: false }
    }

    return this.db.transaction((): IngestionCancellationResult => {
      const changed = this.taskRepo.cancel(task.id)
      if (!changed) {
        const current = this.taskRepo.getByDocId(docId)!
        return {
          docId,
          taskId: current.id,
          status: current.status,
          changed: false,
        }
      }
      this.docRepo.updateStatus(docId, "cancelled")
      this.spanRepo.cancelOpen(docId, this.now().toISOString())
      RUNNING_ABORT_CONTROLLERS.get(docId)?.abort()
      return { docId, taskId: task.id, status: "cancelled", changed: true }
    })()
  }

  recoverStaleClaims(claimedTimeoutMs: number): number {
    if (!Number.isFinite(claimedTimeoutMs) || claimedTimeoutMs <= 0) {
      throw new Error("claimedTimeoutMs must be a positive number")
    }

    const recoveredAt = this.now()
    const cutoff = new Date(recoveredAt.getTime() - claimedTimeoutMs).toISOString()
    let recovered = 0

    while (this.db.transaction(() => {
      const task = this.taskRepo.claimStale(cutoff)
      if (!task) return false

      const error = new Error(`Ingestion claim timed out after ${claimedTimeoutMs}ms`)
      const retryDelay = RETRY_DELAYS_MS[task.failCount]
      const nextAttemptAt = retryDelay === undefined
        ? null
        : new Date(recoveredAt.getTime() + retryDelay).toISOString()
      const spans = this.spanRepo.listByDoc(task.docId)
      const root = [...spans].reverse().find(
        (span) => span.kind === "root" && span.status === "running"
      )

      if (root) {
        for (const span of spans) {
          if (span.parentSpanId === root.spanId && span.status === "running") {
            this.spanRepo.markFailed(
              span.spanId,
              error.message,
              recoveredAt.toISOString(),
              span.startedAt
                ? recoveredAt.getTime() - new Date(span.startedAt).getTime()
                : 0,
              error.stack ?? null
            )
          }
        }
        this.spanRepo.skipPendingChildren(root.spanId, recoveredAt.toISOString())
        this.spanRepo.markFailed(
          root.spanId,
          error.message,
          recoveredAt.toISOString(),
          root.startedAt
            ? recoveredAt.getTime() - new Date(root.startedAt).getTime()
            : 0,
          error.stack ?? null
        )
      }

      const recorded = retryDelay === undefined
        ? this.taskRepo.deadLetter(
            task,
            error.message,
            error.stack ?? null,
            recoveredAt.toISOString()
          )
        : this.taskRepo.recordFailure(task.id, nextAttemptAt, task.claimedAt)
      if (!recorded) {
        throw new Error(`Stale ingestion task ${task.id} could not be recovered`)
      }
      if (nextAttemptAt === null) {
        this.docRepo.updateStatus(task.docId, "failed")
      }
      return true
    })()) {
      recovered += 1
    }

    return recovered
  }

  async runNext(): Promise<IngestionExecutionResult | null> {
    const task = this.taskRepo.claimNext()
    if (!task) return null

    const document = this.docRepo.get(task.docId)
    if (!document) {
      this.taskRepo.finalize(task.id, "failed", task.claimedAt)
      throw new Error(`Document not found: ${task.docId}`)
    }

    const rootSpanId = uuid()
    const rootStartedAt = this.now()
    const stageSpanIds = new Map<IngestionStageName, string>()

    this.db.transaction(() => {
      this.spanRepo.insert({
        docId: task.docId,
        spanId: rootSpanId,
        parentSpanId: null,
        name: "ingest",
        kind: "root",
        status: "running",
        input: { docId: task.docId },
        output: null,
        errorMessage: null,
        startedAt: rootStartedAt.toISOString(),
        finishedAt: null,
        durationMs: null,
      })

      for (const name of INGESTION_STAGE_NAMES) {
        const spanId = uuid()
        stageSpanIds.set(name, spanId)
        this.spanRepo.insert({
          docId: task.docId,
          spanId,
          parentSpanId: rootSpanId,
          name,
          kind: "stage",
          status: "pending",
          input: null,
          output: null,
          errorMessage: null,
          startedAt: null,
          finishedAt: null,
          durationMs: null,
        })
      }
    })()

    const abortController = new AbortController()
    RUNNING_ABORT_CONTROLLERS.set(task.docId, abortController)
    let retryable = true
    try {
      const execution = new TrackedStageExecution(
        this.spanRepo,
        stageSpanIds,
        this.now,
        abortController.signal
      )
      const summary = await this.stageRunner.run(
        document,
        execution
      )
      retryable = false
      execution.assertComplete()
      this.db.transaction(() => {
        const finishedAt = this.now()
        if (
          !this.spanRepo.markDone(
            rootSpanId,
            { stages: [...INGESTION_STAGE_NAMES], ...(summary ?? {}) },
            finishedAt.toISOString(),
            finishedAt.getTime() - rootStartedAt.getTime()
          )
        ) {
          throw new Error("Ingestion root span could not be completed")
        }
        if (!this.taskRepo.finalize(task.id, "completed", task.claimedAt)) {
          throw new Error(`Ingestion task ${task.id} could not be completed`)
        }
        this.docRepo.updateStatus(task.docId, "completed")
        // P6.1 (spec L73, L1574): IngestionLifecycle owns terminal activation.
        // `ACTIVATION_MODE=review` blocks unreviewed versions from active
        // status — the completed candidate is marked `pending_review` and
        // does NOT become active until human approval via
        // `CandidateReviewStore.review()` (spec L1575). HTTP, worker,
        // pipeline, and repository do NOT implement implicit success
        // transfer. `ACTIVATION_MODE=auto` (default) preserves the existing
        // behavior — activate immediately on completion.
        if (this.activationMode === "review") {
          this.docRepo.markPendingReview(task.docId)
        } else {
          this.docRepo.activate(task.docId)
        }
      })()
      return { taskId: task.id, docId: task.docId, rootSpanId, success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const errorStack = error instanceof Error ? error.stack ?? null : null
      const finishedAt = this.now()
      const retryDelay = retryable ? RETRY_DELAYS_MS[task.failCount] : undefined
      const nextAttemptAt = retryDelay === undefined
        ? null
        : new Date(finishedAt.getTime() + retryDelay).toISOString()
      const cancellationWon = this.db.transaction(() => {
        this.spanRepo.skipPendingChildren(rootSpanId, finishedAt.toISOString())
        this.spanRepo.markFailed(
          rootSpanId,
          message,
          finishedAt.toISOString(),
          finishedAt.getTime() - rootStartedAt.getTime(),
          errorStack
        )
        const recorded = retryable && retryDelay === undefined
          ? this.taskRepo.deadLetter(
              task,
              message,
              errorStack,
            finishedAt.toISOString()
          )
          : this.taskRepo.recordFailure(task.id, nextAttemptAt, task.claimedAt)
        if (!recorded) {
          if (this.taskRepo.getById(task.id)?.status === "cancelled") return true
          throw new Error(`Ingestion task ${task.id} failure could not be recorded`)
        }
        if (nextAttemptAt === null) {
          this.docRepo.updateStatus(task.docId, "failed")
        }
        return false
      })()
      if (cancellationWon) {
        return {
          taskId: task.id,
          docId: task.docId,
          rootSpanId,
          success: false,
          cancelled: true,
          error: "cancelled",
        }
      }
      return {
        taskId: task.id,
        docId: task.docId,
        rootSpanId,
        success: false,
        error: message,
      }
    } finally {
      if (RUNNING_ABORT_CONTROLLERS.get(task.docId) === abortController) {
        RUNNING_ABORT_CONTROLLERS.delete(task.docId)
      }
    }
  }
}
