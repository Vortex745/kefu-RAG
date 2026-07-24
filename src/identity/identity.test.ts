import assert from "node:assert/strict"
import test from "node:test"
import {
  loadOidcConfig,
  DEFAULT_CLAIM_MAPPING,
  DEFAULT_CLOCK_SKEW_SECONDS,
  JwksKeyCache,
  getSigningKey,
  DEFAULT_JWKS_MAX_KEYS,
  DEFAULT_JWKS_TTL_MS,
  validateClaims,
  decodeJwtUnsafe,
  type OidcEnvSource,
  type JwtClaims,
} from "./index"

// ---------- helpers ----------

function b64url(obj: unknown): string {
  const json = JSON.stringify(obj)
  return Buffer.from(json, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

/** Build an unsigned JWT (header.payload) for claim-validation tests. */
function makeToken(claims: Partial<JwtClaims>): string {
  const header = b64url({ alg: "RS256", typ: "JWT", kid: "test-kid" })
  const payload = b64url(claims)
  return `${header}.${payload}.signature`
}

const FULL_ENV: OidcEnvSource = {
  OIDC_ISSUER: "https://issuer.example.com",
  OIDC_AUDIENCE: "kefu-rag-api",
  OIDC_JWKS_ENDPOINT: "https://issuer.example.com/.well-known/jwks.json",
}

const NOW = 1_700_000_000_000 // fixed test clock (ms)
const NOW_SECONDS = Math.floor(NOW / 1000)

// ============================================================
// Scenario 3: ACCESS_MODE=single_tenant → noop config (backward compat)
// ============================================================

test("P5.1 #3 single_tenant mode returns noop config (backward compat)", () => {
  const cfg = loadOidcConfig(FULL_ENV, "single_tenant")
  assert.equal(cfg.kind, "noop")
  if (cfg.kind === "noop") {
    assert.equal(cfg.reason, "single_tenant_mode")
  }
})

test("P5.1 #3 single_tenant noop is returned even when OIDC env is fully set (mode takes precedence)", () => {
  // Operator chose single_tenant → OIDC is intentionally skipped regardless of env.
  const cfg = loadOidcConfig(FULL_ENV, "single_tenant")
  assert.equal(cfg.kind, "noop")
})

test("P5.1 #3 single_tenant noop is returned when OIDC env is entirely absent", () => {
  const cfg = loadOidcConfig({}, "single_tenant")
  assert.equal(cfg.kind, "noop")
})

// ============================================================
// Scenario 1 & 2: missing issuer/audience → fail closed
// ============================================================

test("P5.1 #1 enforced mode missing OIDC_ISSUER → fail_closed", () => {
  const cfg = loadOidcConfig(
    { ...FULL_ENV, OIDC_ISSUER: undefined },
    "enforced"
  )
  assert.equal(cfg.kind, "fail_closed")
  if (cfg.kind === "fail_closed") {
    assert.ok(cfg.missingFields.includes("OIDC_ISSUER"), "must list OIDC_ISSUER")
    assert.match(cfg.reason, /OIDC_ISSUER/)
  }
})

test("P5.1 #2 enforced mode missing OIDC_AUDIENCE → fail_closed", () => {
  const cfg = loadOidcConfig(
    { ...FULL_ENV, OIDC_AUDIENCE: undefined },
    "enforced"
  )
  assert.equal(cfg.kind, "fail_closed")
  if (cfg.kind === "fail_closed") {
    assert.ok(cfg.missingFields.includes("OIDC_AUDIENCE"))
  }
})

test("P5.1 enforced mode missing OIDC_JWKS_ENDPOINT → fail_closed", () => {
  const cfg = loadOidcConfig(
    { ...FULL_ENV, OIDC_JWKS_ENDPOINT: undefined },
    "enforced"
  )
  assert.equal(cfg.kind, "fail_closed")
  if (cfg.kind === "fail_closed") {
    assert.ok(cfg.missingFields.includes("OIDC_JWKS_ENDPOINT"))
  }
})

test("P5.1 enforced mode ALL fields missing → fail_closed lists all three", () => {
  const cfg = loadOidcConfig({}, "enforced")
  assert.equal(cfg.kind, "fail_closed")
  if (cfg.kind === "fail_closed") {
    assert.equal(cfg.missingFields.length, 3)
    assert.ok(cfg.missingFields.includes("OIDC_ISSUER"))
    assert.ok(cfg.missingFields.includes("OIDC_AUDIENCE"))
    assert.ok(cfg.missingFields.includes("OIDC_JWKS_ENDPOINT"))
  }
})

test("P5.1 蓝军: enforced mode with blank-string issuer (whitespace) → fail_closed", () => {
  //空白字符串不算"存在"——isBlank 检查 trim() 后非空
  const cfg = loadOidcConfig(
    { ...FULL_ENV, OIDC_ISSUER: "   " },
    "enforced"
  )
  assert.equal(cfg.kind, "fail_closed")
})

test("P5.1 蓝军: enforced mode with empty-string audience → fail_closed", () => {
  const cfg = loadOidcConfig(
    { ...FULL_ENV, OIDC_AUDIENCE: "" },
    "enforced"
  )
  assert.equal(cfg.kind, "fail_closed")
})

test("P5.1 enforced mode with invalid OIDC_CLOCK_SKEW_SECONDS (negative) → fail_closed", () => {
  const cfg = loadOidcConfig(
    { ...FULL_ENV, OIDC_CLOCK_SKEW_SECONDS: "-5" },
    "enforced"
  )
  assert.equal(cfg.kind, "fail_closed")
  if (cfg.kind === "fail_closed") {
    assert.ok(cfg.missingFields.includes("OIDC_CLOCK_SKEW_SECONDS"))
  }
})

test("P5.1 enforced mode with non-numeric OIDC_CLOCK_SKEW_SECONDS → fail_closed", () => {
  const cfg = loadOidcConfig(
    { ...FULL_ENV, OIDC_CLOCK_SKEW_SECONDS: "abc" },
    "enforced"
  )
  assert.equal(cfg.kind, "fail_closed")
})

test("P5.1 enforced mode fully configured → active config with correct fields", () => {
  const cfg = loadOidcConfig(FULL_ENV, "enforced")
  assert.equal(cfg.kind, "active")
  if (cfg.kind === "active") {
    assert.equal(cfg.issuer, "https://issuer.example.com")
    assert.equal(cfg.audience, "kefu-rag-api")
    assert.equal(cfg.jwksEndpoint, "https://issuer.example.com/.well-known/jwks.json")
    assert.deepEqual(cfg.claimMapping, DEFAULT_CLAIM_MAPPING)
    assert.equal(cfg.clockSkewSeconds, DEFAULT_CLOCK_SKEW_SECONDS)
  }
})

test("P5.1 enforced mode trims whitespace from config values", () => {
  const cfg = loadOidcConfig(
    {
      OIDC_ISSUER: "  https://issuer.example.com  ",
      OIDC_AUDIENCE: "  kefu-rag-api  ",
      OIDC_JWKS_ENDPOINT: "  https://issuer.example.com/jwks  ",
    },
    "enforced"
  )
  assert.equal(cfg.kind, "active")
  if (cfg.kind === "active") {
    assert.equal(cfg.issuer, "https://issuer.example.com")
    assert.equal(cfg.audience, "kefu-rag-api")
    assert.equal(cfg.jwksEndpoint, "https://issuer.example.com/jwks")
  }
})

test("P5.1 enforced mode honors custom claim mapping", () => {
  const cfg = loadOidcConfig(
    {
      ...FULL_ENV,
      OIDC_TENANT_CLAIM: "tid",
      OIDC_SUBJECT_CLAIM: "user_id",
      OIDC_GROUPS_CLAIM: "roles",
    },
    "enforced"
  )
  assert.equal(cfg.kind, "active")
  if (cfg.kind === "active") {
    assert.equal(cfg.claimMapping.tenantClaim, "tid")
    assert.equal(cfg.claimMapping.subjectClaim, "user_id")
    assert.equal(cfg.claimMapping.groupsClaim, "roles")
  }
})

// ============================================================
// Scenario 4: bounded cache (max keys, TTL)
// ============================================================

test("P5.1 #4 cache hit returns key; cache miss returns null (fail-closed)", () => {
  let t = 1000
  const cache = new JwksKeyCache({ maxKeys: 3, ttlMs: 5000, now: () => t })
  cache.set("kid-1", "key-1")
  assert.equal(cache.get("kid-1"), "key-1") // hit
  assert.equal(cache.get("kid-missing"), null) // miss → fail-closed
})

test("P5.1 #4 cache enforces maxKeys bound — evicts oldest at capacity", () => {
  let t = 1000
  const cache = new JwksKeyCache({ maxKeys: 2, ttlMs: 5000, now: () => t })
  cache.set("kid-a", "key-a")
  cache.set("kid-b", "key-b")
  assert.equal(cache.size(), 2)
  // inserting a third evicts the oldest (kid-a)
  cache.set("kid-c", "key-c")
  assert.equal(cache.size(), 2)
  assert.equal(cache.get("kid-a"), null) // evicted
  assert.equal(cache.get("kid-b"), "key-b")
  assert.equal(cache.get("kid-c"), "key-c")
})

test("P5.1 #4 cache TTL expiry — expired entry treated as miss (fail-closed)", () => {
  let t = 1000
  const ttlMs = 5000
  const cache = new JwksKeyCache({ maxKeys: 5, ttlMs, now: () => t })
  cache.set("kid-1", "key-1")
  assert.equal(cache.get("kid-1"), "key-1") // not expired
  t += ttlMs // advance to exactly expiry boundary
  assert.equal(cache.get("kid-1"), null) // expired → fail-closed
  assert.equal(cache.size(), 0) // expired entry purged on access
})

test("P5.1 #4 cache TTL — entry valid just before expiry boundary", () => {
  let t = 1000
  const ttlMs = 5000
  const cache = new JwksKeyCache({ maxKeys: 5, ttlMs, now: () => t })
  cache.set("kid-1", "key-1")
  t += ttlMs - 1 // 1ms before expiry
  assert.equal(cache.get("kid-1"), "key-1") // still valid
})

test("P5.1 #4 re-setting existing kid refreshes its position (not evicted as oldest)", () => {
  let t = 1000
  const cache = new JwksKeyCache({ maxKeys: 2, ttlMs: 5000, now: () => t })
  cache.set("kid-a", "key-a")
  cache.set("kid-b", "key-b")
  // re-set kid-a → it moves to end; kid-b is now oldest
  cache.set("kid-a", "key-a-updated")
  cache.set("kid-c", "key-c") // should evict kid-b (oldest), not kid-a
  assert.equal(cache.get("kid-a"), "key-a-updated") // survived
  assert.equal(cache.get("kid-b"), null) // evicted
  assert.equal(cache.get("kid-c"), "key-c")
})

test("P5.1 #4 cache clear() empties all entries", () => {
  let t = 1000
  const cache = new JwksKeyCache({ maxKeys: 5, ttlMs: 5000, now: () => t })
  cache.set("kid-1", "key-1")
  cache.set("kid-2", "key-2")
  assert.equal(cache.size(), 2)
  cache.clear()
  assert.equal(cache.size(), 0)
  assert.equal(cache.get("kid-1"), null)
})

test("P5.1 #4 cache constructor rejects invalid maxKeys", () => {
  assert.throws(() => new JwksKeyCache({ maxKeys: 0 }), /maxKeys/)
  assert.throws(() => new JwksKeyCache({ maxKeys: -1 }), /maxKeys/)
  assert.throws(() => new JwksKeyCache({ maxKeys: 1.5 }), /maxKeys/)
})

test("P5.1 #4 cache constructor rejects invalid ttlMs", () => {
  assert.throws(() => new JwksKeyCache({ ttlMs: 0 }), /ttlMs/)
  assert.throws(() => new JwksKeyCache({ ttlMs: -1 }), /ttlMs/)
  assert.throws(() => new JwksKeyCache({ ttlMs: Infinity }), /ttlMs/)
})

test("P5.1 #4 default cache bounds are sane (maxKeys=10, ttlMs=1h)", () => {
  assert.equal(DEFAULT_JWKS_MAX_KEYS, 10)
  assert.equal(DEFAULT_JWKS_TTL_MS, 60 * 60 * 1000)
})

// ---------- getSigningKey ----------

test("P5.1 #4 getSigningKey cache hit → returns key from cache (no fetcher needed)", async () => {
  let t = 1000
  const cache = new JwksKeyCache({ maxKeys: 5, ttlMs: 5000, now: () => t })
  cache.set("kid-1", "cached-key")
  const result = await getSigningKey("kid-1", cache)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.key, "cached-key")
    assert.equal(result.source, "cache")
  }
})

