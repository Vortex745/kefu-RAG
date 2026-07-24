import { Router, type Request, type Response } from "express"
import type OpenAI from "openai"

interface ModelEntry {
  id: string
  label: string
  source: "remote" | "fallback"
}

interface ModelsResponse {
  current: string
  models: ModelEntry[]
  baseUrl: string
  source: "remote" | "fallback"
  error: string | null
}

/**
 * Best-effort model list. Many OpenAI-compatible providers (e.g. DeepSeek,
 * ModelScope) don't expose /v1/models; we still return a usable list by
 * falling back to the configured chat model + a small set of commonly
 * supported model ids inferred from the baseUrl.
 */
export interface ModelsRouterDeps {
  chatClient: OpenAI
  currentModel: string
  baseUrl: string
}

const FALLBACK_CANDIDATES: Record<string, string[]> = {
  "api.deepseek.com": ["deepseek-v4-flash", "deepseek-v3-flash", "deepseek-chat"],
  "api-inference.modelscope.cn": [
    "deepseek-ai/DeepSeek-V4-Pro",
    "deepseek-ai/DeepSeek-V3",
    "Qwen/Qwen2.5-72B-Instruct",
  ],
  "api.openai.com": ["gpt-4o-mini", "gpt-4o", "gpt-3.5-turbo"],
}

function inferFallback(baseUrl: string, currentModel: string): ModelEntry[] {
  const candidates: string[] = []
  for (const [host, list] of Object.entries(FALLBACK_CANDIDATES)) {
    if (baseUrl.includes(host)) candidates.push(...list)
  }
  if (!candidates.includes(currentModel)) candidates.unshift(currentModel)
  // Dedupe while preserving order.
  const seen = new Set<string>()
  const unique: string[] = []
  for (const id of candidates) {
    if (seen.has(id)) continue
    seen.add(id)
    unique.push(id)
  }
  return unique.map((id) => ({ id, label: id, source: "fallback" as const }))
}

export function createModelsRouter(deps: ModelsRouterDeps): Router {
  const router = Router()

  router.get("/models", async (_req: Request, res: Response) => {
    try {
      const page = await deps.chatClient.models.list()
      const models: ModelEntry[] = []
      for await (const m of page) {
        if (typeof m.id === "string" && m.id.length > 0) {
          models.push({ id: m.id, label: m.id, source: "remote" })
        }
      }
      if (models.length === 0) {
        const body: ModelsResponse = {
          current: deps.currentModel,
          models: inferFallback(deps.baseUrl, deps.currentModel),
          baseUrl: deps.baseUrl,
          source: "fallback",
          error: "Provider returned no models",
        }
        res.json(body)
        return
      }
      // Make sure the configured current model is in the list.
      if (!models.some((m) => m.id === deps.currentModel)) {
        models.unshift({ id: deps.currentModel, label: deps.currentModel, source: "remote" })
      }
      const body: ModelsResponse = {
        current: deps.currentModel,
        models,
        baseUrl: deps.baseUrl,
        source: "remote",
        error: null,
      }
      res.json(body)
    } catch (err) {
      const body: ModelsResponse = {
        current: deps.currentModel,
        models: inferFallback(deps.baseUrl, deps.currentModel),
        baseUrl: deps.baseUrl,
        source: "fallback",
        error: err instanceof Error ? err.message : String(err),
      }
      res.json(body)
    }
  })

  return router
}
