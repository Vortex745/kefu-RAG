import { Router, type Request, type Response } from "express"
import { singleTenantAccessContext, type AccessContext } from "../access/context"
import type { DB } from "../ingestion/tracking/db"
import type { CandidateReviewStore } from "../knowledge/candidate_review_store"
import { InvalidReviewConflictError } from "../knowledge/candidate_review_store"
import type { RetirementService } from "../knowledge/retirement"
import type { SourceLifecycleStore } from "../knowledge/source_lifecycle_store"
import type {
  ReviewDecision,
  SourceLifecycleState,
  SourceStatusSummary,
  SourceTombstone,
} from "../types/governance"

/**
 * Ticket 11 Phase E P5 — Source governance HTTP API (spec §11 L1580-1583).
 *
 * Three endpoints, all tenant-scoped via res.locals.accessContext:
 *
 *   POST  /api/ingest/:docId/review       — review scope (L1580)
 *   POST  /api/sources/:sourceId/retire   — admin scope (L1581)
 *   GET   /api/sources/:sourceId/status  — admin scope (L1582)
 *
 * Error semantics (spec L1580-1583):
 *   - 400 for invalid decision, missing/empty reason, reason too long
 *   - 403 for missing scope (review or admin)
 *   - 404 for cross-tenant or non-existent IDs (never reveal existence)
 *   - 409 for conflicting review decision (InvalidReviewConflictError)
 *   - 200 for happy path AND idempotent re-call (preserves first call's fields)
 *
 * Actor identity: per types/governance.ts L101-103, the actor field is
 * populated from res.locals.accessContext.subjectId, NOT from the request
 * body — this prevents clients from spoofing reviewer identity.
 *
 * Reference: Ticket 09 P5 handoff.ts (same Router + resolveContext pattern).
 */

const MAX_REASON_LENGTH = 1000

const CLEANUP_OPS_LIST = [
  "cleanup_es",
  "cleanup_neo4j",
  "cleanup_pageindex",
  "cleanup_images",
] as const

const VALID_DECISIONS: readonly ReviewDecision[] = ["approve", "reject"]

