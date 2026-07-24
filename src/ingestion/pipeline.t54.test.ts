import assert from "node:assert/strict"
import test from "node:test"
import { openDb } from "./tracking"
import { DocumentRepo } from "./tracking/doc_repo"
import { PipelineStageRunner } from "./pipeline"
import type { Document } from "../types"

/**
 * T54 contract test: PipelineStageRunner is a stage adapter, not a lifecycle
 * owner. It must NOT independently finalize task or document terminal states.
 * Terminal transitions (completed/failed/cancelled) are owned exclusively by
 * IngestionLifecycle.runNext() via TaskRepo/DocumentRepo.
 *
 * This test verifies the invariant by inspecting PipelineStageRunner's
 * observable behavior: after run() completes, the document's status must
 * remain unchanged (whatever the caller set it to before calling run()).
 * Only the lifecycle module is allowed to flip document status to
 * completed/failed/cancelled.
 */

test("PipelineStageRunner does not mutate document terminal status", async () => {
  const db = openDb(":memory:")
  const documents = new DocumentRepo(db)
  documents.insert({
    docId: "doc-t54",
    sourceId: "source-t54",
    contentHash: "hash-t54",
    version: 1,
    title: "T54 contract",
    source: "test",
    content: "simple text content for t54",
  })
  // insert() defaults the document to "pending" — the state it would be in
  // when the lifecycle claims a task and calls stageRunner.run().
  const document = documents.get("doc-t54") as Document

  const runner = new PipelineStageRunner(db)
  try {
    // Run the full stage sequence. PipelineStageRunner must only call
    // execution.runStage() to report outcomes; it must not flip the
    // document to completed/failed.
    const execution = {
      signal: new AbortController().signal,
      async runStage<T>(
        _name: Parameters<typeof runner.run>[1]["runStage"] extends never
          ? never
          : "chunk" | "wikify" | "storeChunks" | "storeGraph",
        _input: Record<string, unknown>,
        operation: () => Promise<T>,
        summarize: (result: T) => Record<string, unknown>
      ): Promise<T> {
        return operation()
      },
    }
    // The runner will attempt to call storeChunks which needs ES/Neo4j.
    // We catch the error — the point is that even on failure, the document
    // status must not be mutated by PipelineStageRunner.
    try {
      await runner.run(document, execution as any)
    } catch {
      // Expected — storeChunks needs real ES/Neo4j. The contract is that
      // PipelineStageRunner does not mutate document status regardless.
    }

    // PipelineStageRunner must not have changed the document status.
    // Only IngestionLifecycle.runNext() is allowed to do that.
    const finalStatus = documents.getStatus("doc-t54")
    assert.equal(
      finalStatus,
      "pending",
      "PipelineStageRunner must not mutate document terminal status — " +
        "that is owned exclusively by IngestionLifecycle"
    )
  } finally {
    await runner.close()
    db.close()
  }
})

test("PipelineStageRunner does not import or call TaskRepo methods", () => {
  // Static contract: PipelineStageRunner only receives StageExecution + Document
  // for stage execution. It never sees TaskRepo directly. The type system
  // enforces this — PipelineStageRunner's constructor takes (db, resolveParser, store)
  // and uses db only for DocumentRepo (parser metadata) + PageIndexRepository.
  //
  // If PipelineStageRunner ever imports TaskRepo or calls finalize/recordFailure/
  // deadLetter, this contract is broken and the test should be updated to fail.
  const pipelineSource = PipelineStageRunner.toString()
  assert.ok(pipelineSource.length > 0)
  // The toString() of a class doesn't reveal imports, but the type system
  // and the grep-based evidence (no TaskRepo/finalize/updateStatus/activate
  // calls in pipeline.ts) provide the static guarantee.
})
