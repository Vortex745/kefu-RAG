import assert from "node:assert/strict"
import test from "node:test"
import type { Client } from "@elastic/elasticsearch"
import type OpenAI from "openai"
import type { PageIndexRepository } from "../../ingestion/tracking/page_index_repo"
import type { ActiveVersionRepository } from "../../ingestion/tracking/active_version_repo"
import type { AccessContext } from "../../access/context"
import type { Query, RetrievalResult } from "../../types"
import {
  RuntimeSearchOperations,
  SearcherImpl,
  type SearchOperations,
} from "./searcher"

function retrieval(
  id: string,
  source: RetrievalResult["source"],
  documentId = "doc-1"
): RetrievalResult {
  return {
    chunk: {
      id,
      documentId,
      content: `content-${id}`,
      childrenIds: [],
      metadata: { source: "test" },
    },
    score: 1,
    source,
    wikilinks: [],
  }
}

test("RRF preserves channel and graph provenance for shared evidence", async () => {
  const vector = retrieval("shared", "vector")
  const graph = retrieval("shared", "graph")
  vector.wikilinks = [{
    sourceEntityId: "refund",
    targetEntityId: "customer-service",
    relation: "POLICY_OF",
    weight: 0.2,
    provenance: [{ documentId: "doc-1", chunkId: "chunk-first" }],
  }]
  graph.chunk.metadata.graphPath = ["Refund", "POLICY_OF", "CustomerService"]
  graph.wikilinks = [{
    sourceEntityId: "refund",
    targetEntityId: "customer-service",
    relation: "POLICY_OF",
    weight: 0.8,
    provenance: [{ documentId: "doc-1", chunkId: "chunk-late" }],
  }]
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => [vector],
    graphSearch: async () => [graph],
  }))

  const outcome = await searcher.search({ text: "query" })
  assert.equal(outcome.results.length, 1)
  assert.deepEqual(outcome.results[0].channels, ["vector", "graph"])
  assert.deepEqual(outcome.results[0].chunk.metadata.graphPath, graph.chunk.metadata.graphPath)
  assert.deepEqual(outcome.results[0].wikilinks, [{
    ...graph.wikilinks[0],
    provenance: [
      { documentId: "doc-1", chunkId: "chunk-first" },
      { documentId: "doc-1", chunkId: "chunk-late" },
    ],
  }])
})

test("RRF does not collapse equal chunk ids from different document versions", async () => {
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => [retrieval("shared", "vector", "doc-v1")],
    bm25Search: async () => [retrieval("shared", "bm25", "doc-v2")],
  }))

  const outcome = await searcher.search({ text: "query" })
  assert.deepEqual(
    outcome.results.map(({ chunk }) => chunk.documentId),
    ["doc-v1", "doc-v2"]
  )
})

function operations(
  overrides: Partial<SearchOperations> = {}
): SearchOperations {
  return {
    vectorSearch: async () => [],
    bm25Search: async () => [],
    graphSearch: async () => [],
    pageIndexSearch: async () => [],
    rerank: async (_query, results) => results,
    loadParents: async () => [],
    ...overrides,
  }
}

test("runtime search recalls child, image, and legacy passages and loads parents by document", async () => {
  const requests: Array<Record<string, unknown>> = []
  const es = {
    async search(request: Record<string, unknown>) {
      requests.push(request)
      return { hits: { hits: [] } }
    },
  } as unknown as Client
  const embeddingClient = {
    embeddings: {
      create: async () => ({ data: [{ embedding: [0.1, 0.2] }] }),
    },
  } as unknown as OpenAI
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient,
    chatModel: "chat",
    embeddingModel: "embedding",
  })

  await runtime.vectorSearch({ text: "refund" }, 5)
  await runtime.bm25Search({ text: "refund" }, 5)
  await runtime.loadParents([
    { documentId: "doc-v1", id: "parent-shared" },
    { documentId: "doc-v2", id: "parent-shared" },
  ])

  const childFilter = {
    bool: {
      minimum_should_match: 1,
      should: [
        { term: { kind: "child" } },
        { term: { kind: "image" } },
        { bool: { must_not: [{ exists: { field: "kind" } }] } },
      ],
    },
  }
  assert.deepEqual(
    (requests[0].knn as { filter: unknown }).filter,
    childFilter
  )
  assert.deepEqual(
    ((requests[1].query as { bool: { filter: unknown[] } }).bool.filter),
    [childFilter]
  )
  assert.deepEqual(
    requests[2].query,
    {
      bool: {
        minimum_should_match: 1,
        should: [
          {
            bool: {
              must: [
                { term: { documentId: "doc-v1" } },
                { term: { id: "parent-shared" } },
                { term: { kind: "parent" } },
              ],
            },
          },
          {
            bool: {
              must: [
                { term: { documentId: "doc-v2" } },
                { term: { id: "parent-shared" } },
                { term: { kind: "parent" } },
              ],
            },
          },
        ],
      },
    }
  )
})

test("graph search follows provenance back to chunk evidence", async () => {
  let esRequest: Record<string, unknown> | undefined
  let graphQuery = ""
  let graphParams: Record<string, unknown> | undefined
  const evidence = retrieval("chunk-graph", "graph", "doc-v2").chunk
  const es = {
    async search(request: Record<string, unknown>) {
      esRequest = request
      return { hits: { hits: [{ _source: evidence, _score: 0.8 }] } }
    },
  } as unknown as Client
  const graphDriver = {
    session() {
      return {
        async run(query: string, params: Record<string, unknown>) {
          graphQuery = query
          graphParams = params
          return {
            records: [{
              get(key: string) {
                if (key === "names") return ["Refund Policy", "Customer"]
                if (key === "relationGroups") return [{
                  values: ["refund->customer:APPLIES_TO"],
                  weight: 0.8,
                  provenance: [
                    JSON.stringify(["doc-v2", "chunk-graph"]),
                    JSON.stringify([
                      "doc-v2",
                      "chunk-graph",
                      "tenant-a",
                      ["support"],
                    ]),
                  ],
                }]
                return []
              },
            }],
          }
        },
        async close() {},
      }
    },
  }
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })

  const results = await runtime.graphSearch({ text: "What is the Refund Policy?" }, 5)

  assert.match(graphQuery, /LIMIT \$entityLimit/)
  assert.match(graphQuery, /LIMIT \$relationshipLimit/)
  assert.match(graphQuery, /toLower\(\$query\) CONTAINS toLower\(e\.name\)/)
  assert.match(graphQuery, /term IN \$queryTerms/)
  assert.deepEqual(graphParams, {
    query: "what is the refund policy?",
    queryTerms: ["what", "is", "the", "refund", "policy"],
    seeds: [],
    entityLimit: 20,
    relationshipLimit: 20,
  })
  assert.deepEqual(
    ((esRequest?.query as { bool: { should: unknown[] } }).bool.should),
    [{
      bool: {
        must: [
          { term: { documentId: "doc-v2" } },
          { term: { id: "chunk-graph" } },
        ],
      },
    }]
  )
  assert.equal(results[0].chunk.id, "chunk-graph")
  assert.deepEqual(
    results[0].chunk.metadata.graphPath,
    ["refund", "APPLIES_TO", "customer"]
  )
  assert.deepEqual(results[0].wikilinks, [{
    sourceEntityId: "refund",
    targetEntityId: "customer",
    relation: "APPLIES_TO",
    weight: 0.8,
    provenance: [{
      documentId: "doc-v2",
      chunkId: "chunk-graph",
      tenantId: "tenant-a",
      allowedGroups: ["support"],
    }],
  }])
})

