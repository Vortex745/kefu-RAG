import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { openDb } from "./tracking"
import { DocumentRepo } from "./tracking/doc_repo"
import {
  IngestionLifecycle,
  type IngestionStageRunner,
  type StageExecution,
} from "./lifecycle"

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("an ingestion job exposes its complete four-stage success lifecycle", async () => {
  const db = openDb(":memory:")
  const runnerStarted = deferred()
  const continueRunner = deferred()
  const runner: IngestionStageRunner = {
    close: async () => {},
    async run(_document, execution: StageExecution): Promise<void> {
      runnerStarted.resolve()
      await continueRunner.promise

      for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
        await execution.runStage(stage, {}, async () => undefined, () => ({ stage }))
      }
    },
  }
  const lifecycle = new IngestionLifecycle(db, runner)

  try {
    const submitted = lifecycle.submit({
      title: "Refund policy",
      content: "Refunds are available within 30 days.",
      source: "test",
    })

    assert.equal(submitted.status, "pending")
    assert.equal(lifecycle.getStatus(submitted.docId)?.task?.status, "pending")

    const running = lifecycle.runNext()
    await runnerStarted.promise

    const active = lifecycle.getStatus(submitted.docId)
    assert.equal(active?.task?.status, "running")
    assert.equal(active?.spanTree.length, 1)
    assert.equal(active?.spanTree[0].span.name, "ingest")
    assert.equal(active?.spanTree[0].span.status, "running")
    assert.deepEqual(
      active?.spanTree[0].children.map(({ span }) => [span.name, span.status]),
      [
        ["chunk", "pending"],
        ["wikify", "pending"],
        ["storeChunks", "pending"],
        ["storeGraph", "pending"],
      ]
    )

    continueRunner.resolve()
    const result = await running
    const completed = lifecycle.getStatus(submitted.docId)

    assert.equal(result?.success, true)
    assert.equal(completed?.task?.status, "completed")
    assert.equal(completed?.documentStatus, "completed")
    assert.equal(completed?.spanTree[0].span.status, "done")
    assert.deepEqual(
      completed?.spanTree[0].children.map(({ span }) => [span.name, span.status]),
      [
        ["chunk", "done"],
        ["wikify", "done"],
        ["storeChunks", "done"],
        ["storeGraph", "done"],
      ]
    )
    assert.deepEqual(lifecycle.cancel(submitted.docId), {
      docId: submitted.docId,
      taskId: submitted.taskId,
      status: "completed",
      changed: false,
    })
    assert.equal(lifecycle.getStatus(submitted.docId)?.documentStatus, "completed")
  } finally {
    db.close()
  }
})

test("unchanged source content is a queryable no-op", async () => {
  const db = openDb(":memory:")
  let runs = 0
  const runner: IngestionStageRunner = {
    close: async () => {},
    async run(_document, execution): Promise<void> {
      runs += 1
      for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
        await execution.runStage(stage, {}, async () => undefined, () => ({ stage }))
      }
    },
  }
  const lifecycle = new IngestionLifecycle(db, runner)

  try {
    const initial = lifecycle.submit({
      title: "Refund policy",
      content: "Refunds are available within 30 days.",
      source: " https://example.com/policies/refunds ",
    })
    assert.equal((await lifecycle.runNext())?.success, true)

    const unchanged = lifecycle.submit({
      title: "Renamed refund policy",
      content: "Refunds are available within 30 days.",
      source: "https://example.com/policies/refunds",
    })

    assert.deepEqual(unchanged, {
      docId: initial.docId,
      taskId: null,
      status: "unchanged",
      version: 1,
    })
    assert.equal(await lifecycle.runNext(), null)
    assert.equal(runs, 1)
    assert.equal(lifecycle.getStatus(initial.docId)?.lifecycleOutcome, "unchanged")
    assert.deepEqual(lifecycle.getStatus(initial.docId)?.documentVersion, {
      version: 1,
      contentHash: "2926202d1cedb270ca52211dcae0d2bafd009a7bfd6699a08233e946501e5229",
      active: true,
    })
  } finally {
    db.close()
  }
})

