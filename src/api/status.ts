import { Router, type Request, type Response } from "express"
import type { Client } from "@elastic/elasticsearch"
import type { Driver } from "neo4j-driver"
import type OpenAI from "openai"
import type { AppConfig } from "../config"

interface ChannelStatus {
  status: "connected" | "degraded" | "disconnected" | "unconfigured"
  detail: string
  responseTimeMs: number | null
  error: string | null
}

interface StatusResponse {
  checkedAt: string
  mode: "full" | "degraded"
  hasKnowledgeBaseContent: boolean
  channels: {
    elasticsearch: ChannelStatus
    neo4j: ChannelStatus
    openai: ChannelStatus
  }
  config: {
    esNode: string
    neo4jUri: string
    openaiBaseUrl: string
    openaiChatModel: string
  }
}

// 知识库 chunk 索引名 — 与 ingestion/storage/store.ts、retrieval/search/searcher.ts 保持一致
const KB_INDEX_NAME = "kefu-rag-chunks"

async function probeKnowledgeBaseContent(client: Client): Promise<boolean> {
  try {
    const result = await client.count({ index: KB_INDEX_NAME })
    return (result.count ?? 0) > 0
  } catch {
    // 索引不存在、ES 不可达、权限不足等都视为"无内容"
    return false
  }
}

export interface StatusRouterDeps {
  config: AppConfig
  elasticsearch: Client
  neo4jDriver: Driver
  chatClient: OpenAI
}

async function time<T>(fn: () => Promise<T>, timeoutMs = 3500): Promise<{ value: T | null; ms: number; error: string | null }> {
  const start = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const value = await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
    return { value, ms: Date.now() - start, error: null }
  } catch (err) {
    return { value: null, ms: Date.now() - start, error: err instanceof Error ? err.message : String(err) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function pingElasticsearch(client: Client): Promise<ChannelStatus> {
  const result = await time(async () => {
    const ok = await client.ping()
    if (!ok) throw new Error("ping returned false")
  })
  return result.error
    ? { status: "disconnected", detail: "Elasticsearch 不可达", responseTimeMs: result.ms, error: result.error }
    : { status: "connected", detail: "Elasticsearch 可用", responseTimeMs: result.ms, error: null }
}

async function pingNeo4j(driver: Driver): Promise<ChannelStatus> {
  const result = await time(async () => {
    // Some drivers lazily negotiate on first call; this can take several
    // seconds. The 3.5s ceiling in `time` keeps the status response snappy.
    await driver.executeQuery("RETURN 1 AS n", {}, { database: undefined })
  })
  return result.error
    ? { status: "disconnected", detail: "Neo4j 不可达", responseTimeMs: result.ms, error: result.error }
    : { status: "connected", detail: "Neo4j 可用", responseTimeMs: result.ms, error: null }
}

async function pingOpenAI(client: OpenAI): Promise<ChannelStatus> {
  const result = await time(async () => {
    // OpenAI SDK: list models is the lightest connectivity check. Some
    // OpenAI-compatible providers (e.g. DeepSeek) may not expose /v1/models;
    // we treat the call as a connectivity probe and surface the error to the
    // caller so the UI can show "degraded".
    await client.models.list()
  })
  return result.error
    ? {
        status: "degraded",
        detail: "OpenAI 模型列表不可用（仍可正常回答）",
        responseTimeMs: result.ms,
        error: result.error,
      }
    : { status: "connected", detail: "OpenAI 可用", responseTimeMs: result.ms, error: null }
}

export function createStatusRouter(deps: StatusRouterDeps): Router {
  const router = Router()

  router.get("/status", async (_req: Request, res: Response) => {
    const [es, neo4j, openai] = await Promise.all([
      pingElasticsearch(deps.elasticsearch),
      pingNeo4j(deps.neo4jDriver),
      pingOpenAI(deps.chatClient),
    ])

    // 仅当 ES 可达时探测 chunk 数量；ES 不可达时直接视为无内容
    const hasContent = es.status === "connected"
      ? await probeKnowledgeBaseContent(deps.elasticsearch)
      : false

    const mode: "full" | "degraded" =
      es.status === "connected" && (neo4j.status === "connected" || openai.status !== "disconnected")
        ? "full"
        : "degraded"

    const body: StatusResponse = {
      checkedAt: new Date().toISOString(),
      mode,
      hasKnowledgeBaseContent: hasContent,
      channels: { elasticsearch: es, neo4j, openai },
      config: {
        esNode: deps.config.esNode,
        neo4jUri: deps.config.neo4jUri,
        openaiBaseUrl: deps.config.openaiBaseUrl || "(default OpenAI)",
        openaiChatModel: deps.config.openaiChatModel,
      },
    }
    res.json(body)
  })

  return router
}
