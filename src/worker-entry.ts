/**
 * Worker-thread entry point: owns every SQLite connection.
 *
 * The agent loop only ever awaits a message round trip, so a multi-millisecond
 * append transaction — or a `synchronous=FULL` fsync — no longer blocks event
 * delivery. Requests are handled sequentially per message, which preserves the
 * per-session ordering the handle chain already enforces.
 */
import { parentPort, workerData, type Transferable } from 'node:worker_threads'

import type { SessionId } from '@deepseek-ai/dsh-session'

import { ensureSessionDirectory } from './database.ts'
import { InlineExecutor } from './executor.ts'
import { toWireError, type WireRequest, type WireResponse } from './rpc.ts'
import type { SqliteSettings } from './database.ts'
import { findDatabasePath } from './storage.ts'

interface WorkerInit {
  preparedSessionCacheSize: number
}

const init = workerData as WorkerInit
const executor = new InlineExecutor(init.preparedSessionCacheSize)

type Handler = (...args: never[]) => Promise<unknown>

const handlers: Record<string, Handler> = {
  loadSession: (
    path: string,
    settings: SqliteSettings,
    window?: { offset: number; length: number },
  ) => executor.loadSession(path, settings, window),
  loadHeader: (path: string, settings: SqliteSettings) => executor.loadHeader(path, settings),
  trustedLength: (path: string, settings: SqliteSettings) =>
    executor.trustedLength(path, settings),
  storedEventCount: (path: string, settings: SqliteSettings) =>
    executor.storedEventCount(path, settings),
  // One message for a whole listing: a root with 200 stores would otherwise pay
  // 200 round trips, which measured slower than the SQL itself.
  listHeaders: (paths: readonly string[], settings: SqliteSettings) =>
    executor.listHeaders(paths, settings),
  appendBatch: (
    path: string,
    settings: SqliteSettings,
    header: never,
    events: never,
    isMaterialized: boolean,
    inheritedEventCount: number,
  ) => executor.appendBatch(path, settings, header, events, isMaterialized, inheritedEventCount),
  materializeHeader: (
    path: string,
    settings: SqliteSettings,
    header: never,
    inheritedEventCount: number,
  ) => executor.materializeHeader(path, settings, header, inheritedEventCount),
  truncateTail: (path: string, settings: SqliteSettings, truncateTo: number) =>
    executor.truncateTail(path, settings, truncateTo),
  sizeBytes: (path: string, settings: SqliteSettings) => executor.sizeBytes(path, settings),
  // Directory work stays off the agent loop for the same reason the SQL does:
  // both are synchronous `node:fs` calls that can block on a slow disk.
  ensureDirectory: (path: string) => {
    ensureSessionDirectory(path)
    return Promise.resolve()
  },
  searchStore: (path: string, settings: SqliteSettings, match: string, limit: number) =>
    executor.searchStore(path, settings, match, limit),
  indexStore: (path: string, settings: SqliteSettings) => executor.indexStore(path, settings),
  findDatabase: (root: string, id: string) => findDatabasePath(root, id as SessionId),
  /**
   * The paged read's two halves.
   *
   * A long log is handed over page by page instead of as one object graph: the
   * reply carries a buffer that is transferred rather than copied, and the
   * caller parses it while the next page is being read here.
   */
  pagedHeader: (path: string, settings: SqliteSettings) =>
    Promise.resolve(executor.pagedHeader(path, settings)),
  readPage: (path: string, settings: SqliteSettings, from: number, to: number) =>
    Promise.resolve(executor.readPage(path, settings, from, to)),
  close: () => executor.close(),
}

/**
 * Buffers a reply should hand over instead of copy.
 *
 * A page is the one reply whose payload is measured in megabytes, so it is moved
 * to the caller's heap rather than cloned into it. Only a view that owns its
 * whole buffer can be transferred — detaching a subarray would take the rest of
 * its backing store with it.
 */
function transferListOf(value: unknown): Transferable[] {
  if (value === null || typeof value !== 'object') return []
  const bytes = (value as { bytes?: unknown }).bytes
  if (!(bytes instanceof Uint8Array)) return []
  if (bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength) return []
  return [bytes.buffer as ArrayBuffer]
}

parentPort?.on('message', (request: WireRequest) => {
  const handler = handlers[request.op]
  void (async (): Promise<WireResponse> => {
    if (handler === undefined) {
      return {
        rid: request.rid,
        ok: false,
        error: { name: 'Error', message: `unknown storage operation "${request.op}"` },
      }
    }
    try {
      const value = await handler(...(request.args as never[]))
      return { rid: request.rid, ok: true, value }
    } catch (error) {
      return { rid: request.rid, ok: false, error: toWireError(error) }
    }
  })().then(
    (response) => {
      try {
        parentPort?.postMessage(
          response,
          transferListOf(response.ok ? response.value : undefined),
        )
      } catch (error) {
        // A reply that cannot be cloned (or a port that closed mid-flight) must
        // not take the thread down: the caller only hangs if we say nothing.
        parentPort?.postMessage({
          rid: request.rid,
          ok: false,
          error: { name: 'Error', message: `storage worker could not return the result: ${String(error)}` },
        })
      }
    },
    (error: unknown) => {
      // The async body above never rejects, but a throw in the try's own
      // bookkeeping must still answer instead of leaving the caller waiting.
      try {
        parentPort?.postMessage({ rid: request.rid, ok: false, error: toWireError(error) })
      } catch {
        // nothing left to answer on
      }
    },
  )
})
