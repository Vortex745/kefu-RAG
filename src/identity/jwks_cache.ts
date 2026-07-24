/**
 * P5.1: Bounded JWKS signing-key cache.
 *
 * The cache is bounded in two dimensions:
 *   - maxKeys (space bound, default 10): evicts the oldest entry when full
 *   - ttlMs (time bound, default 1h): entries expire and are treated as misses
 *
 * Cache miss → fail-closed: `getSigningKey` returns `{ ok: false }` when no
 * cached key matches `kid` (or the cached entry has expired). P5.1 does NOT
 * perform live JWKS fetch (D-002 operator-blocked, P5.3 scope); the optional
 * `fetcher` parameter is the seam P5.3 will wire. When no fetcher is supplied,
 * a miss is a hard reject — an unverified token is NEVER accepted.
 */

export interface JwksCacheEntry {
  kid: string
  /** The signing key (e.g. PEM string or JWK JSON). Opaque to the cache. */
  key: string
  fetchedAt: number
  expiresAt: number
}

export const DEFAULT_JWKS_MAX_KEYS = 10
export const DEFAULT_JWKS_TTL_MS = 60 * 60 * 1000 // 1 hour

export interface JwksCacheOptions {
  maxKeys?: number
  ttlMs?: number
  /** Injectable clock for deterministic tests. */
  now?: () => number
}

/**
 * Bounded LRU-ish JWKS key cache. Eviction is insertion-order (oldest first);
 * a `set` on an existing kid refreshes its position so frequently-used keys
 * are not evicted.
 */
export class JwksKeyCache {
  private entries = new Map<string, JwksCacheEntry>()
  private readonly maxKeys: number
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(options: JwksCacheOptions = {}) {
    this.maxKeys = options.maxKeys ?? DEFAULT_JWKS_MAX_KEYS
    this.ttlMs = options.ttlMs ?? DEFAULT_JWKS_TTL_MS
    this.now = options.now ?? (() => Date.now())
    if (!Number.isInteger(this.maxKeys) || this.maxKeys <= 0) {
      throw new Error("JwksKeyCache maxKeys must be a positive integer")
    }
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error("JwksKeyCache ttlMs must be a positive finite number")
    }
  }

  /** Returns the cached key for `kid` if present and not expired; else null. */
  get(kid: string): string | null {
    const entry = this.entries.get(kid)
    if (!entry) return null
    if (this.isExpired(entry)) {
      this.entries.delete(kid)
      return null
    }
    return entry.key
  }

  /** Stores a key for `kid`, evicting the oldest entry if at capacity. */
  set(kid: string, key: string): void {
    // Refresh existing entry position so re-set moves it to the end
    // (Map preserves insertion order; delete + re-insert achieves LRU-ish).
    if (this.entries.has(kid)) {
      this.entries.delete(kid)
    } else if (this.entries.size >= this.maxKeys) {
      // Evict oldest (first inserted key).
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
    const t = this.now()
    this.entries.set(kid, {
      kid,
      key,
      fetchedAt: t,
      expiresAt: t + this.ttlMs,
    })
  }

  isExpired(entry: JwksCacheEntry): boolean {
    return this.now() >= entry.expiresAt
  }

  size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }
}

/** Result of a signing-key lookup. */
export type SigningKeyResult =
  | { ok: true; key: string; source: "cache" | "fetcher" }
  | { ok: false; reason: string }

export type JwksFetcher = (kid: string) => Promise<string | null>

/**
 * Resolve a signing key for `kid`.
 *
 * - Cache hit (not expired) → return key (source: "cache").
 * - Cache miss + fetcher provided → fetch, cache (bounded), return key
 *   (source: "fetcher"). A null fetcher result is fail-closed.
 * - Cache miss + no fetcher → fail-closed (P5.1 path; live fetch is P5.3).
 *
 * This function never accepts an unverified token: a miss without a fetcher
 * is a hard reject, not a "trust anyway" fallback.
 */
export async function getSigningKey(
  kid: string,
  cache: JwksKeyCache,
  fetcher?: JwksFetcher
): Promise<SigningKeyResult> {
  const cached = cache.get(kid)
  if (cached !== null) {
    return { ok: true, key: cached, source: "cache" }
  }
  if (!fetcher) {
    return { ok: false, reason: `cache miss for kid=${kid} and no fetcher (fail-closed)` }
  }
  const fetched = await fetcher(kid)
  if (fetched === null || fetched === undefined) {
    return { ok: false, reason: `fetcher returned null for kid=${kid} (fail-closed)` }
  }
  cache.set(kid, fetched)
  return { ok: true, key: fetched, source: "fetcher" }
}
