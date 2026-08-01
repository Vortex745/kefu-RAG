import assert from "node:assert/strict"
import test from "node:test"
import type { Client } from "@elastic/elasticsearch"
import neo4j, { type Driver } from "neo4j-driver"
import type OpenAI from "openai"
import type { AppConfig } from "../config"
import { openDb } from "../ingestion/tracking/db"
import {
  createProcessRuntime,
  type RuntimeClientFactory,
} from "./process_runtime"

const config: AppConfig = {
  esNode: "http://elasticsearch.test",
  esApiKey: "",
  openaiApiKey: "chat-key",
  openaiBaseUrl: "http://chat.test",
  openaiChatModel: "chat-model",
  embeddingApiKey: "embedding-key",
  embeddingBaseUrl: "http://embedding.test",
  embeddingModel: "embedding-model",
  embeddingDimensions: 3,
  openaiRequestTimeoutMs: 200_000,
  openaiMaxRetries: 1,
  neo4jUri: "bolt://neo4j.test",
  neo4jUser: "neo4j",
  neo4jPassword: "password",
  sqlitePath: ":memory:",
  pollIntervalMs: 1,
  claimedTimeoutMs: 1,
  accessMode: "single_tenant",
  activationMode: "auto",
  conversationTtlDays: 30,
  conversationGcIntervalMs: 86_400_000,
}

function makeFakeFactory(): {
  factory: RuntimeClientFactory
  closes: { elasticsearch: number; neo4j: number }
} {
  let elasticsearchCloses = 0
  let neo4jCloses = 0
  const elasticsearch = {
    close: async () => {
      elasticsearchCloses += 1
    },
  } as unknown as Client
  const neo4jDriver = {
    close: async () => {
      neo4jCloses += 1
    },
  } as unknown as Driver
  const chatClient = {} as unknown as OpenAI
  const embeddingClient = {} as unknown as OpenAI
  return {
    factory: {
      createChatClient: () => chatClient,
      createEmbeddingClient: () => embeddingClient,
      createElasticsearchClient: () => elasticsearch,
      createNeo4jDriver: () => neo4jDriver,
    },
    closes: { elasticsearch: 0, neo4j: 0 },
  }
}

// Helper to read close counts after the fact via shared mutable object.
function makeTrackingFactory(): {
  factory: RuntimeClientFactory
  elasticsearchCloses: () => number
  neo4jCloses: () => number
} {
  let esCloses = 0
  let neoCloses = 0
  const elasticsearch = {
    close: async () => {
      esCloses += 1
    },
  } as unknown as Client
  const neo4jDriver = {
    close: async () => {
      neoCloses += 1
    },
  } as unknown as Driver
  return {
    factory: {
      createChatClient: () => ({}) as unknown as OpenAI,
      createEmbeddingClient: () => ({}) as unknown as OpenAI,
      createElasticsearchClient: () => elasticsearch,
      createNeo4jDriver: () => neo4jDriver,
    },
    elasticsearchCloses: () => esCloses,
    neo4jCloses: () => neoCloses,
  }
}

test("ProcessRuntime shares the SQLite adapter across multiple consumers", () => {
  const { factory } = makeTrackingFactory()
  const runtime = createProcessRuntime(config, factory)

  const consumerA = runtime.db
  const consumerB = runtime.db
  assert.equal(consumerA, consumerB, "SQLite adapter must be the same instance")
})

test("ProcessRuntime close closes every managed resource exactly once", async () => {
  const tracking = makeTrackingFactory()
  const runtime = createProcessRuntime(config, tracking.factory)

  await runtime.close()

  assert.equal(tracking.elasticsearchCloses(), 1, "ES closed once")
  assert.equal(tracking.neo4jCloses(), 1, "Neo4j closed once")
})

test("ProcessRuntime close is idempotent", async () => {
  const tracking = makeTrackingFactory()
  const runtime = createProcessRuntime(config, tracking.factory)

  await runtime.close()
  await runtime.close()
  await runtime.close()

  assert.equal(tracking.elasticsearchCloses(), 1, "ES closed exactly once")
  assert.equal(tracking.neo4jCloses(), 1, "Neo4j closed exactly once")
})

test("ProcessRuntime exposes chat, embedding, ES, Neo4j and SQLite adapters", () => {
  const { factory } = makeTrackingFactory()
  const runtime = createProcessRuntime(config, factory)

  assert.ok(runtime.chatClient, "chatClient exposed")
  assert.ok(runtime.embeddingClient, "embeddingClient exposed")
  assert.ok(runtime.elasticsearch, "elasticsearch exposed")
  assert.ok(runtime.neo4jDriver, "neo4jDriver exposed")
  assert.ok(runtime.db, "db exposed")
})

test("ProcessRuntime forwards config timeout/maxRetries to chat and embedding factories", () => {
  const received: Array<Record<string, unknown>> = []
  const factory: RuntimeClientFactory = {
    createChatClient: (options) => {
      received.push(options)
      return {} as unknown as OpenAI
    },
    createEmbeddingClient: (options) => {
      received.push(options)
      return {} as unknown as OpenAI
    },
    createElasticsearchClient: () => ({} as unknown as Client),
    createNeo4jDriver: () => ({} as unknown as Driver),
  }

  createProcessRuntime({ ...config, openaiRequestTimeoutMs: 200_000, openaiMaxRetries: 1 }, factory)

  assert.equal(received.length, 2, "chat + embedding factories both invoked")
  for (const options of received) {
    assert.equal(options.timeout, 200_000, "timeout forwarded from config")
    assert.equal(options.maxRetries, 1, "maxRetries forwarded from config")
  }
})

test("ProcessRuntime forwards custom config timeout/maxRetries to factories", () => {
  const received: Array<Record<string, unknown>> = []
  const factory: RuntimeClientFactory = {
    createChatClient: (options) => {
      received.push(options)
      return {} as unknown as OpenAI
    },
    createEmbeddingClient: (options) => {
      received.push(options)
      return {} as unknown as OpenAI
    },
    createElasticsearchClient: () => ({} as unknown as Client),
    createNeo4jDriver: () => ({} as unknown as Driver),
  }

  createProcessRuntime({ ...config, openaiRequestTimeoutMs: 42_000, openaiMaxRetries: 0 }, factory)

  assert.equal(received[0].timeout, 42_000, "custom timeout forwarded")
  assert.equal(received[0].maxRetries, 0, "custom maxRetries forwarded")
})
