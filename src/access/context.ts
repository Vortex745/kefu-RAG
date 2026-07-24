/**
 * Ticket 05 P1: Access Context — the request-level identity envelope that
 * flows through Answer runs, Ingestion tasks, and (future) Handoff/Feedback.
 *
 * The composition root produces exactly one AccessContext per request via
 * `createAccessContext`. In `single_tenant` mode (the default) the context
 * is deterministic and does NOT trust caller-supplied tenant fields. In
 * `enforced` mode an identity adapter is required (wired in Ticket 05 P4);
 * without one the factory fails closed.
 *
 * Reference: Ticket 60 §5, Ticket 05 acceptance criteria #1, #2, #8.
 */

/** Scopes granted to a request. Chat requires `chat`; ingestion, review,
 * and retirement require `ingest`, `review`, and `admin` respectively. */
export type Scope = "chat" | "ingest" | "review" | "admin"

/** Request-level identity envelope. Bound to exactly one Tenant and subject. */
export interface AccessContext {
  tenantId: string
  subjectId: string
  groups: string[]
  scopes: Scope[]
}

/** Deterministic single-tenant identity. Never caller-supplied. */
export const SINGLE_TENANT_TENANT = "default"
export const SINGLE_TENANT_SUBJECT = "local"

/** All local scopes — granted unconditionally in single-tenant mode. */
export const ALL_LOCAL_SCOPES: Scope[] = ["chat", "ingest", "review", "admin"]

/**
 * Produce the deterministic single-tenant AccessContext. This is a pure
 * function with no inputs — caller-supplied tenant fields cannot leak in.
 */
export function singleTenantAccessContext(): AccessContext {
  return {
    tenantId: SINGLE_TENANT_TENANT,
    subjectId: SINGLE_TENANT_SUBJECT,
    groups: [],
    scopes: [...ALL_LOCAL_SCOPES],
  }
}

export type AccessContextOptions =
  | { mode: "single_tenant" }
  | { mode: "enforced" }

/**
 * Produce an AccessContext for a request.
 *
 * - `single_tenant` (default): returns the deterministic context. Does not
 *   trust caller-supplied tenant fields — the factory accepts none.
 * - `enforced`: requires an identity adapter (Ticket 05 P4). Without one
 *   the factory throws — this is the fail-closed guarantee so that a
 *   misconfigured enforced deployment never silently degrades to
 *   single-tenant semantics.
 */
export function createAccessContext(options: AccessContextOptions): AccessContext {
  if (options.mode === "single_tenant") {
    return singleTenantAccessContext()
  }
  // enforced — identity adapter wiring is Ticket 05 P4. Fail closed rather
  // than silently falling back to single-tenant semantics.
  throw new Error(
    "enforced mode requires an identity adapter (not yet implemented — Ticket 05 P4)"
  )
}

/**
 * Ticket 05 P4 + Ticket 05 (jose): Identity adapter contract. In enforced mode,
 * the composition root injects an adapter that produces an AccessContext per
 * request, or `null` when identity is missing/invalid (→ 401).
 *
 * The contract is ASYNC so that adapters can perform remote JWKS fetch /
 * signature verification (jose `jwtVerify` is async). The middleware must
 * `await adapter.resolve(req)`.
 */
export interface IdentityAdapter {
  resolve(req: unknown): Promise<AccessContext | null>
}

/**
 * Ticket 05 P4 / P5.2: Startup fail-closed gate. The composition root
 * (index.ts main()) calls this with the loaded AppConfig. If `accessMode`
 * is `enforced` and no `adapter` is supplied, the function throws — this
 * guarantees a misconfigured enforced deployment never silently degrades
 * to single-tenant semantics at runtime. P5.2 wires the concrete adapter
 * (`OidcIdentityAdapter`), so enforced mode + adapter passes the startup
 * gate; the runtime fail-closed path still lives in `createAccessMiddleware`
 * (enforced + no adapter → 401 for every request).
 *
 * Reference: Ticket 05 acceptance criterion #2.
 */
export function validateAccessMode(config: {
  accessMode: "single_tenant" | "enforced"
  adapter?: IdentityAdapter
}): void {
  if (config.accessMode === "enforced" && !config.adapter) {
    throw new Error(
      "enforced mode requires an identity adapter (not yet wired — Ticket 05 P4)"
    )
  }
}
