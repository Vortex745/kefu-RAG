import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, extname, join, relative, resolve } from "node:path"
import type { NormalizedBlock, NormalizedBlockType } from "../../types"
import { findBoundedArtifact } from "./artifacts"
import type { ParseDocumentInput } from "./markitdown"
import { runBoundedProcess } from "./process"

export interface MinerUParserOptions {
  command: string
  commandArgs?: string[]
  timeoutMs: number
  inputLimitBytes: number
  outputLimitBytes: number
  assetRoot?: string
}

type MinerUMethod = "auto" | "txt" | "ocr"

const AUXILIARY_TYPES = new Set([
  "aside_text",
  "footer",
  "header",
  "page_footnote",
  "page_number",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
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

function pageNumber(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error("malformed MinerU output: page_idx must be a non-negative integer")
  }
  return (value as number) + 1
}

function boundingBox(value: unknown): [number, number, number, number] | undefined {
  if (value === undefined) return undefined
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every(finiteNumber) ||
    value.some((coordinate) => coordinate < 0 || coordinate > 1000) ||
    value[2] < value[0] ||
    value[3] < value[1]
  ) {
    throw new Error("malformed MinerU output: bbox must be an ordered 0-1000 rectangle")
  }
  return value as [number, number, number, number]
}

function providerMetadata(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(value) ||
    (field === "text_format" && value !== "latex")
  ) {
    throw new Error(`malformed MinerU output: invalid ${field}`)
  }
  return value
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`malformed MinerU output: ${field} must be a string array`)
  }
  return value.map((item) => item.trim()).filter(Boolean)
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`malformed MinerU output: ${field} must be non-empty text`)
  }
  return value.trim()
}

function optionalText(value: unknown, field: string): string {
  if (value === undefined) return ""
  if (typeof value !== "string") {
    throw new Error(`malformed MinerU output: ${field} must be text`)
  }
  return value.trim()
}

function imageReference(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("malformed MinerU output: img_path must be a relative image path")
  }
  const normalized = value.replaceAll("\\", "/")
  if (!/^images(?:\/[A-Za-z0-9._-]+)+$/.test(normalized) || normalized.includes("..")) {
    throw new Error("malformed MinerU output: img_path must stay inside images")
  }
  return normalized
}

function optionalImageReference(value: unknown): string | undefined {
  if (value === undefined || (typeof value === "string" && !value.trim())) {
    return undefined
  }
  return imageReference(value)
}

