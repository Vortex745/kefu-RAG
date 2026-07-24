import { Client } from "@elastic/elasticsearch"
import neo4j, { type Driver } from "neo4j-driver"
import OpenAI from "openai"
import { type AppConfig } from "../config"
import { type DB, closeDb, openDb } from "../ingestion/tracking/db"
import { createRunBudgetedOpenAIClient } from "./openai_budget_client"

/**
 * T43: ProcessRuntime owns the lifetime of long-lived process adapters.
 *
 * It is the sole creator of SQLite, Elasticsearch, Neo4j, chat and embedding
 * adapters at process startup, and exposes a single `close()` that releases
 * every managed resource exactly once. Consumers (HTTP, worker, answer
 * generation) obtain adapters from this module instead of constructing them
 * independently.
 *
 * This is the expand phase: existing singletons in runtime.ts / graph/index.ts
 * remain untouched. New code should consume ProcessRuntime; migration happens
 * in subsequent tickets (T44/T45/T46).
 */

export interface ProcessRuntime {
  readonly chatClient: OpenAI
  readonly embeddingClient: OpenAI
  readonly elasticsearch: Client
  readonly neo4jDriver: Driver
  readonly db: DB
  close(): Promise<void>
}

export interface RuntimeClientFactory {
  createChatClient(options: { apiKey: string; baseURL?: string }): OpenAI
  createEmbeddingClient(options: { apiKey: string; baseURL?: string }): OpenAI
  createElasticsearchClient(options: { node: string; apiKey?: string }): Client
  createNeo4jDriver(options: {
    uri: string
    user: string
    password: string
  }): Driver
}

const defaultClientFactory: RuntimeClientFactory = {
  createChatClient: (options) => new OpenAI(options),
  createEmbeddingClient: (options) => new OpenAI(options),
  createElasticsearchClient: ({ node, apiKey }) =>
    new Client({
      node,
      ...(apiKey ? { auth: { apiKey } } : {}),
    }),
  createNeo4jDriver: ({ uri, user, password }) =>
    neo4j.driver(uri, neo4j.auth.basic(user, password)),
}

export function createProcessRuntime(
  config: AppConfig,
  clientFactory: RuntimeClientFactory = defaultClientFactory
): ProcessRuntime {
  const chatClient = createRunBudgetedOpenAIClient(clientFactory.createChatClient({
    apiKey: config.openaiApiKey,
    baseURL: config.openaiBaseUrl || undefined,
  }))
  const embeddingClient = createRunBudgetedOpenAIClient(clientFactory.createEmbeddingClient({
    apiKey: config.embeddingApiKey,
    baseURL: config.embeddingBaseUrl || undefined,
  }))
  const elasticsearch = clientFactory.createElasticsearchClient({
    node: config.esNode,
    apiKey: config.esApiKey || undefined,
  })
  const neo4jDriver = clientFactory.createNeo4jDriver({
    uri: config.neo4jUri,
    user: config.neo4jUser,
    password: config.neo4jPassword,
  })
  // Use the global SQLite cache so existing callers still see the same handle.
  const db = openDb(config.sqlitePath)

  let closePromise: Promise<void> | null = null

  return {
    chatClient,
    embeddingClient,
    elasticsearch,
    neo4jDriver,
    db,
    async close(): Promise<void> {
      if (closePromise) return closePromise
      closePromise = (async () => {
        // Order: ES → Neo4j → SQLite. OpenAI clients have no explicit close.
        await elasticsearch.close()
        await neo4jDriver.close()
        // closeDb() only closes the global handle; if openDb was called with
        // an explicit path the handle is not tracked globally and must be
        // closed directly.
        if (config.sqlitePath) {
          db.close()
        } else {
          closeDb()
        }
      })()
      return closePromise
    },
  }
}