test("duplicate in-flight source content reuses the existing version and task", async () => {
  const db = openDb(":memory:")
  const started = deferred()
  const release = deferred()
  let runs = 0
  const lifecycle = new IngestionLifecycle(db, {
    close: async () => {},
    async run(_document, execution): Promise<void> {
      runs += 1
      started.resolve()
      await release.promise
      for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
        await execution.runStage(stage, {}, async () => undefined, () => ({ stage }))
      }
    },
  })

  try {
    const initial = lifecycle.submit({
      title: "Policy",
      content: "pending content",
      source: "policy:pending",
    })
    const running = lifecycle.runNext()
    await started.promise
    const duplicate = lifecycle.submit({
      title: "Renamed policy",
      content: "pending content",
      source: "policy:pending",
    })

    release.resolve()
    assert.equal((await running)?.success, true)
    assert.deepEqual(duplicate, initial)
    assert.equal(await lifecycle.runNext(), null)
    assert.equal(runs, 1)
  } finally {
    db.close()
  }
})

test("Windows file identity is stable across path casing", {
  skip: process.platform !== "win32",
}, async () => {
  const db = openDb(":memory:")
  const lifecycle = new IngestionLifecycle(db, {
    close: async () => {},
    async run(_document, execution): Promise<void> {
      for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
        await execution.runStage(stage, {}, async () => undefined, () => ({ stage }))
      }
    },
  })

  try {
    const initial = lifecycle.submit({
      title: "Policy",
      content: "same file content",
      sourceIdentity: {
        kind: "file",
        uriOrExternalId: "C:\\Temp\\Policy.txt",
        namespace: "local",
      },
    })
    await lifecycle.runNext()
    const unchanged = lifecycle.submit({
      title: "Policy",
      content: "same file content",
      sourceIdentity: {
        kind: "file",
        uriOrExternalId: "c:\\temp\\policy.txt",
        namespace: "local",
      },
    })
    assert.equal(unchanged.status, "unchanged")
    assert.equal(unchanged.docId, initial.docId)
  } finally {
    db.close()
  }
})

test("same canonical source is isolated by tenant", () => {
  const db = openDb(":memory:")
  const lifecycle = new IngestionLifecycle(db, {
    close: async () => {},
    async run() {},
  })
  try {
    const repo = new DocumentRepo(db)
    const tenantA = lifecycle.submit({
      title: "Tenant A policy",
      content: "A",
      sourceIdentity: {
        kind: "file",
        uriOrExternalId: "C:/knowledge/policy.pdf",
        namespace: "upload",
        tenantId: "tenant-a",
        allowedGroups: ["support"],
      },
    })
    const tenantB = lifecycle.submit({
      title: "Tenant B policy",
      content: "B",
      sourceIdentity: {
        kind: "file",
        uriOrExternalId: "C:/knowledge/policy.pdf",
        namespace: "upload",
        tenantId: "tenant-b",
        allowedGroups: ["billing"],
      },
    })
    const documentA = repo.get(tenantA.docId)
    const documentB = repo.get(tenantB.docId)
    assert.ok(documentA && documentB)
    assert.notEqual(documentA.sourceId, documentB.sourceId)
    assert.equal(documentA.tenantId, "tenant-a")
    assert.deepEqual(documentA.allowedGroups, ["support"])
    assert.equal(documentB.tenantId, "tenant-b")
    assert.deepEqual(documentB.allowedGroups, ["billing"])
  } finally {
    db.close()
  }
})