export function normalizeMinerU(
  value: unknown,
  documentId: string,
  method: MinerUMethod = "ocr"
): NormalizedBlock[] {
  if (!Array.isArray(value)) {
    throw new Error("malformed MinerU output: expected a content-list array")
  }

  const blocks: NormalizedBlock[] = []
  const headings: Array<{ level: number; text: string }> = []

  for (const itemValue of value) {
    if (!isRecord(itemValue) || typeof itemValue.type !== "string") {
      throw new Error("malformed MinerU output: every item needs a type")
    }
    const page = pageNumber(itemValue.page_idx)
    const bbox = boundingBox(itemValue.bbox)
    const subType = providerMetadata(itemValue.sub_type, "sub_type")
    const textFormat = providerMetadata(itemValue.text_format, "text_format")
    if (AUXILIARY_TYPES.has(itemValue.type)) continue
    let type: NormalizedBlockType
    let text: string
    let headingLevel: number | undefined
    let table: Record<string, unknown> | undefined
    let image: Record<string, unknown> | undefined

    switch (itemValue.type) {
      case "text": {
        text = requiredText(itemValue.text, "text")
        const level = itemValue.text_level ?? 0
        if (!Number.isInteger(level) || (level as number) < 0 || (level as number) > 6) {
          throw new Error("malformed MinerU output: text_level must be between 0 and 6")
        }
        headingLevel = level === 0 ? undefined : level as number
        type = headingLevel ? "heading" : "paragraph"
        break
      }
      case "equation": {
        type = "equation"
        const equationText = optionalText(itemValue.text, "equation text")
        const sourceReference = optionalImageReference(itemValue.img_path)
        if (!equationText && !sourceReference) {
          throw new Error("malformed MinerU output: equation needs text or img_path")
        }
        text = equationText || `Equation on page ${page}`
        if (sourceReference) image = { sourceReference }
        break
      }
      case "table": {
        type = "table"
        const html = optionalText(itemValue.table_body, "table_body")
        const captions = stringList(itemValue.table_caption, "table_caption")
        const sourceReference = optionalImageReference(itemValue.img_path)
        if (!html && captions.length === 0 && !sourceReference) {
          throw new Error("malformed MinerU output: table needs content, caption, or img_path")
        }
        text = [...captions, html].filter(Boolean).join("\n") || `Table on page ${page}`
        table = {
          ...(html ? { html } : {}),
          ...(captions.length > 0 ? { captions } : {}),
          ...(sourceReference ? { sourceReference } : {}),
        }
        break
      }
      case "image":
      case "chart": {
        type = "image"
        const sourceReference = optionalImageReference(itemValue.img_path)
        const captionField = itemValue.type === "chart" ? "chart_caption" : "image_caption"
        const captions = stringList(itemValue[captionField], captionField)
        const analyzed = optionalText(itemValue.content, "content")
        if (!sourceReference && captions.length === 0 && !analyzed) {
          throw new Error("malformed MinerU output: image needs content, caption, or img_path")
        }
        text = [...captions, analyzed].filter(Boolean).join("\n") || `Image on page ${page}`
        image = {
          ...(sourceReference ? { sourceReference } : {}),
          captions,
        }
        break
      }
      case "code": {
        type = "code"
        const captions = stringList(itemValue.code_caption, "code_caption")
        text = [...captions, requiredText(itemValue.code_body, "code_body")].join("\n")
        break
      }
      case "list":
        type = "paragraph"
        text = stringList(itemValue.list_items, "list_items").join("\n")
        if (!text) throw new Error("malformed MinerU output: list_items cannot be empty")
        break
      default:
        throw new Error(`malformed MinerU output: unsupported type ${itemValue.type}`)
    }

    if (headingLevel) {
      while (headings.at(-1)?.level && headings.at(-1)!.level >= headingLevel) {
        headings.pop()
      }
      headings.push({ level: headingLevel, text })
    }
    const index = blocks.length
    blocks.push({
      id: blockId(documentId, index, type, text),
      index,
      type,
      text,
      ...(headingLevel ? { headingLevel } : {}),
      page,
      sectionPath: headings.map(({ text: headingText }) => headingText),
      ...(bbox ? { boundingBox: bbox } : {}),
      ...(table ? { table } : {}),
      ...(image && type === "image" ? { image } : {}),
      metadata: {
        mineruType: itemValue.type,
        method,
        ocr: method === "ocr",
        ...(subType ? { subType } : {}),
        ...(textFormat ? { textFormat } : {}),
        ...(image && type === "equation" ? { sourceReference: image.sourceReference } : {}),
      },
      provenance: { parser: "mineru", adapter: "cli" },
    })
  }

  if (blocks.length === 0) {
    throw new Error("malformed MinerU output: no normalized blocks")
  }
  return blocks
}

async function verifyImageReferences(
  artifact: string,
  blocks: NormalizedBlock[],
  assetRoot: string
): Promise<void> {
  const root = dirname(artifact)
  const references = blocks.flatMap((block) => [
    block.image?.sourceReference,
    block.table?.sourceReference,
    typeof block.metadata.sourceReference === "string"
      ? block.metadata.sourceReference
      : undefined,
  ]).filter((value): value is string => value !== undefined)

  for (const reference of new Set(references)) {
    const candidate = resolve(root, reference)
    const pathFromRoot = relative(root, candidate)
    if (pathFromRoot.startsWith("..") || pathFromRoot === "") {
      throw new Error("malformed MinerU output: referenced image does not exist")
    }
    try {
      if (!(await stat(candidate)).isFile()) throw new Error("not a file")
    } catch {
      throw new Error("malformed MinerU output: referenced image does not exist")
    }
  }

  for (const block of blocks) {
    const reference = block.image?.sourceReference
    if (typeof reference !== "string") continue
    const source = resolve(root, reference)
    const bytes = await readFile(source)
    const asset = await publishImageAsset(bytes, reference, assetRoot)
    block.image = {
      ...block.image,
      ...asset,
    }
  }
}