test("P5.1 #4 getSigningKey cache miss + no fetcher → fail-closed (NEVER accepts unverified token)", async () => {
  let t = 1000
  const cache = new JwksKeyCache({ maxKeys: 5, ttlMs: 5000, now: () => t })
  const result = await getSigningKey("kid-missing", cache)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.reason, /fail-closed/)
  }
})

test("P5.1 #4 getSigningKey cache miss + fetcher → fetches, caches, returns key", async () => {
  let t = 1000
  const cache = new JwksKeyCache({ maxKeys: 5, ttlMs: 5000, now: () => t })
  let fetchCalls = 0
  const fetcher = async (kid: string): Promise<string | null> => {
    fetchCalls++
    return `fetched-${kid}`
  }
  const result = await getSigningKey("kid-new", cache, fetcher)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.key, "fetched-kid-new")
    assert.equal(result.source, "fetcher")
  }
  assert.equal(fetchCalls, 1)
  // second call should hit cache, not fetcher
  const result2 = await getSigningKey("kid-new", cache, fetcher)
  assert.equal(result2.ok, true)
  if (result2.ok) assert.equal(result2.source, "cache")
  assert.equal(fetchCalls, 1) // fetcher not called again
})

test("P5.1 #4 getSigningKey fetcher returns null → fail-closed", async () => {
  let t = 1000
  const cache = new JwksKeyCache({ maxKeys: 5, ttlMs: 5000, now: () => t })
  const fetcher = async (): Promise<string | null> => null
  const result = await getSigningKey("kid-x", cache, fetcher)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.reason, /fail-closed/)
})

