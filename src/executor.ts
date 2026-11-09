/**
 * Storage execution: every SQLite call goes through one of two executors.
 *
 * `InlineExecutor` runs the synchronous `node:sqlite` work on the caller's
 * thread. `WorkerExecutor` (worker-client.ts) ships the same operations to a
 * worker thread so a long append transaction cannot stall the agent loop — the
 * single biggest defect of the historical JSONL-era SQLite backend.
 *
 * Both executors keep an LRU of open databases (`preparedSessionCacheSize`) so a
 * hot session does not reopen the file for every append, and both expose
 * `close()` so teardown drops every connection before callers delete a root.
 *
 * The decoded-frame cache is different: it is one cache per executor, handed to
 * every connection it opens. Keeping it per connection meant five open sessions
 * held five independent eight-megabyte budgets (twenty megabytes of frames that
 * could not make room for each other) and a reader switching between two
 * conversations paid to decode the same file twice.
 */
import { statSync } from 'node:fs'
import type { SessionHeader, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'

import { ByteLru } from './lru.ts'
import {
  FRAME_CACHE_BYTES,
  SessionDatabase,
  ensureSessionDirectory,
  fileStampWithSize,
  readHeaderSnapshot,
  type LoadedHeader,
  type LoadedSession,
  type LogPage,
  type SearchHitRow,
  type SqliteSettings,
} from './database.ts'
import { findDatabasePath } from './storage.ts'

/**
 * One store's header as a listing sees it.
 *
 * `error` carries a per-store failure instead of rejecting the batch: `list()`
 * must survive one foreign or half-written file, and a batch that aborted on
 * the first bad entry would take the whole picker down. It is plain data rather
 * than an `Error` because the batch also crosses the worker boundary, and a
 * cloned error loses the class a caller might want to test for — the message is
 * all a listing warning needs.
 */
export interface HeaderBatchEntry {
  readonly path: string
  readonly header: LoadedHeader | undefined
  readonly sizeBytes: number
  readonly error: { readonly name: string; readonly message: string } | undefined
}

/** The narrow surface a persistence backend needs from the storage layer. */
export interface StorageExecutor {
  /**
   * Load a session. `window` limits how many events are decoded; the committed
   * prefix length is reported as `LoadedSession.eventCount` either way.
   */
  loadSession(
    path: string,
    settings: SqliteSettings,
    window?: { offset: number; length: number },
  ): Promise<LoadedSession | undefined>
  loadHeader(path: string, settings: SqliteSettings): Promise<LoadedHeader | undefined>
  /**
   * Load a whole log in pages, parsing each page on the caller's thread.
   *
   * `loadSession` hands back every decoded event at once, which means a long
   * resume pays the log twice: once to decode it and once to move it out of the
   * storage thread (measured on 47k events: 508ms of parse plus 860ms of clone
   * inside a 2.1s read). Paging splits that into a read of the next slice running
   * alongside the parse of this one, and moves text instead of objects, so the
   * clone disappears.
   *
   * Returns `undefined` when the store cannot be paged (no usable seal, an
   * unfinished import, a store below `PAGED_MIN_EVENTS`) or when a page did not
   * arrive as asked. The caller then reads the log with `loadSession`, which is
   * also the only path that can name a torn tail.
   */
  loadSessionPaged(
    path: string,
    settings: SqliteSettings,
    signal?: AbortSignal,
  ): Promise<LoadedSession | undefined>
  /**
   * The committed length when the seal already vouches for the log, else
   * `undefined`.
   *
   * `open(id, 'write')` used to load every event of a session only to learn its
   * next `seq`, which cost about a second on a 47k-event conversation and made
   * resuming one feel like a hang. The seal answers the same question in three
   * cheap queries; when it declines, the caller falls back to `loadSession`,
   * which is also the only path that can name a torn tail precisely.
   */
  trustedLength(path: string, settings: SqliteSettings): Promise<number | undefined>
  /**
   * How many events the file physically holds, without decoding any of them.
   *
   * A store whose row claims more than this is damaged (cut short by a crash, a
   * copy that stopped, a hand-run `DELETE`). A reader has to serve what is there
   * instead of promising the rest, so `open(id,'read')` asks this once.
   */
  storedEventCount(path: string, settings: SqliteSettings): Promise<number>
  /**
   * Read many headers at once.
   *
   * `list()` asks the same narrow question of every file in a root, and the two
   * costs that dominate it are per-store: opening a full `SessionDatabase` and —
   * on the worker executor — one message round trip each. A batch turns 200
   * round trips into one and takes the cheap read-only path per store.
   */
  listHeaders(paths: readonly string[], settings: SqliteSettings): Promise<HeaderBatchEntry[]>
  appendBatch(
    path: string,
    settings: SqliteSettings,
    header: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
    inheritedEventCount: number,
  ): Promise<void>
  materializeHeader(
    path: string,
    settings: SqliteSettings,
    header: SessionHeader,
    inheritedEventCount: number,
  ): Promise<void>
  truncateTail(path: string, settings: SqliteSettings, truncateTo: number): Promise<void>
  sizeBytes(path: string, settings: SqliteSettings): Promise<number>
  /**
   * Directory work. It lives here rather than in the service so the worker
   * executor can keep synchronous `mkdir`/`readdir`/`existsSync` off the agent
   * loop; the inline executor simply does it on the caller's thread.
   */
  ensureDirectory(path: string): Promise<void>
  findDatabase(root: string, id: string): Promise<string | undefined>

  /**
   * Full-text hits for one store, best first.
   *
   * `undefined` means the store has no index and this connection may not build
   * one — different from "no matches": the caller falls back to a scan rather
   * than telling the user their conversation does not contain a word.
   */
  searchStore(
    path: string,
    settings: SqliteSettings,
    match: string,
    limit: number,
  ): Promise<SearchHitRow[] | undefined>
  /**
   * Make sure a store's search index covers its log.
   *
   * Separate from `searchStore` because building is a write and belongs on the
   * warm-up path, not on the request that asked a question: a store written
   * before the index existed would otherwise make the first search pay for it.
   */
  indexStore(path: string, settings: SqliteSettings): Promise<boolean>
  close(): Promise<void>
}

/**
 * Bounded LRU over open databases. Eviction closes the least recently used
 * connection; `close()` drops all of them.
 */
/** Which file a path pointed at, as the filesystem names it. */
interface StoreIdentity {
  readonly dev: number
  readonly ino: number
}

interface CachedStore {
  readonly db: SessionDatabase
  readonly identity: StoreIdentity | undefined
}

function identityOf(path: string): StoreIdentity | undefined {
  try {
    const info = statSync(path)
    return { dev: info.dev, ino: info.ino }
  } catch {
    return undefined
  }
}

/**
 * Whether two observations describe the same file.
 *
 * A missing file is never "the same": a connection whose store was deleted must
 * not keep answering, or a listing would keep showing a session nobody can open.
 * Filesystems that report no inode number cannot answer this question, and for
 * them the two observations also coincide, so the answer is "unchanged" — the
 * cache then behaves exactly as it did before this check existed.
 */
function sameStore(held: StoreIdentity | undefined, seen: StoreIdentity | undefined): boolean {
  if (held === undefined || seen === undefined) return false
  return held.dev === seen.dev && held.ino === seen.ino
}

/**
 * Open databases, kept alive between calls, keyed by path.
 *
 * The identity check is not paranoia: `publishDatabase` replaces a store by
 * renaming a staged file over its name, and the console runs that inside this
 * process. A cached connection keeps reading — and writing — the inode it opened,
 * which after the swap is a file no path leads to. Without this check a converted
 * session answered from its pre-conversion log, and an append after the swap
 * landed in the unlinked copy instead of the published one.
 */
class DatabaseCache {
  private readonly entries = new Map<string, CachedStore>()

  /**
   * `capacity` is at least one: a cache of zero cannot hand a caller a live
   * connection at all (the entry would be evicted and closed before it is
   * returned). The plugin config already refuses anything below 1; this keeps a
   * directly constructed executor honest instead of failing on every call.
   */
  constructor(
    private readonly capacity: number,
    private readonly frames: ByteLru<readonly string[]>,
  ) {
    this.capacity = Math.max(1, Math.trunc(capacity) || 1)
  }

  get(path: string, settings: SqliteSettings): SessionDatabase {
    const cached = this.entries.get(path)
    if (cached !== undefined) {
      if (sameStore(cached.identity, identityOf(path))) {
        // Refresh recency: Map keeps insertion order.
        this.entries.delete(path)
        this.entries.set(path, cached)
        // A cached connection was opened under whatever settings were in force
        // then, so a switch flipped since would not reach it. Only the knobs a
        // live connection can honour are applied here; the pragmas stay as
        // opened.
        cached.db.retune(settings)
        return cached.db
      }
      // The name now leads somewhere else (or nowhere). Drop the connection
      // before opening again, so the old inode is never used again.
      this.entries.delete(path)
      cached.db.close()
    }
    const opened = SessionDatabase.open(path, settings, this.frames)
    this.entries.set(path, { db: opened, identity: identityOf(path) })
    // Evict before returning, but never the entry being handed out.
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true || oldest.value === path) break
      this.entries.get(oldest.value)?.db.close()
      this.entries.delete(oldest.value)
    }
    return opened
  }

  clear(): void {
    for (const entry of this.entries.values()) entry.db.close()
    this.entries.clear()
  }
}

