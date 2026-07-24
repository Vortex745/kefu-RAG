import type { DB } from "../ingestion/tracking/db"
import { TaskRepo } from "../ingestion/tracking/task_repo"
import type { SourceLifecycleState } from "../types/governance"
import type { SourceLifecycleStore } from "./source_lifecycle_store"

/**
 * Ticket 11 Phase E P4 (spec §11 L1576-1577, L1581): RetirementService.
 *
 * Orchestrates Source retirement in three ordered steps:
 *
 *   1. Transition lifecycle_state to `retired` (spec L1576 "Removes the Source
 *      from active visibility in the authoritative local repository"). This is
 *      the safety gate — once committed, the Source is hidden from retrieval
 *      regardless of what happens next.
 *   2. Append a tombstone audit record (spec L1578) carrying retired version
 *      IDs, reason and actor. Steps 1+2 are wrapped in a single SQLite
 *      transaction so a partial failure (e.g., DB error in step 2) rolls back
 *      the lifecycle transition — otherwise a retry would see the Source as
 *      already retired and skip tombstone creation, breaking the audit trail.
 *   3. Enqueue idempotent cleanup tasks (spec L1576-1577) — one each of
 *      cleanup_es / cleanup_neo4j / cleanup_pageindex / cleanup_images per
 *      retired Document. Cleanup reuses the existing TaskRepo infrastructure
 *      (retry, dead-letter, stale-claim recovery, cancellation, fencing).
 *      Enqueue is idempotent per (docId, op): if ANY task already exists for
 *      that pair (any status), the enqueue is skipped. This makes the whole
 *      retire() call safe to retry after an interruption.
 *
 * Safety property (spec L1577): "External partial failure cannot make retired
 * content queryable again." Step 3 happens AFTER the step 1+2 transaction
 * commits. Even if step 3 fails entirely, the Source is already hidden —
 * cleanup is a best-effort side effect, not a correctness gate.
 *
 * Idempotency (spec L1581): "POST /api/sources/:sourceId/retire ... is
 * idempotent." Re-calling retire() on an already-retired Source:
 *   - Does NOT transition again (transition would throw — retired is terminal)
 *   - Does NOT create a new tombstone (preserves audit integrity — the first
 *     tombstone is the authoritative retirement record)
 *   - Does re-check cleanup tasks and enqueues any missing ones (handles the
 *     case where a previous retire was interrupted between steps 2 and 3)
 *   - Returns RetirementResult with idempotent=true and tombstoneId=""
 *
 * Cross-tenant isolation (spec L1582): retire() is scoped by tenant_id.
 *   Cross-tenant or missing Source → null (404, never reveals existence).
 */

/** The four cleanup op codes mandated by spec L1576. */
export const CLEANUP_OPS = [
  "cleanup_es",
  "cleanup_neo4j",
  "cleanup_pageindex",
  "cleanup_images",
] as const

export interface RetirementResult {
  sourceId: string
  tenantId: string
  /** Always "retired" on a successful retire call. */
  lifecycleState: SourceLifecycleState
  /**
   * Tombstone ID created by this call. Empty string on idempotent re-call
   * (no new tombstone was created).
   */
  tombstoneId: string
  /** Count of NEW cleanup tasks enqueued by this call (idempotent skips). */
  enqueuedCleanupTasks: number
  /** True if the Source was already retired before this call. */
  idempotent: boolean
}

export interface RetirementService {
  /**
   * Retire a Source: hide immediately, append tombstone, enqueue cleanup.
   * Returns null if the Source doesn't exist OR belongs to a different
   * tenant (cross-tenant → 404 per spec L1582). Otherwise returns the
   * retirement result (with idempotent=true if the Source was already retired).
   */
  retire(
    sourceId: string,
    tenantId: string,
    reason: string,
    actor: string
  ): RetirementResult | null
}

