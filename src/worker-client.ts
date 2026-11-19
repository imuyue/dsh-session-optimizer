/**
 * Worker-backed executor: sends each storage operation to `worker-entry.ts`.
 *
 * One worker serves the whole backend instance. Requests are matched to replies
 * by `rid`; a worker that dies rejects every in-flight request instead of
 * hanging them, and the next operation spawns a fresh thread. Recovering
 * matters more than it looks: without it a single crash turns "write to disk"
 * into a permanent failure for the rest of the process, which the user
 * experiences as a session that silently stops saving.
 *
 * The worker owns every SQLite connection, so the directory work (create the
 * session directory, look up a database) can ride along as operations too:
 * doing it on this side would put synchronous `mkdir`/`readdir`/`existsSync` on
 * the agent loop, which is exactly the stall this whole design exists to avoid.
 */
import { Worker } from 'node:worker_threads'
import { workerRuntimeExecArgv } from './worker-runtime.ts'

import type { SessionHeader, SessionEvent } from '@deepseek-ai/dsh-session'

import type { LoadedHeader, LoadedSession, LogPage, SqliteSettings } from './database.ts'
import { fromWireError, toWireError, type WireRequest, type WireResponse } from './rpc.ts'
import { PAGED_MIN_EVENTS, assemblePaged, type HeaderBatchEntry, type StorageExecutor } from './executor.ts'
import type { SearchHitRow } from './database.ts'
import { currentPageTransferFormat, type PageTransferFormat } from './page-transfer.ts'
import { registerStoreReleaser } from './store-lease.ts'

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** How many times a dead worker is respawned for one request before giving up. */
const MAX_ATTEMPTS = 3

/**
 * How long a closing worker gets to drop its connections.
 *
 * The polite close lets the worker checkpoint and close its connections, which
 * is worth waiting for — a `terminate` leaves the WAL to be recovered on the
 * next open. But it is a courtesy, not a requirement: a worker stuck inside a
 * long write would otherwise hang plugin teardown, and the host waits on that
 * teardown to shut down. Past this, the thread is killed and recovery does the
 * same job a little slower.
 */
const CLOSE_TIMEOUT_MS = 2000

/**
 * The worker entry sits next to this module. Running from source (`src/*.ts`)
 * and from the build (`lib/*.js`) must both resolve, so mirror the extension of
 * the current module.
 */
function workerSource(): { url: URL; execArgv: string[] } {
  if (!import.meta.url.endsWith('.ts')) {
    return { url: new URL('./worker-entry.js', import.meta.url), execArgv: [] }
  }
  // A worker loads its entry itself, outside vitest's transform pipeline, so
  // node strips the types of the entry's whole import graph. That used to need
  // `--experimental-transform-types` for the parameter properties this code base
  // wrote; those are plain field assignments now, so strip-only is enough and no
  // flag is passed. Node 26 removed the flag outright, and a worker handed an
  // unknown one dies in `spawn` with `invalid execArgv flags`.
  return {
    url: new URL('./worker-entry.ts', import.meta.url),
    execArgv: [],
  }
}

/**
 * Operations that can be replayed after a crash without changing the outcome.
 */
const RETRYABLE = new Set(['loadSession', 'loadHeader', 'trustedLength', 'storedEventCount', 'sizeBytes', 'ensureDirectory', 'findDatabase', 'pagedHeader', 'readPage', 'searchStore', 'indexStore'])

export class WorkerExecutor implements StorageExecutor {
  private worker: Worker | undefined
  private readonly pending = new Map<number, Pending>()
  private rid = 0
  private generation = 0
  private closed = false
  private readonly preparedSessionCacheSize: number

  constructor(preparedSessionCacheSize: number) {
    this.preparedSessionCacheSize = preparedSessionCacheSize
    this.worker = this.spawn()
    this.unregister = registerStoreReleaser(async (path) => { await this.release(path) })
  }

  /**
   * Stop answering the registry on teardown.
   *
   * A closed executor has no worker to ask, and a stale entry would make every
   * later publish wait on a round trip that is rejected anyway.
   */
  private readonly unregister: () => void

