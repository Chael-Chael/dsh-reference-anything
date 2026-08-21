/**
 * Keeping the `@` menu off the network on most keystrokes.
 *
 * `candidates()` runs behind a 100 ms debounce, so a typing burst would
 * otherwise become a burst of authenticated round-trips to a consumer cloud
 * API — slow enough to make the menu feel broken and quick enough to get rate
 * limited. Two small caches fix it, and both are deliberately process-local:
 * nothing here is persisted, because a listing is a snapshot of someone's live
 * drive and a stale one written to disk outlives its truth.
 *
 * @module dsh-reference-anything/cloud-drive/cache
 */

import type { DriveEntry, DriveKind } from './types.ts'

/** One cached listing and when it was taken. */
interface CachedListing {
  readonly fetchedAt: number
  readonly entries: readonly DriveEntry[]
}

/**
 * TTL cache over listings, plus a memo from file id back to its entry.
 *
 * The memo exists because `read()` receives only a reference id. Without it,
 * naming a file's size or path in an error — or deciding it is too large
 * before downloading it — would need a metadata round-trip the listing already
 * paid for.
 */
export class DriveCache {
  private readonly listings = new Map<string, CachedListing>()
  private readonly entries = new Map<string, DriveEntry>()

  /**
   * @param ttlMs - how long a listing stays fresh.
   * @param now - clock in epoch milliseconds, injectable for tests.
   * @param maxEntries - upper bound on memoized entries, so a long session
   * browsing a large drive cannot grow this without limit.
   */
  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly maxEntries: number = 2000,
  ) {}

  /**
   * Look up a listing that is still fresh.
   *
   * @param key - opaque cache key; callers must include the drive and query.
   * @returns the entries, or `undefined` when absent or stale.
   */
  listing(key: string): readonly DriveEntry[] | undefined {
    const hit = this.listings.get(key)
    if (hit === undefined) return undefined
    if (this.now() - hit.fetchedAt > this.ttlMs) {
      this.listings.delete(key)
      return undefined
    }
    return hit.entries
  }

  /**
   * Record a listing and memoize every entry in it.
   *
   * @param key - the same key {@link DriveCache.listing} will be called with.
   * @param entries - what the provider returned.
   */
  remember(key: string, entries: readonly DriveEntry[]): void {
    this.listings.set(key, { fetchedAt: this.now(), entries })
    for (const entry of entries) {
      const key = entryKey(entry.kind, entry.id)
      // Re-inserting moves the key to the end of the iteration order, which is
      // what makes the eviction below least-recently-seen rather than arbitrary.
      this.entries.delete(key)
      this.entries.set(key, entry)
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
    }
  }

  /**
   * Recall one entry seen in an earlier listing.
   *
   * @param kind - which drive owns it. Required, because two drives may well
   * hand out the same id string and one must never answer for the other.
   * @param id - the provider's own file id.
   * @returns the entry, or `undefined` if it was never listed or has been evicted.
   */
  entry(kind: DriveKind, id: string): DriveEntry | undefined {
    const key = entryKey(kind, id)
    const hit = this.entries.get(key)
    if (hit === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, hit)
    return hit
  }

  /** Drop everything. Used when credentials change, so a new account sees no stale rows. */
  clear(): void {
    this.listings.clear()
    this.entries.clear()
  }
}

/**
 * Memo key for one entry.
 *
 * NUL separates because it is the one byte neither a drive name nor a file id
 * can contain, so no pair of parts can collide by concatenation.
 */
function entryKey(kind: DriveKind, id: string): string {
  return `${kind}\0${id}`
}
