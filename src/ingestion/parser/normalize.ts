import { createHash } from "node:crypto"
import type {
  NormalizedBlock,
  NormalizedBlockType,
} from "../../types"

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

function isTableStart(lines: string[], index: number): boolean {
  return index + 1 < lines.length &&
    lines[index].includes("|") &&
    /^\s*\|?\s*:?-{3,}:?/.test(lines[index + 1])
}

function parseTableRow(line: string): string[] {
  let value = line.trim()
  if (value.startsWith("|")) value = value.slice(1)
  if (value.endsWith("|")) value = value.slice(0, -1)

  const cells: string[] = []
  let cell = ""
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\\" && value[index + 1] === "|") {
      cell += "|"
      index += 1
    } else if (value[index] === "|") {
      cells.push(cell.trim())
      cell = ""
    } else {
      cell += value[index]
    }
  }
  cells.push(cell.trim())
  return cells
}

export function normalizeMarkItDown(
  markdown: string,
  documentId: string
): NormalizedBlock[] {
  if (!markdown.trim() || markdown.includes("\0") || markdown.includes("\uFFFD")) {
    throw new Error("malformed MarkItDown output: expected valid non-empty UTF-8 Markdown")
  }

  const lines = markdown.replace(/\r\n?/g, "\n").split("\n")
  const blocks: NormalizedBlock[] = []
  const headings: Array<{ level: number; text: string }> = []

  const addBlock = (
    type: NormalizedBlockType,
    text: string,
    extras: Partial<NormalizedBlock> = {}
  ): void => {
    const normalizedText = text.trim()
    if (!normalizedText) {
      throw new Error("malformed MarkItDown output: block text cannot be empty")
    }
    const index = blocks.length
    blocks.push({
      id: blockId(documentId, index, type, normalizedText),
      index,
      type,
      text: normalizedText,
      sectionPath: headings.map(({ text }) => text),
      metadata: {},
      provenance: { parser: "markitdown", adapter: "cli" },
      ...extras,
    })
  }

  for (let index = 0; index < lines.length;) {
    const line = lines[index]
    if (!line.trim()) {
      index += 1
      continue
    }

    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (heading) {
      const level = heading[1].length
      const text = heading[2].trim()
      while (headings.at(-1)?.level && headings.at(-1)!.level >= level) {
        headings.pop()
      }
      headings.push({ level, text })
      addBlock("heading", text, {
        headingLevel: level,
        sectionPath: headings.map(({ text: headingText }) => headingText),
      })
      index += 1
      continue
    }

    const fence = /^```\s*([\w.+-]*)\s*$/.exec(line)
    if (fence) {
      const content: string[] = []
      index += 1
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        content.push(lines[index])
        index += 1
      }
      if (index >= lines.length) {
        throw new Error("malformed MarkItDown output: unclosed fenced code block")
      }
      addBlock("code", content.join("\n"), {
        metadata: fence[1] ? { language: fence[1] } : {},
      })
      index += 1
      continue
    }

    if (isTableStart(lines, index)) {
      const table: string[] = []
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        table.push(lines[index])
        index += 1
      }
      addBlock("table", table.join("\n"), {
        table: {
          headers: parseTableRow(table[0]),
          rows: table.slice(2).map(parseTableRow),
        },
      })
      continue
    }

    const paragraph: string[] = []
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^(#{1,6})\s+/.test(lines[index]) &&
      !/^```/.test(lines[index]) &&
      !isTableStart(lines, index)
    ) {
      paragraph.push(lines[index].trim())
      index += 1
    }
    addBlock("paragraph", paragraph.join("\n"))
  }

  if (blocks.length === 0) {
    throw new Error("malformed MarkItDown output: no normalized blocks")
  }
  return blocks
}
