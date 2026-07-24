import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import type { NormalizedBlock, NormalizedBlockType } from "../../types"
import { findBoundedArtifact } from "./artifacts"
import type { ParseDocumentInput } from "./markitdown"
import { runBoundedProcess } from "./process"

export interface MarkerParserOptions {
  command: string
  commandArgs?: string[]
  timeoutMs: number
  inputLimitBytes: number
  outputLimitBytes: number
}

interface MarkerNode {
  id?: unknown
  block_type?: unknown
  html?: unknown
  bbox?: unknown
  polygon?: unknown
  children?: unknown
  section_hierarchy?: unknown
  images?: unknown
  [key: string]: unknown
}

function blockId(
  documentId: string,
  index: number,
  type: NormalizedBlockType,
  text: string
): string {
  return createHash("sha256")
    .update(`${documentId}\0${index}\0${type}\0${text}`, "utf8")
    .digest("hex")
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function boundingBox(value: unknown): [number, number, number, number] | undefined {
  if (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every(finiteNumber)
  ) {
    return value as [number, number, number, number]
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

const MARKER_BLOCK_TYPES = new Set([
  "Caption",
  "Char",
  "Code",
  "ComplexRegion",
  "Equation",
  "Figure",
  "FigureGroup",
  "Footnote",
  "Form",
  "Handwriting",
  "Line",
  "ListGroup",
  "ListItem",
  "Page",
  "PageFooter",
  "PageHeader",
  "Picture",
  "PictureGroup",
  "Reference",
  "SectionHeader",
  "Span",
  "Table",
  "TableCell",
  "TableGroup",
  "TableOfContents",
  "Text",
  "TextInlineMath",
])

function markerPage(id: string, blockType: string): number {
  if (!MARKER_BLOCK_TYPES.has(blockType)) {
    throw new Error(`malformed Marker output: unsupported block type ${blockType}`)
  }
  const match = /^\/page\/(\d+)(?:\/([A-Za-z][A-Za-z0-9]*)\/(\d+))?$/.exec(id)
  if (!match) {
    throw new Error("malformed Marker output: invalid block id")
  }
  if ((match[2] && match[2] !== blockType) || (!match[2] && blockType !== "Page")) {
    throw new Error("malformed Marker output: block id and block_type do not match")
  }
  return Number(match[1]) + 1
}

function validatePolygon(value: unknown): void {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every((point) =>
      Array.isArray(point) && point.length === 2 && point.every(finiteNumber)
    )
  ) {
    throw new Error("malformed Marker output: polygon must contain four finite points")
  }
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  }
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(code.slice(2), 16))
    }
    if (code.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(code.slice(1), 10))
    }
    return named[code.toLowerCase()] ?? entity
  })
}

