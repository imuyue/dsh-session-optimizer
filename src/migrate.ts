/**
 * Migration between the two backends, in the two modes the console offers.
 *
 * Both modes move one session's *whole* history and prove the copy before
 * anything becomes visible:
 *
 * 1. read the source with its own reader (the official provider first, streaming
 *    salvage only when the provider refuses the log — and the refusal is
 *    reported either way, so a copy is never silently poorer than its source);
 * 2. write a staged copy under `<targetRoot>.migrating`, mirroring the target's
 *    layout so the read-back below is the same code path a normal open uses;
 * 3. read the staged copy back and compare header, inherited count and every
 *    event;
 * 4. publish with a write lease held, so a live writer cannot keep appending
 *    into an inode the rename just unlinked;
 * 5. only then move the route in the catalog.
 *
 * The modes differ in identity and naming of the new conversation.
 *
 * - **overwrite** keeps `session_id`, so the conversation is the same conversation
 *   and the session list does not grow an entry; it simply starts being read from
 *   the other backend. The old log is then moved aside under
 *   `<sourceRoot>.replaced/<migrationId>/` by {@link archiveSource}, because two
 *   live logs holding one id stay two logs forever — including for a rebuilt
 *   catalog, which cannot tell which one is authoritative.
 * - **clone** assigns a new `session_id` and records where it came from
 *   (`originSessionId`, `migrationId`, `sourceBackend`, `targetBackend`,
 *   `clonedAt`). Both conversations stay live afterwards: the session list shows
 *   two entries, and the clone opens and resumes like any other.
 *
 * Clone is deliberately *not* DSH's own fork: fork copies a prefix and adds
 * inherited-seed markers plus synthesized fork events. Cloning keeps the
 * transcript content. Typed references inside its owned subagent tree are
 * re-keyed together, and its new `副本-<source title>` title is appended.
 *
 * @module dsh-session-optimizer/migrate
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { link, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { SessionBackendCatalog, type SessionBackendId } from './catalog.ts'
import { releaseStore } from './store-lease.ts'
import { SessionDatabase, ensureSessionDirectory, type LoadedHeader } from './database.ts'
import { DATABASE_FILENAME, databasePath, decodeSegment, encodeSegment, sessionDir } from './format.ts'
import { storedTitle } from './inspect.ts'
import { planCloneTree, remapClone, assertTreeSnapshot, type CloneTree, type CloneNode } from './clone-tree.ts'
import { groupedSessions } from './session-groups.ts'
import { pickerInventory, pickerPage, forgetPickerInventory } from './source-picker.ts'
import { SessionWriteLease } from './lease.ts'
import { overlappingDirectories, sameDirectory } from './path-identity.ts'
import { scanSessions } from './storage.ts'
import {
  READ_SETTINGS,
  compareLogs,
  detectCompression,
  findJsonlArtifact,
  headerOf,
  inspectJsonlSessions,
  listJsonlSessionDirs,
  mountJsonl,
  publishDatabase,
  publishNewDatabase,
  readJsonlSession,
  readSqliteHeader,
  readSqliteSessionById,
  removeDatabase,
  scanSqliteSessions,
  storableHeader,
  writeSqliteSession,
  type JsonlCompression,
  type LogCopy,
} from './transfer.ts'

/** Which identity the copy takes. */
export type MigrationMode = 'overwrite' | 'clone'

/**
 * Just where a backend lives, without a mounted provider.
 *
 * Listing a root only walks directories and reads artifacts, so the picker can
 * offer a root this profile does not mount — a different profile's library is
 * exactly what an operator wants to migrate. Requiring a mounted provider here
 * would have forced a second live writer onto a root just to read its file names.
 */
export interface SourceLocator {
  readonly id: SessionBackendId
  readonly root: string
}

/**
 * One backend a migration can read from or write to.
 *
 * `persistence` is optional: reading a root goes through the directory-walking
 * reader (`sourceSessions`), which works on a root no provider is mounted on, so
 * a run can move a library belonging to a different profile.
 */
export interface MigrationBackend extends SourceLocator {
  readonly persistence?: SessionPersistence | undefined
  /** Encoding required by a mounted JSONL provider, including an empty root. */
  readonly compression?: JsonlCompression | undefined
}

export interface MigrationOptions {
  readonly mode: MigrationMode
  /** Restrict the run to one session id. */
  readonly session?: string | undefined
  /** Restrict the run to these session ids; an empty list means every session. */
  readonly sessions?: readonly string[] | undefined
  /** Read the staged copy back and compare it before publishing. */
  readonly verify: boolean
  /** For `clone`: the id to assign, when a caller needs it to be reproducible. */
  readonly newSessionId?: string | undefined
}

export const DEFAULT_MIGRATION_OPTIONS: MigrationOptions = {
  mode: 'overwrite',
  verify: true,
}

export type MigrationItemStatus = 'pending' | 'migrating' | 'verifying' | 'migrated' | 'failed' | 'skipped'

/** The outcome for one session, described as a conversation rather than a file. */
export interface MigrationItem {
  /** Conversation the events came from. */
  readonly sourceSession: string
  /** Conversation the events now live under; differs from the source on a clone. */
  readonly targetSession: string
  status: MigrationItemStatus
  /** Title the conversation carries, which is what the session list shows. */
  title?: string
  /** Project directory the conversation is grouped under in the session list. */
  cwd?: string
  /** Events the source held. */
  expected: number
  /** Events written to the copy. */
  transferred: number
  /** Where an overwrite parked the superseded source log, when it did. */
  archivedTo?: string
  error?: string
}

/** One run, as the CLI and the console both report it. */
export interface MigrationReport {
  readonly migrationId: string
  readonly mode: MigrationMode
  readonly sourceBackend: SessionBackendId
  readonly targetBackend: SessionBackendId
  readonly sourceRoot: string
  readonly targetRoot: string
  readonly startedAt: number
  finishedAt?: number
  status: 'running' | 'completed' | 'partial' | 'failed'
  readonly items: MigrationItem[]
  error?: string
}

/** A migration that cannot start, described in operator language. */
export class MigrationError extends Error {
  override readonly name = 'MigrationError'
}

/** What a console or CLI needs to start a migration without knowing the router. */
export interface MigrationHost {
  readonly catalog: SessionBackendCatalog
  readonly sqlite: MigrationBackend
  readonly jsonl: MigrationBackend
  readonly prepareSession?: (id: string, notice?: (message?: string) => void) => Promise<void>
  /** Called after a clone's files and route are committed, only for the mounted pair. */
  readonly attachClone?: (sourceId: string, targetId: string) => Promise<void>
}