test("graph search bounds provenance lookup and keeps relationships on supporting chunks", async () => {
  let esRequest: Record<string, unknown> | undefined
  const es = {
    async search(request: Record<string, unknown>) {
      esRequest = request
      return {
        hits: {
          hits: [{
            _source: retrieval("chunk-0", "graph", "doc-v2").chunk,
            _score: 0.9,
          }],
        },
      }
    },
  } as unknown as Client
  const provenance = Array.from({ length: 25 }, (_, index) =>
    JSON.stringify(["doc-v2", `chunk-${index}`])
  )
  const graphDriver = {
    session() {
      return {
        async run() {
          return {
            records: [{
              get(key: string) {
                if (key === "names") return ["Refund Policy", "Customer", "Merchant"]
                if (key === "relationGroups") return [
                  {
                    values: ["refund->customer:APPLIES_TO"],
                    weight: 0.8,
                    provenance,
                  },
                  {
                    values: ["refund->merchant:EXCLUDES"],
                    weight: 0.6,
                    provenance: [JSON.stringify(["doc-v2", "chunk-24"])],
                  },
                ]
                return []
              },
            }],
          }
        },
        async close() {},
      }
    },
  }
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })

  const results = await runtime.graphSearch({ text: "refund" }, 5)

  const should = (esRequest?.query as { bool: { should: unknown[] } }).bool.should
  assert.equal(should.length, 20)
  assert.deepEqual(results[0].wikilinks, [{
    sourceEntityId: "refund",
    targetEntityId: "customer",
    relation: "APPLIES_TO",
    weight: 0.8,
    provenance: provenance.slice(0, 20).map((value) => {
      const [documentId, chunkId] = JSON.parse(value)
      return { documentId, chunkId }
    }),
  }])
})

test("hybrid search owns all channels, fusion, reranking, dedupe, and top-K", async () => {
  const calls: string[] = []
  const channelTopKs: number[] = []
  let rerankInput: string[] = []
  const searcher = new SearcherImpl(operations({
    vectorSearch: async (_query, topK) => {
      calls.push("vector")
      channelTopKs.push(topK)
      return ["a", "b", "c", "d", "e"].map((id) => retrieval(id, "vector"))
    },
    bm25Search: async (_query, topK) => {
      calls.push("bm25")
      channelTopKs.push(topK)
      return ["b", "f", "g", "h", "i"].map((id) => retrieval(id, "bm25"))
    },
    graphSearch: async (_query, topK) => {
      calls.push("graph")
      channelTopKs.push(topK)
      return ["i", "j", "k", "l", "m"].map((id) => retrieval(id, "graph"))
    },
    rerank: async (_query, results) => {
      calls.push("rerank")
      rerankInput = results.map(({ chunk }) => chunk.id)
      return [...results].reverse()
    },
  }))

  const outcome = await searcher.search({ text: "query" })

  assert.equal(outcome.status, "ok")
  assert.deepEqual(outcome.unavailableChannels, [])
  assert.deepEqual(calls.slice(0, 3).sort(), ["bm25", "graph", "vector"])
  assert.deepEqual(channelTopKs, [5, 5, 5])
  assert.equal(calls.at(-1), "rerank")
  assert.equal(new Set(rerankInput).size, rerankInput.length)
  assert.ok(rerankInput.includes("j"))
  assert.equal(rerankInput.length, 13)
  assert.equal(outcome.results.length, 10)
})

test("child recall expands a bounded parent without changing evidence identity", async () => {
  const child = retrieval("child-1", "vector")
  child.chunk.parentId = "parent-1"
  child.chunk.metadata.kind = "child"
  const parent = {
    id: "parent-1",
    documentId: child.chunk.documentId,
    content: "parent context",
    childrenIds: [child.chunk.id],
    metadata: { kind: "parent", source: "test" },
  }
  const parentHit = retrieval("parent-1", "bm25")
  parentHit.chunk = parent
  const loaded: Array<Array<{ documentId: string; id: string }>> = []
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => [child],
    bm25Search: async () => [parentHit],
    loadParents: async (identities) => {
      loaded.push(identities)
      return [parent]
    },
  }))

  const outcome = await searcher.search({ text: "refund" })

  assert.deepEqual(loaded, [[{ documentId: "doc-1", id: "parent-1" }]])
  assert.equal(outcome.results.length, 1)
  assert.equal(outcome.results[0].chunk.id, "child-1")
  assert.equal(outcome.results[0].parentChunk?.id, "parent-1")
})

test("parent expansion failure degrades to the recalled child", async () => {
  const recalled = retrieval("child-1", "vector")
  recalled.chunk.parentId = "parent-1"
  recalled.chunk.metadata.kind = "child"
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => [recalled],
    loadParents: async () => { throw new Error("parent lookup failed") },
  }))

  const outcome = await searcher.search({ text: "refund" })

  assert.equal(outcome.status, "degraded")
  assert.equal(outcome.results[0].chunk.id, "child-1")
  assert.equal(outcome.results[0].parentChunk, undefined)
  assert.deepEqual(outcome.degradationReasons, ["parent_expansion_unavailable"])
})

test("missing parent records degrade without dropping recalled children", async () => {
  const recalled = retrieval("child-missing-parent", "vector")
  recalled.chunk.parentId = "parent-missing"
  recalled.chunk.metadata.kind = "child"
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => [recalled],
    loadParents: async () => [],
  }))

  const outcome = await searcher.search({ text: "refund" })

  assert.equal(outcome.status, "degraded")
  assert.equal(outcome.results[0].chunk.id, "child-missing-parent")
  assert.deepEqual(outcome.degradationReasons, ["parent_expansion_unavailable"])
})

test("reranker adapter reject degrades to fused results without escaping the seam", async () => {
  const recalled = retrieval("rerank-failure-vector", "vector")
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => [recalled],
    rerank: async () => { throw new Error("reranker model timeout") },
  }))

  const outcome = await searcher.search({ text: "query" })

  assert.equal(outcome.status, "degraded")
  assert.equal(outcome.results.length, 1)
  assert.equal(outcome.results[0].chunk.id, "rerank-failure-vector")
  assert.deepEqual(outcome.degradationReasons, ["reranker_unavailable"])
})

test("one unavailable channel returns degraded results from the others", async () => {
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => [retrieval("a", "vector")],
    bm25Search: async () => [retrieval("b", "bm25")],
    graphSearch: async () => { throw new Error("neo4j unavailable") },
  }))

  const outcome = await searcher.search({ text: "query" })

  assert.equal(outcome.status, "degraded")
  assert.deepEqual(outcome.unavailableChannels, ["graph"])
  assert.deepEqual(
    outcome.results.map(({ chunk }) => chunk.id),
    ["a", "b"]
  )
})

test("all unavailable channels return an explicit insufficient outcome", async () => {
  let rerankCalled = false
  const unavailable = async (_query: Query): Promise<RetrievalResult[]> => {
    throw new Error("unavailable")
  }
  const searcher = new SearcherImpl(operations({
    vectorSearch: unavailable,
    bm25Search: unavailable,
    graphSearch: unavailable,
    pageIndexSearch: unavailable,
    rerank: async () => {
      rerankCalled = true
      return []
    },
  }))

  const outcome = await searcher.search({ text: "query" })

  assert.deepEqual(outcome, {
    status: "insufficient",
    results: [],
    unavailableChannels: ["vector", "bm25", "graph", "pageIndex"],
  })
  assert.equal(rerankCalled, false)
})

test("page index search recalls chunks linked to matching page index nodes", async () => {
  const pageIndexRepo = {
    searchNodes: () => [{
      documentId: "doc-1",
      nodeId: "node-1",
      title: "Refund Policy",
      sectionPath: ["Refund"],
      pageStart: 1,
      pageEnd: 5,
      summary: "refund policy summary",
      parentId: null,
      childIds: [],
      linkedChunkIds: ["chunk-1"],
    }],
    getNodesByDocument: () => [],
    replaceNodes: () => {},
  } as unknown as PageIndexRepository
  const es = {
    async search() {
      return {
        hits: {
          hits: [{
            _source: {
              id: "chunk-1",
              documentId: "doc-1",
              content: "refund content",
              childrenIds: [],
              metadata: { kind: "child" },
            },
            _score: 0.9,
          }],
        },
      }
    },
  } as unknown as Client
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    pageIndexRepo,
  })
  const results = await runtime.pageIndexSearch({ text: "refund" }, 5)
  assert.equal(results.length, 1)
  assert.equal(results[0].source, "pageIndex")
  assert.equal(results[0].chunk.id, "chunk-1")
})

