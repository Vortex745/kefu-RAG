import assert from "node:assert/strict"
import test from "node:test"
import type OpenAI from "openai"
import type { Chunk, Entity } from "../../types"
import { v5 as uuid } from "uuid"
import { LLMWikifier } from "./wikifier"

function chunk(id: string, content: string): Chunk {
  return {
    id,
    documentId: "doc-v1",
    content,
    childrenIds: [],
    metadata: { kind: "child" },
  }
}

function wikifier(respond: (prompt: string, call: number) => unknown): {
  value: LLMWikifier
  prompts: string[]
} {
  const prompts: string[] = []
  const client = {
    chat: {
      completions: {
        create: async ({ messages }: { messages: Array<{ content: string }> }) => {
          const prompt = messages.at(-1)?.content ?? ""
          prompts.push(prompt)
          return {
            choices: [{ message: { content: JSON.stringify(respond(prompt, prompts.length)) } }],
          }
        },
      },
    },
  } as unknown as OpenAI
  const value = Object.create(LLMWikifier.prototype) as LLMWikifier
  Object.assign(value, { client, model: "test-model" })
  return { value, prompts }
}

test("entity extraction batches the complete document and merges canonical identities", async () => {
  const { value, prompts } = wikifier((_prompt, call) => call === 1
    ? { entities: [{ name: "Refund Policy", type: "Concept", aliases: ["Returns"] }] }
    : { entities: [
        { name: " refund policy ", type: "concept", aliases: ["Refunds"] },
        { name: "Late Entity", type: "Product", aliases: [] },
      ] })
  const entities = await value.extractEntities([
    chunk("chunk-first", `Refund Policy ${"x".repeat(8_100)}`),
    chunk("chunk-late", "Late Entity appears only at the end."),
  ])

  assert.equal(prompts.length, 2)
  assert.match(prompts[1], /Late Entity appears only at the end/)
  assert.equal(entities.length, 2)
  const refund = entities.find(({ name }) => name === "Refund Policy")!
  assert.deepEqual(refund.aliases.sort(), ["Refunds", "Returns"])
  assert.equal(entities.some(({ name }) => name === "Late Entity"), true)
})

test("entity identity uses locale-neutral canonical text", async () => {
  const { value } = wikifier(() => ({
    entities: [{ name: "IDENTITY", type: "CONCEPT", aliases: [] }],
  }))

  const entities = await value.extractEntities([chunk("chunk-identity", "IDENTITY")])

  assert.equal(
    entities[0].id,
    uuid("kefu-rag:entity:concept\0identity", uuid.URL)
  )
})

test("entity extraction merges names and aliases across batches", async () => {
  const { value } = wikifier((_prompt, call) => call === 1
    ? { entities: [{ name: "IBM", type: "organization", aliases: [] }] }
    : { entities: [{
        name: "International Business Machines",
        type: "organization",
        aliases: ["IBM"],
      }] })

  const entities = await value.extractEntities([
    chunk("chunk-first", `IBM ${"x".repeat(8_100)}`),
    chunk("chunk-late", "International Business Machines is also known as IBM."),
  ])

  assert.equal(entities.length, 1)
  assert.equal(entities[0].name, "International Business Machines")
  assert.deepEqual(entities[0].aliases, ["IBM"])
  assert.equal(
    entities[0].id,
    uuid("kefu-rag:entity:organization\0ibm", uuid.URL)
  )
})

test("entity bounds preserve candidates from later document batches", async () => {
  const { value } = wikifier((_prompt, call) => ({
    entities: call === 1
      ? Array.from({ length: 200 }, (_, index) => ({
          name: `Early Entity ${index}`,
          type: "concept",
          aliases: [],
        }))
      : [{ name: "Late Entity", type: "concept", aliases: [] }],
  }))

  const entities = await value.extractEntities([
    chunk("chunk-first", `Early entities ${"x".repeat(8_100)}`),
    chunk("chunk-late", "Late Entity appears only at the end."),
  ])

  assert.equal(entities.length, 200)
  assert.equal(entities.some(({ name }) => name === "Late Entity"), true)
})

test("Wikilinks preserve direction, wording, max weight, and source chunk provenance", async () => {
  const { value } = wikifier((prompt) => ({
    links: [{
      sourceEntityName: "Refund Policy",
      targetEntityName: "Customer",
      relation: "APPLIES_TO",
      weight: prompt.includes("chunk-late") ? 0.9 : 0.4,
      sourceChunkIds: [prompt.includes("chunk-late") ? "chunk-late" : "chunk-first"],
    }],
  }))
  const entities: Entity[] = [
    { id: "refund", name: "Refund Policy", type: "concept", aliases: [], metadata: {} },
    { id: "customer", name: "Customer", type: "role", aliases: [], metadata: {} },
  ]
  const links = await value.buildWikilinks(entities, [
    chunk("chunk-first", `Refund Policy applies to Customer. ${"x".repeat(4_100)}`),
    chunk("chunk-late", "Refund Policy also applies to Customer here."),
  ])

  assert.deepEqual(links, [{
    sourceEntityId: "refund",
    targetEntityId: "customer",
    relation: "APPLIES_TO",
    weight: 0.9,
    provenance: [
      { documentId: "doc-v1", chunkId: "chunk-first" },
      { documentId: "doc-v1", chunkId: "chunk-late" },
    ],
  }])
})

test("Wikilinks without valid source chunk provenance are rejected", async () => {
  const { value } = wikifier(() => ({
    links: [{
      sourceEntityName: "Refund Policy",
      targetEntityName: "Customer",
      relation: "APPLIES_TO",
      weight: 0.8,
      sourceChunkIds: ["missing-chunk"],
    }],
  }))
  const entities: Entity[] = [
    { id: "refund", name: "Refund Policy", type: "concept", aliases: [], metadata: {} },
    { id: "customer", name: "Customer", type: "role", aliases: [], metadata: {} },
  ]

  const links = await value.buildWikilinks(entities, [
    chunk("chunk-real", "Refund Policy applies to Customer."),
  ])

  assert.deepEqual(links, [])
})
