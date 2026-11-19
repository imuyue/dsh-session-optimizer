/**
 * Read-only inspection of a SQLite persistence root, for the Web GUI console.
 *
 * Every function here opens session databases with `readOnly: true` and never
 * writes: no directory is created, no WAL/SHM side car is added, and no pragma
 * is persisted. A damaged or foreign file is reported per conversation
 * (`problem`) instead of thrown, so one bad database cannot hide the rest of the
 * root.
 *
 * One question is asked from here — "what is in this root and is it healthy" —
 * because that is the only question the console asks. The console shows three
 * views, and the two others (conversation conversion, latency) read their own
 * sources.
 *
 * @module dsh-session-optimizer/inspect
 */

import { readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { decodeChunk } from './chunk.ts'
import { fileStamp, type SqliteSettings } from './database.ts'
import { DATABASE_FILENAME, encodeSegment } from './format.ts'
import { ByteLru } from './lru.ts'
import { APPLICATION_ID, READABLE_VERSIONS, SCHEMA_VERSION } from './schema.ts'

/** Where the running backend stores conversations, and how it opens them. */
export interface InspectTarget {
  readonly root: string
  readonly settings: SqliteSettings
  readonly storageThread: 'worker' | 'inline'
}

/** One conversation as the space-usage table shows it. */
export interface InspectUsage {
  readonly origin?: 'subagent'
  readonly parentSession?: string
  readonly id: string
  /** Newest `session/title` in the log, when the conversation has one. */
  readonly title: string | undefined
  readonly eventCount: number
  readonly sizeBytes: number
  readonly walBytes: number
  readonly state: 'importing' | 'ready' | 'unknown'
  /** First structural disagreement found while reading this file; still listed. */
  readonly problem: string | undefined
}

/** Root-wide totals, the pragmas this build applied, and the per-conversation rows. */
export interface InspectOverview {
  readonly root: string
  readonly storageThread: 'worker' | 'inline'
  readonly applicationId: number
  readonly schemaVersion: number
  readonly journalMode: string
  readonly synchronous: string
  readonly busyTimeoutMs: number
  readonly sessions: number
  readonly ready: number
  readonly importing: number
  readonly damaged: number
  readonly events: number
  readonly databaseBytes: number
  readonly walBytes: number
  readonly checkedAt: number
  /** Permission bits of the root directory, already in octal (`0700`). */
  readonly rootMode: string
  /**
   * Whether only the owner can reach the root.
   *
   * `undefined` when the question does not apply to this host: Windows mode bits
   * are synthetic, so reporting `0666` there would be a false alarm.
   */
  readonly rootPrivate: boolean | undefined
  /** Largest first, which is the order the panel ranks them in. */
  readonly usage: readonly InspectUsage[]
}

interface SessionRow {
  readonly session_id: string
  readonly header_json: string
  readonly inherited_event_count: number
  readonly event_count: number
  readonly revision: number
  readonly state: string
  readonly updated_at_ms: number
}

interface StoreRow {
  readonly store_uuid: string
  readonly schema_version: number
  readonly dsh_contract_version: number
}

/**
 * One sealed frame, as far as a reader needs to know.
 *
 * `types` is the stored histogram, so finding the newest title never has to
 * decompress a frame that does not carry one: the log lives in two places now,
 * and the cheap one has to answer the questions the expensive one used to.
 */
interface ChunkMeta {
  readonly firstSeq: number
  readonly eventCount: number
  readonly types: Readonly<Record<string, number>>
}

/** Sealed frames in log order; empty for a store still entirely in rows. */
function chunkMetas(db: DatabaseSync): ChunkMeta[] {
  let rows: Array<{ first_seq: unknown; event_count: unknown; types_json: unknown }>
  try {
    rows = db
      .prepare('SELECT first_seq, event_count, types_json FROM event_chunk ORDER BY first_seq')
      .all() as unknown as Array<{ first_seq: unknown; event_count: unknown; types_json: unknown }>
  } catch {
    // A store written by a build without chunks: everything is in the rows.
    return []
  }
  return rows.map((row) => {
    let types: Record<string, number> = {}
    try {
      const parsed: unknown = JSON.parse(String(row.types_json))
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        types = parsed as Record<string, number>
      }
    } catch {
      // A histogram that will not parse costs an accurate count, not the log.
    }
    return {
      firstSeq: Number(row.first_seq),
      eventCount: Number(row.event_count),
      types,
    }
  })
}

/**
 * Logical log length and key bounds, counting sealed frames and rows together.
 *
 * Contiguity is reported from these three numbers, and a store whose front is
 * compressed would otherwise look like it began at whatever seq the tail happens
 * to start with.
 */