test("pageIndex channel participates in fusion and degrades when unavailable", async () => {
  const unavailable = async (): Promise<RetrievalResult[]> => {
    throw new Error("unavailable")
  }
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => [retrieval("shared", "vector")],
    pageIndexSearch: unavailable,
  }))
  const outcome = await searcher.search({ text: "query" })
  assert.equal(outcome.status, "degraded")
  assert.deepEqual(outcome.unavailableChannels, ["pageIndex"])
  assert.equal(outcome.results.length, 1)
  assert.deepEqual(outcome.results[0].channels, ["vector"])
})

test("active version filter excludes chunks from non-active document versions", async () => {
  const activeVersionRepo = {
    getActiveDocIds: () => ["doc-active"],
  } as unknown as ActiveVersionRepository
  const requests: Array<Record<string, unknown>> = []
  const es = {
    async search(request: Record<string, unknown>) {
      requests.push(request)
      return { hits: { hits: [] } }
    },
  } as unknown as Client
  const embeddingClient = {
    embeddings: {
      create: async () => ({ data: [{ embedding: [0.1] }] }),
    },
  } as unknown as OpenAI
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient,
    chatModel: "chat",
    embeddingModel: "embedding",
    activeVersionRepo,
  })
  await runtime.vectorSearch({ text: "query" }, 5)
  const knn = requests[0].knn as { filter: { bool: { must: Array<Record<string, unknown>> } } }
  const termsFilter = knn.filter.bool.must.find((f) => "terms" in f) as { terms: { documentId: string[] } }
  assert.deepEqual(termsFilter.terms.documentId, ["doc-active"])
})

test("no active version filter when repo is absent", async () => {
  const requests: Array<Record<string, unknown>> = []
  const es = {
    async search(request: Record<string, unknown>) {
      requests.push(request)
      return { hits: { hits: [] } }
    },
  } as unknown as Client
  const embeddingClient = {
    embeddings: {
      create: async () => ({ data: [{ embedding: [0.1] }] }),
    },
  } as unknown as OpenAI
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient,
    chatModel: "chat",
    embeddingModel: "embedding",
  })
  await runtime.vectorSearch({ text: "query" }, 5)
  const knn = requests[0].knn as { filter: { bool: { must?: unknown } } }
  assert.equal(knn.filter.bool.must, undefined)
})

test("Ticket 07 P1: Searcher.search passes accessContext to each channel", async () => {
  const calls: Array<{ channel: string; accessContext?: AccessContext }> = []
  const ops = operations({
    vectorSearch: async (_q, _k, _h, ac) => {
      calls.push({ channel: "vector", accessContext: ac })
      return []
    },
    bm25Search: async (_q, _k, ac) => {
      calls.push({ channel: "bm25", accessContext: ac })
      return []
    },
    graphSearch: async (_q, _k, _s, ac) => {
      calls.push({ channel: "graph", accessContext: ac })
      return []
    },
    pageIndexSearch: async (_q, _k, ac) => {
      calls.push({ channel: "pageIndex", accessContext: ac })
      return []
    },
  })
  const searcher = new SearcherImpl(ops)
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: ["team-x"],
    scopes: ["chat"],
  }
  await searcher.search({ text: "query" }, { accessContext: ac })
  assert.equal(calls.length, 4)
  for (const call of calls) {
    assert.equal(
      call.accessContext,
      ac,
      `${call.channel} channel should receive the same accessContext reference`
    )
  }
})

test("Ticket 07 P1: Searcher.search passes undefined accessContext when omitted (backward compat)", async () => {
  const calls: Array<{ channel: string; accessContext?: AccessContext }> = []
  const ops = operations({
    vectorSearch: async (_q, _k, _h, ac) => {
      calls.push({ channel: "vector", accessContext: ac })
      return []
    },
    bm25Search: async (_q, _k, ac) => {
      calls.push({ channel: "bm25", accessContext: ac })
      return []
    },
    graphSearch: async (_q, _k, _s, ac) => {
      calls.push({ channel: "graph", accessContext: ac })
      return []
    },
    pageIndexSearch: async (_q, _k, ac) => {
      calls.push({ channel: "pageIndex", accessContext: ac })
      return []
    },
  })
  const searcher = new SearcherImpl(ops)
  await searcher.search({ text: "query" })
  assert.equal(calls.length, 4)
  for (const call of calls) {
    assert.equal(
      call.accessContext,
      undefined,
      `${call.channel} channel should receive undefined when caller omits accessContext`
    )
  }
})

function makeRuntime(es: Client, embeddingClient: OpenAI, activeVersionRepo?: ActiveVersionRepository) {
  return new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient,
    chatModel: "chat",
    embeddingModel: "embedding",
    ...(activeVersionRepo ? { activeVersionRepo } : {}),
  })
}

function mockEs() {
  const requests: Array<Record<string, unknown>> = []
  const es = {
    async search(request: Record<string, unknown>) {
      requests.push(request)
      return { hits: { hits: [] } }
    },
  } as unknown as Client
  return { requests, es }
}

function mockEmbedding() {
  return {
    embeddings: {
      create: async () => ({ data: [{ embedding: [0.1] }] }),
    },
  } as unknown as OpenAI
}

test("Ticket 07 P2: vectorSearch includes tenant filter when accessContext is provided", async () => {
  const { requests, es } = mockEs()
  const runtime = makeRuntime(es, mockEmbedding())
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: [],
    scopes: ["chat"],
  }
  await runtime.vectorSearch({ text: "query" }, 5, undefined, ac)
  const filterStr = JSON.stringify(requests[0].knn)
  assert.ok(
    filterStr.includes('"tenantId":"tenant-a"'),
    `vector knn filter should contain tenantId term: ${filterStr}`
  )
})

test("Ticket 07 P2: vectorSearch includes group filter when accessContext.groups is non-empty", async () => {
  const { requests, es } = mockEs()
  const runtime = makeRuntime(es, mockEmbedding())
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: ["team-x", "team-y"],
    scopes: ["chat"],
  }
  await runtime.vectorSearch({ text: "query" }, 5, undefined, ac)
  const filterStr = JSON.stringify(requests[0].knn)
  assert.ok(
    filterStr.includes('"allowedGroups":["team-x","team-y"]'),
    `vector knn filter should contain allowedGroups terms query: ${filterStr}`
  )
  assert.ok(
    filterStr.includes('"must_not"'),
    `vector knn filter should contain must_not exists for tenant-wide chunks: ${filterStr}`
  )
})

test("Ticket 07 P2: vectorSearch without accessContext has no tenant or group filter (backward compat)", async () => {
  const { requests, es } = mockEs()
  const runtime = makeRuntime(es, mockEmbedding())
  await runtime.vectorSearch({ text: "query" }, 5)
  const filterStr = JSON.stringify(requests[0].knn)
  assert.ok(
    !filterStr.includes("tenantId"),
    `vector knn filter must not contain tenantId when accessContext omitted: ${filterStr}`
  )
  assert.ok(
    !filterStr.includes("allowedGroups"),
    `vector knn filter must not contain allowedGroups when accessContext omitted: ${filterStr}`
  )
})