export async function publishImageAsset(
  bytes: Buffer,
  sourceReference: string,
  assetRoot: string
): Promise<{ assetId: string; assetPath: string }> {
  const digest = createHash("sha256").update(bytes).digest("hex")
  const extension = extname(sourceReference).toLowerCase()
  const assetPath = `${digest}${/^\.[a-z0-9]{1,10}$/.test(extension) ? extension : ".bin"}`
  const target = join(assetRoot, assetPath)
  const temporary = join(assetRoot, `.${assetPath}.${randomUUID()}.tmp`)
  await mkdir(assetRoot, { recursive: true })
  await writeFile(temporary, bytes, { flag: "wx" })
  try {
    try {
      await rename(temporary, target)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "EEXIST" && code !== "EPERM") throw error
      const existing = await readFile(target)
      const existingDigest = createHash("sha256").update(existing).digest("hex")
      if (existingDigest !== digest) {
        throw new Error("content-addressed image asset collision")
      }
    }
  } finally {
    await rm(temporary, { force: true })
  }
  return { assetId: `sha256:${digest}`, assetPath }
}

export class MinerUParser {
  readonly type = "mineru" as const

  constructor(private options: MinerUParserOptions) {}

  async parse(input: ParseDocumentInput): Promise<NormalizedBlock[]> {
    if (input.content.length > this.options.inputLimitBytes) {
      throw new Error(`MinerU input exceeded ${this.options.inputLimitBytes} bytes`)
    }

    const workspace = await mkdtemp(join(tmpdir(), "kefu-rag-mineru-"))
    const extension = extname(input.fileName).toLowerCase()
    const safeExtension = /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : ".bin"
    const sourcePath = join(workspace, `input${safeExtension}`)
    const outputPath = join(workspace, "output")
    try {
      await writeFile(sourcePath, input.content, { flag: "wx" })
      await runBoundedProcess({
        command: this.options.command,
        args: [
          ...(this.options.commandArgs ?? []),
          "-p",
          sourcePath,
          "-o",
          outputPath,
          "-m",
          "ocr",
          "-b",
          "pipeline",
          "-l",
          "ch",
        ],
        cwd: workspace,
        timeoutMs: this.options.timeoutMs,
        outputLimitBytes: this.options.outputLimitBytes,
        artifactLimit: { root: outputPath, bytes: this.options.outputLimitBytes },
        signal: input.signal,
      })
      const artifact = await findBoundedArtifact(
        outputPath,
        this.options.outputLimitBytes,
        "MinerU",
        (path) => basename(path).toLowerCase().endsWith("_content_list.json") &&
          !basename(path).toLowerCase().endsWith("_content_list_v2.json")
      )
      let parsed: unknown
      try {
        parsed = JSON.parse(await readFile(artifact, "utf8"))
      } catch (error) {
        throw new Error(
          `malformed MinerU output: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      const blocks = normalizeMinerU(parsed, input.documentId, "ocr")
      await verifyImageReferences(
        artifact,
        blocks,
        resolve(this.options.assetRoot ?? join(process.cwd(), "data", "image-assets"))
      )
      return blocks
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith("Parser executable is unavailable:")) {
        throw new Error(
          `MinerU executable is unavailable. Configure MINERU_COMMAND. ${message}`
        )
      }
      if (message.startsWith("Parser artifacts exceeded ")) {
        throw new Error(`MinerU output exceeded ${this.options.outputLimitBytes} bytes`)
      }
      throw new Error(`MinerU failed: ${message}`)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }
}
