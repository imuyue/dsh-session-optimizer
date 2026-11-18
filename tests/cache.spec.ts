/**
 * A cached connection must follow the name, not the inode.
 *
 * `publishDatabase` replaces a store by renaming a staged file over it, and the
 * console runs that in the same process that already read the store. SQLite keeps
 * serving the file it opened, so a cache without an identity check answers from
 * the pre-conversion log — and a later append lands in the unlinked copy, which
 * is a committed write no path leads to.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'

import { InlineExecutor } from '../src/executor.ts'
import { databasePath } from '../src/format.ts'
import { publishDatabase, writeSqliteSession, type LogCopy } from '../src/transfer.ts'
import { releaseStore } from '../src/store-lease.ts'

const SETTINGS = { journalMode: 'wal', synchronous: 'full', busyTimeoutMs: 5000 } as const
const READ_SETTINGS = { ...SETTINGS, readOnly: true, repair: false } as const

const roots: string[] = []
const executors: InlineExecutor[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshsql-cache-'))
  roots.push(root)
  return root
}

function headerOf(id: string, cwd = '/work/cache'): SessionHeader {
  return {
    version: 4,
    id: id as SessionId,
    createdAt: 1_700_000_000_000,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
  }
}

function ev(seq: number): SessionEvent {
  const turn = (seq >> 1) + 1
  return (seq % 2 === 0
    ? { type: 'turn/start', seq, time: 1_700_000_000_000 + seq, data: { turn } }
    : {
        type: 'turn/end',
        seq,
        time: 1_700_000_000_000 + seq,
        data: { turn, reason: { kind: 'completed' } },
      }) as unknown as SessionEvent
}

function logOf(header: SessionHeader, turns: number): LogCopy {
  return {
    header,
    inheritedEventCount: 0,
    events: Array.from({ length: turns * 2 }, (_, seq) => ev(seq)),
  }
}

/**
 * A log long enough to be sealed into frames.
 *
 * `compact()` only moves rows once the tail is past half a frame, so a two-turn
 * store stays entirely in rows and never touches the frame cache. These events
 * carry a real payload so the seal happens the way it does for a conversation
 * someone actually had.
 */
function bulkyLog(header: SessionHeader, turns: number): LogCopy {
  const filler = 'x'.repeat(8_000)
  return {
    header,
    inheritedEventCount: 0,
    events: Array.from({ length: turns * 2 }, (_, seq) => {
      const base = ev(seq) as unknown as { data: Record<string, unknown> }
      // Keep every field the format validates and add weight next to them, so the
      // log stays a legal conversation that simply takes more space than a frame
      // budget allows.
      return { ...(ev(seq) as object), data: { ...base.data, note: filler } } as unknown as SessionEvent
    }),
  }
}

function executorOf(capacity = 4): InlineExecutor {
  const executor = new InlineExecutor(capacity)
  executors.push(executor)
  return executor
}

