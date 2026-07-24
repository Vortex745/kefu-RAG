import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createObservabilityRouter } from "./observability"

async function listen(app: express.Express) {
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

function buildApp(ragasArtifactPath: string) {
  const app = express()
  app.use("/api", createObservabilityRouter({ ragasArtifactPath }))
  return app
}

test("standalone observability run-list route is removed", async () => {
  const root = mkdtempSync(join(tmpdir(), "rag-observability-"))
  const app = buildApp(join(root, "ragas.json"))
  const { server, port } = await listen(app)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/observability/runs`)
    assert.equal(response.status, 404)
  } finally {
    server.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("observability ragas returns an honest empty state when no artifact exists", async () => {
  const root = mkdtempSync(join(tmpdir(), "rag-observability-"))
  const app = buildApp(join(root, "missing.json"))
  const { server, port } = await listen(app)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/observability/ragas`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { available: false, reason: "not_generated" })
  } finally {
    server.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("observability ragas projects only validated evaluation fields", async () => {
  const root = mkdtempSync(join(tmpdir(), "rag-observability-"))
  const artifactPath = join(root, "ragas.json")
  writeFileSync(artifactPath, JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-07-20T00:00:00.000Z",
    datasetVersion: "golden-v1",
    repositoryRevision: "abc123",
    secret: "must-not-leak",
    ragas: {
      runtime: { ragasVersion: "0.2.14", pythonVersion: "3.11.6", runnerSchemaVersion: 1 },
      evaluatorModelIdentities: { chat: "chat-model", embedding: "embed-model" },
      aggregate: {
        meanFaithfulness: 0.91,
        meanAnswerRelevancy: 0.84,
        meanContextPrecision: 0.79,
        meanContextRecall: 0.88,
        sampleSize: 1,
        errorCount: 0,
        skippedCount: 0,
        secret: "aggregate-secret",
      },
      perCase: [{
        caseId: "case-1",
        status: "ok",
        durationMs: 450,
        metrics: [{ name: "faithfulness", score: 0.91, secret: "metric-secret" }],
      }],
    },
  }))
  const app = buildApp(artifactPath)
  const { server, port } = await listen(app)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/observability/ragas`)
    assert.equal(response.status, 200)
    const body = await response.json() as { available: boolean; aggregate: { sampleSize: number } }
    assert.equal(body.available, true)
    assert.equal(body.aggregate.sampleSize, 1)
    assert.equal(JSON.stringify(body).includes("must-not-leak"), false)
    assert.equal(JSON.stringify(body).includes("aggregate-secret"), false)
    assert.equal(JSON.stringify(body).includes("metric-secret"), false)
  } finally {
    server.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("observability ragas sanitizes malformed artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "rag-observability-"))
  const artifactPath = join(root, "ragas.json")
  writeFileSync(artifactPath, "{broken")
  const app = buildApp(artifactPath)
  const { server, port } = await listen(app)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/observability/ragas`)
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { available: false, reason: "invalid_artifact" })
  } finally {
    server.close()
    rmSync(root, { recursive: true, force: true })
  }
})
