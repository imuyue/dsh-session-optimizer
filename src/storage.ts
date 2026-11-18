/**
 * Handle lifecycle and in-process bookkeeping.
 *
 * The shape here mirrors the official JSONL backend on purpose: one promise
 * chain per handle, a bounded live-write buffer with a fixed window that later
 * events never reset, and a single-flight drain. The live-write contract test
 * drives exactly these semantics, so deviating means failing it.
 *
 * @module dsh-session-optimizer/storage
 */

import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  SessionLogOffset,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
  type SessionSeedEventState,
} from '@deepseek-ai/dsh-session'
import {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionHandleClosedError,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  SessionPersistenceCorruptionError,
  SessionReadOnlyError,
  assertContiguous,
  materializeAppendBatch,
  type SessionAccess,
  type SessionHandle,
  type SessionHandleAppendOptions,
  type SessionHandleFlushOptions,
  type SessionHandleReadOptions,
  type SessionHandleReadResult,
} from '@deepseek-ai/dsh-session-persistence'
import type { LoadedSession } from './database.ts'
import { DATABASE_FILENAME, encodeSegment } from './format.ts'
import type { SessionWriteLease } from './lease.ts'

/** Default fixed batching window for live events, in milliseconds. */
export const DEFAULT_WRITE_BATCH_MAX_DELAY_MS = 200

/**
 * Copy one live event for the write buffer.
 *
 * `materializeAppendBatch` deep-copies the whole batch again when the drain
 * runs, and *that* copy is the one that gets validated and stored. The clone
 * here therefore only has to stop the producer from mutating what it already
 * handed over, which is exactly what `structuredClone` guarantees — so it stays
 * the honest choice and the double copy is accepted rather than approximated
 * with a hand-written walker that could disagree with it on Map/Date/typed
 * arrays.
 */

/** What a handle needs from the service; the service is also the test seam. */
export interface SqliteHandleStorage {
  persistBatch(
    header: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
    inheritedEventCount: number,
  ): Promise<void>
  persistHeader(header: SessionHeader, inheritedEventCount: number): Promise<void>
  truncateTornTail(header: SessionHeader, truncateTo: number): Promise<void>
  /**
   * Load the log. A handle passes the slice it is about to return, so the
   * executor decodes only those rows; `LoadedSession.eventCount` still reports
   * the length of the committed prefix.
   *
   * A caller that already knows where the session lives passes `path`, which
   * spares the directory scan `findDatabasePath` would otherwise run on every
   * read.
   */
  readStoredLog(
    id: SessionId,
    signal?: AbortSignal,
    window?: { offset: number; length: number },
    path?: string,
  ): Promise<LoadedSession | undefined>
  hasPendingSession(id: SessionId): boolean
  acquireWriteLease(header: SessionHeader): Promise<SessionWriteLease>
  releaseHandle(handle: SessionHandle, materialized: boolean): void
}

/** Per-handle storage state; `materialized` means "the row exists on disk". */
export interface SqliteHandleState {
  cursor: number
  materialized: boolean
  tornTruncateTo?: number | undefined
  inheritedEventCount: number
  /**
   * Where this session is stored, once known. Carrying it means `read()` does
   * not rescan the root for every call; a handle that has not materialized yet
   * has no file and simply omits it.
   */
  path?: string | undefined
}

/** Normalize a rejection value so `close()` can report something readable. */
function errorChain(value: unknown): string {
  if (value instanceof Error) return value.message
  return String(value)
}

/**
 * One handle on one session. Reads always come from disk (a read handle has no
 * ownership), appends go through the chain, and live events are buffered.
 */
export class SqliteSessionHandle implements SessionHandle {
  private chain: Promise<unknown> = Promise.resolve()
  private closing: Promise<void> | undefined
  private observedLength = 0
  private buffered: SessionEvent[] = []
  private batchTimer: NodeJS.Timeout | undefined
  /**
   * Set when a background drain failed.
   *
   * The contract's live-write suite requires this: a failure quiets the timer, so
   * a broken disk is not retried in a loop by the timer alone, and the events
   * stay retained in order. `flush()` is the barrier that retries them, which is
   * what makes the state recoverable rather than terminal.
   */
  private drainPaused = false
  private draining: Promise<void> | undefined
  private lease: SessionWriteLease | undefined
  private readonly storage: SqliteHandleStorage
  readonly id: SessionId
  readonly header: SessionHeader
  readonly access: SessionAccess
  private readonly state: SqliteHandleState
  private readonly batchDelayMs: number

