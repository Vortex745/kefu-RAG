import assert from "node:assert/strict"
import test from "node:test"
import { openDb } from "../ingestion/tracking/db"
import { SqliteSessionBinder } from "./session_binder"

test("Ticket 05 P3: first bind for a session creates binding and returns bound=true", () => {
  const db = openDb(":memory:")
  const binder = new SqliteSessionBinder(db)
  const result = binder.bindOrCheck("sess-1", "tenant-a", "user-1")
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.bound, true, "first bind must set bound=true")
    assert.equal(result.binding.sessionId, "sess-1")
    assert.equal(result.binding.tenantId, "tenant-a")
    assert.equal(result.binding.subjectId, "user-1")
    assert.ok(result.binding.createdAt, "createdAt must be set")
  }
})

test("Ticket 05 P3: consistent reuse returns ok with bound=false (idempotent)", () => {
  const db = openDb(":memory:")
  const binder = new SqliteSessionBinder(db)
  binder.bindOrCheck("sess-1", "tenant-a", "user-1")
  const result = binder.bindOrCheck("sess-1", "tenant-a", "user-1")
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.bound, false, "consistent reuse must not create a new binding")
    assert.equal(result.binding.tenantId, "tenant-a")
    assert.equal(result.binding.subjectId, "user-1")
  }
})

test("Ticket 05 P3: conflicting tenant+subject reuse is rejected, not merged", () => {
  const db = openDb(":memory:")
  const binder = new SqliteSessionBinder(db)
  binder.bindOrCheck("sess-1", "tenant-a", "user-1")
  const result = binder.bindOrCheck("sess-1", "tenant-b", "user-2")
  assert.equal(result.ok, false, "conflicting reuse must be rejected")
  if (!result.ok) {
    assert.equal(result.conflict.existing.tenantId, "tenant-a", "existing binding must be preserved, not merged")
    assert.equal(result.conflict.existing.subjectId, "user-1")
  }
  // Existing binding must be unchanged after a rejected attempt
  const recheck = binder.bindOrCheck("sess-1", "tenant-a", "user-1")
  assert.equal(recheck.ok, true, "original binding must still work after a rejected conflict")
})

test("Ticket 05 P3: different sessions bind independently without cross-conflict", () => {
  const db = openDb(":memory:")
  const binder = new SqliteSessionBinder(db)
  const r1 = binder.bindOrCheck("sess-1", "tenant-a", "user-1")
  const r2 = binder.bindOrCheck("sess-2", "tenant-b", "user-2")
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true, "different sessionId must not conflict with each other")
  if (r1.ok && r2.ok) {
    assert.equal(r1.binding.tenantId, "tenant-a")
    assert.equal(r2.binding.tenantId, "tenant-b")
  }
})

test("Ticket 05 P3: partial conflict (same tenant, different subject) is rejected", () => {
  const db = openDb(":memory:")
  const binder = new SqliteSessionBinder(db)
  binder.bindOrCheck("sess-1", "tenant-a", "user-1")
  const result = binder.bindOrCheck("sess-1", "tenant-a", "user-2")
  assert.equal(result.ok, false, "subject change on same session must be rejected")
  if (!result.ok) {
    assert.equal(result.conflict.existing.tenantId, "tenant-a")
    assert.equal(result.conflict.existing.subjectId, "user-1", "existing subject preserved")
  }
})

test("Ticket 05 P3: session_bindings table exists with required columns after openDb migration", () => {
  const db = openDb(":memory:")
  const columns = db.pragma("table_info(session_bindings)") as Array<{ name: string }>
  assert.ok(columns.length > 0, "session_bindings table must exist after openDb migration")
  assert.ok(columns.some((c) => c.name === "session_id"), "session_bindings must have session_id column")
  assert.ok(columns.some((c) => c.name === "tenant_id"), "session_bindings must have tenant_id column")
  assert.ok(columns.some((c) => c.name === "subject_id"), "session_bindings must have subject_id column")
  assert.ok(columns.some((c) => c.name === "created_at"), "session_bindings must have created_at column")
})