test("legacy alias adoption stays within the tenant and updates access metadata", async () => {
  const db = openDb(":memory:")
  const lifecycle = new IngestionLifecycle(db, {
    close: async () => {},
    async run(_document, execution): Promise<void> {
      for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
        await execution.runStage(stage, {}, async () => undefined, () => ({ stage }))
      }
    },
  })
  try {
    const repo = new DocumentRepo(db)
    const legacyA = lifecycle.submit({
      title: "Legacy A",
      content: "same content",
      sourceIdentity: {
        kind: "legacy",
        uriOrExternalId: "C:/knowledge/legacy.pdf",
        tenantId: "tenant-a",
        allowedGroups: ["old-support"],
      },
    })
    await lifecycle.runNext()
    const legacyB = lifecycle.submit({
      title: "Legacy B",
      content: "other tenant",
      sourceIdentity: {
        kind: "legacy",
        uriOrExternalId: "C:/knowledge/legacy.pdf",
        tenantId: "tenant-b",
        allowedGroups: ["billing"],
      },
    })
    await lifecycle.runNext()
    const sourceA = repo.get(legacyA.docId)!.sourceId
    const sourceB = repo.get(legacyB.docId)!.sourceId
    db.prepare("UPDATE documents SET created_at = ? WHERE doc_id = ?")
      .run("2099-01-01T00:00:00.000Z", legacyB.docId)

    const adopted = lifecycle.submit({
      title: "Canonical A",
      content: "same content",
      legacySourceAliases: ["C:/knowledge/legacy.pdf"],
      sourceIdentity: {
        kind: "file",
        uriOrExternalId: "C:/knowledge/legacy.pdf",
        namespace: "local",
        tenantId: "tenant-a",
        allowedGroups: ["support"],
      },
    })

    assert.equal(adopted.status, "unchanged")
    assert.equal(repo.get(adopted.docId)!.sourceId, sourceA)
    assert.equal(repo.get(legacyB.docId)!.sourceId, sourceB)
    const sources = db.prepare(
      "SELECT source_id, tenant_id, allowed_groups, canonical_source_id FROM sources ORDER BY tenant_id"
    ).all() as Array<{
      source_id: string
      tenant_id: string
      allowed_groups: string
      canonical_source_id: string | null
    }>
    const tenantA = sources.find((source) => source.source_id === sourceA)!
    const tenantB = sources.find((source) => source.source_id === sourceB)!
    assert.equal(tenantA.tenant_id, "tenant-a")
    assert.deepEqual(JSON.parse(tenantA.allowed_groups), ["support"])
    assert.equal(tenantB.tenant_id, "tenant-b")
    assert.equal(tenantB.canonical_source_id, null)
    assert.deepEqual(repo.get(legacyA.docId)!.allowedGroups, ["support"])
  } finally {
    db.close()
  }
})

test("a failed replacement remains inspectable without replacing the active version", async () => {
  const db = openDb(":memory:")
  const runner: IngestionStageRunner = {
    close: async () => {},
    async run(document, execution): Promise<void> {
      if (document.content === "replacement") return
      for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
        await execution.runStage(stage, {}, async () => undefined, () => ({ stage }))
      }
    },
  }
  const lifecycle = new IngestionLifecycle(db, runner)

  try {
    const initial = lifecycle.submit({
      title: "Policy",
      content: "original",
      source: "policy:refunds",
    })
    assert.equal((await lifecycle.runNext())?.success, true)

    const replacement = lifecycle.submit({
      title: "Policy",
      content: "replacement",
      source: "policy:refunds",
    })
    assert.equal(replacement.status, "pending")
    assert.equal(replacement.version, 2)
    assert.notEqual(replacement.docId, initial.docId)
    assert.equal((await lifecycle.runNext())?.success, false)

    const oldVersion = lifecycle.getStatus(initial.docId)
    const failedVersion = lifecycle.getStatus(replacement.docId)
    assert.equal(oldVersion?.documentStatus, "completed")
    assert.equal(oldVersion?.documentVersion.active, true)
    assert.equal(failedVersion?.documentStatus, "failed")
    assert.equal(failedVersion?.lifecycleOutcome, "failed")
    assert.deepEqual(failedVersion?.documentVersion, {
      version: 2,
      contentHash: "95713e9cbdd1dfcb2d4080c2537f418d43ca0da25f0d7d6631f4f7c97b89dc47",
      active: false,
    })
  } finally {
    db.close()
  }
})

test("a successful replacement activates the new immutable version", async () => {
  const db = openDb(":memory:")
  const runner: IngestionStageRunner = {
    close: async () => {},
    async run(_document, execution): Promise<void> {
      for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
        await execution.runStage(stage, {}, async () => undefined, () => ({ stage }))
      }
    },
  }
  const lifecycle = new IngestionLifecycle(db, runner)

  try {
    const initial = lifecycle.submit({
      title: "Policy",
      content: "version one",
      source: "policy:shipping",
    })
    await lifecycle.runNext()
    const replacement = lifecycle.submit({
      title: "Policy",
      content: "version two",
      source: "policy:shipping",
    })
    await lifecycle.runNext()

    assert.equal(initial.version, 1)
    assert.equal(replacement.version, 2)
    assert.equal(lifecycle.getStatus(initial.docId)?.documentVersion.active, false)
    assert.equal(lifecycle.getStatus(replacement.docId)?.documentVersion.active, true)
    assert.equal(lifecycle.getStatus(replacement.docId)?.lifecycleOutcome, "completed")
  } finally {
    db.close()
  }
})

