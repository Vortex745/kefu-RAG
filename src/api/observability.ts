import { Router, type Request, type Response } from "express"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

const RAGAS_METRICS = new Set([
  "faithfulness",
  "answer_relevancy",
  "context_precision",
  "context_recall",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function projectRagasArtifact(value: unknown) {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("invalid artifact")
  const metadata = {
    generatedAt: typeof value.generatedAt === "string" ? value.generatedAt : null,
    datasetVersion: typeof value.datasetVersion === "string" ? value.datasetVersion : null,
    repositoryRevision: typeof value.repositoryRevision === "string" ? value.repositoryRevision : null,
  }
  if (value.ragas === undefined) {
    return { available: false as const, reason: "ragas_not_present" as const, ...metadata }
  }
  if (!isRecord(value.ragas)) throw new Error("invalid ragas section")
  const { aggregate, runtime, evaluatorModelIdentities, perCase } = value.ragas
  if (!isRecord(aggregate)
    || !isScore(aggregate.meanFaithfulness)
    || !isScore(aggregate.meanAnswerRelevancy)
    || !isScore(aggregate.meanContextPrecision)
    || !isScore(aggregate.meanContextRecall)
    || !isCount(aggregate.sampleSize)
    || !isCount(aggregate.errorCount)
    || !isCount(aggregate.skippedCount)
    || !isRecord(runtime)
    || typeof runtime.ragasVersion !== "string"
    || typeof runtime.pythonVersion !== "string"
    || !isCount(runtime.runnerSchemaVersion)
    || !isRecord(evaluatorModelIdentities)
    || typeof evaluatorModelIdentities.chat !== "string"
    || typeof evaluatorModelIdentities.embedding !== "string"
    || !Array.isArray(perCase)
    || perCase.length > 1000) {
    throw new Error("invalid ragas section")
  }

  const projectedCases = perCase.map((item) => {
    if (!isRecord(item)
      || typeof item.caseId !== "string"
      || !["ok", "error", "skipped"].includes(String(item.status))) {
      throw new Error("invalid ragas case")
    }
    const status = item.status as "ok" | "error" | "skipped"
    const metrics = item.metrics === undefined ? [] : item.metrics
    if (!Array.isArray(metrics) || metrics.some((metric) =>
      !isRecord(metric)
      || typeof metric.name !== "string"
      || !RAGAS_METRICS.has(metric.name)
      || !isScore(metric.score)
      || (metric.rationale !== undefined && typeof metric.rationale !== "string")
    )) {
      throw new Error("invalid ragas metrics")
    }
    const projectedMetrics = metrics.map((metric) => ({
      name: metric.name as string,
      score: metric.score as number,
      rationale: typeof metric.rationale === "string" ? metric.rationale.slice(0, 1000) : null,
    }))
    return {
      caseId: item.caseId,
      status,
      metrics: projectedMetrics,
      durationMs: typeof item.durationMs === "number" && Number.isFinite(item.durationMs)
        ? Math.max(0, item.durationMs)
        : null,
      error: isRecord(item.error) && typeof item.error.kind === "string" && typeof item.error.message === "string"
        ? { kind: item.error.kind.slice(0, 100), message: item.error.message.slice(0, 1000) }
        : null,
      skippedReason: typeof item.skippedReason === "string" ? item.skippedReason.slice(0, 1000) : null,
    }
  })

  return {
    available: true as const,
    ...metadata,
    runtime: {
      ragasVersion: runtime.ragasVersion,
      pythonVersion: runtime.pythonVersion,
      runnerSchemaVersion: runtime.runnerSchemaVersion,
    },
    evaluatorModelIdentities: {
      chat: evaluatorModelIdentities.chat,
      embedding: evaluatorModelIdentities.embedding,
      evaluator: typeof evaluatorModelIdentities.evaluator === "string"
        ? evaluatorModelIdentities.evaluator
        : null,
    },
    aggregate: {
      meanFaithfulness: aggregate.meanFaithfulness,
      meanAnswerRelevancy: aggregate.meanAnswerRelevancy,
      meanContextPrecision: aggregate.meanContextPrecision,
      meanContextRecall: aggregate.meanContextRecall,
      sampleSize: aggregate.sampleSize,
      errorCount: aggregate.errorCount,
      skippedCount: aggregate.skippedCount,
    },
    perCase: projectedCases,
  }
}

export function createObservabilityRouter(
  options?: { ragasArtifactPath?: string },
): Router {
  const router = Router()
  const ragasArtifactPath = resolve(options?.ragasArtifactPath ?? "./data/ragas-latest.json")

  router.get("/observability/ragas", async (_req: Request, res: Response) => {
    try {
      const artifact = JSON.parse(await readFile(ragasArtifactPath, "utf8")) as unknown
      res.json(projectRagasArtifact(artifact))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        res.json({ available: false, reason: "not_generated" })
        return
      }
      res.status(500).json({ available: false, reason: "invalid_artifact" })
    }
  })

  return router
}
