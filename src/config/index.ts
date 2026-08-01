export interface AppConfig {
  esNode: string
  esApiKey: string
  openaiApiKey: string
  openaiBaseUrl: string
  openaiChatModel: string
  embeddingApiKey: string
  embeddingBaseUrl: string
  embeddingModel: string
  embeddingDimensions: number
  /**
   * Per-request timeout for all OpenAI-compatible client calls (chat +
   * embedding), in milliseconds. Default 200_000. The OpenAI SDK default is
   * 10 minutes; this bounds every LLM call in the Answer and ingestion
   * chains (router/planner/validator/rerank/wikify) so a hung provider
   * cannot occupy a connection/queue for minutes.
   */
  openaiRequestTimeoutMs: number
  /**
   * Per-request retry count for all OpenAI-compatible client calls.
   * Default 1 (SDK default is 2). Bounds worst-case hang time to
   * timeout * (1 + maxRetries) — e.g. 200s * 2 = ~400s instead of the
   * SDK default 10min * 3 = 30min.
   */
  openaiMaxRetries: number
  neo4jUri: string
  neo4jUser: string
  neo4jPassword: string
  sqlitePath: string
  pollIntervalMs: number
  claimedTimeoutMs: number
  markitdownCommand?: string
  markerCommand?: string
  mineruCommand?: string
  parserTimeoutMs?: number
  parserInputLimitBytes?: number
  parserOutputLimitBytes?: number
  imageAssetPath?: string
  accessMode: "single_tenant" | "enforced"
  /**
   * Ticket 11 P1 (spec §11 L1574): ACTIVATION_MODE controls whether completed
   * ingestion candidates become active immediately (`auto`, default) or
   * require explicit human review (`review`). `auto` is the default
   * compatibility behavior — existing flows behave unchanged. `review`
   * stores completed candidates as `pending_review` and does NOT change the
   * active version until approval (spec L1574).
   */
  activationMode: "auto" | "review"
  /**
   * Ticket 08 P6 (spec §7 L1535): conversation records expire after this many
   * days of session inactivity. The GC job deletes ALL turns (validated +
   * pending clarification) for sessions whose MAX(created_at) predates the
   * cutoff. Default 30. Answer run traces (answer_run_events table) are NOT
   * affected — they are preserved as long-lived audit history.
   */
  conversationTtlDays: number
  /**
   * Ticket 08 P6: interval between scheduled conversation GC sweeps, in
   * milliseconds. Default 86_400_000 (24h). An eager sweep fires once at
   * startConversationGc invocation so a freshly-booted process cleans stale
   * sessions without waiting for the first tick.
   */
  conversationGcIntervalMs: number
  /**
   * T11 (spec issue #11): Langfuse observability export. When both
   * `langfusePublicKey` and `langfuseSecretKey` are set, the runtime
   * constructs a `RealLangfuseExporter` (requires a Langfuse client to be
   * injected). When either is missing, the factory selects Noop (criterion
   * #1). When exactly one is set, the factory throws at composition time
   * (criterion #2 — fails clearly rather than silently exporting incomplete
   * traces). `langfuseBaseUrl` is optional (Langfuse cloud default applies).
   */
  langfusePublicKey?: string
  langfuseSecretKey?: string
  langfuseBaseUrl?: string
  /** Optional whole-Answer-run model call limit. */
  answerRunMaxModelCalls?: number
  /** Optional whole-Answer-run aggregate token limit. */
  answerRunMaxTokens?: number
  /** Optional whole-Answer-run aggregate cost limit in integer micro-USD. */
  answerRunMaxCostMicros?: number
  /** Optional exact-model pricing table; no provider prices are hardcoded. */
  answerRunModelPricing?: Record<string, {
    inputCostMicrosPerMillionTokens: number
    outputCostMicrosPerMillionTokens: number
  }>
}

function required(key: string): string {
  const v = process.env[key]
  if (!v) throw new Error(`Missing required env var: ${key}`)
  return v
}

let _config: AppConfig | null = null

function positiveInteger(key: string, fallback: number): number {
  const value = process.env[key] ? Number(process.env[key]) : fallback
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`)
  }
  return value
}

function nonNegativeInteger(key: string, fallback: number): number {
  const value = process.env[key] ? Number(process.env[key]) : fallback
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer`)
  }
  return value
}

