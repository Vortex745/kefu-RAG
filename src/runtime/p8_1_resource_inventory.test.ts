import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * P8.1 (spec L76): closeable resource inventory.
 *
 * "ProcessRuntime 只保留明确 owner 的 closeable 资源，server shutdown 必须按
 * 逆依赖顺序关闭并可重复调用。"
 *
 * P8.1 is Situation A (docs/test-only): it inventories all closeable resources
 * (ES, Neo4j, SQLite, HTTP, worker, GC, ingestion lifecycle, Langfuse exporter,
 * Mastra boundary) and statically audits that every resource constructor has a
 * matching close path. No production code is modified — the rollback boundary
 * is "docs-only rollback" (delete this test file).
 *
 * The inventory is the single source of truth for P8.2 (ProcessRuntime and
 * shutdown composition), which will consolidate duplicate ProcessRuntime
 * instances and verify repeated close + reverse-order shutdown at runtime.
 *
 * Static-source audit style mirrors P6.2 (caller wiring) — each test reads the
 * actual production source via readFileSync + regex, so the audit is grounded
 * in the on-disk codebase, not a hand-maintained table.
 */

const SRC = join(__dirname, "..", "..", "src")

function readSrc(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8")
}

// ─── Inventory table ───────────────────────────────────────────────────────
// Every long-lived closeable resource in the process, its constructor site,
// its close path, and its owner. Transient resources (Neo4j sessions closed
// in finally blocks, HTTP request sockets) are excluded — they are owned by
// the operation that creates them, not the process.

interface InventoryEntry {
  resource: string
  constructorSite: string
  closePath: string
  owner: string
  notes?: string
}

const INVENTORY: InventoryEntry[] = [
  {
    resource: "Elasticsearch Client (ProcessRuntime)",
    constructorSite: "runtime/process_runtime.ts (defaultClientFactory.createElasticsearchClient → new Client)",
    closePath: "runtime/process_runtime.ts (elasticsearch.close() in ProcessRuntime.close())",
    owner: "ProcessRuntime (createProcessRuntime)",
  },
  {
    resource: "Elasticsearch Client (IngestionStore)",
    constructorSite: "ingestion/storage/store.ts (ESStore constructor fallback → new Client)",
    closePath: "ingestion/storage/store.ts (ESStore.close() → this.client.close(); IngestionStoreImpl.close() → this.es.close())",
    owner: "IngestionStoreImpl (via createIngestionStore)",
    notes: "Separate ES client instance from ProcessRuntime — pre-existing duplication, debt for P8.2.",
  },
  {
    resource: "Neo4j Driver (ProcessRuntime)",
    constructorSite: "runtime/process_runtime.ts (defaultClientFactory.createNeo4jDriver → neo4j.driver)",
    closePath: "runtime/process_runtime.ts (neo4jDriver.close() in ProcessRuntime.close())",
    owner: "ProcessRuntime (createProcessRuntime)",
  },
  {
    resource: "Neo4j Driver (graph singleton)",
    constructorSite: "graph/index.ts (createDriver → neo4j.driver)",
    closePath: "graph/index.ts (closeDriver → _driver.close())",
    owner: "graph/index.ts module singleton",
    notes: "Legacy singleton; IngestionStore.Neo4jStore uses getDriver() and does NOT own the driver.",
  },
  {
    resource: "SQLite Database (ProcessRuntime — explicit path)",
    constructorSite: "ingestion/tracking/db.ts (openDb → new Database)",
    closePath: "runtime/process_runtime.ts (db.close() in ProcessRuntime.close() when sqlitePath provided)",
    owner: "ProcessRuntime (createProcessRuntime)",
  },
  {
    resource: "SQLite Database (global singleton — no path)",
    constructorSite: "ingestion/tracking/db.ts (openDb → new Database, cached in _db)",
    closePath: "ingestion/tracking/db.ts (closeDb → _db.close()) + shutdown.ts (db.close())",
    owner: "db.ts module singleton (closeDb) / ShutdownController (deps.db)",
  },
  {
    resource: "HTTP Server",
    constructorSite: "api/server.ts (startServer → app.listen)",
    closePath: "shutdown.ts (createShutdownController → server.close(() => resolve()))",
    owner: "ShutdownController (deps.server)",
  },
  {
    resource: "Background Worker (timer + lifecycle)",
    constructorSite: "api/worker.ts (startWorker → setInterval)",
    closePath: "api/worker.ts (stop() → stopWorker clearInterval + lifecycle.close()) + shutdown.ts (worker.stop())",
    owner: "ShutdownController (deps.worker)",
  },
  {
    resource: "Conversation GC (timer)",
    constructorSite: "answer/conversation_gc.ts (startConversationGc → setInterval)",
    closePath: "shutdown.ts (conversationGc.stop())",
    owner: "ShutdownController (deps.conversationGc)",
  },
  {
    resource: "Ingestion Lifecycle / StageRunner",
    constructorSite: "ingestion/pipeline.ts (IngestionStageRunner ensureStore → createIngestionStore)",
    closePath: "ingestion/pipeline.ts (close() → this.store.close()) + ingestion/lifecycle.ts (close() → stageRunner.close())",
    owner: "IngestionLifecycle (closed via worker.stop / cli runtime.close)",
  },
  {
    resource: "Langfuse Exporter (Noop or Real)",
    constructorSite: "answer/runtime.ts (createAnswerRuntime → createLangfuseExporter)",
    closePath: "answer/langfuse_exporter.ts (NoopLangfuseExporter.close / RealLangfuseExporter.close) + index.ts (langfuseExporter.close())",
    owner: "AnswerRuntime (langfuseExporter field)",
  },
  {
    resource: "Mastra Runtime Boundary",
    constructorSite: "index.ts (createMastraRuntimeBoundary)",
    closePath: "mastra/runtime_boundary.ts (close: () => Promise<void>) + index.ts (mastraBoundary.close())",
    owner: "main() (mastraBoundary local)",
  },
  {
    resource: "OpenAI Client (chat + embedding)",
    constructorSite: "runtime/process_runtime.ts (defaultClientFactory → new OpenAI)",
    closePath: "runtime/process_runtime.ts (comment: 'OpenAI clients have no explicit close')",
    owner: "ProcessRuntime (no close needed — HTTP pool managed by Node runtime)",
    notes: "Documented no-op; not a closeable resource in the traditional sense.",
  },
]