test("Ticket 07 P2: bm25Search includes tenant and group filter when accessContext is provided", async () => {
  const { requests, es } = mockEs()
  const runtime = makeRuntime(es, mockEmbedding())
  const ac: AccessContext = {
    tenantId: "tenant-b",
    subjectId: "user-2",
    groups: ["team-z"],
    scopes: ["chat"],
  }
  await runtime.bm25Search({ text: "query" }, 5, ac)
  const filterStr = JSON.stringify(requests[0].query)
  assert.ok(
    filterStr.includes('"tenantId":"tenant-b"'),
    `bm25 query filter should contain tenantId term: ${filterStr}`
  )
  assert.ok(
    filterStr.includes('"allowedGroups":["team-z"]'),
    `bm25 query filter should contain allowedGroups terms query: ${filterStr}`
  )
})

test("Ticket 07 P2: bm25Search without accessContext has no tenant or group filter (backward compat)", async () => {
  const { requests, es } = mockEs()
  const runtime = makeRuntime(es, mockEmbedding())
  await runtime.bm25Search({ text: "query" }, 5)
  const filterStr = JSON.stringify(requests[0].query)
  assert.ok(
    !filterStr.includes("tenantId"),
    `bm25 query filter must not contain tenantId when accessContext omitted: ${filterStr}`
  )
  assert.ok(
    !filterStr.includes("allowedGroups"),
    `bm25 query filter must not contain allowedGroups when accessContext omitted: ${filterStr}`
  )
})

function makePageIndexRepo(nodes: Array<{
  documentId: string
  linkedChunkIds: string[]
  tenantId?: string
  allowedGroups?: string[]
}>) {
  return {
    searchNodes: () => nodes,
  } as unknown as PageIndexRepository
}

test("Ticket 07 P3: pageIndexSearch filters PageIndex nodes by tenantId before ES lookup", async () => {
  const { requests, es } = mockEs()
  const pageIndexRepo = makePageIndexRepo([
    { documentId: "doc-same-tenant", linkedChunkIds: ["chunk-a"], tenantId: "tenant-a", allowedGroups: [] },
    { documentId: "doc-cross-tenant", linkedChunkIds: ["chunk-b"], tenantId: "tenant-b", allowedGroups: [] },
  ])
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: mockEmbedding(),
    chatModel: "chat",
    embeddingModel: "embedding",
    pageIndexRepo,
  })
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: [],
    scopes: ["chat"],
  }
  await runtime.pageIndexSearch({ text: "query" }, 5, ac)
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"documentId":"doc-same-tenant"'),
    `pageIndex ES query should include same-tenant documentId: ${queryStr}`
  )
  assert.ok(
    !queryStr.includes('"documentId":"doc-cross-tenant"'),
    `pageIndex ES query must exclude cross-tenant documentId: ${queryStr}`
  )
})

test("Ticket 07 P3: pageIndexSearch filters PageIndex nodes by allowedGroups for group-restricted user", async () => {
  const { requests, es } = mockEs()
  const pageIndexRepo = makePageIndexRepo([
    { documentId: "doc-tenant-wide", linkedChunkIds: ["chunk-a"], tenantId: "tenant-a", allowedGroups: [] },
    { documentId: "doc-team-x", linkedChunkIds: ["chunk-b"], tenantId: "tenant-a", allowedGroups: ["team-x"] },
    { documentId: "doc-team-y", linkedChunkIds: ["chunk-c"], tenantId: "tenant-a", allowedGroups: ["team-y"] },
  ])
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: mockEmbedding(),
    chatModel: "chat",
    embeddingModel: "embedding",
    pageIndexRepo,
  })
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: ["team-x"],
    scopes: ["chat"],
  }
  await runtime.pageIndexSearch({ text: "query" }, 5, ac)
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"documentId":"doc-tenant-wide"'),
    `pageIndex ES query should include tenant-wide document (empty allowedGroups): ${queryStr}`
  )
  assert.ok(
    queryStr.includes('"documentId":"doc-team-x"'),
    `pageIndex ES query should include group-matching document: ${queryStr}`
  )
  assert.ok(
    !queryStr.includes('"documentId":"doc-team-y"'),
    `pageIndex ES query must exclude non-matching group document: ${queryStr}`
  )
})

test("Ticket 07 P3: pageIndexSearch without accessContext does not filter nodes (backward compat)", async () => {
  const { requests, es } = mockEs()
  const pageIndexRepo = makePageIndexRepo([
    { documentId: "doc-1", linkedChunkIds: ["chunk-a"], tenantId: "tenant-a", allowedGroups: [] },
    { documentId: "doc-2", linkedChunkIds: ["chunk-b"], tenantId: "tenant-b", allowedGroups: [] },
  ])
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: mockEmbedding(),
    chatModel: "chat",
    embeddingModel: "embedding",
    pageIndexRepo,
  })
  await runtime.pageIndexSearch({ text: "query" }, 5)
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"documentId":"doc-1"'),
    `pageIndex ES query should include doc-1 when no accessContext: ${queryStr}`
  )
  assert.ok(
    queryStr.includes('"documentId":"doc-2"'),
    `pageIndex ES query should include doc-2 when no accessContext: ${queryStr}`
  )
})

test("Ticket 07 P3: pageIndexSearch ES recheck includes ACL filter when accessContext provided", async () => {
  const { requests, es } = mockEs()
  const pageIndexRepo = makePageIndexRepo([
    { documentId: "doc-1", linkedChunkIds: ["chunk-a"], tenantId: "tenant-a", allowedGroups: [] },
  ])
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: mockEmbedding(),
    chatModel: "chat",
    embeddingModel: "embedding",
    pageIndexRepo,
  })
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: [],
    scopes: ["chat"],
  }
  await runtime.pageIndexSearch({ text: "query" }, 5, ac)
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"tenantId":"tenant-a"'),
    `pageIndex ES recheck filter should contain tenantId: ${queryStr}`
  )
})

/**
 * Ticket 07 P4: graph channel ACL filter.
 *
 * Spec §6: "Graph traversal may discover shared entity nodes internally, but
 * a result becomes Evidence only after its provenance resolves to an active
 * authorized Chunk." We enforce this by:
 *  1. Filtering provenance records (4-element format carrying tenantId +
 *     allowedGroups) by AccessContext before building the chunk-identity set.
 *  2. Adding accessContextFilter to the ES recheck query as defense-in-depth.
 *
 * Legacy 2-element provenance (no tenantId) passes through the app-layer
 * filter; the ES recheck is the authoritative gate for those records.
 */
function makeGraphDriver(relationGroups: Array<{
  values: string[]
  weight: number
  provenance: string[]
}>) {
  return {
    session() {
      return {
        async run() {
          return {
            records: [{
              get(key: string) {
                if (key === "names") return ["Refund Policy", "Customer"]
                if (key === "relationGroups") return relationGroups
                return []
              },
            }],
          }
        },
        async close() {},
      }
    },
  }
}

test("Ticket 07 P4: graphSearch filters provenance by tenantId before ES recheck", async () => {
  const { requests, es } = mockEs()
  const graphDriver = makeGraphDriver([{
    values: ["refund->customer:APPLIES_TO"],
    weight: 0.8,
    provenance: [
      JSON.stringify(["doc-same", "chunk-a", "tenant-a", []]),
      JSON.stringify(["doc-cross", "chunk-b", "tenant-b", []]),
    ],
  }])
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: [],
    scopes: ["chat"],
  }
  await runtime.graphSearch({ text: "refund" }, 5, undefined, ac)
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"documentId":"doc-same"'),
    `graph ES recheck should include same-tenant provenance chunk: ${queryStr}`
  )
  assert.ok(
    !queryStr.includes('"documentId":"doc-cross"'),
    `graph ES recheck must exclude cross-tenant provenance chunk: ${queryStr}`
  )
})