// ============================================================
// Scenario 5: claims validation (valid/invalid issuer/audience/expiry)
// ============================================================

const ACTIVE_CONFIG = loadOidcConfig(FULL_ENV, "enforced")
if (ACTIVE_CONFIG.kind !== "active") {
  throw new Error("test setup: expected active config")
}

test("P5.1 #5 validateClaims accepts valid token (matching iss/aud, not expired)", () => {
  const claims: JwtClaims = {
    iss: "https://issuer.example.com",
    aud: "kefu-rag-api",
    exp: NOW_SECONDS + 3600, // 1h in future
    sub: "user-123",
  }
  const result = validateClaims(claims, ACTIVE_CONFIG, NOW)
  assert.equal(result.valid, true)
})

test("P5.1 #5 validateClaims accepts string audience in array form", () => {
  const claims: JwtClaims = {
    iss: "https://issuer.example.com",
    aud: ["other-aud", "kefu-rag-api"],
    exp: NOW_SECONDS + 3600,
  }
  const result = validateClaims(claims, ACTIVE_CONFIG, NOW)
  assert.equal(result.valid, true)
})

test("P5.1 #5 validateClaims rejects issuer mismatch", () => {
  const claims: JwtClaims = {
    iss: "https://wrong-issuer.example.com",
    aud: "kefu-rag-api",
    exp: NOW_SECONDS + 3600,
  }
  const result = validateClaims(claims, ACTIVE_CONFIG, NOW)
  assert.equal(result.valid, false)
  assert.equal(result.reason, "issuer_mismatch")
})