/** A run in flight, as the console polls it. */
export interface MigrationJob {
  readonly id: string
  readonly direction: 'jsonl_to_sqlite' | 'sqlite_to_jsonl'
  readonly mode: MigrationMode
  readonly sourceRoot: string
  readonly targetRoot: string
  status: 'running' | 'completed' | 'partial' | 'failed'
  readonly startedAt: number
  finishedAt?: number
  /** The report as it fills in; the items list grows while the run proceeds. */
  report?: MigrationReport
  error?: string
  notice?: string
}

/**
 * Runs this process started, newest last.
 *
 * A run in flight lives only in memory — its report is being written and a
 * second copy on disk could only disagree with it. What is written down is the
 * *history*: enough for the console to still show yesterday's run after a
 * restart, and to say plainly that a run which was in flight did not finish.
 * The file is a record, never an input to anything the engine decides.
 */
const migrationJobs = new Map<string, MigrationJob>()
const MIGRATION_HISTORY = 32
/** Where the history lives, set by {@link attachMigrationJournal}. */
let journalPath: string | undefined
let journalTimer: NodeJS.Timeout | undefined
let journalWrites: Promise<void> = Promise.resolve()
let journalEpoch = 0
/** Items kept per stored job; a run over hundreds of sessions must not grow the file. */
const JOURNAL_ITEMS = 200

const MIGRATION_JOURNAL_FILENAME = 'migrations.json'
const MIGRATION_JOURNAL_VERSION = 1

interface MigrationJournalDocument {
  readonly version: number
  readonly jobs: readonly MigrationJob[]
}

/**
 * Point the history at a file and load what is already there.
 *
 * A job that was still `running` when its process died is reported as failed
 * with a reason, because that is what an operator needs to know: the copy may
 * be half done, and the next run has to be started again.
 */
export async function attachMigrationJournal(directory: string): Promise<void> {
  journalEpoch++
  journalPath = join(directory, MIGRATION_JOURNAL_FILENAME)
  let text: string
  try {
    text = await readFile(journalPath, 'utf8')
  } catch {
    // No history yet, or one that cannot be read: an empty history is the only
    // honest answer, and the next run overwrites the file anyway.
    return
  }
  let document: MigrationJournalDocument
  try {
    document = JSON.parse(text) as MigrationJournalDocument
  } catch {
    return
  }
  if (document === null || typeof document !== 'object' || document.version !== MIGRATION_JOURNAL_VERSION) return
  if (!Array.isArray(document.jobs)) return
  for (const stored of document.jobs) {
    if (stored === null || typeof stored !== 'object' || typeof stored.id !== 'string') continue
    const job: MigrationJob = {
      ...stored,
      status: stored.status === 'running' ? 'failed' : stored.status,
      error: stored.status === 'running'
        ? 'the process stopped before this migration finished; start it again'
        : stored.error,
      finishedAt: stored.finishedAt ?? (stored.status === 'running' ? stored.startedAt : undefined),
    }
    rememberMigration(job)
  }
}

/** Write the history soon, coalescing bursts of changes into one write. */
function scheduleJournalSave(): void {
  if (journalPath === undefined || journalTimer !== undefined) return
  journalTimer = setTimeout(() => {
    journalTimer = undefined
    void saveJournal()
  }, 250)
  journalTimer.unref?.()
}