function logBounds(db: DatabaseSync, metas: readonly ChunkMeta[]): {
  total: number
  first: number | undefined
  last: number | undefined
} {
  const sealedCount = metas.reduce((sum, meta) => sum + meta.eventCount, 0)
  const sealedLast =
    metas.length === 0 ? undefined : metas[metas.length - 1]!.firstSeq + metas[metas.length - 1]!.eventCount - 1
  const tail = db
    .prepare('SELECT count(*) AS total, min(seq) AS first, max(seq) AS last FROM session_event')
    .get() as { total: unknown; first: unknown; last: unknown }
  const tailCount = Number(tail.total)
  const tailFirst = tail.first === null ? undefined : Number(tail.first)
  const tailLast = tail.last === null ? undefined : Number(tail.last)
  return {
    total: sealedCount + tailCount,
    first: sealedCount > 0 ? metas[0]!.firstSeq : tailFirst,
    last: tailCount > 0 ? tailLast : sealedLast,
  }
}

/** A database opened for reading; `error` is set instead of throwing. */
interface ReadResult {
  readonly applicationId: number
  readonly userVersion: number
  readonly journalMode: string
  readonly store: StoreRow | undefined
  readonly row: SessionRow | undefined
  readonly header: SessionHeader | undefined
  /** Newest `session/title` payload in the log, when there is one. */
  readonly title: string | undefined
  readonly counted: { readonly total: number; readonly first: number | undefined; readonly last: number | undefined }
  readonly error: string | undefined
}

function modeBits(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777
  } catch {
    return undefined
  }
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function octal(bits: number | undefined): string {
  return bits === undefined ? '—' : `0${bits.toString(8).padStart(3, '0')}`
}

/** One conversation's row, as both the cache and the table carry it. */
interface UsageRow {
  readonly usage: InspectUsage
  readonly directory: string
  readonly path: string
}

/**
 * Header snapshots, keyed by database path.
 *
 * The overview re-reads every header on every refresh, which is its whole cost
 * once an operator has more than a handful of logs — and the expensive part of
 * that read is the open, not the row: five pragmas, two selects, a JSON parse per
 * chunk and a title lookup. A cache that only skipped rebuilding the row would
 * save nothing, so the decision to open is made from the file itself.
 *
 * `stamp` is `dev:ino:size@mtime` of the database and its WAL, which is what
 * `fileStamp` already reads for the write path. Two `stat` calls decide whether
 * this file can have changed at all; when it cannot, the row is answered without
 * opening anything. The inode is in there on purpose: `cp -p`, `rsync -t` and
 * `tar -x` all restore mtimes, but they replace the inode, so a restored copy is
 * still a miss.
 *
 * What the stamp cannot see is a tool that rewrites the file in place, on the
 * same inode, to the same size, with the mtime restored. Every real writer bumps
 * the size and the mtime, so the failure mode is this diagnostics view showing
 * counts one write old until the next write, and the row is read again as soon
 * as anything appends. Nothing in the panel makes a decision from these numbers
 * that would be unsafe one write late.
 *
 * The bound is bytes, not entries: a row carries the decoded header (which
 * includes an arbitrary `agentPreset` and `cwd`) and a path.
 *
 * Deliberately never persisted: it is a per-process optimisation, and a fresh
 * process simply reads the headers again.
 */
const HEADER_CACHE_BYTES = 8 << 20

/** One cached row together with the file stamp it was read under. */
interface CachedRow {
  readonly stamp: string
  readonly value: UsageRow
}

const headerCache = new ByteLru<CachedRow>(HEADER_CACHE_BYTES)

/** Rough charge for one row: its strings plus the object overhead. */
function rowBytes(row: UsageRow): number {
  return (
    row.usage.id.length +
    row.path.length +
    row.directory.length +
    (row.usage.title?.length ?? 0) +
    (row.usage.problem?.length ?? 0) +
    256
  )
}

/** One conversation's row, reusing the cached snapshot while its stamp holds. */
function rowCached(entry: { directory: string; path: string }): UsageRow {
  // The stamp is taken before the read: a file that changes while it is being
  // read is stored under the older stamp, so the next refresh reads it again
  // instead of serving a row assembled from two different states.
  const stamp = fileStamp(entry.path)
  const cached = headerCache.get(entry.path)
  if (cached !== undefined && cached.stamp === stamp) return cached.value
  const read = readOne(entry.path)
  const value = rowOf(entry, read)
  headerCache.set(entry.path, { stamp, value }, rowBytes(value))
  return value
}

