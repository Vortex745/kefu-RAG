import assert from "node:assert/strict"
import test from "node:test"
import {
  resolveSourceIdentity,
  resolveStoredSourceIdentity,
  sourceIdentityKey,
  type SourceIdentityInput,
} from "./source_identity"
import { openDb } from "./tracking/db"

test("Ticket 05 P2: resolveSourceIdentity carries tenantId and allowedGroups when provided", () => {
  const identity = resolveSourceIdentity(
    {
      kind: "file",
      uriOrExternalId: "/data/report.pdf",
      namespace: "uploads",
      tenantId: "tenant-acme",
      allowedGroups: ["engineers", "support"],
    },
    undefined,
    "fallback-id"
  )
  assert.equal(identity.tenantId, "tenant-acme")
  assert.deepEqual(identity.allowedGroups, ["engineers", "support"])
})

test("Ticket 05 P2: resolveSourceIdentity defaults tenantId to 'default' and allowedGroups to [] when not provided (backward compat)", () => {
  const identity = resolveSourceIdentity(
    { kind: "file", uriOrExternalId: "/data/report.pdf" },
    undefined,
    "fallback-id"
  )
  assert.equal(identity.tenantId, "default")
  assert.deepEqual(identity.allowedGroups, [])
})

test("Ticket 05 P2: empty allowedGroups represents tenant-wide visibility, never cross-tenant public", () => {
  // Empty allowedGroups = see everything WITHIN the tenant, not public
  // across tenants. The invariant: tenantId is always set and non-empty,
  // so the source is always scoped to exactly one tenant.
  const identity = resolveSourceIdentity(
    {
      kind: "file",
      uriOrExternalId: "/data/report.pdf",
      tenantId: "tenant-acme",
      allowedGroups: [],
    },
    undefined,
    "fallback-id"
  )
  assert.equal(identity.tenantId, "tenant-acme")
  assert.deepEqual(identity.allowedGroups, [])
  assert.ok(
    identity.tenantId.length > 0,
    "tenantId must always be set — empty allowedGroups is tenant-wide, not cross-tenant public"
  )
})

test("Ticket 05 P2: sourceIdentityKey remains stable regardless of tenantId (additive migration)", () => {
  // The key is [kind, uri, namespace] — tenantId is an ATTRIBUTE, not part
  // of the key. This keeps the schema migration additive: existing source
  // rows keep their keys; tenantId is a new column with a default.
  const idTenantA = resolveSourceIdentity(
    { kind: "file", uriOrExternalId: "/data/report.pdf", tenantId: "tenant-a" },
    undefined,
    "fallback-id"
  )
  const idTenantB = resolveSourceIdentity(
    { kind: "file", uriOrExternalId: "/data/report.pdf", tenantId: "tenant-b" },
    undefined,
    "fallback-id"
  )
  assert.equal(
    sourceIdentityKey(idTenantA),
    sourceIdentityKey(idTenantB),
    "sourceIdentityKey must not include tenantId — additive migration guarantee"
  )
})

test("Ticket 05 P2: resolveStoredSourceIdentity (legacy path) defaults tenantId and allowedGroups", () => {
  // Legacy callers pass a raw source string; they get the deterministic
  // single-tenant defaults so existing rows migrate cleanly.
  const identity = resolveStoredSourceIdentity("/data/legacy.pdf", "fallback-id")
  assert.equal(identity.tenantId, "default")
  assert.deepEqual(identity.allowedGroups, [])
})

test("Ticket 05 P2: sources table has tenant_id and allowed_groups columns after openDb migration", () => {
  const db = openDb(":memory:")
  const columns = db.pragma("table_info(sources)") as Array<{ name: string }>
  assert.ok(
    columns.some((c) => c.name === "tenant_id"),
    "sources table must have tenant_id column after migration"
  )
  assert.ok(
    columns.some((c) => c.name === "allowed_groups"),
    "sources table must have allowed_groups column after migration"
  )
})
