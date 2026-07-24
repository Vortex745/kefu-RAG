import { v5 as uuid } from "uuid"
import type { Chunk, Entity, Wikilink } from "../../types"
import OpenAI from "openai"
import { loadConfig } from "../../config"

const ENTITY_EXTRACTION_PROMPT = `从以下文本中提取所有重要的实体（人物、组织、地点、概念、术语、产品等）。
以 JSON 数组格式返回，每个实体包含 name、type、aliases 字段。
仅返回 JSON，不要附加说明。

文本：
"""

{text}
"""`

const WIKILINK_PROMPT = `给定以下实体列表，找出它们之间的关联关系。
以 JSON 数组格式返回，每个关联包含 sourceEntityName、targetEntityName、relation、weight(0-1)、sourceChunkIds。
仅返回 JSON，不要附加说明。

实体：
{entities}

文本上下文：
"""
{context}
"""`

export class LLMWikifier {
  private client: OpenAI
  private model: string

  constructor() {
    const cfg = loadConfig()
    this.client = new OpenAI({ apiKey: cfg.openaiApiKey, baseURL: cfg.openaiBaseUrl || undefined })
    this.model = cfg.openaiChatModel
  }

  async extractEntities(chunks: Chunk[]): Promise<Entity[]> {
    const batches: EntityCandidate[][] = []
    for (const batch of chunkBatches(chunks, 8_000)) {
      const res = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: "You are a precise entity extractor." },
          {
            role: "user",
            content: ENTITY_EXTRACTION_PROMPT.replace("{text}", batchContext(batch)),
          },
        ],
        temperature: 0,
        response_format: { type: "json_object" },
      })
      const parsed = JSON.parse(res.choices[0]?.message?.content || "{}")
      const values = Array.isArray(parsed) ? parsed : parsed.entities
      batches.push(Array.isArray(values)
        ? values.flatMap(parseEntityCandidate).slice(0, 200)
        : [])
    }
    return mergeEntityCandidates(roundRobin(batches)).slice(0, 200)
  }

  async buildWikilinks(entities: Entity[], chunks: Chunk[]): Promise<Wikilink[]> {
    if (entities.length < 2) return []

    const byName = new Map<string, Entity>()
    for (const entity of entities) {
      byName.set(canonical(entity.name), entity)
      for (const alias of entity.aliases) byName.set(canonical(alias), entity)
    }
    const merged = new Map<string, Wikilink>()
    for (const batch of chunkBatches(chunks, 4_000)) {
      const context = batchContext(batch)
      const canonicalContext = context.toLowerCase()
      const mentioned = entities.filter((entity) =>
        [entity.name, ...entity.aliases].some((name) =>
          canonicalContext.includes(name.toLowerCase())
        )
      ).slice(0, 50)
      if (mentioned.length < 2) continue
      const entityList = mentioned.map((entity) => `- ${entity.name} (${entity.type})`).join("\n")
      const res = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: "You identify relationships between entities." },
          {
            role: "user",
            content: WIKILINK_PROMPT
              .replace("{entities}", entityList)
              .replace("{context}", context),
          },
        ],
        temperature: 0,
        response_format: { type: "json_object" },
      })
      const parsed = JSON.parse(res.choices[0]?.message?.content || "{}")
      const values = Array.isArray(parsed)
        ? parsed
        : parsed.links ?? parsed.relationships
      if (!Array.isArray(values)) continue
      const batchById = new Map(batch.map((chunk) => [chunk.id, chunk]))
      for (const value of values) {
        if (!isRecord(value)) continue
        const source = typeof value.sourceEntityName === "string"
          ? byName.get(canonical(value.sourceEntityName))
          : undefined
        const target = typeof value.targetEntityName === "string"
          ? byName.get(canonical(value.targetEntityName))
          : undefined
        if (!source || !target || source.id === target.id) continue
        const relation = typeof value.relation === "string" && value.relation.trim()
          ? value.relation.trim().slice(0, 128)
          : "related_to"
        const weight = typeof value.weight === "number" && Number.isFinite(value.weight)
          ? Math.max(0, Math.min(1, value.weight))
          : 0.5
        const selectedIds = Array.isArray(value.sourceChunkIds)
          ? value.sourceChunkIds.filter((id): id is string =>
              typeof id === "string" && batchById.has(id)
            )
          : []
        if (selectedIds.length === 0) continue
        const provenance = selectedIds.map((id) => batchById.get(id)!)
          .map((chunk) => ({ documentId: chunk.documentId, chunkId: chunk.id }))
        const key = `${source.id}\0${target.id}\0${relation}`
        const existing = merged.get(key)
        if (existing) {
          existing.weight = Math.max(existing.weight, weight)
          existing.provenance = mergeProvenance(existing.provenance ?? [], provenance)
        } else if (merged.size < 500) {
          merged.set(key, {
            sourceEntityId: source.id,
            targetEntityId: target.id,
            relation,
            weight,
            provenance: mergeProvenance([], provenance),
          })
        }
      }
    }
    return [...merged.values()]
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

