import { Router, type Request, type Response } from "express"
import {
  InvalidFeedbackReasonCodeError,
  type FeedbackStore,
  type FeedbackUpsertInput,
} from "../answer/feedback_store"
import { singleTenantAccessContext, type AccessContext } from "../access/context"
import type { FeedbackRating, FeedbackReasonCode } from "../types/answer"

const VALID_RATINGS: readonly FeedbackRating[] = ["up", "down"]

function resolveContext(res: Response): AccessContext {
  return (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
}

interface FeedbackRequestBody {
  rating?: FeedbackRating
  reasonCode?: FeedbackReasonCode | null
  comment?: string
  evidenceIds?: string[]
}

export function createFeedbackRouter(feedbackStore: FeedbackStore): Router {
  const router = Router()

  router.put("/chat/runs/:runId/feedback", (req: Request, res: Response) => {
    const ctx = resolveContext(res)
    const runId = String(req.params.runId)
    const body = req.body as FeedbackRequestBody | undefined

    if (!body?.rating || !VALID_RATINGS.includes(body.rating)) {
      res.status(400).json({ error: "invalid or missing rating", rating: body?.rating })
      return
    }

    const input: FeedbackUpsertInput = {
      runId,
      tenantId: ctx.tenantId,
      subjectId: ctx.subjectId,
      rating: body.rating,
      reasonCode: body.reasonCode ?? null,
      comment: body.comment ?? null,
      evidenceIds: body.evidenceIds ?? [],
    }

    try {
      const stored = feedbackStore.upsert(input)
      res.status(200).json(stored)
    } catch (err) {
      if (err instanceof InvalidFeedbackReasonCodeError) {
        res.status(400).json({
          error: "invalid reason code",
          rating: err.rating,
          reasonCode: err.reasonCode,
        })
        return
      }
      throw err
    }
  })

  return router
}