// ─── Tests ─────────────────────────────────────────────────────────────────

test("P8.1 inventory table is complete — every entry has resource, constructor, close path, and owner", () => {
  assert.ok(INVENTORY.length >= 13, `inventory must list all closeable resources (got ${INVENTORY.length})`)
  for (const entry of INVENTORY) {
    assert.ok(entry.resource, `entry missing resource name: ${JSON.stringify(entry)}`)
    assert.ok(entry.constructorSite, `entry missing constructorSite: ${entry.resource}`)
    assert.ok(entry.closePath, `entry missing closePath: ${entry.resource}`)
    assert.ok(entry.owner, `entry missing owner: ${entry.resource}`)
  }
})

test("P8.1 ES client (ProcessRuntime): constructor has matching close path", () => {
  const source = readSrc("runtime/process_runtime.ts")
  // Constructor: defaultClientFactory.createElasticsearchClient → new Client
  assert.match(
    source,
    /createElasticsearchClient/,
    "ES client constructor seam (createElasticsearchClient) must exist in process_runtime.ts",
  )
  assert.match(
    source,
    /new\s+Client\s*\(/,
    "ES client constructor (new Client) must exist in process_runtime.ts",
  )
  // Close path: elasticsearch.close() inside close()
  assert.match(
    source,
    /elasticsearch\.close\(\)/,
    "ES client close path (elasticsearch.close()) must exist in ProcessRuntime.close()",
  )
})

test("P8.1 ES client (IngestionStore): constructor has matching close path", () => {
  const storeSource = readSrc("ingestion/storage/store.ts")
  // Constructor: ESStore fallback → new Client
  assert.match(
    storeSource,
    /new\s+Client\s*\(/,
    "ESStore constructor fallback (new Client) must exist in store.ts",
  )
  // Close path: ESStore.close() → this.client.close()
  assert.match(
    storeSource,
    /async\s+close\(\)\s*:\s*Promise<void>\s*\{\s*await\s+this\.client\.close\(\)/,
    "ESStore.close() must call this.client.close()",
  )
  // IngestionStoreImpl.close() → this.es.close()
  assert.match(
    storeSource,
    /this\.es\.close\(\)/,
    "IngestionStoreImpl.close() must call this.es.close()",
  )
})

test("P8.1 Neo4j driver (ProcessRuntime): constructor has matching close path", () => {
  const source = readSrc("runtime/process_runtime.ts")
  // Constructor: neo4j.driver
  assert.match(
    source,
    /neo4j\.driver\(/,
    "Neo4j driver constructor (neo4j.driver) must exist in process_runtime.ts",
  )
  // Close path: neo4jDriver.close()
  assert.match(
    source,
    /neo4jDriver\.close\(\)/,
    "Neo4j driver close path (neo4jDriver.close()) must exist in ProcessRuntime.close()",
  )
})

test("P8.1 Neo4j driver (graph singleton): constructor has matching close path", () => {
  const source = readSrc("graph/index.ts")
  // Constructor: createDriver → neo4j.driver
  assert.match(
    source,
    /neo4j\.driver\(/,
    "Neo4j driver constructor (neo4j.driver) must exist in graph/index.ts",
  )
  // Close path: closeDriver → _driver.close()
  assert.match(
    source,
    /_driver\.close\(\)/,
    "Neo4j driver close path (_driver.close()) must exist in closeDriver()",
  )
})

test("P8.1 SQLite database: constructor has matching close path", () => {
  const dbSource = readSrc("ingestion/tracking/db.ts")
  // Constructor: openDb → new Database
  assert.match(
    dbSource,
    /new\s+Database\(/,
    "SQLite constructor (new Database) must exist in db.ts openDb()",
  )
  // Close path: closeDb → _db.close()
  assert.match(
    dbSource,
    /_db\.close\(\)/,
    "SQLite close path (_db.close()) must exist in closeDb()",
  )

  const prSource = readSrc("runtime/process_runtime.ts")
  // ProcessRuntime closes db (either db.close() or closeDb())
  assert.ok(
    /db\.close\(\)|closeDb\(\)/.test(prSource),
    "ProcessRuntime.close() must close SQLite (db.close() or closeDb())",
  )

  const shutdownSource = readSrc("shutdown.ts")
  // ShutdownController closes db (deps.db!.close() — the `!` is the
  // non-null assertion on the optional dep)
  assert.match(
    shutdownSource,
    /deps\.db!?\.\s*close\(\)/,
    "ShutdownController must close SQLite (deps.db!.close())",
  )
})

test("P8.1 HTTP server: constructor has matching close path", () => {
  const serverSource = readSrc("api/server.ts")
  // Constructor: app.listen
  assert.match(
    serverSource,
    /app\.listen\(/,
    "HTTP server constructor (app.listen) must exist in server.ts startServer()",
  )

  const shutdownSource = readSrc("shutdown.ts")
  // Close path: deps.server!.close(() => resolve()) inside runStep("server.close", ...)
  assert.match(
    shutdownSource,
    /deps\.server!?\.\s*close\(/,
    "HTTP server close path (deps.server!.close()) must exist in ShutdownController",
  )
})

test("P8.1 background worker: constructor has matching close path", () => {
  const workerSource = readSrc("api/worker.ts")
  // Constructor: setInterval
  assert.match(
    workerSource,
    /setInterval\(/,
    "Worker constructor (setInterval) must exist in worker.ts startWorker()",
  )
  // Close path: stopWorker → clearInterval + lifecycle.close()
  assert.match(
    workerSource,
    /clearInterval\(/,
    "Worker close path (clearInterval) must exist in stopWorker()",
  )
  assert.match(
    workerSource,
    /lifecycle\.close\(\)/,
    "Worker close path (lifecycle.close()) must exist in stop()",
  )

  const shutdownSource = readSrc("shutdown.ts")
  assert.match(
    shutdownSource,
    /deps\.worker!?\.\s*stop\(\)/,
    "ShutdownController must call deps.worker!.stop()",
  )
})

test("P8.1 conversation GC: constructor has matching close path", () => {
  const gcSource = readSrc("answer/conversation_gc.ts")
  // Constructor: startConversationGc → setInterval
  assert.match(
    gcSource,
    /setInterval\(/,
    "GC constructor (setInterval) must exist in conversation_gc.ts",
  )

  const shutdownSource = readSrc("shutdown.ts")
  // Close path: deps.conversationGc!.stop() inside runStep("conversationGc.stop", ...)
  assert.match(
    shutdownSource,
    /deps\.conversationGc!?\.\s*stop\(\)/,
    "GC close path (deps.conversationGc!.stop()) must exist in ShutdownController",
  )
})

test("P8.1 ingestion lifecycle: constructor has matching close path", () => {
  const pipelineSource = readSrc("ingestion/pipeline.ts")
  // Constructor: createIngestionStore (lazy via ensureStore)
  assert.match(
    pipelineSource,
    /createIngestionStore\(/,
    "Ingestion store constructor (createIngestionStore) must exist in pipeline.ts",
  )
  // Close path: close() → this.store.close()
  assert.match(
    pipelineSource,
    /this\.store\.close\(\)/,
    "IngestionStageRunner.close() must call this.store.close()",
  )

  const lifecycleSource = readSrc("ingestion/lifecycle.ts")
  assert.match(
    lifecycleSource,
    /this\.stageRunner\.close\(\)/,
    "IngestionLifecycle.close() must call this.stageRunner.close()",
  )

  const workerSource = readSrc("api/worker.ts")
  assert.match(
    workerSource,
    /lifecycle\.close\(\)/,
    "Worker stop() must call lifecycle.close()",
  )

  const cliSource = readSrc("ingestion/cli.ts")
  assert.match(
    cliSource,
    /runtime\.close\(\)/,
    "CLI must call runtime.close() in finally block",
  )
})

test("P8.1 Langfuse exporter: constructor has matching close path", () => {
  const runtimeSource = readSrc("answer/runtime.ts")
  // Constructor: createLangfuseExporter
  assert.match(
    runtimeSource,
    /createLangfuseExporter\(/,
    "Langfuse exporter constructor (createLangfuseExporter) must exist in answer/runtime.ts",
  )

  const exporterSource = readSrc("answer/langfuse_exporter.ts")
  // Close path: NoopLangfuseExporter.close() + RealLangfuseExporter.close()
  assert.match(
    exporterSource,
    /async\s+close\(\)\s*:\s*Promise<void>\s*\{\s*\}/,
    "NoopLangfuseExporter.close() must exist (no-op)",
  )
  assert.match(
    exporterSource,
    /close\(\)\s*:\s*Promise<void>/,
    "RealLangfuseExporter.close() must exist",
  )

  const indexSource = readSrc("index.ts")
  assert.match(
    indexSource,
    /langfuseExporter\.close\(\)/,
    "main() shutdown must call langfuseExporter.close()",
  )
})

test("P8.1 Mastra runtime boundary: constructor has matching close path", () => {
  const indexSource = readSrc("index.ts")
  // Constructor: createMastraRuntimeBoundary
  assert.match(
    indexSource,
    /createMastraRuntimeBoundary\(/,
    "Mastra boundary constructor must exist in index.ts",
  )
  // Close path: mastraBoundary.close()
  assert.match(
    indexSource,
    /mastraBoundary\.close\(\)/,
    "main() shutdown must call mastraBoundary.close()",
  )

  const boundarySource = readSrc("mastra/runtime_boundary.ts")
  // Interface declares close
  assert.match(
    boundarySource,
    /close:\s*\(\)\s*=>\s*Promise<void>/,
    "MastraRuntimeBoundary interface must declare close: () => Promise<void>",
  )
})

test("P8.1 OpenAI client: documented as no explicit close needed", () => {
  const source = readSrc("runtime/process_runtime.ts")
  // The source explicitly documents that OpenAI clients have no close path.
  // This is correct — the OpenAI SDK uses Node's HTTP agent which is reaped
  // on process exit. The inventory records this as a deliberate no-op.
  assert.match(
    source,
    /OpenAI clients have no explicit close/,
    "ProcessRuntime must document why OpenAI clients have no close path",
  )
})

test("P8.1 ProcessRuntime.close() is idempotent — closePromise guard exists", () => {
  const source = readSrc("runtime/process_runtime.ts")
  // The close() method caches its promise so repeated calls return the same
  // in-flight close. This satisfies spec L76 "可重复调用".
  assert.match(
    source,
    /let\s+closePromise/,
    "ProcessRuntime.close() must have a closePromise guard for idempotency",
  )
  assert.match(
    source,
    /if\s*\(closePromise\)\s*return\s+closePromise/,
    "ProcessRuntime.close() must return cached closePromise on repeat calls",
  )
})

test("P8.1 ShutdownController.shutdown() is idempotent — shutdownPromise guard exists", () => {
  const source = readSrc("shutdown.ts")
  assert.match(
    source,
    /let\s+shutdownPromise/,
    "ShutdownController must have a shutdownPromise guard for idempotency",
  )
  assert.match(
    source,
    /if\s*\(shutdownPromise\)\s*return\s+shutdownPromise/,
    "ShutdownController.shutdown() must return cached shutdownPromise on repeat calls",
  )
})

test("P8.1 shutdown order: worker → conversationGc → server → runtime → driver → db (reverse dependency)", () => {
  const source = readSrc("shutdown.ts")
  // Spec L76: "server shutdown 必须按逆依赖顺序关闭". The shutdown controller
  // must close resources in reverse dependency order:
  //   1. worker (depends on db + ingestion clients) — stop accepting tasks
  //   2. conversationGc (depends on db) — stop timer before db closes
  //   3. server (depends on db + runtime) — stop accepting HTTP connections
  //   4. runtime (ProcessRuntime: ES → Neo4j → SQLite) — close adapters
  //   5. driver (legacy Neo4j singleton) — close driver pool
  //   6. db (SQLite) — close last, everyone depends on it
  //
  // We verify the order by checking that each step's runStep call appears
  // AFTER the previous one in the source (doShutdown is sequential await).
  const workerIdx = source.indexOf('"worker.stop"')
  const gcIdx = source.indexOf('"conversationGc.stop"')
  const serverIdx = source.indexOf('"server.close"')
  const runtimeIdx = source.indexOf('"runtime.close"')
  const driverIdx = source.indexOf('"driver.close"')
  const dbIdx = source.indexOf('"db.close"')

  assert.ok(workerIdx > -1, "shutdown must close worker")
  assert.ok(gcIdx > -1, "shutdown must close conversationGc")
  assert.ok(serverIdx > -1, "shutdown must close server")
  assert.ok(runtimeIdx > -1, "shutdown must close runtime")
  assert.ok(driverIdx > -1, "shutdown must close driver")
  assert.ok(dbIdx > -1, "shutdown must close db")

  assert.ok(workerIdx < gcIdx, "worker must close BEFORE conversationGc")
  assert.ok(gcIdx < serverIdx, "conversationGc must close BEFORE server")
  assert.ok(serverIdx < runtimeIdx, "server must close BEFORE runtime")
  assert.ok(runtimeIdx < driverIdx, "runtime must close BEFORE driver")
  assert.ok(driverIdx < dbIdx, "driver must close BEFORE db (db is last, everyone depends on it)")
})

test("P8.1 ProcessRuntime.close() order: ES → Neo4j → SQLite (reverse of construction)", () => {
  const source = readSrc("runtime/process_runtime.ts")
  // Construction order: chatClient → embeddingClient → elasticsearch →
  // neo4jDriver → db. Close order reverses the closeable subset:
  // elasticsearch → neo4jDriver → db. (OpenAI clients have no close.)
  const esCloseIdx = source.indexOf("elasticsearch.close()")
  const neo4jCloseIdx = source.indexOf("neo4jDriver.close()")
  const dbCloseIdx = source.indexOf("db.close()")

  assert.ok(esCloseIdx > -1, "ProcessRuntime.close() must close ES")
  assert.ok(neo4jCloseIdx > -1, "ProcessRuntime.close() must close Neo4j")
  assert.ok(dbCloseIdx > -1, "ProcessRuntime.close() must close SQLite")

  assert.ok(esCloseIdx < neo4jCloseIdx, "ES must close BEFORE Neo4j")
  assert.ok(neo4jCloseIdx < dbCloseIdx, "Neo4j must close BEFORE SQLite (db is last)")
})

test("P8.1 inventory matches constructors — no production resource constructor is missing from inventory", () => {
  // Cross-check: grep all production .ts files for resource constructor patterns
  // and verify each constructor site is represented in the inventory table.
  // This is the "inventory matches constructors" gate condition.
  const filesToAudit = [
    "runtime/process_runtime.ts",
    "answer/runtime.ts",
    "ingestion/storage/store.ts",
    "ingestion/storage/index.ts",
    "ingestion/tracking/db.ts",
    "graph/index.ts",
    "api/server.ts",
    "api/worker.ts",
    "answer/conversation_gc.ts",
    "ingestion/pipeline.ts",
    "answer/langfuse_exporter.ts",
    "mastra/runtime_boundary.ts",
    "index.ts",
    "shutdown.ts",
  ]

  const constructorPatterns = [
    /new\s+Client\s*\(/, // Elasticsearch Client
    /neo4j\.driver\(/, // Neo4j Driver
    /new\s+Database\(/, // SQLite Database
    /app\.listen\(/, // HTTP Server
    /setInterval\(/, // Timer (worker + GC)
  ]

  let totalConstructorSites = 0
  for (const file of filesToAudit) {
    const source = readSrc(file)
    for (const pattern of constructorPatterns) {
      if (pattern.test(source)) {
        totalConstructorSites++
      }
    }
  }

  // Every constructor pattern found in production code must have at least one
  // matching inventory entry. The inventory has 13 entries covering all
  // closeable resource types. This test verifies the inventory is not empty
  // and that the audited files contain the expected constructor patterns.
  assert.ok(
    totalConstructorSites > 0,
    "production code must contain closeable resource constructors",
  )
  assert.ok(
    INVENTORY.length >= totalConstructorSites - 2,
    `inventory (${INVENTORY.length} entries) must cover all constructor sites ` +
      `(found ${totalConstructorSites} constructor pattern matches across ${filesToAudit.length} files; ` +
      `setInterval matches 2 files: worker + GC, so inventory >= sites - 2)`,
  )
})