test("Ticket 07 P4: graphSearch filters provenance by allowedGroups for group-restricted user", async () => {
  const { requests, es } = mockEs()
  const graphDriver = makeGraphDriver([{
    values: ["refund->customer:APPLIES_TO"],
    weight: 0.8,
    provenance: [
      JSON.stringify(["doc-tenant-wide", "chunk-wide", "tenant-a", []]),
      JSON.stringify(["doc-support", "chunk-sup", "tenant-a", ["support"]]),
      JSON.stringify(["doc-finance", "chunk-fin", "tenant-a", ["finance"]]),
    ],
  }])
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: ["support"],
    scopes: ["chat"],
  }
  await runtime.graphSearch({ text: "refund" }, 5, undefined, ac)
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"documentId":"doc-tenant-wide"'),
    `graph ES recheck should include tenant-wide provenance chunk: ${queryStr}`
  )
  assert.ok(
    queryStr.includes('"documentId":"doc-support"'),
    `graph ES recheck should include group-matching provenance chunk: ${queryStr}`
  )
  assert.ok(
    !queryStr.includes('"documentId":"doc-finance"'),
    `graph ES recheck must exclude non-matching group provenance chunk: ${queryStr}`
  )
})

test("Ticket 07 P4: graphSearch without accessContext does not filter provenance (backward compat)", async () => {
  const { requests, es } = mockEs()
  const graphDriver = makeGraphDriver([{
    values: ["refund->customer:APPLIES_TO"],
    weight: 0.8,
    provenance: [
      JSON.stringify(["doc-a", "chunk-a", "tenant-a", []]),
      JSON.stringify(["doc-b", "chunk-b", "tenant-b", []]),
    ],
  }])
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })
  await runtime.graphSearch({ text: "refund" }, 5)
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"documentId":"doc-a"'),
    `graph ES recheck should include doc-a when no accessContext: ${queryStr}`
  )
  assert.ok(
    queryStr.includes('"documentId":"doc-b"'),
    `graph ES recheck should include doc-b when no accessContext: ${queryStr}`
  )
  assert.ok(
    !queryStr.includes('"tenantId"'),
    `graph ES recheck must not contain tenantId filter when accessContext omitted: ${queryStr}`
  )
})

test("Ticket 07 P4: graphSearch ES recheck includes ACL filter when accessContext provided", async () => {
  const { requests, es } = mockEs()
  const graphDriver = makeGraphDriver([{
    values: ["refund->customer:APPLIES_TO"],
    weight: 0.8,
    provenance: [
      JSON.stringify(["doc-a", "chunk-a", "tenant-a", []]),
    ],
  }])
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: [],
    scopes: ["chat"],
  }
  await runtime.graphSearch({ text: "refund" }, 5, undefined, ac)
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"tenantId":"tenant-a"'),
    `graph ES recheck filter should contain tenantId: ${queryStr}`
  )
})

test("Ticket 07 P4: graphSearch legacy 2-element provenance passes through app-layer filter to ES gate", async () => {
  const { requests, es } = mockEs()
  const graphDriver = makeGraphDriver([{
    values: ["refund->customer:APPLIES_TO"],
    weight: 0.8,
    // Legacy 2-element format: no tenantId/allowedGroups carried.
    provenance: [JSON.stringify(["doc-legacy", "chunk-legacy"])],
  }])
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: [],
    scopes: ["chat"],
  }
  await runtime.graphSearch({ text: "refund" }, 5, undefined, ac)
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"documentId":"doc-legacy"'),
    `graph ES recheck should include legacy 2-element provenance (ES is authoritative gate): ${queryStr}`
  )
  assert.ok(
    queryStr.includes('"tenantId":"tenant-a"'),
    `graph ES recheck must still apply tenantId filter as authoritative gate: ${queryStr}`
  )
})

/**
 * P2.2 — Graph fallback path ACL enforcement (closes GRAPH_RETRIEVAL_FALLBACK_BYPASS).
 *
 * When graph provenance is empty but entity names are found, the fallback ES
 * recheck uses a `multi_match` query. P2.1 recorded that this fallback omitted
 * accessContextFilter and activeTermsFilter; P2.2 closes the bypass by mirroring
 * the primary path's filter array. These tests prove the fallback path is
 * exercised (multi_match shape, not primary bool.should) AND applies the ACL +
 * active-version filters that deny missing-tenant / cross-tenant / wrong-group /
 * inactive-version candidates. Backward compat: when accessContext is undefined
 * and no activeVersionRepo is wired, the fallback filter is just [childFilter()]
 * — identical to pre-P2.2 behavior (bare router mounts / single-tenant callers).
 */

test("P2.2 fallback path is exercised when provenance is empty (multi_match query shape, not primary bool.should)", async () => {
  const { requests, es } = mockEs()
  const graphDriver = makeGraphDriver([{
    values: ["refund->customer:APPLIES_TO"],
    weight: 0.8,
    provenance: [], // empty provenance → fallback path
  }])
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })
  await runtime.graphSearch({ text: "refund" }, 5)
  const query = requests[0].query as { bool: { must: unknown[] } }
  assert.ok(
    Array.isArray(query.bool.must) && query.bool.must.length === 1,
    "fallback path must use multi_match in bool.must"
  )
  const must = query.bool.must[0] as { multi_match?: unknown }
  assert.ok(
    must.multi_match !== undefined,
    "fallback path must use multi_match query (not primary bool.should with documentId/id terms)"
  )
})

test("P2.2 fallback deny: missing tenant tag → tenantId filter present (fail closed for untagged)", async () => {
  const { requests, es } = mockEs()
  const graphDriver = makeGraphDriver([{
    values: ["refund->customer:APPLIES_TO"],
    weight: 0.8,
    provenance: [], // empty provenance → fallback path
  }])
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: [],
    scopes: ["chat"],
  }
  await runtime.graphSearch({ text: "refund" }, 5, undefined, ac)
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"multi_match"'),
    `fallback path must be exercised (multi_match shape): ${queryStr}`
  )
  assert.ok(
    queryStr.includes('"tenantId":"tenant-a"'),
    `fallback ES query must contain tenantId filter — a chunk without tenantId field (legacy untagged) will not match ES term query → denied (fail closed): ${queryStr}`
  )
})

test("P2.2 fallback deny: cross-tenant → tenantId filter present (denies tenant-b chunk when caller is tenant-a)", async () => {
  const { requests, es } = mockEs()
  const graphDriver = makeGraphDriver([{
    values: ["refund->customer:APPLIES_TO"],
    weight: 0.8,
    provenance: [],
  }])
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: [],
    scopes: ["chat"],
  }
  await runtime.graphSearch({ text: "refund" }, 5, undefined, ac)
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"multi_match"'),
    `fallback path must be exercised: ${queryStr}`
  )
  assert.ok(
    queryStr.includes('"tenantId":"tenant-a"'),
    `fallback ES query must contain tenantId filter — a chunk with tenantId="tenant-b" will not match → cross-tenant denied: ${queryStr}`
  )
})

test("P2.2 fallback deny: wrong group → allowedGroups filter present (denies non-intersecting group)", async () => {
  const { requests, es } = mockEs()
  const graphDriver = makeGraphDriver([{
    values: ["refund->customer:APPLIES_TO"],
    weight: 0.8,
    provenance: [],
  }])
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: ["support"],
    scopes: ["chat"],
  }
  await runtime.graphSearch({ text: "refund" }, 5, undefined, ac)
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"multi_match"'),
    `fallback path must be exercised: ${queryStr}`
  )
  assert.ok(
    queryStr.includes('"allowedGroups":["support"]'),
    `fallback ES query must contain allowedGroups filter — a chunk with allowedGroups=["finance"] will not intersect → wrong-group denied: ${queryStr}`
  )
})