test("P5.1 #5 validateClaims rejects audience mismatch", () => {
  const claims: JwtClaims = {
    iss: "https://issuer.example.com",
    aud: "wrong-audience",
    exp: NOW_SECONDS + 3600,
  }
  const result = validateClaims(claims, ACTIVE_CONFIG, NOW)
  assert.equal(result.valid, false)
  assert.equal(result.reason, "audience_mismatch")
})

test("P5.1 #5 validateClaims rejects expired token", () => {
  const claims: JwtClaims = {
    iss: "https://issuer.example.com",
    aud: "kefu-rag-api",
    exp: NOW_SECONDS - 100, // expired 100s ago
  }
  const result = validateClaims(claims, ACTIVE_CONFIG, NOW)
  assert.equal(result.valid, false)
  assert.equal(result.reason, "token_expired")
})

test("P5.1 #5 validateClaims allows token within clock skew window", () => {
  // expired 30s ago, but clock skew is 60s → still valid
  const claims: JwtClaims = {
    iss: "https://issuer.example.com",
    aud: "kefu-rag-api",
    exp: NOW_SECONDS - 30,
  }
  const result = validateClaims(claims, ACTIVE_CONFIG, NOW)
  assert.equal(result.valid, true)
})

test("P5.1 #5 validateClaims rejects token beyond clock skew window", () => {
  // expired 90s ago, clock skew is 60s → expired
  const claims: JwtClaims = {
    iss: "https://issuer.example.com",
    aud: "kefu-rag-api",
    exp: NOW_SECONDS - 90,
  }
  const result = validateClaims(claims, ACTIVE_CONFIG, NOW)
  assert.equal(result.valid, false)
  assert.equal(result.reason, "token_expired")
})

