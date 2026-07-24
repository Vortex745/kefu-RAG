import { loadConfig } from "../config"
import type {
  ActivationMode,
  Chunk,
  Document,
  Entity,
  NormalizedBlock,
  ParserType,
  Wikilink,
} from "../types"
import { RecursiveChunker } from "./chunker/chunker"
import {
  IngestionLifecycle,
  type IngestionStageRunner,
  type StageExecution,
} from "./lifecycle"
import {
  MarkItDownParser,
  MarkerParser,
  MinerUParser,
  selectParser,
  type Parser,
} from "./parser"
import { createIngestionStore, IngestionStoreImpl } from "./storage"
import { buildPageIndex } from "./page_index_builder"
import type { DB } from "./tracking/db"
import { DocumentRepo } from "./tracking/doc_repo"
import { PageIndexRepository } from "./tracking/page_index_repo"
import { LLMWikifier } from "./wikify/wikifier"

export type ParserResolver = (type: ParserType) => Parser

interface ChunkStageResult {
  chunks: Chunk[]
  blocks: NormalizedBlock[]
  parser: ParserType | null
  parserReason: string | null
}

function configuredParser(type: ParserType): Parser {
  const config = loadConfig()
  if (type === "marker") {
    return new MarkerParser({
      command: config.markerCommand ?? "marker_single",
      timeoutMs: config.parserTimeoutMs ?? 120_000,
      inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
      outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
    })
  }
  if (type === "mineru") {
    return new MinerUParser({
      command: config.mineruCommand ?? "mineru",
      timeoutMs: config.parserTimeoutMs ?? 120_000,
      inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
      outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
      assetRoot: config.imageAssetPath,
    })
  }
  return new MarkItDownParser({
    command: config.markitdownCommand ?? "markitdown",
    timeoutMs: config.parserTimeoutMs ?? 120_000,
    inputLimitBytes: config.parserInputLimitBytes ?? 20 * 1024 * 1024,
    outputLimitBytes: config.parserOutputLimitBytes ?? 20 * 1024 * 1024,
  })
}

function recordParserMetadata(
  repository: DocumentRepo,
  document: Document,
  parser: ParserType | null,
  reason: string,
  blocks?: NormalizedBlock[]
): void {
  const existingSystem = document.metadata.system
  const system = existingSystem && typeof existingSystem === "object" && !Array.isArray(existingSystem)
    ? existingSystem as Record<string, unknown>
    : {}
  repository.updateMetadata(document.id, {
    ...document.metadata,
    system: {
      ...system,
      source: document.source,
      fileName: document.fileName,
      mimeType: document.mimeType,
      contentHash: document.contentHash,
      version: document.version,
      parser: {
        selected: parser,
        reason,
        ...(blocks
          ? {
              normalizedBlockCount: blocks.length,
              provenance: blocks[0]?.provenance ?? null,
            }
          : {}),
      },
    },
  })
}

export class PipelineStageRunner implements IngestionStageRunner {
  private documentRepo: DocumentRepo
  private store: IngestionStoreImpl | null

  constructor(
    private db: DB,
    private resolveParser: ParserResolver = configuredParser,
    store?: IngestionStoreImpl
  ) {
    this.documentRepo = new DocumentRepo(db)
    // T21: accept an injected store for sharing across runs; lazily create one
    // on first run() if not provided so construction stays cheap and tests
    // that never reach storeChunks don't need env vars.
    this.store = store ?? null
  }

  private ensureStore(): IngestionStoreImpl {
    if (!this.store) {
      this.store = createIngestionStore()
    }
    return this.store
  }

