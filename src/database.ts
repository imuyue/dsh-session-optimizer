/**
 * The physical engine: one SQLite file per session, opened for the duration of
 * one operation. Every mutating call runs inside `BEGIN IMMEDIATE`, so an append
 * is one durable transaction and a reader never observes half a batch.
 *
 * `node:sqlite` is synchronous. The service keeps these calls off the
 * session-visible path by batching live events (fixed window) and by queueing
 * handle operations behind one promise chain.
 *
 * @module dsh-session-optimizer/database
 */

import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { zstdDecompressSync } from 'node:zlib'
import {
  KNOWN_SESSION_EVENT_TYPES,
  SESSION_FORMAT_VERSION,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import {
  SessionFormatUnsupportedError,
  SessionPersistenceCorruptionError,
  assertVersion,
  validateStoredEvents,
  type SessionLocation,
} from '@deepseek-ai/dsh-session-persistence'
import {
  CHUNK_BYTES,
  CHUNK_CODEC,
  decodeChunk,
  decodeChunkLines,
  decodeChunkRange,
  encodeChunk,
  type EncodedChunk,
} from './chunk.ts'
import { ByteLru } from './lru.ts'
import { pageLinesWithinBudget, type PageTransferFormat } from './page-transfer.ts'
import { searchableText, semanticTextOf } from './search.ts'
import {
  APPLICATION_ID,
  AUXILIARY_STATEMENTS,
  READABLE_VERSIONS,
  SCHEMA_STATEMENTS,
  SCHEMA_VERSION,
} from './schema.ts'

/** Tunables mirrored from the plugin config onto every file open. */
export interface SqliteSettings {
  readonly journalMode: 'wal' | 'delete' | 'truncate' | 'persist'
  readonly synchronous: 'full' | 'normal'
  readonly busyTimeoutMs: number
  /**
   * Open an existing store for reading without creating anything.
   *
   * A read-only connection never creates the file, the directory, or a `-wal`
   * sidecar, and it cannot change `journal_mode` — so a diagnostic can inspect a
   * store that another process owns without leaving a trace on disk.
   */
  readonly readOnly?: boolean | undefined
  /**
   * Let a read-only open top up what a store from an older build lacks (the fold
   * index and the seal table).
   *
   * Defaults to true: without them every windowed read decodes the whole log. A
   * caller that promised not to touch the file — a migration treating its source
   * as immutable — sets it false, and then such a store simply has no seal to
   * lean on, which costs decode time rather than correctness.
   */
  readonly repair?: boolean | undefined
  /**
   * Seal appended events into compressed frames.
   *
   * Defaults to true. It is what keeps the decode cost of a window bounded as a
   * conversation grows: without it every event stays its own row and every
   * windowed read decodes the whole tail. The settings view turns it off to get
   * the legacy layout back — one row per event, no `event_chunk` growth — which
   * is exactly the behaviour that made a long conversation expensive to read.
   *
   * Turning it off does not unseal what is already framed: those frames stay
   * readable, and only the rows appended afterwards stay rows.
   */
  readonly seal?: boolean | undefined
}

/** Raw JSON lines, never parsed event objects, in either supported wire form. */
export type LogPage = {
  readonly firstSeq: number
  readonly count: number
} & ({
  /** Absent on legacy byte pages. */
  readonly format?: 'bytes'
  readonly bytes: Uint8Array
  readonly lines?: never
} | {
  readonly format: 'lines'
  readonly lines: readonly string[]
  readonly bytes?: never
})

/** A session row plus the committed event prefix. */
export interface LoadedSession {
  readonly header: SessionHeader
  readonly inheritedEventCount: number
  readonly revision: number
  readonly events: readonly SessionEvent[]
  /**
   * Length of the committed prefix. With a windowed read this is larger than
   * `events.length`: the log's total length is what a handle tracks, and it is
   * derived from the index instead of from decoding every row.
   */
  readonly eventCount: number
  /** Immutable store identity, part of every snapshot revision token. */
  readonly storeUuid: string
  /** Stored lifecycle state; `importing` means a migration was interrupted. */
  readonly state: 'importing' | 'ready'
  /**
   * Index of the first row that does not continue the committed prefix, or
   * `undefined` when the stored log is whole. Such a row is never served; the
   * write path deletes it before the next append.
   */
  readonly tornTruncateTo: number | undefined
  /** Where this log lives, so a handle can read it again without scanning. */
  readonly path: string
}

/** A session row without decoding the event log — used by `stat` and `list`. */
export interface LoadedHeader {
  readonly header: SessionHeader
  readonly inheritedEventCount: number
  readonly revision: number
  readonly eventCount: number
  /**
   * How many events the file actually holds, counted rather than claimed.
   *
   * Present only where the count was actually taken (the listing snapshot). The
   * header read on an already-open connection leaves it out: `eventCount` is what
   * the row says, and the callers of a live handle either already re-count
   * (`storedEventCount`, `trustedLength`) or must see the claim to detect that it
   * disagrees. A listing, in contrast, is the picker: repeating a claim there
   * promises events the file cannot deliver, which is exactly what makes a store
   * cut short by a crash look healthy.
   */
  readonly heldEventCount?: number
  readonly storeUuid: string
  /** Stored lifecycle state; `importing` means a migration was interrupted. */
  readonly state: 'importing' | 'ready'
  /**
   * The row's own `updated_at_ms`. Exposed so a reader can tell two header reads
   * apart without comparing the whole decoded header.
   */
  readonly updatedAtMs: number
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

interface EventRow {
  readonly seq: number
  readonly event_type: string
  readonly event_time_ms: number
  readonly event_json: string
}

/** A row-shaped object from `node:sqlite` is not narrowed for us. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * A fingerprint of the store's bytes, cheap enough to take on every read.
 *
 * The size and mtime of the database and of its write-ahead log move on any
 * write: an append grows the WAL without touching the main file, a checkpoint
 * moves both, and a closed store has no WAL. So "the stamp is unchanged" is a
 * sound reason to believe nothing was written, and unlike a checksum it costs
 * two stats instead of a pass over the table.
 *
 * The device and inode are part of the stamp because a stamp also has to tell
 * one file from another: `publishDatabase` replaces a store by renaming a staged
 * file over its name, and a replacement that happens to match in size and
 * mtime — a re-import of the same conversation does — would otherwise read as
 * "unchanged" while every byte behind it is new.
 */
export function fileStamp(path: string): string {
  return fileStampWithSize(path).stamp
}

/**
 * The stamp, plus the database's own size.
 *
 * Callers that want both used to stat the file themselves and then call
 * `fileStamp`, which stats it again — three `stat` calls per store on a path a
 * session picker walks on every refresh. The size comes out of the stat the
 * stamp needed anyway.
 *
 * `ctimeMs` is in the stamp because it is the one timestamp a writer cannot put
 * back: a rewrite that restores `mtimeMs` and keeps the size still moves the
 * inode change time. That matters beyond caching a row — the header cache is
 * keyed by this stamp, and what it caches about a store includes whether the
 * store was readable at all. Judging "healthy" from a stamp that a repair could
 * fail to move would keep reporting damage after it was fixed, so the stamp
 * leans on the field that only the kernel writes.
 */
export function fileStampWithSize(path: string): { stamp: string; size: number | undefined } {
  let size: number | undefined
  const part = (file: string): string => {
    try {
      const stat = statSync(file)
      if (file === path) size = stat.size
      return `${String(stat.dev)}:${String(stat.ino)}:${String(stat.size)}@${stat.mtimeMs.toFixed(3)}+${stat.ctimeMs.toFixed(3)}`
    } catch {
      return 'absent'
    }
  }
  const stamp = `${part(path)}|${part(`${path}-wal`)}`
  return { stamp, size }
}

/** Create the session directory (mode 0700) when it is missing. */
export function ensureSessionDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
}

/**
 * Create the database file exclusively with mode 0600.
 *
 * The file has to exist before SQLite opens it: SQLite would create it using the
 * process umask, which on many systems leaves a session log world-readable.
 * Returns `true` when this call created the file.
 */
function ensureDatabaseFile(path: string): boolean {
  if (existsSync(path)) return false
  closeSync(openSync(path, 'wx', 0o600))
  return true
}

function readPragma(db: DatabaseSync, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined
  const value = row?.[name]
  return typeof value === 'number' ? value : Number(value ?? 0)
}

function countUserTables(db: DatabaseSync): number {
  // Only the core tables count as identity. `session_seal` and its index are
  // additions an older store gains on its first writable open, so a file that
  // has them but not the core three is still not a store — and a file with the
  // core three is a store whether or not it has been upgraded yet.
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM sqlite_schema
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
          AND name IN ('storage_meta', 'session', 'session_event')`,
    )
    .get() as { n: unknown } | undefined
  return Number(row?.n ?? 0)
}

/** Whether one named table exists in this connection's schema. */
function hasTable(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?`)
    .get(table)
  return row !== undefined
}

/** Page cache per connection: 16 MiB, up from SQLite's ~2 MiB default. */
const CACHE_KIB = -16000

/** Memory-map window: 64 MiB per connection, so ranges are read without copies. */
const MMAP_BYTES = 67_108_864

/**
 * Freed bytes that justify converting an old store to incremental auto-vacuum.
 *
 * A store created before the pragma was set has no way to shrink: sealed rows
 * leave free pages the file keeps. One `VACUUM` fixes that permanently, but it
 * rewrites the whole file, so it waits until a compaction has freed at least
 * this much — 8 MiB is a few prompts' worth of threshold and a quarter of a
 * second on a large store, against doing it on every open.
 */
const LEGACY_VACUUM_BYTES = 8 << 20

/**
 * Tail rows beyond which the vocabulary scan stops being a shortcut.
 *
 * Scans a b-tree of `event_type` values; the walk it replaces decodes and
 * validates the same rows, so the crossover is not far above zero. It is set
 * where a scan is still plainly cheaper than JSON-parsing every row.
 */
const FAST_PATH_MAX_TAIL_ROWS = 4096

/**
 * Rows written between seals when compaction is off.
 *
 * Without compaction the unsealed tail is the whole log, so every seal is an
 * aggregate over all of it: resealing per batch makes writing one long
 * conversation quadratic in the number of batches. Skipping is safe — a sealed
 * proof is a read-side shortcut, and a stale one only sends the reader down the
 * walk a store with no seal pays anyway — but every skipped seal also drops the
 * resume fast path for that window, so the interval is not free either.
 *
 * The two costs meet at the same number: once the tail is longer than
 * `FAST_PATH_MAX_TAIL_ROWS`, `trustedLength()` declines the vocabulary scan and
 * walks the log regardless. Resealing exactly then keeps the tail inside the
 * window where a fast resume is still possible, and makes the seal cost one
 * aggregate per window instead of one per batch.
 */
const RESEAL_ROWS = FAST_PATH_MAX_TAIL_ROWS

/**
 * How much decoded chunk text stays resident per open store.
 *
 * Eight megabytes is the working set of the page above and the page below the
 * viewport at the 500-event page the history reader asks for. It is a byte
 * budget rather than a frame count because a frame's size is only bounded from
 * above: a short final frame may hold a dozen events while a frame full of long
 * assistant messages holds a thousand, so "eight frames" describes anywhere from
 * two to twenty megabytes — not a number to leave to chance in a process that
 * also runs the model.
 */
export const FRAME_CACHE_BYTES = 8 << 20

/** Any character outside Latin-1 makes V8 store the whole string in UTF-16. */
const TWO_BYTE_TEXT = /[^\u0000-\u00ff]/

/**
 * Heap cost of decoded lines, in bytes.
 *
 * A JS string spends one byte per character only while every character fits in
 * Latin-1; one CJK character anywhere in the string doubles the whole string. One
 * scan per line decides which factor applies, which is nothing next to the
 * decompression that produced the line.
 */
function residentBytes(lines: readonly string[]): number {
  let bytes = 0
  for (const line of lines) bytes += line.length * (TWO_BYTE_TEXT.test(line) ? 2 : 1)
  return bytes
}

/**
 * Per-connection pragmas.
 *
 * `synchronous = FULL` is what makes `flush` a real durability barrier, and
 * `journal_mode` refuses to change inside a transaction — so this must run
 * before any write, including the schema-creating transaction. The cache and
 * mmap settings are read-mostly tuning: the default 2 MiB page cache is smaller
 * than a large session log, which turns one append into thousands of repeated
 * page reads.
 */