function resolveContext(res: Response): AccessContext {
  return (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
}

/**
 * Spec L1580: POST /api/ingest/:docId/review requires `review` OR `admin`
 * scope. In single_tenant mode ALL_LOCAL_SCOPES includes both — the check
 * activates under enforced mode where the IdentityAdapter grants scopes.
 */
function requireReviewOrAdmin(ctx: AccessContext, res: Response): boolean {
  if (!ctx.scopes.includes("review") && !ctx.scopes.includes("admin")) {
    res.status(403).json({ error: "missing scope: review or admin" })
    return false
  }
  return true
}

/**
 * Spec L1581-1582: POST /retire and GET /status require `admin` scope.
 * Review alone is NOT enough — these are operational/admin actions.
 */
function requireAdmin(ctx: AccessContext, res: Response): boolean {
  if (!ctx.scopes.includes("admin")) {
    res.status(403).json({ error: "missing scope: admin" })
    return false
  }
  return true
}

/**
 * Validate a reason string: non-empty, max MAX_REASON_LENGTH chars.
 * Returns true if valid; res sends 400 and returns false otherwise.
 */
function validateReason(reason: unknown, res: Response): reason is string {
  if (typeof reason !== "string" || reason.length === 0 || reason.length > MAX_REASON_LENGTH) {
    res
      .status(400)
      .json({ error: `reason must be a non-empty string (max ${MAX_REASON_LENGTH} chars)` })
    return false
  }
  return true
}

interface ReviewRequestBody {
  decision?: ReviewDecision
  reason?: string
}

interface RetireRequestBody {
  reason?: string
}

interface StoredSource {
  source_id: string
  tenant_id: string
  lifecycle_state: string
  active_doc_id: string | null
}

interface StoredDocId {
  doc_id: string
}

interface CountRow {
  n: number
}

/**
 * Compute the SourceStatusSummary (spec L1582) — Tenant-bound Source
 * lifecycle, active/candidate version identities and cleanup/dead-letter
 * summary without exposing raw content.
 *
 * Returns null if the Source doesn't exist OR belongs to a different
 * tenant (cross-tenant → 404 per spec L1582).
 *
 * cleanupSummary counts (per spec L1582):
 *   - pending: cleanup tasks (op IN CLEANUP_OPS) with status IN
 *     ('pending', 'running') — active cleanup work
 *   - failed: cleanup tasks with status='failed' but NOT in
 *     task_dead_letters — failed without retry, not yet dead-lettered
 *   - deadLettered: cleanup tasks in task_dead_letters — permanently failed,
 *     requires manual intervention
 *
 * Completed/cancelled tasks are NOT counted in any category — they
 * represent finished work, not pending or failed work.
 */
function computeStatusSummary(
  db: DB,
  lifecycleStore: SourceLifecycleStore,
  sourceId: string,
  tenantId: string
): SourceStatusSummary | null {
  const sourceRow = db.prepare(
    `SELECT source_id, tenant_id, lifecycle_state, active_doc_id
     FROM sources WHERE source_id = ? AND tenant_id = ?`
  ).get(sourceId, tenantId) as StoredSource | undefined
  if (!sourceRow) return null

  const candidateRows = db.prepare(
    `SELECT doc_id FROM documents
     WHERE source_id = ? AND tenant_id = ? AND candidate_state = 'pending_review'
     ORDER BY activation_order ASC, doc_id ASC`
  ).all(sourceId, tenantId) as StoredDocId[]

  const lastTombstone: SourceTombstone | null =
    lifecycleStore.getLatestTombstone(sourceId, tenantId)

  const cleanupOpsIn = CLEANUP_OPS_LIST.map(op => `'${op}'`).join(", ")

  const pendingRow = db.prepare(
    `SELECT COUNT(*) AS n FROM task_pending_ops t
     JOIN documents d ON t.doc_id = d.doc_id
     WHERE d.source_id = ? AND d.tenant_id = ?
       AND t.op IN (${cleanupOpsIn})
       AND t.status IN ('pending', 'running')`
  ).get(sourceId, tenantId) as CountRow

  const failedRow = db.prepare(
    `SELECT COUNT(*) AS n FROM task_pending_ops t
     JOIN documents d ON t.doc_id = d.doc_id
     WHERE d.source_id = ? AND d.tenant_id = ?
       AND t.op IN (${cleanupOpsIn})
       AND t.status = 'failed'
       AND t.id NOT IN (SELECT task_id FROM task_dead_letters)`
  ).get(sourceId, tenantId) as CountRow

  const deadLetteredRow = db.prepare(
    `SELECT COUNT(*) AS n FROM task_dead_letters dl
     JOIN documents d ON dl.doc_id = d.doc_id
     WHERE d.source_id = ? AND d.tenant_id = ?
       AND dl.op IN (${cleanupOpsIn})`
  ).get(sourceId, tenantId) as CountRow

  return {
    sourceId,
    tenantId,
    lifecycleState: sourceRow.lifecycle_state as SourceLifecycleState,
    activeDocId: sourceRow.active_doc_id,
    candidateDocIds: candidateRows.map(r => r.doc_id),
    lastTombstone,
    cleanupSummary: {
      pending: pendingRow.n,
      failed: failedRow.n,
      deadLettered: deadLetteredRow.n,
    },
  }
}

interface SourceGovernanceRouterDeps {
  db: DB
  candidateReviewStore: CandidateReviewStore
  retirementService: RetirementService
  lifecycleStore: SourceLifecycleStore
}

export function createSourceGovernanceRouter(deps: SourceGovernanceRouterDeps): Router {
  const router = Router()
  const { db, candidateReviewStore, retirementService, lifecycleStore } = deps

  // POST /api/ingest/:docId/review — review scope (spec L1580)
  router.post("/ingest/:docId/review", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireReviewOrAdmin(ctx, res)) return

    const docId = String(req.params.docId)
    const body = req.body as ReviewRequestBody | undefined

    if (!body?.decision || !VALID_DECISIONS.includes(body.decision)) {
      res.status(400).json({ error: "invalid or missing decision", decision: body?.decision })
      return
    }
    if (!validateReason(body.reason, res)) return

    // Actor from ctx.subjectId — prevents spoofing via body.actor
    // (spec types/governance.ts L101-103)
    const actor = ctx.subjectId

    try {
      const result = candidateReviewStore.review(
        docId,
        ctx.tenantId,
        body.decision,
        body.reason,
        actor
      )
      if (!result) {
        // Cross-tenant or non-existent — 404 (never reveal existence)
        res.status(404).json({ error: "document not found" })
        return
      }
      res.status(200).json(result)
    } catch (err) {
      if (err instanceof InvalidReviewConflictError) {
        res.status(409).json({
          error: "conflicting review decision",
          docId: err.docId,
          currentCandidateState: err.currentCandidateState,
          requestedDecision: err.requestedDecision,
        })
        return
      }
      throw err
    }
  })

  // POST /api/sources/:sourceId/retire — admin scope (spec L1581)
  router.post("/sources/:sourceId/retire", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return

    const sourceId = String(req.params.sourceId)
    const body = req.body as RetireRequestBody | undefined
    if (!validateReason(body?.reason, res)) return

    // Actor from ctx.subjectId — prevents spoofing via body.actor
    const actor = ctx.subjectId

    const result = retirementService.retire(sourceId, ctx.tenantId, body.reason, actor)
    if (!result) {
      // Cross-tenant or non-existent — 404 (never reveal existence)
      res.status(404).json({ error: "source not found" })
      return
    }
    res.status(200).json(result)
  })

  // GET /api/sources/:sourceId/status — admin scope (spec L1582)
  router.get("/sources/:sourceId/status", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireAdmin(ctx, res)) return

    const sourceId = String(req.params.sourceId)
    const summary = computeStatusSummary(db, lifecycleStore, sourceId, ctx.tenantId)
    if (!summary) {
      // Cross-tenant or non-existent — 404 (never reveal existence)
      res.status(404).json({ error: "source not found" })
      return
    }
    res.status(200).json(summary)
  })

  return router
}