  constructor(
    storage: SqliteHandleStorage,
    id: SessionId,
    header: SessionHeader,
    access: SessionAccess,
    state: SqliteHandleState,
    batchDelayMs: number = DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
    lease?: SessionWriteLease,
  ) {
    this.storage = storage
    this.id = id
    this.header = header
    this.access = access
    this.state = state
    this.batchDelayMs = batchDelayMs
    this.observedLength = state.cursor
    // A write open already holds the cross-process lock; reusing it keeps the
    // handle from flocking the same file twice (which always reports contention
    // against our own descriptor).
    this.lease = lease
  }

  get inheritedEventCount(): SessionLogOffset {
    return SessionLogOffset(this.state.inheritedEventCount)
  }

  async read(
    offset = 0,
    length = Number.MAX_SAFE_INTEGER,
    options?: SessionHandleReadOptions,
  ): Promise<SessionHandleReadResult> {
    this.assertOpen('read')
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError(`read offset must be a non-negative safe integer, got ${String(offset)}`)
    }
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new TypeError(`read length must be a non-negative safe integer, got ${String(length)}`)
    }
    options?.signal?.throwIfAborted()
    if (this.access === 'write' && !this.state.materialized) {
      return { eventState: 'detached', events: [] }
    }
    // Ask only for the slice being returned. The executor still reports the
    // committed prefix length (`eventCount`), which is what the freshness check
    // below needs — it no longer has to decode the whole log to find out.
    // `state.path` is known as soon as the handle is created (create() computes
    // it, open() resolved it), so a read goes straight to the file instead of
    // rescanning the root for every call.
    // `read(0)` with no length means the whole log, and saying so is what lets
    // a long conversation be read in pages: a window that covers everything is
    // routed back through the whole-log path, where the page read lives. Asking
    // for `[0, MAX_SAFE_INTEGER)` instead would take the sliced path and decode
    // the log in one piece — measured 1.5s against 0.9s for the same events.
    const whole = offset === 0 && length === Number.MAX_SAFE_INTEGER
    const source = await this.storage.readStoredLog(
      this.id,
      options?.signal,
      whole ? undefined : { offset, length },
      this.state.path,
    )
    if (source === undefined) {
      if (this.storage.hasPendingSession(this.id)) {
        return { eventState: 'detached', events: [] }
      }
      throw new SessionPersistenceNotFoundError(this.id)
    }
    if (source.eventCount < this.observedLength) {
      throw new Error(
        `session "${this.id}": stored log shrank below a previously observed prefix (${source.eventCount} < ${this.observedLength})`,
      )
    }
    this.observedLength = source.eventCount
    this.state.path ??= source.path
    // A windowed read only decodes the slice it returns, so a bad row outside
    // the window is invisible to it. Report what this read actually proved: the
    // returned slice was validated, nothing more. `eventState` therefore stays
    // `detached` (the handle does not own the log) and `tornTruncateTo` is left
    // to the full reads (`open()`), which is where the tail is discovered.
    const eventState: SessionSeedEventState = 'detached'
    return { eventState, events: source.events }
  }

  async append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void> {
    this.assertOpen('append')
    // Validate and deep-snapshot before queueing so the checked value is exactly
    // the value that reaches the database.
    const batch = materializeAppendBatch(events)
    return this.run('append', async () => {
      options?.signal?.throwIfAborted()
      await this.persistContiguous(batch)
    })
  }

  async flush(options?: SessionHandleFlushOptions): Promise<void> {
    this.assertOpen('flush')
    options?.signal?.throwIfAborted()
    if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'flush')
    // Live events sit in `buffered` until the batch timer fires, so a flush that
    // only wrote the header would return while events the caller already handed
    // over are still in memory — and the caller treats a resolved flush as
    // "everything so far is on disk". The drain has to happen before this call
    // joins the chain, not inside it: draining goes through the same chain, so a
    // flush waiting in the chain for its own drain would wait for itself.
    await this.drainLive()
    return this.run('flush', async () => {
      options?.signal?.throwIfAborted()
      if (this.state.materialized) return
      await this.ensureLease()
      await this.storage.persistHeader(this.header, this.state.inheritedEventCount)
      this.state.materialized = true
    })
  }

  close(): Promise<void> {
    return (this.closing ??= (async () => {
      let drainFailure: unknown
      for (;;) {
        try {
          await this.drainLive()
        } catch (error) {
          drainFailure = error
          break
        }
        await this.chain
        if (this.buffered.length === 0) break
      }
      await this.chain
      const failures: Error[] = []
      if (drainFailure !== undefined) {
        failures.push(drainFailure instanceof Error ? drainFailure : new Error(errorChain(drainFailure)))
      }
      try {
        await this.lease?.release()
      } catch (releaseFailure) {
        failures.push(
          releaseFailure instanceof Error ? releaseFailure : new Error(errorChain(releaseFailure)),
        )
      }
      this.storage.releaseHandle(this, this.state.materialized)
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          `session "${this.id}": close failed to drain and to release its write lock`,
        )
      }
      const [first] = failures
      if (first !== undefined) throw first
    })())
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }

  /** Queue a live event; the window starts at the first event and never resets. */
  enqueueLive(event: SessionEvent, reportBackgroundFailure: (error: unknown) => void): void {
    this.buffered.push(structuredClone(event))
    if (this.batchTimer !== undefined) return
    if (this.drainPaused) return
    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined
      this.drainLive().catch(reportBackgroundFailure)
    }, this.batchDelayMs)
  }

  private clearTimer(): void {
    if (this.batchTimer === undefined) return
    clearTimeout(this.batchTimer)
    this.batchTimer = undefined
  }

  /** Single-flight drain of the live buffer. */
  drainLive(): Promise<void> {
    return (this.draining ??= this.drainBuffered().finally(() => {
      this.draining = undefined
    }))
  }

  private async drainBuffered(): Promise<void> {
    this.clearTimer()
    this.drainPaused = false
    while (this.buffered.length > 0) {
      await this.enqueueChain(async () => {
        const batch = this.buffered.splice(0)
        try {
          await this.persistContiguous(materializeAppendBatch(batch))
        } catch (error) {
          // Retain the failed batch in front of anything buffered meanwhile and
          // stop here: retrying immediately on a broken disk would spin. The
          // pause is lifted by the next explicit `flush()` or by `close()`, both
          // of which go through `drainBuffered`.
          this.buffered = batch.concat(this.buffered)
          this.drainPaused = true
          // An event that arrived while this drain was in flight armed a timer
          // of its own. Left alone it would fire against a paused drain, lift the
          // pause in `drainBuffered` and retry the write the failure had just
          // suppressed — the contract wants the automatic path quiet until an
          // explicit barrier (`flush` or `close`) asks again.
          this.clearTimer()
          throw error
        }
      })
    }
  }

  private async persistContiguous(batch: readonly SessionEvent[]): Promise<void> {
    if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'append')
    if (batch.length === 0) return
    await this.ensureLease()
    assertContiguous(this.id, batch, this.state.cursor)
    if (this.state.tornTruncateTo !== undefined) {
      await this.storage.truncateTornTail(this.header, this.state.tornTruncateTo)
      this.state.tornTruncateTo = undefined
    }
    await this.storage.persistBatch(
      this.header,
      batch,
      this.state.materialized,
      this.state.inheritedEventCount,
    )
    this.state.materialized = true
    this.state.cursor += batch.length
    this.observedLength = this.state.cursor
  }

  private async ensureLease(): Promise<void> {
    this.lease ??= await this.storage.acquireWriteLease(this.header)
  }

  private enqueueChain<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation)
    this.chain = next.catch(() => undefined)
    return next
  }

  private async run(operation: string, body: () => Promise<void>): Promise<void> {
    this.assertOpen(operation)
    return this.enqueueChain(async () => {
      this.assertOpen(operation)
      await body()
    })
  }

  private assertOpen(operation: string): void {
    if (this.closing !== undefined) throw new SessionHandleClosedError(this.id, operation)
  }
}