/**
 * One listing entry, with failures captured rather than thrown.
 *
 * A missing file is not an error: it means the store vanished between the
 * directory scan and this read, and `list()` has nothing to report for it.
 */
function headerEntryOf(path: string, sizeBytes: number): HeaderBatchEntry {
  try {
    return { path, header: readHeaderSnapshot(path), sizeBytes, error: undefined }
  } catch (error) {
    return {
      path,
      header: undefined,
      sizeBytes,
      error: error instanceof Error
        ? { name: error.name, message: error.message }
        : { name: 'Error', message: String(error) },
    }
  }
}

/**
 * Headers read before, keyed by path, remembered together with the byte stamp
 * they were derived from.
 *
 * A session picker lists the same root over and over while nothing about most
 * stores changes; without this every refresh pays one open per store. The
 * fingerprint is checked first and an unchanged store is answered from here, so
 * a refresh costs one `stat` per store instead of a query. It cannot go stale
 * silently: the WAL grows on the first append of any batch, so the stamp moves
 * before the header it would describe can.
 */
class HeaderCache {
  private readonly entries = new Map<string, { stamp: string; entry: HeaderBatchEntry }>()

  read(path: string): HeaderBatchEntry | undefined {
    const { stamp, size } = fileStampWithSize(path)
    // `undefined` size means the stat itself failed: the file is gone or
    // unreadable, and a remembered entry for it would be a guess.
    if (size === undefined) {
      this.entries.delete(path)
      return undefined
    }
    const sizeBytes = size
    const cached = this.entries.get(path)
    if (cached !== undefined && cached.stamp === stamp) return cached.entry
    const entry = headerEntryOf(path, sizeBytes)
    // A failing store is remembered too: the failure is as stable as a header,
    // and a picker must not re-open a foreign file on every refresh.
    this.entries.set(path, { stamp, entry })
    return entry
  }

