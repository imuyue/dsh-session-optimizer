/**
 * Warm the read path before the operator asks for it.
 *
 * Opening a conversation is fast because the header is small, but the first page
 * of history is not: it has to locate the frame that holds the tail, fetch it,
 * decompress it and parse it, and on a long conversation that is the difference
 * between an instant panel and a second of waiting. The work is unavoidable —
 * what can change is *when* it happens.
 *
 * Two costs are warmed here, and both are per-store:
 *
 * 1. The header cache behind `list()`. A picker opens the same root repeatedly;
 *    priming it turns the first refresh after a start into a `stat` per store.
 * 2. The tail window of the most recently used conversations — the page a GUI
 *    shows on open — which also lands the store in the executor's connection
 *    cache and its frames in the store's byte-bounded frame cache.
 *
 * The whole thing is **chunked and yields between chunks**. A warm-up that runs
 * to completion in one turn would stall the agent loop for exactly as long as the
 * reads it is trying to avoid, which is the failure mode this exists to prevent:
 * the upstream fault this borrows from blocked for twenty minutes folding
 * projections synchronously, because a loop over a large log never returned to
 * the event loop.
 *
 * Nothing here is authoritative: every value read is an ordinary read, the report
 * counts what happened, and a failure is a number rather than an exception — a
 * store that cannot be warmed is one that will be read cold later, not a reason
 * to fail a mount.
 *
 * @module dsh-session-optimizer/warmup
 */

import { existsSync, statSync } from 'node:fs'

import type { SqliteSettings } from './database.ts'
import type { StorageExecutor } from './executor.ts'
import { scanSessions } from './storage.ts'

/** How many events the tail window primes; the history page asks for 500 at most. */
const TAIL_EVENTS = 100

/** Stores per turn of the loop, between yields. */
const STORES_PER_CHUNK = 8

/** What the warm-up did, for the console and the log. */
export interface WarmupReport {
  /** Stores found under the root. */
  readonly scanned: number
  /** Headers answered from the batch read (including ones already cached). */
  readonly headers: number
  /** Conversations whose tail window was decoded. */
  readonly primed: number
  /** Stores whose search index was built or confirmed complete. */
  readonly indexed: number
  /** Stores that could not be read; they simply stay cold. */
  readonly failed: number
  /** End-to-end time, including the yields. */
  readonly elapsedMs: number
  /** How long the loop spent parked because the application was busy. */
  readonly pausedMs: number
}

/** Bound on how much is warmed, so a huge root cannot turn this into a crawl. */
export interface WarmupOptions {
  readonly root: string
  readonly settings: SqliteSettings
  readonly executor: StorageExecutor
  /** Most recently used conversations whose tail is decoded. Defaults to 5. */
  readonly sessions?: number
  /** Stores per yield. Defaults to 8. */
  readonly batch?: number
  /** Build the search index of the newest conversations too. Defaults to true. */
  readonly indexSearch?: boolean
  /** Stop early (plugin teardown, a newer request); partial work is kept. */
  readonly signal?: AbortSignal
  /**
   * Whether the application is idle right now.
   *
   * A warm-up is work the operator did not ask for, so it must lose every race
   * against work they did: while a request is in flight the loop parks itself and
   * resumes once the app goes quiet again. Absent means "never busy", which is
   * what a headless profile or a test wants.
   */
  readonly quiet?: (() => boolean) | undefined
  /** How long to keep re-checking `quiet` before giving up and staying paused. */
  readonly waitStepMs?: number
  /**
   * How long the loop may spend parked before it gives up for this run.
   *
   * A busy application is not an error, but parking without a limit would mean a
   * warm-up that never finishes and a teardown that waits for it. Past this
   * budget the run simply ends with what it has, and the next mount tries again.
   */
  readonly pauseBudgetMs?: number
}

/** How often a parked warm-up re-checks whether the app is idle. */
const DEFAULT_WAIT_STEP_MS = 100

/** How long a run may stay parked in total before it stops for this mount. */
const DEFAULT_PAUSE_BUDGET_MS = 30_000

/** Yield to the event loop. */
function breathe(ms = 0): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Whether the caller asked to stop. */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/**
 * Park until the application is idle, the signal aborts, or the budget is spent.
 *
 * Polling rather than an event: the warm-up is the only consumer, the check is a
 * boolean read, and a subscription would have to be torn down on every abort
 * path. A hundred milliseconds of slack is invisible next to the decode this is
 * deferring.
 */
