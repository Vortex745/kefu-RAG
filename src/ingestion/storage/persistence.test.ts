import "dotenv/config"
import assert from "node:assert/strict"
import test from "node:test"
import type { Client } from "@elastic/elasticsearch"
import type OpenAI from "openai"
import type { Driver } from "neo4j-driver"
import type { Chunk } from "../../types"
import { IngestionStoreImpl, type KnowledgePersistenceDependencies } from "./store"

/**
 * T21 deep module DI seam tests.
 *
 * The Knowledge persistence deep module must accept injected clients so that:
 * 1. Pipeline runs share clients instead of creating new ones per run.
 * 2. Tests can inject mocks at the deep module boundary without reaching into ESStore.
 * 3. Embedding / index compat / bulk write / graph idempotency stay internal.
 */

function mockEsClient(): Client {
  const bulkCalls: unknown[] = []
  return {
    indices: {
      exists: async () => false,
      create: async () => ({ acknowledged: true }),
      getMapping: async () => ({ }),
      putMapping: async () => ({ acknowledged: true }),
    },
    bulk: async ({ body }: { body: unknown[] }) => {
      bulkCalls.push(body)
      return { errors: false, items: [] }
    },
    close: async () => {},
  } as unknown as Client
}

function mockEmbeddingClient(): OpenAI {
  return {
    embeddings: {
      create: async ({ input }: { input: string[] }) => ({
        data: input.map(() => ({ embedding: [0.1, 0.2] })),
      }),
    },
  } as unknown as OpenAI
}

function mockGraphDriver(): Driver {
  return {
    session: () => ({
      run: async () => ({ records: [] }),
      close: async () => {},
    }),
  } as unknown as Driver
}

test("IngestionStoreImpl accepts injected clients via KnowledgePersistenceDependencies", async () => {
  const es = mockEsClient()
  const embeddingClient = mockEmbeddingClient()
  const graphDriver = mockGraphDriver()

  const deps: KnowledgePersistenceDependencies = {
    esClient: es,
    embeddingClient,
    embeddingModel: "test-embedding-model",
    embeddingDimensions: 2,
    graphDriver,
  }

  const store = new IngestionStoreImpl(deps)

  const chunks: Chunk[] = [
    {
      id: "child-1",
      documentId: "doc-di-1",
      content: "injected dependency content",
      childrenIds: [],
      metadata: { kind: "child" },
    },
  ]

  // Should not throw — uses injected clients, never reads process.env / loadConfig.
  await store.storeChunks(chunks, { tenantId: "default", allowedGroups: [] })
  await store.storeEntities([])
  await store.storeWikilinks([], { tenantId: "default", allowedGroups: [] })

  // close() should close the injected ES client (resource behavior hidden inside).
  await store.close()
})

test("IngestionStoreImpl without deps falls back to config-based clients (backward compat)", () => {
  // Construction without deps must not throw — existing callers (pipeline.ts default)
  // rely on this. We do NOT call storeChunks here because that would require live ES.
  // The point of this test: constructor signature is backward compatible.
  const store = new IngestionStoreImpl()
  assert.ok(store instanceof IngestionStoreImpl)
})

test("createIngestionStore factory returns a shared IngestionStoreImpl", async () => {
  const { createIngestionStore } = await import("./index")
  // Factory reads config; in test env OPENAI_API_KEY is set by setup, so this should work.
  const store = createIngestionStore()
  assert.ok(store instanceof IngestionStoreImpl)
  // Second call returns a NEW store (factory creates clients once per call).
  // Callers should call createIngestionStore() ONCE and share the result.
  const store2 = createIngestionStore()
  assert.notEqual(store, store2)
})