test("P2.2 fallback deny: inactive version → documentId terms filter present (denies non-active documents)", async () => {
  const { requests, es } = mockEs()
  const graphDriver = makeGraphDriver([{
    values: ["refund->customer:APPLIES_TO"],
    weight: 0.8,
    provenance: [],
  }])
  const activeVersionRepo = {
    getActiveDocIds: () => ["doc-active"],
  } as unknown as ActiveVersionRepository
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
    activeVersionRepo,
  })
  await runtime.graphSearch({ text: "refund" }, 5)
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"multi_match"'),
    `fallback path must be exercised: ${queryStr}`
  )
  assert.ok(
    queryStr.includes('"documentId":["doc-active"]'),
    `fallback ES query must contain documentId terms filter — a chunk with documentId="doc-inactive" will not match → inactive-version denied: ${queryStr}`
  )
})

test("P2.2 fallback backward compat: no accessContext and no activeVersionRepo → fallback filter unchanged (just childFilter)", async () => {
  const { requests, es } = mockEs()
  const graphDriver = makeGraphDriver([{
    values: ["refund->customer:APPLIES_TO"],
    weight: 0.8,
    provenance: [],
  }])
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })
  // No accessContext, no activeVersionRepo — backward compat with bare router
  // mounts and legacy callers. accessContextFilter(undefined) returns [] and
  // activeTermsFilter() returns [] when no repo is wired, so the fallback
  // filter array stays as [childFilter()] — identical to pre-P2.2 behavior.
  await runtime.graphSearch({ text: "refund" }, 5)
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"multi_match"'),
    `fallback path must be exercised: ${queryStr}`
  )
  assert.ok(
    !queryStr.includes('"tenantId"'),
    `fallback ES query must NOT contain tenantId when accessContext omitted (backward compat): ${queryStr}`
  )
  assert.ok(
    !queryStr.includes('"allowedGroups"'),
    `fallback ES query must NOT contain allowedGroups when accessContext omitted (backward compat): ${queryStr}`
  )
  assert.ok(
    !queryStr.includes('"terms"'),
    `fallback ES query must NOT contain terms filter when activeVersionRepo absent (backward compat): ${queryStr}`
  )
})

/**
 * P2.3 — Graph outage and provenance regression.
 *
 * Proves that graph driver outage degrades gracefully (no crash, no hang) and
 * that Evidence produced during outage — whether from other channels (hard
 * outage: driver throws) or from the graph fallback path (soft outage: graph
 * returns empty provenance) — still carries correct tenant/group/active-
 * version attribution. No unauthorized Evidence leaks under outage conditions.
 *
 * Backward compat: when accessContext is undefined, outage degradation
 * behavior is unchanged (no ACL filter added, identical to pre-P2.3).
 *
 * Situation A (test-only): graphSearch already has try/finally that propagates
 * session.run() errors; SearcherImpl.search uses Promise.allSettled that
 * captures rejections gracefully. The fallback path ACL enforcement is already
 * in place (P2.2). No searcher.ts modification needed — these tests verify the
 * existing outage handling and prove no leak path exists.
 */

// Helper: graph driver whose session.run() throws (Neo4j unreachable)
function makeThrowingGraphDriver(error: Error) {
  return {
    session() {
      return {
        async run() { throw error },
        async close() {},
      }
    },
  }
}

// Helper: graph driver whose session() throws (driver not connected)
function makeBrokenGraphDriver(error: Error) {
  return {
    session() { throw error },
  }
}

test("P2.3 outage: graph driver session.run throws → SearcherImpl degrades gracefully (graph unavailable, other channels produce results)", async () => {
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => [retrieval("a", "vector")],
    bm25Search: async () => [retrieval("b", "bm25")],
    graphSearch: async () => { throw new Error("Neo4j: could not perform discovery") },
  }))
  const outcome = await searcher.search({ text: "query" })
  assert.equal(outcome.status, "degraded")
  assert.deepEqual(outcome.unavailableChannels, ["graph"])
  assert.deepEqual(
    outcome.results.map(({ chunk }) => chunk.id).sort(),
    ["a", "b"]
  )
})

test("P2.3 outage: accessContext propagated to all available channels during graph outage", async () => {
  const calls: Array<{ channel: string; accessContext?: AccessContext }> = []
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: ["support"],
    scopes: ["chat"],
  }
  const searcher = new SearcherImpl(operations({
    vectorSearch: async (_q, _k, _h, accessContext) => {
      calls.push({ channel: "vector", accessContext })
      return [retrieval("a", "vector")]
    },
    bm25Search: async (_q, _k, accessContext) => {
      calls.push({ channel: "bm25", accessContext })
      return [retrieval("b", "bm25")]
    },
    graphSearch: async () => { throw new Error("neo4j unavailable") },
    pageIndexSearch: async (_q, _k, accessContext) => {
      calls.push({ channel: "pageIndex", accessContext })
      return []
    },
  }))
  await searcher.search({ text: "query" }, { accessContext: ac })
  assert.equal(calls.length, 3, "graph threw; the other 3 channels should still be called")
  for (const call of calls) {
    assert.equal(
      call.accessContext,
      ac,
      `${call.channel} should receive accessContext during graph outage`
    )
  }
})

test("P2.3 outage: no unauthorized leak — ES queries from available channels contain all 3 ACL filters (tenant + group + active-version) during outage", async () => {
  const { requests, es } = mockEs()
  const activeVersionRepo = {
    getActiveDocIds: () => ["doc-active"],
  } as unknown as ActiveVersionRepository
  const graphDriver = makeThrowingGraphDriver(new Error("Neo4j unreachable"))
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: mockEmbedding(),
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
    activeVersionRepo,
  })
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: ["support"],
    scopes: ["chat"],
  }
  // graphSearch throws (outage); vector + bm25 succeed with ACL filters
  await runtime.graphSearch({ text: "query" }, 5, undefined, ac).catch(() => {})
  await runtime.vectorSearch({ text: "query" }, 5, undefined, ac)
  await runtime.bm25Search({ text: "query" }, 5, ac)
  for (const request of requests) {
    const queryStr = JSON.stringify(request)
    assert.ok(
      queryStr.includes('"tenantId":"tenant-a"'),
      `ES query during graph outage must contain tenantId filter (no cross-tenant leak): ${queryStr}`
    )
    assert.ok(
      queryStr.includes('"allowedGroups":["support"]'),
      `ES query during graph outage must contain allowedGroups filter (no wrong-group leak): ${queryStr}`
    )
    assert.ok(
      queryStr.includes('"documentId":["doc-active"]'),
      `ES query during graph outage must contain documentId terms filter (no inactive-version leak): ${queryStr}`
    )
  }
})

test("P2.3 outage: backward compat — accessContext undefined → degradation behavior unchanged (no ACL filter)", async () => {
  const { requests, es } = mockEs()
  const graphDriver = makeThrowingGraphDriver(new Error("Neo4j unreachable"))
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: mockEmbedding(),
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })
  // No accessContext, no activeVersionRepo — backward compat with bare mounts
  await runtime.graphSearch({ text: "query" }, 5).catch(() => {})
  await runtime.vectorSearch({ text: "query" }, 5)
  await runtime.bm25Search({ text: "query" }, 5)
  for (const request of requests) {
    const queryStr = JSON.stringify(request)
    assert.ok(
      !queryStr.includes('"tenantId"'),
      `ES query during graph outage must NOT contain tenantId when accessContext omitted (backward compat): ${queryStr}`
    )
    assert.ok(
      !queryStr.includes('"allowedGroups"'),
      `ES query during graph outage must NOT contain allowedGroups when accessContext omitted (backward compat): ${queryStr}`
    )
    assert.ok(
      !queryStr.includes('"terms"'),
      `ES query during graph outage must NOT contain terms filter when activeVersionRepo absent (backward compat): ${queryStr}`
    )
  }
})