/** Every `<root>/<project>/<session>/session.db`, tolerating unreadable levels. */
export function scanDatabasePaths(root: string): Array<{ directory: string; path: string }> {
  const found: Array<{ directory: string; path: string }> = []
  let projects: string[]
  try {
    projects = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return found
  }
  for (const project of projects) {
    const projectPath = join(root, project)
    let sessions: string[]
    try {
      sessions = readdirSync(projectPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      continue
    }
    for (const session of sessions) {
      const directory = join(projectPath, session)
      const path = join(directory, DATABASE_FILENAME)
      if (modeBits(path) === undefined) continue
      found.push({ directory, path })
    }
  }
  return found
}

function readHeaderJson(json: string): SessionHeader | undefined {
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const header = parsed as { id?: unknown }
    if (typeof header.id !== 'string') return undefined
    return parsed as unknown as SessionHeader
  } catch {
    return undefined
  }
}

/** Open one database read-only and collect what the panel needs. */
function readOne(path: string): ReadResult {
  const empty: ReadResult = {
    applicationId: 0,
    userVersion: 0,
    journalMode: 'unknown',
    store: undefined,
    row: undefined,
    header: undefined,
    title: undefined,
    counted: { total: 0, first: undefined, last: undefined },
    error: undefined,
  }
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const applicationId = Number(
      (db.prepare('PRAGMA application_id').get() as Record<string, unknown> | undefined)?.[
        'application_id'
      ] ?? 0,
    )
    const userVersion = Number(
      (db.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined)?.[
        'user_version'
      ] ?? 0,
    )
    const journalMode = String(
      (db.prepare('PRAGMA journal_mode').get() as Record<string, unknown> | undefined)?.[
        'journal_mode'
      ] ?? 'unknown',
    )
    // Identity is a pragma, not a table: a foreign file is recognised before any
    // schema query, so the report names the real disagreement instead of the
    // "no such table" the query would have thrown.
    if (applicationId !== APPLICATION_ID) {
      return { ...empty, applicationId, userVersion, journalMode }
    }
    let store: StoreRow | undefined
    let row: SessionRow | undefined
    let title: string | undefined
    let counted = empty.counted
    try {
      store = db
        .prepare(
          'SELECT store_uuid, schema_version, dsh_contract_version FROM storage_meta WHERE singleton = 1',
        )
        .get() as StoreRow | undefined
      row = db
        .prepare(
          `SELECT session_id, header_json, inherited_event_count, event_count, revision, state, updated_at_ms
             FROM session WHERE singleton = 1`,
        )
        .get() as SessionRow | undefined
      const metas = chunkMetas(db)
      const aggregate = logBounds(db, metas)
      counted = {
        total: aggregate.total,
        first: aggregate.first,
        last: aggregate.last,
      }
      title = titleOf(db, metas)
    } catch (error) {
      return { ...empty, applicationId, userVersion, journalMode, error: describe(error) }
    }
    const header = row === undefined ? undefined : readHeaderJson(String(row.header_json))
    return {
      applicationId,
      userVersion,
      journalMode,
      store,
      row,
      header,
      title,
      counted,
      error: undefined,
    }
  } catch (error) {
    return { ...empty, error: describe(error) }
  } finally {
    try {
      db?.close()
    } catch {
      // A connection that failed to open has nothing to close.
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The newest `session/title` in one store, read without changing anything.
 *
 * Exposed for the conversion picker, which lists stores it did not mount.
 */
export function storedTitle(path: string): string | undefined {
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path, { readOnly: true })
    return titleOf(db, chunkMetas(db))
  } catch {
    return undefined
  } finally {
    try {
      db?.close()
    } catch {
      // A connection that failed to open has nothing to close.
    }
  }
}

/**
 * The newest `session/title` in one log.
 *
 * A conversation carries its title as an ordinary event and renames itself by
 * appending another one, so the last one wins. Rows are searched first by
 * primary-key range; when the tail has no title, the newest sealed frame that
 * reports one in its histogram is opened — the title may have been sealed away
 * while the conversation went on, and a rename is the only title a long
 * conversation ever gets after its first frame.
 */
function titleOf(db: DatabaseSync, metas: readonly ChunkMeta[]): string | undefined {
  let row: { event_json: string } | undefined
  try {
    row = db
      .prepare(
        `SELECT event_json FROM session_event
          WHERE event_type = 'session/title'
          ORDER BY seq DESC LIMIT 1`,
      )
      .get() as { event_json: string } | undefined
  } catch {
    // An older store without the type in its vocabulary is simply untitled.
    return undefined
  }
  if (row !== undefined) return titleIn(String(row.event_json))
  for (let index = metas.length - 1; index >= 0; index -= 1) {
    const meta = metas[index]!
    if ((meta.types['session/title'] ?? 0) === 0) continue
    let payload: unknown
    try {
      payload = (
        db.prepare('SELECT payload FROM event_chunk WHERE first_seq = ?').get(meta.firstSeq) as
          | { payload: unknown }
          | undefined
      )?.payload
    } catch {
      return undefined
    }
    if (payload === undefined) return undefined
    let events
    try {
      events = decodeChunk(payload as Uint8Array, meta)
    } catch {
      return undefined
    }
    for (let inner = events.length - 1; inner >= 0; inner -= 1) {
      const event = events[inner]!
      // `session/title` is not part of the released event vocabulary the type
      // union covers, so the comparison is against the stored string.
      if (String(event.type) !== 'session/title') continue
      const title = titleIn(JSON.stringify(event))
      if (title !== undefined) return title
    }
  }
  return undefined
}

