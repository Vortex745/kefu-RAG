import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"
import type { Request, Response, NextFunction } from "express"
import { createFeedbackRouter } from "./feedback"
import { SqliteFeedbackStore } from "../answer/feedback_store"
import { type AccessContext, type Scope } from "../access/context"
import { openDb } from "../ingestion/tracking/db"

const ALL_SCOPES: Scope[] = ["chat", "ingest", "review", "admin"]

function buildApp(options: {
  feedbackStore?: SqliteFeedbackStore
  middleware?: (req: Request, res: Response, next: NextFunction) => void
} = {}) {
  const app = express()
  const db = openDb(":memory:")
  const feedbackStore = options.feedbackStore ?? new SqliteFeedbackStore(db)
  app.use(express.json())
  if (options.middleware) {
    app.use(options.middleware)
  }
  app.use("/api", createFeedbackRouter(feedbackStore))
  return { app, db, feedbackStore }
}

async function listen(app: express.Express) {
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

async function putFeedback(
  port: number,
  runId: string,
  body: unknown = {},
  headers: Record<string, string> = {}
) {
  const res = await fetch(`http://127.0.0.1:${port}/api/chat/runs/${runId}/feedback`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null }
}

function multiTenantMiddleware(req: Request, res: Response, next: NextFunction): void {
  const tenant = (req.headers["x-test-tenant"] as string | undefined) ?? "default"
  res.locals.accessContext = {
    tenantId: tenant,
    subjectId: `user-${tenant}`,
    groups: [],
    scopes: ALL_SCOPES,
  } satisfies AccessContext
  next()
}

test("PUT /feedback: happy path - rating=up returns 200 with normalized stored record", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const res = await putFeedback(port, "run-up-1", { rating: "up" })
    assert.equal(res.status, 200, "PUT rating=up must return 200")
    assert.equal(res.json?.rating, "up")
    assert.equal(res.json?.reasonCode, null, "rating=up must store null reasonCode")
    assert.equal(res.json?.runId, "run-up-1")
    assert.equal(res.json?.comment, null, "missing comment defaults to null")
    assert.ok(Array.isArray(res.json?.evidenceIds) && (res.json!.evidenceIds as unknown[]).length === 0, "missing evidenceIds defaults to []")
    assert.ok(res.json?.id, "stored record must have an id")
    assert.ok(res.json?.createdAt, "stored record must have createdAt")
    assert.ok(res.json?.updatedAt, "stored record must have updatedAt")
  } finally {
    server.close()
    db.close()
  }
})

test("PUT /feedback: happy path - rating=down with valid reasonCode returns 200", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const res = await putFeedback(port, "run-down-1", {
      rating: "down",
      reasonCode: "wrong_answer",
    })
    assert.equal(res.status, 200, "PUT rating=down with valid reasonCode must return 200")
    assert.equal(res.json?.rating, "down")
    assert.equal(res.json?.reasonCode, "wrong_answer")
  } finally {
    server.close()
    db.close()
  }
})

test("PUT /feedback: upsert - second PUT updates the existing record", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const r1 = await putFeedback(port, "run-upsert-1", {
      rating: "up",
      comment: "first comment",
    })
    assert.equal(r1.status, 200)
    const r2 = await putFeedback(port, "run-upsert-1", {
      rating: "down",
      reasonCode: "incomplete",
      comment: "changed my mind",
    })
    assert.equal(r2.status, 200, "second PUT (upsert) must return 200")
    assert.equal(r2.json?.id, r1.json?.id, "upsert must preserve the same id (UNIQUE triple)")
    assert.equal(r2.json?.rating, "down", "upsert must overwrite rating")
    assert.equal(r2.json?.reasonCode, "incomplete", "upsert must overwrite reasonCode")
    assert.equal(r2.json?.comment, "changed my mind", "upsert must overwrite comment")
    assert.equal(r2.json?.createdAt, r1.json?.createdAt, "upsert must preserve createdAt")
  } finally {
    server.close()
    db.close()
  }
})

test("PUT /feedback: optional comment is stored", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const res = await putFeedback(port, "run-comment-1", {
      rating: "down",
      reasonCode: "other",
      comment: "the answer was confusing",
    })
    assert.equal(res.status, 200)
    assert.equal(res.json?.comment, "the answer was confusing")
  } finally {
    server.close()
    db.close()
  }
})

test("PUT /feedback: evidenceIds array is stored", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const res = await putFeedback(port, "run-evid-1", {
      rating: "down",
      reasonCode: "wrong_citation",
      evidenceIds: ["ev-1", "ev-2"],
    })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json?.evidenceIds, ["ev-1", "ev-2"])
  } finally {
    server.close()
    db.close()
  }
})

test("PUT /feedback: missing rating returns 400", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const res = await putFeedback(port, "run-no-rating-1", { comment: "no rating" })
    assert.equal(res.status, 400, "missing rating must return 400")
    assert.ok(res.json?.error && /rating/i.test(String(res.json.error)))
  } finally {
    server.close()
    db.close()
  }
})

test("PUT /feedback: invalid rating returns 400", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const res = await putFeedback(port, "run-bad-rating-1", { rating: "sideways" })
    assert.equal(res.status, 400, "invalid rating must return 400 per spec L1552")
    assert.ok(res.json?.error && /rating/i.test(String(res.json.error)))
  } finally {
    server.close()
    db.close()
  }
})

test("PUT /feedback: rating=down without reasonCode returns 400", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const res = await putFeedback(port, "run-down-no-reason-1", { rating: "down" })
    assert.equal(res.status, 400, "rating=down without reasonCode must return 400")
    assert.equal(res.json?.rating, "down", "400 body must include rating from error")
  } finally {
    server.close()
    db.close()
  }
})

test("PUT /feedback: rating=down with invalid reasonCode returns 400", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const res = await putFeedback(port, "run-down-bad-reason-1", {
      rating: "down",
      reasonCode: "totally_made_up_code",
    })
    assert.equal(res.status, 400, "rating=down with invalid reasonCode must return 400 per spec L1552")
    assert.equal(res.json?.reasonCode, "totally_made_up_code", "400 body must include reasonCode from error")
  } finally {
    server.close()
    db.close()
  }
})

test("PUT /feedback: rating=up with reasonCode returns 400", async () => {
  const { app, db } = buildApp()
  const { server, port } = await listen(app)
  try {
    const res = await putFeedback(port, "run-up-with-reason-1", {
      rating: "up",
      reasonCode: "wrong_answer",
    })
    assert.equal(res.status, 400, "rating=up with reasonCode must return 400")
    assert.equal(res.json?.rating, "up")
  } finally {
    server.close()
    db.close()
  }
})

test("PUT /feedback: cross-tenant - different tenants each submit feedback for same runId", async () => {
  const { app, db } = buildApp({ middleware: multiTenantMiddleware })
  const { server, port } = await listen(app)
  try {
    const r1 = await putFeedback(port, "run-shared-1", { rating: "up" }, { "x-test-tenant": "tenant-a" })
    const r2 = await putFeedback(port, "run-shared-1", { rating: "down", reasonCode: "other" }, { "x-test-tenant": "tenant-b" })
    assert.equal(r1.status, 200, "tenant-a PUT must succeed")
    assert.equal(r2.status, 200, "tenant-b PUT must succeed (no cross-tenant conflict on upsert)")
    assert.notEqual(r1.json?.id, r2.json?.id, "each tenant gets its own feedback row (different ids)")
    assert.equal(r1.json?.tenantId, "tenant-a")
    assert.equal(r2.json?.tenantId, "tenant-b")
  } finally {
    server.close()
    db.close()
  }
})