test("P5.1 #5 validateClaims rejects token not yet valid (nbf in future)", () => {
  const claims: JwtClaims = {
    iss: "https://issuer.example.com",
    aud: "kefu-rag-api",
    exp: NOW_SECONDS + 3600,
    nbf: NOW_SECONDS + 120, // valid in 2 min (beyond 60s skew)
  }
  const result = validateClaims(claims, ACTIVE_CONFIG, NOW)
  assert.equal(result.valid, false)
  assert.equal(result.reason, "token_not_yet_valid")
})

// ---------- missing issuer/audience in TOKEN (fail-closed) ----------

test("P5.1 #1 validateClaims rejects token with missing issuer (fail-closed)", () => {
  const claims: JwtClaims = {
    aud: "kefu-rag-api",
    exp: NOW_SECONDS + 3600,
  }
  const result = validateClaims(claims, ACTIVE_CONFIG, NOW)
  assert.equal(result.valid, false)
  assert.equal(result.reason, "missing_issuer")
})

test("P5.1 #2 validateClaims rejects token with missing audience (fail-closed)", () => {
  const claims: JwtClaims = {
    iss: "https://issuer.example.com",
    exp: NOW_SECONDS + 3600,
  }
  const result = validateClaims(claims, ACTIVE_CONFIG, NOW)
  assert.equal(result.valid, false)
  assert.equal(result.reason, "missing_audience")
})

test("P5.1 validateClaims rejects token with missing expiry", () => {
  const claims: JwtClaims = {
    iss: "https://issuer.example.com",
    aud: "kefu-rag-api",
  }
  const result = validateClaims(claims, ACTIVE_CONFIG, NOW)
  assert.equal(result.valid, false)
  assert.equal(result.reason, "missing_expiry")
})

test("P5.1 validateClaims rejects token with non-string issuer (type fail-closed)", () => {
  const claims: JwtClaims = {
    iss: 12345,
    aud: "kefu-rag-api",
    exp: NOW_SECONDS + 3600,
  }
  const result = validateClaims(claims, ACTIVE_CONFIG, NOW)
  assert.equal(result.valid, false)
  assert.equal(result.reason, "issuer_mismatch")
})

test("P5.1 validateClaims rejects token with numeric audience (type fail-closed)", () => {
  const claims: JwtClaims = {
    iss: "https://issuer.example.com",
    aud: 12345,
    exp: NOW_SECONDS + 3600,
  }
  const result = validateClaims(claims, ACTIVE_CONFIG, NOW)
  assert.equal(result.valid, false)
  assert.equal(result.reason, "audience_mismatch")
})

