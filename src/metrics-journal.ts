/** Bounded latency history, persisted independently of the chart time range. */
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readFile, rename, unlink, writeFile, mkdir } from 'node:fs/promises'
import type { LatencySampleRecord, MetricsRegistry } from './metrics.ts'

export const LATENCY_JOURNAL_FILENAME = 'latency.json'
const LATENCY_JOURNAL_VERSION = 1
const SAVE_INTERVAL_MS = 15_000
interface Attachment {
  readonly registry: MetricsRegistry
  readonly path: string
  readonly writable: boolean
  interval?: NodeJS.Timeout | undefined
  writing?: Promise<void> | undefined
  closed: boolean
}
let target: Attachment | undefined
let lifecycle: Promise<unknown> = Promise.resolve()

/** Mount and unmount I/O must finish in invocation order. */
function serialize<T>(body: () => Promise<T>): Promise<T> {
  const pending = lifecycle.then(body)
  lifecycle = pending.catch(() => undefined)
  return pending
}

async function persist(current: Attachment): Promise<void> {
  if (!current.writable) return
  const staging = `${current.path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await mkdir(join(current.path, '..'), { recursive: true, mode: 0o700 })
    const samples = current.registry.exportSamples()
    await writeFile(staging, `${JSON.stringify({ version: LATENCY_JOURNAL_VERSION, samples })}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(staging, current.path)
  } catch {
    // Measurement failures must never fail a completed storage operation.
    await unlink(staging).catch(() => undefined)
  }
}

async function stop(expected?: MetricsRegistry): Promise<void> {
  const current = target
  if (current === undefined || (expected !== undefined && current.registry !== expected)) return
  target = undefined
  current.closed = true
  clearInterval(current.interval)
  // Wait for a periodic write, then capture any calls that finished during it.
  await current.writing
  await persist(current)
}

/** Restore retained measurements, then own the periodic writer until detached. */
export function attachMetricsJournal(registry: MetricsRegistry, directory: string): Promise<number> {
  return serialize(async () => {
    const path = join(directory, LATENCY_JOURNAL_FILENAME)
    if (target?.registry === registry && target.path === path) return 0
    await stop()
    let restored = 0
    let writable = true
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null &&
          (parsed as { version?: unknown }).version === LATENCY_JOURNAL_VERSION &&
          Array.isArray((parsed as { samples?: unknown }).samples)) {
        restored = registry.restoreSamples((parsed as { samples: LatencySampleRecord[] }).samples)
      } else {
        writable = false
      }
    } catch (error) {
      // Preserve unreadable, damaged and newer-format files. A missing file is
      // the only read failure that permits creating a fresh journal.
      writable = typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
    }
    const current: Attachment = { registry, path, writable, closed: false }
    target = current
    if (writable) {
      current.interval = setInterval(() => {
        if (current.closed || current.writing !== undefined) return
        const pending = persist(current)
        current.writing = pending
        void pending.finally(() => { if (current.writing === pending) current.writing = undefined })
      }, SAVE_INTERVAL_MS)
      current.interval.unref()
    }
    return restored
  })
}

/** A retired backend may only detach its own writer. */
export function detachMetricsJournal(expected?: MetricsRegistry): Promise<void> {
  return serialize(() => stop(expected))
}