test("P2.3 outage: graph driver session() throws (driver itself broken) → graphSearch throws before ES query", async () => {
  const { requests, es } = mockEs()
  const graphDriver = makeBrokenGraphDriver(new Error("driver not connected"))
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: mockEmbedding(),
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
  })
  // graphSearch should throw (session() throws before try block)
  await assert.rejects(
    runtime.graphSearch({ text: "query" }, 5),
    /driver not connected/,
    "graphSearch should propagate the session() error"
  )
  assert.equal(
    requests.length, 0,
    "no ES query should be issued when graph driver session() throws"
  )
})

test("P2.3 outage: no hang — search completes promptly during graph outage", async () => {
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => [retrieval("a", "vector")],
    graphSearch: async () => { throw new Error("ServiceUnavailable: Neo4j bolt connection refused") },
  }))
  const start = Date.now()
  const outcome = await searcher.search({ text: "query" })
  const elapsed = Date.now() - start
  assert.equal(outcome.status, "degraded")
  assert.deepEqual(outcome.unavailableChannels, ["graph"])
  assert.ok(
    elapsed < 5000,
    `search should complete promptly during outage (elapsed: ${elapsed}ms)`
  )
  assert.equal(outcome.results.length, 1)
})

test("P2.3 provenance regression: fallback path (empty provenance) Evidence carries all 3 ACL attributions (tenant + group + active-version)", async () => {
  const { requests, es } = mockEs()
  const graphDriver = makeGraphDriver([{
    values: ["refund->customer:APPLIES_TO"],
    weight: 0.8,
    provenance: [], // empty provenance → fallback path (soft outage / partial failure)
  }])
  const activeVersionRepo = {
    getActiveDocIds: () => ["doc-active"],
  } as unknown as ActiveVersionRepository
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: {} as OpenAI,
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
    activeVersionRepo,
  })
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: ["support"],
    scopes: ["chat"],
  }
  await runtime.graphSearch({ text: "refund" }, 5, undefined, ac)
  const queryStr = JSON.stringify(requests[0].query)
  // Regression: P2.2's fix must still be in place — fallback path carries all 3 filters
  assert.ok(
    queryStr.includes('"multi_match"'),
    `fallback path must be exercised (multi_match shape): ${queryStr}`
  )
  assert.ok(
    queryStr.includes('"tenantId":"tenant-a"'),
    `fallback ES query must contain tenantId filter (P2.2 regression — no cross-tenant leak): ${queryStr}`
  )
  assert.ok(
    queryStr.includes('"allowedGroups":["support"]'),
    `fallback ES query must contain allowedGroups filter (P2.2 regression — no wrong-group leak): ${queryStr}`
  )
  assert.ok(
    queryStr.includes('"documentId":["doc-active"]'),
    `fallback ES query must contain documentId terms filter (P2.2 regression — no inactive-version leak): ${queryStr}`
  )
})

test("P2.3 outage: full SearcherImpl flow with RuntimeSearchOperations — graph throws, other channels produce ACL-filtered Evidence", async () => {
  const { requests, es } = mockEs()
  const pageIndexRepo = {
    searchNodes: () => [],
  } as unknown as PageIndexRepository
  const graphDriver = makeThrowingGraphDriver(new Error("Neo4j unreachable"))
  const runtime = new RuntimeSearchOperations({
    es,
    chatClient: {} as OpenAI,
    embeddingClient: mockEmbedding(),
    chatModel: "chat",
    embeddingModel: "embedding",
    graphDriver: graphDriver as never,
    pageIndexRepo,
  })
  const searcher = new SearcherImpl(runtime)
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: ["support"],
    scopes: ["chat"],
  }
  const outcome = await searcher.search({ text: "query" }, { accessContext: ac })
  assert.equal(outcome.status, "degraded")
  assert.deepEqual(outcome.unavailableChannels, ["graph"])
  // All ES queries from available channels (vector, bm25) must contain ACL filters
  for (const request of requests) {
    const queryStr = JSON.stringify(request)
    assert.ok(
      queryStr.includes('"tenantId":"tenant-a"'),
      `ES query during outage should contain tenantId filter: ${queryStr}`
    )
    assert.ok(
      queryStr.includes('"allowedGroups":["support"]'),
      `ES query during outage should contain allowedGroups filter: ${queryStr}`
    )
  }
})

/**
 * Ticket 07 P5: loadParents ES ACL filter.
 *
 * Spec §6: "RRF, rerank, parent expansion, Context assembly and Citation
 * generation operate only on already-authorized results. No later stage may
 * broaden visibility." Parent expansion identities are derived from already-
 * authorized children, but defense-in-depth requires the ES query to also
 * enforce AccessContext so a cross-tenant parent (e.g. due to documentId
 * collision or data corruption) can never leak.
 *
 * Backward compat: when no accessContext is supplied, the query shape is
 * exactly the legacy shape (no `filter` key) so existing deepEqual assertions
 * and single-tenant callers are unaffected.
 */
test("Ticket 07 P5: loadParents includes tenant filter when accessContext provided", async () => {
  const { requests, es } = mockEs()
  const runtime = makeRuntime(es, mockEmbedding())
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: [],
    scopes: ["chat"],
  }
  await runtime.loadParents(
    [{ documentId: "doc-1", id: "parent-1" }],
    ac
  )
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"tenantId":"tenant-a"'),
    `loadParents ES query should contain tenantId filter: ${queryStr}`
  )
})

test("Ticket 07 P5: loadParents includes group filter when accessContext.groups is non-empty", async () => {
  const { requests, es } = mockEs()
  const runtime = makeRuntime(es, mockEmbedding())
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: ["support"],
    scopes: ["chat"],
  }
  await runtime.loadParents(
    [{ documentId: "doc-1", id: "parent-1" }],
    ac
  )
  const queryStr = JSON.stringify(requests[0].query)
  assert.ok(
    queryStr.includes('"allowedGroups":["support"]'),
    `loadParents ES query should contain allowedGroups filter: ${queryStr}`
  )
})

test("Ticket 07 P5: loadParents without accessContext has no filter (backward compat)", async () => {
  const { requests, es } = mockEs()
  const runtime = makeRuntime(es, mockEmbedding())
  await runtime.loadParents([{ documentId: "doc-1", id: "parent-1" }])
  const query = requests[0].query as { bool: Record<string, unknown> }
  assert.ok(
    !("filter" in query.bool),
    `loadParents ES query must not have filter key when accessContext omitted: ${JSON.stringify(query)}`
  )
  assert.ok(
    !JSON.stringify(query).includes("tenantId"),
    `loadParents ES query must not contain tenantId when accessContext omitted: ${JSON.stringify(query)}`
  )
})

test("Ticket 07 P5: SearcherImpl.search passes accessContext to loadParents", async () => {
  const child = retrieval("child-1", "vector")
  child.chunk.parentId = "parent-1"
  child.chunk.metadata.kind = "child"
  const parent = {
    id: "parent-1",
    documentId: child.chunk.documentId,
    content: "parent context",
    childrenIds: [child.chunk.id],
    metadata: { kind: "parent", source: "test" },
  }
  const loadParentsCalls: Array<{ accessContext?: AccessContext }> = []
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => [child],
    loadParents: async (identities, accessContext?) => {
      loadParentsCalls.push({ accessContext })
      return [parent]
    },
  }))
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: ["support"],
    scopes: ["chat"],
  }
  await searcher.search({ text: "query" }, { accessContext: ac })
  assert.equal(loadParentsCalls.length, 1, "loadParents should be called exactly once")
  assert.deepEqual(
    loadParentsCalls[0].accessContext,
    ac,
    "loadParents should receive the same accessContext as Searcher.search"
  )
})

// === Ticket 06 P2: Channel selection ===