async function saveJournal(strict = false, clearing?: ReadonlyMap<string, MigrationJob>): Promise<number> {
  const path = journalPath, epoch = journalEpoch
  const commitClear = (): number => {
    let count = 0
    for (const [id, job] of clearing ?? []) if (migrationJobs.get(id) === job && job.status !== 'running') { migrationJobs.delete(id); count++ }
    return count
  }
  if (path === undefined) return commitClear()
  let cleared = 0
  const writing = journalWrites.catch(() => undefined).then(async () => {
    if (journalEpoch !== epoch) {
      if (strict) throw new Error('migration history changed while saving')
      return
    }
    const jobs = [...migrationJobs.values()].filter(job => clearing?.get(job.id) !== job).map(job => ({ ...job, report: job.report === undefined ? undefined : { ...job.report, items: job.report.items.slice(-JOURNAL_ITEMS) } }))
    const document: MigrationJournalDocument = { version: MIGRATION_JOURNAL_VERSION, jobs }
    const staging = `${path}.${String(process.pid)}.${randomUUID()}.tmp`
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(staging, `${JSON.stringify(document)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(staging, path)
      if (clearing !== undefined) {
        if (journalEpoch !== epoch) throw new Error('migration history changed while clearing')
        cleared = commitClear()
      }
    } catch (error) { await unlink(staging).catch(() => undefined); throw error }
  })
  journalWrites = writing
  try { await writing } catch (error) { if (strict) throw error }
  return cleared
}

/** Clear finished history only; running/waiting work and session files are untouched. */
export async function clearMigrationHistory(): Promise<{ cleared: number; retainedRunning: number }> {
  const finished = new Map([...migrationJobs].filter(([, job]) => job.status !== 'running'))
  if (journalTimer !== undefined) { clearTimeout(journalTimer); journalTimer = undefined }
  const cleared = await saveJournal(true, finished)
  return { cleared, retainedRunning: [...migrationJobs.values()].filter(job => job.status === 'running').length }
}

/** Forget the loaded history and stop writing to it (tests, and profile switches). */
export async function detachMigrationJournal(): Promise<void> {
  if (journalTimer !== undefined) {
    clearTimeout(journalTimer)
    journalTimer = undefined
  }
  journalEpoch++
  journalPath = undefined
  await journalWrites.catch(() => undefined)
  migrationJobs.clear()
}

function rememberMigration(job: MigrationJob): void {
  migrationJobs.set(job.id, job)
  if (migrationJobs.size > MIGRATION_HISTORY) {
    for (const [id, candidate] of migrationJobs) {
      if (migrationJobs.size <= MIGRATION_HISTORY) break
      if (candidate.status === 'running') continue
      migrationJobs.delete(id)
    }
  }
  scheduleJournalSave()
}

/** Runs the console may show, oldest first. */
export function listMigrations(): readonly MigrationJob[] {
  return [...migrationJobs.values()]
}

export function migrationById(id: string): MigrationJob | undefined {
  return migrationJobs.get(id)
}

/**
 * Start a migration in the background and return the job immediately.
 *
 * The caller gets an id before the first `await` inside the engine resolves, so
 * the console can poll progress instead of holding a request open for a run that
 * may touch a hundred sessions.
 *
 * `ends` overrides the pair derived from the host: the picker may point at a
 * library this profile does not mount, and then the roots come from what the
 * operator selected rather than from the mounted backends.
 */
export function startMigration(
  host: MigrationHost,
  direction: 'jsonl_to_sqlite' | 'sqlite_to_jsonl',
  options: MigrationOptions = DEFAULT_MIGRATION_OPTIONS,
  ends?: { readonly source: MigrationBackend; readonly target: MigrationBackend } | undefined,
): MigrationJob {
  const source = ends?.source ?? (direction === 'jsonl_to_sqlite' ? host.jsonl : host.sqlite)
  const target = ends?.target ?? (direction === 'jsonl_to_sqlite' ? host.sqlite : host.jsonl)
  const job: MigrationJob = {
    id: `mig-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    direction,
    mode: options.mode,
    sourceRoot: source.root,
    targetRoot: target.root,
    status: 'running',
    startedAt: Date.now(),
  }
  const historyEpoch = journalEpoch
  rememberMigration(job)
  let mounted: Promise<boolean> | undefined
  const prepare = host.prepareSession === undefined ? undefined : async (id: string) => {
    mounted ??= (async () => await sameDirectory(source.root, host[source.id].root)
      || (options.mode === 'overwrite' && await sameDirectory(target.root, host[target.id].root)))()
    if (await mounted) await host.prepareSession!(id, message => { job.notice = message })
  }
  let cloneMounted: Promise<boolean> | undefined
  const attachClone = host.attachClone === undefined ? undefined : async (sourceId: string, targetId: string) => {
    cloneMounted ??= (async () => await sameDirectory(source.root, host[source.id].root)
      && await sameDirectory(target.root, host[target.id].root))()
    if (await cloneMounted) await host.attachClone!(sourceId, targetId)
  }
  const run = async () => {
    const mountedTarget = host[target.id]
    const effectiveTarget = target.id === 'jsonl' && mountedTarget.compression !== undefined
      && await sameDirectory(target.root, mountedTarget.root)
      ? { ...target, compression: mountedTarget.compression } : target
    return runMigration(host.catalog, source, effectiveTarget, options, prepare, attachClone)
  }
  void run()
    .then((report) => {
      job.report = report
      job.status = report.status === 'running' ? 'completed' : report.status
      job.error = report.error
    })
    .catch((error: unknown) => {
      job.status = 'failed'
      job.error = error instanceof Error ? error.message : String(error)
    })
    .finally(() => {
      job.finishedAt ??= Date.now()
      // Persist only while this history still owns the exact job. Completion may
      // arrive after teardown or a different journal has attached.
      if (journalEpoch === historyEpoch && migrationJobs.get(job.id) === job) rememberMigration(job)
    })
  return job
}

function headerForClone(header: SessionHeader, id: SessionId): SessionHeader {
  // Fork ancestry is retained; owned subagent parent links were prepared by the tree plan.
  return { ...header, id }
}

function titleInLog(copy: LogCopy): string | undefined {
  for (let index = copy.events.length - 1; index >= 0; index--) {
    const event = copy.events[index]!
    if (String(event.type) !== 'session/title') continue
    const data: unknown = event.data
    if (data !== null && typeof data === 'object' && 'title' in data && typeof data.title === 'string' && data.title !== '') return data.title
  }
  return undefined
}
function logForClone(copy: LogCopy, header: SessionHeader, id: SessionId): { log: LogCopy; title: string } {
  let sourceTitle = titleInLog(copy)
  if (sourceTitle === undefined && copy.header.origin === 'subagent') for (let index = copy.events.length - 1; index >= copy.inheritedEventCount; index--) {
    const event = copy.events[index]!, data = event.data as unknown as { label?: unknown }
    if (String(event.type) === 'subagent/descriptor' && typeof data?.label === 'string' && data.label !== '') { sourceTitle = data.label; break }
  }
  const title = `副本-${sourceTitle ?? '未命名'}`
  const seq = copy.events.length === 0 ? copy.inheritedEventCount : Number(copy.events.at(-1)!.seq) + 1
  if (!Number.isSafeInteger(seq) || seq < 0) throw new MigrationError('clone title has no valid next event sequence')
  // session/title is a stored extension event; the published SessionEvent union
  // does not describe it. The same readers and staged verification validate it.
  const renamed = { type: 'session/title', seq, time: Date.now(), data: { title, messageSeqs: [], source: { kind: 'user' } } } as unknown as SessionEvent
  return { title, log: { ...copy, header: headerForClone(header, id), events: [...copy.events, renamed] } }
}

/**
 * Where one session's log belongs under a JSONL root.
 *
 * Both encodings keep one directory per session, `<project>/<id>/`, holding the
 * log file named by the encoding (`session.v4.jsonl.zstd` or `session.v4.jsonl`).
 * The provider reads by scanning that directory, and refuses the older flat
 * layout outright, so the directory — not the file — is the publishable unit.
 */
export function jsonlLogPath(root: string, cwd: string | undefined, id: string): string {
  return sessionDir(root, cwd, id as SessionId)
}

/** Where one session's log belongs under a SQLite root. */
export function sqliteLogPath(root: string, cwd: string | undefined, id: string): string {
  return databasePath(root, cwd, id as SessionId)
}

/** Where a copy will land, for a caller that wants to show it before running. */
export function plannedTargetPath(
  target: MigrationBackend,
  id: string,
  cwd: string | undefined,
): string {
  return target.id === 'sqlite'
    ? sqliteLogPath(target.root, cwd, id)
    : jsonlLogPath(target.root, cwd, id)
}

/** Read one session out of a backend, reporting a refused log rather than losing it. */
async function readSource(backend: MigrationBackend, id: string): Promise<LogCopy | undefined> {
  if (backend.id === 'jsonl') return await readJsonlSession(backend.root, id)
  return await readSqliteSessionById(backend.root, id, {
    force: false,
    verify: false,
    digest: false,
    readOnlySources: true,
  })
}

/**
 * Write a copy into the staging root, in the layout the target will use.
 *
 * Returns the unit the publish step renames: the database file for SQLite, the
 * session directory for JSONL. Publishing a JSONL log's file instead of its
 * directory leaves the directory behind, and the provider reads directories.
 */
async function stageCopy(
  target: MigrationBackend,
  stagingRoot: string,
  copy: LogCopy,
  encoding: JsonlCompression,
): Promise<string> {
  if (target.id === 'sqlite') {
    const staged = sqliteLogPath(stagingRoot, copy.header.cwd, String(copy.header.id))
    await writeSqliteSession(staged, copy)
    return staged
  }
  // The writer decides the file it produces, so the copy is made through the
  // provider and then found on disk — never assembled by hand.
  const mount = await mountJsonl(stagingRoot, encoding === 'zstd' ? 'jsonl.zstd' : 'jsonl')
  const header = headerOf(copy.header)
  const handle = header.isSeeded
    ? await mount.persistence.create(header, { inheritedEventCount: copy.inheritedEventCount as never })
    : await mount.persistence.create(header)
  try {
    if (copy.events.length > 0) await handle.append(copy.events as SessionEvent[])
    await handle.flush()
  } finally {
    await handle.close()
  }
  const produced = await findJsonlArtifact(stagingRoot, String(header.id))
  if (produced === undefined) {
    throw new MigrationError(
      `the JSONL writer produced no artifact for "${String(header.id)}" under "${stagingRoot}"`,
    )
  }
  return dirname(produced.path)
}

/** Read a staged copy back with the target's own reader; `undefined` when it agrees. */
async function verifyStaged(
  target: MigrationBackend,
  stagingRoot: string,
  expected: LogCopy,
): Promise<string | undefined> {
  if (target.id === 'sqlite') {
    const staged = sqliteLogPath(stagingRoot, expected.header.cwd, String(expected.header.id))
    const db = SessionDatabase.open(staged, { ...READ_SETTINGS, readOnly: true })
    try {
      const loaded = db.loadSession()
      if (loaded === undefined) return 'staged copy holds no session row'
      if (loaded.state !== 'ready') return 'staged copy is not marked ready'
      const difference = compareLogs(
        expected,
        { header: loaded.header, inheritedEventCount: loaded.inheritedEventCount, events: loaded.events },
        { ignoreInherited: expected.header.isSeeded },
      )
      return difference?.detail
    } finally {
      db.close()
    }
  }
  const readBack = await readJsonlSession(stagingRoot, String(expected.header.id))
  if (readBack === undefined) return 'staged copy is unreadable'
  return compareLogs(expected, readBack, { ignoreInherited: expected.header.isSeeded })?.detail
}

/**
 * Put a staged copy in place, keeping whatever occupied the target until it is.
 *
 * This is the only step that changes what a reader sees, so it is the only step
 * that has to be reversible: the previous occupant is moved aside and moved back
 * if the publish fails.
 */
async function publishPath(staged: string, target: string): Promise<void> {
  await ensureSessionDirectory(target)
  const previous = `${target}.replaced-${randomUUID()}`
  await mkdir(previous, { mode: 0o700 })
  const archived: string[] = [], published: string[] = []
  try {
    for (const name of await readdir(target)) {
      if (name === 'session.lock') continue
      await rename(join(target, name), join(previous, name)); archived.push(name)
    }
    for (const name of await readdir(staged)) {
      if (name === 'session.lock') continue
      await rename(join(staged, name), join(target, name)); published.push(name)
    }
  } catch (error) {
    try {
      for (const name of published.reverse()) await rename(join(target, name), join(staged, name))
      for (const name of archived.reverse()) await rename(join(previous, name), join(target, name))
    } catch (restoreError) { throw new AggregateError([error, restoreError], `publish of "${target}" failed; previous data remains in "${previous}"`) }
    await rm(previous, { recursive: true, force: true })
    throw error
  }
  await rm(previous, { recursive: true, force: true })
}

/** Check the whole root under the publication lease, without a listing cache. */
async function assertCloneAbsent(target: MigrationBackend, id: string, catalog: SessionBackendCatalog): Promise<void> {
  const collision = (): never => { throw new MigrationError(`clone target "${id}" already exists in "${target.root}"`) }
  if (catalog.get(id) !== undefined) collision()
  if (target.id === 'jsonl') {
    for (const entry of await listJsonlSessionDirs(target.root)) {
      if (decodeSegment(entry.directory) === id && await findJsonlArtifact(target.root, id) !== undefined) collision()
    }
  } else {
    for (const entry of await scanSqliteSessions(target.root)) {
      if (decodeSegment(entry.directory) === id) collision()
    }
  }
}

/** One session a migration run could pick up, as a picker shows it. */
export interface SourceSession {
  readonly origin?: 'subagent'
  readonly parentSession?: string
  readonly id: string
  readonly title: string | undefined
  readonly eventCount: number
  readonly sizeBytes: number
  readonly createdAt: number | undefined
  readonly path: string
  /**
   * The working directory the log records, when it has one.
   *
   * Carried because the Host drops a conversation without a `cwd` from the
   * session list: a log whose header lost it is on disk but unreachable in the
   * sidebar, and the picker should say so rather than migrate it into another
   * invisible copy.
   */
  readonly cwd: string | undefined
  /** Set when the source reader would have to salvage, or cannot read at all. */
  readonly problem: string | undefined
  /**
   * Whether the *target* backend already stores this conversation.
   *
   * A picker that does not say so invites a second copy of a conversation that
   * was converted an hour ago, which reads as "the first conversion did not
   * happen". Present only when the caller named the other root.
   */
  readonly inTarget?: boolean
  /** Metadata-only picker row: exact count and full integrity are checked at conversion. */
  readonly detailsPending?: boolean
  readonly titlePending?: boolean
  readonly childCount?: number
}

/**
 * List what a backend holds *without* trusting its own `list()`.
 *
 * The official JSONL provider answers `list()` with the sessions whose header it
 * can decode and silently omits the rest — a root full of logs it refuses reads
 * as an empty root, which is exactly how a migration reports `0/0` on a library
 * that is not empty. Discovery therefore walks the directories and scans each
 * artifact, and the picker sees every log, including the ones that will need
 * salvage.
 */
export async function sourceSessions(backend: SourceLocator, onlyIds?: ReadonlySet<string>): Promise<readonly SourceSession[]> {
  if (backend.id === 'jsonl') {
    const listed = await inspectJsonlSessions(backend.root, onlyIds)
    return listed.map((entry) => ({
      id: entry.id,
      ...(entry.origin === 'subagent' ? { origin: 'subagent' as const, ...(entry.parentSession === undefined ? {} : { parentSession: entry.parentSession }) } : {}),
      title: entry.title,
      eventCount: entry.eventCount,
      sizeBytes: entry.sizeBytes,
      createdAt: entry.createdAt,
      path: entry.path,
      cwd: entry.cwd,
      problem: entry.problem,
    }))
  }
  const found: SourceSession[] = []
  for (const entry of await scanSqliteSessions(backend.root)) {
    let header: LoadedHeader
    try {
      header = await readSqliteHeader(entry.path)
    } catch {
      // A store that cannot even give its header still occupies a directory;
      // naming it by directory keeps it visible instead of dropping the row.
      found.push({
        id: entry.directory,
        title: undefined,
        eventCount: 0,
        sizeBytes: 0,
        createdAt: undefined,
        path: entry.path,
        cwd: undefined,
        problem: 'the store has no readable session header',
      })
      continue
    }
    const id = String(header.header.id)
    found.push({
      id,
      ...(header.header.origin === 'subagent' ? { origin: 'subagent' as const, ...(header.header.parentSession === undefined ? {} : { parentSession: String(header.header.parentSession) }) } : {}),
      title: storedTitle(entry.path),
      eventCount: header.eventCount,
      sizeBytes: await sizeOf(entry.path),
      createdAt: header.header.createdAt,
      path: entry.path,
      cwd: header.header.cwd,
      problem: header.state === 'ready'
        ? header.header.cwd === undefined
          ? 'the header has no working directory, so the session list cannot show it'
          : undefined
        : 'the store holds an unfinished import',
    })
  }
  return found
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/**
 * What one backend root holds, cached briefly.
 *
 * Listing a JSONL root has to stream every artifact — titles and counts live
 * inside the log — which is seconds of work on a large library. A picker redraws
 * far more often than a library changes, so the answer is kept for a few seconds;
 * a caller that just wrote a log asks for `refresh`.
 */
interface CachedListing {
  readonly at: number
  readonly encoding: JsonlCompression
  readonly sessions: readonly SourceSession[]
}

const LISTING_TTL_MS = 10_000
const listings = new Map<string, CachedListing>()
const listingScans = new Map<string, Promise<CachedListing>>()
let listingGeneration = 0

async function cachedSourceListing(backend: SourceLocator, refresh = false): Promise<CachedListing> {
  const key = `${backend.id}\u0000${backend.root}`
  const pending = listingScans.get(key)
  if (pending !== undefined) return pending
  const cached = listings.get(key)
  if (!refresh && cached !== undefined && Date.now() - cached.at < LISTING_TTL_MS) return cached
  const generation = listingGeneration
  const scan = (async (): Promise<CachedListing> => {
    const sessions = await sourceSessions(backend)
    const entry = {
      at: Date.now(),
      encoding: backend.id === 'jsonl' ? await detectCompression(backend.root) : 'none' as const,
      sessions: [...sessions].sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0) || left.id.localeCompare(right.id)),
    }
    if (generation === listingGeneration) listings.set(key, entry)
    return entry
  })()
  listingScans.set(key, scan)
  try { return await scan } finally { if (listingScans.get(key) === scan) listingScans.delete(key) }
}

/** Complete cached inventory, shared with the paged conversion picker. Read-only. */
export async function sourceInventory(backend: SourceLocator, signal?: AbortSignal): Promise<readonly SourceSession[]> {
  if (backend.id === 'jsonl') return pickerInventory(backend.root, false, signal)
  return (await cachedSourceListing(backend)).sessions
}

/** Ids one backend holds, cached on the same schedule as the listings. */
interface CachedIds {
  readonly at: number
  readonly ids: ReadonlySet<string>
}

const knownIds = new Map<string, CachedIds>()

/**
 * Which conversations a root holds, without reading their events.
 *
 * A JSONL directory is named after the escaped id, so the id is in the name; a
 * SQLite store keeps its id in the header, which is a page read.
 */
async function heldIds(locator: SourceLocator): Promise<ReadonlySet<string>> {
  const key = `${locator.id}\u0000${locator.root}`
  const cached = knownIds.get(key)
  if (cached !== undefined && Date.now() - cached.at < LISTING_TTL_MS) return cached.ids
  const ids = new Set<string>()
  if (locator.id === 'jsonl') {
    for (const dir of await listJsonlSessionDirs(locator.root)) {
      const id = decodeSegment(dir.directory)
      if (id !== undefined) ids.add(id)
    }
  } else {
    for (const entry of await scanSqliteSessions(locator.root)) {
      let id: string | undefined
      try {
        id = String((await readSqliteHeader(entry.path)).header.id)
      } catch {
        id = decodeSegment(entry.directory)
      }
      if (id !== undefined) ids.add(id)
    }
  }
  knownIds.set(key, { at: Date.now(), ids })
  return ids
}

/**
 * Held ids, widened through the conversions the catalog recorded.
 *
 * A clone is a new conversation, so its id never matches the one it came from.
 * Without this the source of a copy still looks untouched — the operator converts
 * it again and gets a second copy — and a copy whose original is already on the
 * other side looks unconverted. Both directions are the same question asked from
 * one end, so both ends are closed here; chains are followed because a copy can
 * itself be converted onward.
 */
function idsWithOrigins(ids: ReadonlySet<string>, catalog: SessionBackendCatalog | undefined): ReadonlySet<string> {
  if (catalog === undefined) return ids
  const pairs: Array<readonly [string, string]> = []
  for (const [id, entry] of catalog.list()) {
    if (entry.originSessionId !== undefined) pairs.push([id, entry.originSessionId])
  }
  const widened = new Set(ids)
  for (let round = 0; round < 8; round += 1) {
    const before = widened.size
    for (const [copy, origin] of pairs) {
      if (widened.has(copy)) widened.add(origin)
      else if (widened.has(origin)) widened.add(copy)
    }
    if (widened.size === before) break
  }
  return widened
}

/** One page of a root, as the migration picker asks for it. */
export interface SourceListing {
  readonly backend: SessionBackendId
  readonly root: string
  readonly encoding: JsonlCompression
  readonly total: number
  readonly offset: number
  readonly limit: number
  readonly sessions: readonly SourceSession[]
}

/**
 * List one backend root, newest first, with titles and an event count each.
 *
 * Pagination happens after the scan because the sort key (creation time) and the
 * label (newest title) both live inside the artifacts: there is no index to page
 * against, and pretending otherwise would page by directory name — which is the
 * escaped id and meaningless to a reader.
 *
 * Passing `target` marks every session the other root already holds, so a picker
 * can say «已转换为 SQLite» instead of offering a second copy. Pass `catalog` too
 * and a clone's origin counts as held: the copy has a new id, and only the
 * catalog knows where it came from.
 */
export async function listSourceRoot(
  backend: SourceLocator,
  options: {
    readonly offset?: number | undefined
    readonly limit?: number | undefined
    readonly query?: string | undefined
    readonly refresh?: boolean | undefined
    readonly target?: SourceLocator | undefined
    readonly catalog?: SessionBackendCatalog | undefined
    readonly summary?: boolean | undefined
    readonly grouped?: boolean | undefined
    readonly parent?: string | undefined
    readonly signal?: AbortSignal | undefined
  } = {},
): Promise<SourceListing> {
  if (backend.id === 'jsonl' && options.summary === true) {
    const offset = Math.max(0, Math.trunc(options.offset ?? 0))
    const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 50)))
    const page = await pickerPage(backend.root, { offset, limit, query:options.query, refresh:options.refresh, signal:options.signal, grouped:options.grouped, parent:options.parent })
    const target = options.target === undefined ? undefined : idsWithOrigins(await heldIds(options.target), options.catalog)
    options.signal?.throwIfAborted()
    return { backend:backend.id,root:backend.root,encoding:page.encoding,offset,limit,total:page.total,sessions:target === undefined ? page.sessions : page.sessions.map(session => ({...session,inTarget:target.has(session.id)})) }
  }
  const source = await cachedSourceListing(backend, options.refresh === true)
  const target = options.target === undefined
    ? undefined
    : idsWithOrigins(await heldIds(options.target), options.catalog)
  const sessions = target === undefined
    ? source.sessions
    : source.sessions.map((session) => ({ ...session, inTarget: target.has(session.id) }))
  const query = options.query?.trim().toLowerCase() ?? ''
  const matched = options.grouped === true
    ? groupedSessions(sessions, query, options.parent)
    : query === '' ? sessions : sessions.filter((session) =>
      session.id.toLowerCase().includes(query)
      || (session.title ?? '').toLowerCase().includes(query))
  const offset = Math.max(0, Math.trunc(options.offset ?? 0))
  const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 50)))
  return {
    backend: backend.id,
    root: backend.root,
    encoding: source.encoding,
    total: matched.length,
    offset,
    limit,
    sessions: matched.slice(offset, offset + limit),
  }
}

