import type { AccessContext } from "../access/context"

/**
 * P2.1 — Graph Retrieval ACL Predicate Contract
 *
 * Audit finding (issue 03 — close graph retrieval authorization bypass):
 * The primary graph path applies `accessContextFilter` +
 * `filterProvenanceByAccessContext` + `activeTermsFilter`, but the fallback
 * ES recheck (when graph provenance is empty) omits the ACL filter entirely
 * — see `GRAPH_RETRIEVAL_FALLBACK_BYPASS` below. This module defines the
 * UNIFIED ACL predicate that ALL graph retrieval callers must satisfy
 * before a candidate becomes Evidence.
 *
 * P2.1 scope (this module):
 *   - Static caller audit (every production caller of graph retrieval)
 *   - Predicate contract (tenant + group + active-version)
 *   - Fail-closed semantics for legacy untagged candidates
 *
 * P2.2 scope (next item, not this one):
 *   - Wire enforcement of this predicate into the fallback path and every
 *     caller listed in `GRAPH_RETRIEVAL_CALLER_AUDIT`.
 */

/**
 * A candidate for ACL authorization. Shape covers Chunk, provenance records,
 * and RetrievalResult.chunk projections — the predicate is shape-agnostic so
 * it can be applied at any stage (provenance filter, ES recheck, post-fetch
 * defense-in-depth).
 */
export interface GraphAclCandidate {
  /**
   * Tenant tag. Undefined = legacy/untagged candidate. The predicate FAILS
   * CLOSED for untagged candidates when an AccessContext is present — this
   * is the key fix for the audit finding (legacy 2-element provenance must
   * not silently pass the app-layer ACL gate).
   */
  tenantId?: string
  /**
   * Group ACL. Empty/undefined = tenant-wide candidate (visible to all
   * same-tenant callers). Non-empty = visible only to callers whose
   * `accessContext.groups` intersects.
   */
  allowedGroups?: string[]
  /** Document ID — must be in the active-version set. */
  documentId: string
}

/** ACL predicate — returns true when the candidate is authorized. */
export type GraphRetrievalAclPredicate = (candidate: GraphAclCandidate) => boolean

/** Authorization denial reason (for fixture assertions and audit). */
export type GraphAclDenialReason =
  | "missing_tenant_tag"
  | "cross_tenant"
  | "group_not_authorized"
  | "inactive_version"

export interface GraphAclDecision {
  authorized: boolean
  reason?: GraphAclDenialReason
}

/**
 * Create the unified graph retrieval ACL predicate for a given AccessContext
 * and active-version set.
 *
 * Semantics (spec §6, unifying `accessContextFilter` +
 * `filterProvenanceByAccessContext` + `activeTermsFilter`, with fail-closed
 * for legacy untagged candidates):
 *
 * 1. Tenant (hard): `candidate.tenantId` MUST equal `accessContext.tenantId`.
 *    - Undefined tenantId → DENY (`missing_tenant_tag`) — fail closed for
 *      legacy. This closes the bypass where untagged provenance passed
 *      through the app-layer filter to a fallback ES query that had no ACL.
 *    - Mismatched tenantId → DENY (`cross_tenant`).
 *
 * 2. Group (intersect): when `accessContext.groups` is non-empty, candidate
 *    is visible when its `allowedGroups` is empty (tenant-wide chunk) OR
 *    intersects `accessContext.groups`.
 *    - Non-empty candidate groups with no intersection → DENY
 *      (`group_not_authorized`).
 *    - When `accessContext.groups` is empty (tenant-wide user) → all
 *      same-tenant candidates visible (no group filter).
 *
 * 3. Active version: `candidate.documentId` MUST be in `activeDocIds`.
 *    - Missing → DENY (`inactive_version`).
 *    - When `activeDocIds` is empty (no active version repo wired) → all
 *      versions pass (backward compat with single-tenant / no-repo callers).
 */
export function createGraphRetrievalAclPredicate(
  accessContext: AccessContext,
  activeDocIds: ReadonlySet<string>
): GraphRetrievalAclPredicate {
  return (candidate) =>
    evaluateGraphAcl(candidate, accessContext, activeDocIds).authorized
}

/**
 * Evaluate the ACL predicate and return a structured decision. Used by the
 * fixture (P2.1) and by enforcement points (P2.2) that need the denial
 * reason for audit logging.
 */
export function evaluateGraphAcl(
  candidate: GraphAclCandidate,
  accessContext: AccessContext,
  activeDocIds: ReadonlySet<string>
): GraphAclDecision {
  // 1. Tenant — hard filter, fail closed for untagged.
  if (candidate.tenantId === undefined) {
    return { authorized: false, reason: "missing_tenant_tag" }
  }
  if (candidate.tenantId !== accessContext.tenantId) {
    return { authorized: false, reason: "cross_tenant" }
  }

  // 2. Group — intersect semantics (mirrors accessContextFilter).
  if (accessContext.groups.length > 0) {
    const candidateGroups = candidate.allowedGroups ?? []
    if (candidateGroups.length > 0) {
      const intersects = candidateGroups.some((g) =>
        accessContext.groups.includes(g)
      )
      if (!intersects) {
        return { authorized: false, reason: "group_not_authorized" }
      }
    }
    // Empty candidate groups = tenant-wide chunk → allowed.
  }
  // Empty accessContext.groups = tenant-wide user → all same-tenant allowed.

  // 3. Active version — backward compat: empty set = no filter.
  if (activeDocIds.size > 0 && !activeDocIds.has(candidate.documentId)) {
    return { authorized: false, reason: "inactive_version" }
  }

  return { authorized: true }
}