  /** Drop entries for paths that are gone; keeps a shrinking root from leaking. */
  retain(paths: readonly string[]): void {
    if (this.entries.size <= paths.length) return
    const live = new Set(paths)
    for (const path of this.entries.keys()) if (!live.has(path)) this.entries.delete(path)
  }

  clear(): void {
    this.entries.clear()
  }
}

/**
 * Logs shorter than this are read whole.
 *
 * Paging buys overlap, and overlap only pays when the log is long enough to hide
 * something behind: below a couple of thousand events a whole read is a few
 * milliseconds, and the round trips would be the larger cost.
 */
export const PAGED_MIN_EVENTS = 1500
/**
 * Events per page. A page is one round trip and one transferable buffer.
 *
 * 8192 events is about 21MB of text on the largest conversation measured here.
 * The buffer is transferred, not copied, so its size costs nothing on the way
 * over; what it buys is fewer round trips — 2048 meant 24 of them on a 47k log.
 * The measured gain was small (932 -> 918ms on that log: parsing, not messaging,
 * is the floor), but six messages instead of twenty-four is the cheaper default.
 */
const PAGE_EVENTS = 8192

/**
 * Pages kept in flight. Two would already overlap, three leaves room for the
 * storage thread to fall behind one slow parse without stalling.
 */