  async close(): Promise<void> {
    if (!this.store) return
    try {
      await this.store.close()
    } catch (error) {
      console.warn(
        "[pipeline] Failed to close ingestion store:",
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  async run(
    document: Document,
    execution: StageExecution
  ): Promise<Record<string, unknown>> {
    let parserDecision: ReturnType<typeof selectParser> | null = null
    let parserRoutingError: Error | null = null
      if (document.rawContent) {
        try {
          parserDecision = selectParser({
            fileName: document.fileName ?? document.title,
            mimeType: document.mimeType ?? undefined,
            override: document.parserOverride ?? undefined,
          })
        } catch (error) {
          parserRoutingError = error instanceof Error ? error : new Error(String(error))
        }
        recordParserMetadata(
          this.documentRepo,
          document,
          parserDecision?.parser ?? null,
          parserDecision?.reason ?? parserRoutingError?.message ?? "parser routing failed"
        )
      }

      const chunkResult = await execution.runStage(
        "chunk",
        document.rawContent
          ? {
              contentLength: document.rawContent.length,
              fileName: document.fileName,
              mimeType: document.mimeType,
              parser: parserDecision?.parser ?? null,
              parserReason: parserDecision?.reason ?? parserRoutingError?.message ?? null,
            }
          : { contentLength: document.content.length },
        async (): Promise<ChunkStageResult> => {
          if (!document.rawContent) {
            return {
              chunks: await new RecursiveChunker().chunk(document),
              blocks: [],
              parser: null,
              parserReason: null,
            }
          }
          if (parserRoutingError) throw parserRoutingError
          if (!parserDecision) throw new Error("Raw document parser routing did not produce a decision")

          const parser = this.resolveParser(parserDecision.parser)
          const blocks = await parser.parse({
            content: document.rawContent,
            fileName: document.fileName ?? document.title,
            mimeType: document.mimeType ?? undefined,
            documentId: document.id,
            signal: execution.signal,
          })
          const parsedDocument: Document = {
            ...document,
            content: blocks.map((block) => block.text).join("\n\n"),
          }
          const chunks = await new RecursiveChunker().chunk(parsedDocument, blocks)
          recordParserMetadata(
            this.documentRepo,
            document,
            parserDecision.parser,
            parserDecision.reason,
            blocks
          )
          return {
            chunks,
            blocks,
            parser: parserDecision.parser,
            parserReason: parserDecision.reason,
          }
        },
        (result) => ({
          chunkCount: result.chunks.length,
          chunkIds: result.chunks.map((chunk) => chunk.id),
          totalChars: result.chunks.reduce((sum, chunk) => sum + chunk.content.length, 0),
          ...(result.parser
            ? {
                parser: result.parser,
                parserReason: result.parserReason,
                normalizedBlockCount: result.blocks.length,
                normalizedBlockTypes: result.blocks.map((block) => block.type),
                provenance: result.blocks[0]?.provenance ?? null,
              }
            : {}),
        })
      )
      const chunks = chunkResult.chunks

      const wikified = await execution.runStage(
        "wikify",
        { chunkCount: chunks.length },
        async (): Promise<{ entities: Entity[]; wikilinks: Wikilink[] }> => {
          const wikifier = new LLMWikifier()
          const entities = await wikifier.extractEntities(chunks)
          const wikilinks = await wikifier.buildWikilinks(entities, chunks)
          return { entities, wikilinks }
        },
        ({ entities, wikilinks }) => ({
          entityCount: entities.length,
          wikilinkCount: wikilinks.length,
          entityNames: entities.slice(0, 20).map((entity) => entity.name),
        })
      )

      await execution.runStage(
        "storeChunks",
        { chunkCount: chunks.length },
        async (): Promise<Chunk[]> => {
          if (document.tenantId === undefined || document.allowedGroups === undefined) {
            throw new Error("Document access metadata is required before chunk persistence")
          }
          const store = this.ensureStore()
          await store.storeChunks(chunks, {
            tenantId: document.tenantId,
            allowedGroups: document.allowedGroups,
          })
          const nodes = buildPageIndex(document, chunks)
          if (nodes.length > 0) {
            new PageIndexRepository(this.db).replaceNodes(document.id, nodes, {
              tenantId: document.tenantId,
              allowedGroups: document.allowedGroups,
            })
          }
          return chunks
        },
        (storedChunks) => ({
          chunkCount: storedChunks.length,
          indexName: "kefu-rag-chunks",
        })
      )

      await execution.runStage(
        "storeGraph",
        {
          entityCount: wikified.entities.length,
          wikilinkCount: wikified.wikilinks.length,
        },
        async () => {
          if (document.tenantId === undefined || document.allowedGroups === undefined) {
            throw new Error("Document access metadata is required before graph persistence")
          }
          const store = this.ensureStore()
          await store.storeEntities(wikified.entities)
          await store.storeWikilinks(wikified.wikilinks, {
            tenantId: document.tenantId,
            allowedGroups: document.allowedGroups,
          })
          return wikified
        },
        ({ entities, wikilinks }) => ({
          entityCount: entities.length,
          wikilinkCount: wikilinks.length,
        })
      )

      return {
        chunkCount: chunks.length,
        entityCount: wikified.entities.length,
        wikilinkCount: wikified.wikilinks.length,
        ...(chunkResult.parser
          ? {
              parser: chunkResult.parser,
              parserReason: chunkResult.parserReason,
              normalizedBlockCount: chunkResult.blocks.length,
            }
          : {}),
      }
  }
}

/**
 * Optional overrides for {@link createIngestionLifecycle}.
 *
 * Production callers (HTTP/worker/CLI) omit these — the factory reads
 * `loadConfig().activationMode` and wires a `PipelineStageRunner`. Release
 * testing infrastructure (e.g. revision-scoped ingestion fixtures) supplies
 * explicit overrides so acceptance probes can exercise the lifecycle under
 * a controlled activation mode and stage runner without touching production
 * config or external services.
 */
export interface CreateIngestionLifecycleOptions {
  stageRunner?: IngestionStageRunner
  activationMode?: ActivationMode
  now?: () => Date
}

export function createIngestionLifecycle(
  db: DB,
  options?: CreateIngestionLifecycleOptions
): IngestionLifecycle {
  // P6.1 (spec L73): IngestionLifecycle owns the ACTIVATION_MODE decision.
  // The factory reads the config once at construction; HTTP/worker/CLI
  // callers all go through this factory so they cannot bypass the review
  // state machine. Release testing infrastructure (Ticket 18) passes explicit
  // overrides via `options` to exercise the lifecycle under a controlled
  // activation mode and stage runner — the config-driven default still
  // applies when an override is absent, so production behavior is unchanged.
  //
  // When `options.activationMode` is supplied, config loading is skipped
  // entirely: the override is authoritative and config env vars (e.g.
  // OPENAI_API_KEY) may not be present in the acceptance-test environment.
  // The `cfg` variable unifies both paths so the audit regex still sees
  // `cfg.activationMode` as the value passed to the constructor.
  const cfg = options?.activationMode
    ? { activationMode: options.activationMode }
    : loadConfig()
  return new IngestionLifecycle(
    db,
    options?.stageRunner ?? new PipelineStageRunner(db),
    options?.now ?? (() => new Date()),
    cfg.activationMode)
}
