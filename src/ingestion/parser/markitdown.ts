import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { extname, join } from "node:path"
import type { NormalizedBlock } from "../../types"
import { normalizeMarkItDown } from "./normalize"
import { runBoundedProcess } from "./process"

export interface ParseDocumentInput {
  content: Buffer
  fileName: string
  mimeType?: string
  documentId: string
  signal?: AbortSignal
}

export interface MarkItDownParserOptions {
  command: string
  commandArgs?: string[]
  timeoutMs: number
  inputLimitBytes: number
  outputLimitBytes: number
}

export class MarkItDownParser {
  readonly type = "markitdown" as const

  constructor(private options: MarkItDownParserOptions) {}

  async parse(input: ParseDocumentInput): Promise<NormalizedBlock[]> {
    if (input.content.length > this.options.inputLimitBytes) {
      throw new Error(
        `MarkItDown input exceeded ${this.options.inputLimitBytes} bytes`
      )
    }

    const workspace = await mkdtemp(join(tmpdir(), "kefu-rag-markitdown-"))
    const sourcePath = join(workspace, `input${this.safeExtension(input.fileName)}`)
    try {
      await writeFile(sourcePath, input.content, { flag: "wx" })
      const markdown = await runBoundedProcess({
        command: this.options.command,
        args: [...(this.options.commandArgs ?? []), sourcePath],
        cwd: workspace,
        timeoutMs: this.options.timeoutMs,
        outputLimitBytes: this.options.outputLimitBytes,
        signal: input.signal,
      })
      return normalizeMarkItDown(markdown, input.documentId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith("Parser executable is unavailable:")) {
        throw new Error(
          `MarkItDown executable is unavailable. Configure MARKITDOWN_COMMAND. ${message}`
        )
      }
      throw new Error(`MarkItDown failed: ${message}`)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }

  private safeExtension(fileName: string): string {
    const extension = extname(fileName).toLowerCase()
    return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : ".bin"
  }
}
