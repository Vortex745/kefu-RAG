import { Router, type Request, type Response } from "express"
import {
  InvalidHandoffTransitionError,
  type HandoffCreateInput,
  type HandoffStore,
} from "../answer/handoff_store"
import { singleTenantAccessContext, type AccessContext } from "../access/context"
import type { HandoffReasonCode, HandoffState } from "../types/answer"

/**
 * Ticket 09 P5 — Handoff HTTP API (spec §8 L1549-1552).
 *
 * Three endpoints, all tenant-scoped via res.locals.accessContext:
 *
 *   POST   /chat/runs/:runId/handoff   — explicit user handoff request (L1542a)
 *   GET    /handoffs?status=<state>    — list Tenant-bound cases (L1550)
 *   PATCH  /handoffs/:caseId           — legal state transitions only (L1550)
 *
 * Error semantics (spec L1552):
 *   - 404 for cross-tenant run/case IDs (never reveal existence)
 *   - 409 for invalid state transitions (InvalidHandoffTransitionError)
 *   - 400 for invalid reason codes or status values
 *   - 403 for missing review/admin scope on GET + PATCH /handoffs
 *
 * The POST endpoint is idempotent by run_id (spec L1549 "creates or returns
 * the idempotent Handoff case"). If a case already exists for the run —
 * whether created by P4 auto-trigger (reasonCode="insufficient_evidence") or
 * a prior POST — the existing case is returned unchanged. The optional body
 * reason supplements but does NOT replace the domain terminal reason; this
 * is enforced structurally by HandoffStore.create's INSERT OR IGNORE.
 */

const VALID_REASON_CODES: readonly HandoffReasonCode[] = [
  "user_request",
  "policy_review",
  "insufficient_evidence",
  "provider_error",
  "other",
]

const VALID_STATES: readonly HandoffState[] = [
  "open",
  "claimed",
  "resolved",
  "cancelled",
]

/**
 * Spec L1550: GET + PATCH /handoffs require `review` or `admin` scope. In
 * single_tenant mode ALL_LOCAL_SCOPES includes both, so the check is a no-op;
 * it activates under enforced mode where the IdentityAdapter grants scopes.
 */
function requireReviewOrAdmin(ctx: AccessContext, res: Response): boolean {
  if (!ctx.scopes.includes("review") && !ctx.scopes.includes("admin")) {
    res.status(403).json({ error: "missing scope: review or admin" })
    return false
  }
  return true
}

/**
 * Resolve AccessContext from res.locals (set by access middleware) with a
 * single-tenant fallback for bare-router mode (no middleware mounted).
 */
function resolveContext(res: Response): AccessContext {
  return (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
}

interface HandoffRequestBody {
  reason?: HandoffReasonCode
  sessionId?: string
  userRequest?: string
  conversationSummary?: string
  evidenceIds?: string[]
}

export function createHandoffRouter(handoffStore: HandoffStore): Router {
  const router = Router()

  // POST /chat/runs/:runId/handoff — explicit user request (spec L1542a, L1549)
  router.post("/chat/runs/:runId/handoff", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    const runId = String(req.params.runId)
    const body = req.body as HandoffRequestBody | undefined

    // Validate optional body.reason — invalid reason code → 400 (spec L1552)
    if (body?.reason !== undefined && !VALID_REASON_CODES.includes(body.reason)) {
      res.status(400).json({ error: "invalid reason code", reason: body.reason })
      return
    }

    const input: HandoffCreateInput = {
      runId,
      tenantId: ctx.tenantId,
      subjectId: ctx.subjectId,
      sessionId: body?.sessionId ?? runId,
      reasonCode: body?.reason ?? "user_request",
      userRequest: body?.userRequest ?? "",
      conversationSummary: body?.conversationSummary ?? "",
      evidenceIds: body?.evidenceIds ?? [],
      traceReference: runId,
    }

    // create() is idempotent by run_id (INSERT OR IGNORE). Returns null when
    // a case already exists for the run_id but belongs to a different tenant
    // (cross-tenant conflict on UNIQUE) → 404 per spec L1552.
    const result = handoffStore.create(input)
    if (!result) {
      res.status(404).json({ error: "run not found" })
      return
    }
    res.status(200).json(result)
  })

  // GET /handoffs?status=<state> — list Tenant-bound cases (spec L1550)
  router.get("/handoffs", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireReviewOrAdmin(ctx, res)) return

    const status = req.query.status as HandoffState | undefined
    if (status !== undefined && !VALID_STATES.includes(status)) {
      res.status(400).json({ error: "invalid status filter", status })
      return
    }

    // listByTenant is always tenant-scoped — cross-tenant cases are never
    // returned. Ordered by created_at DESC (newest first).
    const cases = handoffStore.listByTenant(ctx.tenantId, status)
    res.status(200).json(cases)
  })

  // PATCH /handoffs/:caseId — legal state transitions only (spec L1550)
  router.patch("/handoffs/:caseId", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    if (!requireReviewOrAdmin(ctx, res)) return

    const caseId = String(req.params.caseId)
    const body = req.body as { status?: HandoffState } | undefined
    if (!body?.status || !VALID_STATES.includes(body.status)) {
      res.status(400).json({
        error: "invalid or missing target status",
        status: body?.status,
      })
      return
    }

    try {
      const updated = handoffStore.updateStatus(caseId, ctx.tenantId, body.status)
      // null = cross-tenant or non-existent → 404 per spec L1552 (do NOT
      // reveal whether the case exists for another tenant).
      if (!updated) {
        res.status(404).json({ error: "case not found" })
        return
      }
      res.status(200).json(updated)
    } catch (err) {
      if (err instanceof InvalidHandoffTransitionError) {
        res.status(409).json({
          error: "invalid state transition",
          from: err.fromStatus,
          to: err.toStatus,
        })
        return
      }
      throw err
    }
  })

  return router
}