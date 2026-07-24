import type { Request, Response, NextFunction } from "express"
import {
  singleTenantAccessContext,
  type AccessContext,
  type IdentityAdapter,
  type Scope,
} from "../access/context"

/**
 * Ticket 05 P4: Access middleware — the Express-level gate that enforces
 * AccessContext availability and required scope before any route handler
 * runs. Satisfies acceptance criteria #3 (401/403) and #4 (no side effects
 * on rejection — middleware returns before next() so handlers never execute).
 *
 * Mode semantics:
 * - `single_tenant` (default): injects the deterministic AccessContext into
 *   `res.locals.accessContext` and calls next(). No gating — backward
 *   compatible with all existing callers (acceptance #8).
 * - `enforced`: requires an `adapter`. Calls `adapter.resolve(req)`:
 *     - returns null → 401 missing identity
 *     - returns ctx without `requiredScope` → 403 missing scope
 *     - returns ctx with `requiredScope` → injects ctx, calls next()
 *   If `adapter` is absent (misconfigured) every request gets 401 — this is
 *   the runtime fail-closed gate that complements `validateAccessMode`'s
 *   startup gate.
 *
 * Reference: Ticket 60 §5, Ticket 05 acceptance criteria #3, #4, #8.
 */
export interface AccessMiddlewareOptions {
  mode: "single_tenant" | "enforced"
  adapter?: IdentityAdapter
  requiredScope: Scope
}

export function createAccessMiddleware(options: AccessMiddlewareOptions) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (options.mode === "single_tenant") {
      res.locals.accessContext = singleTenantAccessContext()
      next()
      return
    }

    // enforced — adapter is required at runtime
    const adapter = options.adapter
    if (!adapter) {
      res.status(401).json({ error: "missing identity" })
      return
    }

    const ctx: AccessContext | null = await adapter.resolve(req)
    if (!ctx) {
      res.status(401).json({ error: "missing identity" })
      return
    }

    if (!ctx.scopes.includes(options.requiredScope)) {
      res.status(403).json({ error: `missing scope: ${options.requiredScope}` })
      return
    }

    res.locals.accessContext = ctx
    next()
  }
}
