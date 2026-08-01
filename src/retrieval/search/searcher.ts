import type { Client } from "@elastic/elasticsearch"
import type OpenAI from "openai"
import type { Driver } from "neo4j-driver"
import { getDriver } from "../../graph"
import type { PageIndexRepository } from "../../ingestion/tracking/page_index_repo"
import type { ActiveVersionRepository } from "../../ingestion/tracking/active_version_repo"
import type { AccessContext } from "../../access/context"
import type { Query, RetrievalResult, Chunk } from "../../types"
import type {
  RetrievalChannel,
  SearchOptions,
  SearchOutcome,
  Searcher,
} from "./interface"
import { ALL_RETRIEVAL_CHANNELS, validateChannelSelection } from "./interface"
import { rrf } from "./rrf"
import { rerank } from "./reranker"

const INDEX_NAME = "kefu-rag-chunks"
const CHANNEL_TOP_K = 5
const RESULT_TOP_K = 10
const GRAPH_CANDIDATE_MULTIPLIER = 4
const GRAPH_HOPS = 1
const PAGE_INDEX_NODE_LIMIT = 5

function childFilter() {
  return {
    bool: {
      minimum_should_match: 1,
      should: [
        { term: { kind: "child" } },
        { term: { kind: "image" } },
        { bool: { must_not: [{ exists: { field: "kind" } }] } },
      ],
    },
  }
}

/**
 * Ticket 07 P2: Build the Elasticsearch filter clauses that enforce Access
 * Context on a chunk index. Returns an empty array when no AccessContext is
 * supplied (legacy/single-tenant callers) so existing behavior is unchanged.
 *
 * Semantics (spec §6):
 * - tenantId is a hard filter — chunks from other tenants are never visible.
 * - allowedGroups=[] on the caller means "tenant-wide user" (e.g. the
 *   single-tenant default): no group filter is added, so the caller sees
 *   every same-tenant chunk.
 * - allowedGroups non-empty on the caller means "group-restricted user":
 *   a chunk is visible when its own allowedGroups is empty (tenant-wide
 *   chunk) OR intersects the caller's groups. ES `exists` returns false
 *   for an empty-array keyword field, so `must_not: exists` matches
 *   tenant-wide chunks reliably.
 */
function accessContextFilter(ac?: AccessContext): Array<Record<string, unknown>> {
  if (!ac) return []
  const filters: Array<Record<string, unknown>> = [
    { term: { tenantId: ac.tenantId } },
  ]
  if (ac.groups.length > 0) {
    filters.push({
      bool: {
        minimum_should_match: 1,
        should: [
          { bool: { must_not: [{ exists: { field: "allowedGroups" } }] } },
          { terms: { allowedGroups: ac.groups } },
        ],
      },
    })
  }
  return filters
}

/**
 * Ticket 07 P3: Filter PageIndex nodes (or any node-shaped object) by Access
 * Context in the application layer, before linked Chunk IDs are extracted.
 * This enforces spec §6 "PageIndex lookup filters before linked Chunk IDs
 * are returned" without modifying the PageIndexRepository surface.
 *
 * Semantics mirror accessContextFilter:
 * - No AccessContext → no filtering (legacy/single-tenant callers).
 * - tenantId must match exactly.
 * - Caller groups empty (tenant-wide user) → all same-tenant nodes visible.
 * - Caller groups non-empty → node visible when its own allowedGroups is
 *   empty (tenant-wide node) OR intersects the caller's groups.
 */
function filterNodesByAccessContext<N extends { tenantId?: string; allowedGroups?: string[] }>(
  nodes: N[],
  ac?: AccessContext
): N[] {
  if (!ac) return nodes
  return nodes.filter((node) => {
    if (node.tenantId !== ac.tenantId) return false
    if (ac.groups.length === 0) return true
    const nodeGroups = node.allowedGroups ?? []
    if (nodeGroups.length === 0) return true
    return nodeGroups.some((g) => ac.groups.includes(g))
  })
}

