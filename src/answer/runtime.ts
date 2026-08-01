import { Client } from "@elastic/elasticsearch"
import neo4j from "neo4j-driver"
import OpenAI from "openai"
import { type AppConfig, loadConfig } from "../config"
import {
  createProcessRuntime,
  type ProcessRuntime,
  type RuntimeClientFactory,
} from "../runtime/process_runtime"
import {
  NoopLangfuseExporter,
  createLangfuseExporter,
  type LangfuseClient,
  type LangfuseConfig,
  type LangfuseExporter,
} from "./langfuse_exporter"
import { AnswerTraceRepository } from "./trace_repository"

export interface AnswerClientFactory {
  createChatClient(options: {
    apiKey: string
    baseURL?: string
    timeout?: number
    maxRetries?: number
  }): OpenAI
  createEmbeddingClient(options: {
    apiKey: string
    baseURL?: string
    timeout?: number
    maxRetries?: number
  }): OpenAI
  createElasticsearchClient(options: { node: string; apiKey?: string }): Client
  createNeo4jDriver?(options: {
    uri: string
    user: string
    password: string
  }): import("neo4j-driver").Driver
}

const defaultClientFactory: AnswerClientFactory = {
  createChatClient: (options) => new OpenAI(options),
  createEmbeddingClient: (options) => new OpenAI(options),
  createElasticsearchClient: ({ node, apiKey }) => new Client({
    node,
    ...(apiKey ? { auth: { apiKey } } : {}),
    // ES client v9 ↔ server v8/v7 compat: pin media-type headers to
    // compatible-with=8 (mirrors process_runtime.ts + store.ts). Without
    // this, the worker's knowledge-retrieval ES queries fail with
    // media_type_header_exception, breaking the entire chat SSE flow.
    headers: {
      accept: "application/vnd.elasticsearch+json; compatible-with=8",
      "content-type": "application/vnd.elasticsearch+json; compatible-with=8",
    },
  }),
}

export class AnswerRuntime {
  readonly traceRepository: AnswerTraceRepository
  readonly langfuseExporter: LangfuseExporter

  constructor(
    readonly processRuntime: ProcessRuntime,
    traceRepository?: AnswerTraceRepository,
    langfuseExporter?: LangfuseExporter
  ) {
    this.traceRepository = traceRepository ?? new AnswerTraceRepository(processRuntime.db)
    this.langfuseExporter = langfuseExporter ?? new NoopLangfuseExporter()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

function adaptToRuntimeFactory(
  factory: AnswerClientFactory
): RuntimeClientFactory {
  return {
    createChatClient: factory.createChatClient,
    createEmbeddingClient: factory.createEmbeddingClient,
    createElasticsearchClient: factory.createElasticsearchClient,
    createNeo4jDriver:
      factory.createNeo4jDriver ??
      (({ uri, user, password }) =>
        neo4j.driver(uri, neo4j.auth.basic(user, password))),
  }
}

export function createAnswerRuntime(
  config: AppConfig = loadConfig(),
  clientFactory: AnswerClientFactory = defaultClientFactory,
  langfuseClient?: LangfuseClient,
): AnswerRuntime {
  const processRuntime = createProcessRuntime(
    config,
    adaptToRuntimeFactory(clientFactory)
  )
  const traceRepository = new AnswerTraceRepository(processRuntime.db)
  const hasPublicKey = !!config.langfusePublicKey?.trim()
  const hasSecretKey = !!config.langfuseSecretKey?.trim()
  const langfuseConfig: LangfuseConfig | undefined =
    hasPublicKey || hasSecretKey
      ? {
          publicKey: config.langfusePublicKey ?? "",
          secretKey: config.langfuseSecretKey ?? "",
          ...(config.langfuseBaseUrl
            ? { baseUrl: config.langfuseBaseUrl }
            : {}),
        }
      : undefined
  const langfuseExporter = createLangfuseExporter(
    langfuseConfig,
    langfuseClient,
    { chatModel: config.openaiChatModel },
  )
  return new AnswerRuntime(processRuntime, traceRepository, langfuseExporter)
}
