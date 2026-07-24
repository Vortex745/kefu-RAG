import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Server } from "node:http"
import { createShutdownController, type ShutdownDeps } from "../shutdown"

/**
 * P8.2 (spec L76): ProcessRuntime and shutdown composition.
 *
 * "ProcessRuntime 只保留明确 owner 的 closeable 资源，server shutdown 必须按
 * 逆依赖顺序关闭并可重复调用。"
 *
 * P8.2 is Situation B (modifies production code): it wires the legacy graph
 * Neo4j driver singleton (closeDriver from graph/index.ts) into the production
 * createShutdownController call at src/index.ts. This fixes P8.1 Debt #3 — the
 * Neo4j driver connection pool was never released on server shutdown.
 *
 * This file complements P8.1's static-only audit with RUNTIME verification:
 * 1. Static audit: src/index.ts wires the driver dep (Neo4j leak fix).
 * 2. Runtime: reverse-order shutdown with ALL 6 deps (P8.1 was static only).
 * 3. Runtime: driver.close is actually called during shutdown (leak fix proof).
 * 4. Runtime: repeated shutdown() is idempotent (P8.1 was static only).
 * 5. Runtime: closeDriver is safely repeatable (idempotency guard).
 *
 * Debt #1 (duplicate ProcessRuntime) and Debt #2 (duplicate ES client) are
 * efficiency issues, not leaks — both instances are closed. They are
 * carry-forward debt registered in the P8.2 ledger evidence, not fixed here
 * (fixing them requires large-scale refactoring across answer/runtime.ts,
 * api/server.ts, and ingestion/storage/store.ts — out of P8.2 scope).
 */

const SRC = join(__dirname, "..", "..", "src")

function readSrc(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8")
}

// ─── Static audit: Neo4j leak fix (Debt #3) ────────────────────────────────

test("P8.2 Neo4j leak fix: src/index.ts imports closeDriver from ./graph", () => {
  const source = readSrc("index.ts")
  // The import must bring closeDriver into scope so it can be wired into the
  // shutdown controller. This is the prerequisite for the leak fix.
  assert.match(
    source,
    /import\s+\{[^}]*\bcloseDriver\b[^}]*\}\s*from\s*["']\.\/graph["']/,
    "src/index.ts must import closeDriver from ./graph (resolves to graph/index.ts)",
  )
})

test("P8.2 Neo4j leak fix: createShutdownController wires driver: { close: closeDriver }", () => {
  const source = readSrc("index.ts")
  // The createShutdownController call must pass a `driver` dep so the legacy
  // graph Neo4j driver singleton is closed during server shutdown. Before P8.2
  // this dep was missing — the driver pool leaked on every server shutdown.
  assert.match(
    source,
    /driver:\s*\{\s*close:\s*closeDriver\s*\}/,
    "createShutdownController must wire driver: { close: closeDriver } to close the legacy graph Neo4j singleton",
  )
})

