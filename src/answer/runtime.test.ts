import assert from "node:assert/strict"
import test from "node:test"
import type { Client } from "@elastic/elasticsearch"
import type { Driver } from "neo4j-driver"
import type OpenAI from "openai"
import type { AppConfig } from "../config"
import {
  NoopLangfuseExporter,
  RealLangfuseExporter,
  type LangfuseClient,
} from "./langfuse_exporter"
import {
  createAnswerRuntime,
  type AnswerClientFactory,
} from "./runtime"

const config: AppConfig = {
  esNode: "http://elasticsearch.test",
  esApiKey: "",
  openaiApiKey: "chat-key",
  openaiBaseUrl: "http://chat.test",
  openaiChatModel: "configured-chat-model",
  embeddingApiKey: "embedding-key",
  embeddingBaseUrl: "http://embedding.test",
  embeddingModel: "configured-embedding-model",
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

function factory(record: {
  chat: number
  embedding: number
  elasticsearch: number
  neo4j: number
  esCloses: number
  neo4jCloses: number
}): AnswerClientFactory {
  return {
    createChatClient: () => {
      record.chat += 1
      return {} as OpenAI
    },
    createEmbeddingClient: () => {
      record.embedding += 1
      return {} as OpenAI
    },
    createElasticsearchClient: () => {
      record.elasticsearch += 1
      return {
        close: async () => { record.esCloses += 1 },
      } as unknown as Client
    },
    createNeo4jDriver: () => {
      record.neo4j += 1
      return {
        close: async () => { record.neo4jCloses += 1 },
      } as unknown as Driver
    },
  }
}

test("answer runtime owns shared clients without constructing legacy orchestration", async () => {
  const record = {
    chat: 0,
    embedding: 0,
    elasticsearch: 0,
    neo4j: 0,
    esCloses: 0,
    neo4jCloses: 0,
  }
  const runtime = createAnswerRuntime(config, factory(record))
  assert.deepEqual(record, {
    chat: 1,
    embedding: 1,
    elasticsearch: 1,
    neo4j: 1,
    esCloses: 0,
    neo4jCloses: 0,
  })
  assert.equal("generation" in runtime, false)
  await runtime.close()
  assert.equal(record.esCloses, 0)
  assert.equal(record.neo4jCloses, 0)
  await runtime.processRuntime.close()
  await runtime.processRuntime.close()
  assert.equal(record.esCloses, 1)
  assert.equal(record.neo4jCloses, 1)
})

test("partial Langfuse configuration fails at composition", () => {
  const record = { chat: 0, embedding: 0, elasticsearch: 0, neo4j: 0, esCloses: 0, neo4jCloses: 0 }
  assert.throws(
    () => createAnswerRuntime(
      { ...config, langfusePublicKey: "pk" },
      factory(record)
    ),
    /partial.*secretKey/i
  )
})

test("missing Langfuse configuration exposes the Noop exporter", async () => {
  const record = { chat: 0, embedding: 0, elasticsearch: 0, neo4j: 0, esCloses: 0, neo4jCloses: 0 }
  const runtime = createAnswerRuntime(config, factory(record))
  assert.ok(runtime.langfuseExporter instanceof NoopLangfuseExporter)
  await runtime.processRuntime.close()
})

test("complete Langfuse configuration exposes the real exporter", async () => {
  const record = { chat: 0, embedding: 0, elasticsearch: 0, neo4j: 0, esCloses: 0, neo4jCloses: 0 }
  const client: LangfuseClient = {
    trace: () => ({
      span: () => ({ end: () => {}, update: () => {} }),
      generation: () => ({ end: () => {}, update: () => {} }),
      update: () => {},
    }),
  }
  const runtime = createAnswerRuntime(
    { ...config, langfusePublicKey: "pk", langfuseSecretKey: "sk" },
    factory(record),
    client
  )
  assert.ok(runtime.langfuseExporter instanceof RealLangfuseExporter)
  await runtime.processRuntime.close()
})