function applySettings(db: DatabaseSync, settings: SqliteSettings): void {
  // `journal_mode` is an attribute of the file, not of the connection: a
  // read-only handle cannot set it, and trying would turn an inspection into a
  // failed open.
  if (settings.readOnly !== true) db.exec(`PRAGMA journal_mode = ${settings.journalMode}`)
  db.exec(`PRAGMA synchronous = ${settings.synchronous === 'normal' ? 'NORMAL' : 'FULL'}`)
  db.exec(`PRAGMA busy_timeout = ${settings.busyTimeoutMs}`)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`PRAGMA cache_size = ${CACHE_KIB}`)
  db.exec(`PRAGMA mmap_size = ${MMAP_BYTES}`)
}

/**
 * Create the schema, the storage identity row and both version stamps in one
 * transaction, so a store is never left half-initialized.
 */
function initializeStore(db: DatabaseSync): string {
  const storeUuid = randomUUID()
  const now = Date.now()
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const statement of SCHEMA_STATEMENTS) db.exec(statement)
    db.prepare(
      `INSERT INTO storage_meta
         (singleton, store_uuid, schema_version, dsh_contract_version, created_at_ms, updated_at_ms)
       VALUES (1, ?, ?, ?, ?, ?)`,
    ).run(storeUuid, SCHEMA_VERSION, SESSION_FORMAT_VERSION, now, now)
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // keep the original failure
    }
    throw error
  }
  // Compaction moves rows into frames, which leaves the pages those rows used
  // behind as free pages. Without incremental auto-vacuum the file never shrinks
  // and the space saving is cosmetic — measured on the 47k-event sample, sealing
  // grew the file from 163 MB to 186 MB and only `VACUUM` brought it to 23 MB.
  //
  // Set after the schema transaction, not before it: `auto_vacuum` only takes
  // effect on a file with no tables yet, so the store is created, then rewritten
  // into an incremental one by a single `VACUUM` on an empty database (which is
  // instant at this size). Failure is not fatal — the store still works, it just
  // cannot give space back without a manual vacuum.
  try {
    db.exec('PRAGMA auto_vacuum = INCREMENTAL')
    db.exec('VACUUM')
  } catch {
    // An older SQLite without incremental auto-vacuum keeps the default layout.
  }
  return storeUuid
}

/**
 * Add whatever this build's schema has grown since the store was created.
 *
 * A layout version in `user_version` says how the *rows* are shaped; it does not
 * say which tables exist. The seal table and its index were added after the
 * first stores were written, and refusing those files (or rewriting the version
 * so they look newer than they are) would turn a pure optimisation into a
 * migration. Everything here is `IF NOT EXISTS` and additive: the rows keep their
 * meaning, and a store that never gets the table simply reads the old slow way.
 */
function ensureAuxiliaryTables(db: DatabaseSync): void {
  for (const statement of AUXILIARY_STATEMENTS) db.exec(statement)
}

/**
 * Move a readable store to this build's layout, once, and say so.
 *
 * `READABLE_VERSIONS` is what a reader accepts; a writer has to leave a store it
 * opened in the layout it writes. Both stamps move in one transaction, because a
 * store whose `user_version` says 2 while `storage_meta.schema_version` still
 * says 1 is a file that disagrees with itself — and the next build would have to
 * guess which one to believe. The rows are untouched: version 2 only *permits*
 * sealed chunks, and a store without them is still a valid version 2 store.
 *
 * Returns the layout version found on entry, or `undefined` when there was
 * nothing to move, so a caller can report the move.
 */
function upgradeLayout(db: DatabaseSync, path: string, found: number): number | undefined {
  if (found === SCHEMA_VERSION) return undefined
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.prepare('UPDATE storage_meta SET schema_version = ? WHERE singleton = 1').run(SCHEMA_VERSION)
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The original failure is what the caller has to see.
    }
    throw new SessionPersistenceCorruptionError(
      `"${path}" could not be moved from layout version ${found} to ${SCHEMA_VERSION}`,
      { cause: error },
    )
  }
  return found
}

/** The layout version this file declares, without creating or repairing it. */
export function layoutVersionOf(path: string): number | undefined {
  try {
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      return readPragma(db, 'user_version')
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}

/**
 * Refuse anything that is not this build's own store.
 *
 * Identity comes first: an unrelated SQLite file has no `storage_meta` table, so
 * asking about its schema before its `application_id` would report a missing
 * table instead of the real reason.
 */
function assertOwnStore(
  path: string,
  applicationId: number,
  userVersion: number,
  tables: number,
): void {
  if (applicationId !== APPLICATION_ID) {
    throw new SessionPersistenceCorruptionError(
      `"${path}" is not a dsh-session-optimizer store: application_id is ${applicationId}, expected ${APPLICATION_ID}`,
      {},
    )
  }
  if (!READABLE_VERSIONS.includes(userVersion)) {
    throw new SessionFormatUnsupportedError(
      `"${path}" uses store layout version ${userVersion}, but this build reads only ${READABLE_VERSIONS.join(', ')}`,
      { kind: 'sqlite', path },
    )
  }
  if (tables === 0) {
    throw new SessionPersistenceCorruptionError(
      `"${path}" is marked as a dsh-session-optimizer store but has no schema tables`,
      {},
    )
  }
}

/**
 * Everything `stat` and `list` need, in one statement.
 *
 * Both version stamps are read as `pragma_*` table-valued functions *inside* the
 * query, because `prepare()` is the expensive part of reading a header: on 200
 * stores a merged query costs 24.6ms while the same work split across a handful
 * of statements costs 79ms. Nothing here writes, creates a table or touches a
 * pragma that changes the file — listing must not mutate the stores it lists.
 *
 * The count is the last column: frames plus tail, so a listing reports what the
 * file holds rather than what the session row claims. It is part of the same
 * statement for the reason above — one prepare, not three.
 */
const HEADER_SNAPSHOT_SQL = `
  SELECT (SELECT application_id FROM pragma_application_id) AS application_id,
         (SELECT user_version FROM pragma_user_version) AS layout_version,
         m.store_uuid AS store_uuid,
         s.session_id AS session_id,
         s.header_json AS header_json,
         s.inherited_event_count AS inherited_event_count,
         s.event_count AS event_count,
         s.revision AS revision,
         s.state AS state,
         s.updated_at_ms AS updated_at_ms,
         (SELECT coalesce(sum(event_count), 0) FROM event_chunk)
           + (SELECT count(*) FROM session_event) AS held_event_count
    FROM storage_meta m
    LEFT JOIN session s ON s.singleton = m.singleton
   WHERE m.singleton = 1`

/**
 * The same query for a layout-1 store, which has no `event_chunk` table.
 *
 * Version 1 predates frames, so every event sits in the tail and the count is
 * just the tail. Referencing the missing table would fail at prepare time, and
 * that failure would surface as an unreadable conversation.
 */
const HEADER_SNAPSHOT_SQL_V1 = `
  SELECT (SELECT application_id FROM pragma_application_id) AS application_id,
         (SELECT user_version FROM pragma_user_version) AS layout_version,
         m.store_uuid AS store_uuid,
         s.session_id AS session_id,
         s.header_json AS header_json,
         s.inherited_event_count AS inherited_event_count,
         s.event_count AS event_count,
         s.revision AS revision,
         s.state AS state,
         s.updated_at_ms AS updated_at_ms,
         (SELECT count(*) FROM session_event) AS held_event_count
    FROM storage_meta m
    LEFT JOIN session s ON s.singleton = m.singleton
   WHERE m.singleton = 1`

interface HeaderSnapshotRow {
  readonly application_id: unknown
  readonly layout_version: unknown
  readonly store_uuid: unknown
  readonly session_id: unknown
  readonly header_json: unknown
  readonly inherited_event_count: unknown
  readonly event_count: unknown
  readonly revision: unknown
  readonly state: unknown
  readonly updated_at_ms: unknown
  readonly held_event_count: unknown
}

/** Decode and validate a stored header; the one place both readers agree. */
function decodeHeaderJson(headerJson: string, location: SessionLocation): SessionHeader {
  let parsed: unknown
  try {
    parsed = JSON.parse(headerJson)
  } catch (error) {
    throw new SessionPersistenceCorruptionError(
      `"${location.path}" stores an unreadable session header`,
      { cause: error },
    )
  }
  if (!isRecord(parsed) || typeof parsed.id !== 'string') {
    throw new SessionPersistenceCorruptionError(
      `"${location.path}" stores a session header that is not an object with an id`,
      {},
    )
  }
  const header = parsed as unknown as SessionHeader
  assertVersion(header, location)
  // Rows written before this build may omit `delegationDepth`; the JSONL
  // backend always reports it (its header line encoder defaults to 0), so
  // normalizing here keeps both backends' headers comparable.
  return { ...header, delegationDepth: header.delegationDepth ?? 0 }
}

/**
 * Read one store's header without opening it as a store.
 *
 * `stat` and `list` ask the same narrow question of every file in a root, and
 * `SessionDatabase.open` answers far more than that: pragma tuning, the schema
 * probe, the auxiliary-table repair and a `store_uuid` query. On 200 stores that
 * is 79ms against 24.6ms for one statement on a read-only connection — and the
 * cheap path also cannot write, which matters because a `list()` must never
 * change the files it reports.
 *
 * A file that is not this build's store is refused with the same error the full
 * open would raise, so callers cannot tell the two paths apart.
 */
export function readHeaderSnapshot(path: string): LoadedHeader | undefined {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    let row: HeaderSnapshotRow | undefined
    try {
      row = db.prepare(HEADER_SNAPSHOT_SQL).get() as HeaderSnapshotRow | undefined
    } catch (error) {
      // Three different files land here and they deserve different words: a blank
      // file is not a store at all, an unrelated SQLite file is foreign because of
      // its identity, and a layout-1 store simply has no frame table for the count
      // to read. Asking costs a few statements, and only on the path that has
      // already failed.
      const applicationId = readPragma(db, 'application_id')
      const layout = readPragma(db, 'user_version')
      const tables = countUserTables(db)
      if (tables === 0 && applicationId === 0) {
        throw new SessionPersistenceCorruptionError(`"${path}" holds no dsh-session-optimizer store`, {
          cause: error,
        })
      }
      assertOwnStore(path, applicationId, layout, tables)
      if (layout !== 1) throw error
      // Version 1 predates frames, so the frames term cannot be planned. The count
      // is the tail alone, and refusing the whole conversation over a missing
      // table would hide every session written by the previous layout.
      row = db.prepare(HEADER_SNAPSHOT_SQL_V1).get() as HeaderSnapshotRow | undefined
    }
    if (row === undefined) return undefined
    const applicationId = Number(row.application_id)
    const layout = Number(row.layout_version)
    if (applicationId !== APPLICATION_ID) {
      // Build the refusal the slow path would build: identity first, so an
      // unrelated SQLite file is reported as foreign rather than as broken.
      const tables = countUserTables(db)
      if (tables === 0 && applicationId === 0) {
        throw new SessionPersistenceCorruptionError(`"${path}" holds no dsh-session-optimizer store`, {})
      }
      assertOwnStore(path, applicationId, layout, tables)
    }
    if (!READABLE_VERSIONS.includes(layout)) {
      throw new SessionFormatUnsupportedError(
        `"${path}" uses store layout version ${layout}, but this build reads only ${READABLE_VERSIONS.join(', ')}`,
        { kind: 'sqlite', path },
      )
    }
    if (row.session_id === null || row.session_id === undefined) return undefined
    const eventCount = Number(row.event_count)
    return {
      header: decodeHeaderJson(String(row.header_json), { kind: 'sqlite', path }),
      inheritedEventCount: Number(row.inherited_event_count),
      revision: Number(row.revision),
      eventCount,
      // Counted, not claimed. The extra aggregate costs one index scan (~1.4ms on
      // 47k events) and happens once per file stamp — the listing's header cache
      // answer is reused until the store changes — while a listing that repeats
      // the row's claim promises events the file no longer holds.
      heldEventCount: Math.min(eventCount, Number(row.held_event_count)),
      storeUuid: String(row.store_uuid),
      state: row.state === 'importing' ? 'importing' : 'ready',
      updatedAtMs: Number(row.updated_at_ms),
    }
  } finally {
    db.close()
  }
}

/** One open database file. Not shared between threads. */
/** One full-text hit, with the text its snippet is cut from. */
export interface SearchHitRow {
  readonly seq: number
  readonly score: number
  readonly type: string
  readonly time: number
  readonly text: string
}