/** A created session that has not reached disk yet. */
export interface PendingSession {
  readonly header: SessionHeader
  readonly revision: SessionPersistenceRevision
  readonly inheritedEventCount: SessionLogOffset
}

/**
 * In-process registry: which sessions this instance has created but not yet
 * materialized, and which handle currently owns each write.
 */
export class SqliteBackendTracker {
  readonly openHandles = new Set<SessionHandle>()
  private readonly writers = new Map<SessionId, SqliteSessionHandle | null>()
  private readonly pending = new Map<SessionId, PendingSession>()
  private counter = 0
  readonly name: string

  constructor(name: string) {
    this.name = name
  }

  hasPending(id: SessionId): boolean {
    return this.pending.has(id)
  }

  pendingOf(id: SessionId): PendingSession | undefined {
    return this.pending.get(id)
  }

  pendingEntries(): PendingSession[] {
    return [...this.pending.values()]
  }

  /** Remember a freshly created session; also claims the write slot. */
  registerCreated(header: SessionHeader, inheritedEventCount: number): void {
    if (this.writers.has(header.id)) throw new SessionAlreadyExistsError(header.id)
    this.writers.set(header.id, null)
    this.counter += 1
    this.pending.set(header.id, {
      header,
      revision: SessionPersistenceRevision(`memory:${this.name}:${this.counter}`),
      inheritedEventCount: SessionLogOffset(inheritedEventCount),
    })
  }