test("an older version finishing late cannot replace a newer active version", async () => {
  const db = openDb(":memory:")
  const olderStarted = deferred()
  const releaseOlder = deferred()
  const lifecycle = new IngestionLifecycle(db, {
    close: async () => {},
    async run(document, execution): Promise<void> {
      if (document.content === "version two") {
        olderStarted.resolve()
        await releaseOlder.promise
      }
      for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
        await execution.runStage(stage, {}, async () => undefined, () => ({ stage }))
      }
    },
  })

  try {
    const initial = lifecycle.submit({
      title: "Policy",
      content: "version one",
      source: "policy:concurrent",
    })
    await lifecycle.runNext()
    const older = lifecycle.submit({
      title: "Policy",
      content: "version two",
      source: "policy:concurrent",
    })
    const newer = lifecycle.submit({
      title: "Policy",
      content: "version three",
      source: "policy:concurrent",
    })

    const olderRun = lifecycle.runNext()
    await olderStarted.promise
    assert.equal((await lifecycle.runNext())?.success, true)
    assert.equal(lifecycle.getStatus(newer.docId)?.documentVersion.active, true)

    releaseOlder.resolve()
    assert.equal((await olderRun)?.success, true)
    assert.equal(lifecycle.getStatus(initial.docId)?.documentVersion.active, false)
    assert.equal(lifecycle.getStatus(older.docId)?.documentVersion.active, false)
    assert.equal(lifecycle.getStatus(newer.docId)?.documentVersion.active, true)
  } finally {
    db.close()
  }
})

test("an ingestion job cannot complete when its runner omits required stages", async () => {
  const db = openDb(":memory:")
  const runner: IngestionStageRunner = {
    close: async () => {},
    async run(_document, execution): Promise<void> {
      await execution.runStage("chunk", {}, async () => undefined, () => ({}))
    },
  }
  const lifecycle = new IngestionLifecycle(db, runner)

  try {
    const submitted = lifecycle.submit({ title: "Incomplete", content: "content" })
    const result = await lifecycle.runNext()
    const status = lifecycle.getStatus(submitted.docId)

    assert.equal(result?.success, false)
    assert.equal(status?.task?.status, "failed")
    assert.equal(status?.documentStatus, "failed")
    assert.equal(status?.spanTree[0].span.status, "failed")
  } finally {
    db.close()
  }
})

test("a failed ingestion job leaves no open stage spans", async () => {
  const db = openDb(":memory:")
  const runner: IngestionStageRunner = {
    close: async () => {},
    async run(_document, execution): Promise<void> {
      await execution.runStage(
        "chunk",
        {},
        async () => {
          throw new Error("chunk failed")
        },
        () => ({})
      )
    },
  }
  const lifecycle = new IngestionLifecycle(db, runner)

  try {
    const submitted = lifecycle.submit({ title: "Failure", content: "content" })
    const result = await lifecycle.runNext()
    const status = lifecycle.getStatus(submitted.docId)
    const root = status?.spanTree[0]

    assert.equal(result?.success, false)
    assert.equal(status?.task?.status, "pending")
    assert.equal(status?.documentStatus, "pending")
    assert.equal(root?.span.status, "failed")
    assert.deepEqual(
      root?.children.map(({ span }) => [span.name, span.status]),
      [
        ["chunk", "failed"],
        ["wikify", "skipped"],
        ["storeChunks", "skipped"],
        ["storeGraph", "skipped"],
      ]
    )
    assert.equal(
      status?.spanTree.flatMap((node) => [node.span, ...node.children.map(({ span }) => span)])
        .some(({ status: spanStatus }) => spanStatus === "pending" || spanStatus === "running"),
      false
    )
  } finally {
    db.close()
  }
})