test("P5.1 validateClaims rejects token with invalid expiry type", () => {
  const claims: JwtClaims = {
    iss: "https://issuer.example.com",
    aud: "kefu-rag-api",
    exp: "not-a-number",
  }
  const result = validateClaims(claims, ACTIVE_CONFIG, NOW)
  assert.equal(result.valid, false)
  assert.equal(result.reason, "invalid_expiry")
})

test("P5.1 validateClaims accepts string-form exp (numeric string)", () => {
  const claims: JwtClaims = {
    iss: "https://issuer.example.com",
    aud: "kefu-rag-api",
    exp: String(NOW_SECONDS + 3600),
  }
  const result = validateClaims(claims, ACTIVE_CONFIG, NOW)
  assert.equal(result.valid, true)
})

// ---------- noop / fail_closed config → validateClaims ----------

test("P5.1 validateClaims with noop config → invalid (oidc path disabled)", () => {
  const noopCfg = loadOidcConfig(FULL_ENV, "single_tenant")
  const claims: JwtClaims = {
    iss: "https://issuer.example.com",
    aud: "kefu-rag-api",
    exp: NOW_SECONDS + 3600,
  }
  const result = validateClaims(claims, noopCfg, NOW)
  assert.equal(result.valid, false)
  assert.equal(result.reason, "oidc_disabled_noop_config")
})

test("P5.1 validateClaims with fail_closed config → invalid (propagates reason)", () => {
  const fcCfg = loadOidcConfig({}, "enforced")
  assert.equal(fcCfg.kind, "fail_closed")
  const claims: JwtClaims = {
    iss: "https://issuer.example.com",
    aud: "kefu-rag-api",
    exp: NOW_SECONDS + 3600,
  }
  const result = validateClaims(claims, fcCfg, NOW)
  assert.equal(result.valid, false)
  if (!result.valid) assert.match(result.reason!, /oidc_fail_closed/)
})

// ---------- decodeJwtUnsafe ----------

test("P5.1 decodeJwtUnsafe extracts claims from a well-formed token", () => {
  const token = makeToken({
    iss: "https://issuer.example.com",
    aud: "kefu-rag-api",
    exp: NOW_SECONDS + 3600,
    sub: "user-1",
  })
  const decoded = decodeJwtUnsafe(token)
  assert.notEqual(decoded, null)
  if (decoded) {
    assert.equal(decoded.claims.iss, "https://issuer.example.com")
    assert.equal(decoded.claims.aud, "kefu-rag-api")
  }
})

test("P5.1 decodeJwtUnsafe returns null for empty string", () => {
  assert.equal(decodeJwtUnsafe(""), null)
})

test("P5.1 decodeJwtUnsafe returns null for non-string input", () => {
  assert.equal(decodeJwtUnsafe(null as unknown as string), null)
})

test("P5.1 decodeJwtUnsafe returns null for token with too few segments", () => {
  assert.equal(decodeJwtUnsafe("onlyonepart"), null)
})

test("P5.1 decodeJwtUnsafe returns null for malformed base64url", () => {
  // two segments but not valid base64url JSON
  assert.equal(decodeJwtUnsafe("!!!.@@@.sig"), null)
})

test("P5.1 decodeJwtUnsafe returns null when payload is not a JSON object", () => {
  // payload decodes to a JSON array
  const header = b64url({ alg: "RS256" })
  const payload = b64url([1, 2, 3])
  assert.equal(decodeJwtUnsafe(`${header}.${payload}.sig`), null)
})

// ============================================================
// 蓝军自检 (PUA Protocol)
// ============================================================

test("P5.1 蓝军 #1: no path accepts token without issuer validation in enforced mode", () => {
  // A token missing iss must ALWAYS be rejected when config is active.
  // There is no "skip issuer check" branch.
  const claims: JwtClaims = { aud: "kefu-rag-api", exp: NOW_SECONDS + 3600 }
  // Try every config kind:
  assert.equal(validateClaims(claims, ACTIVE_CONFIG, NOW).valid, false)
  assert.equal(
    validateClaims(claims, loadOidcConfig(FULL_ENV, "single_tenant"), NOW).valid,
    false
  )
  assert.equal(
    validateClaims(claims, loadOidcConfig({}, "enforced"), NOW).valid,
    false
  )
})

