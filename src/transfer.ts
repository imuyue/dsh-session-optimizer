/**
 * The migration engine: JSONL → SQLite and SQLite → JSONL, with staging,
 * verification and atomic publish.
 *
 * Both the CLI and the Web GUI console drive this module, so a transfer behaves
 * the same however it was started. The JSONL side is always the official
 * `@deepseek-ai/dsh-session-persistence-jsonl` provider — this backend never
 * parses or writes the JSONL format itself, so a migrated log is byte-identical
 * to one the official backend wrote.
 *
 * Two guarantees that matter operationally:
 *
 * - **Staging.** A target is written to `<path>.importing` / `<dir>.exporting`
 *   and read back before it is published, so an interrupted run leaves the
 *   previous state intact and at worst a `.importing` directory behind.
 * - **Single writer.** Publishing over a live session renames the database, and
 *   on POSIX a live writer keeps writing to the now-unlinked inode — silent lost
 *   writes. Every publish therefore takes the target's write lease first and
 *   refuses while DSH holds it.
 *
 * @module dsh-session-optimizer/transfer
 */

import { createReadStream, existsSync } from 'node:fs'
import { link, mkdir, readdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve, win32 } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { readArtifactZstd } from './artifact-zstd.ts'
import { Context } from '@deepseek-ai/cordis'
import {
  SessionLogOffset,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
} from '@deepseek-ai/dsh-session'
import { SessionPersistence, SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'
import { SessionDatabase, ensureSessionDirectory, type LoadedHeader, type SqliteSettings } from './database.ts'
import { databasePath, decodeSegment, encodeSegment, sessionDir } from './format.ts'
import { SessionWriteLease } from './lease.ts'
import { scanSessions } from './storage.ts'
import { holdStore, withStoreHeld } from './store-lease.ts'

/** Import writes no WAL sidecars: a published session is one self-contained file. */
export const IMPORT_SETTINGS: SqliteSettings = {
  journalMode: 'delete',
  synchronous: 'full',
  busyTimeoutMs: 5000,
}

/** Read settings for a published store: the same pragmas the backend runs with. */
export const READ_SETTINGS: SqliteSettings = {
  journalMode: 'wal',
  synchronous: 'full',
  busyTimeoutMs: 5000,
}

const DATABASE_SUFFIXES = ['', '-wal', '-shm', '-journal'] as const

export type TransferDirection = 'jsonl_to_sqlite' | 'sqlite_to_jsonl'

export type TransferItemStatus = 'pending' | 'transferring' | 'verifying' | 'verified' | 'failed' | 'skipped'

export interface TransferItem {
  session: string
  /** Events the source held when the run started. */
  expected: number
  /** Events written to the staging copy. */
  transferred: number
  /** Next seq the published log continues from, or `undefined` when unknown. */
  nextSeq: number | undefined
  status: TransferItemStatus
  /** A short stable digest of the staged log, for cross-run comparison. */
  digest?: string
  /** Where the item landed, when it landed. */
  outputPath?: string
  /** Why it failed, in operator language. */
  error?: string
}

export type TransferJobStatus = 'running' | 'completed' | 'failed' | 'partial'

export interface TransferJob {
  readonly id: string
  readonly direction: TransferDirection
  readonly sourceRoot: string
  readonly targetRoot: string
  status: TransferJobStatus
  readonly startedAt: number
  finishedAt?: number
  readonly opts: TransferOptions
  readonly items: TransferItem[]
  /** Where staging happened, for operators cleaning up after a crash. */
  staging: string
  /** A previous run left staging behind; the next run removes it first. */
  partial: boolean
  error?: string
}

export interface TransferOptions {
  /** Replace an existing target instead of skipping it. */
  readonly force: boolean
  /** Read the staged copy back and compare it before publishing. */
  readonly verify: boolean
  /** Record a content digest per item (costs one extra pass). */
  readonly digest: boolean
  /** Restrict the run to one session id. */
  readonly session?: string | undefined
  /**
   * Open the source store read-only and never repair it.
   *
   * Reading a store normally goes through `SessionDatabase.open`, which tops up
   * the auxiliary table and index a store from an older build lacks — a write to
   * a file the operator may be inspecting, or one they were told would not be
   * touched. A migration that treats its source as immutable sets this, and pays
   * for it: no seal means no shortcut, so a windowed read decodes the log.
   */
  readonly readOnlySources?: boolean | undefined
}

/** Options that change nothing: what a caller gets when it says nothing. */
export const DEFAULT_TRANSFER_OPTIONS: TransferOptions = {
  force: false,
  verify: true,
  digest: false,
}

export interface JsonlMount {
  readonly persistence: SessionPersistence
  readonly compression: JsonlCompression
  readonly dispose: () => Promise<void>
}

const mounts = new Map<string, Promise<JsonlMount>>()

/** Load the official JSONL backend; it is only needed once a transfer starts. */
async function loadJsonl(): Promise<typeof import('@deepseek-ai/dsh-session-persistence-jsonl')> {
  try {
    return await import('@deepseek-ai/dsh-session-persistence-jsonl')
  } catch (error) {
    throw new Error(
      'the JSONL backend "@deepseek-ai/dsh-session-persistence-jsonl" is not installed; '
      + 'install it next to this plugin to move sessions between the two backends '
      + `(${error instanceof Error ? error.message : String(error)})`,
    )
  }
}

/**
 * Mount the official provider over one JSONL root.
 *
 * Mounts are cached per root and shared by every transfer in this process: two
 * providers over the same root would be two writers for the same logs. The owner
 * keeps them alive for the process lifetime; `disposeJsonlMounts` releases them
 * on shutdown.
 *
 * The encoding is decided per root, not fixed: DSH's own sessions root is zstd
 * compressed on disk (`session.v4.jsonl.zstd`), while a hand-made export is
 * usually plain. The official provider refuses to touch a root whose artifacts
 * are written with the other suffix, so asking for the wrong one turns every
 * real installation into "no sessions found" or an encoding mismatch.
 */
export async function mountJsonl(root: string, suffix?: 'jsonl' | 'jsonl.zstd'): Promise<JsonlMount> {
  const key = resolve(root)
  // Two encodings of the same path are two different roots to the provider: a
  // staging directory that already holds the other suffix must get its own mount.
  const cacheKey = suffix === undefined ? key : `${key}\u0000${suffix}`
  const existing = mounts.get(cacheKey)
  if (existing !== undefined) return existing
  const created = (async (): Promise<JsonlMount> => {
    const jsonl = await loadJsonl()
    const compression: JsonlCompression = suffix === undefined
      ? await detectCompression(key)
      : (suffix === 'jsonl.zstd' ? 'zstd' : 'none')
    const ctx = new Context()
    await ctx.plugin(jsonl, { root: key, compression })
    const persistence = ctx.sessionPersistence
    return {
      persistence,
      compression,
      dispose: async () => {
        await ctx.fiber.dispose()
        if (mounts.get(cacheKey) === created) mounts.delete(cacheKey)
      },
    }
  })()
  mounts.set(cacheKey, created)
  return created
}

/** The physical encoding one JSONL root is written in. */
export type JsonlCompression = 'zstd' | 'none'

/**
 * Which suffix artifacts under a root carry.
 *
 * `none` is the answer for an empty or missing root — a fresh export writes plain
 * JSONL. When both suffixes appear the compressed one wins only if it is the sole
 * kind; a mixed root is the caller's mess, and the official provider would refuse
 * it anyway, so the first artifact seen decides and the provider reports the rest.
 */
export async function detectCompression(root: string): Promise<JsonlCompression> {
  let projects: string[]
  try {
    projects = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
  } catch {
    return 'none'
  }
  for (const project of projects) {
    let entries
    try {
      entries = await readdir(project, { withFileTypes: true })
    } catch {
      continue
    }
    // A plain root keeps the log *as* `<project>/<id>.jsonl`, so its suffix is
    // right here; a compressed root keeps it one level down.
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl.zstd')) return 'zstd'
      if (entry.isFile() && entry.name.endsWith('.jsonl')) return 'none'
      if (!entry.isDirectory()) continue
      let files: string[]
      try {
        files = await readdir(join(project, entry.name))
      } catch {
        continue
      }
      if (files.some((name) => name.endsWith('.jsonl.zstd'))) return 'zstd'
      if (files.some((name) => name.endsWith('.jsonl'))) return 'none'
    }
  }
  return 'none'
}