test("a failed ingestion job persists 2s, 4s, and 8s retries", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "kefu-rag-retry-"))
  const dbPath = join(tempDir, "retry.db")
  let db = openDb(dbPath)
  let now = Date.parse("2026-07-15T00:00:00.000Z")
  const runner: IngestionStageRunner = {
    close: async () => {},
    async run(_document, execution): Promise<void> {
      await execution.runStage(
        "chunk",
        {},
        async () => {
          throw new Error("temporary provider failure")
        },
        () => ({})
      )
    },
  }
  let lifecycle = new IngestionLifecycle(db, runner, () => new Date(now))
  let firstAttemptSnapshot = ""

  try {
    const submitted = lifecycle.submit({ title: "Retry", content: "content" })
    if (submitted.status !== "pending") assert.fail("expected queued ingestion")
    const retryDelays = [2_000, 4_000, 8_000]

    for (const [index, delay] of retryDelays.entries()) {
      const result = await lifecycle.runNext()
      const status = lifecycle.getStatus(submitted.docId)

      assert.equal(result?.success, false)
      assert.equal(status?.task?.status, "pending")
      assert.equal(status?.task?.failCount, index + 1)
      assert.equal(
        status?.task?.nextAttemptAt,
        new Date(now + delay).toISOString()
      )
      assert.equal(status?.documentStatus, "pending")
      assert.equal(status?.spanTree.length, index + 1)
      assert.equal(lifecycle.getDeadLetter(submitted.taskId), null)
      assert.equal(status?.spanTree.at(-1)?.children.length, 4)
      assert.deepEqual(
        status?.spanTree.at(-1)?.children.map(({ span }) => span.name),
        ["chunk", "wikify", "storeChunks", "storeGraph"]
      )
      assert.equal(await lifecycle.runNext(), null)

      if (index === 0) {
        firstAttemptSnapshot = JSON.stringify(status?.spanTree[0])
        db.close()
        db = openDb(dbPath)
        lifecycle = new IngestionLifecycle(db, runner, () => new Date(now))
        assert.equal(await lifecycle.runNext(), null)
      }

      now += delay
    }

    const exhausted = await lifecycle.runNext()
    const finalStatus = lifecycle.getStatus(submitted.docId)

    assert.equal(exhausted?.success, false)
    assert.equal(finalStatus?.task?.status, "failed")
    assert.equal(finalStatus?.task?.failCount, 4)
    assert.equal(finalStatus?.task?.nextAttemptAt, null)
    assert.equal(finalStatus?.documentStatus, "failed")
    assert.equal(finalStatus?.spanTree.length, 4)
    const deadLetter = lifecycle.getDeadLetter(submitted.taskId)
    assert.equal(deadLetter?.taskId, submitted.taskId)
    assert.equal(deadLetter?.docId, submitted.docId)
    assert.equal(deadLetter?.op, "ingest")
    assert.deepEqual(deadLetter?.payload, {
      title: "Retry",
      contentLength: 7,
    })
    assert.equal(deadLetter?.failCount, 4)
    assert.equal(deadLetter?.errorMessage, "temporary provider failure")
    assert.match(deadLetter?.errorStack ?? "", /temporary provider failure/)
    assert.equal(deadLetter?.failedAt, new Date(now).toISOString())
    assert.equal("errorStack" in finalStatus!.spanTree.at(-1)!.span, false)
    assert.equal(JSON.stringify(finalStatus?.spanTree[0]), firstAttemptSnapshot)
    const spanIds = finalStatus?.spanTree.flatMap(({ span, children }) => [
      span.spanId,
      ...children.map(({ span: child }) => child.spanId),
    ]) ?? []
    assert.equal(new Set(spanIds).size, 20)
    assert.equal(await lifecycle.runNext(), null)
  } finally {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test("an ingestion job can complete after its persisted retry", async () => {
  const db = openDb(":memory:")
  let now = Date.parse("2026-07-15T00:00:00.000Z")
  let attempt = 0
  const retryStarted = deferred()
  const continueRetry = deferred()
  const runner: IngestionStageRunner = {
    close: async () => {},
    async run(_document, execution): Promise<void> {
      attempt += 1
      if (attempt === 2) {
        retryStarted.resolve()
        await continueRetry.promise
      }
      for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
        await execution.runStage(
          stage,
          {},
          async () => {
            if (attempt === 1 && stage === "chunk") {
              throw new Error("temporary provider failure")
            }
          },
          () => ({ stage })
        )
      }
    },
  }
  const lifecycle = new IngestionLifecycle(db, runner, () => new Date(now))

  try {
    const submitted = lifecycle.submit({ title: "Recovery", content: "content" })

    await lifecycle.runNext()
    now += 2_000
    const retryRun = lifecycle.runNext()
    await retryStarted.promise

    const running = lifecycle.getStatus(submitted.docId)
    assert.equal(running?.task?.status, "running")
    assert.equal(running?.task?.nextAttemptAt, null)

    continueRetry.resolve()
    const result = await retryRun
    const status = lifecycle.getStatus(submitted.docId)

    assert.equal(result?.success, true)
    assert.equal(status?.task?.status, "completed")
    assert.equal(status?.task?.failCount, 1)
    assert.equal(status?.task?.nextAttemptAt, null)
    assert.equal(status?.documentStatus, "completed")
    assert.deepEqual(
      status?.spanTree.map(({ span }) => span.status),
      ["failed", "done"]
    )
  } finally {
    db.close()
  }
})