/**
 * P2.1 Static Caller Audit — ALL production callers of graph retrieval.
 *
 * Each entry records: caller location, whether it propagates
 * `accessContext` to the Searcher, and notes on how it can reach the graph
 * channel. P2.2 enforcement will verify every caller in this table
 * satisfies the unified ACL predicate on every result.
 *
 * The audit is exhaustive over production code paths that can invoke the
 * graph channel (`SearcherImpl.search` with graph in the channel set, or
 * `operations.graphSearch` directly). Test-only callers and ingestion-side
 * Neo4j writes (`src/ingestion/storage/store.ts`, `src/ingestion/cli.ts`)
 * are out of scope — they are not retrieval callers.
 */
export const GRAPH_RETRIEVAL_CALLER_AUDIT = [
  {
    caller: "SearcherImpl.search → operations.graphSearch",
    file: "src/retrieval/search/searcher.ts",
    line: 519,
    propagatesAccessContext: true,
    notes:
      "Primary graph entry. Passes accessContext to graphSearch for provenance filter + ES recheck. Reaches this path whenever 'graph' is in the executed channel set (default all-channels, or graph_navigation tool, or planner path default).",
  },
  {
    caller: "SimpleKnowledgeMastraRunner GATE 1",
    file: "src/mastra/simple_knowledge_runner.ts",
    line: 564,
    propagatesAccessContext: true,
    notes:
      "searcher.search(query, { ...perQueryOptions, accessContext }). perQueryOptions may include channels: ['graph'] via tool_selector graph_navigation; default all-channels includes graph.",
  },
  {
    caller: "SimpleKnowledgeMastraRunner correction retrieval",
    file: "src/mastra/simple_knowledge_runner.ts",
    line: 819,
    propagatesAccessContext: true,
    notes:
      "Correction retrieval after Critic replan produces gap queries. searcher.search(gapQuery, { accessContext }). Default channels include graph — mirrors the complex-runner correction paths (lines 1187/1213) and must fail closed (P2.2).",
  },
  {
    caller: "ComplexKnowledgeMastraRunner GATE 1 (planner path)",
    file: "src/mastra/complex_knowledge_runner.ts",
    line: 774,
    propagatesAccessContext: true,
    notes:
      "searcher.search(rewrittenQueries[i], { ...complexOptions[i], accessContext }). Default channels include graph; complexOptions may carry graphSeeds from planner.navigate.",
  },
  {
    caller: "ComplexKnowledgeMastraRunner correction (path A deterministic fallback)",
    file: "src/mastra/complex_knowledge_runner.ts",
    line: 1187,
    propagatesAccessContext: true,
    notes:
      "Deterministic fallback after complex loop produces 0 new results. searcher.search(gapQuery, { accessContext }). Default channels include graph — this is the fallback path that MUST fail closed (P2.2).",
  },
  {
    caller: "ComplexKnowledgeMastraRunner correction (path B legacy)",
    file: "src/mastra/complex_knowledge_runner.ts",
    line: 1213,
    propagatesAccessContext: true,
    notes:
      "Legacy single searcher.search per gap query when complexLoopController is absent. searcher.search(gapQuery, { accessContext }). Default channels include graph.",
  },
  {
    caller: "runComplexLoop tool execution",
    file: "src/retrieval/complex_loop.ts",
    line: 530,
    propagatesAccessContext: true,
    notes:
      "deps.searcher.search({ text: args.query }, searchOptions). searchOptions spreads input.accessContext. Tool may be graph_navigation → channels: ['graph'].",
  },
] as const

/**
 * Known fallback path that bypasses ACL (P2.2 enforcement target).
 *
 * `searcher.ts` lines 329-334: when graph provenance is empty (no chunk
 * identities extracted from relations), the ES recheck falls back to a
 * `multi_match` query with `filter: [childFilter()]` only — NO
 * `accessContextFilter` and NO `activeTermsFilter`. This is the
 * authorization bypass identified in audit issue 03.
 *
 * P2.1 records this bypass; P2.2 closes it by requiring the fallback query
 * to apply the same ACL + active-version filters as the primary path.
 */
export const GRAPH_RETRIEVAL_FALLBACK_BYPASS = {
  file: "src/retrieval/search/searcher.ts",
  lines: [329, 334] as const,
  description:
    "Fallback ES query omits accessContextFilter and activeTermsFilter when provenance is empty",
  enforcementItem: "P2.2",
} as const