const PAGE_WINDOW = 3

/** Parse one page of JSON lines into `events`, or `false` if it is not clean. */
function parsePage(
  decoder: InstanceType<typeof TextDecoder>,
  page: LogPage,
  events: SessionEvent[],
): boolean {
  if (page.count === 0) return true
  const before = events.length
  let text: string
  try {
    text = decoder.decode(page.bytes)
  } catch {
    return false
  }
  for (const line of text.split('\n')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return false
    }
    if (parsed === null || typeof parsed !== 'object') return false
    events.push(parsed as SessionEvent)
  }
  // A line count that disagrees with the page means a frame was cut or a row
  // was missing: the caller has to read the log the slow way to find out which.
  return events.length - before === page.count
}

/**
 * Read a log page by page, parsing each page while the next is being read.
 *
 * `readPage` is the executor's own door to one slice, so this runs unchanged on
 * the calling thread and over the worker boundary. Every page is checked to
 * start where the previous one ended, and the assembled log has to be exactly
 * `eventCount` long; anything else falls back to `loadSession`, whose walk names
 * the exact cut.
 */
export async function assemblePaged(
  path: string,
  meta: LoadedHeader,
  readPage: (from: number, to: number) => Promise<LogPage | undefined>,
  signal: AbortSignal | undefined,
): Promise<LoadedSession | undefined> {
  const total = meta.eventCount
  const events: SessionEvent[] = []
  const decoder = new TextDecoder()
  const queue: Array<Promise<LogPage | undefined>> = []
  let next = 0
  const push = (): void => {
    if (next >= total) return
    const from = next
    const to = Math.min(total, from + PAGE_EVENTS)
    next = to
    queue.push(readPage(from, to))
  }
  for (let index = 0; index < PAGE_WINDOW; index += 1) push()
  while (queue.length > 0) {
    signal?.throwIfAborted()
    const page = await (queue.shift() as Promise<LogPage | undefined>)
    if (page === undefined) return undefined
    if (page.firstSeq !== events.length) return undefined
    if (!parsePage(decoder, page, events)) return undefined
    push()
  }
  if (events.length !== total) return undefined
  const location = { kind: 'sqlite', path }
  validateStoredEvents(meta.header, events, location)
  return {
    header: meta.header,
    inheritedEventCount: meta.inheritedEventCount,
    revision: meta.revision,
    events,
    eventCount: total,
    storeUuid: meta.storeUuid,
    state: meta.state,
    tornTruncateTo: undefined,
    path,
  }
}

/** Run the SQLite work on this thread. */
export class InlineExecutor implements StorageExecutor {
  private readonly cache: DatabaseCache
  private readonly headers = new HeaderCache()
  private readonly frames = new ByteLru<readonly string[]>(FRAME_CACHE_BYTES)

  constructor(preparedSessionCacheSize: number) {
    this.cache = new DatabaseCache(preparedSessionCacheSize, this.frames)
  }

  /**
   * Bytes of decoded frames this executor holds, across every store it opened.
   *
   * Exposed so a benchmark can report the resident set instead of inferring it
   * from the number of open sessions.
   */
  frameBytes(): number {
    return this.frames.bytes
  }

  async loadSession(
    path: string,
    settings: SqliteSettings,
    window?: { offset: number; length: number },
  ): Promise<LoadedSession | undefined> {
    return this.cache.get(path, settings).loadSession(window)
  }

  async loadHeader(path: string, settings: SqliteSettings): Promise<LoadedHeader | undefined> {
    return this.cache.get(path, settings).loadHeader()
  }