test("stale running claims consume retry budget and eventually dead-letter", async () => {
  const db = openDb(":memory:")
  let now = Date.parse("2026-07-15T00:00:00.000Z")
  const claimedTimeoutMs = 10_000
  const starts = Array.from({ length: 4 }, () => deferred())
  let attempt = 0
  const runner: IngestionStageRunner = {
    close: async () => {},
    async run(): Promise<void> {
      starts[attempt].resolve()
      attempt += 1
      await new Promise<void>(() => {})
    },
  }
  const lifecycle = new IngestionLifecycle(db, runner, () => new Date(now))

  try {
    const submitted = lifecycle.submit({ title: "Stale", content: "content" })
    if (submitted.status !== "pending") assert.fail("expected queued ingestion")
    const retryDelays = [2_000, 4_000, 8_000]

    for (let index = 0; index < 4; index += 1) {
      void lifecycle.runNext()
      await starts[index].promise
      now += claimedTimeoutMs + 1

      assert.equal(lifecycle.recoverStaleClaims(claimedTimeoutMs), 1)
      const status = lifecycle.getStatus(submitted.docId)
      assert.equal(status?.task?.failCount, index + 1)
      assert.equal(status?.spanTree.length, index + 1)
      assert.deepEqual(
        status?.spanTree.at(-1)?.children.map(({ span }) => span.status),
        ["skipped", "skipped", "skipped", "skipped"]
      )

      if (index < retryDelays.length) {
        assert.equal(status?.task?.status, "pending")
        assert.equal(
          status?.task?.nextAttemptAt,
          new Date(now + retryDelays[index]).toISOString()
        )
        now += retryDelays[index]
      }
    }

    const finalStatus = lifecycle.getStatus(submitted.docId)
    assert.equal(finalStatus?.task?.status, "failed")
    assert.equal(finalStatus?.documentStatus, "failed")
    assert.equal(lifecycle.getDeadLetter(submitted.taskId)?.failCount, 4)
    assert.match(
      lifecycle.getDeadLetter(submitted.taskId)?.errorMessage ?? "",
      /timed out/
    )
    assert.equal(lifecycle.recoverStaleClaims(claimedTimeoutMs), 0)
  } finally {
    db.close()
  }
})

test("a stale worker callback cannot mutate a newer attempt", async () => {
  const db = openDb(":memory:")
  let now = Date.parse("2026-07-15T00:00:00.000Z")
  const starts = [deferred(), deferred()]
  const releases = [deferred(), deferred()]
  let attempt = 0
  const runner: IngestionStageRunner = {
    close: async () => {},
    async run(_document, execution): Promise<void> {
      const currentAttempt = attempt
      attempt += 1
      starts[currentAttempt].resolve()
      await releases[currentAttempt].promise
      for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
        await execution.runStage(stage, {}, async () => undefined, () => ({ stage }))
      }
    },
  }
  const lifecycle = new IngestionLifecycle(db, runner, () => new Date(now))

  try {
    const submitted = lifecycle.submit({ title: "Fenced", content: "content" })
    const staleRun = lifecycle.runNext()
    await starts[0].promise

    now += 10_001
    assert.equal(lifecycle.recoverStaleClaims(10_000), 1)
    now += 2_000

    const currentRun = lifecycle.runNext()
    await starts[1].promise
    releases[0].resolve()
    await assert.rejects(staleRun, /failure could not be recorded/)

    const stillRunning = lifecycle.getStatus(submitted.docId)
    assert.equal(stillRunning?.task?.status, "running")
    assert.equal(stillRunning?.task?.failCount, 1)

    releases[1].resolve()
    assert.equal((await currentRun)?.success, true)
    assert.equal(lifecycle.getStatus(submitted.docId)?.task?.status, "completed")
  } finally {
    db.close()
  }
})