  private spawn(): Worker {
    this.generation += 1
    const source = workerSource()
    const worker = new Worker(source.url, {
      workerData: { preparedSessionCacheSize: this.preparedSessionCacheSize },
      execArgv: workerRuntimeExecArgv(source.execArgv),
    })
    worker.on('message', (response: WireResponse) => {
      const entry = this.pending.get(response.rid)
      if (entry === undefined) return
      this.pending.delete(response.rid)
      if (response.ok) entry.resolve(response.value)
      else entry.reject(fromWireError(response.error ?? { name: 'Error', message: 'storage worker failed' }))
    })
    // `error` and `exit` both fire for one crash; `forget` makes the second a
    // no-op so the worker is only accounted for once.
    worker.on('error', (error: unknown) => {
      this.forget(worker, error instanceof Error ? error : new Error(String(error)))
    })
    worker.on('exit', (code: number) => {
      this.forget(worker, new Error(`storage worker exited with code ${String(code)}`))
    })
    return worker
  }

  /**
   * Detach a dead worker. Anything in flight is rejected — or, when the
   * operation is replayable, re-issued on the replacement thread.
   */
  private forget(worker: Worker, error: Error): void {
    if (this.worker !== worker) return
    this.worker = undefined
    const lost = [...this.pending.entries()]
    this.pending.clear()
    for (const [, entry] of lost) entry.reject(error)
  }

  private call<T>(op: string, args: unknown[], attempt = 1, allowClosed = false): Promise<T> {
    // `allowClosed` is for the teardown's own request: `close()` marks the
    // executor closed before it asks the worker to drop its connections, so that
    // nothing routes new work onto a thread that is on its way out.
    if (this.closed && !allowClosed) return Promise.reject(new Error(`storage worker is closed (${op})`))
    // The replacement is stored, not just used: a thread that is spawned here
    // has to be the one `close()` terminates and the one the next call posts to,
    // otherwise every crash leaks a thread and the retry spawns another.
    const worker = this.worker ?? (this.worker = this.spawn())
    const rid = ++this.rid
    const retryable = RETRYABLE.has(op) && attempt < MAX_ATTEMPTS
    return new Promise<T>((resolve, reject) => {
      this.pending.set(rid, {
        resolve: (value) => { resolve(value as T) },
        reject,
      })
      const request: WireRequest = { rid, op, args }
      try {
        worker.postMessage(request)
      } catch (error) {
        this.pending.delete(rid)
        reject(toWireError(error) as unknown as Error)
      }
    }).catch((error: unknown) => {
      // A retry is only justified when the thread itself is gone: the operation
      // never produced an answer, so replaying it cannot apply anything twice.
      // A rejected operation — a corrupt store, a missing file — answered
      // correctly and would answer the same way again, so it is reported as is
      // instead of being replayed until the attempts run out.
      if (this.closed || !retryable || !this.workerLost(worker)) throw error
      return this.call<T>(op, args, attempt + 1)
    })
  }

  /** Did the thread this request was posted to go away? */
  private workerLost(worker: Worker): boolean {
    return this.worker !== worker
  }

  loadSession(
    path: string,
    settings: SqliteSettings,
    window?: { offset: number; length: number },
  ): Promise<LoadedSession | undefined> {
    return this.call<LoadedSession | undefined>('loadSession', [path, settings, window])
  }

  loadHeader(path: string, settings: SqliteSettings): Promise<LoadedHeader | undefined> {
    return this.call<LoadedHeader | undefined>('loadHeader', [path, settings])
  }

  /**
   * Read a long log a page at a time and parse each page here.
   *
   * This is the one place the worker boundary is worth paying attention to: a
   * whole-log reply has to clone every decoded event onto this heap (860ms on
   * 47k events), while a page reply carries a transferred buffer that costs
   * nothing to hand over and is parsed while the next page is being read.
   */
  async loadSessionPaged(
    path: string,
    settings: SqliteSettings,
    signal?: AbortSignal,
  ): Promise<LoadedSession | undefined> {
    const meta = await this.pagedHeader(path, settings)
    if (meta === undefined || meta.eventCount < PAGED_MIN_EVENTS) return undefined
    // Same reasoning as InlineExecutor.loadSessionPaged: a whole log is consumed
    // as lines, so asking the worker for bytes would only make this thread split
    // them again. The strings clone across the boundary faster than the 34MB
    // buffer they were cut from, and nothing is decoded on this side.
    return assemblePaged(path, meta, (from, to) => this.readPage(path, settings, from, to, 'lines'), signal)
  }

