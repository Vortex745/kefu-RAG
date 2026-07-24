import { Client } from "@elastic/elasticsearch"
import OpenAI from "openai"
import type { Driver } from "neo4j-driver"
import type { Chunk, Entity, Wikilink } from "../../types"
import { loadConfig } from "../../config"
import { getDriver } from "../../graph"

const INDEX_NAME = "kefu-rag-chunks"
const CHUNK_KEYWORD_PROPERTIES = {
  kind: { type: "keyword" as const },
  parentId: { type: "keyword" as const },
  childrenIds: { type: "keyword" as const },
  tenantId: { type: "keyword" as const },
  allowedGroups: { type: "keyword" as const },
}

/**
 * T21 Knowledge persistence deep module dependencies.
 *
 * Injecting these allows the pipeline to share clients across runs and tests
 * to mock at the deep module seam. When omitted, the module falls back to
 * config-based clients (backward compat).
 */
export interface KnowledgePersistenceDependencies {
  esClient: Client
  embeddingClient: OpenAI
  embeddingModel: string
  embeddingDimensions: number
  graphDriver?: Driver
}

export interface KnowledgeAccessMetadata {
  tenantId: string
  allowedGroups: string[]
}

export type ChunkAccessMetadata = KnowledgeAccessMetadata

export class ESStore {
  private client: Client
  private embeddingClient: OpenAI
  private embeddingModel: string
  private embeddingDimensions: number

  constructor(clients?: {
    client?: Client
    embeddingClient?: OpenAI
    embeddingModel?: string
    embeddingDimensions?: number
  }) {
    if (clients?.client && clients.embeddingClient && clients.embeddingModel && clients.embeddingDimensions) {
      this.client = clients.client
      this.embeddingClient = clients.embeddingClient
      this.embeddingModel = clients.embeddingModel
      this.embeddingDimensions = clients.embeddingDimensions
    } else {
      const cfg = loadConfig()
      this.client = clients?.client ?? new Client({
        node: cfg.esNode,
        ...(cfg.esApiKey ? { auth: { apiKey: cfg.esApiKey } } : {}),
      })
      this.embeddingClient = clients?.embeddingClient ?? new OpenAI({
        apiKey: cfg.embeddingApiKey,
        baseURL: cfg.embeddingBaseUrl || undefined,
      })
      this.embeddingModel = clients?.embeddingModel ?? cfg.embeddingModel
      this.embeddingDimensions = clients?.embeddingDimensions ?? cfg.embeddingDimensions
    }
  }

  async ensureIndex(): Promise<void> {
    const exists = await this.client.indices.exists({ index: INDEX_NAME })
    if (exists) {
      const mapping = await this.client.indices.getMapping({ index: INDEX_NAME })
      const embedding = mapping[INDEX_NAME]?.mappings.properties?.embedding as
        | { dims?: number }
        | undefined
      if (embedding?.dims !== this.embeddingDimensions) {
        throw new Error(
          `Elasticsearch index ${INDEX_NAME} has ${embedding?.dims ?? "unknown"} embedding dimensions; expected ${this.embeddingDimensions}`
        )
      }
      const properties = mapping[INDEX_NAME]?.mappings.properties ?? {}
      if (Object.keys(CHUNK_KEYWORD_PROPERTIES).some((name) => !(name in properties))) {
        await this.client.indices.putMapping({
          index: INDEX_NAME,
          properties: CHUNK_KEYWORD_PROPERTIES,
        })
      }
      return
    }

    await this.client.indices.create({
      index: INDEX_NAME,
      settings: { number_of_shards: 1, number_of_replicas: 0 },
      mappings: {
        properties: {
          id: { type: "keyword" },
          documentId: { type: "keyword" },
          ...CHUNK_KEYWORD_PROPERTIES,
          content: { type: "text" },
          embedding: {
            type: "dense_vector",
            dims: this.embeddingDimensions,
            index: true,
            similarity: "cosine",
          },
          metadata: { type: "object" },
        },
      },
    })
  }