export class SessionDatabase {
  /**
   * Layout version this connection's open moved the file from, or `undefined`
   * when it was already current. Read by the upgrade CLI to report a sweep.
   */
  upgradedFrom: number | undefined

  /**
   * Statement handles are cached on the connection: `prepare()` parses and plans
   * the SQL every time, and the append path runs the same statements for every
   * batch. The cache dies with the database, so a statement can never outlive
   * the schema it was planned against.
   */
  private readonly statements = new Map<string, StatementSync>()

  /**
   * The last fold this instance computed, with the file stamp it was computed
   * against.
   *
   * A fold costs 2.5ms on 47k events, and paging through a conversation runs one
   * per page: ninety-five pages of history pay it ninety-five times while the
   * file underneath never changes. Remembering it is only sound with a proof
   * that the file did not change, and there is a cheap one — the size and mtime
   * of the database and its WAL, which move on every append and every
   * checkpoint. Two `stat` calls replace the fold, and a write from this very
   * process moves the stamp before the header it would describe can.
   */
  private proof: { readonly stamp: string; readonly marker: string; readonly checksum: string } | undefined

  /**
   * Decoded frames, least recently used first, keyed by `first_seq:event_count`.
   *
   * A history page usually starts in the middle of a frame, and the next page
   * upward starts in that same frame again — so the same decompression is paid
   * twice for every page boundary. Caching a handful of frames turns 445 frame
   * decodes into 269 on a 95-page walk (measured: 951ms → 637ms).
   *
   * The bound is bytes, not frames. Frames are cut to a byte budget, but the
   * budget is a *ceiling*: a frame that ends early is small, and one long
   * assistant message can fill it alone. Holding "eight frames" therefore means
   * anywhere from two to twenty megabytes depending on the conversation, which is
   * not a number to leave to chance in a process that also runs the model. The
   * charge is the frame's own uncompressed size, the same figure the seal folds.
   *
   * Eight megabytes is the working set of the page above and the page below the
   * viewport at the 500-event page the history reader asks for, and it is the
   * same figure the frame-count bound used to approximate.
   *
   * Any write clears it — a frame can be rewritten by `compact` or dissolved by
   * `truncateTail`, and a stale unpack would be served as if it were the log.
   *
   * What is held is the frame's JSON lines, not its parsed events. A history page
   * usually covers a fraction of a frame, so caching events would make every read
   * parse rows the caller never sees; slicing the cached text and parsing only the
   * window is what turns a 1.1ms frame parse into the 0.13ms a 50-event page owes.
   * Strings are immutable, so the same lines can be handed to several readers.
   *
   * The budget is per *process*, not per store: `StorageExecutor` hands every
   * connection the same cache. Five prepared sessions each holding eight megabytes
   * was forty megabytes of frames that never knew about each other, and a reader
   * switching between two conversations paid twice for the same file. Keys carry
   * the store identity, so one log's frames are addressed apart from another's and
   * a write only evicts its own.
   */
  private readonly frames: ByteLru<readonly string[]>

  /** Prefix every frame key of this store carries inside the shared cache. */
  private readonly framePrefix: string

  /**
   * Whether appends may seal their rows into frames.
   *
   * Mutable, and refreshed on every cache hit (see `retune`): the operator can
   * flip the switch in the settings view and the very next append honours it,
   * instead of waiting for the connection to be evicted.
   */
  private sealing = true

  /** Rows written since the last seal, while the row budget has not been met. */
  private rowsSinceSeal = 0

  /** Committed frame moves whose space reclamation still needs a retry. */
  private pendingReclaimBytes = 0

  private constructor(
    private readonly db: DatabaseSync,
    readonly path: string,
    readonly storeUuid: string,
    /**
     * Whether this file has the chunk table.
     *
     * A v1 store has none, and a pure reader (`readOnly` with `repair: false`,
     * which is what the search indexer and the inspector use) must not create it:
     * the table left by another build is not ours to touch. Queries that name it
     * are therefore skipped rather than attempted — for such a file the whole log
     * is the unsealed tail, which is exactly what v1 means.
     */
    private readonly chunks: boolean,
    frames: ByteLru<readonly string[]>,
    /**
     * Whether this connection may write.
     *
     * The full-text index is derived, so a read-only connection cannot build a
     * missing one: it answers "no index here" and the caller falls back to
     * scanning, instead of failing the search or writing through a connection
     * opened on someone else's file.
     */
    private readonly writable: boolean = false,
  ) {
    this.frames = frames
    // Each open owns a namespace: replacing a file can preserve both its path
    // and store UUID while changing every payload under the same frame keys.
    this.framePrefix = `${path}\u0000${randomUUID()}\u0000`
  }