/** The `data.title` of one serialized event, when it has a usable one. */
function titleIn(json: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const data = (parsed as { data?: unknown }).data
    if (typeof data !== 'object' || data === null) return undefined
    const title = (data as { title?: unknown }).title
    return typeof title === 'string' && title !== '' ? title : undefined
  } catch {
    return undefined
  }
}

/** The first structural disagreement in one file, if any. */
function problemOf(path: string, read: ReadResult): string | undefined {
  if (read.error !== undefined) return read.error
  if (read.applicationId !== APPLICATION_ID) {
    return `not a dsh-session-optimizer store: application_id is ${read.applicationId}, expected ${APPLICATION_ID}`
  }
  if (!READABLE_VERSIONS.includes(read.userVersion)) {
    return `layout version ${read.userVersion}, this build reads ${READABLE_VERSIONS.join(', ')}`
  }
  if (read.row === undefined) return 'no session row'
  if (read.header === undefined) return 'session header is not readable'
  if (read.header.id !== String(read.row.session_id)) {
    return `header id "${read.header.id}" disagrees with session_id "${read.row.session_id}"`
  }
  if (basename(dirname(path)) !== encodeSegment(read.header.id)) {
    return 'session directory name does not encode the stored id'
  }
  const { total, first, last } = read.counted
  if (total > 0 && (first !== 0 || last === undefined || last - first + 1 !== total)) {
    return `event rows are not contiguous (${total} rows, seq ${first}…${last})`
  }
  return undefined
}

function rowOf(entry: { directory: string; path: string }, read: ReadResult): UsageRow {
  const header = read.header
  const row = read.row
  return {
    directory: entry.directory,
    path: entry.path,
    usage: {
      id: header?.id ?? String(row?.session_id ?? basename(entry.directory)),
      title: read.title,
      ...(header?.origin === 'subagent' ? { origin: 'subagent' as const, ...(header.parentSession === undefined ? {} : { parentSession: String(header.parentSession) }) } : {}),
      eventCount: row === undefined ? read.counted.total : Number(row.event_count),
      sizeBytes: fileBytes(entry.path),
      walBytes: fileBytes(`${entry.path}-wal`),
      state: row === undefined ? 'unknown' : row.state === 'importing' ? 'importing' : 'ready',
      problem: problemOf(entry.path, read),
    },
  }
}

/** Every conversation under the root, largest first. */
function usageOf(root: string): UsageRow[] {
  return scanDatabasePaths(root)
    .map(rowCached)
    .sort((left, right) => right.usage.sizeBytes - left.usage.sizeBytes || left.usage.id.localeCompare(right.usage.id))
}

/**
 * Root-wide totals, the pragmas in force, and one row per conversation.
 *
 * Reads every header; event bodies stay untouched. One unreadable file is
 * reported as a row with a `problem` rather than hiding the rest of the root.
 */
export function inspectOverview(target: InspectTarget): InspectOverview {
  const rows = usageOf(target.root)
  let events = 0
  let databaseBytes = 0
  let walBytes = 0
  let ready = 0
  let importing = 0
  let damaged = 0
  for (const row of rows) {
    events += row.usage.eventCount
    databaseBytes += row.usage.sizeBytes
    walBytes += row.usage.walBytes
    if (row.usage.problem !== undefined) damaged += 1
    if (row.usage.state === 'ready') ready += 1
    else if (row.usage.state === 'importing') importing += 1
  }
  const bits = modeBits(target.root)
  return {
    root: target.root,
    storageThread: target.storageThread,
    applicationId: APPLICATION_ID,
    schemaVersion: SCHEMA_VERSION,
    journalMode: target.settings.journalMode,
    synchronous: target.settings.synchronous,
    busyTimeoutMs: target.settings.busyTimeoutMs,
    sessions: rows.length,
    ready,
    importing,
    damaged,
    events,
    databaseBytes,
    walBytes,
    checkedAt: Date.now(),
    rootMode: octal(bits),
    // Windows mode bits are synthetic; there the question is not asked.
    rootPrivate: process.platform === 'win32' || bits === undefined ? undefined : (bits & 0o077) === 0,
    usage: rows.map((row) => row.usage),
  }
}
