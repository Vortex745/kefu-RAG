import { randomUUID } from "node:crypto"
import type { DB } from "../ingestion/tracking/db"
import type {
  SourceLifecycleState,
  SourceTombstone,
} from "../types/governance"

/**
 * Ticket 11 Phase E P2 (spec §11 L1571-1578, L1593): SourceLifecycleStore.
 *
 * Persists Source lifecycle state transitions and tombstone audit records.
 * Three invariants mandated by spec §11:
 *
 * 1. State machine (L1573, L1593) — legal transitions:
 *      active → quarantined         (start investigation)
 *      active → retired              (direct retirement)
 *      quarantined → active          (manual un-quarantine)
 *      quarantined → retired         (escalate to retirement)
 *    `retired` is terminal — spec L1593 forbids reactivating a retired Source.
 *    Same-state transitions (active→active) throw — the HTTP layer must
 *    implement idempotency by checking current state first, NOT by relying
 *    on the store to silently no-op.
 *
 * 2. Cross-tenant isolation (L1582) — every read/write is scoped by
 *    tenant_id. A source/tombstone that exists for a different tenant is
 *    indistinguishable from a non-existent one (returns null → HTTP 404),
 *    so the store never reveals that a cross-tenant resource exists.
 *
 * 3. Tombstones are append-only audit records (L1578) — createTombstone
 *    always inserts a new row; rows are never modified or deleted. The
 *    most recent tombstone (by retired_at DESC) is returned by
 *    getLatestTombstone. Multiple tombstones for the same Source model
 *    successive retirement events over the Source's lifetime.
 *
 * Reference: Ticket 09 SqliteHandoffStore (same Store pattern).
 */

export interface SourceLifecycleEntry {
  sourceId: string
  tenantId: string
  lifecycleState: SourceLifecycleState
  updatedAt: string
}

export interface TombstoneCreateInput {
  sourceId: string
  tenantId: string
  retiredVersionIds: string[]
  reason: string
  actor: string
}

export interface SourceLifecycleStore {
  /**
   * Get the lifecycle entry for a Source, scoped to tenantId. Returns null
   * if the source doesn't exist OR belongs to a different tenant
   * (cross-tenant → 404 per spec L1582).
   */
  getSource(sourceId: string, tenantId: string): SourceLifecycleEntry | null

  /**
   * Transition a Source to a new lifecycle state via the legal state
   * machine (spec L1573, L1593). Throws InvalidSourceLifecycleTransitionError
   * for illegal transitions (including same-state and any transition out of
   * `retired`). Returns null if the source doesn't exist OR belongs to a
   * different tenant (cross-tenant → 404 per spec L1582). Returns the
   * updated entry on success.
   *
   * The HTTP layer (P5) implements idempotency for POST /retire by checking
   * current state first — if already `retired`, return 200 without calling
   * transition(). The store does NOT silently no-op same-state transitions.
   */
  transition(
    sourceId: string,
    tenantId: string,
    target: SourceLifecycleState
  ): SourceLifecycleEntry | null

  /**
   * Append a new tombstone record (spec L1578). Tombstones are append-only —
   * this method always inserts a new row. The `retiredAt` and `createdAt`
   * timestamps are populated from the store's clock (now()). The tombstoneId
   * is a fresh UUID. Returns the created SourceTombstone.
   *
   * Note: createTombstone does NOT verify that the source exists or belongs
   * to the given tenant — the caller (RetirementService, P4) is responsible
   * for getSource() first. This keeps tombstone creation independent of
   * source state, which matters for audit trails where the source row may
   * have been deleted physically (per retention policy, L1578).
   */
  createTombstone(input: TombstoneCreateInput): SourceTombstone

  /**
   * Get the most recent tombstone for a Source, scoped to tenantId. Returns
   * null if no tombstone exists OR the latest tombstone belongs to a
   * different tenant (cross-tenant → 404 / null in the status summary per
   * spec L1582). Ordered by retired_at DESC, then created_at DESC.
   */
  getLatestTombstone(sourceId: string, tenantId: string): SourceTombstone | null
}

/**
 * Thrown when transition() requests a transition that is not in the legal
 * state machine (spec L1573, L1593). Carries from/to state so the HTTP
 * handler (P5) can surface them in the 409 response body.
 */
export class InvalidSourceLifecycleTransitionError extends Error {
  constructor(
    public readonly fromState: SourceLifecycleState,
    public readonly toState: SourceLifecycleState
  ) {
    super(`Invalid source lifecycle transition: ${fromState} → ${toState}`)
    this.name = "InvalidSourceLifecycleTransitionError"
  }
}

