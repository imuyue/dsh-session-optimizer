/**
 * On-disk journal for the latency panel.
 *
 * The registry is a five-minute window in memory, which means every restart made
 * the panel claim "no samples in this window" even seconds after a page load that
 * really did take a second. This journal writes the window to the state directory
 * and reads it back on mount, so the first screen after a restart still answers
 * "what did this machine actually do a minute ago".
 *
 * What is written is the same thing the panel shows: real call durations, no
 * synthetic points. Samples that have already left the window are dropped on load
 * rather than resurrected, because a chart is only allowed to claim "in the last
 * five minutes".
 *
 * @module dsh-session-optimizer/metrics-journal
 */

import { join } from 'node:path'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'

import type { LatencySampleRecord, MetricsRegistry } from './metrics.ts'

/** File name inside the state directory. */
export const LATENCY_JOURNAL_FILENAME = 'latency.json'

/** Format version; a build only reads what it understands. */
const LATENCY_JOURNAL_VERSION = 1

/**
 * How often a running process rewrites the journal.
 *
 * Long enough that an idle backend does not keep touching the disk, short enough
 * that a crash loses at most this much of the window. The interval is unref'd, so
 * it never keeps the process alive on its own.
 */
const SAVE_INTERVAL_MS = 15_000

/** Where the current journal lives, if one is attached. */
let target: { readonly registry: MetricsRegistry; readonly path: string } | undefined

/** Periodic writer; unref'd so it does not hold the process open. */
let interval: NodeJS.Timeout | undefined

/** Write the current window, ignoring failures. */
async function save(): Promise<void> {
  const current = target
  if (current === undefined) return
  const samples = current.registry.exportSamples()
  const document = { version: LATENCY_JOURNAL_VERSION, samples }
  const staging = `${current.path}.${String(process.pid)}.tmp`
  try {
    mkdirSync(join(current.path, '..'), { recursive: true, mode: 0o700 })
    await writeFile(staging, `${JSON.stringify(document)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(staging, current.path)
  } catch {
    // A read-only or full state directory must not turn a finished call into a
    // failed one: the journal is a convenience, not a durability barrier.
    await unlink(staging).catch(() => undefined)
  }
}

/**
 * Attach `registry` to `<directory>/latency.json`, restoring what is still inside
 * the window. Returns how many samples came back.
 */
export async function attachMetricsJournal(registry: MetricsRegistry, directory: string): Promise<number> {
  await detachMetricsJournal()
  const path = join(directory, LATENCY_JOURNAL_FILENAME)
  let restored = 0
  try {
    const text = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) {
      const document = parsed as { version?: unknown; samples?: unknown }
      if (document.version === LATENCY_JOURNAL_VERSION && Array.isArray(document.samples)) {
        restored = registry.restoreSamples(document.samples as readonly LatencySampleRecord[])
      }
    }
  } catch {
    // Missing, unreadable, or written by a different build: start the window
    // empty instead of failing the mount over a chart.
  }
  target = { registry, path }
  interval = setInterval(() => {
    void save()
  }, SAVE_INTERVAL_MS)
  interval.unref()
  return restored
}

/**
 * Stop writing and flush once.
 *
 * The flush is best-effort and bounded by the same rules as the periodic save, so
 * disposing the plugin never throws because of the journal.
 */
export async function detachMetricsJournal(): Promise<void> {
  if (interval !== undefined) {
    clearInterval(interval)
    interval = undefined
  }
  if (target === undefined) return
  await save()
  target = undefined
}