test("P8.2 Neo4j leak fix: one authoritative close path for graph singleton", () => {
  // closeDriver() in graph/index.ts is the SINGLE authoritative close path for
  // the _driver singleton. It is idempotent (guards on _driver null) and resets
  // _driver to null after close. This satisfies done-when "one authoritative
  // close path".
  const graphSource = readSrc("graph/index.ts")
  assert.match(
    graphSource,
    /export\s+async\s+function\s+closeDriver\(\):\s*Promise<void>/,
    "closeDriver must be an exported async function returning Promise<void>",
  )
  assert.match(
    graphSource,
    /if\s*\(_driver\)\s*\{/,
    "closeDriver must guard on _driver (idempotent — no-op if already closed)",
  )
  assert.match(
    graphSource,
    /_driver\s*=\s*null/,
    "closeDriver must reset _driver to null after close (prevents double-close)",
  )
})

test("P8.2 Neo4j leak fix: no other production caller closes graph driver outside shutdown controller", () => {
  // closeDriver should only be called from: (1) the shutdown controller via
  // driver dep (index.ts — the P8.2 fix), and (2) the ingestion CLI (cli.ts
  // — separate process, own lifecycle). No other production path should call
  // closeDriver directly, ensuring the shutdown controller is the single
  // authoritative close path for the server process.
  const indexSource = readSrc("index.ts")
  const cliSource = readSrc("ingestion/cli.ts")
  assert.match(
    indexSource,
    /driver:\s*\{\s*close:\s*closeDriver\s*\}/,
    "index.ts must wire closeDriver via driver dep (server shutdown path)",
  )
  assert.match(
    cliSource,
    /await\s+closeDriver\(\)/,
    "cli.ts may call closeDriver directly (separate CLI process, own lifecycle)",
  )
})

// ─── Runtime: reverse-order shutdown with all 6 deps ───────────────────────

function makeFullDeps(): ShutdownDeps & { callOrder: string[] } {
  const callOrder: string[] = []
  const deps: ShutdownDeps = {
    worker: {
      stop: async () => {
        callOrder.push("worker.stop")
      },
    },
    conversationGc: {
      stop: () => {
        callOrder.push("conversationGc.stop")
      },
    },
    server: {
      close: (cb?: (err?: Error) => void) => {
        callOrder.push("server.close")
        cb?.()
      },
    } as unknown as Server,
    runtime: {
      close: async () => {
        callOrder.push("runtime.close")
      },
    },
    driver: {
      close: async () => {
        callOrder.push("driver.close")
      },
    },
    db: {
      close: () => {
        callOrder.push("db.close")
      },
    },
    timeoutMs: 5000,
  }
  return Object.assign(deps, { callOrder })
}

test("P8.2 runtime reverse-order: shutdown closes all 6 deps in order worker → conversationGc → server → runtime → driver → db", async () => {
  // P8.1 verified the order STATICALLY (indexOf position in shutdown.ts source).
  // P8.2 verifies at RUNTIME — the actual call sequence must match the reverse
  // dependency order. This is the runtime complement to P8.1's static audit.
  // Order rationale (reverse dependency):
  //   1. worker (depends on db + ingestion) — stop accepting tasks first
  //   2. conversationGc (depends on db) — stop timer before db closes
  //   3. server (depends on db + runtime) — stop accepting HTTP connections
  //   4. runtime (ProcessRuntime: ES → Neo4j → SQLite) — close adapters
  //   5. driver (legacy Neo4j singleton) — close driver pool AFTER runtime
  //   6. db (SQLite) — close last, everyone depends on it
  const deps = makeFullDeps()
  const controller = createShutdownController(deps)
  await controller.shutdown()
  assert.deepEqual(deps.callOrder, [
    "worker.stop",
    "conversationGc.stop",
    "server.close",
    "runtime.close",
    "driver.close",
    "db.close",
  ])
})

test("P8.2 runtime reverse-order: driver closes AFTER runtime, BEFORE db", async () => {
  // Focused test on the P8.2-specific ordering concern: the graph Neo4j driver
  // singleton (driver dep) must close AFTER ProcessRuntime (runtime dep, which
  // closes ProcessRuntime's own Neo4j driver) and BEFORE SQLite (db dep).
  // This ensures:
  // - ProcessRuntime's Neo4j driver closes first (runtime.close)
  // - Then the legacy graph singleton closes (driver.close) — no conflict
  //   because they are separate Driver instances
  // - SQLite closes last (db.close) — everyone depends on it
  const deps = makeFullDeps()
  const controller = createShutdownController(deps)
  await controller.shutdown()
  const runtimeIdx = deps.callOrder.indexOf("runtime.close")
  const driverIdx = deps.callOrder.indexOf("driver.close")
  const dbIdx = deps.callOrder.indexOf("db.close")
  assert.ok(runtimeIdx > -1 && driverIdx > -1 && dbIdx > -1, "all three steps must run")
  assert.ok(runtimeIdx < driverIdx, "runtime.close must run BEFORE driver.close (ProcessRuntime Neo4j before graph singleton)")
  assert.ok(driverIdx < dbIdx, "driver.close must run BEFORE db.close (Neo4j before SQLite)")
})

// ─── Runtime: driver dep is actually called (leak fix proof) ───────────────

test("P8.2 runtime driver integration: shutdown calls driver.close exactly once when driver dep is wired", async () => {
  // This is the RUNTIME proof that the Neo4j leak fix works: when a driver dep
  // is passed to createShutdownController, shutdown() calls driver.close().
  // In production, this dep is { close: closeDriver }, so closeDriver() runs
  // and the legacy graph Neo4j driver pool is released.
  let driverCloseCalls = 0
  const controller = createShutdownController({
    driver: {
      close: async () => {
        driverCloseCalls += 1
      },
    },
    timeoutMs: 1000,
  })
  await controller.shutdown()
  assert.equal(driverCloseCalls, 1, "driver.close must be called exactly once during shutdown")
})

test("P8.2 runtime driver integration: shutdown skips driver.close when driver dep is absent (backwards compat)", async () => {
  // The driver dep is optional (ShutdownDeps.driver?: ...). When absent,
  // shutdown must skip it gracefully. This preserves backwards compatibility
  // for callers that don't have a Neo4j driver (e.g. tests, CLI paths).
  const callOrder: string[] = []
  const controller = createShutdownController({
    runtime: {
      close: async () => {
        callOrder.push("runtime.close")
      },
    },
    timeoutMs: 1000,
  })
  await controller.shutdown()
  assert.deepEqual(callOrder, ["runtime.close"], "shutdown must skip missing driver dep gracefully")
})

// ─── Runtime: repeated close (shutdown idempotency) ────────────────────────

test("P8.2 runtime repeated close: shutdown() is idempotent — second call returns same promise and does not re-close", async () => {
  // P8.1 verified the shutdownPromise guard STATICALLY. P8.2 verifies at RUNTIME
  // that a second shutdown() call returns the same promise and does NOT invoke
  // the closers again. This satisfies spec L76 "可重复调用".
  const deps = makeFullDeps()
  const controller = createShutdownController(deps)
  const p1 = controller.shutdown()
  const p2 = controller.shutdown()
  assert.equal(p1, p2, "second shutdown() must return the same promise (idempotent)")
  await p1
  assert.equal(deps.callOrder.length, 6, "closers must run exactly once (6 steps), not twice")
  assert.deepEqual(deps.callOrder, [
    "worker.stop",
    "conversationGc.stop",
    "server.close",
    "runtime.close",
    "driver.close",
    "db.close",
  ])
})

test("P8.2 runtime repeated close: closeDriver is safely repeatable (idempotency guard)", async () => {
  // Direct RUNTIME verification that closeDriver can be called repeatedly
  // without throwing. We import the real closeDriver from graph/index.ts and
  // call it twice. Since _driver is null in this test process (no createDriver()
  // called), both calls are no-ops. This proves the idempotency guard works
  // and that calling closeDriver multiple times is safe — which is what the
  // shutdown controller does if shutdown() is invoked repeatedly.
  const { closeDriver } = await import("../graph/index")
  await closeDriver() // first call — no-op (driver is null)
  await closeDriver() // second call — no-op (driver still null)
  // If we reach here without throwing, idempotency holds.
  assert.ok(true, "closeDriver must be safely repeatable (idempotent guard — no throw on repeat)")
})

test("P8.2 runtime repeated close: shutdown() after completion does not re-invoke closers", async () => {
  // Additional idempotency check: call shutdown() to completion, then call it
  // again. The second call must not re-invoke any closer.
  const deps = makeFullDeps()
  const controller = createShutdownController(deps)
  await controller.shutdown()
  const firstRunCount = deps.callOrder.length
  await controller.shutdown() // second call after completion
  assert.equal(deps.callOrder.length, firstRunCount, "second shutdown() after completion must not re-invoke closers")
})