  /**
   * Open (and on a fresh file, initialize) the store.
   *
   * Pragma tuning is applied before the schema-creating transaction so the very
   * first write already runs under the configured journal mode: creating the
   * tables on the rollback journal and only then switching to WAL would leave
   * the initial schema pages uncheckpointed.
   *
   * `frames` is the decode cache to share with other open stores; a call that
   * omits it gets a private one, which is what every direct caller (tests, the
   * migration and search paths) wants — they open one file, read it, close it.
   * The executor passes the same instance to every connection it opens, so the
   * budget is a process budget rather than five separate ones.
   */
  static open(
    path: string,
    settings: SqliteSettings,
    frames: ByteLru<readonly string[]> = new ByteLru<readonly string[]>(FRAME_CACHE_BYTES),
  ): SessionDatabase {
    const readOnly = settings.readOnly === true
    if (!readOnly) ensureSessionDirectory(dirname(path))
    const created = readOnly ? false : ensureDatabaseFile(path)
    // A read-only open that is allowed to repair needs a writable connection:
    // SQLite refuses DDL through `readOnly: true`, and the repair is exactly the
    // auxiliary table and index. It still creates nothing — the file has to
    // exist, and `ensureDatabaseFile`/`ensureSessionDirectory` are skipped.
    const repair = readOnly && settings.repair !== false
    const db = readOnly && !repair ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path)
    try {
      const applicationId = readPragma(db, 'application_id')
      const userVersion = readPragma(db, 'user_version')
      const tables = countUserTables(db)
      let storeUuid: string
      let chunks = true
      if (tables === 0 && applicationId === 0) {
        if (readOnly) {
          throw new SessionPersistenceCorruptionError(`"${path}" holds no dsh-session-optimizer store`, {})
        }
        applySettings(db, settings)
        storeUuid = initializeStore(db)
        // The additive tables are part of a store too: a fresh file must not be
        // missing the index its own writes maintain.
        ensureAuxiliaryTables(db)
      } else {
        assertOwnStore(path, applicationId, userVersion, tables)
        // A read-only caller must not move the journal mode of a file another
        // process may own, so it skips the pragma tuning as well.
        if (!readOnly) applySettings(db, settings)
        // Before the seal is ever consulted: a store written by an earlier build
        // has the rows but not the table that summarises them.
        if (!readOnly || repair) ensureAuxiliaryTables(db)
        chunks = hasTable(db, 'event_chunk')
        const row = db.prepare('SELECT store_uuid FROM storage_meta WHERE singleton = 1').get()
        if (row === undefined) {
          throw new SessionPersistenceCorruptionError(`"${path}" has no storage_meta row`, {})
        }
        storeUuid = String((row as { store_uuid: unknown }).store_uuid)
      }
      const store = new SessionDatabase(db, path, storeUuid, chunks, frames, !readOnly)
      // Honour the switch from the first append rather than the first cache hit.
      store.retune(settings)
      return store
    } catch (error) {
      db.close()
      if (created) {
        // A file this call created and failed to initialize is worthless — and,
        // left behind with an application id and no schema, it would look like a
        // foreign store on the next attempt. Remove it and any sidecar the
        // failed initialization managed to create; best-effort, so the original
        // failure is what surfaces.
        for (const suffix of ['', '-wal', '-shm', '-journal']) {
          try {
            unlinkSync(`${path}${suffix}`)
          } catch {
            // best-effort only
          }
        }
      }
      throw error
    }
  }

  close(): void {
    this.frames.deletePrefix(this.framePrefix)
    this.statements.clear()
    this.db.close()
  }

  /**
   * Move this store to the layout this build writes, deliberately.
   *
   * Opening does *not* do this. Version 2 only says sealed chunks are allowed, so
   * a store that never seals is a valid version 1 store, and restamping it on
   * every write open would take away the one thing the version buys the reader:
   * an older build can still open it. Sealing stamps the version on its own; this
   * method is for the operator who wants the store moved now (the `upgrade`
   * command), and it says which version it found.
   */
  upgradeLayout(): number | undefined {
    if (!this.writable) return undefined
    const moved = upgradeLayout(this.db, this.path, readPragma(this.db, 'user_version'))
    this.upgradedFrom = moved
    return moved
  }

  /**
   * What the log adds up to, or `undefined` when the store cannot say.
   *
   * The value folds the columns a reader trusts, computed by the engine over the
   * covering index `session_event_fold` — a key read, not a table scan, and no
   * row ever reaches V8. Measured on 47k events: 1.4ms here against 602ms for
   * decoding every row and 419ms for merely stepping the cursor.
   *
   * What makes it move when a row is rewritten in place is the byte total, which
   * costs a pass over the JSON text (63ms on 47k events). A reader must never pay
   * that: the writer records it in the seal when it commits, and a read compares
   * the recorded value against a stored total it can trust only if the fold
   * matches — so the fold is all a read recomputes (2.4ms).
   *
   * Every number is cast to text in SQL, because `sum(event_time_ms)` over 47k
   * stamps overflows int64 and arrives as a lossy float that `get()` refuses to
   * convert (ERR_OUT_OF_RANGE).
   */
  private logChecksum(): string | undefined {
    // The fold covers the *logical* log, which is a sealed prefix of chunks plus
    // an unsealed tail of rows. A chunk stores its own contribution to the two
    // sums (`types_bytes`, `times_total`), so folding 47k events that have been
    // sealed reads 100-odd small rows instead of 47k big ones — and the string
    // it produces is byte-identical to what the same log produced before it was
    // sealed, which is what lets an older seal keep matching.
    // A v1 store has no chunk table at all: the whole log is its unsealed tail,
    // which the second half of this query already folds correctly.
    const zero = '0'
    const chunks = this.chunks
    const rowExpr = chunks ? '(SELECT coalesce(sum(event_count), 0) FROM event_chunk)' : zero
    const typeExpr = chunks ? '(SELECT coalesce(sum(types_bytes), 0) FROM event_chunk)' : zero
    const timeExpr = chunks ? '(SELECT coalesce(sum(times_total), 0) FROM event_chunk)' : zero
    const endExpr = chunks ? '(SELECT coalesce(max(last_seq) + 1, 0) FROM event_chunk)' : zero
    const row = this.statement(
      `SELECT cast(${rowExpr} AS TEXT) AS sealed_rows,
              cast(${typeExpr} AS TEXT) AS sealed_types,
              cast(${timeExpr} AS TEXT) AS sealed_times,
              cast(${endExpr} AS TEXT) AS sealed_end,
              cast((SELECT count(*) FROM session_event) AS TEXT) AS tail_rows,
              cast((SELECT coalesce(sum(length(event_type)), 0) FROM session_event) AS TEXT) AS tail_types,
              cast((SELECT coalesce(sum(event_time_ms), 0) FROM session_event) AS TEXT) AS tail_times,
              cast((SELECT min(seq) FROM session_event) AS TEXT) AS tail_lo,
              cast((SELECT max(seq) FROM session_event) AS TEXT) AS tail_hi`,
    ).get() as
      | {
          sealed_rows: unknown
          sealed_types: unknown
          sealed_times: unknown
          sealed_end: unknown
          tail_rows: unknown
          tail_types: unknown
          tail_times: unknown
          tail_lo: unknown
          tail_hi: unknown
        }
      | undefined
    if (row === undefined) return undefined
    const sealedRows = Number(row.sealed_rows)
    const sealedEnd = Number(row.sealed_end)
    const tailRows = Number(row.tail_rows)
    const count = sealedRows + tailRows
    const types = BigInt(String(row.sealed_types)) + BigInt(String(row.tail_types))
    const times = BigInt(String(row.sealed_times)) + BigInt(String(row.tail_times))
    // The log always starts at zero — a chunk chain that did not would be a hole,
    // and the coverage check refuses it — so the low bound is zero whenever there
    // is a sealed prefix, and the tail's own minimum otherwise.
    const lo = sealedEnd > 0 ? '0' : row.tail_lo === null ? 'null' : String(row.tail_lo)
    const hi = tailRows > 0 ? String(row.tail_hi) : sealedEnd > 0 ? String(sealedEnd - 1) : 'null'
    return `${String(count)}:${String(types)}:${String(times)}:${lo}:${hi}`
  }

  /** What the store claims about a log without decoding any of it. */
  private marker(): string {
    const row = this.readSessionRow()
    if (row === undefined) return 'none'
    return `${row.event_count}@${row.revision}`
  }

  /**
   * Record the checksum of a log that is known to be good.
   *
   * Called by the writer after it commits — the writer has just written the rows,
   * so it is the one party that knows the content without a validating read. A
   * store that never gets a seal (written by another build, or only ever read)
   * simply keeps paying for the walk, which is the old behaviour.
   */
  reseal(): void {
    const checksum = this.logChecksum()
    if (checksum === undefined) return
    // The remembered proof describes the log before this commit; the stamp will
    // move as well, but forgetting it here keeps the two in step even if a later
    // write lands in the same millisecond and at the same size. The decoded
    // frames go with it: a frame key survives a rewrite, so a stale decode would
    // be served as if it were the log. Only this store's frames are dropped —
    // the cache is shared, and another conversation's pages are still valid.
    this.proof = undefined
    this.frames.deletePrefix(this.framePrefix)
    this.statement(
      `INSERT INTO session_seal (singleton, marker, checksum) VALUES (1, ?, ?)
       ON CONFLICT (singleton) DO UPDATE SET
         marker = excluded.marker,
         checksum = excluded.checksum`,
    ).run(this.marker(), checksum)
  }

  /**
   * Whether a window may skip the rows it is not returning.
   *
   * True only when a stored seal proves the log has not changed since the writer
   * that produced it committed: the marker (`event_count@revision`) still
   * describes the row, and the key fold still matches. Those two are the whole
   * read-side check, because they are all a reader can afford — the fold is a
   * 2.4ms key scan on 47k events, while a pass over the JSON text would cost
   * 63ms and put back the very scan the seal exists to avoid.
   *
   * What that leaves uncovered is a row rewritten in place whose JSON changed
   * without moving its type, time or count. `reseal` covers the writer's own
   * commits, and the full walk's per-row `JSON.parse` covers every store without
   * a usable seal (an older build, or one changed behind this process's back).
   *
   * The comparison runs inside a read transaction together with the caller's
   * window query, so a writer that commits between "prove" and "read" cannot make
   * the proof describe a log that is no longer there.
   *
   * It is also remembered per file stamp (see `proof`), which is what keeps the
   * ninety-fifth page of a conversation as cheap as the first: paging does not
   * change the file, so the fold is computed once and the following pages pay
   * two `stat` calls for it.
   */
  private sliceIsTrusted(): boolean {
    const stamp = fileStamp(this.path)
    const marker = this.marker()
    const remembered = this.proof
    // A fold this instance already computed for exactly these bytes. Paging a
    // long conversation asks this question once per page while the file sits
    // still, so the answer is remembered against the stamp: without it, 95 pages
    // of history pay 95 folds of 2.5ms each and nothing about them changed.
    //
    // Sound because the stamp moves on every write — an append grows the WAL, a
    // checkpoint moves both files — and because the marker (`count@revision`)
    // still has to match, which an append can never leave behind.
    if (remembered !== undefined && remembered.stamp === stamp && remembered.marker === marker) {
      return true
    }
    let sealed: { marker: unknown; checksum: unknown } | undefined
    try {
      sealed = this.statement(
        'SELECT marker, checksum FROM session_seal WHERE singleton = 1',
      ).get() as { marker: unknown; checksum: unknown } | undefined
    } catch {
      // No seal table: a store written by another build. Nothing to trust.
      return false
    }
    if (sealed === undefined) return false
    if (String(sealed.marker) !== marker) return false
    let checksum: string | undefined
    try {
      checksum = this.logChecksum()
    } catch {
      return false
    }
    if (checksum === undefined || checksum !== String(sealed.checksum)) {
      // A seal that no longer describes the log: forget any remembered proof.
      this.proof = undefined
      return false
    }
    this.proof = { stamp, marker, checksum }
    return true
  }

  /**
   * Decode a whole log the seal vouched for, paying only for the JSON.
   *
   * A validating walk fetches four columns per row and compares the three
   * redundant ones against the JSON it just parsed. Once the seal has proved the
   * columns (count, key bounds, type lengths, time total), that comparison can
   * only ever fail on a store edited behind the seal's back — which is the same
   * risk `sliceIsTrusted` already takes for windows — so it is skipped, and with
   * it the three extra columns. Measured on 47k events: 668ms → 443ms for the
   * decode, against 955ms for the same conversation through the JSONL provider.
   *
   * Sealed chunks come first and are decoded whole: they are the log, and a
   * frame that will not open is not a torn tail but a broken store, so it also
   * answers `undefined` here and lets the validating walk say so precisely.
   *
   * `undefined` means "the fast path could not be taken": a row that does not
   * continue the log, or JSON that will not parse. The caller then walks the log
   * exactly as before, which is also what produces the precise `tornTruncateTo`.
   */
  private decodeTrusted(total: number): SessionEvent[] | undefined {
    const decoded: SessionEvent[] = []
    if (this.chunks) {
      for (const chunk of this.statement(
        'SELECT first_seq, event_count, raw_bytes, payload FROM event_chunk ORDER BY first_seq',
      ).iterate() as Iterable<{
        first_seq: unknown
        event_count: unknown
        raw_bytes: unknown
        payload: unknown
      }>) {
        let events: SessionEvent[]
        try {
          const firstSeq = Number(chunk.first_seq)
          const eventCount = Number(chunk.event_count)
          const lines = this.frameLines(
            firstSeq,
            eventCount,
            Buffer.from(chunk.payload as Uint8Array),
            // A whole-log read visits every frame once; keeping them would evict
            // the frames the next page needs without ever being hit again.
            false,
          )
          events = decodeChunkRange(lines, { firstSeq }, firstSeq, firstSeq + eventCount)
        } catch {
          return undefined
        }
        if (events[0]?.seq !== decoded.length) return undefined
        for (const event of events) decoded.push(event)
      }
    }
    for (const row of this.statement(
      'SELECT seq, event_json FROM session_event ORDER BY seq',
    ).iterate() as Iterable<{ seq: unknown; event_json: unknown }>) {
      if (Number(row.seq) !== decoded.length) return undefined
      let parsed: unknown
      try {
        parsed = JSON.parse(String(row.event_json))
      } catch {
        return undefined
      }
      if (!isRecord(parsed)) return undefined
      decoded.push(parsed as unknown as SessionEvent)
    }
    return decoded.length === total ? decoded : undefined
  }

  /**
   * Decode the events in `[from, to)` without touching the rest of the log.
   *
   * Only a trusted seal may call this: it is what turns a history page into one
   * or two chunk decompressions plus a handful of tail rows, instead of a walk
   * over everything the conversation ever said. Chunks that straddle the edge of
   * the range are decoded whole and filtered, because a frame cannot be cut.
   */
  private sliceTrusted(from: number, to: number): SessionEvent[] {
    const events: SessionEvent[] = []
    if (from >= to) return events
    const sealedEnd = this.sealedRows().end
    if (from < sealedEnd) {
      // The window is anchored to a frame start, not searched from the beginning.
      // `first_seq < to` alone is a primary-key range that starts at seq 0, so
      // every page paid for the frames before it as well (measured 3.1ms of a
      // 3.7ms read on a 257-frame store); finding the frame that holds `from`
      // first turns that into a seek (0.6ms) and leaves the decompression as the
      // only real cost.
      const anchor = this.statement(
        'SELECT first_seq FROM event_chunk WHERE first_seq <= ? ORDER BY first_seq DESC LIMIT 1',
      ).get(from) as { first_seq: unknown } | undefined
      const lower = anchor === undefined ? from : Number(anchor.first_seq)
      for (const chunk of this.statement(
        `SELECT first_seq, event_count, raw_bytes, payload
           FROM event_chunk
          WHERE first_seq >= ? AND first_seq < ?
          ORDER BY first_seq`,
      ).all(lower, Math.min(to, sealedEnd)) as unknown as Array<{
        first_seq: unknown
        event_count: unknown
        raw_bytes: unknown
        payload: unknown
      }>) {
        const firstSeq = Number(chunk.first_seq)
        const eventCount = Number(chunk.event_count)
        const payload = Buffer.from(chunk.payload as Uint8Array)
        // Decompression has to run over the whole frame either way (a zstd frame
        // cannot be cut), but parsing is per row: only the part the page reads is
        // parsed. The unpack is shared with the next page through the cache, so a
        // page that ends mid-frame costs the next page nothing.
        const lines = this.frameLines(firstSeq, eventCount, payload)
        events.push(...decodeChunkRange(lines, { firstSeq }, from, Math.min(to, firstSeq + eventCount)))
      }
    }
    if (to > sealedEnd) {
      const lo = Math.max(from, sealedEnd)
      for (const row of this.statement(
        `SELECT seq, event_json FROM session_event WHERE seq >= ? AND seq < ? ORDER BY seq`,
      ).iterate(lo, to) as Iterable<{ seq: unknown; event_json: unknown }>) {
        events.push(JSON.parse(String(row.event_json)) as SessionEvent)
      }
    }
    return events
  }

  /**
   * Unpack one frame's JSON lines, reusing the unpack if it was just read.
   *
   * Page boundaries do not line up with frame boundaries, so a page that ends
   * inside a frame and the page above it unpack that frame twice; keeping the
   * text resident cuts roughly 40% of a full upward walk. The cache charges what
   * the strings actually occupy, not the frame's recorded `rawBytes`: those are
   * UTF-8 bytes, and V8 stores a string in one byte per character only while it
   * is Latin-1 — a conversation in CJK lives in UTF-16 and costs twice what the
   * writer measured, so charging `rawBytes` would let the budget hold twice its
   * size.
   *
   * What is cached is the lines, not the parsed events: a page usually covers a
   * fraction of a frame, and caching events would force parsing everything a page
   * will not show. Parsing a 50-event slice of a 500-event frame is 0.13ms.
   *
   * The stamp is deliberately not consulted: this is only reached after the seal
   * matched, and every write path clears the cache before it commits.
   *
   * `keep` is false for a whole-log read. That read touches every frame exactly
   * once, so caching can only churn the shared budget and evict the frames the
   * next page actually needs — measured on a 47k-event store, keeping them cost
   * an extra 8MiB of resident lines and bought zero hits.
   */
  private frameLines(
    firstSeq: number,
    eventCount: number,
    payload: Buffer,
    keep = true,
  ): readonly string[] {
    const key = `${this.framePrefix}${String(firstSeq)}:${String(eventCount)}`
    const cached = this.frames.get(key)
    if (cached !== undefined) return cached
    const lines = this.decodeFrameLines(payload, firstSeq, eventCount)
    if (keep) this.frames.set(key, lines, residentBytes(lines))
    return lines
  }

  /**
   * Unpack one frame, refusing as *corruption* rather than as a stray `Error`.
   *
   * `decodeChunkLines` speaks zstd's vocabulary ("Unknown frame descriptor"), and
   * a caller cannot tell that from a bug in this plugin. A frame that will not
   * decode is a damaged store, so it is reported with the path — the console
   * shows "damaged" instead of a generic failure, and a salvage run is the
   * obvious next step.
   */
  private decodeFrameLines(payload: Buffer, firstSeq: number, eventCount: number): string[] {
    try {
      return decodeChunkLines(payload, { firstSeq, eventCount })
    } catch (error) {
      throw new SessionPersistenceCorruptionError(
        `the event frame at seq ${String(firstSeq)} in "${this.path}" cannot be decoded: ${String(error)}`,
        { cause: error },
      )
    }
  }

  /**
   * How much of the log lives in sealed chunks.
   *
   * `end` is the first seq that is *not* sealed, which is also the only place a
   * tail row can start: the two halves have to meet, or the log has a hole and
   * the coverage check in `loadSession` refuses it.
   */
  private sealedRows(): { count: number; end: number } {
    if (!this.chunks) return { count: 0, end: 0 }
    const row = this.statement(
      `SELECT coalesce(sum(event_count), 0) AS n, coalesce(max(last_seq) + 1, 0) AS end
         FROM event_chunk`,
    ).get() as { n: unknown; end: unknown }
    return { count: Number(row.n), end: Number(row.end) }
  }

  private statement(sql: string): StatementSync {
    const cached = this.statements.get(sql)
    if (cached !== undefined) return cached
    const prepared = this.db.prepare(sql)
    this.statements.set(sql, prepared)
    return prepared
  }

  private transaction<T>(body: () => T): T {
    const rowsSinceSeal = this.rowsSinceSeal
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = body()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.rowsSinceSeal = rowsSinceSeal
      this.proof = undefined
      this.frames.deletePrefix(this.framePrefix)
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // keep the original failure
      }
      throw error
    }
  }

  hasSessionRow(): boolean {
    return this.statement('SELECT 1 AS present FROM session WHERE singleton = 1').get() !== undefined
  }

  /** Events the full-text index covers, or `undefined` when it was never built. */
  private indexedRows(): number | undefined {
    // A store written before the index existed has no `event_fts_state` at all,
    // and that is not an error: it is the reason the index has to be built.
    if (!hasTable(this.db, 'event_fts_state')) return undefined
    const row = this.statement('SELECT built_rows FROM event_fts_state WHERE singleton = 1').get() as
      | { built_rows: unknown }
      | undefined
    return row === undefined ? undefined : Number(row.built_rows)
  }

  private setIndexedRows(rows: number): void {
    this.statement(
      `INSERT INTO event_fts_state (singleton, built_rows) VALUES (1, ?)
       ON CONFLICT(singleton) DO UPDATE SET built_rows = excluded.built_rows`,
    ).run(rows)
  }

  /**
   * Index one committed batch, inside the transaction that wrote it.
   *
   * The covered count only advances while the index is contiguous with the rows
   * before it: a hole means the next search rebuilds from the log rather than
   * answering out of a partial index and quietly missing matches.
   */
  private indexEvents(events: readonly SessionEvent[], base: number): void {
    const built = this.indexedRows()
    const insert = this.statement('INSERT INTO event_fts (rowid, text) VALUES (?, ?)')
    for (const event of events) {
      const text = semanticTextOf(event)
      // Structural events carry no words; indexing their envelope would make
      // every id and timestamp searchable.
      if (text === '') continue
      insert.run(event.seq + 1, searchableText(text))
    }
    if (built === base) this.setIndexedRows(base + events.length)
  }

  /** Every stored event, sealed frames first, in seq order. */
  private *storedEventLines(): Generator<string> {
    if (this.chunks) {
      const frames = this.statement(
        'SELECT first_seq, event_count, payload FROM event_chunk ORDER BY first_seq',
      ).all() as unknown as Array<{ first_seq: unknown; event_count: unknown; payload: Uint8Array }>
      for (const frame of frames) {
        for (const line of this.decodeFrameLines(
          frame.payload as Buffer,
          Number(frame.first_seq),
          Number(frame.event_count),
        )) {
          yield line
        }
      }
    }
    const rows = this.statement('SELECT event_json FROM session_event ORDER BY seq').iterate() as Iterable<{
      event_json: unknown
    }>
    for (const row of rows) yield String(row.event_json)
  }

  /**
   * Build the index from the log. Returns false when this connection may not
   * write, which is the honest answer for a reader opened on someone else's file.
   */
  private rebuildSearchIndex(total: number): boolean {
    if (!this.writable) return false
    this.transaction(() => {
      // `DELETE FROM event_fts` is not allowed on a contentless table without a
      // rowid, so the table's own command does the clearing.
      this.statement("INSERT INTO event_fts (event_fts) VALUES ('delete-all')").run()
      const insert = this.statement('INSERT INTO event_fts (rowid, text) VALUES (?, ?)')
      for (const line of this.storedEventLines()) {
        const event = JSON.parse(line) as SessionEvent
        const text = semanticTextOf(event)
        if (text === '') continue
        insert.run(event.seq + 1, searchableText(text))
      }
      this.setIndexedRows(total)
    })
    return true
  }

  /**
   * Builds the index for a store written before the index existed.
   *
   * A file from an older build has rows but no `event_fts`, so its first search
   * would find nothing and the honest-looking answer would be "that word is not
   * in your conversation". Building needs a writable handle, which is why the
   * caller may open one just for this; returns false when it cannot.
   */
  ensureSearchIndex(): boolean {
    if (!this.writable) return false
    const total = this.countEvents()
    if (this.indexedRows() === total) return true
    return this.rebuildSearchIndex(total)
  }

  /** One stored event by seq, sealed frame or tail row. */
  readEventAt(seq: number): SessionEvent | undefined {
    if (this.chunks) {
      const frame = this.statement(
        `SELECT first_seq, event_count, payload FROM event_chunk
          WHERE first_seq <= ? AND last_seq >= ? ORDER BY first_seq DESC LIMIT 1`,
      ).get(seq, seq) as unknown as
        | { first_seq: unknown; event_count: unknown; payload: Uint8Array }
        | undefined
      if (frame !== undefined) {
        const lines = this.decodeFrameLines(
          frame.payload as Buffer,
          Number(frame.first_seq),
          Number(frame.event_count),
        )
        const line = lines[seq - Number(frame.first_seq)]
        return line === undefined ? undefined : (JSON.parse(line) as SessionEvent)
      }
    }
    const row = this.statement('SELECT event_json FROM session_event WHERE seq = ?').get(seq) as
      | { event_json: unknown }
      | undefined
    return row === undefined ? undefined : (JSON.parse(String(row.event_json)) as SessionEvent)
  }

  /**
   * Matching events with the text a snippet can be cut from.
   *
   * The index stores no copy of the text, so each hit is read back from its own
   * event: the caller asked for a page of results, not for the log.
   */
  searchHits(match: string, limit: number): SearchHitRow[] | undefined {
    const sequences = this.searchSequences(match, limit)
    if (sequences === undefined) return undefined
    const hits: SearchHitRow[] = []
    for (const hit of sequences) {
      const event = this.readEventAt(hit.seq)
      if (event === undefined) continue
      hits.push({
        seq: hit.seq,
        score: hit.score,
        type: event.type,
        time: event.time,
        text: semanticTextOf(event),
      })
    }
    return hits
  }

  /**
   * Sequences matching one FTS5 expression, best first.
   *
   * `undefined` means "this store has no index and this connection cannot build
   * one": the caller is expected to fall back to scanning the log, not to report
   * an empty result that looks like "no matches".
   */
  searchSequences(match: string, limit: number): Array<{ seq: number; score: number }> | undefined {
    const total = this.countEvents()
    if (!hasTable(this.db, 'event_fts')) return undefined
    if (this.indexedRows() !== total && !this.rebuildSearchIndex(total)) return undefined
    const rows = this.statement(
      'SELECT rowid - 1 AS seq, bm25(event_fts) AS score FROM event_fts WHERE event_fts MATCH ? ORDER BY rank LIMIT ?',
    ).all(match, limit) as unknown as Array<{ seq: unknown; score: unknown }>
    return rows.map((row) => ({ seq: Number(row.seq), score: Number(row.score) }))
  }

  private insertSessionRow(header: SessionHeader, inheritedEventCount: number): void {
    const now = Date.now()
    this.statement(
      `INSERT INTO session
         (singleton, session_id, header_json, inherited_event_count, event_count, revision, state, created_at_ms, updated_at_ms)
       VALUES (1, ?, ?, ?, 0, 0, 'ready', ?, ?)`,
    ).run(header.id, JSON.stringify(header), inheritedEventCount, now, now)
  }

  /**
   * Write a whole imported log in one transaction, marked `importing`.
   *
   * The row and its events commit together, so a crash mid-import leaves either
   * nothing or a log the migration CLI can recognise as unfinished
   * (`state = 'importing'`) and replace. `markReady` promotes it afterwards.
   */
  appendImported(
    header: SessionHeader,
    events: readonly SessionEvent[],
    inheritedEventCount: number,
  ): void {
    this.transaction(() => {
      const now = Date.now()
      this.statement(
        `INSERT INTO session
           (singleton, session_id, header_json, inherited_event_count, event_count, revision, state, created_at_ms, updated_at_ms)
         VALUES (1, ?, ?, ?, 0, 0, 'importing', ?, ?)`,
      ).run(header.id, JSON.stringify(header), inheritedEventCount, now, now)
      const insert = this.statement(
        'INSERT INTO session_event (seq, event_type, event_time_ms, event_json) VALUES (?, ?, ?, ?)',
      )
      for (const event of events) {
        insert.run(event.seq, event.type, event.time, JSON.stringify(event))
      }
      this.indexEvents(events, 0)
      this.statement(
        `UPDATE session
            SET event_count = ?, revision = revision + 1, updated_at_ms = ?
          WHERE singleton = 1`,
      ).run(events.length, now)
      this.resealAfterWrite(events.length)
    })
    // An import that never gets compacted leaves the whole log uncompressed
    // until the next append, and a conversation imported once may never be
    // appended to again.
    this.sealIfAllowed()
  }

  /** Promote a fully written import to `ready`; readers rely on this state. */
  markReady(): void {
    this.transaction(() => {
      this.statement(
        `UPDATE session SET state = 'ready', revision = revision + 1, updated_at_ms = ? WHERE singleton = 1`,
      ).run(Date.now())
      this.reseal()
    })
  }

  /** Current stored lifecycle state, without decoding the log. */
  storedState(): 'importing' | 'ready' | undefined {
    const row = this.readSessionRow()
    return row === undefined ? undefined : this.decodeState(row.state)
  }

  /** Materialize a session row without events: a flushed empty session. */
  materializeHeader(header: SessionHeader, inheritedEventCount: number): void {
    this.transaction(() => {
      if (this.hasSessionRow()) return
      this.insertSessionRow(header, inheritedEventCount)
      this.resealAfterWrite()
    })
  }

  /**
   * Append one contiguous batch. `isMaterialized` says whether the session row
   * already exists here; row and first events land in one transaction so a
   * crash cannot leave events without their header.
   */
  appendBatch(
    header: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
    inheritedEventCount: number,
  ): void {
    if (events.length === 0) return
    this.transaction(() => {
      if (!isMaterialized && !this.hasSessionRow()) this.insertSessionRow(header, inheritedEventCount)
      // `event_count` is what the log claims to hold, and every reader trusts it
      // to mean "seq 0 .. event_count-1 are here". Adding the row count instead
      // of the reachable prefix would let a batch with a gap leave a count that
      // no query can satisfy: the store would look longer than it is and every
      // read would have to fall back to a full scan to find out.
      const current = this.statement('SELECT event_count FROM session WHERE singleton = 1').get() as
        | { event_count: number }
        | undefined
      const base = current === undefined ? 0 : Number(current.event_count)
      const first = events[0] as SessionEvent
      const lastSeq = events.reduce((high, event) => Math.max(high, event.seq), -1)
      if (first.seq > base) {
        throw new SessionPersistenceCorruptionError(
          `session "${String(header.id)}" appends seq ${String(first.seq)} but its log ends at ${String(base - 1)}`,
          {},
        )
      }
      // Starting before the end would `INSERT OR REPLACE` over events that are
      // already committed — the log would silently change its own history, and
      // the frames sealing that prefix would still describe the old events.
      // Callers rewrite a prefix by truncating first, which moves `base` back.
      if (first.seq < base) {
        throw new SessionPersistenceCorruptionError(
          `session "${String(header.id)}" appends seq ${String(first.seq)} but its log already holds ${String(base)} events`,
          {},
        )
      }
      let cursor: number = first.seq
      for (const event of events) {
        if (event.seq !== cursor) {
          throw new SessionPersistenceCorruptionError(
            `session "${String(header.id)}" appends seq ${String(event.seq)} after ${String(cursor - 1)}`,
            {},
          )
        }
        cursor += 1
      }
      const insert = this.statement(
        'INSERT OR REPLACE INTO session_event (seq, event_type, event_time_ms, event_json) VALUES (?, ?, ?, ?)',
      )
      for (const event of events) {
        insert.run(event.seq, event.type, event.time, JSON.stringify(event))
      }
      this.indexEvents(events, base)
      const grown = Math.max(base, lastSeq + 1)
      this.statement(
        `UPDATE session
            SET event_count = ?,
                revision = revision + 1,
                updated_at_ms = ?
          WHERE singleton = 1`,
      ).run(grown, Date.now())
      // The contiguous events and their proof either commit together or roll
      // back together; a rejected append must leave the cursor unchanged.
      this.resealAfterWrite(events.length)
    })
    this.sealIfAllowed()
  }

  /** Drop every row at or after `truncateTo`, keeping the stored header. */
  truncateTail(truncateTo: number): void {
    // A cut past the end would rewrite `event_count` to a length the log does
    // not have: the store would claim rows that were never written, every read
    // would refuse it as short, and nothing would ever put it back. The only
    // caller passes the length it just measured, so a value beyond that is a
    // programming error and must not reach the UPDATE below.
    const claimed = this.loadHeader()
    if (claimed === undefined) {
      throw new SessionPersistenceCorruptionError(
        `"${this.path}" has no session row, so there is no log to truncate`,
        {},
      )
    }
    if (!Number.isSafeInteger(truncateTo) || truncateTo < 0 || truncateTo > claimed.eventCount) {
      throw new SessionPersistenceCorruptionError(
        `cannot truncate session "${String(claimed.header.id)}" to seq ${String(truncateTo)}; its log holds ${String(claimed.eventCount)} events`,
        {},
      )
    }
    this.transaction(() => {
      // Rows live in two places, and a cut can land inside a compressed frame.
      // Whole frames past the cut go; a frame that straddles it is unpacked and
      // its survivors move back among the rows, because a frame cannot be cut and
      // the rows after it must stay contiguous with the ones before.
      if (this.chunks) {
        this.statement('DELETE FROM event_chunk WHERE first_seq >= ?').run(truncateTo)
        for (const chunk of this.statement(
          `SELECT first_seq, event_count, payload FROM event_chunk
            WHERE last_seq >= ? ORDER BY first_seq`,
        ).all(truncateTo) as unknown as Array<{
          first_seq: unknown
          event_count: unknown
          payload: unknown
        }>) {
          const events = decodeChunk(Buffer.from(chunk.payload as Uint8Array), {
            firstSeq: Number(chunk.first_seq),
            eventCount: Number(chunk.event_count),
          })
          const insert = this.statement(
            'INSERT OR REPLACE INTO session_event (seq, event_type, event_time_ms, event_json) VALUES (?, ?, ?, ?)',
          )
          for (const event of events) {
            if (event.seq >= truncateTo) continue
            insert.run(event.seq, event.type, event.time, JSON.stringify(event))
          }
          this.statement('DELETE FROM event_chunk WHERE first_seq = ?').run(Number(chunk.first_seq))
        }
      }
      this.statement('DELETE FROM session_event WHERE seq >= ?').run(truncateTo)
      // The index describes events that no longer exist. Its rows are keyed by
      // `seq + 1`, so the cut is one range delete; the covered count has to come
      // back with it or a later search would trust rows it describes and no
      // longer has.
      this.statement('DELETE FROM event_fts WHERE rowid >= ?').run(truncateTo + 1)
      this.statement(
        'UPDATE event_fts_state SET built_rows = ? WHERE singleton = 1 AND built_rows > ?',
      ).run(truncateTo, truncateTo)
      // `seq` is the primary key and the log runs from zero, so the surviving
      // length is the cut itself — no count over either half is needed.
      this.statement(
        `UPDATE session
            SET event_count = ?,
                revision = revision + 1,
                updated_at_ms = ?
          WHERE singleton = 1`,
      ).run(truncateTo, Date.now())
      this.reseal()
    })
  }

  /**
   * Adopt the settings of the call that is about to use this connection.
   *
   * The connection cache is keyed by file, not by the settings that opened it, so
   * a switch flipped in the settings view has to reach a connection that is
   * already open — otherwise "stability fixes: off" would mean "off after this
   * conversation is evicted", which an operator would read as a broken switch.
   * Only the knobs that a live connection can honour are read here: the pragmas
   * are fixed at open (a `journal_mode` change mid-connection would need a
   * checkpoint) and `readOnly` cannot be undone, so both stay a reopen-only
   * decision. Sealing is the one that matters for stability, and it costs nothing
   * to apply per call.
   */
  retune(settings: SqliteSettings): void {
    this.sealing = settings.seal !== false
  }

  /**
   * Seal the tail, unless the operator turned the fixes off.
   *
   * `compact()` itself stays unconditional: `dsq compact <id>` is an explicit
   * instruction about one file and must do what it says even on a store whose
   * automatic sealing is off.
   */
  private sealIfAllowed(): void {
    if (!this.sealing) return
    try {
      this.compact()
    } catch (error) {
      // The append already committed. Leave its success visible to the handle;
      // the next append retries compaction, and explicit compact still throws.
      console.warn(`SQLite automatic compaction failed for "${this.path}"; will retry:`, error)
    }
  }

  /**
   * Record a checksum for the batch just committed, at a cost that stays bounded.
   *
   * With sealing on, the unsealed tail is a fraction of a chunk — compaction
   * keeps it under `CHUNK_BYTES` — so folding it after every batch is cheap and
   * the next reader gets a proof it can use.
   *
   * With sealing off, nothing is ever folded, so the tail *is* the whole log and
   * an aggregate over it is O(N): doing that per batch would make writing one
   * long conversation quadratic. A seal is only a read-side shortcut — a stale
   * one makes the reader walk the log, which is what a store that never had a
   * seal pays anyway — so a batch that skips it loses speed but no correctness.
   * The deferred seal fires per `RESEAL_ROWS` written rows rather than per
   * batch: a batch is whatever the caller happened to hand over, and counting
   * batches measures nothing. Rows keep the tail inside the window where
   * `trustedLength()` can still answer from the fold (see `RESEAL_ROWS`).
   */
  private resealAfterWrite(rows = 0): void {
    if (this.sealing) {
      this.rowsSinceSeal = 0
      this.reseal()
      return
    }
    this.rowsSinceSeal += rows
    if (this.rowsSinceSeal < RESEAL_ROWS) return
    this.rowsSinceSeal = 0
    this.reseal()
  }

  /**
   * Seal the front of the tail into compressed chunks.
   *
   * Runs after a committed append, so the seal already describes the log this
   * call is about to move — and keeping the checksum identical across the move
   * (`logChecksum` sums chunks and rows into the same number) is what makes that
   * ordering safe. Compaction therefore never reseals, and never invalidates a
   * seal a reader is holding.
   *
   * A frame is sealed only once it holds at least half a budget of JSON: a run of
   * small appends would otherwise leave one tiny frame behind each batch, and a
   * frame's own header is a fixed cost that small frames cannot amortise. The
   * lower bound is half rather than a full budget because the row that would
   * overrun the budget can never be moved into the current frame — waiting for a
   * full megabyte in front of such a row would leave the front unsealed forever.
   *
   * Public so a store written before frames existed can be compressed on demand
   * instead of waiting for its next prompt: `dsq compact <id>`. Safe to call on
   * a sealed log — it seals only what is still rows.
   */
  compact(): void {
    if (this.pendingReclaimBytes > 0) {
      this.reclaim(this.pendingReclaimBytes)
      this.pendingReclaimBytes = 0
    }
    // A pure reader never gets here, but a store without the table must not be
    // handed a write it cannot place.
    if (!this.chunks) return
    // A cheap question first: an append usually leaves the tail far below a
    // frame, and reading a megabyte of JSON to discover that would put the
    // compression's cost on every single prompt.
    const weight = this.statement(
      'SELECT coalesce(sum(length(event_json)), 0) AS bytes FROM session_event',
    ).get() as { bytes: unknown }
    if (Number(weight.bytes) < CHUNK_BYTES >> 1) return

    // One pass, because the alternative — re-reading the tail once per frame —
    // is quadratic on the very case this exists for: importing a hundred
    // megabytes in a single append. Only one frame's events are held parsed at a
    // time; the frames themselves are held compressed, so the pass costs about a
    // sixth of the tail in the heap rather than all of it. The writes are held
    // until the read cursor is closed on purpose: this connection cannot be told
    // to delete rows underneath a cursor that is still walking them.
    const frames: EncodedChunk[] = []
    let picked: SessionEvent[] = []
    let bytes = 0
    const iterator = this.statement(
      'SELECT event_json FROM session_event ORDER BY seq',
    ).iterate() as IterableIterator<{ event_json: unknown }>
    try {
      for (const row of iterator) {
        const json = String(row.event_json)
        const size = Buffer.byteLength(json, 'utf8') + 1
        if (picked.length > 0 && bytes + size > CHUNK_BYTES) {
          const frame = encodeChunk(picked)
          if (frame !== undefined) frames.push(frame)
          picked = []
          bytes = 0
        }
        picked.push(JSON.parse(json) as SessionEvent)
        bytes += size
      }
    } finally {
      // Leaving the loop early must release the cursor: the write below runs on
      // the same connection and would otherwise find its own read still open.
      iterator.return?.(undefined)
    }
    // Whatever is left stays in the tail: a frame smaller than half a budget
    // carries its own header for too little text, and keeping it as rows also
    // keeps the next append from having to reopen a frame to extend it.
    if (bytes >= CHUNK_BYTES >> 1) {
      const frame = encodeChunk(picked)
      if (frame !== undefined) frames.push(frame)
    }
    if (frames.length === 0) return

    let sealedTo = 0
    let movedBytes = 0
    this.transaction(() => {
      const insert = this.statement(
        `INSERT OR REPLACE INTO event_chunk
           (first_seq, last_seq, event_count, raw_bytes, compressed_bytes, codec,
            types_bytes, times_total, types_json, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const frame of frames) {
        insert.run(
          frame.firstSeq,
          frame.lastSeq,
          frame.eventCount,
          frame.rawBytes,
          frame.payload.byteLength,
          CHUNK_CODEC,
          frame.typesBytes,
          frame.timesTotal,
          JSON.stringify(frame.types),
          frame.payload,
        )
        sealedTo = frame.firstSeq + frame.eventCount
        movedBytes += frame.rawBytes
      }
      this.statement('DELETE FROM session_event WHERE seq < ?').run(sealedTo)
      // The rows that just moved are described by a chunk now, which is layout
      // version 2. A store that only ever held a tail stays at its old version,
      // so reading it needs nothing from this build that it did not already have.
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    })
    // Invalidate as soon as the layout commits, even if reclaiming space fails.
    this.frames.deletePrefix(this.framePrefix)
    this.proof = undefined
    this.pendingReclaimBytes += movedBytes
    // Outside the transaction: `incremental_vacuum` cannot run inside one.
    this.reclaim(this.pendingReclaimBytes)
    this.pendingReclaimBytes = 0
  }

  /**
   * Give back the pages a seal just freed.
   *
   * Bounded rather than a full vacuum because this runs on the write path: the
   * pages of one frame are a few hundred, which costs a couple of milliseconds,
   * while the whole of a freshly migrated 150 MB store is half a second and
   * belongs to a migration, not to a prompt.
   *
   * A store created before incremental auto-vacuum existed cannot give anything
   * back — deleting 40k rows leaves 39k free pages and the file grows. Once such
   * a store has accumulated a real amount of freed space (a compaction pass, not
   * an append), it is converted with one `VACUUM`, and never again.
   */
  private reclaim(freedBytes: number): void {
    const free = readPragma(this.db, 'freelist_count')
    if (free <= 0) return
    if (readPragma(this.db, 'auto_vacuum') === 0) {
      // Free pages are the real question, not what this call freed: an old store
      // seals a frame at a time and would otherwise never reach the threshold.
      if (free * 4096 < LEGACY_VACUUM_BYTES) return
      try {
        this.db.exec('PRAGMA auto_vacuum = INCREMENTAL')
        this.db.exec('VACUUM')
      } catch {
        // Keep the pages rather than fail a write over housekeeping.
      }
      return
    }
    const wanted = Math.ceil(freedBytes / 4096)
    try {
      this.db.exec(`PRAGMA incremental_vacuum(${String(Math.max(1, Math.min(free, wanted)))})`)
    } catch {
      // A store without incremental auto-vacuum needs `VACUUM`; that is the
      // operator's call, not something to spend a write on.
    }
  }

  private readSessionRow(): SessionRow | undefined {
    const row = this.statement(
      `SELECT session_id, header_json, inherited_event_count, event_count, revision, state, updated_at_ms
         FROM session WHERE singleton = 1`,
    ).get() as SessionRow | undefined
    if (row === undefined) return undefined
    return {
      session_id: String(row.session_id),
      header_json: String(row.header_json),
      inherited_event_count: Number(row.inherited_event_count),
      event_count: Number(row.event_count),
      revision: Number(row.revision),
      state: String(row.state),
      updated_at_ms: Number(row.updated_at_ms),
    }
  }

  /** Normalise the CHECKed `state` column for callers. */
  private decodeState(state: string): 'importing' | 'ready' {
    return state === 'importing' ? 'importing' : 'ready'
  }

  private decodeHeader(headerJson: string, location: SessionLocation): SessionHeader {
    let parsed: unknown
    try {
      parsed = JSON.parse(headerJson)
    } catch (error) {
      throw new SessionPersistenceCorruptionError(
        `"${location.path}" stores an unreadable session header`,
        { cause: error },
      )
    }
    if (!isRecord(parsed) || typeof parsed.id !== 'string') {
      throw new SessionPersistenceCorruptionError(
        `"${location.path}" stores a session header that is not an object with an id`,
        {},
      )
    }
    const header = parsed as unknown as SessionHeader
    assertVersion(header, location)
    // Rows written before this build may omit `delegationDepth`; the JSONL
    // backend always reports it (its header line encoder defaults to 0), so
    // normalizing here keeps both backends' headers comparable.
    return { ...header, delegationDepth: header.delegationDepth ?? 0 }
  }

  /**
   * Read the header only; `stat` and `list` never interpret events.
   *
   * `undefined` means the store holds no session row yet — a session that was
   * created and never flushed, or one whose header materialized but whose events
   * did not. Callers must not assume a database file implies a header.
   */
  loadHeader(): LoadedHeader | undefined {
    const row = this.readSessionRow()
    if (row === undefined) return undefined
    const location: SessionLocation = { kind: 'sqlite', path: this.path }
    const header = this.decodeHeader(row.header_json, location)
    return {
      header,
      inheritedEventCount: row.inherited_event_count,
      revision: row.revision,
      eventCount: row.event_count,
      storeUuid: this.storeUuid,
      state: this.decodeState(row.state),
      updatedAtMs: row.updated_at_ms,
    }
  }

  /**
   * Advisory loading preview only. Never used by SessionPersistence or recovery.
   * Declines without a seal instead of running the whole-log fallback. The
   * metadata budget is checked before any BLOB reaches JavaScript, and the
   * decompressor enforces its own output limit even if raw_bytes is dishonest.
   */
  loadPreviewWindow(): LoadedSession | undefined {
    // Advisory text need not fill 768 events. Retry only preflight budget declines,
    // never corruption or a missing proof; each attempt owns a fresh read snapshot.
    for (const maxEvents of [768, 384, 192, 96, 48]) {
      const result = this.tryPreviewWindow(maxEvents)
      if (result !== 'budget') return result
    }
    return undefined
  }

  /** Recheck advisory-preview identity without reparsing header JSON. */
  previewStillCurrent(loaded: LoadedSession): boolean {
    const row = this.statement(`SELECT revision = ? AND state = 'ready' AND
      (SELECT store_uuid FROM storage_meta WHERE singleton = 1) = ? AS same
      FROM session WHERE singleton = 1`).get(loaded.revision, loaded.storeUuid) as { same: unknown } | undefined
    return row?.same === 1
  }

  private tryPreviewWindow(maxEvents: number): LoadedSession | 'budget' | undefined {
    const maxBytes = 2 * 1024 * 1024
    this.db.exec('BEGIN')
    try {
      const headerSize = this.statement('SELECT length(CAST(header_json AS BLOB)) AS n FROM session WHERE singleton = 1').get() as { n: unknown } | undefined
      if (headerSize === undefined || !Number.isSafeInteger(headerSize.n) || Number(headerSize.n) > 256 * 1024) return undefined
      const sealSize = this.statement('SELECT length(CAST(marker AS BLOB)) + length(CAST(checksum AS BLOB)) AS n FROM session_seal WHERE singleton = 1').get() as { n: unknown } | undefined
      if (sealSize === undefined || !Number.isSafeInteger(sealSize.n) || Number(sealSize.n) > 4096) return undefined
      const identitySize = this.statement('SELECT length(CAST(store_uuid AS BLOB)) AS n FROM storage_meta WHERE singleton = 1').get() as { n: unknown } | undefined
      if (identitySize === undefined || !Number.isSafeInteger(identitySize.n) || Number(identitySize.n) > 256) return undefined
      const loaded = this.loadHeader()
      // A materialized snapshot can retain seed/parent provenance without an
      // external inherited prefix. The seal and contiguous local seqs still have
      // to prove the stored log; no parent lookup or recovery runs on this path.
      if (loaded === undefined || loaded.state !== 'ready' || loaded.inheritedEventCount !== 0 ||
        (loaded.header.parentSession !== undefined && !loaded.header.isSeeded) ||
        (loaded.header.delegationDepth ?? 0) !== 0) return undefined
      const tailCount = Number((this.statement('SELECT count(*) AS n FROM session_event').get() as { n: unknown }).n)
      const chunkCount = this.chunks
        ? Number((this.statement('SELECT count(*) AS n FROM event_chunk').get() as { n: unknown }).n) : 0
      // Only indexed seal/vocabulary metadata may cover this bounded tail;
      // event JSON and decompression remain under the 2 MiB window budget.
      if (tailCount > 100000 || chunkCount > 4096) return undefined
      if (this.chunks) {
        const vocabularySize = Number((this.statement('SELECT coalesce(sum(length(CAST(types_json AS BLOB))), 0) AS n FROM event_chunk').get() as { n: unknown }).n)
        if (!Number.isSafeInteger(vocabularySize) || vocabularySize > 512 * 1024) return undefined
      }
      const total = this.trustedLength()
      if (total === undefined || total === 0) return undefined
      const from = Math.max(0, total - maxEvents)
      const sealedEnd = this.sealedRows().end
      const frames: Array<{ first_seq: number; last_seq: number; event_count: number; raw_bytes: number; compressed_bytes: number; actual_bytes: number; codec: string }> = []
      if (this.chunks && from < sealedEnd) {
        const anchor = this.statement('SELECT first_seq FROM event_chunk WHERE first_seq <= ? ORDER BY first_seq DESC LIMIT 1').get(from) as { first_seq: number } | undefined
        if (anchor === undefined) return undefined
        frames.push(...this.statement(`SELECT first_seq, last_seq, event_count, raw_bytes, compressed_bytes,
          length(payload) AS actual_bytes, codec FROM event_chunk
          WHERE first_seq >= ? AND first_seq < ? ORDER BY first_seq LIMIT 9`).all(anchor.first_seq, total) as typeof frames)
      }
      if (frames.length > 8) return 'budget'
      let rawBytes = 0
      let compressedBytes = 0
      for (const frame of frames) {
        if (![frame.first_seq, frame.last_seq, frame.event_count, frame.raw_bytes, frame.compressed_bytes, frame.actual_bytes].every(Number.isSafeInteger) ||
          frame.first_seq < 0 || frame.event_count < 1 || frame.last_seq !== frame.first_seq + frame.event_count - 1 ||
          frame.raw_bytes < 1 || frame.compressed_bytes < 1 || frame.compressed_bytes !== frame.actual_bytes || frame.codec !== CHUNK_CODEC) return undefined
        rawBytes += frame.raw_bytes
        compressedBytes += frame.actual_bytes
        if (rawBytes > maxBytes || compressedBytes > maxBytes) return 'budget'
      }
      const tailFrom = Math.max(from, sealedEnd)
      const tailBytes = Number((this.statement(`SELECT coalesce(sum(length(CAST(event_json AS BLOB))), 0) AS n
        FROM session_event WHERE seq >= ? AND seq < ?`).get(tailFrom, total) as { n: unknown }).n)
      if (!Number.isSafeInteger(tailBytes) || tailBytes < 0) return undefined
      if (rawBytes + tailBytes > maxBytes) return 'budget'
      const events: SessionEvent[] = []
      for (const frame of frames) {
        const row = this.statement('SELECT payload FROM event_chunk WHERE first_seq = ?').get(frame.first_seq) as { payload: Uint8Array } | undefined
        if (row === undefined) return undefined
        const output = zstdDecompressSync(row.payload, { maxOutputLength: Math.min(maxBytes, frame.raw_bytes) })
        if (output.byteLength !== frame.raw_bytes) return undefined
        const lines = output.toString('utf8').split('\n')
        if (lines.length !== frame.event_count) return undefined
        events.push(...decodeChunkRange(lines, { firstSeq: frame.first_seq }, from, total))
      }
      for (const row of this.statement('SELECT seq, event_type, event_time_ms, event_json FROM session_event WHERE seq >= ? AND seq < ? ORDER BY seq').iterate(tailFrom, total) as Iterable<EventRow>) {
        const event: unknown = JSON.parse(String(row.event_json))
        if (!isRecord(event) || event.seq !== row.seq || event.type !== row.event_type || event.time !== row.event_time_ms) return undefined
        events.push(event as unknown as SessionEvent)
      }
      if (events.length !== total - from || events.some((event, i) => event.seq !== from + i)) return undefined
      validateStoredEvents(loaded.header, events, { kind: 'sqlite', path: this.path })
      return { ...loaded, events, eventCount: total, tornTruncateTo: undefined, path: this.path }
    } catch {
      // The optional preview never masks the official reader's diagnostics.
      return undefined
    } finally {
      this.db.exec('ROLLBACK')
    }
  }

  /**
   * The committed length, when the seal already vouches for the whole log.
   *
   * A write handle needs three things from an existing store: the header, the
   * next `seq`, and a decision about whether the tail is torn. The first two are
   * on the session row, and the third is answered by the seal: rows and
   * `event_count` move together inside one transaction, so a count that equals
   * the derived one and a fold that still matches cannot describe a log with a
   * half-written row at its end. Decoding 47k events to learn this cost about a
   * second on every resume of a long conversation, which is the one cost a user
   * feels before they have typed anything.
   *
   * What this does *not* prove is that every `event_json` still parses: the fold
   * covers count, key bounds, type lengths and the time total, not the JSON text.
   * That is the same risk `sliceIsTrusted` takes for windowed reads, and it is
   * not silent — a row whose JSON no longer decodes is found by the next
   * validating read, which reports the torn tail and truncates there. Callers
   * that need the precise boundary (`tornTruncateTo`) must use `loadSession`,
   * which is exactly what they do when this returns `undefined`.
   */
  trustedLength(): number | undefined {
    let header: LoadedHeader | undefined
    try {
      header = this.loadHeader()
    } catch {
      return undefined
    }
    if (header === undefined) return undefined
    // An import that never reached `ready` is not a log yet: its length says
    // nothing about a committed prefix.
    if (header.state !== 'ready') return undefined
    let counted: number
    try {
      counted = this.countEvents()
    } catch {
      return undefined
    }
    if (counted !== header.eventCount) return undefined
    if (!this.sliceIsTrusted()) return undefined
    // Fail-closed on the vocabulary, the one thing the fold cannot see. A log
    // written by a newer harness must keep refusing here, and a type this build
    // does not know is cheap to spot: the redundant column names every tail row
    // and each sealed chunk carries a histogram of the types inside it.
    //
    // With nothing sealed the "histogram" is a `SELECT DISTINCT` over the whole
    // tail. That reads every row, but it reads one indexed column: measured on a
    // 47k-event store the scan is 10ms, while the walk it replaces decodes 123MB
    // and costs about a second. Declining here to save 10ms is what made a
    // resume pay the second twice — once for this decision and once for the
    // caller's read — so the scan always runs.
    return this.vocabularyKnown() ? counted : undefined
  }

  /**
   * Whether every stored event type is one this build knows.
   *
   * An unknown type is not automatically an error — `validateStoredEvents`
   * accepts it when the record says `ignorable: true` — but deciding that needs
   * the record itself, so an unknown name simply declines the fast path and the
   * full walk decides. Nothing is trusted that the slow path would refuse.
   */
  private vocabularyKnown(): boolean {
    for (const row of this.statement(
      'SELECT DISTINCT event_type AS name FROM session_event',
    ).iterate() as Iterable<{ name: unknown }>) {
      if (!KNOWN_SESSION_EVENT_TYPES.has(String(row.name))) return false
    }
    if (!this.chunks) return true
    for (const row of this.statement(
      'SELECT types_json AS hist FROM event_chunk',
    ).iterate() as Iterable<{ hist: unknown }>) {
      let parsed: unknown
      try {
        parsed = JSON.parse(String(row.hist))
      } catch {
        return false
      }
      if (parsed === null || typeof parsed !== 'object') return false
      for (const name of Object.keys(parsed as Record<string, unknown>)) {
        if (!KNOWN_SESSION_EVENT_TYPES.has(name)) return false
      }
    }
    return true
  }

  /**
   * The header a paged read needs, or `undefined` when this store cannot be
   * paged.
   *
   * Paging exists so a long resume never becomes one message: the parse of one
   * page overlaps the read of the next, which is the only way to stay under a
   * second on a log of 47k events. It only pays while the seal still vouches for
   * the rows — an unsealed store has to be walked row by row anyway, and that
   * walk is what names a torn tail.
   */
  pagedHeader(): LoadedHeader | undefined {
    let header: LoadedHeader | undefined
    try {
      header = this.loadHeader()
    } catch {
      return undefined
    }
    if (header === undefined || header.state !== 'ready') return undefined
    if (!this.sliceIsTrusted()) return undefined
    let counted: number
    try {
      counted = this.countEvents()
    } catch {
      return undefined
    }
    return counted === header.eventCount ? header : undefined
  }

  /**
   * One page of raw JSON lines, `[from, to)`; bytes remain the default wire.
   *
   * The opt-in lines format skips UTF-8 encode/decode and join/split. It still
   * parses events on the caller and preserves the original SQL/frame checks.
   * Oversize string pages fall back to the existing transferable byte format.
   *
   * `undefined` means the page is not there as asked — a row missing, a frame
   * that no longer decodes, or a range that left the log. The caller then reads
   * the whole log the slow way, which reports the exact cut.
   */
  readPageBytes(from: number, to: number, format: PageTransferFormat = 'bytes'): LogPage | undefined {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) return undefined
    if (format !== 'bytes' && format !== 'lines') return undefined
    if (from === to) return format === 'lines'
      ? { firstSeq: from, count: 0, format: 'lines', lines: [] }
      : { firstSeq: from, count: 0, bytes: new Uint8Array(0) }
    const lines: string[] = []
    const sealedEnd = this.sealedRows().end
    try {
      if (from < sealedEnd) {
        // Seek to the frame that holds `from` instead of scanning frames 0..n:
        // on a 257-frame store that turns a 3.1ms range read into a 0.6ms seek.
        const anchor = this.statement(
          'SELECT first_seq FROM event_chunk WHERE first_seq <= ? ORDER BY first_seq DESC LIMIT 1',
        ).get(from) as { first_seq: unknown } | undefined
        const lower = anchor === undefined ? from : Number(anchor.first_seq)
        for (const chunk of this.statement(
          `SELECT first_seq, event_count, raw_bytes, payload
             FROM event_chunk
            WHERE first_seq >= ? AND first_seq < ?
            ORDER BY first_seq`,
        ).all(lower, Math.min(to, sealedEnd)) as unknown as Array<{
          first_seq: unknown
          event_count: unknown
          raw_bytes: unknown
          payload: unknown
        }>) {
          const firstSeq = Number(chunk.first_seq)
          const eventCount = Number(chunk.event_count)
          const frame = this.frameLines(
            firstSeq,
            eventCount,
            Buffer.from(chunk.payload as Uint8Array),
            // A whole-log read visits each frame once, so caching it can only
            // evict the frames the next page needs.
            false,
          )
          const lo = Math.max(from, firstSeq) - firstSeq
          const hi = Math.min(to, firstSeq + eventCount) - firstSeq
          for (let index = lo; index < hi; index += 1) lines.push(frame[index] as string)
        }
      }
      if (to > sealedEnd) {
        const lo = Math.max(from, sealedEnd)
        for (const row of this.statement(
          'SELECT event_json FROM session_event WHERE seq >= ? AND seq < ? ORDER BY seq',
        ).iterate(lo, to) as Iterable<{ event_json: unknown }>) {
          lines.push(String(row.event_json))
        }
      }
    } catch {
      return undefined
    }
    if (lines.length !== to - from) return undefined
    if (format === 'lines' && pageLinesWithinBudget(lines)) {
      return { firstSeq: from, count: to - from, format: 'lines', lines }
    }
    return { firstSeq: from, count: to - from, bytes: new TextEncoder().encode(lines.join('\n')) }
  }

  /**
   * How many events the store physically holds, sealed and tail together.
   *
   * One aggregate query, no decoding — cheap enough to ask on every open. A
   * store whose row claims more than this holds is damaged: it was cut short by
   * a crash, an interrupted copy, or a hand-run `DELETE`, and the row was never
   * brought down with it.
   */
  storedEventCount(): number {
    return this.countEvents()
  }

  /**
   * How many events the *logical* log holds: everything sealed plus the tail.
   *
   * `event_count` on the session row is the same number — this is how a read
   * checks the row still describes the data, so it must not count one half only.
   */
  private countEvents(): number {
    const sealed = this.chunks ? '(SELECT coalesce(sum(event_count), 0) FROM event_chunk)' : '0'
    const counted = this.statement(
      `SELECT ${sealed} + (SELECT count(*) FROM session_event) AS n`,
    ).get() as { n: unknown }
    return Number(counted.n)
  }

  /**
   * Read the committed prefix. A row is trusted only while it continues the
   * log: `seq` must equal the row index, the JSON must decode, and the redundant
   * columns must agree with it. The first disagreement ends the prefix and is
   * reported as `tornTruncateTo`.
   *
   * Because `seq` is the primary key of a WITHOUT ROWID table, the count and the
   * bounds prove key coverage: when `count === event_count && lo === 0 &&
   * hi === count - 1`, every seq in `[0, count)` exists exactly once. What they
   * cannot prove is that a row's JSON agrees with its columns, so a slice is
   * only served from a log that also passed that per-row check — which is what
   * the walk below establishes, and why the two paths report identical
   * `eventCount` and `tornTruncateTo`.
   *
   * Two ways to establish it, and the seal is the difference between them:
   *  * with a seal that still matches (`sliceIsTrusted`), the writer that
   *    committed the rows already vouched for them — one key fold (2–7ms on 47k
   *    events) replaces a full decode (1s);
   *  * otherwise every row is decoded, which is the cost of not knowing.
   *
   * `window` bounds how many events are decoded *into the result*. It never
   * bounds validation: a windowed read must answer exactly what a full read
   * would, or the same log would look different depending on the slice asked
   * for.
   */
  loadSession(window?: { offset: number; length: number }): LoadedSession | undefined {
    // One read transaction covers the proof and the read: a writer that commits
    // in between would otherwise be able to make the seal describe a log that is
    // no longer the one being served.
    this.db.exec('BEGIN')
    try {
      return this.loadSessionInTransaction(window)
    } finally {
      try {
        this.db.exec('COMMIT')
      } catch {
        // A read that failed half way has nothing to roll back; the failure is
        // what the caller needs to see.
      }
    }
  }

  private loadSessionInTransaction(window?: { offset: number; length: number }): LoadedSession | undefined {
    const loaded = this.loadHeader()
    if (loaded === undefined) return undefined
    const location: SessionLocation = { kind: 'sqlite', path: this.path }
    const total = this.countEvents()
    // The seal is consulted before the rows are decoded, not after: decoding
    // them is exactly what it is there to avoid. A seal that matches has already
    // proved the key bounds too — the checksum it is compared against folds
    // `count`, `min(seq)` and `max(seq)` into one value, so a match means the log
    // still runs 0 .. total-1 and every seq in between exists once. Without a
    // seal nothing is assumed: the walk below establishes the prefix row by row.
    const trusted = total === loaded.eventCount && this.sliceIsTrusted()

    const start = window === undefined ? 0 : Math.max(0, Math.min(window.offset, total))
    const end = window === undefined
      ? total
      : Math.max(start, Math.min(window.offset + window.length, total))


    // A whole log the seal vouched for is decoded the cheap way: chunks whole,
    // rows one column, no per-row comparison with the columns the writer also
    // filled in.
    if (trusted) {
      if (window === undefined) {
        const whole = this.decodeTrusted(total)
        if (whole !== undefined) {
          validateStoredEvents(loaded.header, whole, location)
          return {
            header: loaded.header,
            inheritedEventCount: loaded.inheritedEventCount,
            revision: loaded.revision,
            events: whole,
            storeUuid: loaded.storeUuid,
            state: loaded.state,
            eventCount: total,
            tornTruncateTo: undefined,
            path: this.path,
          }
        }
      } else {
        // The seal vouched for everything outside the window, so only the window
        // is decoded — one or two frames instead of the whole conversation.
        const sliced = this.sliceTrusted(start, end)
        validateStoredEvents(loaded.header, sliced, location)
        return {
          header: loaded.header,
          inheritedEventCount: loaded.inheritedEventCount,
          revision: loaded.revision,
          events: sliced,
          storeUuid: loaded.storeUuid,
          state: loaded.state,
          eventCount: total,
          tornTruncateTo: undefined,
          path: this.path,
        }
      }
    }

    // No usable seal: walk the logical log — sealed chunks, then tail rows — and
    // slice afterwards, because a windowed read has to report the same cut a full
    // read would. This is also the only path that can name the exact first bad
    // seq, which is why it stays available even when the seal is missing.
    const prefix: SessionEvent[] = []
    let tornTruncateTo: number | undefined
    if (this.chunks) {
      const chunks = this.statement(
        'SELECT first_seq, event_count, payload FROM event_chunk ORDER BY first_seq',
      ).iterate() as Iterable<{ first_seq: unknown; event_count: unknown; payload: unknown }>
      for (const chunk of chunks) {
        let events: SessionEvent[]
        try {
          events = decodeChunk(Buffer.from(chunk.payload as Uint8Array), {
            firstSeq: Number(chunk.first_seq),
            eventCount: Number(chunk.event_count),
          })
        } catch {
          tornTruncateTo = prefix.length
          break
        }
        if (events[0]?.seq !== prefix.length) {
          tornTruncateTo = prefix.length
          break
        }
        for (const event of events) prefix.push(event)
      }
    }
    if (tornTruncateTo === undefined) {
      const cursor = this.statement(
        `SELECT seq, event_type, event_time_ms, event_json
           FROM session_event
          ORDER BY seq`,
      ).iterate() as Iterable<EventRow>
      for (const row of cursor) {
        if (Number(row.seq) !== prefix.length) {
          tornTruncateTo = prefix.length
          break
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(String(row.event_json))
        } catch {
          tornTruncateTo = prefix.length
          break
        }
        if (
          !isRecord(parsed) ||
          parsed.type !== row.event_type ||
          parsed.seq !== Number(row.seq) ||
          parsed.time !== Number(row.event_time_ms)
        ) {
          tornTruncateTo = prefix.length
          break
        }
        prefix.push(parsed as unknown as SessionEvent)
      }
    }
    // A log that stops short of what the row claims is damaged, not clean: a
    // crash, an interrupted copy, or a hand-run DELETE took rows without taking
    // the count. The walk above finds holes and unreadable rows, but a log whose
    // prefix is simply shorter is contiguous by construction — so the only
    // evidence is the number itself, and without this line nothing would ever
    // report it: `stat` would keep promising rows that are gone, a reader would
    // refuse a log that merely got shorter, and the write path would append the
    // next batch over seqs whose contents were lost.
    if (tornTruncateTo === undefined && prefix.length < loaded.eventCount) {
      tornTruncateTo = prefix.length
    }
    if (window === undefined) {
      validateStoredEvents(loaded.header, prefix, location)
      return {
        header: loaded.header,
        inheritedEventCount: loaded.inheritedEventCount,
        revision: loaded.revision,
        events: prefix,
        storeUuid: loaded.storeUuid,
        state: loaded.state,
        eventCount: prefix.length,
        tornTruncateTo,
        path: this.path,
      }
    }
    // The slice must not reach past the cut, and it is validated against the
    // vocabulary exactly as the full read validates the whole prefix.
    const sliced = prefix.slice(start, Math.min(end, prefix.length))
    validateStoredEvents(loaded.header, sliced, location)
    return {
      header: loaded.header,
      inheritedEventCount: loaded.inheritedEventCount,
      revision: loaded.revision,
      events: sliced,
      storeUuid: loaded.storeUuid,
      state: loaded.state,
      eventCount: prefix.length,
      tornTruncateTo,
      path: this.path,
    }
  }

  /** On-disk size of the database file, excluding WAL and SHM side cars. */
  sizeBytes(): number {
    try {
      return statSync(this.path).size
    } catch {
      return 0
    }
  }

  /**
   * Fold the write-ahead log into the main file and empty it.
   *
   * Needed before a store is moved: `rename` carries only the main file, so a
   * tail still sitting in `-wal` would be lost (and the side car left behind
   * would then be replayed against whatever file took the name).
   */
  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }
}
