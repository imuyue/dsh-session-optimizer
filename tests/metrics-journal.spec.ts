import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { MetricsRegistry } from '../src/metrics.ts'
import {
  attachMetricsJournal,
  detachMetricsJournal,
  LATENCY_JOURNAL_FILENAME,
} from '../src/metrics-journal.ts'

const roots: string[] = []

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dshsql-latency-'))
  roots.push(directory)
  return directory
}

async function journalOf(directory: string): Promise<{ version: number; samples: unknown[] }> {
  const text = await readFile(join(directory, LATENCY_JOURNAL_FILENAME), 'utf8')
  return JSON.parse(text) as { version: number; samples: unknown[] }
}

afterEach(async () => {
  await detachMetricsJournal()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('the latency journal', () => {
  it('writes the window it kept and restores it into a fresh registry', async () => {
    const directory = await makeDirectory()
    const first = new MetricsRegistry()
    first.observe('read', 12.5, true)
    first.observe('read', 30, false)
    first.observe('search', 4, true)

    await attachMetricsJournal(first, directory)
    await detachMetricsJournal()

    const written = await journalOf(directory)
    expect(written.version).toBe(1)
    expect(written.samples).toHaveLength(3)
    if (process.platform !== 'win32') {
      expect(statSync(join(directory, LATENCY_JOURNAL_FILENAME)).mode & 0o777).toBe(0o600)
    }

    const second = new MetricsRegistry()
    const restored = await attachMetricsJournal(second, directory)
    expect(restored).toBe(3)
    const snapshot = second.snapshot()
    expect(snapshot.count).toBe(3)
    expect(snapshot.errors).toBe(1)
    expect(snapshot.ops.find((series) => series.op === 'read')?.count).toBe(2)
  })

  it('retains older measurements without counting them in the rolling window', async () => {
    const directory = await makeDirectory()
    const stale = Date.now() - 10 * 60_000
    await writeFile(
      join(directory, LATENCY_JOURNAL_FILENAME),
      `${JSON.stringify({ version: 1, samples: [{ op: 'read', at: stale, ms: 900, ok: true }] })}\n`,
      'utf8',
    )

    const registry = new MetricsRegistry()
    expect(await attachMetricsJournal(registry, directory)).toBe(1)
    expect(registry.snapshot().count).toBe(0)
    expect(registry.historySnapshot().count).toBe(1)
  })

  it('ignores a journal it cannot understand', async () => {
    const directory = await makeDirectory()
    const path = join(directory, LATENCY_JOURNAL_FILENAME)

    await writeFile(path, 'not json at all', 'utf8')
    expect(await attachMetricsJournal(new MetricsRegistry(), directory)).toBe(0)

    await writeFile(path, `${JSON.stringify({ version: 99, samples: [{ op: 'read', at: Date.now(), ms: 1, ok: true }] })}\n`, 'utf8')
    expect(await attachMetricsJournal(new MetricsRegistry(), directory)).toBe(0)

    await writeFile(path, `${JSON.stringify({ version: 1, samples: [{ op: 'nonsense', at: Date.now(), ms: 1, ok: true }] })}\n`, 'utf8')
    expect(await attachMetricsJournal(new MetricsRegistry(), directory)).toBe(0)
  })

  it('leaves the warm-up signal alone, because a previous process is not activity', async () => {
    const directory = await makeDirectory()
    const first = new MetricsRegistry()
    first.observe('open', 700, true)
    await attachMetricsJournal(first, directory)
    await detachMetricsJournal()

    const second = new MetricsRegistry()
    expect(await attachMetricsJournal(second, directory)).toBe(1)
    expect(second.lastObservedAt).toBeUndefined()
    second.observe('open', 2, true)
    expect(second.lastObservedAt).toBeTypeOf('number')
  })
})
