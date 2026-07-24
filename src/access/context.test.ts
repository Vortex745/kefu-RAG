import assert from "node:assert/strict"
import test from "node:test"
import {
  singleTenantAccessContext,
  createAccessContext,
  validateAccessMode,
  ALL_LOCAL_SCOPES,
  SINGLE_TENANT_TENANT,
  SINGLE_TENANT_SUBJECT,
} from "./context"

test("Ticket 05 P1: single-tenant mode injects deterministic tenant, subject, empty groups, and all local scopes", () => {
  const ctx = singleTenantAccessContext()
  assert.equal(ctx.tenantId, SINGLE_TENANT_TENANT)
  assert.equal(ctx.subjectId, SINGLE_TENANT_SUBJECT)
  assert.deepEqual(ctx.groups, [])
  assert.deepEqual(ctx.scopes, ALL_LOCAL_SCOPES)
  assert.deepEqual(ctx.scopes, ["chat", "ingest", "review", "admin"])
})

test("Ticket 05 P1: createAccessContext with single_tenant mode returns the deterministic context", () => {
  const ctx = createAccessContext({ mode: "single_tenant" })
  assert.equal(ctx.tenantId, "default")
  assert.equal(ctx.subjectId, "local")
  assert.deepEqual(ctx.groups, [])
  assert.deepEqual(ctx.scopes, ["chat", "ingest", "review", "admin"])
  // The factory is a pure function — no caller inputs are accepted in
  // single-tenant mode, so caller-supplied tenant fields cannot leak in.
  const ctx2 = createAccessContext({ mode: "single_tenant" })
  assert.deepEqual(ctx, ctx2)
})

test("Ticket 05 P1: createAccessContext with enforced mode and no identity adapter fails closed", () => {
  // Enforced mode requires an identity adapter (wired in Ticket 05 P4).
  // Without one, the factory must throw rather than silently fall back to
  // single-tenant semantics — this is the fail-closed guarantee.
  assert.throws(
    () => createAccessContext({ mode: "enforced" }),
    /identity adapter/i,
    "enforced mode without identity adapter must fail closed"
  )
})

test("Ticket 05 P4: validateAccessMode accepts single_tenant (no throw)", () => {
  // single_tenant is the default — must not throw.
  validateAccessMode({ accessMode: "single_tenant" })
})

test("Ticket 05 P4: validateAccessMode throws for enforced (startup fail-closed, acceptance #2)", () => {
  // Enforced mode without a wired identity adapter must fail at startup,
  // never silently degrade to single-tenant semantics at runtime.
  assert.throws(
    () => validateAccessMode({ accessMode: "enforced" }),
    /identity adapter/i,
    "enforced mode at startup must fail closed without an identity adapter"
  )
})