test("a pending ingestion job can be cancelled idempotently", async () => {
  const db = openDb(":memory:")
  const runner: IngestionStageRunner = {
    close: async () => {},
    async run(): Promise<void> {},
  }
  const lifecycle = new IngestionLifecycle(db, runner)

  try {
    const submitted = lifecycle.submit({ title: "Cancel", content: "content" })

    assert.deepEqual(lifecycle.cancel(submitted.docId), {
      docId: submitted.docId,
      taskId: submitted.taskId,
      status: "cancelled",
      changed: true,
    })
    assert.equal(lifecycle.getStatus(submitted.docId)?.documentStatus, "cancelled")
    assert.equal(lifecycle.getStatus(submitted.docId)?.spanTree.length, 0)
    assert.equal(await lifecycle.runNext(), null)
    assert.deepEqual(lifecycle.cancel(submitted.docId), {
      docId: submitted.docId,
      taskId: submitted.taskId,
      status: "cancelled",
      changed: false,
    })
  } finally {
    db.close()
  }
})

test("a running ingestion job cancels open spans and fences its late callback", async () => {
  const db = openDb(":memory:")
  const chunkStarted = deferred()
  const releaseChunk = deferred()
  const startedStages: string[] = []
  const runner: IngestionStageRunner = {
    close: async () => {},
    async run(_document, execution): Promise<void> {
      for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
        await execution.runStage(
          stage,
          {},
          async () => {
            startedStages.push(stage)
            if (stage === "chunk") {
              chunkStarted.resolve()
              await releaseChunk.promise
            }
          },
          () => ({ stage })
        )
      }
    },
  }
  const lifecycle = new IngestionLifecycle(db, runner)

  try {
    const submitted = lifecycle.submit({ title: "Cancel running", content: "content" })
    const running = lifecycle.runNext()
    await chunkStarted.promise

    assert.equal(lifecycle.cancel(submitted.docId)?.status, "cancelled")
    const cancelled = lifecycle.getStatus(submitted.docId)
    assert.equal(cancelled?.task?.status, "cancelled")
    assert.equal(cancelled?.documentStatus, "cancelled")
    assert.equal(cancelled?.spanTree[0].span.status, "cancelled")
    assert.deepEqual(
      cancelled?.spanTree[0].children.map(({ span }) => span.status),
      ["cancelled", "cancelled", "cancelled", "cancelled"]
    )

    releaseChunk.resolve()
    const result = await running
    assert.equal(result?.success, false)
    assert.equal(result?.cancelled, true)
    assert.deepEqual(startedStages, ["chunk"])
    assert.equal(lifecycle.getStatus(submitted.docId)?.task?.status, "cancelled")
    assert.equal(lifecycle.cancel(submitted.docId)?.changed, false)
  } finally {
    db.close()
  }
})

test("cancellation wins when it races failure persistence", async (t) => {
  for (const failCount of [0, 3]) {
    await t.test(`after ${failCount} recorded failures`, async () => {
      const db = openDb(":memory:")
      const runner: IngestionStageRunner = {
        close: async () => {},
        async run(): Promise<void> {
          throw new Error("adapter failed")
        },
      }
      const lifecycle = new IngestionLifecycle(db, runner)

      try {
        const submitted = lifecycle.submit({ title: "Cancel race", content: "content" })
        if (submitted.status !== "pending") assert.fail("expected queued ingestion")
        db.prepare("UPDATE task_pending_ops SET fail_count = ? WHERE id = ?")
          .run(failCount, submitted.taskId)

        // Reproduce another connection committing cancellation after the failure
        // path reads the task but before its fenced write reaches SQLite.
        db.exec(`CREATE TRIGGER cancel_before_failure_persistence
          BEFORE UPDATE OF status ON processing_spans
          WHEN NEW.status IN ('failed', 'skipped')
            AND OLD.status IN ('running', 'pending')
          BEGIN
            UPDATE task_pending_ops
            SET status = 'cancelled', claimed_at = NULL, next_attempt_at = NULL
            WHERE doc_id = OLD.doc_id AND status = 'running';
            UPDATE documents
            SET status = 'cancelled'
            WHERE doc_id = OLD.doc_id;
            UPDATE processing_spans
            SET status = 'cancelled', finished_at = '2026-07-15T00:00:00.000Z', duration_ms = 0
            WHERE doc_id = OLD.doc_id AND status IN ('pending', 'running');
            SELECT RAISE(IGNORE);
          END`)

        const result = await lifecycle.runNext()
        assert.equal(result?.cancelled, true)
        assert.equal(lifecycle.getStatus(submitted.docId)?.task?.status, "cancelled")
        assert.equal(lifecycle.getStatus(submitted.docId)?.documentStatus, "cancelled")
        assert.equal(lifecycle.getDeadLetter(submitted.taskId), null)
      } finally {
        db.close()
      }
    })
  }
})