/** Forget cached listings and ids, after a run that wrote logs somewhere. */
export function forgetListings(): void {
  forgetPickerInventory()
  listingGeneration++
  listingScans.clear()
  listings.clear()
  knownIds.clear()
}

/** Take the same non-blocking writer lease as the source's own provider. */
async function acquireSourceLease(
  source: MigrationBackend,
  entry: SourceSession,
): Promise<{ release(): Promise<void> }> {
  const dir = dirname(entry.path)
  if (source.id === 'sqlite') return SessionWriteLease.acquire(dir, entry.id as SessionId)
  return acquireJsonlLease(source, entry.id as SessionId, dir)
}
async function acquireJsonlLease(source: MigrationBackend, id: SessionId, dir: string): Promise<{ release(): Promise<void> }> {
  const { persistence } = await mountJsonl(source.root)
  // The official provider exposes this method on its concrete storage service.
  // Use its arbiter (including the Windows semaphore), and the listed artifact's
  // actual directory rather than deriving a new path from a legacy header.
  const provider = persistence as typeof persistence & {
    acquireLease(id: SessionId, cwd: string | undefined, dir: string): Promise<{ release(): Promise<void> }>
  }
  if (typeof provider.acquireLease !== 'function') {
    throw new MigrationError('the JSONL provider does not expose its source writer lease')
  }
  return provider.acquireLease(id, undefined, dir)
}