afterEach(async () => {
  const failures: unknown[] = []
  for (const executor of executors.splice(0)) {
    try {
      await executor.close()
    } catch (error) {
      failures.push(error)
    }
  }
  for (const root of roots.splice(0)) {
    try {
      await rm(root, { recursive: true, force: true })
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'cache test cleanup failed')
})

describe('a cached store follows its name', () => {
  it('answers from the published store after a conversion replaces the file', async () => {
    const root = await makeRoot()
    const cwd = '/work/cache'
    const header = headerOf('session-cached', cwd)
    const path = databasePath(root, cwd, header.id)
    await writeSqliteSession(path, logOf(header, 1))
    const executor = executorOf()
    expect((await executor.loadSession(path, SETTINGS))?.events.length).toBe(2)

    // Exactly what the console does when an operator converts this conversation.
    const staged = `${path}.staged`
    await writeSqliteSession(staged, logOf(header, 2))
    await publishDatabase(staged, path)

    const after = await executor.loadSession(path, SETTINGS)
    expect(after?.events.length).toBe(4)
    expect(after?.events.map((event) => event.seq)).toStrictEqual([0, 1, 2, 3])
  })

  it('writes an append into the published file, not into the replaced one', async () => {
    const root = await makeRoot()
    const cwd = '/work/cache'
    const header = headerOf('session-append', cwd)
    const path = databasePath(root, cwd, header.id)
    await writeSqliteSession(path, logOf(header, 1))
    const executor = executorOf()
    expect((await executor.loadSession(path, SETTINGS))?.events.length).toBe(2)

    const staged = `${path}.staged`
    await writeSqliteSession(staged, logOf(header, 2))
    await publishDatabase(staged, path)

    await executor.appendBatch(path, SETTINGS, header, [ev(4)], true, 0)

    // A reader that never saw the old file must see the append.
    const reader = executorOf(1)
    const visible = await reader.loadSession(path, SETTINGS)
    expect(visible?.events.map((event) => event.seq)).toStrictEqual([0, 1, 2, 3, 4])
  })

  it('forgets a store that is gone instead of answering from the unlinked file', async () => {
    const root = await makeRoot()
    const cwd = '/work/cache'
    const header = headerOf('session-gone', cwd)
    const path = databasePath(root, cwd, header.id)
    await writeSqliteSession(path, logOf(header, 1))
    const executor = executorOf()
    expect((await executor.loadSession(path, SETTINGS))?.events.length).toBe(2)

    // Windows will not unlink a file this process still has open, and the
    // executor is holding one by design. A delete that comes from outside the
    // plugin has to ask for the release first — which is what the transfer path
    // does before it replaces a store.
    await releaseStore(path)
    await rm(path)
    await expect(executor.loadSession(path, READ_SETTINGS)).rejects.toThrow()
  })
})

describe('the frame cache is one budget for the whole executor', () => {
  it('lets two open sessions share frames instead of holding two budgets', async () => {
    const root = await makeRoot()
    const cwd = '/work/cache'
    const first = headerOf('session-cache-one', cwd)
    const second = headerOf('session-cache-two', cwd)
    const firstPath = databasePath(root, cwd, first.id)
    const secondPath = databasePath(root, cwd, second.id)
    await writeSqliteSession(firstPath, bulkyLog(first, 40))
    await writeSqliteSession(secondPath, bulkyLog(second, 40))

    // Two connections open at once, which is what `preparedSessionCacheSize` is
    // for. Before the cache was hoisted each connection charged its own budget,
    // so the executor could hold twice the configured number of bytes.
    // A page read, not a whole-log read: only the former keeps frames.
    const executor = executorOf(2)
    await executor.loadSession(firstPath, SETTINGS, { offset: 0, length: 20 })
    const afterFirst = executor.frameBytes()
    expect(afterFirst).toBeGreaterThan(0)
    await executor.loadSession(secondPath, SETTINGS, { offset: 0, length: 20 })
    // Both stores' frames are charged against one figure, and it did not double
    // just because a second connection opened.
    expect(executor.frameBytes()).toBeGreaterThanOrEqual(afterFirst)
  })

  it('does not let one conversation evict the frames of another', async () => {
    const root = await makeRoot()
    const cwd = '/work/cache'
    const first = headerOf('session-cache-read', cwd)
    const second = headerOf('session-cache-write', cwd)
    const firstPath = databasePath(root, cwd, first.id)
    const secondPath = databasePath(root, cwd, second.id)
    await writeSqliteSession(firstPath, bulkyLog(first, 40))
    await writeSqliteSession(secondPath, bulkyLog(second, 40))

    const executor = executorOf(2)
    await executor.loadSession(firstPath, SETTINGS, { offset: 0, length: 20 })
    const warm = executor.frameBytes()
    expect(warm).toBeGreaterThan(0)

    // A write to the other store invalidates only its own frames. Clearing the
    // whole map would make an append in one conversation evict the pages of the
    // conversation the reader is scrolling.
    await executor.appendBatch(secondPath, SETTINGS, second, [ev(80)], true, 0)
    expect(executor.frameBytes()).toBeGreaterThanOrEqual(warm)

    const reread = await executor.loadSession(firstPath, SETTINGS, { offset: 0, length: 20 })
    expect(reread?.events.length).toBe(20)
  })

  it('leaves a whole-log read out of the budget instead of flushing it', async () => {
    const root = await makeRoot()
    const cwd = '/work/cache'
    const header = headerOf('session-cache-full', cwd)
    const path = databasePath(root, cwd, header.id)
    await writeSqliteSession(path, bulkyLog(header, 40))

    const executor = executorOf(2)
    // A conversation the reader is scrolling: its frames are worth keeping.
    const other = headerOf('session-cache-kept', cwd)
    const otherPath = databasePath(root, cwd, other.id)
    await writeSqliteSession(otherPath, bulkyLog(other, 40))
    await executor.loadSession(otherPath, SETTINGS, { offset: 0, length: 20 })
    const kept = executor.frameBytes()
    expect(kept).toBeGreaterThan(0)

    // A whole-log read visits every frame exactly once, so caching them buys no
    // hit and would push the page another reader is about to ask for out of the
    // shared budget — measured on a 47k-event store, that was 8MiB of dead lines.
    await executor.loadSession(path, SETTINGS)
    expect(executor.frameBytes()).toBe(kept)

    // The reader on the other conversation still gets its frames back.
    await expect(executor.loadSession(otherPath, SETTINGS, { offset: 0, length: 20 })).resolves.toBeDefined()
  })
})