function optionalNonNegativeInteger(key: string): number | undefined {
  if (!process.env[key]) return undefined
  const value = Number(process.env[key])
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer`)
  }
  return value
}

function optionalPricingTable(): AppConfig["answerRunModelPricing"] {
  const raw = process.env.ANSWER_RUN_MODEL_PRICING_JSON
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("ANSWER_RUN_MODEL_PRICING_JSON must be valid JSON")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("ANSWER_RUN_MODEL_PRICING_JSON must be an object")
  }
  const table: NonNullable<AppConfig["answerRunModelPricing"]> = {}
  for (const [model, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`ANSWER_RUN_MODEL_PRICING_JSON.${model} must be an object`)
    }
    const input = (value as Record<string, unknown>).inputCostMicrosPerMillionTokens
    const output = (value as Record<string, unknown>).outputCostMicrosPerMillionTokens
    if (!Number.isInteger(input) || (input as number) < 0 ||
      !Number.isInteger(output) || (output as number) < 0) {
      throw new Error(
        `ANSWER_RUN_MODEL_PRICING_JSON.${model} rates must be non-negative integers`
      )
    }
    table[model] = {
      inputCostMicrosPerMillionTokens: input as number,
      outputCostMicrosPerMillionTokens: output as number,
    }
  }
  return table
}

export function loadConfig(): AppConfig {
  if (_config) return _config
  const openaiApiKey = required("OPENAI_API_KEY")
  const openaiBaseUrl = process.env.OPENAI_BASE_URL || ""
  const embeddingDimensions = process.env.EMBEDDING_DIMENSIONS
    ? Number(process.env.EMBEDDING_DIMENSIONS)
    : 1536
  if (!Number.isInteger(embeddingDimensions) || embeddingDimensions <= 0) {
    throw new Error("EMBEDDING_DIMENSIONS must be a positive integer")
  }
  _config = {
    esNode: process.env.ES_NODE || "http://localhost:9200",
    esApiKey: process.env.ES_API_KEY || "",
    openaiApiKey,
    openaiBaseUrl,
    openaiChatModel: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
    embeddingApiKey: process.env.EMBEDDING_API_KEY || openaiApiKey,
    embeddingBaseUrl: process.env.EMBEDDING_BASE_URL || openaiBaseUrl,
    embeddingModel: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
    embeddingDimensions,
    openaiRequestTimeoutMs: positiveInteger("OPENAI_REQUEST_TIMEOUT_MS", 200_000),
    openaiMaxRetries: nonNegativeInteger("OPENAI_MAX_RETRIES", 1),
    neo4jUri: process.env.NEO4J_URI || "bolt://localhost:7687",
    neo4jUser: process.env.NEO4J_USER || "neo4j",
    neo4jPassword: process.env.NEO4J_PASSWORD || "",
    sqlitePath: process.env.SQLITE_PATH || "./data/kefu-rag.db",
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 2000,
    claimedTimeoutMs: Number(process.env.CLAIMED_TIMEOUT_MS) || 600000,
    markitdownCommand: process.env.MARKITDOWN_COMMAND || "markitdown",
    markerCommand: process.env.MARKER_COMMAND || "marker_single",
    mineruCommand: process.env.MINERU_COMMAND || "mineru",
    parserTimeoutMs: positiveInteger("PARSER_TIMEOUT_MS", 120_000),
    parserInputLimitBytes: positiveInteger("PARSER_INPUT_LIMIT_BYTES", 20 * 1024 * 1024),
    parserOutputLimitBytes: positiveInteger("PARSER_OUTPUT_LIMIT_BYTES", 20 * 1024 * 1024),
    imageAssetPath: process.env.IMAGE_ASSET_PATH || "./data/image-assets",
    accessMode: process.env.ACCESS_MODE === "enforced" ? "enforced" : "single_tenant",
    // Ticket 11 P1 (spec §11 L1574): ACTIVATION_MODE=auto is default; only
    // the literal value "review" activates review mode. Any other value
    // (including unset) falls back to "auto" — same defensive pattern as
    // accessMode above.
    activationMode: process.env.ACTIVATION_MODE === "review" ? "review" : "auto",
    conversationTtlDays: positiveInteger("CONVERSATION_TTL_DAYS", 30),
    conversationGcIntervalMs: positiveInteger("CONVERSATION_GC_INTERVAL_MS", 86_400_000),
    // T11: Langfuse env vars. Both LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY
    // must be set to enable real export; either missing → Noop. The factory
    // (`createLangfuseExporter`) enforces the partial-config-throws rule.
    langfusePublicKey: process.env.LANGFUSE_PUBLIC_KEY || undefined,
    langfuseSecretKey: process.env.LANGFUSE_SECRET_KEY || undefined,
    langfuseBaseUrl: process.env.LANGFUSE_BASE_URL || undefined,
    answerRunMaxModelCalls: optionalNonNegativeInteger("ANSWER_RUN_MAX_MODEL_CALLS"),
    answerRunMaxTokens: optionalNonNegativeInteger("ANSWER_RUN_MAX_TOKENS"),
    answerRunMaxCostMicros: optionalNonNegativeInteger("ANSWER_RUN_MAX_COST_MICROS"),
    answerRunModelPricing: optionalPricingTable(),
  }
  return _config
}