interface EntityCandidate {
  type: string
  names: string[]
}

function parseEntityCandidate(value: unknown): EntityCandidate[] {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim()) return []
  const name = value.name.trim()
  const type = typeof value.type === "string" && value.type.trim()
    ? value.type.trim().toLowerCase()
    : "concept"
  const aliases = Array.isArray(value.aliases)
    ? value.aliases.filter((item): item is string =>
        typeof item === "string" && !!item.trim()
      ).map((item) => item.trim())
    : []
  return [{ type, names: mergeStrings([name], aliases) }]
}

function roundRobin<T>(groups: T[][]): T[] {
  const values: T[] = []
  const maxLength = Math.max(0, ...groups.map(({ length }) => length))
  for (let index = 0; index < maxLength; index += 1) {
    for (const group of groups) {
      if (group[index] !== undefined) values.push(group[index])
    }
  }
  return values
}

function mergeEntityCandidates(candidates: EntityCandidate[]): Entity[] {
  const groups: Array<{ type: string; names: string[]; order: number }> = []
  candidates.forEach((candidate, order) => {
    const identities = new Set(candidate.names.map(canonical))
    const matches = groups.filter((group) =>
      group.type === candidate.type && group.names.some((name) => identities.has(canonical(name)))
    )
    const names = mergeStrings(
      candidate.names,
      matches.flatMap((group) => group.names)
    )
    const firstOrder = Math.min(order, ...matches.map((group) => group.order))
    for (const match of matches) groups.splice(groups.indexOf(match), 1)
    groups.push({ type: candidate.type, names, order: firstOrder })
  })
  return groups.sort((left, right) => left.order - right.order).map(({ type, names }) => {
    const name = [...names].sort((left, right) =>
      right.length - left.length || canonical(left).localeCompare(canonical(right))
    )[0]
    const identity = names.map(canonical).sort()[0]
    return {
      id: uuid(`kefu-rag:entity:${type}\0${identity}`, uuid.URL),
      name,
      type,
      aliases: names.filter((value) => canonical(value) !== canonical(name)),
      metadata: {},
    }
  })
}

function canonical(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase()
}

function mergeStrings(left: string[], right: string[]): string[] {
  return [...new Map([...left, ...right].map((value) => [canonical(value), value])).values()]
}

function chunkBatches(chunks: Chunk[], limit: number): Chunk[][] {
  const passages = chunks.filter(({ metadata }) => metadata.kind !== "parent")
  const batches: Chunk[][] = []
  let batch: Chunk[] = []
  let length = 0
  for (const chunk of passages) {
    if (batch.length > 0 && length + chunk.content.length > limit) {
      batches.push(batch)
      batch = []
      length = 0
    }
    batch.push(chunk)
    length += chunk.content.length
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}

function batchContext(chunks: Chunk[]): string {
  return chunks.map((chunk) => `[chunk:${chunk.id}]\n${chunk.content}`).join("\n\n")
}

function mergeProvenance(
  left: NonNullable<Wikilink["provenance"]>,
  right: NonNullable<Wikilink["provenance"]>
): NonNullable<Wikilink["provenance"]> {
  return [...new Map([...left, ...right].map((item) => [
    `${item.documentId}\0${item.chunkId}`,
    item,
  ])).values()]
}
