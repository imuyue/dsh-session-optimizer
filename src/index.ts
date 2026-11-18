/**
 * `session-persistence-optimizer` — a SessionPersistence backend that stores one
 * session per SQLite file.
 *
 * Contract obligations this module implements (see the persistence package):
 * - a created-but-unwritten session is visible to this instance only;
 * - `flush` is the durability barrier, `append` may batch behind it;
 * - a torn tail is never served and is truncated by the write path;
 * - `revision` is opaque, stable per instance and session, and changes with
 *   content only.
 *
 * Layout mirrors the JSONL backend so the two can live side by side:
 * `<root>/--<projectKey(cwd)>--/<encodeSegment(sessionId)>/session.db`.
 *
 * @module dsh-session-optimizer/index
 */

import { dirname, join, resolve } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import {
  type SessionEvent,
  type SessionHeader,
  type SessionId,
} from '@deepseek-ai/dsh-session'
import {
  SessionAlreadyExistsError,
  SessionPersistence,
  SessionPersistenceCorruptionError,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  sessionFormatVersionRefusal,
  materializeCreateHeader,
  assertVersion,
  type SessionPersistenceCreateOptions,
  type SessionPersistenceListOptions,
  type SessionPersistenceOpenOptions,
  type SessionPersistenceSnapshot,
  type SessionPersistenceStatOptions,
  type SessionAccess,
  type SessionHandle,
} from '@deepseek-ai/dsh-session-persistence'
import z from '@deepseek-ai/schemastery'
import { pluginAbout } from './about.ts'
import { SessionBackendCatalog, type SessionBackendId } from './catalog.ts'
import { type LoadedHeader, type LoadedSession, type SqliteSettings } from './database.ts'
import { recordDiagnostic } from './diagnostics.ts'
import { registerConsole, type ConsoleConfig } from './console.ts'
import { PerformanceController } from './performance.ts'
import { PreviewReader } from './history-preview.ts'
import { createPerformanceTool, type PerformanceToolRegistry } from './performance-tool.ts'
import { PAGE_TRANSFER_POLICY, registerPageTransferPolicy } from './page-transfer.ts'
import { InlineExecutor, type StorageExecutor } from './executor.ts'
import { databasePath, decodeSegment, encodeSegment, sessionDir } from './format.ts'
import { SessionWriteLease } from './lease.ts'
import { attachMigrationJournal } from './migrate.ts'
import { installMigrationRuntime } from './migration-runtime.ts'
import { cloneWorkspaceAttacher, readWorkspaceMemberships, type MigrationWorkspaceRegistry } from './migration-workspace.ts'
import { createMigrationHistoryTool } from './migration-history-tool.ts'
import { MetricsRegistry } from './metrics.ts'
import { attachMetricsJournal, detachMetricsJournal } from './metrics-journal.ts'
import {
  type Preferences,
  type SessionFormat,
  createPreferencesHost,
  preferencesPath,
} from './preferences.ts'
import { HybridSessionPersistence, rebuildCatalog, type RoutedBackend } from './router.ts'
import { matchQueryFor, snippetOf, type SearchHit } from './search.ts'
import {
  DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
  SqliteBackendTracker,
  SqliteSessionHandle,
  findDatabasePath,
  scanSessions,
} from './storage.ts'
import { WorkerExecutor } from './worker-client.ts'
import { warmRecentSessions, type WarmupReport } from './warmup.ts'

/** Plugin name, also used as the logger prefix. */
export const name = 'session-persistence-optimizer'

const DEFAULT_BUSY_TIMEOUT_MS = 5000
const DEFAULT_PREPARED_SESSION_CACHE_SIZE = 5

/**
 * Conversations warmed on mount by default.
 *
 * Five is more than a picker shows at once and small enough that the whole
 * warm-up is a few frames rather than a scan of the root; a profile with hundreds
 * of conversations should not pay for all of them at startup.
 */
const DEFAULT_WARMUP_SESSIONS = 5

/**
 * How long the backend must have been idle before the warm-up takes a turn.
 *
 * The window has to cover one open plus its first page — otherwise the warm-up
 * keeps grabbing the slot between the two halves of a reader's own request — and
 * stay short enough that an idle profile is warm well before anyone clicks.
 */
const WARMUP_QUIET_AFTER_MS = 250

/**
 * The settings this backend actually runs with.
 *
 * `SqliteSettings` is read-only because it describes one open connection; this
 * instance holds one object for its whole life and the settings view writes the
 * live switch (`seal`) into it, so a flip reaches the next append without
 * reopening anything. Everything else in the object really is fixed: the pragmas
 * are applied when a connection opens.
 */
type LiveSettings = { -readonly [K in keyof SqliteSettings]: SqliteSettings[K] }

/** Plugin configuration. */
export interface Config {
  /** Directory holding every session database; usually `dshHomePath('sessions')`. */
  root: string
  journalMode: 'wal' | 'delete' | 'truncate' | 'persist'
  synchronous: 'full' | 'normal'
  busyTimeoutMs: number
  writeBatchMaxDelayMs: number
  preparedSessionCacheSize: number
  storageThread: 'worker' | 'inline'
  /**
   * JSONL root offered to the console as the default export/import side. Leave
   * empty when the profile does not keep one: the console then asks the operator
   * for a path instead of guessing.
   */
  jsonlRoot: string
  /**
   * Directory holding the per-session backend catalog. Leave empty to use
   * `<dirname(root)>/session-backends`, which keeps it out of the SQLite session
   * tree and next to the profile's other state.
   */
  stateDirectory: string
  /**
   * Mount the official JSONL provider alongside this backend and route each
   * session to whichever one holds it. Off by default: a profile that only wants
   * SQLite should not depend on the JSONL package being installed.
   */
  hybrid: boolean
  /** Backend that receives a session nobody has routed yet. */
  newSessionBackend: 'sqlite' | 'jsonl'
  /**
   * How many of the most recently written conversations to warm on mount.
   *
   * The first history page of a long conversation costs a frame decompression
   * that the operator then waits for; doing it just after mount, in chunks that
   * yield to the event loop, moves that cost off the click. `0` disables it.
   */
  warmupSessions: number
  /**
   * Provide `ctx.sessionQuery` from these stores.
   *
   * A profile loads one search engine: this one, or
   * `@deepseek-ai/dsh-session-query-sqlite`. Turning it on here means dropping
   * the released plugin from the profile, because the service has one owner.
   */
  ownSearch: boolean
}

