import { v5 as uuid } from "uuid"
import type { Document, Chunk, NormalizedBlock } from "../../types"

const MAX_CHUNK_SIZE = 1500
const MAX_CHILD_CHUNK_SIZE = 750
const MIN_CHUNK_SIZE = 200
const SEMANTIC_SIMILARITY_THRESHOLD = 0.15

export class RecursiveChunker {
  async chunk(doc: Document, blocks?: NormalizedBlock[]): Promise<Chunk[]> {
    if (blocks) return this.chunkBlocks(doc, blocks)

    const segments = this.split(doc.content)
    return segments.map((text, i) => ({
      id: uuid(`kefu-rag:chunk:${doc.id}:child:${doc.content}:${i}:${text}`, uuid.URL),
      documentId: doc.id,
      content: text,
      childrenIds: [],
      metadata: {
        kind: "child",
        index: i,
        title: doc.title,
        source: doc.source,
        sourceId: doc.sourceId,
        documentVersion: doc.version,
      },
    }))
  }

  private chunkBlocks(doc: Document, blocks: NormalizedBlock[]): Chunk[] {
    const sourceContent = blocks.map(({ text }) => text).join("\n\n")
    const groups: NormalizedBlock[][] = []

    for (const block of blocks) {
      const current = groups.at(-1)
      if (!current || this.sectionKey(current[0]) !== this.sectionKey(block)) {
        groups.push([block])
      } else {
        current.push(block)
      }
    }

    const chunks: Chunk[] = []
    const emittedStructure = new Set<string>()
    let childIndex = 0

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const group = groups[groupIndex]
      const sectionPath = group[0].sectionPath
      const parentContent = group.map(({ text }) => text).join("\n\n")
      const parentId = uuid(
        `kefu-rag:chunk:${doc.id}:parent:${groupIndex}:${sourceContent}:${this.sectionKey(group[0])}:${parentContent}`,
        uuid.URL
      )
      const textRuns: NormalizedBlock[][] = []
      let textRun: NormalizedBlock[] = []
      for (const block of group) {
        if (block.type === "image") {
          if (textRun.length > 0) textRuns.push(textRun)
          textRun = []
        } else {
          textRun.push(block)
        }
      }
      if (textRun.length > 0) textRuns.push(textRun)
      const children = textRuns.flatMap((run) => this.splitBlocks(run))
        .map(({ text, blocks: segmentBlocks }) => {
        const index = childIndex
        childIndex += 1
        return {
          id: uuid(`kefu-rag:chunk:${doc.id}:child:${sourceContent}:${index}:${text}`, uuid.URL),
          documentId: doc.id,
          content: text,
          parentId,
          childrenIds: [],
          metadata: {
            kind: "child",
            index,
            title: doc.title,
            source: doc.source,
            sourceId: doc.sourceId,
            documentVersion: doc.version,
            sectionPath,
            normalizedBlocks: segmentBlocks.map((block) => {
              const continuation = emittedStructure.has(block.id)
              emittedStructure.add(block.id)
              return {
                id: block.id,
                index: block.index,
                type: block.type,
                headingLevel: block.headingLevel,
                page: block.page,
                sectionPath: block.sectionPath,
                boundingBox: block.boundingBox,
                metadata: block.metadata,
                provenance: block.provenance,
                ...(continuation
                  ? { continuation: true }
                  : { table: block.table, image: block.image }),
              }
            }),
          },
        } satisfies Chunk
      })

      const imageChildren = group.flatMap((block, blockIndex) => {
        if (block.type !== "image") return []
        const previous = [...group.slice(0, blockIndex)]
          .reverse()
          .find(({ type }) => type !== "image")
        const next = group.slice(blockIndex + 1).find(({ type }) => type !== "image")
        const nearbyText = [previous?.text, block.text, next?.text]
          .filter((value): value is string => !!value)
          .map((value) => value.slice(0, MAX_CHILD_CHUNK_SIZE / 2))
          .join("\n\n")
        const image = block.image ?? {}
        const assetIdentity = typeof image.assetId === "string"
          ? image.assetId
          : `metadata:${block.id}`
        const id = uuid(
          `kefu-rag:chunk:${doc.id}:image:${block.index}:${assetIdentity}:${block.text}`,
          uuid.URL
        )
        return [{
          id,
          documentId: doc.id,
          content: nearbyText,
          parentId,
          childrenIds: [],
          metadata: {
            kind: "image",
            index: block.index,
            title: doc.title,
            source: doc.source,
            sourceId: doc.sourceId,
            documentVersion: doc.version,
            page: block.page,
            sectionPath: block.sectionPath,
            image,
            assetStatus: typeof image.assetId === "string"
              ? "available"
              : "metadata_only",
            normalizedBlocks: [{
              id: block.id,
              index: block.index,
              type: block.type,
              page: block.page,
              sectionPath: block.sectionPath,
              boundingBox: block.boundingBox,
              image,
              metadata: block.metadata,
              provenance: block.provenance,
            }],
          },
        } satisfies Chunk]
      })

      const orderedChildren = [...children, ...imageChildren].sort((left, right) => {
        const leftIndex = left.metadata.kind === "image"
          ? left.metadata.index as number
          : ((left.metadata.normalizedBlocks as Array<{ index: number }>)[0]?.index ?? 0)
        const rightIndex = right.metadata.kind === "image"
          ? right.metadata.index as number
          : ((right.metadata.normalizedBlocks as Array<{ index: number }>)[0]?.index ?? 0)
        return leftIndex - rightIndex
      })

      chunks.push(...orderedChildren, {
        id: parentId,
        documentId: doc.id,
        content: parentContent,
        childrenIds: orderedChildren.map(({ id }) => id),
        metadata: {
          kind: "parent",
          title: doc.title,
          source: doc.source,
          sourceId: doc.sourceId,
          documentVersion: doc.version,
          sectionPath,
          normalizedBlocks: [],
        },
      })
    }