export class RetirementServiceImpl implements RetirementService {
  constructor(
    private db: DB,
    private lifecycleStore: SourceLifecycleStore,
    private taskRepo: TaskRepo,
    private now: () => Date = () => new Date()
  ) {}

  retire(
    sourceId: string,
    tenantId: string,
    reason: string,
    actor: string
  ): RetirementResult | null {
    // Step 0: existence check (also cross-tenant gate — getSource returns null
    // for cross-tenant per SourceLifecycleStore's contract).
    const source = this.lifecycleStore.getSource(sourceId, tenantId)
    if (!source) return null

    // Collect retired version IDs for tombstone + cleanup enqueue. Same query
    // in both paths (idempotent and first-time) so the tombstone's
    // retired_version_ids matches the cleanup scope.
    const docIds = this.getDocIdsForSource(sourceId, tenantId)

    if (source.lifecycleState === "retired") {
      // Idempotent path (spec L1581): no new tombstone, no transition, but
      // still enqueue any missing cleanup tasks (handles interrupted prior
      // retire between the transition and the enqueue).
      const enqueued = this.enqueueMissingCleanupTasks(docIds)
      return {
        sourceId,
        tenantId,
        lifecycleState: "retired",
        tombstoneId: "",
        enqueuedCleanupTasks: enqueued,
        idempotent: true,
      }
    }

    // First-time path: atomic transition + tombstone (transaction ensures
    // audit-trail integrity on partial failure).
    const tombstoneId = this.db.transaction(() => {
      // transition() throws on illegal transitions — but we've already
      // checked the source is active or quarantined, both of which can
      // legally transition to retired. So this will not throw.
      this.lifecycleStore.transition(sourceId, tenantId, "retired")
      const tombstone = this.lifecycleStore.createTombstone({
        sourceId,
        tenantId,
        retiredVersionIds: docIds,
        reason,
        actor,
      })
      return tombstone.tombstoneId
    })()

    // Step 3: enqueue cleanup tasks. Outside the transaction — even if this
    // fails, the Source is already retired (safety property, spec L1577).
    const enqueued = this.enqueueMissingCleanupTasks(docIds)

    return {
      sourceId,
      tenantId,
      lifecycleState: "retired",
      tombstoneId,
      enqueuedCleanupTasks: enqueued,
      idempotent: false,
    }
  }

  /**
   * Return all doc_ids belonging to the source (scoped by tenant), ordered
   * by activation_order then doc_id so the tombstone's retired_version_ids
   * array is deterministic.
   */
  private getDocIdsForSource(sourceId: string, tenantId: string): string[] {
    const rows = this.db.prepare(
      `SELECT doc_id FROM documents
       WHERE source_id = ? AND tenant_id = ?
       ORDER BY activation_order ASC, doc_id ASC`
    ).all(sourceId, tenantId) as { doc_id: string }[]
    return rows.map(r => r.doc_id)
  }

  /**
   * For each (docId, op) pair, enqueue a cleanup task if and only if no
   * task already exists for that pair (any status). This is the idempotent
   * enqueue gate (spec L1576 "enqueue idempotent cleanup"). Returns the
   * count of newly enqueued tasks.
   *
   * Idempotency check is "any task exists" rather than "pending/running
   * task exists" so that completed or dead-lettered cleanups are NOT
   * retried by a re-retire call. A dead-lettered cleanup requires manual
   * intervention; silently re-enqueuing would mask the underlying failure.
   */
  private enqueueMissingCleanupTasks(docIds: string[]): number {
    let count = 0
    for (const docId of docIds) {
      for (const op of CLEANUP_OPS) {
        if (this.hasTask(docId, op)) continue
        this.taskRepo.enqueue({ docId, op, payload: {} })
        count++
      }
    }
    return count
  }

  private hasTask(docId: string, op: string): boolean {
    const row = this.db.prepare(
      `SELECT 1 FROM task_pending_ops WHERE doc_id = ? AND op = ? LIMIT 1`
    ).get(docId, op)
    return !!row
  }
}