export const Config: z<Config> = z.object({
  root: z.string().required(),
  journalMode: z
    .union([z.const('wal'), z.const('delete'), z.const('truncate'), z.const('persist')])
    .default('wal'),
  synchronous: z.union([z.const('full'), z.const('normal')]).default('full'),
  busyTimeoutMs: z.natural().min(0).default(DEFAULT_BUSY_TIMEOUT_MS),
  writeBatchMaxDelayMs: z.natural().min(1).default(DEFAULT_WRITE_BATCH_MAX_DELAY_MS),
  preparedSessionCacheSize: z.natural().min(1).default(DEFAULT_PREPARED_SESSION_CACHE_SIZE),
  storageThread: z.union([z.const('worker'), z.const('inline')]).default('worker'),
  jsonlRoot: z.string().default(''),
  stateDirectory: z.string().default(''),
  hybrid: z.boolean().default(false),
  newSessionBackend: z.union([z.const('sqlite'), z.const('jsonl')]).default('sqlite'),
  warmupSessions: z.natural().min(0).default(DEFAULT_WARMUP_SESSIONS),
  ownSearch: z.boolean().default(false),
})

/**
 * Enforce the seeded/unseeded invariant on `inheritedEventCount`, mirroring the
 * refusal the JSONL header line performs.
 */
function validateInheritedCount(header: SessionHeader, inheritedEventCount: number | undefined): number {
  const cut = inheritedEventCount ?? 0
  if (header.isSeeded && inheritedEventCount === undefined) {
    throw new Error('seeded session header requires an inherited event count')
  }
  if (!header.isSeeded && cut !== 0) {
    throw new Error('unseeded session header inherited event count must be 0')
  }
  return cut
}

/**
 * Canonicalize the logical header exactly as the JSONL backend's header line
 * does, so both backends report the same object for the same session.
 *
 * `delegationDepth` is optional in the logical `SessionHeader` and defaults to
 * 0 at the JSONL line encoder; a session created through JSONL therefore reads
 * back with an explicit `delegationDepth: 0`, and a session created here must
 * match, or an export/import round trip would look like a header change.
 */
function normalizeHeader(header: SessionHeader): SessionHeader {
  return { ...header, delegationDepth: header.delegationDepth ?? 0 }
}

/** The backend. One instance per profile; one file per session. */
export class SqliteSessionPersistence extends SessionPersistence {
  override readonly name = name
  /** Where this backend stores its sessions. */
  private readonly root: string
  private readonly settings: LiveSettings
  private readonly batchDelayMs: number
  private readonly executor: StorageExecutor
  private readonly storageThread: 'worker' | 'inline'
  /** JSONL root handed to the console for migration, or `undefined`. */
  private readonly jsonlRoot: string | undefined
  /** Real latencies of this instance's own operations, for the console. */
  readonly metrics = new MetricsRegistry()
  /**
   * How a format switch reaches the router.
   *
   * Set by `mountHybrid` once the router exists — the instance is constructed
   * before it, and a standalone install has nothing to switch, so the switch
   * stays undefined there and a saved preference is simply remembered.
   */
  private backendSwitch: ((format: SessionFormat) => void) | undefined
  private readonly tracker: SqliteBackendTracker

  constructor(
    ctx: Context,
    config: Config,
    tracker: SqliteBackendTracker,
  ) {
    super(ctx)
    this.tracker = tracker
    this.root = resolve(config.root)
    this.settings = {
      journalMode: config.journalMode,
      synchronous: config.synchronous,
      busyTimeoutMs: config.busyTimeoutMs,
    }
    this.batchDelayMs = config.writeBatchMaxDelayMs
    this.storageThread = config.storageThread
    this.jsonlRoot = config.jsonlRoot === '' ? undefined : resolve(config.jsonlRoot)
    this.executor = config.storageThread === 'worker'
      ? new WorkerExecutor(config.preparedSessionCacheSize)
      : new InlineExecutor(config.preparedSessionCacheSize)
  }

  /** Close the executor (and, in worker mode, the worker thread). */
  async closeStorage(): Promise<void> {
    await this.executor.close()
  }

  /**
   * Read the headers of the whole root and the tail of the newest conversations.
   *
   * Called once after mount, never on a request path: the reader that benefits
   * is the operator opening a conversation, and the cost is paid while nothing
   * is waiting for it. Yields between chunks, so a mount is not delayed by more
   * than one batch; a store that fails to warm simply stays cold.
   *
   * `quiet` is what makes it let the application go first: while it returns
   * false the loop parks, so a warm-up can never compete with the request that
   * made the operator wait.
   */
  async warmUp(
    sessions = DEFAULT_WARMUP_SESSIONS,
    signal?: AbortSignal,
    quiet?: () => boolean,
  ): Promise<WarmupReport> {
    return warmRecentSessions({
      root: this.root,
      settings: this.settings,
      executor: this.executor,
      sessions,
      ...(signal === undefined ? {} : { signal }),
      ...(quiet === undefined ? {} : { quiet }),
    })
  }