async function waitForQuiet(options: WarmupOptions, signal: AbortSignal | undefined, until: number): Promise<void> {
  const quiet = options.quiet
  if (quiet === undefined) return
  const step = Math.max(1, Math.trunc(options.waitStepMs ?? DEFAULT_WAIT_STEP_MS))
  while (!quiet()) {
    if (aborted(signal) || Date.now() >= until) return
    await breathe(step)
  }
}

/** Modification time, or 0 when the file vanished between scan and now. */
function touchedAt(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Prime headers for the whole root and tail windows for the newest stores.
 *
 * Ordering is by file modification time rather than by header `updatedAt`,
 * because the whole point is to avoid opening every store to decide which ones
 * to open. Modification time moves on every commit, so it ranks "which
 * conversation did the operator touch last" correctly for a warm start.
 */
export async function warmRecentSessions(options: WarmupOptions): Promise<WarmupReport> {
  const startedAt = Date.now()
  const sessions = Math.max(0, Math.trunc(options.sessions ?? 5))
  const batch = Math.max(1, Math.trunc(options.batch ?? STORES_PER_CHUNK))
  const found = (await scanSessions(options.root)).map((entry) => ({
    path: entry.path,
    at: touchedAt(entry.path),
  }))
  found.sort((left, right) => right.at - left.at)

  let headers = 0
  let failed = 0
  let primed = 0
  let indexed = 0
  let pausedMs = 0
  let stopped = aborted(options.signal)
  const pauseUntil = startedAt + Math.max(0, Math.trunc(options.pauseBudgetMs ?? DEFAULT_PAUSE_BUDGET_MS))

  /**
   * Park while the app is busy, charging the wait to `pausedMs`.
   *
   * Returns false when the run must stop: the budget is spent, so the rest of the
   * root stays cold until the next mount. Returning "stop" rather than looping for
   * ever is what keeps a permanently busy profile from pinning a warm-up nobody
   * will ever benefit from.
   */
  const yieldTurn = async (): Promise<boolean> => {
    const before = Date.now()
    await waitForQuiet(options, options.signal, pauseUntil)
    await breathe()
    pausedMs += Date.now() - before
    if (aborted(options.signal)) return false
    // Only a *parking* run can exceed the budget, and only when it stayed parked:
    // a quiet profile finishes far inside it.
    if (options.quiet !== undefined && Date.now() >= pauseUntil && !options.quiet()) return false
    return true
  }

  for (let index = 0; index < found.length; index += batch) {
    if (stopped) break
    if (!(await yieldTurn())) break
    const chunk = found.slice(index, index + batch)
    let entries
    try {
      entries = await options.executor.listHeaders(
        chunk.map((entry) => entry.path),
        options.settings,
      )
    } catch {
      // A batch read that throws says nothing about which store did it, so the
      // whole chunk is counted as cold rather than attributed to one file.
      failed += chunk.length
      stopped = aborted(options.signal)
      continue
    }
    for (const entry of entries) {
      if (entry.header === undefined) failed += 1
      else headers += 1
    }
    stopped = aborted(options.signal)
  }

  // The tail of the newest conversations: the page the GUI shows on open. Each
  // store is opened and left in the executor's cache, so the read that follows
  // reuses the connection and, with luck, the frames.
  for (const entry of found.slice(0, sessions)) {
    if (stopped) break
    if (!(await yieldTurn())) break
    // A store deleted between the scan and this moment stays deleted. Opening its
    // path would initialize a fresh empty store there — a write-side open creates
    // the file — and the operator's deleted conversation would reappear as an
    // empty one, so the read is dropped instead.
    if (!existsSync(entry.path)) {
      failed += 1
      continue
    }
    try {
      const header = await options.executor.loadHeader(entry.path, options.settings)
      if (header === undefined) {
        failed += 1
        continue
      }
      const total = header.eventCount
      const length = Math.min(TAIL_EVENTS, Math.max(1, total))
      const offset = Math.max(0, total - length)
      await options.executor.loadSession(entry.path, options.settings, { offset, length })
      primed += 1
      // A store written before the index existed would otherwise charge the
      // first search for the whole build, on the request thread. Doing it here
      // costs the same work while the operator is not waiting for an answer, and
      // the loop already yields between stores.
      if (options.indexSearch !== false && (await options.executor.indexStore(entry.path, options.settings))) {
        indexed += 1
      }
    } catch {
      failed += 1
    }
    stopped = aborted(options.signal)
  }

  return {
    scanned: found.length,
    headers,
    primed,
    indexed,
    failed,
    elapsedMs: Date.now() - startedAt,
    pausedMs,
  }
}
