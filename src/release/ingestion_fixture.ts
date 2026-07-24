// Ticket 18 — Revision-scoped ingestion fixture.
//
// Spec issue #18: Create a revision-scoped ingestion fixture that ingests
// bounded synthetic knowledge through the public lifecycle into a tenant,
// SQLite database, and search namespace derived from the trusted revision,
// without touching production tenant data.
//
// Design (karpathy-guidelines):
//   - Simplest viable shape: a thin wrapper around IngestionLifecycle that
//     derives an isolated tenantId + searchNamespace from the repository
//     revision, opens an in-memory SQLite database, and rewrites the
//     SCHEMA-DEFAULT 'default' tenant_id to the derived acceptance tenant
//     after each ingest so the fixture never touches production tenant data.
//   - No new abstractions: the fixture exposes the real IngestionLifecycle
//     (callers run runNext/getStatus/cancel directly). The fixture only owns
//     tenant isolation, evidence redaction, and cleanup.
//   - Evidence records ONLY resource identifiers (tenantId, docIds, sourceIds,
//     version metadata). Source content, rawContent, credentials, tokens, and
//     authorization material are NEVER included — operators can safely share
//     evidence for cleanup without leaking synthetic input.
//   - Cleanup is idempotent and ordered: lifecycle.close() (lets stage runners
//     release resources) → db.close() (releases the in-memory database).

import type { IngestionLifecycle, IngestionStageRunner, IngestionSubmission } from "../ingestion/lifecycle"
import { createIngestionLifecycle } from "../ingestion/pipeline"
import { openDb, type DB } from "../ingestion/tracking/db"
import type { ActivationMode } from "../types/governance"

// ---------------------------------------------------------------------------
// Revision derivation
// ---------------------------------------------------------------------------

const ACCEPTANCE_PREFIX = "acceptance-"
const TENANT_ID_LENGTH = 12
const MIN_REVISION_LENGTH = 12

/**
 * Derive the acceptance-scoped tenantId from a trusted repository revision.
 *
 * The revision is sanitized to alphanumeric characters only (so special chars
 * in a real git SHA or branch name cannot leak into the tenant identifier),
 * then truncated to {@link TENANT_ID_LENGTH} characters and prefixed with
 * `acceptance-`. The result is stable for a given revision and distinct
 * across revisions — operators can identify acceptance tenants at a glance
 * and know they never collide with the production `default` tenant.
 *
 * Throws if the sanitized revision is shorter than {@link MIN_REVISION_LENGTH}
 * — short revisions would risk collision and indicate an upstream configuration
 * error (a real git SHA is 40 hex chars).
 */
export function deriveTenantId(revision: string): string {
  if (!revision) {
    throw new Error("revision is required (non-empty)")
  }
  const sanitized = revision.replace(/[^a-zA-Z0-9]/g, "")
  if (sanitized.length < MIN_REVISION_LENGTH) {
    throw new Error(
      `revision is too short after sanitization: need at least ${MIN_REVISION_LENGTH} alphanumeric chars, got ${sanitized.length}`
    )
  }
  return ACCEPTANCE_PREFIX + sanitized.slice(0, TENANT_ID_LENGTH)
}

/**
 * Derive the acceptance-scoped search namespace from a trusted repository
 * revision.
 *
 * The search namespace mirrors the tenant boundary so acceptance traffic
 * cannot cross-contaminate production search indices. The derivation is
 * identical to {@link deriveTenantId} — one revision maps to exactly one
 * (tenantId, searchNamespace) pair.
 */
export function deriveSearchNamespace(revision: string): string {
  return deriveTenantId(revision)
}

// ---------------------------------------------------------------------------
// Default stage runner
// ---------------------------------------------------------------------------

const DEFAULT_STAGE_NAMES = ["chunk", "wikify", "storeChunks", "storeGraph"] as const

