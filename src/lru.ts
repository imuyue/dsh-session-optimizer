/**
 * A least-recently-used map bounded by bytes rather than by entry count.
 *
 * The cache this exists for holds decoded chunks, and those are wildly uneven:
 * one frame can carry a handful of short events and another a few thousand long
 * ones, so "keep eight entries" means anywhere between two megabytes and twenty.
 * A byte budget makes the resident set predictable, which matters because the
 * same process also holds a worker thread, the model's own buffers and the
 * renderer's DOM — a cache that quietly doubles under a pathological
 * conversation is how a long session turns into an out-of-memory crash.
 *
 * Eviction is strict LRU: `get` refreshes recency, `set` inserts at the newest
 * end, and the oldest entries are dropped until the budget holds again. A single
 * entry larger than the budget is still admitted (and is then the only entry):
 * refusing it would mean re-decoding it on every access, which is worse than the
 * memory it costs, and the alternative — returning nothing — would be wrong.
 *
 * @module dsh-session-optimizer/lru
 */
export class ByteLru<V> {
  private readonly entries = new Map<string, { value: V; bytes: number }>()
  private used = 0
  private readonly budget: number

  constructor(budget: number) {
    this.budget = budget
  }

  /** The value for `key`, marking it as most recently used. */
  get(key: string): V | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  /** Store `value`, dropping the coldest entries until it fits. */
  set(key: string, value: V, bytes: number): void {
    this.delete(key)
    this.entries.set(key, { value, bytes })
    this.used += bytes
    while (this.used > this.budget && this.entries.size > 1) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.delete(oldest.value)
    }
  }

  delete(key: string): void {
    const entry = this.entries.get(key)
    if (entry === undefined) return
    this.entries.delete(key)
    this.used -= entry.bytes
  }

  /**
   * Drop every entry whose key starts with `prefix`.
   *
   * The cache is shared between stores, and a write invalidates one store's
   * frames without touching anyone else's: clearing the whole map is what a
   * per-store cache used to do, and it would make one append evict the session
   * the reader is scrolling.
   */
  deletePrefix(prefix: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.delete(key)
    }
  }

  clear(): void {
    this.entries.clear()
    this.used = 0
  }

  /** Keys in eviction order, coldest first. */
  keys(): IterableIterator<string> {
    return this.entries.keys()
  }

  /** Bytes currently held, as reported by the callers that charged them. */
  get bytes(): number {
    return this.used
  }

  get size(): number {
    return this.entries.size
  }
}