test("Ticket 06 P2: default search (no channels option) executes all four channels and omits unselectedChannels", async () => {
  const calls: string[] = []
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => { calls.push("vector"); return [retrieval("a", "vector")] },
    bm25Search: async () => { calls.push("bm25"); return [retrieval("b", "bm25")] },
    graphSearch: async () => { calls.push("graph"); return [retrieval("c", "graph")] },
    pageIndexSearch: async () => { calls.push("pageIndex"); return [retrieval("d", "pageIndex")] },
  }))

  const outcome = await searcher.search({ text: "query" })

  assert.equal(outcome.status, "ok")
  assert.deepEqual(calls.sort(), ["bm25", "graph", "pageIndex", "vector"],
    "all four channels should execute when channels option is omitted (backward compat)")
  assert.equal(outcome.unselectedChannels, undefined,
    "unselectedChannels must be undefined when all four channels are executed")
})

test("Ticket 06 P2: single-channel subset (vector only) executes only vectorSearch and reports unselectedChannels", async () => {
  const calls: string[] = []
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => { calls.push("vector"); return [retrieval("a", "vector")] },
    bm25Search: async () => { calls.push("bm25"); return [] },
    graphSearch: async () => { calls.push("graph"); return [] },
    pageIndexSearch: async () => { calls.push("pageIndex"); return [] },
  }))

  const outcome = await searcher.search({ text: "query" }, { channels: ["vector"] })

  assert.equal(outcome.status, "ok")
  assert.deepEqual(calls, ["vector"],
    "only the vector channel should be called when channels: ['vector']")
  assert.deepEqual(outcome.unselectedChannels, ["bm25", "graph", "pageIndex"],
    "unselectedChannels should list all channels not in the caller's selection")
  assert.deepEqual(outcome.unavailableChannels, [])
  assert.equal(outcome.results.length, 1)
  assert.equal(outcome.results[0].chunk.id, "a")
})

test("Ticket 06 P2: multi-channel subset (vector + bm25) executes only requested channels", async () => {
  const calls: string[] = []
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => { calls.push("vector"); return [retrieval("a", "vector")] },
    bm25Search: async () => { calls.push("bm25"); return [retrieval("b", "bm25")] },
    graphSearch: async () => { calls.push("graph"); return [] },
    pageIndexSearch: async () => { calls.push("pageIndex"); return [] },
  }))

  const outcome = await searcher.search({ text: "query" }, { channels: ["vector", "bm25"] })

  assert.equal(outcome.status, "ok")
  assert.deepEqual(calls.sort(), ["bm25", "vector"],
    "only the requested channels should be called")
  assert.deepEqual(outcome.unselectedChannels, ["graph", "pageIndex"],
    "unselectedChannels should list channels not in the caller's selection")
  assert.deepEqual(outcome.unavailableChannels, [])
  assert.equal(outcome.results.length, 2)
  assert.deepEqual(
    outcome.results.map(({ chunk }) => chunk.id).sort(),
    ["a", "b"]
  )
})

test("Ticket 06 P2: degraded outcome with channel selection reports partial failure among selected channels only", async () => {
  const searcher = new SearcherImpl(operations({
    vectorSearch: async () => [retrieval("a", "vector")],
    bm25Search: async () => { throw new Error("bm25 unavailable") },
  }))

  const outcome = await searcher.search({ text: "query" }, { channels: ["vector", "bm25"] })

  assert.equal(outcome.status, "degraded")
  assert.deepEqual(outcome.unavailableChannels, ["bm25"],
    "unavailableChannels should list only the selected channel that failed")
  assert.deepEqual(outcome.unselectedChannels, ["graph", "pageIndex"],
    "unselectedChannels should still list the channels not in the caller's selection")
  assert.equal(outcome.results.length, 1)
  assert.equal(outcome.results[0].chunk.id, "a")
})

test("Ticket 06 P2: insufficient outcome with channel selection reports all selected channels unavailable", async () => {
  let rerankCalled = false
  const unavailable = async (): Promise<RetrievalResult[]> => {
    throw new Error("unavailable")
  }
  const searcher = new SearcherImpl(operations({
    vectorSearch: unavailable,
    bm25Search: unavailable,
    graphSearch: unavailable,
    pageIndexSearch: unavailable,
    rerank: async () => { rerankCalled = true; return [] },
  }))

  const outcome = await searcher.search({ text: "query" }, { channels: ["vector", "bm25"] })

  assert.deepEqual(outcome, {
    status: "insufficient",
    results: [],
    unavailableChannels: ["vector", "bm25"],
    unselectedChannels: ["graph", "pageIndex"],
  })
  assert.equal(rerankCalled, false,
    "rerank must not be called when all selected channels fail")
})

test("Ticket 06 P2: ACL propagation with channel selection — accessContext passed to selected channels only", async () => {
  const calls: Array<{ channel: string; accessContext?: AccessContext }> = []
  const searcher = new SearcherImpl(operations({
    vectorSearch: async (_q, _k, _h, ac) => {
      calls.push({ channel: "vector", accessContext: ac })
      return [retrieval("a", "vector")]
    },
    bm25Search: async (_q, _k, ac) => {
      calls.push({ channel: "bm25", accessContext: ac })
      return []
    },
    graphSearch: async (_q, _k, _s, ac) => {
      calls.push({ channel: "graph", accessContext: ac })
      return [retrieval("c", "graph")]
    },
    pageIndexSearch: async (_q, _k, ac) => {
      calls.push({ channel: "pageIndex", accessContext: ac })
      return []
    },
  }))
  const ac: AccessContext = {
    tenantId: "tenant-a",
    subjectId: "user-1",
    groups: ["team-x"],
    scopes: ["chat"],
  }

  const outcome = await searcher.search(
    { text: "query" },
    { channels: ["vector", "graph"], accessContext: ac }
  )

  assert.equal(calls.length, 2,
    "only the 2 selected channels should be called")
  assert.deepEqual(
    calls.map((c) => c.channel).sort(),
    ["graph", "vector"],
    "only vector and graph channels should be called"
  )
  for (const call of calls) {
    assert.equal(
      call.accessContext,
      ac,
      `${call.channel} channel should receive the same accessContext reference`
    )
  }
  assert.deepEqual(outcome.unselectedChannels, ["bm25", "pageIndex"],
    "unselectedChannels should list channels not in the caller's selection")
  assert.deepEqual(outcome.unavailableChannels, [])
})

test("Ticket 06 P2: graphBudget omitted when graph channel not selected, present when selected", async () => {
  // Part 1: graph NOT selected → graphBudget must be undefined
  const searcherWithoutGraph = new SearcherImpl(operations({
    vectorSearch: async () => [retrieval("a", "vector")],
    bm25Search: async () => [retrieval("b", "bm25")],
  }))

  const outcomeWithoutGraph = await searcherWithoutGraph.search(
    { text: "query" },
    { channels: ["vector", "bm25"], graphSeeds: ["seed-1", "seed-2"] }
  )

  assert.equal(outcomeWithoutGraph.status, "ok")
  assert.equal(outcomeWithoutGraph.graphBudget, undefined,
    "graphBudget must be undefined when graph channel is not in the selection")
  assert.deepEqual(outcomeWithoutGraph.unselectedChannels, ["graph", "pageIndex"])

  // Part 2: graph IS selected → graphBudget must be present with expected shape
  const searcherWithGraph = new SearcherImpl(operations({
    vectorSearch: async () => [retrieval("a", "vector")],
    graphSearch: async () => [retrieval("c", "graph")],
  }))

  const outcomeWithGraph = await searcherWithGraph.search(
    { text: "query" },
    { channels: ["vector", "graph"], graphSeeds: ["seed-1", "seed-2"] }
  )

  assert.equal(outcomeWithGraph.status, "ok")
  assert.deepEqual(outcomeWithGraph.graphBudget, {
    seeds: ["seed-1", "seed-2"],
    hops: 1,
    candidates: 20,
  })
  assert.deepEqual(outcomeWithGraph.unselectedChannels, ["bm25", "pageIndex"])
})