/**
 * Default no-op stage runner used when callers don't supply a custom one.
 * Each stage succeeds with an empty result — sufficient for exercising the
 * lifecycle state machine without wiring real chunking/embedding stores.
 */
const DEFAULT_STAGE_RUNNER: IngestionStageRunner = {
  async close() {},
  async run(_document, execution) {
    for (const stage of DEFAULT_STAGE_NAMES) {
      await execution.runStage(stage, {}, async () => undefined, () => ({ stage }))
    }
  },
}

// ---------------------------------------------------------------------------
// Fixture types
// ---------------------------------------------------------------------------

export interface CreateIngestionFixtureInput {
  revision: string
  activationMode?: ActivationMode
  stageRunner?: IngestionStageRunner
}

export interface IngestBoundedInput {
  title: string
  content: string
  /**
   * Optional per-document source key. When supplied, the source identity
   * becomes `acceptance:${tenantId}:${sourceKey}` so each document maps to
   * its OWN source (each version 1, each independently active) — needed when
   * a caller ingests multiple semantically-distinct documents (e.g. the
   * Ticket 19 hybrid retrieval probe ingests "Return Policy" + "Shipping
   * Policy" as two independent active docs, not as stacked versions of one
   * source). When omitted, behavior is unchanged: all submits map to the
   * same source `acceptance:${tenantId}` and stack as successive versions
   * (Ticket 18 idempotency + failed-replacement semantics rely on this).
   */
  sourceKey?: string
}

export interface IngestionFixtureEvidence {
  tenantId: string
  searchNamespace: string
  revision: string
  sqlitePath: string
  activationMode: ActivationMode
  docIds: string[]
  sourceIds: string[]
  versions: Array<{
    docId: string
    version: number
    active: boolean
    status: string
  }>
  generatedAt: string
}

export interface IngestionFixture {
  readonly tenantId: string
  readonly searchNamespace: string
  readonly revision: string
  readonly lifecycle: IngestionLifecycle
  /**
   * The isolated in-memory SQLite database. Exposed so acceptance tests can
   * construct auxiliary stores (e.g. SqliteCandidateReviewStore) that share
   * the fixture's transactional boundary.
   */
  readonly db: DB
  ingestBounded(input: IngestBoundedInput): IngestionSubmission
  evidence(): IngestionFixtureEvidence
  cleanup(): Promise<void>
}

// ---------------------------------------------------------------------------
// Fixture factory
// ---------------------------------------------------------------------------

/**
 * Create a revision-scoped ingestion fixture backed by an isolated in-memory
 * SQLite database.
 *
 * The fixture derives a tenantId and searchNamespace from the supplied
 * revision. Every {@link IngestionFixture.ingestBounded} call rewrites the
 * SCHEMA-DEFAULT 'default' tenant_id to the derived acceptance tenantId on
 * any source/document rows touched by the call — the production `default`
 * tenant is never populated.
 *
 * Callers run the real IngestionLifecycle (runNext/getStatus/cancel) directly
 * via {@link IngestionFixture.lifecycle}. Evidence is available via
 * {@link IngestionFixture.evidence} and contains only resource identifiers
 * for operator cleanup — never source content or credentials.
 *
 * Always call {@link IngestionFixture.cleanup} in a `finally` block to
 * release the in-memory database and any resources held by the stage runner.
 */
