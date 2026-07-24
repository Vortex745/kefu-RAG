import assert from "node:assert/strict"
import test from "node:test"
import { Server } from "node:http"
import {
  createShutdownController,
  installSignalHandlers,
  type ShutdownDeps,
} from "./shutdown"

/**
 * T22 graceful shutdown tests.
 *
 * The shutdown controller coordinates closing 5 resource types in order:
 * worker → server → runtime → driver → db, with best-effort error handling
 * and a bounded timeout that forces process.exit if exceeded.
 */

function makeDeps(overrides: Partial<ShutdownDeps> = {}): ShutdownDeps & {
  callOrder: string[]
} {
  const callOrder: string[] = []
  const deps: ShutdownDeps = {
    worker: {
      stop: async () => {
        callOrder.push("worker.stop")
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
    ...overrides,
  }
  return Object.assign(deps, { callOrder })
}

test("shutdown() calls all closers in order: worker → server → runtime → driver → db", async () => {
  const deps = makeDeps()
  const controller = createShutdownController(deps)
  await controller.shutdown()
  assert.deepEqual(deps.callOrder, [
    "worker.stop",
    "server.close",
    "runtime.close",
    "driver.close",
    "db.close",
  ])
})

test("shutdown() continues if one closer throws (best-effort)", async () => {
  const deps = makeDeps({
    runtime: {
      close: async () => {
        throw new Error("runtime boom")
      },
    },
  })
  const controller = createShutdownController(deps)
  await controller.shutdown()
  // Even though runtime.close threw, driver.close and db.close still ran.
  assert.ok(deps.callOrder.includes("driver.close"))
  assert.ok(deps.callOrder.includes("db.close"))
})

test("shutdown() skips missing deps gracefully", async () => {
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
  assert.deepEqual(callOrder, ["runtime.close"])
})

test("shutdown() forces exit when timeout exceeded", async () => {
  let timedOut = false
  const controller = createShutdownController({
    worker: {
      // Never resolves — simulates stuck active operation.
      stop: () => new Promise<void>(() => {}),
    },
    timeoutMs: 50,
    onTimeout: () => {
      timedOut = true
    },
  })
  // shutdown() rejects with timeout error after 50ms.
  await controller.shutdown().catch(() => {})
  assert.ok(timedOut, "onTimeout should have been called")
})

test("installSignalHandlers registers SIGINT and SIGTERM handlers", () => {
  const originalOn = process.on
  const registered: string[] = []
  process.on = ((name: string, handler: () => void) => {
    registered.push(name)
    return process
  }) as never
  try {
    const controller = createShutdownController(makeDeps())
    installSignalHandlers(controller)
    assert.ok(registered.includes("SIGINT"))
    assert.ok(registered.includes("SIGTERM"))
  } finally {
    process.on = originalOn
  }
})

test("shutdown() is idempotent — second call returns same promise", async () => {
  const deps = makeDeps()
  const controller = createShutdownController(deps)
  const p1 = controller.shutdown()
  const p2 = controller.shutdown()
  assert.equal(p1, p2)
  await p1
})