/** One session directory found under a JSONL root, by name only. */
export interface JsonlSessionDir {
  readonly project: string
  readonly directory: string
  readonly path: string
}

/**
 * Whether a file name is a session log the provider could have written.
 *
 * The provider names the artifact after the session id and appends the encoding:
 * `<id>.jsonl` for a plain root, `<id>.jsonl.zstd` when compressed. A compressed
 * root keeps it inside a directory of the same id (`<id>/session.v4.jsonl.zstd`),
 * so a name without any suffix is not an artifact unless it lives there.
 */
function isArtifactName(name: string): boolean {
  return /\.jsonl(?:\.zstd)?$/.test(name)
}

/**
 * The escaped id a bare file name standing in for a session directory encodes.
 *
 * A plain root writes `<project>/<id>`, so the file *is* the session and has no
 * suffix of its own; its content still starts with the v4 header line, which is
 * what tells such a file apart from stray debris.
 */
async function bareSessionId(path: string): Promise<string | undefined> {
  const shape = await inspectJsonlArtifact(path)
  const id = shape?.header?.id
  return typeof id === 'string' ? id : undefined
}

/**
 * List the session directories under a JSONL root without opening any log.
 *
 * The directory name is the escaped session id, so this is enough to import a
 * specific session even when the provider refuses the root's other logs.
 */