  async storeChunks(
    chunks: Chunk[],
    accessMetadata: KnowledgeAccessMetadata
  ): Promise<void> {
    if (chunks.length === 0) return
    if (!accessMetadata?.tenantId || !Array.isArray(accessMetadata.allowedGroups)) {
      throw new Error("Chunk access metadata is required")
    }

    const { tenantId, allowedGroups } = accessMetadata
    const passages = chunks.filter((chunk) => chunk.metadata.kind !== "parent")
    const embeddings = new Map<string, number[]>()
    if (passages.length > 0) {
      const embRes = await this.embeddingClient.embeddings.create({
        model: this.embeddingModel,
        input: passages.map(({ content }) => content),
      })
      for (let index = 0; index < passages.length; index += 1) {
        const passage = passages[index]
        embeddings.set(`${passage.documentId}\0${passage.id}`, embRes.data[index].embedding)
      }
    }

    const body = chunks.flatMap((c) => [
      { index: { _index: INDEX_NAME, _id: `${c.documentId}:${c.id}` } },
      {
        id: c.id,
        documentId: c.documentId,
        tenantId,
        allowedGroups,
        kind: c.metadata.kind,
        content: c.content,
        ...(embeddings.has(`${c.documentId}\0${c.id}`)
          ? { embedding: embeddings.get(`${c.documentId}\0${c.id}`) }
          : {}),
        parentId: c.parentId,
        childrenIds: c.childrenIds,
        metadata: c.metadata,
      },
    ])
    const result = await this.client.bulk({ body, refresh: "wait_for" })
    if (result.errors) {
      const failure = result.items.find((item) => item.index?.error)?.index?.error
      throw new Error(`Elasticsearch bulk indexing failed: ${failure?.reason ?? "unknown error"}`)
    }
  }

  async close(): Promise<void> {
    await this.client.close()
  }
}

export class Neo4jStore {
  constructor(private driver?: Driver) {}

  async storeEntities(entities: Entity[]): Promise<void> {
    const driver = this.driver ?? getDriver()
    const session = driver.session()
    try {
      for (const e of entities) {
        await session.run(
          `MERGE (e:Entity {id: $id})
           SET e.name = $name, e.type = $type, e.aliases = $aliases`,
          { id: e.id, name: e.name, type: e.type, aliases: e.aliases }
        )
      }
    } finally {
      await session.close()
    }
  }

  async storeWikilinks(
    wikilinks: Wikilink[],
    accessMetadata: KnowledgeAccessMetadata
  ): Promise<void> {
    if (wikilinks.length === 0) return
    if (!accessMetadata?.tenantId || !Array.isArray(accessMetadata.allowedGroups)) {
      throw new Error("Graph provenance access metadata is required")
    }

    const { tenantId, allowedGroups } = accessMetadata
    const driver = this.driver ?? getDriver()
    const session = driver.session()
    try {
      for (const w of wikilinks) {
        const [sourceId, targetId] = [w.sourceEntityId, w.targetEntityId].sort()
        const relation = `${w.sourceEntityId}->${w.targetEntityId}:${w.relation}`
        await session.run(
          `MATCH (a:Entity {id: $sourceId})
           MATCH (b:Entity {id: $targetId})
           MERGE (a)-[r:WIKILINK {fact: $relation}]->(b)
           SET r.weight = CASE WHEN r.weight IS NULL OR $weight > r.weight THEN $weight ELSE r.weight END,
           r.provenance = reduce(
             acc = coalesce(r.provenance, []),
             item IN $provenance |
             CASE WHEN item IN acc THEN acc ELSE acc + item END
           )`,
          {
            sourceId,
            targetId,
            relation,
            weight: w.weight,
            provenance: (w.provenance ?? []).map(({ documentId, chunkId }) =>
              JSON.stringify([documentId, chunkId, tenantId, allowedGroups])
            ),
          }
        )
      }
    } finally {
      await session.close()
    }
  }
}

export class IngestionStoreImpl {
  private es: ESStore
  private neo4j: Neo4jStore

  constructor(deps?: KnowledgePersistenceDependencies) {
    if (deps) {
      this.es = new ESStore({
        client: deps.esClient,
        embeddingClient: deps.embeddingClient,
        embeddingModel: deps.embeddingModel,
        embeddingDimensions: deps.embeddingDimensions,
      })
      this.neo4j = new Neo4jStore(deps.graphDriver)
    } else {
      this.es = new ESStore()
      this.neo4j = new Neo4jStore()
    }
  }

  async storeChunks(
    chunks: Chunk[],
    accessMetadata: KnowledgeAccessMetadata
  ): Promise<void> {
    await this.es.ensureIndex()
    await this.es.storeChunks(chunks, accessMetadata)
  }

  async storeEntities(entities: Entity[]): Promise<void> {
    await this.neo4j.storeEntities(entities)
  }

  async storeWikilinks(
    wikilinks: Wikilink[],
    accessMetadata: KnowledgeAccessMetadata
  ): Promise<void> {
    await this.neo4j.storeWikilinks(wikilinks, accessMetadata)
  }

  async close(): Promise<void> {
    await this.es.close()
  }
}
