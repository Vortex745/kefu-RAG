import assert from "node:assert/strict"
import test from "node:test"
import express from "express"
import type { Client } from "@elastic/elasticsearch"
import type { Driver } from "neo4j-driver"
import type OpenAI from "openai"
import { createStatusRouter } from "./status"
import type { AppConfig } from "../config"

/**
 * 覆盖 /api/status 的 hasKnowledgeBaseContent 字段：
 *   - ES 可达且 count > 0 → true
 *   - ES 可达但 count = 0 → false
 *   - ES count 抛错（索引不存在）→ false
 *   - ES 不可达 → false（跳过 count 调用）
 */

function mockConfig(): AppConfig {
  return {
    esNode: "http://localhost:9200",
    neo4jUri: "bolt://localhost:7687",
    openaiBaseUrl: "",
    openaiChatModel: "gpt-4o-mini",
    openaiApiKey: "sk-test",
    embeddingApiKey: "sk-test",
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 1536,
  } as unknown as AppConfig
}

function mockEsClient(opts: {
  pingOk: boolean
  count?: number
  countThrows?: boolean
}): Client {
  return {
    ping: async () => opts.pingOk,
    count: async () => {
      if (opts.countThrows) throw new Error("index_not_found")
      return { count: opts.count ?? 0 }
    },
  } as unknown as Client
}

function mockNeo4jDriver(ok: boolean): Driver {
  return {
    executeQuery: async () => {
      if (!ok) throw new Error("neo4j down")
    },
  } as unknown as Driver
}

function mockOpenAI(ok: boolean): OpenAI {
  return {
    models: {
      list: async () => {
        if (!ok) throw new Error("openai down")
        return { data: [] }
      },
    },
  } as unknown as OpenAI
}

async function callStatus(deps: {
  es: Client
  neo4j: Driver
  openai: OpenAI
}): Promise<Record<string, unknown>> {
  const app = express()
  app.use("/api", createStatusRouter({
    config: mockConfig(),
    elasticsearch: deps.es,
    neo4jDriver: deps.neo4j,
    chatClient: deps.openai,
  }))
  const server = app.listen(0)
  await new Promise<void>((r) => server.once("listening", r))
  const port = (server.address() as { port: number }).port
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`)
    return await res.json() as Record<string, unknown>
  } finally {
    server.close()
  }
}

test("status: ES reachable and count > 0 → hasKnowledgeBaseContent=true", async () => {
  const body = await callStatus({
    es: mockEsClient({ pingOk: true, count: 42 }),
    neo4j: mockNeo4jDriver(true),
    openai: mockOpenAI(true),
  })
  assert.equal(body.hasKnowledgeBaseContent, true)
})

test("status: ES reachable but count = 0 → hasKnowledgeBaseContent=false", async () => {
  const body = await callStatus({
    es: mockEsClient({ pingOk: true, count: 0 }),
    neo4j: mockNeo4jDriver(true),
    openai: mockOpenAI(true),
  })
  assert.equal(body.hasKnowledgeBaseContent, false)
})

test("status: ES reachable but count throws (index missing) → hasKnowledgeBaseContent=false", async () => {
  const body = await callStatus({
    es: mockEsClient({ pingOk: true, countThrows: true }),
    neo4j: mockNeo4jDriver(true),
    openai: mockOpenAI(true),
  })
  assert.equal(body.hasKnowledgeBaseContent, false)
})

test("status: ES unreachable → hasKnowledgeBaseContent=false (count not called)", async () => {
  let countCalled = false
  const es = {
    ping: async () => false,
    count: async () => { countCalled = true; return { count: 999 } },
  } as unknown as Client
  const body = await callStatus({
    es,
    neo4j: mockNeo4jDriver(true),
    openai: mockOpenAI(true),
  })
  assert.equal(body.hasKnowledgeBaseContent, false)
  assert.equal(countCalled, false, "count should not be called when ES ping fails")
})