/**
 * Ticket 07 P4: Filter graph provenance records by Access Context before
 * building the chunk-identity set used for ES recheck. Enforces spec §6:
 * "a result becomes Evidence only after its provenance resolves to an active
 * authorized Chunk."
 *
 * Semantics:
 * - No AccessContext → no filtering (legacy/single-tenant callers).
 * - Legacy 2-element provenance (no tenantId) passes through unchanged —
 *   the ES recheck is the authoritative gate for those records, since we
 *   cannot authorize them at the app layer without a tenant tag.
 * - 4-element provenance (with tenantId) is authorized at the app layer:
 *   tenantId must match exactly, and group semantics mirror
 *   filterNodesByAccessContext (empty caller groups = tenant-wide;
 *   empty provenance groups = tenant-wide chunk; otherwise intersect).
 */
function filterProvenanceByAccessContext<P extends { tenantId?: string; allowedGroups?: string[] }>(
  provenance: P[],
  ac?: AccessContext
): P[] {
  if (!ac) return provenance
  return provenance.filter((p) => {
    if (p.tenantId === undefined) return true
    if (p.tenantId !== ac.tenantId) return false
    if (ac.groups.length === 0) return true
    const pGroups = p.allowedGroups ?? []
    if (pGroups.length === 0) return true
    return pGroups.some((g) => ac.groups.includes(g))
  })
}

export interface SearchOperations {
  vectorSearch(query: Query, topK: number, hypothesis?: string, accessContext?: AccessContext, signal?: AbortSignal): Promise<RetrievalResult[]>
  bm25Search(query: Query, topK: number, accessContext?: AccessContext, signal?: AbortSignal): Promise<RetrievalResult[]>
  graphSearch(query: Query, topK: number, seeds?: string[], accessContext?: AccessContext, signal?: AbortSignal): Promise<RetrievalResult[]>
  pageIndexSearch(query: Query, topK: number, accessContext?: AccessContext, signal?: AbortSignal): Promise<RetrievalResult[]>
  rerank(query: string, results: RetrievalResult[], signal?: AbortSignal): Promise<RetrievalResult[]>
  loadParents(identities: Array<{ documentId: string; id: string }>, accessContext?: AccessContext, signal?: AbortSignal): Promise<Chunk[]>
}

export interface RuntimeSearchDependencies {
  es: Client
  chatClient: OpenAI
  embeddingClient: OpenAI
  chatModel: string
  embeddingModel: string
  graphDriver?: Driver
  pageIndexRepo?: PageIndexRepository
  activeVersionRepo?: ActiveVersionRepository
}

export class RuntimeSearchOperations implements SearchOperations {
  constructor(private dependencies: RuntimeSearchDependencies) {}

  private activeTermsFilter(): Array<Record<string, unknown>> {
    const repo = this.dependencies.activeVersionRepo
    if (!repo) return []
    const docIds = repo.getActiveDocIds()
    return docIds.length > 0 ? [{ terms: { documentId: docIds } }] : []
  }

  async vectorSearch(query: Query, topK: number, hypothesis?: string, accessContext?: AccessContext, signal?: AbortSignal): Promise<RetrievalResult[]> {
    const embedInput = hypothesis && hypothesis.trim() ? hypothesis : query.text
    const emb = await this.dependencies.embeddingClient.embeddings.create(
      {
        model: this.dependencies.embeddingModel,
        input: embedInput,
      },
      { signal }
    )
    const filters = [
      childFilter(),
      ...this.activeTermsFilter(),
      ...accessContextFilter(accessContext),
    ]
    const res = await this.dependencies.es.search({
      index: INDEX_NAME,
      knn: {
        field: "embedding",
        query_vector: emb.data[0].embedding,
        k: topK,
        num_candidates: topK * 10,
        filter: filters.length > 1
          ? { bool: { must: filters } }
          : filters[0],
      },
      _source: true,
    }, { signal })
    return res.hits.hits.map((hit) => ({
      chunk: hit._source as unknown as Chunk,
      score: hit._score ?? 0,
      source: "vector" as const,
      wikilinks: [],
    }))
  }

