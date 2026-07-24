import { Router, Request, Response } from "express"
import { v4 as uuid } from "uuid"
import type { AnswerRunOptions } from "../answer/generation"
import { AnswerTraceRepository } from "../answer/trace_repository"
import type { AnswerRunEvent } from "../types"
import { singleTenantAccessContext, type AccessContext } from "../access/context"
import type { SqliteSessionBinder } from "../access/session_binder"

interface ChatRequest {
  message: string
  /** Defaults to true. Set to false only for legacy non-streaming clients. */
  stream?: boolean
  runId?: string
  sessionId?: string
  /** Legacy field; ignored — the deployment-configured model is always used. */
  model?: string
}

function streamPayload(event: AnswerRunEvent, sessionId: string) {
  return {
    sessionId,
    runId: event.runId,
    event,
    ...(event.type === "answer_delta" ? { token: event.token } : {}),
    ...(event.type === "done" ? {
      done: true,
      status: event.result.status,
      references: event.result.references,
      degradation: event.result.degradation,
    } : {}),
  }
}

/**
 * Source of answer-run events for the HTTP transport. The composition root
 * must inject the Mastra-backed source.
 */
export type AnswerEventsSource = (
  message: string,
  options: AnswerRunOptions
) => AsyncIterable<AnswerRunEvent>

/**
 * T49: createChatRouter only needs traceRepository for the GET /chat/runs/:runId
 * endpoint (reading history). Trace persistence and export fanout are now owned
 * by the Answer run module via AnswerRunObserver — the HTTP route no longer
 * appends events or calls LangfuseExporter.
 *
 * Transport tests inject a stub to verify encoding without live providers.
 */
export function createChatRouter(
  traceRepository: AnswerTraceRepository,
  eventsSource: AnswerEventsSource,
  sessionBinder?: SqliteSessionBinder,
): Router {
  const router = Router()

  router.get("/chat/runs/:runId", (req: Request, res: Response) => {
    const history = traceRepository.getRun(String(req.params.runId))
    if (!history) {
      res.status(404).json({ error: "Answer run not found" })
      return
    }
    res.json(history)
  })

  router.post("/chat", async (req: Request, res: Response) => {
    const {
      message,
      stream: requestedStream,
      runId: requestedRunId,
      sessionId: requestedSessionId,
    } = req.body as ChatRequest
    // Default to streaming so legacy callers and the in-app UI get instant
    // token-by-token output without an opt-in field. Explicit false is honored
    // for the non-streaming JSON transport.
    const stream = requestedStream !== false
    if (!message?.trim()) {
      res.status(400).json({ error: "message is required" })
      return
    }

    const sessionId = typeof requestedSessionId === "string"
      && /^[a-zA-Z0-9-]{1,100}$/.test(requestedSessionId)
      ? requestedSessionId
      : uuid()
    const runId = typeof requestedRunId === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(requestedRunId)
      ? requestedRunId
      : uuid()

    // The legacy `model` field is accepted but ignored — the deployment-
    // configured model (cfg.openaiChatModel) is always used. Trace and export
    // metadata name that configured model, not a per-request override.
    const runOptions: AnswerRunOptions = {
      runId,
      sessionId,
      signal: undefined,
      accessContext: undefined,
    }

    // Ticket 05 follow-up wiring: bind sessionId → (tenantId, subjectId)
    // before any side effect. The identity comes from the access middleware
    // (res.locals.accessContext) when mounted; otherwise fall back to the
    // single-tenant deterministic identity so the binder always receives a
    // non-empty tenant/subject even in bare-router mode (backward compat).
    // On conflict, return 409 WITHOUT calling eventsSource — no Answer run
    // may be created on a rejected binding (side-effect gating).
    //
    // Ticket 07 P6: the same accessContext is propagated to the Answer run
    // (eventsSource → Mastra runner → Searcher.search) so the
    // retrieval-layer ACL filters (P1-P5) receive a non-undefined context.
    // In single_tenant mode the middleware already injects the deterministic
    // AccessContext, so this wiring is a behavior no-op there; it activates
    // under enforced mode where res.locals.accessContext carries the real
    // tenant/subject/groups resolved by the IdentityAdapter.
    const accessContext: AccessContext =
      (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
    if (sessionBinder) {
      const bindResult = sessionBinder.bindOrCheck(
        sessionId,
        accessContext.tenantId,
        accessContext.subjectId
      )
      if (!bindResult.ok) {
        res.status(409).json({
          error: "session binding conflict",
          sessionId,
          existing: {
            tenantId: bindResult.conflict.existing.tenantId,
            subjectId: bindResult.conflict.existing.subjectId,
          },
        })
        return
      }
    }

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream")
      res.setHeader("Cache-Control", "no-cache")
      res.setHeader("Connection", "keep-alive")
      res.setHeader("X-Accel-Buffering", "no")

      const clientGone = { value: false }
      const abortController = new AbortController()
      const onClientClose = () => {
        clientGone.value = true
        abortController.abort()
      }
      res.on("close", onClientClose)
      try {
        // The injected source guarantees a terminal event on every path.
        // HTTP only encodes events to SSE.
        for await (const event of eventsSource(message, {
          ...runOptions,
          signal: abortController.signal,
          accessContext,
        })) {
          if (clientGone.value || res.writableEnded) break
          res.write(`data: ${JSON.stringify(streamPayload(event, sessionId))}\n\n`)
        }
      } catch (err) {
        if (!clientGone.value) console.error("[chat] Error:", err)
      }
      res.off("close", onClientClose)
      if (!res.writableEnded) res.end()
    } else {
      const clientGone = { value: false }
      const abortController = new AbortController()
      const onClientClose = () => {
        if (res.writableEnded) return
        clientGone.value = true
        abortController.abort()
      }
      const events: AnswerRunEvent[] = []
      res.on("close", onClientClose)
      try {
        let terminal: Extract<AnswerRunEvent, { type: "done" }> | undefined
        for await (const event of eventsSource(message, {
          ...runOptions,
          signal: abortController.signal,
          accessContext,
        })) {
          events.push(event)
          if (event.type === "done") terminal = event
        }
        if (!terminal) throw new Error("Answer run ended without a terminal event")
        res.json({
          reply: terminal.result.reply,
          sessionId,
          runId: terminal.result.runId,
          status: terminal.result.status,
          references: terminal.result.references,
          degradation: terminal.result.degradation,
          events,
        })
      } catch (err) {
        if (!clientGone.value) console.error("[chat] Error:", err)
        if (!clientGone.value && !res.writableEnded) {
          res.status(500).json({
            error: "Internal error",
            sessionId,
            runId,
            events,
          })
        }
      } finally {
        res.off("close", onClientClose)
      }
    }
  })

  return router
}