export function createIngestionFixture(input: CreateIngestionFixtureInput): IngestionFixture {
  if (!input.revision) {
    throw new Error("revision is required (non-empty)")
  }

  const tenantId = deriveTenantId(input.revision)
  const searchNamespace = deriveSearchNamespace(input.revision)
  const activationMode: ActivationMode = input.activationMode ?? "auto"
  const stageRunner = input.stageRunner ?? DEFAULT_STAGE_RUNNER

  const db = openDb(":memory:")
  // Go through the factory (not direct construction) so the P6.2 caller audit
  // holds: the factory remains the single entry point for IngestionLifecycle
  // construction. The overrides let the fixture exercise the lifecycle under
  // a controlled activation mode and stage runner without touching production
  // config or external services.
  const lifecycle = createIngestionLifecycle(db, {
    stageRunner,
    activationMode,
    now: () => new Date(),
  })

  function rewriteDefaultTenantId(): void {
    // Acceptance isolation boundary: the sources/documents schema defaults
    // tenant_id to 'default' (the production tenant). Immediately after each
    // submit we rewrite every 'default' row to the revision-derived tenantId
    // so the fixture never touches production tenant data. This is safe because
    // the fixture's db is a fresh in-memory instance — every row belongs to
    // this fixture.
    const now = new Date().toISOString()
    db.prepare(
      `UPDATE sources SET tenant_id = ?, updated_at = ? WHERE tenant_id = 'default'`
    ).run(tenantId, now)
    db.prepare(
      `UPDATE documents SET tenant_id = ?, updated_at = ? WHERE tenant_id = 'default'`
    ).run(tenantId, now)
  }

  function ingestBounded(boundedInput: IngestBoundedInput): IngestionSubmission {
    if (!boundedInput.title || !boundedInput.content) {
      throw new Error("title and content are required")
    }

    // The source identity is anchored to the acceptance tenant so re-ingests
    // of the same content resolve to the same source row (idempotent
    // re-runs per spec acceptance criterion #2). When `sourceKey` is
    // supplied, it is appended to the uri so each document maps to its
    // own source (each version 1, each independently active) — used by
    // callers ingesting multiple semantically-distinct documents.
    const uriOrExternalId = boundedInput.sourceKey
      ? `acceptance:${tenantId}:${boundedInput.sourceKey}`
      : `acceptance:${tenantId}`
    const submission = lifecycle.submit({
      title: boundedInput.title,
      content: boundedInput.content,
      sourceIdentity: {
        kind: "submission",
        uriOrExternalId,
        namespace: searchNamespace,
      },
    })

    rewriteDefaultTenantId()
    return submission
  }

  function evidence(): IngestionFixtureEvidence {
    // SELECT only resource identifiers — NEVER content, raw_content, title,
    // metadata, or any column that could carry source input. This is the
    // defense-in-depth boundary: even if a future schema migration adds a
    // sensitive column, this query won't include it.
    const docRows = db.prepare(
      `SELECT doc_id, version, status FROM documents ORDER BY created_at ASC, doc_id ASC`
    ).all() as Array<{ doc_id: string; version: number; status: string }>

    const sourceRows = db.prepare(
      `SELECT DISTINCT source_id FROM documents WHERE source_id IS NOT NULL ORDER BY source_id ASC`
    ).all() as Array<{ source_id: string }>

    const activeRows = db.prepare(
      `SELECT active_doc_id FROM sources WHERE active_doc_id IS NOT NULL`
    ).all() as Array<{ active_doc_id: string }>
    const activeSet = new Set(activeRows.map((r) => r.active_doc_id))

    return {
      tenantId,
      searchNamespace,
      revision: input.revision,
      sqlitePath: ":memory:",
      activationMode,
      docIds: docRows.map((r) => r.doc_id),
      sourceIds: sourceRows.map((r) => r.source_id),
      versions: docRows.map((r) => ({
        docId: r.doc_id,
        version: r.version,
        active: activeSet.has(r.doc_id),
        status: r.status,
      })),
      generatedAt: new Date().toISOString(),
    }
  }

  async function cleanup(): Promise<void> {
    // Ordered shutdown: stage runner first (lets ES/Neo4j/OpenAI clients
    // release), then the in-memory database. Idempotent — calling cleanup
    // twice is a no-op because better-sqlite3 treats double-close as a no-op
    // when the db is already closed (it throws on use-after-close, not on
    // double-close).
    await lifecycle.close()
    db.close()
  }

  return {
    tenantId,
    searchNamespace,
    revision: input.revision,
    lifecycle,
    db,
    ingestBounded,
    evidence,
    cleanup,
  }
}