/**
 * Run one migration over the selected sessions of the source backend.
 *
 * Linked ownership is preflighted before any publication. Children publish first;
 * a required child's failure prevents its parent from publishing a dangling catalog.
 */
export async function runMigration(
  catalog: SessionBackendCatalog,
  source: MigrationBackend,
  target: MigrationBackend,
  options: MigrationOptions = DEFAULT_MIGRATION_OPTIONS,
  prepareSession?: (id: string) => Promise<void>,
  attachClone?: (sourceId: string, targetId: string) => Promise<void>,
): Promise<MigrationReport> {
  if (source.id === target.id) {
    throw new MigrationError(`source and target are both "${source.id}"; a migration needs two backends`)
  }
  if (await overlappingDirectories(source.root, target.root)) {
    throw new MigrationError('source and target roots are the same physical directory or contain one another')
  }
  const startedAt = Date.now()
  const report: MigrationReport = {
    migrationId: `mig-${startedAt.toString(36)}-${randomUUID().slice(0, 8)}`,
    mode: options.mode,
    sourceBackend: source.id,
    targetBackend: target.id,
    sourceRoot: source.root,
    targetRoot: target.root,
    startedAt,
    status: 'running',
    items: [],
  }
  const encoding: JsonlCompression = target.id === 'jsonl'
    ? target.compression ?? await detectCompression(target.root)
    : 'none'
  const stagingRoot = join(`${target.root}.migrating`, report.migrationId)

  const wanted = options.sessions === undefined || options.sessions.length === 0
    ? undefined
    : new Set(options.sessions)
  const listed = await sourceSessions(source, options.session === undefined ? wanted : new Set([options.session]))
  const selected = options.session === undefined
    ? (wanted === undefined ? listed : listed.filter((entry) => wanted.has(entry.id)))
    : listed.filter((entry) => entry.id === options.session)
  if (selected.length === 0) {
    report.status = 'failed'
    report.error = options.session !== undefined
      ? `the ${source.id} backend at "${source.root}" does not hold "${options.session}"`
      : wanted === undefined
        ? `the ${source.id} backend at "${source.root}" holds no sessions`
        : `none of the ${wanted.size} selected sessions are stored by the ${source.id} backend at "${source.root}"`
    report.finishedAt = Date.now()
    return report
  }
  // One name cannot label several copies: the second clone would overwrite the
  // first one's log and the operator would have converted two conversations into
  // one. Refusing is the only answer that keeps both.
  if (options.mode === 'clone' && options.newSessionId !== undefined && selected.length > 1) {
    report.status = 'failed'
    report.error = `newSessionId names one copy, but ${selected.length} sessions are selected; select one session or let the run assign ids`
    report.finishedAt = Date.now()
    return report
  }

  const prepared = new Set<string>()
  const prepareOnce = async (id: string) => { if (!prepared.has(id)) { await prepareSession?.(id); prepared.add(id) } }
  const entries = new Map(selected.map(entry => [entry.id, entry]))
  const candidatesFor = (id: string, explicit: boolean) => explicit ? [source] : catalog.backendOf(id) === target.id ? [target, source] : [source, target]
  const factCache = new Map<string, Map<string, string> | undefined>()
  const factsFor = async (id: string): Promise<Map<string, string> | undefined> => {
    if (factCache.has(id)) return factCache.get(id)
    for (const backend of candidatesFor(id, entries.has(id))) {
      const copy = await readSource(backend, id)
      if (!copy) continue
      if (copy.incomplete || String(copy.header.id) !== id) throw new MigrationError(`cannot prove subagent ownership from incomplete or mismatched parent "${id}"`)
      const facts = new Map<string, string>()
      for (const event of copy.events) {
        const data = event.data as unknown as { childId?: unknown; mode?: unknown }
        if (String(event.type) === 'subagent/catalog' && Number(event.seq) >= copy.inheritedEventCount && data?.mode !== 'external' && typeof data?.childId === 'string' && typeof data.mode === 'string') {
          if (facts.has(data.childId) && facts.get(data.childId) !== data.mode) throw new MigrationError(`conflicting subagent catalog facts in "${id}"`)
          facts.set(data.childId, data.mode)
        }
      }
      factCache.set(id, facts); return facts
    }
    factCache.set(id, undefined); return undefined
  }
  const canRebind = options.mode === 'clone' ? async (childId: string, actualParent: string, copiedParent: string): Promise<boolean> => {
    let id = copiedParent, proven = false
    const seen = new Set<string>()
    for (let depth = 0; depth < 16 && !seen.has(id); depth++) {
      seen.add(id)
      const origin = catalog.get(id)?.originSessionId
      if (origin === undefined) break
      if (origin === actualParent) { proven = true; break }
      id = origin
    }
    if (!proven) return false
    const original = await factsFor(actualParent), copied = await factsFor(copiedParent)
    return original?.has(childId) === true && original.get(childId) === copied?.get(childId)
  } : undefined
  let tree: CloneTree
  try {
    tree = await planCloneTree(selected.map(entry => entry.id), async (id, explicit) => {
      await prepareOnce(id)
      const candidates = candidatesFor(id, explicit)
      for (const backend of candidates) {
        const copy = await readSource(backend, id)
        if (copy === undefined) continue
        let path = explicit ? entries.get(id)?.path : undefined
        if (path === undefined && backend.id === 'jsonl') path = (await findJsonlArtifact(backend.root, id))?.path
        if (path === undefined && backend.id === 'sqlite') {
          const expected = databasePath(backend.root, copy.header.cwd, copy.header.id)
          if (existsSync(expected)) path = expected
          else for (const artifact of await scanSqliteSessions(backend.root)) { if (String((await readSqliteHeader(artifact.path)).header.id) === id) { path = artifact.path; break } }
        }
        if (path === undefined) throw new MigrationError(`cannot locate the source artifact for required session "${id}"`)
        return { source: backend, copy, path }
      }
      return undefined
    }, options.mode === 'clone' ? options.newSessionId : undefined, options.mode === 'overwrite', canRebind)
    if (options.mode === 'clone') for (const node of tree.nodes) await assertCloneAbsent(target, node.targetId, catalog)
  } catch (error) {
    const problem = error instanceof Error ? error.message : String(error)
    for (const entry of selected) report.items.push({ sourceSession: entry.id, targetSession: options.newSessionId ?? entry.id, status: 'failed', expected: 0, transferred: 0, error: problem })
    report.status = 'failed'; report.error = problem; report.finishedAt = Date.now(); return report
  }
  const work: Array<{ entry: SourceSession; source: MigrationBackend; targetId: string; node: CloneNode }> = tree.nodes.map(node => ({
    entry: entries.get(node.sourceId) ?? { id: node.sourceId, title: undefined, problem: undefined, eventCount: 0, sizeBytes: 0, createdAt: node.header.createdAt, cwd: node.header.cwd, path: node.path },
    source: node.source, targetId: node.targetId, node,
  }))
  const completed = new Set<string>()
  for (const task of work) {
    const { entry, source, targetId, node } = task
    const sourceId = entry.id
    const item: MigrationItem = {
      sourceSession: sourceId,
      targetSession: targetId,
      status: 'pending',
      expected: 0,
      transferred: 0,
    }
    report.items.push(item)
    let cloneLease: SessionWriteLease | undefined
    let sourceLease: { release(): Promise<void> } | undefined
    try {
      if (node?.childIds.some(id => !completed.has(id))) throw new MigrationError(`required subagent copy for "${sourceId}" did not complete; parent copy was not published`)
      await prepareOnce(entry.id)
      if (options.mode === 'overwrite') sourceLease = await acquireSourceLease(source, entry)
      if (options.mode === 'clone') {
        cloneLease = await SessionWriteLease.acquire(target.root, targetId as SessionId)
        await assertCloneAbsent(target, targetId, catalog)
      }
      item.status = 'migrating'
      const copy = await readSource(source, sourceId)
      if (copy === undefined) {
        item.status = 'skipped'
        item.error = `the ${source.id} backend lists "${sourceId}" but cannot read it`
        continue
      }
      if (copy.incomplete === true) {
        throw new MigrationError(`the source log is incomplete; left the source and target unchanged (${copy.problem ?? 'streaming stopped at a broken record'})`)
      }
      item.expected = copy.events.length
      // The conversation is about to live on *this* host, so its cwd is settled
      // before anything is written: the store's own validator, the project bucket
      // the log lands in, and the result the operator reads must all name one
      // path. A store keeps the mounted form (it is opened here); a JSONL log
      // keeps whatever the writer accepts, which is the same translation.
      assertTreeSnapshot(copy, node)
      if (options.mode === 'overwrite' && source.id === target.id && await sameDirectory(source.root, target.root)) {
        item.status = 'skipped'; item.title = titleInLog(copy); item.cwd = copy.header.cwd; completed.add(sourceId); continue
      }
      const snapshot = options.mode === 'clone' ? remapClone(copy, node, tree.ids) : copy
      const portable = target.id === 'sqlite' ? storableHeader(snapshot.header) : headerOf(snapshot.header)
      const cloned = options.mode === 'clone' ? logForClone(snapshot, portable, targetId as SessionId) : undefined
      const write: LogCopy = cloned?.log ?? { ...copy, header: portable }
      item.expected = write.events.length

      await mkdir(stagingRoot, { recursive: true, mode: 0o700 })
      const staged = await stageCopy(target, stagingRoot, write, encoding)
      item.transferred = write.events.length
      if (options.verify) {
        item.status = 'verifying'
        const problem = await verifyStaged(target, stagingRoot, write)
        if (problem !== undefined) {
          item.status = 'failed'
          item.error = `staged copy does not match the source: ${problem}`
          continue
        }
      }

      const final = plannedTargetPath(target, targetId, write.header.cwd)
      if (target.id === 'sqlite') {
        // `publishDatabase` already takes the write lease on the session
        // directory before it renames. Taking a second one here would contend
        // with it — POSIX `flock` conflicts between two descriptors of the same
        // file even inside one process — so the lease stays in one place.
        if (options.mode === 'clone') {
          await publishNewDatabase(staged, final, async () => { await assertCloneAbsent(target, targetId, catalog) })
        } else {
          await publishDatabase(staged, final)
        }
      } else {
        // Both encodings keep one directory per session, so the published unit
        // is the staging directory — the provider reads directories and rejects
        // the older flat-file layout.
        //
        // The lease is taken before the publish: renaming under a live writer
        // loses its later appends to an unlinked inode with no error anywhere.
        // The lock lives inside the session directory, where the JSONL provider
        // puts it, so publishing contends with the same file a live writer holds.
        const lease = await acquireJsonlLease(target, targetId as SessionId, final)
        try {
          if (options.mode === 'clone') {
            await assertCloneAbsent(target, targetId, catalog)
            if (existsSync(`${final}.replaced`)
              || (await readdir(final)).some((name) => name !== 'session.lock')) {
              throw new MigrationError(`clone target "${targetId}" already exists`)
            }
            const artifact = await findJsonlArtifact(stagingRoot, targetId)
            if (artifact === undefined) throw new MigrationError(`staged clone "${targetId}" is missing`)
            await link(artifact.path, join(final, basename(artifact.path)))
          } else {
            await publishPath(staged, final)
          }
        } finally {
          await lease.release()
        }
      }
      await rm(stagingRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      // The label the picker showed, carried into the result so a reader can
      // recognise the conversation instead of matching two opaque ids.
      item.title = cloned?.title ?? entry.title ?? titleInLog(write)
      item.cwd = write.header.cwd

      // The route moves only after the copy is in place and proven. A crash here
      // leaves the copy on disk with the catalog still naming the source, which
      // the router resolves by probing: no session is lost, and a later run
      // reconciles the two.
      const previous = catalog.get(targetId)
      await catalog.commitRoute(targetId, target.id, {
        ...options.mode === 'clone' ? { originSessionId: sourceId, clonedAt: Date.now() }
          : previous?.originSessionId === undefined ? {} : { originSessionId: previous.originSessionId, ...(previous.clonedAt === undefined ? {} : { clonedAt: previous.clonedAt }) },
        migrationId: report.migrationId,
        sourceBackend: source.id,
        targetBackend: target.id,
      })
      item.status = 'migrated'
      completed.add(sourceId)
      if (options.mode === 'clone') {
        try {
          await attachClone?.(sourceId, targetId)
        } catch (error) {
          // Files and routing are durable. Do not report a failed copy and invite
          // another clone; expose the separate account failure on the created ID.
          item.error = 'the new conversation was created, but its project group could not be preserved: '
            + (error instanceof Error ? error.message : String(error))
        }
      }

      // An overwrite replaces the old conversation: the copy is now the one the
      // session list shows, and the source log must stop being a second copy of
      // the same id — otherwise the two backends disagree forever about which is
      // authoritative. It is moved aside, not deleted, because an operator who
      // migrated by mistake still needs the original back.
      //
      // The conversation already moved and its route is committed, so a failure
      // here leaves a correct migration with a leftover source log; the item says
      // so instead of turning a completed move into a failed one.
      if (options.mode === 'overwrite') {
        try {
          const archived = await archiveSource(source, sourceId, report.migrationId)
          if (archived !== undefined) item.archivedTo = archived
        } catch (error) {
          item.error = `the conversation moved, but its ${source.id} copy could not be set aside: `
            + (error instanceof Error ? error.message : String(error))
        }
      }
    } catch (error) {
      item.status = 'failed'
      item.error = error instanceof Error ? error.message : String(error)
    } finally {
      try {
        await sourceLease?.release()
      } finally {
        await cloneLease?.release()
      }
    }
  }

  report.finishedAt = Date.now()
  // A run wrote logs and moved routes, so any listing taken before it is stale.
  forgetListings()
  const failed = report.items.filter((item) => item.status === 'failed').length
  const done = report.items.filter((item) => item.status === 'migrated').length
  report.status = failed === 0 ? 'completed' : done === 0 ? 'failed' : 'partial'
  return report
}

/**
 * Move a superseded source log out of the live library, into a dated backup.
 *
 * An overwrite leaves two logs holding one conversation. Readers would then have
 * to trust the catalog to pick one, and a rebuilt catalog — which is the whole
 * point of being able to rebuild it — would see both. Moving the old log out of
 * the backend's root makes "one conversation, one log" true on disk again, and
 * keeping it under `<root>.replaced/<migrationId>/` makes the move reversible by
 * hand.
 *
 * @returns where the log went, or `undefined` when the source had nothing left.
 */
export async function archiveSource(
  source: MigrationBackend,
  id: string,
  migrationId: string,
): Promise<string | undefined> {
  const vault = `${source.root}.replaced`
  const room = join(vault, migrationId)
  if (source.id === 'sqlite') {
    for (const entry of await scanSessions(source.root)) {
      const db = SessionDatabase.open(entry.path, { ...READ_SETTINGS, readOnly: true })
      let matches = false
      try {
        matches = String(db.loadHeader()?.header.id ?? '') === id
      } finally {
        db.close()
      }
      if (!matches) continue
      await mkdir(room, { recursive: true, mode: 0o700 })
      const parked = join(room, basename(dirname(entry.path)))
      await rm(parked, { recursive: true, force: true })
      // The database and its sidecars move together: a `-wal` left behind would
      // replay writes into the fresh copy's directory name.
      await ensureSessionDirectory(parked)
      // The archive is a move, and Windows refuses to move a store whose handle
      // this process still holds. Dropping the cached connection first is what
      // makes "set the old log aside" work outside a POSIX host.
      await releaseStore(entry.path)
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        if (!existsSync(`${entry.path}${suffix}`)) continue
        await rename(`${entry.path}${suffix}`, join(parked, `${DATABASE_FILENAME}${suffix}`))
      }
      return parked
    }
    return undefined
  }
  const artifact = await findJsonlArtifact(source.root, id)
  if (artifact === undefined) return undefined
  await mkdir(room, { recursive: true, mode: 0o700 })
  // A session directory moves whole; a flat log is one file. Either way the
  // destination is named after the artifact, not after the id, so a compressed
  // root's `session.v4.jsonl.zstd` keeps the name the provider gave it.
  const holder = dirname(artifact.path)
  const ownsDirectory = basename(holder) === encodeSegment(id as SessionId)
  const parked = join(room, basename(ownsDirectory ? holder : artifact.path))
  await rm(parked, { recursive: true, force: true })
  await rename(ownsDirectory ? holder : artifact.path, parked)
  return parked
}