  /**
   * What the read-only console needs to reach this backend's files. The console
   * opens them itself with `readOnly: true`, so it shares the root and pragmas
   * but never the write connection.
   */
  consoleTarget(): {
    root: string
    settings: SqliteSettings
    storageThread: 'worker' | 'inline'
    metrics: MetricsRegistry
    jsonlRoot: string | undefined
    search: (query: string, limit: number) => Promise<SearchHit[]>
  } {
    return {
      root: this.root,
      settings: this.settings,
      storageThread: this.storageThread,
      metrics: this.metrics,
      jsonlRoot: this.jsonlRoot,
      search: (query, limit) => this.search(query, limit),
    }
  }

  /**
   * Full-text search across every store this root holds.
   *
   * Each store keeps its own index, so the fan-out is one query per conversation
   * rather than one index over all of them: a conversation is created, forked,
   * deleted and copied between roots as a unit, and an index that lives with its
   * log cannot disagree with it after a crash. Results from every store are
   * merged by rank; bm25 is comparable across stores because it is a function of
   * the match inside one document set, and every store is scored against its own
   * rows.
   */
  /** The stores a search has to walk: one when the caller named a session. */
  private async storeEntries(sessionId: string | undefined): Promise<Array<{ directory: string; path: string }>> {
    if (sessionId === undefined) return scanSessions(this.root)
    const path = await findDatabasePath(this.root, sessionId as never)
    if (path === undefined) return []
    // The same encoding `scanSessions` sees, so the id decodes back unchanged.
    return [{ directory: encodeSegment(sessionId), path }]
  }

  async search(query: string, limit = 20, sessionId?: string): Promise<SearchHit[]> {
    const match = matchQueryFor(query)
    if (match === undefined) return []
    return this.metrics.time('search', async () => {
      const found = await this.storeEntries(sessionId)
      const hits: SearchHit[] = []
      for (const entry of found) {
        let rows
        try {
          rows = await this.executor.searchStore(entry.path, this.settings, match, limit)
        } catch (error) {
          // One unreadable store must not take the whole search down; the panel
          // reports it in the problem log instead.
          recordDiagnostic('warn', 'search', `${entry.path}: ${String(error)}`)
          continue
        }
        if (rows === undefined) continue
        // A directory this backend wrote always decodes; one it did not is
        // reported under its raw name rather than dropped from the results.
        const sessionId = decodeSegment(entry.directory) ?? entry.directory
        for (const row of rows) {
          hits.push({
            sessionId,
            seq: row.seq,
            type: row.type,
            time: row.time,
            score: row.score,
            text: row.text,
            snippet: snippetOf(row.text, query),
          })
        }
      }
      hits.sort((left, right) => left.score - right.score)
      return hits.slice(0, limit)
    })
  }

  /**
   * Adopt the operator's saved preferences.
   *
   * Called once at mount with what is on disk, and again on every change. The two
   * switches act on different things: the stability fixes are the log-shape
   * rewrites this plugin performs (sealing the tail into compressed frames), so
   * turning them off leaves a store as plain rows and nothing reshapes a log
   * behind a reader; the format names the backend new conversations are created
   * on, which only a hybrid install can honour.
   *
   * A format this install cannot serve is not an error here — the console refuses
   * it at the edge (`/settings` validates against the same list), and a saved
   * preference from a hybrid profile that is now standalone must not stop the
   * mount.
   */
  applyPreferences(preferences: Preferences): void {
    this.settings.seal = preferences.stabilityFixes
    this.backendSwitch?.(preferences.format)
  }

  /** Route format switches to the hybrid router; a no-op install never sets it. */
  setBackendSwitch(redirect: (format: SessionFormat) => void): void {
    this.backendSwitch = redirect
  }

  /** Create a session and hand back a write handle. Nothing touches disk yet. */
  async create(
    header: SessionHeader,
    options?: SessionPersistenceCreateOptions,
  ): Promise<SessionHandle> {
    return this.metrics.time('open', async () => {
      options?.signal?.throwIfAborted()
      const snapshot = normalizeHeader(materializeCreateHeader(header))
      const inheritedEventCount = validateInheritedCount(snapshot, options?.inheritedEventCount)
      // `path` is known up front, so every later read goes straight to this
      // file instead of scanning the root for it. Nothing is created on disk.
      const path = databasePath(this.root, snapshot.cwd, snapshot.id)
      await this.executor.ensureDirectory(this.root)
      options?.signal?.throwIfAborted()
      if (
        this.tracker.hasPending(snapshot.id) ||
        (await this.executor.findDatabase(this.root, snapshot.id)) !== undefined
      ) {
        throw new SessionAlreadyExistsError(snapshot.id)
      }
      options?.signal?.throwIfAborted()
      // registerCreated is the atomic guard: a concurrent create loses here.
      this.tracker.registerCreated(snapshot, inheritedEventCount)
      return this.tracker.adopt(
        new SqliteSessionHandle(
          this,
          snapshot.id,
          snapshot,
          'write',
          { cursor: 0, materialized: false, inheritedEventCount, path },
          this.batchDelayMs,
        ),
      )
    })
  }