  claimWrite(id: SessionId): void {
    if (this.writers.has(id)) throw new SessionAlreadyOwnedError(id)
    this.writers.set(id, null)
  }

  releaseClaim(id: SessionId): void {
    this.writers.delete(id)
  }

  /** The session reached disk, so it is no longer pending. */
  materialized(id: SessionId): void {
    this.pending.delete(id)
  }

  adopt<T extends SessionHandle>(handle: T): T {
    this.openHandles.add(handle)
    if (handle.access === 'write') this.writers.set(handle.id, handle as unknown as SqliteSessionHandle)
    return handle
  }

  release(handle: SessionHandle, materialized: boolean): void {
    this.openHandles.delete(handle)
    if (handle.access !== 'write') return
    // Only the handle that owns the slot may free it: a late `release` from a
    // handle whose slot was already reclaimed must not evict the writer that
    // took its place, or that writer's buffered events lose their owner.
    if (this.writers.get(handle.id) === handle) this.writers.delete(handle.id)
    if (!materialized) this.pending.delete(handle.id)
  }

  /** Flush every active writer; a handle already closing counts as flushed. */
  async flushAll(): Promise<void> {
    const errors: unknown[] = []
    for (const writer of [...this.writers.values()]) {
      if (writer === null) continue
      try {
        // `flush()` drains the live buffer itself, before it joins the chain;
        // draining here as well would repeat the pass for nothing.
        await writer.flush()
      } catch (error) {
        if (error instanceof SessionHandleClosedError) continue
        errors.push(error)
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, `${this.name} flush failed`)
  }

  /**
   * Route published events, flushes and disposal into the owning handle. The
   * disposer closes every handle still open, then reports what failed.
   */
  install(ctx: Context): () => Promise<void> {
    return ctx.effect(function* (this: SqliteBackendTracker) {
      yield async () => {
        const failures: unknown[] = []
        for (const handle of [...this.openHandles]) {
          try {
            await handle.close()
          } catch (error) {
            failures.push(error)
          }
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, `${this.name} dispose failed`)
        }
      }
      yield ctx.on('session/event', (session, event) => {
        const writer = this.writers.get(session.id as SessionId)
        if (writer === null || writer === undefined) return
        writer.enqueueLive(event, (error) => {
          ctx.logger.warn(
            `${this.name}: background write for session "${session.id}" failed (buffered events retained): ${String(error)}`,
          )
        })
      })
      yield ctx.on('session/flush', (session) => {
        const writer = this.writers.get(session.id as SessionId)
        if (writer === null || writer === undefined) return undefined
        // `flush()` is the barrier: it drains first, then materializes.
        return writer.flush()
      })
      yield ctx.on('session/disposed', (session) => {
        const writer = this.writers.get(session.id as SessionId)
        if (writer === null || writer === undefined) return
        writer.close().catch((error: unknown) => {
          ctx.logger.warn(
            `${this.name}: final drain for session "${session.id}" failed: ${String(error)}`,
          )
        })
      })
    }.bind(this), `${this.name} live routing and open handles`) as unknown as () => Promise<void>
  }
}

/**
 * Locate every stored database under `root`.
 *
 * Session directory names are escapes (`encodeSegment`), so they are returned
 * as `directory`, not as an id: the header stored inside the database is the
 * only authority on which session a file holds.
 */
export async function scanSessions(root: string): Promise<Array<{ directory: string; path: string }>> {
  const found: Array<{ directory: string; path: string }> = []
  let projectDirs: string[]
  try {
    projectDirs = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return found
  }
  for (const project of projectDirs) {
    let sessionDirs: string[]
    try {
      sessionDirs = (await readdir(join(root, project), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      continue
    }
    for (const session of sessionDirs) {
      const path = join(root, project, session, DATABASE_FILENAME)
      if (existsSync(path)) found.push({ directory: session, path })
    }
  }
  return found
}

/** Find the one database for `id` by scanning the root, as the contract requires. */
export async function findDatabasePath(
  root: string,
  id: SessionId,
): Promise<string | undefined> {
  const segment = encodeSegment(id)
  let found: string | undefined
  let projectDirs: string[]
  try {
    projectDirs = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return undefined
  }
  for (const project of projectDirs) {
    const candidate = join(root, project, segment, DATABASE_FILENAME)
    if (!existsSync(candidate)) continue
    if (found !== undefined && found !== candidate) {
      throw new SessionPersistenceCorruptionError(
        `session "${id}" is stored more than once ("${found}" and "${candidate}")`,
        {},
      )
    }
    found = candidate
  }
  return found
}