export async function listJsonlSessionDirs(root: string): Promise<readonly JsonlSessionDir[]> {
  const base = resolve(root)
  let projects: string[]
  try {
    projects = (await readdir(base, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
  const found: JsonlSessionDir[] = []
  for (const project of projects) {
    let entries
    try {
      entries = await readdir(join(base, project), { withFileTypes: true })
    } catch {
      continue
    }
    const names = entries.map((entry: { name: string }) => entry.name)
    for (const name of names) {
      const path = join(base, project, name)
      const isFile = await stat(path).then((info) => info.isFile(), () => false)
      if (!isFile) {
        found.push({ project, directory: name, path })
        continue
      }
      // A plain root keeps the log as a bare file named after the id: no suffix
      // to key on, so the header line is what identifies it. A compressed root
      // puts the artifact (suffixed) inside the session directory instead.
      const id = isArtifactName(name)
        ? name.replace(/\.jsonl(?:\.zstd)?$/, '')
        : await bareSessionId(path)
      if (id === undefined) continue
      // `path` stays the file: a plain root has no session directory to open, and
      // the file is the artifact (a compressed root's entry above is a directory).
      found.push({ project, directory: encodeSegment(id as SessionId), path })
    }
  }
  return found
}

/**
 * Sessions under a root that the provider will not hand over, with the reason.
 *
 * Discovery is by directory, reading is by provider: anything that is a session
 * directory but is neither listed nor readable is reported once, by the id its
 * directory name encodes, so a damaged session cannot hide behind a clean list.
 */
async function unreadableSessions(
  root: string,
  readable: ReadonlySet<string>,
): Promise<readonly { readonly id: string; readonly problem: string }[]> {
  const problems: { id: string; problem: string }[] = []
  const seen = new Set(readable)
  for (const dir of await listJsonlSessionDirs(root)) {
    const id = decodeSegment(dir.directory)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    const artifact = await findJsonlArtifact(root, id)
    if (artifact === undefined) continue
    const shape = await inspectJsonlArtifact(artifact.path)
    if (shape === undefined) {
      problems.push({ id, problem: `cannot read "${artifact.path}"` })
      continue
    }
    // The provider fails closed on an event type it does not know; say which
    // kinds the log carries so the operator can tell a version skew from damage.
    const kinds = shape.types.slice(0, 6).map(([type, count]) => `${type}×${count}`).join(', ')
    problems.push({
      id,
      problem: `the provider refused this session (${shape.problem ?? `${shape.eventCount} events`}`
        + `${kinds === '' ? '' : `; types: ${kinds}`}); the log cannot be copied`,
    })
  }
  return problems
}

/** One session artifact under a JSONL root, as it sits on disk. */
export interface JsonlArtifact {
  /** The project directory name, e.g. `--C-APP-demo--`. */
  readonly project: string
  /** The escaped session directory name. */
  readonly directory: string
  /** The log file itself. */
  readonly path: string
  readonly sizeBytes: number
}

/** One session as the migration picker shows it, read without changing anything. */
export interface JsonlSessionListing {
  readonly id: string
  readonly origin?: 'subagent'
  readonly parentSession?: string
  readonly title: string | undefined
  readonly eventCount: number
  readonly sizeBytes: number
  readonly cwd: string | undefined
  readonly createdAt: number
  readonly path: string
  /** How the log looks to a reader, when that is worth warning about. */
  readonly problem: string | undefined
}

/**
 * Every session under a JSONL root, with the facts a picker needs.
 *
 * Discovery is by directory and by scan of the artifact itself, so a log the
 * provider refuses still appears (the operator can then see *why* before
 * choosing it). Titles come from the newest `session/title` in the same single
 * streaming pass that counts events.
 */
export async function inspectJsonlSessions(root: string, onlyIds?: ReadonlySet<string>): Promise<readonly JsonlSessionListing[]> {
  const listed = await listJsonlSessionDirs(root)
  const found: JsonlSessionListing[] = []
  for (const entry of listed) {
    const id = decodeSegment(entry.directory) ?? entry.directory
    if (onlyIds !== undefined && !onlyIds.has(id)) continue
    const artifact = await findJsonlArtifact(root, id)
    const path = artifact?.path ?? entry.path
    const shape = await inspectJsonlArtifact(path)
    if (shape?.header === undefined) continue
    found.push({
      id: String(shape.header.id),
      ...(shape.header.origin === 'subagent' ? { origin: 'subagent' as const, ...(shape.header.parentSession === undefined ? {} : { parentSession: String(shape.header.parentSession) }) } : {}),
      title: shape.title,
      eventCount: shape.eventCount,
      sizeBytes: artifact?.sizeBytes ?? 0,
      cwd: shape.header.cwd,
      createdAt: shape.header.createdAt,
      path,
      problem: shape.problem,
    })
  }
  return found
}

export async function findJsonlArtifact(root: string, id: string): Promise<JsonlArtifact | undefined> {
  const base = resolve(root)
  let projects: string[]
  try {
    projects = (await readdir(base, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return undefined
  }
  const segment = encodeSegment(id as SessionId)
  for (const project of projects) {
    const inside = await insideArtifact(join(base, project, segment))
    if (inside !== undefined) return { project, directory: segment, ...inside }
    // A plain root has no session directory: the provider writes the log *as*
    // `<root>/<project>/<id>`, so the inner name is the file itself.
    const flat = await stat(join(base, project, segment)).catch(() => undefined)
    if (flat?.isFile() !== true) continue
    return { project, directory: segment, path: join(base, project, segment), sizeBytes: flat.size }
  }
  return undefined
}

/**
 * The log file directly inside one session directory, if it holds one.
 *
 * A compressed root puts `<id>/session.v4.jsonl.zstd` there; a hand-made export
 * may leave a plain `.jsonl` beside it. Nothing deeper is searched: the provider
 * writes one artifact per directory, and guessing further would invent sessions.
 */
async function insideArtifact(directory: string): Promise<{ path: string; sizeBytes: number } | undefined> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return undefined
  }
  const name = names.find((entry) => entry.endsWith('.jsonl.zstd'))
    ?? names.find((entry) => entry.endsWith('.jsonl'))
  if (name === undefined) return undefined
  const path = join(directory, name)
  const info = await stat(path).catch(() => undefined)
  if (info?.isFile() !== true) return undefined
  return { path, sizeBytes: info.size }
}

/** How many events, and which kinds, one artifact holds. Counted without writing. */
export interface JsonlArtifactShape {
  readonly eventCount: number
  /** `undefined` when the log file could not be decompressed at all. */
  readonly contiguous: boolean | undefined
  readonly types: ReadonlyArray<readonly [string, number]>
  /** The header line, when it parses. */
  readonly header?: SessionHeader | undefined
  /** Newest `session/title` seen while streaming, when the log has one. */
  readonly title?: string | undefined
  /** Why the artifact could not be read, when it could not. */
  readonly problem?: string | undefined
}

/**
 * Count the events of one artifact by streaming it.
 *
 * Nothing is buffered beyond one line, so a 36 MB compressed / 130 MB plain log
 * costs the same memory as a small one. Returns `undefined` only when the file
 * cannot be opened.
 */
/** Own the entire read/decode chain, including errors after a consumer stops early. */
async function* artifactLines(path: string): AsyncGenerator<string> {
  const raw = path.endsWith('.zstd') ? undefined : createReadStream(path)
  const input = raw ?? readArtifactZstd(path)
  const decoder = new StringDecoder('utf8')
  let pending = ''
  try {
    for await (const chunk of input) {
      pending += decoder.write(chunk as Buffer)
      let start = 0
      for (;;) {
        const end = pending.indexOf('\n', start)
        if (end < 0) break
        const line = pending.slice(start, end)
        yield line.endsWith('\r') ? line.slice(0, -1) : line
        start = end + 1
      }
      pending = pending.slice(start)
    }
    pending += decoder.end()
    if (pending !== '') yield pending.endsWith('\r') ? pending.slice(0, -1) : pending
  } finally {
    // for-await return/break must not leave a paused decompressor/source alive.
    raw?.destroy()
  }
}

export async function readJsonlParent(path: string, id: string, signal?: AbortSignal): Promise<{ origin?: 'subagent'; parentSession?: string }> {
  const raw = path.endsWith('.zstd') ? undefined : createReadStream(path)
  const input = raw ?? readArtifactZstd(path), decoder = new StringDecoder('utf8')
  let pending = '', bytes = 0
  const parse = (line: string): { origin?: 'subagent'; parentSession?: string } => {
    const value = JSON.parse(line) as Record<string, unknown>
    if (value?.type !== 'session' || value.id !== id) throw new Error('session header identity disagrees with directory')
    return value.origin === 'subagent'
      ? { origin: 'subagent', ...(typeof value.parentSession === 'string' && value.parentSession.length <= 256 ? { parentSession: value.parentSession } : {}) }
      : {}
  }
  try {
    for await (const chunk of input) {
      signal?.throwIfAborted()
      const piece = (chunk as Buffer).subarray(0, 256 * 1024 - bytes); bytes += piece.length
      pending += decoder.write(piece)
      let end: number
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0,end); pending = pending.slice(end + 1)
        if (line.trim() !== '') return parse(line)
      }
      if (bytes >= 256 * 1024) throw new Error('session header exceeds metadata budget')
    }
    pending += decoder.end(); signal?.throwIfAborted()
    if (pending.trim() !== '') return parse(pending)
    throw new Error('no readable session header')
  } finally { raw?.destroy() }
}

export async function readJsonlTitle(path: string, id: string, signal?: AbortSignal): Promise<string | undefined> {
  let title: string | undefined
  let header = false
  for await (const line of artifactLines(path)) {
    signal?.throwIfAborted()
    if (line.trim() === '') continue
    if (!header) {
      const value = JSON.parse(line) as Record<string, unknown>
      if (value?.type !== 'session' || value.id !== id) throw new Error('session header identity disagrees with directory')
      header = true
      continue
    }
    if (!line.includes('session/title')) continue
    const value: unknown = JSON.parse(line)
    if (typeof value !== 'object' || value === null) continue
    const event = value as { type?: unknown; data?: { title?: unknown } }
    if (event.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title !== '') title = event.data.title
  }
  signal?.throwIfAborted()
  if (!header) throw new Error('no readable session header')
  return title
}

export async function inspectJsonlArtifact(path: string): Promise<JsonlArtifactShape | undefined> {
  if (!existsSync(path)) return undefined
  const counts = new Map<string, number>()
  let eventCount = 0
  let contiguous = true
  let header: SessionHeader | undefined
  let title: string | undefined
  let problem: string | undefined
  try {
    for await (const line of artifactLines(path)) {
      if (line === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        contiguous = false
        problem ??= 'a line is not JSON'
        continue
      }
      if (typeof parsed !== 'object' || parsed === null) {
        contiguous = false
        continue
      }
      const record = parsed as Record<string, unknown>
      if (record.type === 'session') {
        header = record as unknown as SessionHeader
        continue
      }
      const seq = record.seq
      if (typeof seq !== 'number' || seq !== eventCount) contiguous = false
      const type = typeof record.type === 'string' ? record.type : '<missing type>'
      counts.set(type, (counts.get(type) ?? 0) + 1)
      if (type === 'session/title') {
        const data = record.data
        const candidate = typeof data === 'object' && data !== null
          ? (data as { title?: unknown }).title
          : undefined
        if (typeof candidate === 'string' && candidate !== '') title = candidate
      }
      eventCount += 1
    }
  } catch (error) {
    problem ??= error instanceof Error ? error.message : String(error)
    return { eventCount, contiguous: undefined, types: [...counts], header, title, problem }
  }
  const types = [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  return { eventCount, contiguous, types, header, title, problem }
}

/**
 * Copy one artifact line by line, without the provider's vocabulary check.
 *
 * Used only when the provider refuses a log; the result carries the events it
 * could read and marks the copy torn when a line broke the run. A missing or
 * unparsable header means the file is not a session log at all and there is
 * nothing to salvage, so `undefined` is returned instead of a guessed header.
 */
export async function salvageJsonlArtifact(path: string): Promise<LogCopy | undefined> {
  if (!existsSync(path)) return undefined
  const events: SessionEvent[] = []
  let header: SessionHeader | undefined
  let expected = 0
  let broken = false
  // An event's seq is absolute: a seeded log starts at the seq its parent had
  // reached, so the first event fixes the base every later seq is measured from.
  let base: number | undefined
  try {
    for await (const line of artifactLines(path)) {
      if (line === '') continue
      if (broken) break
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        broken = true
        break
      }
      if (typeof parsed !== 'object' || parsed === null) {
        broken = true
        break
      }
      const record = parsed as Record<string, unknown>
      if (record.type === 'session') {
        header ??= record as unknown as SessionHeader
        continue
      }
      if (typeof record.type !== 'string' || typeof record.seq !== 'number') {
        broken = true
        break
      }
      base ??= record.seq
      if (record.seq !== base + expected) {
        broken = true
        break
      }
      events.push(record as unknown as SessionEvent)
      expected += 1
    }
  } catch {
    broken = true
  }
  if (header === undefined) return undefined
  // A prefix that stopped short is not the whole log, and saying so is the only
  // way a caller can tell a faithful copy from a truncated one.
  const problem = broken
    ? `the log breaks after ${events.length} events; copied that prefix`
    : undefined
  return { header, inheritedEventCount: inheritedCountOf(events), events, problem, ...(broken ? { incomplete: true } : {}) }
}

/**
 * The count a seeded session's header implies, read back out of its own events.
 *
 * A seeded log starts mid-history: its first event carries the seq the parent had
 * reached, which is exactly the inherited count the provider was created with. A
 * log that starts at zero inherits nothing, which is also what an unseeded header
 * means. Recovering this from the events keeps the count honest on the way back
 * without a second field in the file.
 */
function inheritedCountOf(events: readonly SessionEvent[]): number {
  const first = events[0]
  return first === undefined ? 0 : first.seq
}

/** Release every JSONL mount; safe to call more than once. */
export async function disposeJsonlMounts(): Promise<void> {
  const pending = [...mounts.values()]
  mounts.clear()
  for (const mount of pending) {
    try {
      const { dispose } = await mount
      await dispose()
    } catch {
      // A mount that never came up has nothing to release.
    }
  }
}

/** Release the mount over one root — used after a staging root is removed. */
export async function releaseJsonlMount(root: string): Promise<void> {
  const key = resolve(root)
  // One root can hold a mount per encoding; release every one of them.
  const keys = [...mounts.keys()].filter((candidate) => candidate === key || candidate.startsWith(`${key}\u0000`))
  const entries = keys.map((candidate) => mounts.get(candidate)).filter((entry) => entry !== undefined)
  for (const candidate of keys) mounts.delete(candidate)
  for (const entry of entries) {
    try {
      const { dispose } = await entry
      await dispose()
    } catch {
      // best-effort
    }
  }
}

export interface LogCopy {
  readonly header: SessionHeader
  readonly inheritedEventCount: number
  readonly events: readonly SessionEvent[]
  /** Set only when streaming salvage stopped before the physical log ended. */
  readonly incomplete?: boolean | undefined
  /** Set when the copy was not taken through the provider verbatim. */
  readonly problem?: string | undefined
}

/**
 * The header a writer will accept, derived from the one a store or a log carries.
 *
 * `type: 'session'` is the physical line tag, not session metadata, so it is
 * dropped — the provider's header schema rejects it. A `cwd` that is not absolute
 * for *this* host (a log written on Windows, `C:\APP\x`) is translated into the
 * POSIX form of the same place, because the provider validates it with
 * `path.isAbsolute` and refuses the whole header otherwise. The original path is
 * still what the comparison uses (`cwdKey` keeps both sides equal), so nothing is
 * claimed to differ just because the export ran on another platform.
 */
export function headerOf(header: SessionHeader, host: 'windows' | 'posix' = hostKind()): SessionHeader {
  const { type, ...rest } = header as SessionHeader & { readonly type?: unknown }
  void type
  const cwd = portableCwd(rest.cwd, host)
  if (cwd === undefined) {
    const { cwd: _cwd, ...withoutCwd } = rest
    void _cwd
    return withoutCwd as SessionHeader
  }
  return { ...rest, cwd } as SessionHeader
}

function hostKind(): 'windows' | 'posix' {
  return process.platform === 'win32' ? 'windows' : 'posix'
}

/**
 * The `cwd` the given host's validator accepts, or `undefined` when relative.
 *
 * "Accepts" is the runtime's own test, not a stricter one of our making: the
 * provider validates a header with that host's `path.isAbsolute`, and on Windows
 * that accepts a drive path (`C:\APP\x`), a UNC path (`\\server\share`) and a
 * root-relative path (`/work/x`, `\work\x` — anchored to the current drive). All
 * three are absolute to the runtime that will open the store, so all three are
 * carried through; only a genuinely relative path (`C:APP`, `foo\bar`) is refused.
 */
function portableCwd(cwd: string | undefined, host: 'windows' | 'posix'): string | undefined {
  if (cwd === undefined) return undefined
  if (host === 'windows') return win32.isAbsolute(cwd) ? cwd : undefined
  if (cwd.startsWith('/')) return cwd
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(cwd)
  if (drive !== null) return `/mnt/${(drive[1] as string).toLowerCase()}/${(drive[2] as string).replaceAll('\\', '/')}`
  const unc = /^[\\/]{2}([^\\/]+)[\\/](.*)$/.exec(cwd)
  if (unc !== null) return `/${(unc[1] as string).toLowerCase()}/${(unc[2] as string).replaceAll('\\', '/')}`
  return undefined
}

/**
 * The provider validates `header.cwd` with `path.isAbsolute`, which on this host
 * only accepts a POSIX path, so a log written on Windows (`C:\APP\x`) is refused
 * even though the path was absolute for the runtime that wrote it. The header cwd
 * is a label in the store — nothing opens it — so the comparison is made on a
 * host-neutral key instead of rewriting (and thus losing) the recorded path.
 *
 * `null` marks a header the writer would refuse, which only a relative cwd causes.
 */
/**
 * A host-neutral key for `header.cwd`.
 *
 * The same session can be read as `C:\APP\x` on the machine that wrote it and as
 * `/mnt/c/APP/x` after a cross-platform export, so both spellings have to compare
 * equal — otherwise every migrated session would look like it changed. `null`
 * marks a relative path, which no writer accepts.
 */
function cwdKey(cwd: string | undefined): string | null {
  if (cwd === undefined) return ''
  const mounted = /^\/mnt\/([A-Za-z])\/(.*)$/.exec(cwd)
  if (mounted !== null) return `${(mounted[1] as string).toLowerCase()}:/${mounted[2] as string}`
  const drive = /^([A-Za-z]):[\\/]?(.*)$/.exec(cwd)
  if (drive !== null) return `${(drive[1] as string).toLowerCase()}:/${(drive[2] as string).replaceAll('\\', '/')}`
  if (cwd.startsWith('/')) return cwd
  const unc = /^[\\/]{2}([^\\/]+)[\\/](.*)$/.exec(cwd)
  if (unc !== null) return `//${(unc[1] as string).toLowerCase()}/${(unc[2] as string).replaceAll('\\', '/')}`
  return null
}

/**
 * One artifact as the provider sees it, or `undefined` when it has none.
 *
 * A plain `.jsonl` root stores the log at `<root>/<project>/<id>` — the id is the
 * file name, so the directory walk cannot recognise it. The mount's own record is
 * therefore consulted first for that layout.
 */
export async function readJsonlLog(root: string, id: string): Promise<LogCopy | undefined> {
  const mounted = await mountedArtifact(root, id)
  if (mounted !== undefined) {
    // An artifact the provider can name is read through its own view of the root,
    // so a staging root (a path never meant as a sessions root) still resolves.
    const viaPath = await readArtifactFile(mounted)
    if (viaPath !== undefined) return viaPath
  }
  return await readJsonlSession(root, id)
}

/** Read one artifact file directly, whatever root it lives under. */
async function readArtifactFile(path: string): Promise<LogCopy | undefined> {
  const shape = await inspectJsonlArtifact(path)
  if (shape === undefined) return undefined
  const salvaged = await salvageJsonlArtifact(path)
  if (salvaged === undefined) return undefined
  return salvaged
}

/**
 * Read one JSONL log through the provider, or stream it when the provider refuses.
 *
 * The provider fails closed on an event type it does not know, and that verdict is
 * correct for resuming a session. A migration only has to copy what is there, so
 * the fallback streams the same lines and checks the parts a copy must agree on:
 * the header parses, every event is an object with a `type` and a contiguous
 * `seq`. It never repairs anything — a damaged line ends the readable prefix.
 */
export async function readJsonlSession(root: string, id: string): Promise<LogCopy | undefined> {
  // An absent session and a refused one are different answers: `stat` decides the
  // first, so a provider that happens to fall silent never reads as "not there".
  const { persistence } = await mountJsonl(root)
  const snapshot = await persistence.stat(id as SessionId).catch(() => undefined)
  if (snapshot === undefined) {
    const artifact = await findJsonlArtifact(root, id)
    if (artifact === undefined) return undefined
  }
  try {
    return await readJsonlThroughProvider(root, id)
  } catch (error) {
    const artifact = await findJsonlArtifact(root, id)
    if (artifact === undefined) throw error
    const salvaged = await salvageJsonlArtifact(artifact.path)
    if (salvaged === undefined) throw error
    // Say which refusal sent the copy down the streaming path: the differences
    // between this build's vocabulary and the log's are the operator's to judge.
    const refusal = `the provider refused this session (${String((error as Error).message).slice(0, 200)})`
    return {
      ...salvaged,
      problem: salvaged.problem === undefined ? `${refusal}; copied the whole log` : `${refusal}; ${salvaged.problem}`,
    }
  }
}

async function readJsonlThroughProvider(root: string, id: string): Promise<LogCopy | undefined> {
  const { persistence } = await mountJsonl(root)
  const snapshot = await persistence.stat(id as SessionId)
  if (snapshot === undefined) {
    // `stat` returning nothing does not mean the log is gone: the provider drops a
    // header line it cannot decode. The file still has to be streamed then, so
    // that refusal is raised rather than reported as an absent session.
    const artifact = await findJsonlArtifact(root, id)
    if (artifact !== undefined) {
      throw new SessionPersistenceCorruptionError(
        `session "${id}": the provider cannot stat the artifact at "${artifact.path}"`,
        {},
      )
    }
    return undefined
  }
  const handle = await persistence.open(id as SessionId, 'read')
  try {
    const log = await handle.read()
    return {
      header: headerOf(handle.header ?? snapshot.header),
      inheritedEventCount: handle.inheritedEventCount,
      events: log.events,
    }
  } finally {
    await handle.close()
  }
}

export async function listJsonlSessions(root: string): Promise<readonly SessionHeader[]> {
  const { persistence, compression } = await mountJsonl(root)
  // The provider's own listing silently drops a session whose header line it
  // cannot decode (see `listArtifacts`), and an empty list is indistinguishable
  // from an empty root. Anything that fails outright is reported by the caller,
  // which also walks the directories, so a refused artifact never disappears here.
  const snapshots = await persistence.list().catch(() => [])
  // Every header taken from an artifact with the other suffix is unusable: the
  // directory was written before the root's encoding changed, or it is debris.
  const wanted = compression === 'zstd' ? '.jsonl.zstd' : '.jsonl'
  const headers = snapshots
    .filter((snapshot) => snapshot.location?.path?.endsWith(wanted) ?? true)
    .map((snapshot) => headerOf(snapshot.header))
  // The directory walk names every session on disk. A log the provider skips is
  // still a session to migrate when the reader below can stream it, so headers are
  // recovered from the files themselves (the directory name is only the id).
  const known = new Set<string>(headers.map((header) => String(header.id)))
  for (const dir of await listJsonlSessionDirs(root)) {
    const artifact = await artifactPathOf(dir.path)
    if (artifact === undefined) continue
    const shape = await inspectJsonlArtifact(artifact)
    // The header carries the identity; the directory name is only a hint, so a
    // log whose header disagrees with its directory is skipped, not renamed.
    const header = shape?.header
    const id = header?.id
    if (header === undefined || typeof id !== 'string' || known.has(id)) continue
    known.add(id)
    headers.push(headerOf(header))
  }
  return headers
}

/** The log file inside one session directory, compressed form first. */
async function artifactPathOf(path: string): Promise<string | undefined> {
  // A plain root writes the log as the session's own path; only a directory has
  // to be searched for the artifact inside it.
  if (isArtifactName(path)) return path
  if (await stat(path).then((info) => info.isFile(), () => false)) return path
  const files = await readdir(path).catch(() => [] as string[])
  const name = files.find((entry) => entry.endsWith('.jsonl.zstd'))
    ?? files.find((entry) => entry.endsWith('.jsonl'))
  return name === undefined ? undefined : join(path, name)
}

/**
 * Where the provider actually wrote one session under a root it has mounted.
 *
 * A plain `.jsonl` root gets the artifact at `<root>/<project>/<id>` — the id is
 * the file name, not a directory — which the directory walk cannot recognise.
 * The mount's own record is therefore authoritative, and the walk only covers a
 * root this process never mounted.
 */
async function mountedArtifact(root: string, id: string): Promise<string | undefined> {
  const key = resolve(root)
  for (const [cacheKey, mount] of mounts) {
    if (cacheKey !== key && !cacheKey.startsWith(`${key}\u0000`)) continue
    const { persistence } = await mount
    const snapshot = await persistence.stat(id as SessionId).catch(() => undefined)
    const path = snapshot?.location?.path
    if (path !== undefined) return path
  }
  return undefined
}

/** Every store under a SQLite root: the escaped directory and its database path. */
export async function scanSqliteSessions(root: string): Promise<readonly { readonly directory: string; readonly path: string }[]> {
  return await scanSessions(root)
}

/** Read one store by session id under a root; `undefined` when it is absent. */
export async function readSqliteSessionById(
  root: string,
  id: string,
  options: TransferOptions | undefined = undefined,
): Promise<SqliteCopy | undefined> {
  const entries = await scanSessions(root)
  for (const entry of entries) {
    let copy: SqliteCopy
    try {
      copy = await readSqliteCopy(entry.path, 'strict', options)
    } catch {
      continue
    }
    if (copy.header.id === id) return copy
  }
  return undefined
}

/** One session read back out of a SQLite store, with the facts a report needs. */
export interface SqliteCopy extends LogCopy {
  readonly state: 'importing' | 'ready'
  readonly path: string
  /** The log started at seq N and the rest of it is not there. */
  readonly torn: boolean
}

/**
 * How strictly a store is read.
 *
 * `strict` is for a transfer that must not silently move less than the source
 * holds. `salvage` keeps whatever prefix is readable and reports the damage, so a
 * diagnostic command can name the session it cannot use instead of dying on the
 * first one — the difference between "these three are broken" and a stack trace.
 */
export type SqliteReadMode = 'strict' | 'salvage'

/** Read a published session by directory, resolving its id from the header. */
export async function readSqliteCopy(
  path: string,
  mode: SqliteReadMode = 'strict',
  options: TransferOptions | undefined = undefined,
): Promise<SqliteCopy> {
  // A read-only connection keeps a diagnostic from creating an empty store where
  // the caller asked only about an existing one.
  const db = SessionDatabase.open(path, { ...READ_SETTINGS, readOnly: true, repair: options?.readOnlySources !== true })
  try {
    const loaded = db.loadSession()
    if (loaded === undefined) throw new Error(`"${path}" holds no session row`)
    if (mode === 'strict') {
      if (loaded.state !== 'ready') {
        throw new Error(`"${path}" holds an unfinished import; rerun the transfer to replace it`)
      }
      if (loaded.tornTruncateTo !== undefined) {
        throw new Error(
          `"${path}" has a torn tail starting at seq ${loaded.tornTruncateTo}; `
          + 'open the session with the plugin so the write path can repair it before exporting',
        )
      }
    }
    return {
      header: loaded.header,
      inheritedEventCount: loaded.inheritedEventCount,
      events: loaded.events,
      state: loaded.state,
      path,
      torn: loaded.tornTruncateTo !== undefined,
    }
  } finally {
    db.close()
  }
}

/**
 * Read only the header of a store, for callers that need its identity and not
 * its events. A store whose log is damaged usually still names its session, and
 * that name is what lets a diagnostic say which session it is complaining about.
 */
export async function readSqliteHeader(path: string): Promise<LoadedHeader> {
  // Read-only, and allowed to repair: a diagnostic that only wants the identity
  // must not create a store, but it may add the auxiliary table an older build
  // lacks so the next windowed read is cheap.
  const db = SessionDatabase.open(path, { ...READ_SETTINGS, readOnly: true })
  try {
    const header = db.loadHeader()
    if (header === undefined) throw new Error(`"${path}" holds no session row`)
    return header
  } finally {
    db.close()
  }
}

/** Remove a store and every sidecar a crash could have left beside it. */
export async function removeDatabase(path: string): Promise<void> {
  // The hold closes the cached connection and keeps it closed for the duration:
  // without it a read that arrives between the release and the `rm` reopens the
  // file, and on Windows the `rm` then fails with `EBUSY` on a store nothing is
  // legitimately using any more.
  await withStoreHeld(path, async () => {
    for (const suffix of DATABASE_SUFFIXES) {
      await rm(`${path}${suffix}`, { force: true })
    }
  })
}

/**
 * The header a store may hold on this host.
 *
 * A log written on Windows records `C:\APP\x`, which this host's runtime rejects
 * with `path.isAbsolute` — the session then loads as corrupt even though every
 * event is intact. The store is the place a conversation is opened from, so the
 * cwd is translated into the mounted form of the same directory instead of being
 * carried verbatim. A cwd with no translation (a relative path) is refused here:
 * dropping it would hide the conversation from the session list, which reads as a
 * successful migration of something that is not there.
 */
export function storableHeader(header: SessionHeader): SessionHeader {
  const normalized = headerOf(header)
  if (header.cwd !== undefined && normalized.cwd === undefined) {
    throw new Error(
      `cwd "${header.cwd}" is not an absolute path on this host, so a store written here could never be opened`,
    )
  }
  return normalized
}

/** Write one session into a fresh store, marked `importing` until verified. */
export async function writeSqliteSession(target: string, copy: LogCopy): Promise<void> {
  // The header is settled before the directory exists: a refusal here must not
  // leave an empty store behind, which a later scan would list as an unreadable
  // session and an operator would have to clean up by hand.
  const header = storableHeader(copy.header)
  await ensureSessionDirectory(dirname(target))
  await removeDatabase(target)
  const db = SessionDatabase.open(target, IMPORT_SETTINGS)
  try {
    db.appendImported(header, copy.events, copy.inheritedEventCount)
    db.markReady()
  } finally {
    db.close()
  }
  // `removeDatabase` clears the side cars, and the store was closed above, so
  // nothing should be left — but if a `-wal` survives, publishing it by rename
  // would move a main file that disagrees with its own log.
  await checkpointDatabase(target)
}

/**
 * Fold a `-wal` into its main file.
 *
 * SQLite's tail lives in `-wal` until a checkpoint, and `rename` only carries
 * the main file: publishing without this step hands the next opener a database
 * that is missing however many events were still in the log. `TRUNCATE` also
 * empties the file, which is what makes the side car harmless afterwards.
 */
async function checkpointDatabase(path: string): Promise<void> {
  if (!existsSync(path)) return
  let db: SessionDatabase | undefined
  try {
    db = SessionDatabase.open(path, READ_SETTINGS)
    db.checkpoint()
  } finally {
    db?.close()
  }
}

/**
 * Publish a staged store over the target, refusing while DSH writes it.
 */
export async function publishDatabase(staged: string, target: string): Promise<void> {
  await publishDatabaseWithPolicy(staged, target)
}

/** Publish a clone without ever replacing an existing store. */
export async function publishNewDatabase(
  staged: string,
  target: string,
  assertAbsent: () => Promise<void>,
): Promise<void> {
  await publishDatabaseWithPolicy(staged, target, assertAbsent)
}

async function publishDatabaseWithPolicy(
  staged: string,
  target: string,
  assertAbsent?: () => Promise<void>,
): Promise<void> {
  // Take the lease first: renaming under a live writer loses its later appends
  // to an unlinked inode without any error.
  // The lease id is the caller's business, not the session's: publish holds it
  // only for the rename, so a concurrent `import --force` of the same session
  // cannot interleave with it.
  const lease = await SessionWriteLease.acquire(dirname(target), basename(dirname(target)) as SessionId)
  try {
    if (assertAbsent !== undefined) {
      await checkpointDatabase(staged)
      await assertAbsent()
      if (DATABASE_SUFFIXES.some((suffix) => existsSync(`${target}${suffix}`)
        || existsSync(`${target}.replaced${suffix}`))) {
        throw new Error(`clone target "${target}" already exists`)
      }
      await link(staged, target)
      await unlink(staged)
      return
    }
    // A publish that died between moving the old store aside and renaming the
    // new one leaves the old store under `<target>.replaced` and nothing under
    // the target name: invisible to listing, and one `removeDatabase` away from
    // being deleted by the next publish. Put it back before doing anything else.
    const previous = `${target}.replaced`
    if (!existsSync(target) && existsSync(previous)) await moveDatabase(previous, target)
    // A staged store is closed by now, so this only guarantees the invariant
    // rather than fixing anything: what gets renamed must be self-contained.
    await checkpointDatabase(staged)
    if (!existsSync(target)) {
      // A store whose main file is gone can still leave `-wal`/`-shm` behind —
      // a crash between the two halves of an earlier replace, or a delete that
      // could not remove them. Renaming over the name while they sit there hands
      // the next opener a fresh database with someone else's write-ahead log,
      // which it replays as if it belonged: the log reads as empty or corrupt.
      await removeDatabase(target)
      await rename(staged, target)
      return
    }
    // Carry the whole store — a target kept open elsewhere leaves its `-wal`
    // and `-shm` next to the new file, and those belong to the old log.
    await removeDatabase(previous)
    await moveDatabase(target, previous)
    try {
      await rename(staged, target)
    } catch (error) {
      // Put the old store back under its own name. A failed restore is not
      // silence: the target may now be a new main file with the old log beside
      // it, so the caller has to hear about both failures.
      await moveDatabase(previous, target).catch((restoreError: unknown) => {
        throw new AggregateError(
          [error, restoreError],
          `publish of "${target}" failed and the previous store could not be restored`,
        )
      })
      throw error
    }
    await removeDatabase(previous)
  } finally {
    await lease.release()
  }
}

/**
 * Move a store with its side cars.
 *
 * `rename` on the main file alone is not a move of the database: a `-wal` left
 * behind would be replayed against the wrong file by the next opener. So the side
 * cars move first — the main file is the one that makes the store visible, and if
 * a side car cannot be moved the move stops before the store changes identity.
 * Only "there is no such side car" is tolerated; anything else (a held `-shm` on
 * Windows, a permission problem) is reported, because swallowing it would leave a
 * new main file next to an old write-ahead log.
 */
async function moveDatabase(from: string, to: string): Promise<void> {
  // Both names are released first: a connection this process still holds makes
  // the first `rename` fail with `EBUSY` on Windows, and the handle is ours, so
  // no retry outlasts it. The holds are taken before the renames, because the
  // release alone leaves a window in which a read (a warm-up, a refresh) opens
  // the file again and the rename then meets the handle it just closed.
  const releaseFrom = await holdStore(from)
  let releaseTo: (() => void) | undefined
  try {
    releaseTo = await holdStore(to)
    const moved: string[] = []
    try {
      for (const suffix of ['-wal', '-shm', '-journal']) {
        try {
          await rename(`${from}${suffix}`, `${to}${suffix}`)
          moved.push(suffix)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      await rename(from, to)
    } catch (error) {
      // A later sharing/failure must not detach a committed WAL from its old
      // main file. Restore only files moved by this call, in reverse order.
      const errors: unknown[] = [error]
      for (const suffix of moved.reverse()) {
        try { await rename(`${to}${suffix}`, `${from}${suffix}`) }
        catch (restoreError) { errors.push(restoreError) }
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, `database move from ${from} to ${to} failed and sidecar restoration was incomplete; preserve both paths for recovery`)
      }
      throw error
    }
  } finally {
    releaseTo?.()
    releaseFrom()
  }
}

/** Canonical JSON: sorted keys, so two encoders of the same value compare equal. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

/** One difference between the two sides of a transfer. */
export interface Difference {
  readonly session: string
  readonly detail: string
}

/**
 * Compare two copies of the same log; `undefined` means they agree.
 *
 * The header is compared field by field with `cwd` on a host-neutral key: the same
 * session imported on Windows and exported on Linux must not be reported as a
 * difference, and a changed path must not be hidden either.
 */
export function headerDifference(expected: SessionHeader, actual: SessionHeader): string | undefined {
  const left = new Map<string, string>()
  const right = new Map<string, string>()
  for (const [key, value] of Object.entries(expected as unknown as Record<string, unknown>)) {
    if (key === 'type') continue
    left.set(key, key === 'cwd' ? String(cwdKey(value as string | undefined)) : canonical(value))
  }
  for (const [key, value] of Object.entries(actual as unknown as Record<string, unknown>)) {
    if (key === 'type') continue
    right.set(key, key === 'cwd' ? String(cwdKey(value as string | undefined)) : canonical(value))
  }
  if (left.size !== right.size) return 'session header differs: a field is present on one side only'
  for (const [key, value] of left) {
    const other = right.get(key)
    if (other === undefined) return `session header differs: "${key}" is present on one side only`
    if (other !== value) return `session header differs: "${key}" is ${value} vs ${other}`
  }
  return undefined
}

/** Compare two copies of the same log; `undefined` means they agree. */
export function compareLogs(  expected: LogCopy,
  actual: LogCopy,
  opts: { readonly ignoreInherited?: boolean } = {},
): Difference | undefined {
  const session = expected.header.id
  if (headerDifference(expected.header, actual.header) !== undefined) {
    return { session, detail: headerDifference(expected.header, actual.header) as string }
  }
  // A seeded session comes back with events, not with the inherited count: the
  // count is a property of the source's history and has no wire form in a log
  // this build writes. Comparing it would fail every seeded round trip.
  if (opts.ignoreInherited !== true && expected.inheritedEventCount !== actual.inheritedEventCount) {
    return {
      session,
      detail: `inherited event count differs (${expected.inheritedEventCount} vs ${actual.inheritedEventCount})`,
    }
  }
  if (expected.events.length !== actual.events.length) {
    return { session, detail: `event count differs (${expected.events.length} vs ${actual.events.length})` }
  }
  for (const [index, event] of expected.events.entries()) {
    const other = actual.events[index]
    if (other === undefined || canonical(event) !== canonical(other)) {
      return { session, detail: `event seq ${event.seq} differs` }
    }
  }
  return undefined
}

/** Jobs this process has run, newest last, kept in memory only. */
const jobs = new Map<string, TransferJob>()

/** How many finished jobs are remembered before the oldest is dropped. */
const JOB_HISTORY = 32

function remember(job: TransferJob): void {
  jobs.set(job.id, job)
  // A long-lived DSH process imports and exports repeatedly; finished jobs are
  // history, not state, so old ones go instead of accumulating forever.
  for (const [id, known] of jobs) {
    if (jobs.size <= JOB_HISTORY) break
    if (known.status === 'running') continue
    jobs.delete(id)
  }
}

/**
 * Where one target is staged while it is being written.
 *
 * The suffix is the marker an operator looks for; a second concurrent run over
 * the same target is refused by the lease, not by a per-run name.
 */
function stagingPath(target: string, suffix: string): string {
  return `${target}.${suffix}`
}

/**
 * Start one transfer and return its job immediately.
 *
 * The job object is mutated in place as items move, so a poller sees progress
 * without subscribing: `items[].status` and the counters are the progress.
 */
export function startTransfer(
  direction: TransferDirection,
  sourceRoot: string,
  targetRoot: string,
  opts: TransferOptions,
): TransferJob {
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const job: TransferJob = {
    id: runId,
    direction,
    sourceRoot: resolve(sourceRoot),
    targetRoot: resolve(targetRoot),
    status: 'running',
    startedAt: Date.now(),
    opts,
    items: [],
    staging: '',
    partial: false,
  }
  jobs.set(runId, job)
  // Kick the work off after returning, so the caller gets the job before the
  // first await inside it resolves.
  void runJob(job).catch((error: unknown) => {
    job.status = 'failed'
    job.error = error instanceof Error ? error.message : String(error)
  }).finally(() => {
    job.finishedAt ??= Date.now()
    settle(job)
    // History is pruned when a run finishes, so a running job is never evicted.
    remember(job)
  })
  return job
}

/** Run one transfer to completion; the CLI waits for it, the console polls it. */
export async function runTransfer(
  direction: TransferDirection,
  sourceRoot: string,
  targetRoot: string,
  opts: TransferOptions,
): Promise<TransferJob> {
  const job = startTransfer(direction, sourceRoot, targetRoot, opts)
  await finished(job)
  return job
}

const waiters = new WeakMap<TransferJob, Array<() => void>>()

function finished(job: TransferJob): Promise<void> {
  if (job.status !== 'running') return Promise.resolve()
  return new Promise((resolveWait) => {
    const list = waiters.get(job) ?? []
    list.push(resolveWait)
    waiters.set(job, list)
  })
}

function settle(job: TransferJob): void {
  const list = waiters.get(job)
  if (list === undefined) return
  waiters.delete(job)
  for (const resolveWait of list) resolveWait()
}

async function runJob(job: TransferJob): Promise<void> {
  const { sourceRoot, targetRoot, opts, direction } = job
  try {
    if (direction === 'jsonl_to_sqlite') {
      await runImport(job, sourceRoot, targetRoot, opts)
    } else {
      await runExport(job, sourceRoot, targetRoot, opts)
    }
    job.status = job.items.some((item) => item.status === 'failed') ? 'partial' : 'completed'
  } catch (error) {
    // A run that dies before items exist still names the stage it died in, and a
    // damaged session must not read as "the tool is broken".
    job.status = 'failed'
    job.error = `cannot ${direction === 'jsonl_to_sqlite' ? 'list the JSONL source' : 'read the SQLite source'} `
      + `"${direction === 'jsonl_to_sqlite' ? sourceRoot : targetRoot}": `
      + (error instanceof Error ? error.message : String(error))
  }
}

async function runImport(
  job: TransferJob,
  sourceRoot: string,
  targetRoot: string,
  opts: TransferOptions,
): Promise<void> {
  const headers = await listJsonlSessions(sourceRoot)
  // A real DSH root holds sessions this build may refuse: an event type from a
  // newer contract, a hand-edited line. Listing is not copying, so the run reads
  // every session below and records a refusal as that one item's outcome — the
  // writer streams a refused log rather than dropping it.
  const unreadable = await unreadableSessions(sourceRoot, new Set(headers.map((header) => header.id)))
  const only = (id: string): boolean => opts.session === undefined || opts.session === id
  // A refused artifact refuses in two different places: before its header is even
  // known (no identity, so only its directory name can describe it) and after the
  // log is listed, where the failure belongs to that session's own item.
  const selected = headers.filter((header) => only(String(header.id)))
  const identified = new Set<string>(selected.map((header) => String(header.id)))
  job.items.push(...selected.map((header) => ({
    session: header.id,
    expected: 0,
    transferred: 0,
    nextSeq: undefined,
    status: 'pending' as const,
  })))
  for (const entry of unreadable) {
    if (identified.has(entry.id) || !only(entry.id)) continue
    job.items.push({
      session: entry.id,
      expected: 0,
      transferred: 0,
      nextSeq: undefined,
      status: 'failed',
      error: entry.problem,
    })
  }
  if (job.items.length === 0) {
    job.error = `the JSONL root "${sourceRoot}" holds no session directory; check the path and that this is a sessions root, not a project directory`
  }

  await mkdir(targetRoot, { recursive: true, mode: 0o700 })
  for (const item of job.items) {
    if (item.status === 'failed') continue
    const target = databasePath(
      targetRoot,
      selected.find((header) => header.id === item.session)?.cwd,
      item.session as SessionId,
    )
    try {
      if (existsSync(target) && !opts.force) {
        item.status = 'skipped'
        item.error = 'already present in the SQLite root'
        continue
      }
      item.status = 'transferring'
      // A log the provider refuses is still copied: the streaming read keeps every
      // event and reports the refusal with the item, so one unknown event type
      // cannot block a migration the operator asked for.
      const copy = await readJsonlSession(sourceRoot, item.session)
      if (copy === undefined) {
        item.status = 'skipped'
        item.error = 'missing from the JSONL root'
        continue
      }
      setCounts(item, copy)
      // A copy that is not the provider's verbatim read is reported even when it
      // verifies: "verified" would otherwise cover a vocabulary the other build
      // cannot reload, or a prefix that stopped at a damaged line.
      if (copy.problem !== undefined) item.error = copy.problem
      const staged = stagingPath(target, 'importing')
      job.staging = staged
      job.partial ||= existsSync(staged)
      await removeDatabase(staged)
      await writeSqliteSession(staged, copy)
      item.transferred = copy.events.length
      if (opts.verify) {
        item.status = 'verifying'
        const readBack = await readSqliteCopy(staged, 'strict', opts)
        const difference = readBack.header.id === item.session
          ? compareLogs(copy, readBack)
          : { session: item.session, detail: `staged copy stores "${readBack.header.id}"` }
        if (difference !== undefined) {
          await removeDatabase(staged)
          item.status = 'failed'
          item.error = `staged copy does not match the source: ${difference.detail}`
          continue
        }
      }
      if (opts.digest) item.digest = digestOf(copy.events)
      await publishDatabase(staged, target)
      item.status = 'verified'
      item.outputPath = target
    } catch (error) {
      item.status = 'failed'
      item.error = error instanceof Error ? error.message : String(error)
    }
  }
}

async function runExport(
  job: TransferJob,
  sourceRoot: string,
  targetRoot: string,
  opts: TransferOptions,
): Promise<void> {
  // A root that already holds sessions dictates the encoding; an empty target is
  // plain JSONL, which is what the official backend writes by default.
  const encoding: 'jsonl' | 'jsonl.zstd' =
    await detectCompression(targetRoot) === 'zstd' ? 'jsonl.zstd' : 'jsonl'
  const entries = await scanSessions(sourceRoot)
  const targets = await Promise.all(entries.map(async (entry) => {
    try {
      // Salvage, not strict: a store whose tail is torn still holds a readable
      // prefix, and exporting that prefix is better than refusing the session.
      const copy = await readSqliteCopy(entry.path, 'salvage', opts)
      return { entry, copy }
    } catch (error) {
      return { entry, error: error instanceof Error ? error.message : String(error) }
    }
  }))
  const usable = targets.filter(
    (value): value is { entry: typeof entries[number]; copy: SqliteCopy } => 'copy' in value,
  )
  const selected = opts.session === undefined
    ? usable
    : usable.filter((value) => value.copy.header.id === opts.session)
  job.items.push(...selected.map(({ copy }) => ({
    session: copy.header.id,
    expected: copy.events.length,
    transferred: 0,
    nextSeq: undefined,
    status: 'pending' as const,
  })))
  for (const value of targets) {
    if ('error' in value) {
      job.items.push({
        session: value.entry.directory,
        expected: 0,
        transferred: 0,
        nextSeq: undefined,
        status: 'failed',
        error: `cannot read "${value.entry.path}": ${value.error}`,
      })
    }
  }

  await mkdir(targetRoot, { recursive: true, mode: 0o700 })
  for (const item of job.items) {
    if (item.status === 'failed') continue
    const chosen = selected.find((value) => value.copy.header.id === item.session)
    if (chosen === undefined) continue
    const { copy } = chosen
    const target = sessionDir(targetRoot, copy.header.cwd, copy.header.id)
    try {
      if (copy.state !== 'ready') {
        item.status = 'failed'
        item.error = `"${copy.path}" holds an unfinished import; rerun the import to replace it`
        continue
      }
      if (existsSync(target) && !opts.force) {
        item.status = 'skipped'
        item.error = 'already present in the JSONL root'
        continue
      }
      item.status = 'transferring'
      // The official writer decides the directory shape, so stage a whole root
      // and move only the session directory it produced.
      const staging = stagingPath(target, 'exporting')
      job.staging = staging
      job.partial ||= existsSync(staging)
      await rm(staging, { recursive: true, force: true })
      // An export writes the same physical encoding it is reading: a compressed
      // root (§ the default `dshHomePath('sessions')`) gets `.jsonl.zstd` back, a
      // plain root stays plain. Passing the suffix instead of probing keeps a
      // half-written staging directory from answering the wrong way.
      const staged = await mountJsonl(staging, encoding)
      // A store written by `import` keeps the physical `type: 'session'` tag the
      // source line carried; the writer's header schema has no such field, so the
      // tag is dropped on the way out instead of being written back.
      const header = headerOf(copy.header)
      const handle = copy.header.isSeeded
        ? await staged.persistence.create(header, { inheritedEventCount: copy.inheritedEventCount as SessionLogOffset })
        : await staged.persistence.create(header)
      try {
        if (copy.events.length > 0) await handle.append(copy.events as SessionEvent[])
        await handle.flush()
      } finally {
        await handle.close()
      }
      item.transferred = copy.events.length
      // A published copy of a repaired prefix is not the same log as the source:
      // say so, otherwise "verified" would cover a silent truncation.
      if (copy.torn) {
        item.error = `source log was torn; exported the readable prefix (${copy.events.length} events)`
      }
      if (opts.verify) {
        item.status = 'verifying'
        const readBack = await readJsonlSession(staging, copy.header.id)
        // The writer decides what the header line says, so the comparison is made
        // against the normalized header the writer was given — otherwise a store
        // that still holds a Windows cwd would differ from its own correct export.
        const expected: LogCopy = { ...copy, header }
        const difference = readBack === undefined
          ? { session: copy.header.id, detail: 'staged copy is unreadable' }
          : compareLogs(expected, readBack, { ignoreInherited: copy.header.isSeeded })
        if (difference !== undefined) {
          await rm(staging, { recursive: true, force: true })
          item.status = 'failed'
          item.error = `staged copy does not match the source: ${difference.detail}`
          continue
        }
      }
      if (opts.digest) item.digest = digestOf(copy.events)
      // Both encodings keep one directory per session, so the publishable unit is
      // the session directory the writer produced — moving the log file alone
      // would leave the directory behind, and the provider reads directories.
      const stagedArtifact = await mountedArtifact(staging, header.id)
        ?? await findJsonlArtifact(staging, header.id)
      const stagedPath = typeof stagedArtifact === 'string' ? stagedArtifact : stagedArtifact?.path
      if (stagedPath === undefined) {
        throw new Error(`the writer produced no artifact for "${header.id}" under "${staging}"`)
      }
      // Replace by renaming the old directory aside first, then the new one in.
      // Deleting the target and then renaming is a window where a crash leaves
      // the conversation with no log at all — the old copy is already gone and
      // the staged one is still under the staging name.
      const retired = `${target}.replaced`
      await rm(retired, { recursive: true, force: true })
      if (existsSync(target)) await rename(target, retired)
      await ensureSessionDirectory(dirname(target))
      try {
        await rename(dirname(stagedPath), target)
      } catch (error) {
        await rename(retired, target).catch(() => undefined)
        throw error
      }
      await rm(retired, { recursive: true, force: true })
      await rm(staging, { recursive: true, force: true })
      // The staging root is gone, so its mount must not outlive it: a later run
      // would otherwise reuse a provider whose root no longer exists.
      await releaseJsonlMount(staging)
      item.status = 'verified'
      item.outputPath = target
    } catch (error) {
      item.status = 'failed'
      item.error = error instanceof Error ? error.message : String(error)
    }
  }
  // The mount over the staging root is dropped with the process; the target root
  // keeps its own mount for later runs.
}

function setCounts(item: TransferItem, copy: LogCopy): void {
  item.expected = copy.events.length + copy.inheritedEventCount
  item.nextSeq = copy.events.length === 0
    ? copy.inheritedEventCount
    : (copy.events.at(-1)?.seq ?? -1) + 1
}

/** A short, stable digest of a log's events. */
function digestOf(events: readonly SessionEvent[]): string {
  let hash = 0x811c9dc5
  for (const event of events) {
    const text = canonical(event)
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
  }
  return hash.toString(16).padStart(8, '0')
}

/** Size of one path in bytes, `0` when it is gone. */
export async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}