  async loadSessionPaged(
    path: string,
    settings: SqliteSettings,
    signal?: AbortSignal,
  ): Promise<LoadedSession | undefined> {
    const store = this.cache.get(path, settings)
    const meta = store.pagedHeader()
    if (meta === undefined || meta.eventCount < PAGED_MIN_EVENTS) return undefined
    return assemblePaged(
      path,
      meta,
      (from, to) => Promise.resolve(store.readPageBytes(from, to)),
      signal,
    )
  }

  /**
   * The header a paged read needs, for a client that drives the pages itself.
   *
   * The worker boundary is why this is separate from `loadSessionPaged`: there
   * the pages have to be requested one message at a time so the parse of one
   * overlaps the read of the next, and only the caller can decide when to stop.
   */
  pagedHeader(path: string, settings: SqliteSettings): LoadedHeader | undefined {
    return this.cache.get(path, settings).pagedHeader()
  }

  /** One page of the log as bytes, for a client that drives the pages itself. */
  readPage(path: string, settings: SqliteSettings, from: number, to: number): LogPage | undefined {
    return this.cache.get(path, settings).readPageBytes(from, to)
  }

  async trustedLength(path: string, settings: SqliteSettings): Promise<number | undefined> {
    return this.cache.get(path, settings).trustedLength()
  }

  async storedEventCount(path: string, settings: SqliteSettings): Promise<number> {
    return this.cache.get(path, settings).storedEventCount()
  }

  async listHeaders(paths: readonly string[], settings: SqliteSettings): Promise<HeaderBatchEntry[]> {
    void settings
    this.headers.retain(paths)
    const entries: HeaderBatchEntry[] = []
    for (const path of paths) {
      const entry = this.headers.read(path)
      // A store that vanished between the scan and the stat has nothing to say.
      if (entry !== undefined) entries.push(entry)
    }
    return entries
  }

  async appendBatch(
    path: string,
    settings: SqliteSettings,
    header: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
    inheritedEventCount: number,
  ): Promise<void> {
    this.cache.get(path, settings).appendBatch(header, events, isMaterialized, inheritedEventCount)
  }

  async materializeHeader(
    path: string,
    settings: SqliteSettings,
    header: SessionHeader,
    inheritedEventCount: number,
  ): Promise<void> {
    this.cache.get(path, settings).materializeHeader(header, inheritedEventCount)
  }

  async truncateTail(path: string, settings: SqliteSettings, truncateTo: number): Promise<void> {
    this.cache.get(path, settings).truncateTail(truncateTo)
  }

  async sizeBytes(path: string, settings: SqliteSettings): Promise<number> {
    // Statting a file must not open it (and must never create or initialize a
    // store just to learn its size), so the cache is not consulted here.
    void settings
    try {
      return statSync(path).size
    } catch {
      return 0
    }
  }

  async searchStore(
    path: string,
    settings: SqliteSettings,
    match: string,
    limit: number,
  ): Promise<SearchHitRow[] | undefined> {
    const cached = this.cache.get(path, settings).searchHits(match, limit)
    if (cached !== undefined) return cached
    // The store predates the index and this handle is read-only. Indexing is a
    // write, so borrow a writable handle for exactly that, then ask again. A
    // store we may not write (a read-only mount, someone else's file) answers
    // `undefined` instead of throwing: a search must not fail because its index
    // could not be built, and the caller still knows the difference.
    try {
      if (!(await this.indexStore(path, settings))) return undefined
    } catch {
      return undefined
    }
    return this.cache.get(path, settings).searchHits(match, limit)
  }

  async indexStore(path: string, settings: SqliteSettings): Promise<boolean> {
    const writer = SessionDatabase.open(path, { ...settings, readOnly: false })
    try {
      return writer.ensureSearchIndex()
    } finally {
      writer.close()
    }
  }

  async close(): Promise<void> {
    this.cache.clear()
    this.headers.clear()
    this.frames.clear()
  }

  async ensureDirectory(path: string): Promise<void> {
    ensureSessionDirectory(path)
  }

  async findDatabase(root: string, id: string): Promise<string | undefined> {
    return findDatabasePath(root, id as SessionId)
  }
}