test("raw file submissions hash and persist the original bytes", async () => {
  const db = openDb(":memory:")
  const rawContent = Buffer.from([0x00, 0xff, 0x41, 0x42])
  let observedRawContent: Buffer | null | undefined
  const runner: IngestionStageRunner = {
    close: async () => {},
    async run(document, execution): Promise<void> {
      observedRawContent = document.rawContent
      for (const stage of ["chunk", "wikify", "storeChunks", "storeGraph"] as const) {
        await execution.runStage(stage, {}, async () => undefined, () => ({ stage }))
      }
    },
  }
  const lifecycle = new IngestionLifecycle(db, runner)

  try {
    const submitted = lifecycle.submit({
      title: "Binary policy",
      content: "",
      rawContent,
      fileName: "policy.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      parserOverride: "markitdown",
      sourceIdentity: {
        kind: "file",
        uriOrExternalId: "C:/knowledge/policy.docx",
        namespace: "local",
      },
    })
    assert.equal((await lifecycle.runNext())?.success, true)
    assert.deepEqual(observedRawContent, rawContent)
    assert.equal(
      lifecycle.getStatus(submitted.docId)?.documentVersion.contentHash,
      createHash("sha256").update(rawContent).digest("hex")
    )

    const stored = db.prepare(
      "SELECT raw_content, file_name, mime_type, parser_override FROM documents WHERE doc_id = ?"
    ).get(submitted.docId) as {
      raw_content: Buffer
      file_name: string
      mime_type: string
      parser_override: string
    }
    assert.deepEqual(stored.raw_content, rawContent)
    assert.equal(stored.file_name, "policy.docx")
    assert.equal(stored.mime_type, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    assert.equal(stored.parser_override, "markitdown")

    assert.equal(
      lifecycle.submit({
        title: "Binary policy renamed",
        content: "",
        rawContent,
        fileName: "policy.docx",
        sourceIdentity: {
          kind: "file",
          uriOrExternalId: "C:/knowledge/policy.docx",
          namespace: "local",
        },
      }).status,
      "unchanged"
    )
  } finally {
    db.close()
  }
})

test("cancelling through another lifecycle aborts the running parser signal", async () => {
  const db = openDb(":memory:")
  const started = deferred()
  let observedAbort = false
  const runner: IngestionStageRunner = {
    close: async () => {},
    async run(_document, execution): Promise<void> {
      await execution.runStage(
        "chunk",
        {},
        () => new Promise<void>((_resolve, reject) => {
          started.resolve()
          execution.signal.addEventListener("abort", () => {
            observedAbort = true
            reject(new Error("parser cancelled"))
          }, { once: true })
        }),
        () => ({})
      )
    },
  }
  const workerLifecycle = new IngestionLifecycle(db, runner)
  const apiLifecycle = new IngestionLifecycle(db, runner)

  try {
    const submitted = workerLifecycle.submit({
      title: "Cancellable raw file",
      content: "",
      rawContent: Buffer.from("raw"),
      fileName: "policy.docx",
    })
    const running = workerLifecycle.runNext()
    await started.promise
    assert.equal(apiLifecycle.cancel(submitted.docId)?.status, "cancelled")
    const result = await running

    assert.equal(observedAbort, true)
    assert.equal(result?.cancelled, true)
  } finally {
    db.close()
  }
})