  async bm25Search(query: Query, topK: number, accessContext?: AccessContext, signal?: AbortSignal): Promise<RetrievalResult[]> {
    const res = await this.dependencies.es.search({
      index: INDEX_NAME,
      query: {
        bool: {
          must: [{ match: { content: query.text } }],
          filter: [
            childFilter(),
            ...this.activeTermsFilter(),
            ...accessContextFilter(accessContext),
          ],
        },
      },
      size: topK,
      _source: true,
    }, { signal })
    return res.hits.hits.map((hit) => ({
      chunk: hit._source as unknown as Chunk,
      score: hit._score ?? 0,
      source: "bm25" as const,
      wikilinks: [],
    }))
  }

  async graphSearch(query: Query, topK: number, seeds?: string[], accessContext?: AccessContext, signal?: AbortSignal): Promise<RetrievalResult[]> {
    const driver = this.dependencies.graphDriver ?? getDriver()
    const session = driver.session()
    const candidateLimit = topK * GRAPH_CANDIDATE_MULTIPLIER
    const graphQuery = query.text.normalize("NFKC").trim().toLowerCase().slice(0, 512)
    const queryTerms = [...new Set(graphQuery.match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 16)
    const seedList = Array.isArray(seeds)
      ? seeds.map((s) => String(s)).filter((s) => s.length > 0).slice(0, 16)
      : []
    try {
      const res = await session.run(
        `MATCH (e:Entity)
           WHERE toLower($query) CONTAINS toLower(e.name)
              OR any(a IN e.aliases WHERE toLower($query) CONTAINS toLower(a))
              OR any(term IN $queryTerms WHERE
                toLower(e.name) CONTAINS term OR
                any(a IN e.aliases WHERE toLower(a) CONTAINS term)
              )
              OR any(s IN $seeds WHERE toLower(e.name) = toLower(s))
           WITH e
           ORDER BY e.id
           LIMIT $entityLimit
           OPTIONAL MATCH (e)-[r]-(related:Entity)
           WITH e, r, related
           ORDER BY e.id, coalesce(r.fact, ''), related.id
           LIMIT $relationshipLimit
           WITH collect(DISTINCT e.name) + collect(DISTINCT related.name) AS names,
                collect(DISTINCT {
                  values: CASE
                    WHEN r.fact IS NOT NULL THEN [r.fact]
                    ELSE coalesce(r.relations, [])
                  END,
                  weight: coalesce(r.weight, 0.5),
                  provenance: coalesce(r.provenance, [])
                }) AS relationGroups
           RETURN names,
                  relationGroups`,
        {
          query: graphQuery,
          queryTerms,
          seeds: seedList,
          entityLimit: candidateLimit,
          relationshipLimit: candidateLimit,
        }
      )
      const names = [...new Set(
        res.records.flatMap((record) => record.get("names") as string[])
      )]
      const relations = res.records.flatMap((record) =>
        (record.get("relationGroups") as unknown[]).flatMap((group) => {
          if (!group || typeof group !== "object" || Array.isArray(group)) return []
          const values = (group as { values?: unknown }).values
          const rawWeight = (group as { weight?: unknown }).weight
          const rawProvenance = (group as { provenance?: unknown }).provenance
          if (!Array.isArray(values)) return []
          const weight = typeof rawWeight === "number" && Number.isFinite(rawWeight)
            ? Math.max(0, Math.min(1, rawWeight))
            : 0.5
          const provenance = filterProvenanceByAccessContext(
            parseGraphProvenance(rawProvenance),
            accessContext
          )
          return values.flatMap((value) => {
            if (typeof value !== "string") return []
            const separator = value.indexOf(":")
            const direction = value.slice(0, separator).split("->")
            if (separator < 0 || direction.length !== 2) return []
            return [{
              sourceEntityId: direction[0],
              targetEntityId: direction[1],
              relation: value.slice(separator + 1),
              weight,
              provenance,
            }]
          })
        })
      )
      const provenance = [...new Map(relations.flatMap(({ provenance = [] }) =>
        provenance.map(({ documentId, chunkId }) => [
          `${documentId}\0${chunkId}`,
          { documentId, id: chunkId },
        ] as const)
      )).values()].slice(0, candidateLimit)
      if (names.length === 0 && provenance.length === 0) return []
      const selected = new Set(provenance.map(({ documentId, id }) =>
        `${documentId}\0${id}`
      ))
      const boundedRelations = relations.flatMap((relation) => {
        const bounded = (relation.provenance ?? []).filter(({ documentId, chunkId }) =>
          selected.has(`${documentId}\0${chunkId}`)
        )
        return bounded.length > 0 ? [{ ...relation, provenance: bounded }] : []
      })

      const esRes = await this.dependencies.es.search({
        index: INDEX_NAME,
        query: provenance.length > 0
          ? {
              bool: {
                minimum_should_match: 1,
          should: provenance.map(({ documentId, id }) => ({
            bool: {
              must: [
                { term: { documentId } },
                { term: { id } },
              ],
            },
          })),
          filter: [childFilter(), ...this.activeTermsFilter(), ...accessContextFilter(accessContext)],
              },
            }
          : {
              bool: {
                must: [{ multi_match: { query: names.join(" "), fields: ["content"] } }],
                // P2.2: fallback path mirrors primary path ACL + active-version
                // filters (closes GRAPH_RETRIEVAL_FALLBACK_BYPASS).
                filter: [childFilter(), ...this.activeTermsFilter(), ...accessContextFilter(accessContext)],
              },
            },
        size: topK,
        _source: true,
      }, { signal })
      return esRes.hits.hits.map((hit) => {
        const chunk = hit._source as unknown as Chunk
        const identity = `${chunk.documentId}\0${chunk.id}`
        const wikilinks = boundedRelations.filter(({ provenance = [] }) =>
          provenance.some(({ documentId, chunkId }) =>
            `${documentId}\0${chunkId}` === identity
          )
        )
        const graphPath = wikilinks.flatMap(({ sourceEntityId, relation, targetEntityId }) =>
          [sourceEntityId, relation, targetEntityId]
        ).slice(0, 32)
        return {
          chunk: {
            ...chunk,
            metadata: {
              ...chunk.metadata,
              ...(graphPath.length > 0 ? { graphPath } : {}),
            },
          },
          score: hit._score ?? 0,
          source: "graph" as const,
          wikilinks,
        }
      })
    } finally {
      await session.close()
    }
  }

  async pageIndexSearch(query: Query, topK: number, accessContext?: AccessContext, signal?: AbortSignal): Promise<RetrievalResult[]> {
    const repo = this.dependencies.pageIndexRepo
    if (!repo) throw new Error("pageIndex repository unavailable")
    const allNodes = repo.searchNodes(query.text, PAGE_INDEX_NODE_LIMIT)
    const nodes = filterNodesByAccessContext(allNodes, accessContext)
    if (nodes.length === 0) return []
    const seen = new Set<string>()
    const unique = nodes.flatMap((node) =>
      node.linkedChunkIds.map((chunkId) => ({ documentId: node.documentId, chunkId }))
    ).filter(({ documentId, chunkId }) => {
      const key = `${documentId}\0${chunkId}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, topK)
    if (unique.length === 0) return []
    const esRes = await this.dependencies.es.search({
      index: INDEX_NAME,
      query: {
        bool: {
          minimum_should_match: 1,
          should: unique.map(({ documentId, chunkId }) => ({
            bool: {
              must: [
                { term: { documentId } },
                { term: { id: chunkId } },
              ],
            },
          })),
          filter: [
            childFilter(),
            ...this.activeTermsFilter(),
            ...accessContextFilter(accessContext),
          ],
        },
      },
      size: topK,
      _source: true,
    }, { signal })
    return esRes.hits.hits.map((hit) => ({
      chunk: hit._source as unknown as Chunk,
      score: hit._score ?? 0,
      source: "pageIndex" as const,
      wikilinks: [],
    }))
  }

  async rerank(query: string, results: RetrievalResult[], signal?: AbortSignal): Promise<RetrievalResult[]> {
    return rerank(
      this.dependencies.chatClient,
      this.dependencies.chatModel,
      query,
      results,
      signal
    )
  }

  async loadParents(
    identities: Array<{ documentId: string; id: string }>,
    accessContext?: AccessContext,
    signal?: AbortSignal
  ): Promise<Chunk[]> {
    if (identities.length === 0) return []
    const aclFilters = accessContextFilter(accessContext)
    const res = await this.dependencies.es.search({
      index: INDEX_NAME,
      query: {
        bool: {
          minimum_should_match: 1,
          should: identities.map(({ documentId, id }) => ({
            bool: {
              must: [
                { term: { documentId } },
                { term: { id } },
                { term: { kind: "parent" } },
              ],
            },
          })),
          ...(aclFilters.length > 0 ? { filter: aclFilters } : {}),
        },
      },
      size: identities.length,
      _source: true,
    }, { signal })
    return res.hits.hits.map((hit) => hit._source as unknown as Chunk)
  }
}

function parseGraphProvenance(values: unknown): NonNullable<
  RetrievalResult["wikilinks"][number]["provenance"]
> {
  if (!Array.isArray(values)) return []
  const provenance = new Map<string, NonNullable<
    RetrievalResult["wikilinks"][number]["provenance"]
  >[number]>()
  for (const value of values) {
    if (typeof value !== "string") continue
    try {
      const parsed = JSON.parse(value)
      if (!Array.isArray(parsed)) continue
      const item = parsed.length === 2 && parsed.every((part) => typeof part === "string")
        ? { documentId: parsed[0], chunkId: parsed[1] }
        : parsed.length === 4 &&
            parsed.slice(0, 3).every((part) => typeof part === "string") &&
            Array.isArray(parsed[3]) &&
            parsed[3].every((part) => typeof part === "string")
          ? {
              documentId: parsed[0],
              chunkId: parsed[1],
              tenantId: parsed[2],
              allowedGroups: parsed[3],
            }
          : null
      if (!item) continue
      const key = `${item.documentId}\0${item.chunkId}`
      const existing = provenance.get(key)
      if (!existing || (existing.tenantId === undefined && item.tenantId !== undefined)) {
        provenance.set(key, item)
      }
    } catch {
      continue
    }
  }
  return [...provenance.values()]
}

export class SearcherImpl implements Searcher {
  constructor(private operations: SearchOperations) {}

  async search(query: Query, options?: SearchOptions): Promise<SearchOutcome> {
    const hypothesis = options?.hypothesis
    const graphSeeds = options?.graphSeeds
    const accessContext = options?.accessContext
    // P7.2: honor cancellation at retrieval stage boundaries. When the
    // signal is already aborted at entry, reject immediately — no ES/Neo4j
    // queries are issued. Mid-run aborts are checked after allSettled and
    // after rerank so downstream work stops at the next boundary.
    const signal = options?.signal
    if (signal?.aborted) {
      const err = new Error("Answer run cancelled at GATE 1 (retrieval entry)")
      err.name = "AbortError"
      throw err
    }
    // Ticket 06: Resolve the caller's channel selection. undefined → all four
    // (backward compat); non-empty subset → only the requested channels.
    const selectedChannels = validateChannelSelection(options?.channels)
    const selectedSet = new Set<RetrievalChannel>(selectedChannels)
    const unselectedChannels = ALL_RETRIEVAL_CHANNELS.filter(
      (ch) => !selectedSet.has(ch)
    )
    const allChannelRunners: Array<{
      name: RetrievalChannel
      run: () => Promise<RetrievalResult[]>
    }> = [
      {
        name: "vector",
        run: () => this.operations.vectorSearch(query, CHANNEL_TOP_K, hypothesis, accessContext, signal),
      },
      {
        name: "bm25",
        run: () => this.operations.bm25Search(query, CHANNEL_TOP_K, accessContext, signal),
      },
      {
        name: "graph",
        run: () => this.operations.graphSearch(query, CHANNEL_TOP_K, graphSeeds, accessContext, signal),
      },
      {
        name: "pageIndex",
        run: () => this.operations.pageIndexSearch(query, CHANNEL_TOP_K, accessContext, signal),
      },
    ]
    const channelRunners = allChannelRunners.filter(({ name }) => selectedSet.has(name))
    const settled = await Promise.allSettled(channelRunners.map(({ run }) => run()))
    // P7.2: if the signal aborted while channel fetches were in flight,
    // stop downstream work (rerank/parent-load) at this boundary.
    if (signal?.aborted) {
      const err = new Error("Answer run cancelled at GATE 1 (after retrieval)")
      err.name = "AbortError"
      throw err
    }
    const unavailableChannels: RetrievalChannel[] = []
    const resultSets: RetrievalResult[][] = []

    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index]
      if (result.status === "fulfilled") {
        resultSets.push(result.value.filter(({ chunk }) =>
          chunk.metadata.kind !== "parent"
        ))
        continue
      }

      const channel = channelRunners[index].name
      unavailableChannels.push(channel)
      const message = result.reason instanceof Error
        ? result.reason.message
        : String(result.reason)
      console.warn(`[search] ${channel} channel unavailable:`, message)
    }

    if (unavailableChannels.length === channelRunners.length) {
      return {
        status: "insufficient",
        results: [],
        unavailableChannels,
        ...(unselectedChannels.length > 0
          ? { unselectedChannels }
          : {}),
      }
    }

    const fused = rrf(resultSets)
    let reranked = fused
    let rerankerFailed = false
    try {
      reranked = await this.operations.rerank(query.text, fused, signal)
    } catch (error) {
      rerankerFailed = true
      const message = error instanceof Error ? error.message : String(error)
      console.warn("[search] reranker unavailable:", message)
    }
    const results = reranked.slice(0, RESULT_TOP_K)
    const identities = [...new Map(
      results.flatMap(({ chunk }) => chunk.parentId
        ? [[`${chunk.documentId}\0${chunk.parentId}`, {
            documentId: chunk.documentId,
            id: chunk.parentId,
          }] as const]
        : [])
    ).values()]
    let parentExpansionFailed = false
    let parents: Chunk[] = []
    try {
      parents = await this.operations.loadParents(identities, accessContext, signal)
    } catch (error) {
      parentExpansionFailed = true
      const message = error instanceof Error ? error.message : String(error)
      console.warn("[search] parent expansion unavailable:", message)
    }
    const parentsById = new Map(parents.map((parent) => [
      `${parent.documentId}\0${parent.id}`,
      parent,
    ]))
    if (identities.some(({ documentId, id }) =>
      !parentsById.has(`${documentId}\0${id}`)
    )) {
      parentExpansionFailed = true
    }
    for (const result of results) {
      if (result.chunk.parentId) {
        result.parentChunk = parentsById.get(
          `${result.chunk.documentId}\0${result.chunk.parentId}`
        )
      }
    }
    const graphBudget = selectedSet.has("graph")
      ? {
          seeds: Array.isArray(graphSeeds)
            ? graphSeeds.map((s) => String(s)).filter((s) => s.length > 0).slice(0, 16)
            : [],
          hops: GRAPH_HOPS,
          candidates: CHANNEL_TOP_K * GRAPH_CANDIDATE_MULTIPLIER,
        }
      : undefined
    const degradationReasons: string[] = []
    if (parentExpansionFailed) degradationReasons.push("parent_expansion_unavailable")
    if (rerankerFailed) degradationReasons.push("reranker_unavailable")
    return {
      status: unavailableChannels.length === 0 && !parentExpansionFailed && !rerankerFailed
        ? "ok"
        : "degraded",
      results,
      unavailableChannels,
      ...(graphBudget ? { graphBudget } : {}),
      ...(degradationReasons.length > 0
        ? { degradationReasons }
        : {}),
      ...(unselectedChannels.length > 0
        ? { unselectedChannels }
        : {}),
    }
  }
}