test("P5.1 蓝军 #2: no path accepts token without audience validation in enforced mode", () => {
  const claims: JwtClaims = { iss: "https://issuer.example.com", exp: NOW_SECONDS + 3600 }
  assert.equal(validateClaims(claims, ACTIVE_CONFIG, NOW).valid, false)
  assert.equal(
    validateClaims(claims, loadOidcConfig(FULL_ENV, "single_tenant"), NOW).valid,
    false
  )
  assert.equal(
    validateClaims(claims, loadOidcConfig({}, "enforced"), NOW).valid,
    false
  )
})

test("P5.1 蓝军 #3: cache miss NEVER returns a key without a fetcher (no trust-on-miss)", async () => {
  let t = 1000
  const cache = new JwksKeyCache({ maxKeys: 5, ttlMs: 5000, now: () => t })
  // Multiple kids all miss → all fail-closed, none return a key
  for (const kid of ["a", "b", "c", "d", "e"]) {
    const r = await getSigningKey(kid, cache)
    assert.equal(r.ok, false, `${kid} should fail-closed`)
  }
})

test("P5.1 蓝军 #4: expired cache entry is purged and treated as miss (no stale-key use)", async () => {
  let t = 1000
  const cache = new JwksKeyCache({ maxKeys: 5, ttlMs: 1000, now: () => t })
  cache.set("kid-1", "stale-key")
  t += 2000 // expire
  // getSigningKey without fetcher → must NOT return stale key
  const r = await getSigningKey("kid-1", cache)
  assert.equal(r.ok, false)
  assert.equal(cache.get("kid-1"), null) // purged
})

test("P5.1 蓝军 #5: cache is bounded — cannot grow unbounded via set", () => {
  let t = 1000
  const maxKeys = 5
  const cache = new JwksKeyCache({ maxKeys, ttlMs: 5000, now: () => t })
  for (let i = 0; i < 50; i++) {
    cache.set(`kid-${i}`, `key-${i}`)
  }
  assert.equal(cache.size(), maxKeys, "cache must never exceed maxKeys")
})

test("P5.1 蓝军 #6: no live network I/O performed (P5.1 is config + cache only)", () => {
  // loadOidcConfig must not attempt any fetch; a fail_closed config is a
  // configuration error, not a trigger to connect to a live issuer.
  // We verify by passing an env with a JWKS endpoint that would fail if
  // fetched — the function returns synchronously without I/O.
  const cfg = loadOidcConfig(
    { OIDC_ISSUER: "x", OIDC_AUDIENCE: "y", OIDC_JWKS_ENDPOINT: "https://invalid.test/jwks" },
    "enforced"
  )
  assert.equal(cfg.kind, "active") // config loaded without fetching
  // JwksKeyCache constructor + get do not fetch either.
  const cache = new JwksKeyCache()
  assert.equal(cache.get("any"), null) // no I/O
})

test("P5.1 蓝军 #7: single_tenant backward compat — validateClaims rejects JWT (uses different path)", () => {
  // In single_tenant mode, identity comes from singleTenantAccessContext(),
  // NOT from JWT. validateClaims with a noop config must reject every token
  // so the OIDC path can never accidentally run in single_tenant mode.
  const noopCfg = loadOidcConfig(FULL_ENV, "single_tenant")
  const validLookingToken: JwtClaims = {
    iss: "https://issuer.example.com",
    aud: "kefu-rag-api",
    exp: NOW_SECONDS + 3600,
  }
  assert.equal(validateClaims(validLookingToken, noopCfg, NOW).valid, false)
})

test("P5.1 蓝军 #8: getSigningKey with fetcher that throws → error propagates (not swallowed as valid)", async () => {
  let t = 1000
  const cache = new JwksKeyCache({ maxKeys: 5, ttlMs: 5000, now: () => t })
  const throwingFetcher = async (): Promise<string | null> => {
    throw new Error("network down")
  }
  await assert.rejects(
    () => getSigningKey("kid-err", cache, throwingFetcher),
    /network down/
  )
  // Nothing cached after a throw
  assert.equal(cache.size(), 0)
})