    return chunks
  }

  private sectionKey(block: NormalizedBlock): string {
    return JSON.stringify(block.sectionPath)
  }

  private splitBlocks(blocks: NormalizedBlock[]): Array<{
    text: string
    blocks: NormalizedBlock[]
  }> {
    const result: Array<{ text: string; blocks: NormalizedBlock[] }> = []
    let text = ""
    let included: NormalizedBlock[] = []
    let lastBlockId: string | null = null
    let lastBlockText = ""

    const flush = (): void => {
      if (!text) return
      result.push({ text, blocks: included })
      text = ""
      included = []
      lastBlockId = null
      lastBlockText = ""
    }

    for (const block of blocks) {
      for (const piece of this.splitLongText(block.text)) {
        let separator = text && lastBlockId !== block.id ? "\n\n" : ""
        const semanticBreak = text.length >= MIN_CHUNK_SIZE
          && lastBlockId !== block.id
          && this.embeddingSimilarity(lastBlockText, block.text)
            < SEMANTIC_SIMILARITY_THRESHOLD
        if (semanticBreak
          || text.length + separator.length + piece.length > MAX_CHILD_CHUNK_SIZE) {
          flush()
          separator = ""
        }
        text += separator + piece
        if (!included.some(({ id }) => id === block.id)) included.push(block)
        lastBlockId = block.id
        lastBlockText = block.text
      }
    }
    flush()
    return result
  }

  private splitLongText(text: string): string[] {
    const pieces: string[] = []
    let offset = 0
    while (offset < text.length) {
      const remaining = text.length - offset
      if (remaining <= MAX_CHILD_CHUNK_SIZE) {
        pieces.push(text.slice(offset))
        break
      }

      const targetWindow = text.slice(offset, offset + MAX_CHILD_CHUNK_SIZE)
      let length = this.safeBoundary(targetWindow)
      if (length === 0) {
        const hardWindow = text.slice(offset, offset + MAX_CHUNK_SIZE)
        length = this.safeBoundary(hardWindow)
      }
      if (length === 0) {
        if (remaining <= MAX_CHUNK_SIZE) {
          pieces.push(text.slice(offset))
          break
        }
        throw new Error(
          `Normalized block exceeds ${MAX_CHUNK_SIZE} characters without a safe semantic boundary`
        )
      }
      pieces.push(text.slice(offset, offset + length))
      offset += length
    }
    return pieces
  }

  private safeBoundary(text: string): number {
    const boundaries = ["\n\n", "\n", "。", "！", "？", ". ", "! ", "? ", " ", "\t"]
    let length = 0
    for (const boundary of boundaries) {
      const index = text.lastIndexOf(boundary)
      if (index >= MIN_CHUNK_SIZE) {
        length = Math.max(length, index + boundary.length)
      }
    }
    return length
  }

  private embeddingSimilarity(left: string, right: string): number {
    const leftVector = this.textEmbedding(left)
    const rightVector = this.textEmbedding(right)
    let dot = 0
    let leftMagnitude = 0
    let rightMagnitude = 0

    for (const value of leftVector.values()) leftMagnitude += value * value
    for (const [token, value] of rightVector) {
      dot += (leftVector.get(token) ?? 0) * value
      rightMagnitude += value * value
    }
    if (leftMagnitude === 0 || rightMagnitude === 0) return 0
    return dot / Math.sqrt(leftMagnitude * rightMagnitude)
  }

  private textEmbedding(text: string): Map<string, number> {
    const vector = new Map<string, number>()
    const words = text.toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
    for (const word of words) {
      const tokens = word.length < 3
        ? [word]
        : Array.from({ length: word.length - 1 }, (_, index) =>
            word.slice(index, index + 2)
          )
      for (const token of tokens) {
        vector.set(token, (vector.get(token) ?? 0) + 1)
      }
    }
    return vector
  }

  private split(text: string): string[] {
    const paragraphs = text.split(/\n\s*\n/)
    const chunks: string[] = []
    let buffer = ""

    for (const p of paragraphs) {
      const trimmed = p.trim()
      if (!trimmed) continue

      if (buffer.length + trimmed.length > MAX_CHUNK_SIZE) {
        if (buffer) chunks.push(buffer.trim())
        buffer = trimmed.length > MAX_CHUNK_SIZE
          ? trimmed.slice(0, MAX_CHUNK_SIZE)
          : trimmed
      } else {
        buffer += (buffer ? "\n\n" : "") + trimmed
      }
    }
    if (buffer) chunks.push(buffer.trim())

    return this.mergeSmall(chunks)
  }

  private mergeSmall(chunks: string[]): string[] {
    const result: string[] = []
    for (const c of chunks) {
      if (result.length > 0 && result[result.length - 1].length < MIN_CHUNK_SIZE) {
        result[result.length - 1] += "\n\n" + c
      } else {
        result.push(c)
      }
    }
    return result
  }
}
