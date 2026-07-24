import { extname } from "node:path"
import type { ParserType } from "../../types"

const MARKITDOWN_EXTENSIONS = new Set([
  ".csv",
  ".doc",
  ".docx",
  ".epub",
  ".htm",
  ".html",
  ".json",
  ".md",
  ".markdown",
  ".ppt",
  ".pptx",
  ".rtf",
  ".txt",
  ".xls",
  ".xlsx",
  ".xml",
])

const MARKITDOWN_MIME_TYPES = new Set([
  "application/epub+zip",
  "application/json",
  "application/msword",
  "application/rtf",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/xml",
  "text/csv",
  "text/html",
  "text/markdown",
  "text/plain",
  "text/xml",
])

export interface ParserSelectionInput {
  fileName: string
  mimeType?: string
  override?: string
}

export interface ParserDecision {
  parser: ParserType
  reason: string
}

function parserOverride(value: string): ParserType {
  if (value === "markitdown" || value === "marker" || value === "mineru") {
    return value
  }
  throw new Error(
    `Unsupported parser override: ${value}. Expected markitdown, marker, or mineru.`
  )
}

export function selectParser(input: ParserSelectionInput): ParserDecision {
  if (input.override) {
    return { parser: parserOverride(input.override), reason: "explicit parser override" }
  }

  const extension = extname(input.fileName).toLowerCase()
  if (extension === ".pdf") {
    return { parser: "marker", reason: "PDF documents require layout-aware parsing" }
  }
  if ([".bmp", ".heic", ".jpeg", ".jpg", ".png", ".tif", ".tiff"].includes(extension)) {
    return { parser: "mineru", reason: "image documents require OCR-aware parsing" }
  }
  if (MARKITDOWN_EXTENSIONS.has(extension)) {
    return {
      parser: "markitdown",
      reason: `extension ${extension} is supported by MarkItDown`,
    }
  }

  const mimeType = input.mimeType?.split(";", 1)[0].trim().toLowerCase()
  if (mimeType === "application/pdf") {
    return { parser: "marker", reason: "PDF documents require layout-aware parsing" }
  }
  if (mimeType?.startsWith("image/")) {
    return { parser: "mineru", reason: "image documents require OCR-aware parsing" }
  }
  if (mimeType && MARKITDOWN_MIME_TYPES.has(mimeType)) {
    return {
      parser: "markitdown",
      reason: `MIME type ${mimeType} is supported by MarkItDown`,
    }
  }
  throw new Error(
    `No parser route for ${input.fileName}${mimeType ? ` (${mimeType})` : ""}`
  )
}