function htmlText(html: string): string {
  return decodeHtml(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/td\s*>/gi, " | ")
      .replace(/<\/(?:p|div|li|h[1-6]|tr)\s*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function headingLevel(node: MarkerNode, id: string, html: string): number {
  const htmlHeading = /<h([1-6])(?:\s|>)/i.exec(html)
  if (htmlHeading) return Number(htmlHeading[1])
  if (isRecord(node.section_hierarchy)) {
    for (const [level, headingId] of Object.entries(node.section_hierarchy)) {
      if (headingId === id && /^[1-6]$/.test(level)) return Number(level)
    }
  }
  return 1
}

function sectionHierarchy(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) {
    throw new Error("malformed Marker output: section_hierarchy must be an object")
  }
  const hierarchy: Record<string, string> = {}
  for (const [level, id] of Object.entries(value)) {
    if (!/^[1-6]$/.test(level) || typeof id !== "string") {
      throw new Error("malformed Marker output: invalid section_hierarchy entry")
    }
    hierarchy[level] = id
  }
  return hierarchy
}

function markerType(blockType: string): NormalizedBlockType {
  const normalized = blockType.toLowerCase()
  if (normalized.includes("sectionheader") || normalized.includes("heading")) {
    return "heading"
  }
  if (normalized.includes("equation") || normalized.includes("formula")) {
    return "equation"
  }
  if (normalized.includes("table")) return "table"
  if (normalized.includes("code")) return "code"
  if (normalized.includes("picture") || normalized.includes("image") || normalized.includes("figure")) {
    return "image"
  }
  return "paragraph"
}

export function normalizeMarker(
  value: unknown,
  documentId: string
): NormalizedBlock[] {
  if (!isRecord(value)) {
    throw new Error("malformed Marker output: expected a JSON object")
  }
  if (value.block_type !== "Document" || !isRecord(value.metadata) || !Array.isArray(value.children)) {
    throw new Error("malformed Marker output: expected a Document root")
  }

  const blocks: NormalizedBlock[] = []
  const headings: Array<{ level: number; text: string }> = []
  const headingTextById = new Map<string, string>()

  const visit = (nodeValue: unknown): void => {
    if (!isRecord(nodeValue)) {
      throw new Error("malformed Marker output: block must be an object")
    }
    const node = nodeValue as MarkerNode
    if (
      typeof node.id !== "string" ||
      typeof node.block_type !== "string" ||
      typeof node.html !== "string" ||
      !boundingBox(node.bbox)
    ) {
      throw new Error("malformed Marker output: block is missing required fields")
    }
    validatePolygon(node.polygon)
    const hierarchy = sectionHierarchy(node.section_hierarchy)
    if (node.images !== undefined && node.images !== null && !isRecord(node.images)) {
      throw new Error("malformed Marker output: images must be an object")
    }
    if (node.children !== null && !Array.isArray(node.children)) {
      throw new Error("malformed Marker output: children must be null or an array")
    }
    const blockType = node.block_type
    const page = markerPage(node.id, blockType)

    if (Array.isArray(node.children) && node.children.length > 0) {
      for (const child of node.children) visit(child)
      return
    }

    const type = markerType(blockType)
    const html = node.html.trim()
    const content = htmlText(html)
    if (content) {
      const level = headingLevel(node, node.id, html)
      if (type === "heading") {
        while (headings.at(-1)?.level && headings.at(-1)!.level >= level) {
          headings.pop()
        }
        headings.push({ level, text: content })
        headingTextById.set(node.id, content)
      }

      const index = blocks.length
      const hierarchyPath = Object.entries(hierarchy)
        .sort(([left], [right]) => Number(left) - Number(right))
        .map(([, headingId]) => headingTextById.get(headingId))
        .filter((heading): heading is string => !!heading)
      blocks.push({
        id: blockId(documentId, index, type, content),
        index,
        type,
        text: content,
        ...(type === "heading" ? { headingLevel: level } : {}),
        page,
        sectionPath: hierarchyPath.length > 0
          ? hierarchyPath
          : headings.map(({ text: headingText }) => headingText),
        boundingBox: boundingBox(node.bbox),
        ...(type === "table" ? { table: { html } } : {}),
        ...(type === "image"
          ? {
              image: {
                referenceCount: isRecord(node.images) ? Object.keys(node.images).length : 0,
              },
            }
          : {}),
        metadata: {
          markerBlockId: node.id,
          markerBlockType: blockType,
        },
        provenance: { parser: "marker", adapter: "cli" },
      })
    }
  }

  for (const child of value.children) {
    if (!isRecord(child) || child.block_type !== "Page") {
      throw new Error("malformed Marker output: Document children must be Page blocks")
    }
    visit(child)
  }
  if (blocks.length === 0) {
    throw new Error("malformed Marker output: no normalized blocks")
  }
  return blocks
}

export class MarkerParser {
  readonly type = "marker" as const

  constructor(private options: MarkerParserOptions) {}

  async parse(input: ParseDocumentInput): Promise<NormalizedBlock[]> {
    if (input.content.length > this.options.inputLimitBytes) {
      throw new Error(`Marker input exceeded ${this.options.inputLimitBytes} bytes`)
    }

    const workspace = await mkdtemp(join(tmpdir(), "kefu-rag-marker-"))
    const sourcePath = join(workspace, "input.pdf")
    const outputPath = join(workspace, "output")
    try {
      await writeFile(sourcePath, input.content, { flag: "wx" })
      await runBoundedProcess({
        command: this.options.command,
        args: [
          ...(this.options.commandArgs ?? []),
          sourcePath,
          "--output_dir",
          outputPath,
          "--output_format",
          "json",
        ],
        cwd: workspace,
        timeoutMs: this.options.timeoutMs,
        outputLimitBytes: this.options.outputLimitBytes,
        artifactLimit: {
          root: outputPath,
          bytes: this.options.outputLimitBytes,
        },
        signal: input.signal,
      })
      const artifact = await findBoundedArtifact(
        outputPath,
        this.options.outputLimitBytes,
        "Marker",
        (path) => path.toLowerCase().endsWith(".json"),
        (path) => basename(path).toLowerCase() === "input.json"
      )
      let parsed: unknown
      try {
        parsed = JSON.parse(await readFile(artifact, "utf8"))
      } catch (error) {
        throw new Error(
          `malformed Marker output: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      return normalizeMarker(parsed, input.documentId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith("Parser executable is unavailable:")) {
        throw new Error(
          `Marker executable is unavailable. Configure MARKER_COMMAND. ${message}`
        )
      }
      if (message.startsWith("Parser artifacts exceeded ")) {
        throw new Error(`Marker output exceeded ${this.options.outputLimitBytes} bytes`)
      }
      throw new Error(`Marker failed: ${message}`)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }
}