  /** Open an existing session, read-only or for writing, taking the lease last. */
  async open(
    id: SessionId,
    access: SessionAccess,
    options?: SessionPersistenceOpenOptions,
  ): Promise<SessionHandle> {
    return this.metrics.time('open', async () => {
      options?.signal?.throwIfAborted()
      await this.executor.ensureDirectory(this.root)
      options?.signal?.throwIfAborted()

      if (access === 'read') {
        const pending = this.tracker.pendingOf(id)
        if (pending !== undefined) {
          return this.tracker.adopt(
            new SqliteSessionHandle(
              this,
              id,
              pending.header,
              'read',
              {
                cursor: 0,
                materialized: false,
                inheritedEventCount: Number(pending.inheritedEventCount),
              },
              this.batchDelayMs,
            ),
          )
        }
        const path = await this.executor.findDatabase(this.root, id)
        if (path === undefined) throw new SessionPersistenceNotFoundError(id)
        // A read handle owns nothing, so it must not take the write lease: when
        // another process holds one, a reader has to behave like SQLite's BUSY
        // (serve the committed prefix) instead of failing outright. What a
        // reader does need is the length of that prefix, and the header records
        // it — decoding the whole log just to learn it made `open()` cost one
        // JSON.parse per event, which is why a 100k-event session used to take
        // hundreds of milliseconds to open.
        const header = await this.readHeaderAt(id, path, options?.signal)
        if (header === undefined) throw new SessionPersistenceNotFoundError(id)
        // The row's `event_count` is a claim; the rows are the fact. When a store
        // was cut short — a crash mid-copy, an interrupted restore, a hand-run
        // DELETE — the claim stays high, and a reader that believed it would
        // promise events that are gone and then refuse the log as "shrank" every
        // time it was opened. Counting costs one aggregate query, so the handle
        // is built from what the file actually holds.
        const stored = await this.executor.storedEventCount(path, this.settings)
        const served = Math.min(header.eventCount, stored)
        return this.tracker.adopt(
          new SqliteSessionHandle(
            this,
            id,
            header.header,
            'read',
            {
              cursor: served,
              materialized: true,
              // The store is short: a write path has to cut the claim down to
              // the rows before it appends again, or the next batch lands on
              // seqs whose contents were lost.
              tornTruncateTo: stored < header.eventCount ? stored : undefined,
              inheritedEventCount: header.inheritedEventCount,
              path,
            },
            this.batchDelayMs,
          ),
        )
      }

      this.tracker.claimWrite(id)
      let lease: SessionWriteLease | undefined
      try {
        const path = await this.executor.findDatabase(this.root, id)
        if (path === undefined) throw new SessionPersistenceNotFoundError(id)
        lease = await SessionWriteLease.acquire(dirname(path), id)
        // Resuming a conversation must not decode it. A write handle needs the
        // header, the next `seq` and a verdict on the tail — the session row and
        // the seal answer all three, while walking 47k events cost about a
        // second and delayed the first append of every resumed session. When the
        // seal declines (no seal, a fold that no longer matches, a length that
        // disagrees) the store is walked, which is also the only path that can
        // name a torn tail precisely.
        const trusted = await this.executor.trustedLength(path, this.settings)
        if (trusted !== undefined) {
          const header = await this.executor.loadHeader(path, this.settings)
          if (header !== undefined) {
            options?.signal?.throwIfAborted()
            return this.tracker.adopt(
              new SqliteSessionHandle(
                this,
                id,
                header.header,
                'write',
                {
                  cursor: trusted,
                  materialized: true,
                  tornTruncateTo: undefined,
                  inheritedEventCount: header.inheritedEventCount,
                  path,
                },
                this.batchDelayMs,
                lease,
              ),
            )
          }
        }
        const loaded = await this.readAt(id, path, options?.signal)
        if (loaded === undefined) throw new SessionPersistenceNotFoundError(id)
        options?.signal?.throwIfAborted()
        return this.tracker.adopt(
          new SqliteSessionHandle(
            this,
            id,
            loaded.header,
            'write',
            {
              cursor: loaded.eventCount,
              materialized: true,
              tornTruncateTo: loaded.tornTruncateTo,
              inheritedEventCount: loaded.inheritedEventCount,
              path,
            },
            this.batchDelayMs,
            lease,
          ),
        )
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error))
        const releaseFailure = lease === undefined ? undefined : await lease.release().then(
          () => undefined,
          (releaseError: unknown) => releaseError,
        )
        this.tracker.releaseClaim(id)
        if (releaseFailure !== undefined) {
          throw new AggregateError(
            [failure, releaseFailure],
            `session "${id}": write open failed and its lock release failed`,
          )
        }
        throw failure
      }
    })
  }

  /** Durability barrier for every active writer. */
  async flush(): Promise<void> {
    await this.metrics.time('flush', async () => { await this.tracker.flushAll() })
  }

  /** Metadata for one session, or `undefined` when it was never materialized. */
  async stat(
    id: SessionId,
    options?: SessionPersistenceStatOptions,
  ): Promise<SessionPersistenceSnapshot | undefined> {
    return this.metrics.time('stat', async () => {
      options?.signal?.throwIfAborted()
      const pending = this.tracker.pendingOf(id)
      if (pending !== undefined) {
        return {
          header: pending.header,
          formatStatus: 'current',
          revision: pending.revision,
        }
      }
      const path = await this.executor.findDatabase(this.root, id)
      if (path === undefined) return undefined
      return this.snapshotAt(id, path)
    })
  }

  /**
   * Every materialized session under the root, plus this instance's pending
   * ones. Pending entries are snapshotted before the scan so a create racing a
   * list is never invisible.
   *
   * Directory names are escaped (`encodeSegment`), so they cannot be decoded
   * back into ids: the header inside each database is the only authority.
   *
   * One unusable file must not take the list down. A foreign store, an
   * interrupted import or a newer layout version is a property of that one
   * entry, so it is skipped with a warning and every healthy session is still
   * returned: `list()` feeds session pickers, and losing the whole picker
   * because a stray file sits in the root is far worse than hiding it.
   */
  async list(options?: SessionPersistenceListOptions): Promise<SessionPersistenceSnapshot[]> {
    return this.metrics.time('list', async () => {
      options?.signal?.throwIfAborted()
      const pending = this.tracker.pendingEntries()
      const pendingIds = new Set(pending.map((entry) => entry.header.id))
      const snapshots: SessionPersistenceSnapshot[] = pending.map((entry) => ({
        header: entry.header,
        formatStatus: 'current',
        revision: entry.revision,
      }))
      const found = await scanSessions(this.root)
      const listed = await this.executor.listHeaders(
        found.map((entry) => entry.path),
        this.settings,
      )
      // One conversation, one row. A root can hold the same id twice — WSL's
      // `/mnt/c/x` and Windows' `C:\x` name the same directory under two project
      // keys, and a copied project directory carries its sessions with it. Both
      // copies read fine, so without this the picker would show the conversation
      // twice and then refuse to open either one (`findDatabasePath` treats the
      // pair as corruption). Listing the first and naming the loser in the log
      // keeps the surface honest and leaves the repair to the operator.
      const seen = new Set<string>()
      for (const entry of listed) {
        options?.signal?.throwIfAborted()
        if (entry.error !== undefined) {
          const problem = `${name}: skipping "${entry.path}" while listing sessions: ${entry.error.message}`
          this.ctx.logger.warn(problem)
          // Also into the console's ring: a shorter session list with no visible
          // reason is the one failure an operator cannot diagnose from the panel.
          recordDiagnostic('warn', 'list', problem)
          continue
        }
        const header = entry.header
        if (header === undefined) continue
        if (pendingIds.has(header.header.id)) continue
        if (seen.has(header.header.id)) {
          this.ctx.logger.warn(
            `${name}: session "${header.header.id}" is stored more than once; listing "${entry.path}" only`,
          )
          continue
        }
        seen.add(header.header.id)
        assertVersion(header.header, { kind: 'sqlite', path: entry.path })
        snapshots.push({
          header: header.header,
          formatStatus: 'current',
          revision: SessionPersistenceRevision(`${header.storeUuid}:${header.revision}`),
          // What the file holds, not what the row claims: a store cut short keeps
          // the old count until something rewrites it, and a picker that repeats
          // the claim offers events the conversation cannot deliver.
          eventCount: header.heldEventCount ?? header.eventCount,
          sizeBytes: entry.sizeBytes,
          location: { kind: 'sqlite', path: entry.path },
        })
      }
      return snapshots
    })
  }

  private async snapshotAt(
    id: SessionId,
    path: string,
  ): Promise<SessionPersistenceSnapshot | undefined> {
    const snapshot = await this.snapshotAtPath(path)
    return snapshot !== undefined && snapshot.header.id === id ? snapshot : undefined
  }

  private async snapshotAtPath(path: string): Promise<SessionPersistenceSnapshot | undefined> {
    let loaded
    try {
      loaded = await this.executor.loadHeader(path, this.settings)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    if (loaded === undefined) return undefined
    const { header, revision, eventCount, storeUuid } = loaded
    assertVersion(header, { kind: 'sqlite', path })
    // A listing must not promise events the file no longer holds. The row's
    // count is a claim; a store cut short by a crash keeps the old number until
    // something rewrites it, and a count in the picker that the conversation
    // cannot deliver is exactly what makes a damaged session look healthy. The
    // header read already counted when it could, so the extra query is only for
    // a store whose count came from a connection that did not take it.
    let held = loaded.heldEventCount
    if (held === undefined) {
      try {
        held = Math.min(eventCount, await this.executor.storedEventCount(path, this.settings))
      } catch {
        // Unreadable tables are `loadHeader`'s business, not the listing's.
        held = eventCount
      }
    }
    return {
      header,
      formatStatus: 'current',
      revision: SessionPersistenceRevision(`${storeUuid}:${revision}`),
      eventCount: held,
      sizeBytes: await this.executor.sizeBytes(path, this.settings),
      location: { kind: 'sqlite', path },
    }
  }

  // ---------------------------------------------------------------- storage

  /**
   * Write one batch. `isMaterialized` is the caller's belief about the row; the
   * database re-checks it inside the transaction, so a stale belief cannot
   * duplicate the header.
   */
  async persistBatch(
    header: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
    inheritedEventCount: number,
  ): Promise<void> {
    if (events.length === 0) return
    await this.metrics.time('append', async () => {
      const path = databasePath(this.root, header.cwd, header.id)
      await this.executor.ensureDirectory(dirname(path))
      await this.executor.appendBatch(
        path,
        this.settings,
        header,
        events,
        isMaterialized,
        inheritedEventCount,
      )
      this.tracker.materialized(header.id)
    })
  }

  /** Materialize an empty session (a flushed session with no events yet). */
  async persistHeader(header: SessionHeader, inheritedEventCount: number): Promise<void> {
    const path = databasePath(this.root, header.cwd, header.id)
    await this.executor.ensureDirectory(dirname(path))
    await this.executor.materializeHeader(path, this.settings, header, inheritedEventCount)
    this.tracker.materialized(header.id)
  }

  /** Drop a torn tail before the next append. */
  async truncateTornTail(header: SessionHeader, truncateTo: number): Promise<void> {
    const path = databasePath(this.root, header.cwd, header.id)
    await this.executor.truncateTail(path, this.settings, truncateTo)
    const repaired = `${name}: session "${header.id}" recovered from a torn tail; invalid tail rows were discarded`
    this.ctx.logger.warn(repaired)
    recordDiagnostic('warn', 'open', repaired)
  }

  /** Read and validate the committed prefix, or `undefined` when absent. */
  async readStoredLog(
    id: SessionId,
    signal?: AbortSignal,
    window?: { offset: number; length: number },
    path?: string,
  ): Promise<LoadedSession | undefined> {
    signal?.throwIfAborted()
    // A handle that already knows its file skips the directory scan entirely.
    const resolved = path ?? (await this.executor.findDatabase(this.root, id))
    if (resolved === undefined) return undefined
    return this.readAt(id, resolved, signal, window)
  }

  /**
   * Load `path` and check that it holds `id` and a finished import.
   *
   * Header-only on purpose: a reader needs the committed prefix length, which
   * the header records; whether the rows behind it are still sound is answered
   * by the reads themselves, one slice at a time.
   */
  async readHeaderAt(
    id: SessionId,
    path: string,
    signal?: AbortSignal,
  ): Promise<LoadedHeader | undefined> {
    return this.metrics.time('read', async () => {
      signal?.throwIfAborted()
      let header: LoadedHeader | undefined
      try {
        header = await this.executor.loadHeader(path, this.settings)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
      if (header === undefined) return undefined
      if (header.header.id !== id) return undefined
      if (header.state !== 'ready') {
        throw new SessionPersistenceCorruptionError(
          `session "${id}" has an unfinished import in "${path}"; rerun the migration CLI to replace it`,
          {},
        )
      }
      return header
    })
  }

  /** Load `path` and check that it holds `id` and a finished import. */
  async readAt(
    id: SessionId,
    path: string,
    signal?: AbortSignal,
    window?: { offset: number; length: number },
  ): Promise<LoadedSession | undefined> {
    return this.metrics.time('read', async () => {
      signal?.throwIfAborted()
      let loaded: LoadedSession | undefined
      try {
        // A whole-log read of a long conversation is the one cost a user feels
        // before they have typed anything, so it is read in pages: the parse of
        // one page runs while the next is being read, and the page travels as
        // text instead of as decoded events. `undefined` means the store could
        // not be paged (no usable seal, a short log, a page that did not arrive
        // as asked) and the walk below answers, including a torn-tail boundary.
        loaded = window === undefined
          ? await this.executor.loadSessionPaged(path, this.settings, signal)
          : undefined
        if (loaded === undefined) {
          loaded = await this.executor.loadSession(path, this.settings, window)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
      if (loaded === undefined) return undefined
      if (loaded.header.id !== id) return undefined
      if (loaded.state !== 'ready') {
        // An import that never reached `ready` is not a log yet: serving a
        // prefix of it would let the runtime resume from a half-copied history.
        throw new SessionPersistenceCorruptionError(
          `session "${id}" has an unfinished import in "${path}"; rerun the migration CLI to replace it`,
          {},
        )
      }
      return loaded
    })
  }

  hasPendingSession(id: SessionId): boolean {
    return this.tracker.hasPending(id)
  }

  /** Take the per-session write lease, creating the session directory first. */
  async acquireWriteLease(header: SessionHeader): Promise<SessionWriteLease> {
    const dir = sessionDir(this.root, header.cwd, header.id)
    return SessionWriteLease.acquire(dir, header.id)
  }

  releaseHandle(handle: SessionHandle, materialized: boolean): void {
    this.tracker.release(handle, materialized)
  }
}

/** Mount the backend: a tracker for live routing plus the persistence service. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // A JSONL root is the only thing that makes a JSONL session creatable, so it is
  // also the answer to "can this install offer that format". Saying where the
  // root is therefore selects the mixed mount whether or not `hybrid` was set:
  // the alternative was a settings page whose JSONL card is permanently dead
  // even though the profile is pointing at a perfectly good JSONL tree.
  const target = config.hybrid || config.jsonlRoot !== ''
    ? await mountHybrid(ctx, config)
    : await mountStandalone(ctx, config)
  // The read-only console is a Web GUI surface: without a `connection` (a
  // headless profile) there is nothing to answer, and the backend stands alone.
  // Not awaited on purpose: a profile that never mounts `connection` would
  // otherwise leave this apply pending forever.
  let consoleTarget = target
  // A separately mounted performance add-on may already own this process-wide
  // face. Treat any own value (including an unknown descriptor) as occupied;
  // storage and the original console remain independent of optional controls.
  if (target?.preferences !== undefined && !Object.hasOwn(globalThis, PAGE_TRANSFER_POLICY)) {
    const performance = new PerformanceController(target.preferences.host, {
      historyWindow: { supported: true, reason: 'Bounded read-only preview and optional raw JSON page transport; complete recovery and validation remain unchanged.' },
      virtualChat: { supported: true, reason: 'First-follow window on a compatible exact-version Client hook; complete projections and later history paging remain official.' },
    })
    ctx.effect(() => registerPageTransferPolicy(() => performance.read().effective.historyWindow), `${name} page transport policy`)
    const preview = new PreviewReader(target.root, target.settings)
    ctx.inject(['tools'], (toolCtx) => {
      const tools = toolCtx.get('tools') as PerformanceToolRegistry | undefined
      if (tools === undefined) return
      toolCtx.effect(function* () { yield tools.register(createPerformanceTool(performance)) }, `${name} performance controls tool`)
    })
    consoleTarget = { ...target, performance, historyPreview: preview }
    ctx.effect(function* () {
      yield async () => { performance.dispose(); await preview.close() }
    }, `${name} optional performance paths`)
  }
  ctx.inject(['connection'], (consoleCtx) => {
    if (consoleTarget === undefined) return
    registerConsole(consoleCtx, consoleTarget)
  })
  if (!config.ownSearch) return
  // Imported only when a profile asks for it: the query package belongs to the
  // host, and a profile that keeps the released engine must not depend on it.
  const { queryEnginePlugin } = await import('./query-engine.ts')
  ctx.plugin((await queryEnginePlugin()) as never, {} as never)
}

/**
 * Start the read-path warm-up and tie its lifetime to the plugin.
 *
 * Deliberately not awaited: the profile must finish mounting while the warm-up
 * is still yielding between chunks. The disposer stops it and waits for the
 * chunk in flight, and because it is registered after the storage disposers it
 * runs before them — a read still in flight would otherwise meet a closing
 * worker.
 */
function scheduleWarmUp(
  ctx: Context,
  instance: SqliteSessionPersistence | undefined,
  config: Config,
): void {
  if (instance === undefined || config.warmupSessions <= 0) return
  const controller = new AbortController()
  const metrics = instance.metrics
  // The window has to be long enough to cover an open and its first page, and
  // short enough that an idle profile warms within a second of going quiet.
  const quietAfterMs = WARMUP_QUIET_AFTER_MS
  const quiet = (): boolean => {
    const last = metrics.lastObservedAt
    return last === undefined || Date.now() - last >= quietAfterMs
  }
  const running = instance
    .warmUp(config.warmupSessions, controller.signal, quiet)
    .then((report) => {
      ctx.logger.info(
        `${name}: warmed ${String(report.primed)} of ${String(report.scanned)} conversations in ${String(report.elapsedMs)}ms (${String(report.failed)} unreadable, ${String(report.pausedMs)}ms parked)`,
      )
    })
    .catch((error: unknown) => {
      // A warm-up is an optimisation: failing it must not fail the mount.
      ctx.logger.warn(`${name}: warm-up stopped: ${String(error)}`)
    })
  ctx.effect(function* () {
    yield async () => {
      controller.abort()
      await running
    }
  }, `${name} warm-up`)
}

/**
 * Where this plugin keeps state that is not a conversation.
 *
 * An explicit `stateDirectory`, otherwise next to the profile's other state
 * rather than inside the session tree — a bookkeeping record must never look like
 * a conversation, and `scanDatabasePaths` would be the first thing to trip over
 * one. Both the backend catalog and the console preferences live here.
 */
function stateDirectoryOf(config: Config): string {
  return config.stateDirectory === ''
    ? join(dirname(resolve(config.root)), 'session-backends')
    : resolve(config.stateDirectory)
}

/**
 * Formats this install can actually create conversations on.
 *
 * A standalone mount serves one backend, and offering the other would be a switch
 * that silently meant nothing. Hybrid mounts both, so both are offered.
 */
function formatsOf(config: Config): readonly SessionFormat[] {
  // Both are creatable exactly when both backends are mounted, which is the same
  // condition that picks the mixed mount.
  return config.hybrid || config.jsonlRoot !== '' ? ['sqlite', 'jsonl'] : ['sqlite']
}

/** Console view of a standalone (SQLite-only) install. */
async function mountStandalone(
  ctx: Context,
  config: Config,
): Promise<ConsoleConfig | undefined> {
  let service!: Fiber
  let instance: SqliteSessionPersistence | undefined
  ctx.effect(function* () {
    // Registered first so it is disposed LAST: handles must finish draining
    // through the storage executor before the executor (and its worker) goes
    // away. Reversing this order makes a teardown drain await a dead worker.
    yield async () => {
      // The journal writes through the registry, which outlives the storage
      // executor, so it is flushed before the executor teardown drains handles.
      if (instance !== undefined) await detachMetricsJournal(instance.metrics)
      await instance?.closeStorage()
    }
    const tracker = new SqliteBackendTracker(name)
    yield tracker.install(ctx)
    service = ctx.plugin({
      name: `${name}-service`,
      apply(serviceCtx: Context) {
        instance = new SqliteSessionPersistence(serviceCtx, config, tracker)
      },
    })
    yield service.dispose
  }, `${name} resources`)
  await service.await()
  // Registered after the storage effect, so its disposer runs first and stops
  // the reads before the executor goes away.
  scheduleWarmUp(ctx, instance, config)
  if (instance === undefined) return undefined
  const formats = formatsOf(config)
  // Restore bounded measurement history before exposing the latency panel.
  await attachMetricsJournal(instance.metrics, stateDirectoryOf(config))
  // Created here rather than in the console so the saved switches are already in
  // force for the mount itself: `createPreferencesHost` applies what it reads,
  // which is how a "stability fixes off" profile stops sealing from its first
  // append instead of after the operator opens the panel.
  const preferences = createPreferencesHost(
    preferencesPath(stateDirectoryOf(config)),
    formats,
    (saved) => { instance?.applyPreferences(saved) },
  )
  return {
    ...instance.consoleTarget(),
    preferences: { host: preferences, formats },
    about: pluginAbout,
  }
}

/**
 * Mount both backends and put the router on the real `sessionPersistence` key.
 *
 * cordis gives a service key to one registration per context chain, so the two
 * backends are mounted in isolated scopes where the key is free and only the
 * router occupies it. Their trackers register on those scopes and still receive
 * this context's `session/event` events, so live writes reach the backend that
 * owns the session without the router forwarding anything.
 */
async function mountHybrid(
  ctx: Context,
  config: Config,
): Promise<ConsoleConfig | undefined> {
  if (config.jsonlRoot === '') {
    throw new Error(
      `${name}: hybrid mode needs jsonlRoot; point it at the JSONL sessions directory the profile already uses`,
    )
  }
  const prepareMigrationSession = installMigrationRuntime(ctx)
  let jsonl: unknown
  try {
    jsonl = await import('@deepseek-ai/dsh-session-persistence-jsonl')
  } catch (error) {
    throw new Error(
      `${name}: hybrid mode needs @deepseek-ai/dsh-session-persistence-jsonl installed next to this plugin: ${String(error)}`,
    )
  }

  /**
   * Where the backend catalog lives: which backend owns each conversation, plus
   * the console preferences. See `stateDirectoryOf`.
   */
  const stateDirectory = stateDirectoryOf(config)

  const tracker = new SqliteBackendTracker(name)
  let sqliteInstance: SqliteSessionPersistence | undefined

  // Two scopes, one backend each. The labels are symbols so no other plugin can
  // join these scopes by accident, and the real key stays free for the router.
  const sqliteScope = ctx.isolate('sessionPersistence', Symbol(`${name}/sqlite`))
  const jsonlScope = ctx.isolate('sessionPersistence', Symbol(`${name}/jsonl`))
  const sqliteFiber = sqliteScope.plugin({
    name: `${name}-member-sqlite`,
    apply(memberCtx: Context) {
      sqliteInstance = new SqliteSessionPersistence(memberCtx, { ...config, hybrid: false }, tracker)
    },
  })
  const jsonlFiber = jsonlScope.plugin(jsonl as Parameters<Context['plugin']>[0], {
    root: resolve(config.jsonlRoot),
    compression: 'zstd',
  })

  ctx.effect(function* () {
    // Disposed last, like the standalone path: the SQLite member must finish
    // draining through its executor before the executor goes away.
    yield async () => {
      if (sqliteInstance !== undefined) await detachMetricsJournal(sqliteInstance.metrics)
      await sqliteInstance?.closeStorage()
    }
    // The tracker must be installed on the isolated scope the member runs in:
    // a listener there still receives this context's `session/event` events, so
    // live writes reach the backend that owns the session without the router
    // forwarding anything. Without this install nothing ever drains.
    yield tracker.install(sqliteScope)
    yield sqliteFiber.dispose
    yield jsonlFiber.dispose
  }, `${name} hybrid resources`)

  await sqliteFiber.await()
  await jsonlFiber.await()

  const sqliteMember = sqliteScope.get('sessionPersistence') as unknown as
    | SqliteSessionPersistence
    | undefined
  const jsonlMember = jsonlScope.get('sessionPersistence') as unknown as
    | SessionPersistence
    | undefined
  if (sqliteMember === undefined || jsonlMember === undefined) {
    throw new Error(`${name}: hybrid mode could not resolve both member backends`)
  }

  const backends: RoutedBackend[] = [
    { id: 'sqlite', persistence: sqliteMember, label: `${name} (sqlite)` },
    { id: 'jsonl', persistence: jsonlMember, label: '@deepseek-ai/dsh-session-persistence-jsonl' },
  ]
  const routerConfig: { newSessionBackend: SessionBackendId; preference: readonly SessionBackendId[] } = {
    newSessionBackend: config.newSessionBackend,
    preference: ['sqlite', 'jsonl'],
  }

  let catalog = await SessionBackendCatalog.open(stateDirectory)
  if (catalog.size === 0) {
    const rebuilt = await rebuildCatalog(stateDirectory, backends, routerConfig)
    catalog = rebuilt.catalog
    for (const conflict of rebuilt.conflicts) {
      ctx.logger.warn(
        `${name}: session "${conflict.id}" is stored by both backends; routing it to "${conflict.listed}" (also on ${conflict.also.join(', ')})`,
      )
    }
    await catalog.save().catch((error: unknown) => {
      const problem = `${name}: cannot write "${catalog.location}": ${String(error)}`
      ctx.logger.warn(problem)
      recordDiagnostic('error', 'catalog', problem)
    })
  }

  // Constructing the router registers it on the real `sessionPersistence` key.
  new HybridSessionPersistence(ctx, catalog, backends, routerConfig)
  ctx.inject(['tools'], toolCtx => { toolCtx.effect(() => (toolCtx as unknown as { tools: PerformanceToolRegistry }).tools.register(createMigrationHistoryTool())) })
  // A format switch has to reach the router, not just this backend: the router is
  // what decides where a conversation nobody routed yet is created. It holds the
  // same object, and `create()` reads the field per call, so a write here is
  // live — no restart, no rebuild of the catalog.
  sqliteMember.setBackendSwitch((format) => {
    routerConfig.newSessionBackend = format
  })
  const console = sqliteMember.consoleTarget()
  // The history of runs outlives the process that made them: an operator who
  // restarts the harness can still see how yesterday's migration ended, and a run
  // that was cut off reads as failed instead of vanishing. Loaded before the
  // console is registered so its first poll already sees the old runs.
  await attachMigrationJournal(stateDirectory)
  await attachMetricsJournal(sqliteMember.metrics, stateDirectory)
  scheduleWarmUp(ctx, sqliteMember, config)
  const formats = formatsOf(config)
  const preferences = createPreferencesHost(
    preferencesPath(stateDirectory),
    formats,
    (saved) => { sqliteMember.applyPreferences(saved) },
    // Until the operator saves a switch, the panel must report where new
    // conversations actually go. Without this seed an untouched install would
    // read as SQLite (the file defaults) and overwrite `newSessionBackend` two
    // lines later — a profile configured for JSONL would silently store in
    // SQLite while the log claimed otherwise.
    { format: config.newSessionBackend },
  )
  // Logged after the preferences were applied, not before: the line is what an
  // operator reads to learn where the next conversation will land, and a profile
  // that saved "jsonl" would otherwise be reported as "sqlite" until the first
  // switch was made in the panel.
  ctx.logger.info(
    `${name}: hybrid mode, ${catalog.size} routed session(s), catalog "${catalog.location}", new sessions on "${routerConfig.newSessionBackend}"`,
  )
  // The console gets the same two members the router holds, so a migration it
  // starts goes through the engine and updates the catalog the router reads.
  return {
    ...console,
    preferences: { host: preferences, formats },
    about: pluginAbout,
    workspaceMemberships: ids => readWorkspaceMemberships(() => ctx.get('workspaceRegistry') as unknown as MigrationWorkspaceRegistry | undefined, ids),
    migrations: {
      prepareSession: prepareMigrationSession,
      attachClone: cloneWorkspaceAttacher(() => ctx.get('workspaceRegistry') as unknown as MigrationWorkspaceRegistry | undefined),
      catalog,
      sqlite: { id: 'sqlite', root: console.root, persistence: sqliteMember },
      jsonl: { id: 'jsonl', root: resolve(config.jsonlRoot), persistence: jsonlMember, compression: 'zstd' },
    },
  }
}

/** Root scan helper re-exported for the migration CLI. */
export { scanSessions, findDatabasePath, encodeSegment, sessionFormatVersionRefusal }