/**
 * Legal state transitions per spec L1573, L1593:
 *   active → quarantined, retired
 *   quarantined → active, retired
 *   retired → (none, terminal)
 * Same-state transitions are NOT listed — they throw (strict state machine).
 * The HTTP layer implements idempotency by checking current state first.
 */
const VALID_TRANSITIONS: Record<SourceLifecycleState, SourceLifecycleState[]> = {
  active: ["quarantined", "retired"],
  quarantined: ["active", "retired"],
  retired: [],
}

interface StoredSource {
  source_id: string
  tenant_id: string
  lifecycle_state: string
  updated_at: string
}

interface StoredTombstone {
  tombstone_id: string
  source_id: string
  tenant_id: string
  retired_version_ids: string
  reason: string
  actor: string
  retired_at: string
  created_at: string
}

function rowToEntry(row: StoredSource): SourceLifecycleEntry {
  return {
    sourceId: row.source_id,
    tenantId: row.tenant_id,
    lifecycleState: row.lifecycle_state as SourceLifecycleState,
    updatedAt: row.updated_at,
  }
}

function rowToTombstone(row: StoredTombstone): SourceTombstone {
  return {
    tombstoneId: row.tombstone_id,
    sourceId: row.source_id,
    tenantId: row.tenant_id,
    retiredVersionIds: JSON.parse(row.retired_version_ids),
    reason: row.reason,
    actor: row.actor,
    retiredAt: row.retired_at,
    createdAt: row.created_at,
  }
}

export class SqliteSourceLifecycleStore implements SourceLifecycleStore {
  constructor(
    private db: DB,
    private now: () => Date = () => new Date()
  ) {}

  getSource(sourceId: string, tenantId: string): SourceLifecycleEntry | null {
    const row = this.db.prepare(
      `SELECT source_id, tenant_id, lifecycle_state, updated_at
       FROM sources WHERE source_id = ? AND tenant_id = ?`
    ).get(sourceId, tenantId) as StoredSource | undefined
    return row ? rowToEntry(row) : null
  }

  transition(
    sourceId: string,
    tenantId: string,
    target: SourceLifecycleState
  ): SourceLifecycleEntry | null {
    const existing = this.db.prepare(
      `SELECT source_id, tenant_id, lifecycle_state, updated_at
       FROM sources WHERE source_id = ? AND tenant_id = ?`
    ).get(sourceId, tenantId) as StoredSource | undefined
    if (!existing) return null

    const currentState = existing.lifecycle_state as SourceLifecycleState
    if (!VALID_TRANSITIONS[currentState].includes(target)) {
      throw new InvalidSourceLifecycleTransitionError(currentState, target)
    }

    const updatedAt = this.now().toISOString()
    this.db.prepare(
      `UPDATE sources SET lifecycle_state = ?, updated_at = ?
       WHERE source_id = ? AND tenant_id = ?`
    ).run(target, updatedAt, sourceId, tenantId)
    return rowToEntry({
      ...existing,
      lifecycle_state: target,
      updated_at: updatedAt,
    })
  }

  createTombstone(input: TombstoneCreateInput): SourceTombstone {
    const now = this.now().toISOString()
    const tombstoneId = randomUUID()
    const retiredVersionIdsJson = JSON.stringify(input.retiredVersionIds)
    this.db.prepare(
      `INSERT INTO source_tombstones (
        tombstone_id, source_id, tenant_id, retired_version_ids,
        reason, actor, retired_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      tombstoneId,
      input.sourceId,
      input.tenantId,
      retiredVersionIdsJson,
      input.reason,
      input.actor,
      now,
      now
    )
    return {
      tombstoneId,
      sourceId: input.sourceId,
      tenantId: input.tenantId,
      retiredVersionIds: [...input.retiredVersionIds],
      reason: input.reason,
      actor: input.actor,
      retiredAt: now,
      createdAt: now,
    }
  }

  getLatestTombstone(sourceId: string, tenantId: string): SourceTombstone | null {
    // ORDER BY retired_at DESC, created_at DESC picks the latest tombstone.
    // If two tombstones share the same retired_at (same millisecond), the
    // tiebreaker is created_at — also DESC, so the later insert wins.
    const row = this.db.prepare(
      `SELECT tombstone_id, source_id, tenant_id, retired_version_ids,
              reason, actor, retired_at, created_at
       FROM source_tombstones
       WHERE source_id = ? AND tenant_id = ?
       ORDER BY retired_at DESC, created_at DESC
       LIMIT 1`
    ).get(sourceId, tenantId) as StoredTombstone | undefined
    return row ? rowToTombstone(row) : null
  }
}