/**
 * Delete the source log of a session whose route already points elsewhere.
 *
 * This is the "operator confirms, then the backup goes" end of an overwrite. It
 * refuses while the route still names the source — deleting the only copy of a
 * session that is not yet migrated is exactly the mistake this guard exists for.
 */
export async function pruneSource(
  catalog: SessionBackendCatalog,
  source: MigrationBackend,
  id: string,
): Promise<'removed' | 'absent'> {
  const routed = catalog.backendOf(id as SessionId)
  if (routed === undefined || routed === source.id) {
    throw new MigrationError(
      `session "${id}" is ${routed === undefined ? 'not routed anywhere yet' : `still routed to ${source.id}`}; `
      + `migrate it before deleting its ${source.id} log`,
    )
  }
  if (source.id === 'sqlite') {
    for (const entry of await scanSessions(source.root)) {
      const db = SessionDatabase.open(entry.path, { ...READ_SETTINGS, readOnly: true })
      let matches = false
      try {
        matches = String(db.loadHeader()?.header.id ?? '') === id
      } finally {
        db.close()
      }
      if (!matches) continue
      await removeDatabase(entry.path)
      return 'removed'
    }
    return 'absent'
  }
  const artifact = await findJsonlArtifact(source.root, id)
  if (artifact === undefined) return 'absent'
  // A compressed root keeps one directory per session and the artifact is the
  // log *inside* it: deleting only the file leaves a session directory the
  // provider still lists. A flat root names the log after the id with no
  // directory of its own, so there is nothing else to remove.
  const holder = dirname(artifact.path)
  const ownsDirectory = existsSync(holder) && basename(holder) === encodeSegment(id as SessionId)
  await rm(ownsDirectory ? holder : artifact.path, { recursive: true, force: true })
  return 'removed'
}