  pagedHeader(path: string, settings: SqliteSettings): Promise<LoadedHeader | undefined> {
    return this.call<LoadedHeader | undefined>('pagedHeader', [path, settings])
  }

  readPage(
    path: string,
    settings: SqliteSettings,
    from: number,
    to: number,
    format: PageTransferFormat = currentPageTransferFormat(),
  ): Promise<LogPage | undefined> {
    return this.call<LogPage | undefined>('readPage', [path, settings, from, to, format])
  }

  trustedLength(path: string, settings: SqliteSettings): Promise<number | undefined> {
    return this.call<number | undefined>('trustedLength', [path, settings])
  }

  storedEventCount(path: string, settings: SqliteSettings): Promise<number> {
    return this.call<number>('storedEventCount', [path, settings])
  }

  listHeaders(paths: readonly string[], settings: SqliteSettings): Promise<HeaderBatchEntry[]> {
    return this.call<HeaderBatchEntry[]>('listHeaders', [paths, settings])
  }

  appendBatch(
    path: string,
    settings: SqliteSettings,
    header: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
    inheritedEventCount: number,
  ): Promise<void> {
    return this.call<void>('appendBatch', [
      path,
      settings,
      header,
      events,
      isMaterialized,
      inheritedEventCount,
    ])
  }

  materializeHeader(
    path: string,
    settings: SqliteSettings,
    header: SessionHeader,
    inheritedEventCount: number,
  ): Promise<void> {
    return this.call<void>('materializeHeader', [path, settings, header, inheritedEventCount])
  }

  truncateTail(path: string, settings: SqliteSettings, truncateTo: number): Promise<void> {
    return this.call<void>('truncateTail', [path, settings, truncateTo])
  }

  ensureDirectory(path: string): Promise<void> {
    return this.call<void>('ensureDirectory', [path])
  }

  findDatabase(root: string, id: string): Promise<string | undefined> {
    return this.call<string | undefined>('findDatabase', [root, id])
  }

  searchStore(
    path: string,
    settings: SqliteSettings,
    match: string,
    limit: number,
  ): Promise<SearchHitRow[] | undefined> {
    return this.call<SearchHitRow[] | undefined>('searchStore', [path, settings, match, limit])
  }

  indexStore(path: string, settings: SqliteSettings): Promise<boolean> {
    return this.call<boolean>('indexStore', [path, settings])
  }

  sizeBytes(path: string, settings: SqliteSettings): Promise<number> {
    // The settings travel with the request because the wire shape is shared with
    // the inline executor; the handler only stats the file.
    return this.call<number>('sizeBytes', [path, settings])
  }

  /**
   * Let go of one store so it can be renamed or unlinked.
   *
   * The connection lives on the worker thread, so the release has to travel
   * there; a terminate would also work but would cost the whole worker (and the
   * other conversations it is serving) for one file. Deliberately not retryable:
   * a worker that died took its handles with it, which is the state the caller
   * wanted.
   */
  release(path: string): Promise<void> {
    return this.call<void>('forget', [path])
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.unregister()
    // Marked closed before the round trip, not after: `call()` checks this flag,
    // and the wait below can last as long as CLOSE_TIMEOUT_MS, during which a
    // caller would otherwise queue work onto a worker that is being torn down.
    this.closed = true
    const worker = this.worker
    if (worker !== undefined) {
      // Let the worker drop its connections first; a terminate leaves the WAL
      // to be recovered on the next open, which is correct but slower. Bounded,
      // because the host waits on this teardown to exit and a worker parked in a
      // long write must not be able to hold the process open.
      await Promise.race([
        this.call<void>('close', [], 1, true).catch(() => undefined),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS)
          // Never keep the process alive just for this timer.
          timer.unref?.()
        }),
      ])
    }
    // `call('close')` may have witnessed a crash and left `this.worker` empty;
    // the thread captured before the call is still the one to terminate.
    const live = worker ?? this.worker
    if (live !== undefined) this.forget(live, new Error('storage worker is closed'))
    await worker?.terminate().catch(() => undefined)
    await this.worker?.terminate().catch(() => undefined)
    this.worker = undefined
  }
}
