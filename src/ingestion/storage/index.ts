import { Client } from "@elastic/elasticsearch"
import OpenAI from "openai"
import type { Chunk, Entity, Wikilink } from "../../types"
import { loadConfig } from "../../config"
import { createDriver } from "../../graph"
import {
  IngestionStoreImpl,
  type ChunkAccessMetadata,
  type KnowledgeAccessMetadata,
  type KnowledgePersistenceDependencies,
} from "./store"

export type {
  ChunkAccessMetadata,
  KnowledgeAccessMetadata,
  KnowledgePersistenceDependencies,
} from "./store"
export { ESStore, Neo4jStore, IngestionStoreImpl } from "./store"

export interface IngestionStore {
  storeChunks(chunks: Chunk[], accessMetadata: ChunkAccessMetadata): Promise<void>
  storeEntities(entities: Entity[]): Promise<void>
  storeWikilinks(
    wikilinks: Wikilink[],
    accessMetadata: KnowledgeAccessMetadata
  ): Promise<void>
}

/**
 * T21 factory: create a Knowledge persistence deep module with clients
 * built once from config. Callers should call this ONCE and share the result
 * across pipeline runs so that ES / OpenAI / Neo4j clients are not recreated
 * per document ingestion.
 *
 * For tests, construct `IngestionStoreImpl` directly with `KnowledgePersistenceDependencies`.
 */
export function createIngestionStore(): IngestionStoreImpl {
  const cfg = loadConfig()
  const deps: KnowledgePersistenceDependencies = {
    esClient: new Client({
      node: cfg.esNode,
      ...(cfg.esApiKey ? { auth: { apiKey: cfg.esApiKey } } : {}),
    }),
    embeddingClient: new OpenAI({
      apiKey: cfg.embeddingApiKey,
      baseURL: cfg.embeddingBaseUrl || undefined,
    }),
    embeddingModel: cfg.embeddingModel,
    embeddingDimensions: cfg.embeddingDimensions,
    graphDriver: createDriver(),
  }
  return new IngestionStoreImpl(deps)
}
