/**
 * Warm-up: what the mount does before anyone asks, and what it must not break.
 *
 * The value of a warm-up is invisible in a correctness test — a cache that is not
 * warm produces the same answers, just later. So these tests check the three
 * things that can actually go wrong: the reads must land where the reader will
 * look (the header cache, the tail window), the loop must yield instead of
 * monopolising the thread, and a store that cannot be read must be counted
 * rather than thrown — a profile with one foreign file in its root still has to
 * start.
 *
 * @module dsh-session-optimizer/tests/warmup
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionDatabase, ensureSessionDirectory, type SqliteSettings } from '../src/database.ts'
import { InlineExecutor } from '../src/executor.ts'
import { databasePath } from '../src/format.ts'
import { matchQueryFor } from '../src/search.ts'
import { warmRecentSessions } from '../src/warmup.ts'

const SETTINGS: SqliteSettings = { journalMode: 'wal', synchronous: 'full', busyTimeoutMs: 5000 }

const roots: string[] = []
const executors: InlineExecutor[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-warmup-'))
  roots.push(root)
  return root
}

function headerOf(id: string, cwd = '/work/warmup'): SessionHeader {
  return {
    version: 4,
    id: id as SessionId,
    createdAt: 1_700_000_000_000,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
  }
}

/** One closed turn carrying `text`, in the shape the released format accepts. */
function turn(startSeq: number, turnIndex: number, text: string): SessionEvent[] {
  return [
    { type: 'turn/start', seq: startSeq, time: startSeq, data: { turn: turnIndex } } as never,
    {
      type: 'user/message',
      seq: startSeq + 1,
      time: startSeq + 1,
      data: {
        id: `msg-warm-${String(turnIndex)}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      },
      surfaceOp: 'append',
    } as never,
    { type: 'turn/end', seq: startSeq + 2, time: startSeq + 2, data: { turn: turnIndex } } as never,
  ]
}

async function seed(root: string, id: string, turns = 2): Promise<string> {
  const events: SessionEvent[] = []
  for (let index = 0; index < turns; index += 1) {
    events.push(...turn(index * 3, index + 1, `warm ${String(index)}`))
  }
  const path = databasePath(root, headerOf(id).cwd, id)
  await ensureSessionDirectory(dirname(path))
  const db = SessionDatabase.open(path, SETTINGS)
  try {
    db.appendImported(headerOf(id), events, 0)
    db.markReady()
  } finally {
    db.close()
  }
  return path
}

function executor(): InlineExecutor {
  const made = new InlineExecutor(8)
  executors.push(made)
  return made
}

afterEach(async () => {
  for (const made of executors.splice(0)) await made.close()
  const failures: unknown[] = []
  for (const root of roots.splice(0)) {
    try {
      await rm(root, { recursive: true, force: true })
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'cleanup failed')
})

describe('warm-up', () => {
  it('reads every header and the tail of the newest conversations', async () => {
    const root = await makeRoot()
    // Three conversations, written oldest first: the last one is the newest and
    // must be the first primed.
    await seed(root, 'session-old')
    await seed(root, 'session-middle')
    await seed(root, 'session-new')

    const report = await warmRecentSessions({
      root,
      settings: SETTINGS,
      executor: executor(),
      sessions: 2,
    })

    expect(report.scanned).toBe(3)
    expect(report.headers).toBe(3)
    expect(report.primed).toBe(2)
    expect(report.failed).toBe(0)
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('does not open a store it has already read while the file is unchanged', async () => {
    const root = await makeRoot()
    const path = await seed(root, 'session-stable')
    const shared = executor()

    await warmRecentSessions({ root, settings: SETTINGS, executor: shared, sessions: 1 })
    const before = await shared.listHeaders([path], SETTINGS)
    // A second pass reuses the header cache: the entry is the same object the
    // first pass stored, which is only true if the stamp matched.
    const after = await shared.listHeaders([path], SETTINGS)
    expect(after[0]).toBe(before[0])
  })

  it('counts a file it cannot read instead of failing the whole root', async () => {
    const root = await makeRoot()
    await seed(root, 'session-good')
    // A store that is a real file but not a database: the failure is per store.
    const broken = join(root, '--work-warmup--', 'session-broken')
    await ensureSessionDirectory(broken)
    await writeFile(join(broken, 'session.db'), 'not a database')

    const report = await warmRecentSessions({
      root,
      settings: SETTINGS,
      executor: executor(),
      sessions: 5,
    })

    expect(report.scanned).toBe(2)
    expect(report.headers).toBe(1)
    expect(report.failed).toBeGreaterThanOrEqual(1)
  })

  it('stops when the signal aborts, keeping what it already read', async () => {
    const root = await makeRoot()
    for (let index = 0; index < 6; index += 1) await seed(root, `session-${String(index)}`)
    const controller = new AbortController()
    controller.abort()

    const report = await warmRecentSessions({
      root,
      settings: SETTINGS,
      executor: executor(),
      sessions: 5,
      signal: controller.signal,
    })

    expect(report.scanned).toBe(6)
    expect(report.headers).toBe(0)
    expect(report.primed).toBe(0)
  })

  it('yields between chunks so a mount is never blocked by the whole root', async () => {
    const root = await makeRoot()
    for (let index = 0; index < 5; index += 1) await seed(root, `session-${String(index)}`)
    const order: string[] = []
    const running = warmRecentSessions({
      root,
      settings: SETTINGS,
      executor: executor(),
      sessions: 0,
      batch: 2,
    }).then((report) => {
      order.push('warmup')
      return report
    })
    // A zero-delay timer queued after the warm-up starts must run before it ends:
    // that is what "yields" buys, and without it the agent loop would stall.
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        order.push('elsewhere')
        resolve()
      }, 0)
    })
    await running
    expect(order[0]).toBe('elsewhere')
  })

  it('parks while the application is busy and reads nothing', async () => {
    const root = await makeRoot()
    for (let index = 0; index < 4; index += 1) await seed(root, `session-${String(index)}`)
    const running = warmRecentSessions({
      root,
      settings: SETTINGS,
      executor: executor(),
      sessions: 0,
      batch: 2,
      waitStepMs: 2,
      pauseBudgetMs: 30,
      // Busy for ever: a warm-up must not outrank the request someone is waiting
      // on, so the right answer here is "read nothing at all".
      quiet: () => false,
    })
    const report = await running
    expect(report.headers).toBe(0)
    expect(report.scanned).toBe(4)
  })

  it('resumes once the application goes quiet again', async () => {
    const root = await makeRoot()
    for (let index = 0; index < 4; index += 1) await seed(root, `session-${String(index)}`)
    let busy = true
    const running = warmRecentSessions({
      root,
      settings: SETTINGS,
      executor: executor(),
      sessions: 1,
      batch: 2,
      waitStepMs: 2,
      quiet: () => !busy,
    })
    // Let it park for a few checks, then release it: the work must still land, and
    // the parked time must be reported rather than counted as slow reads.
    setTimeout(() => {
      busy = false
    }, 12)
    const report = await running
    expect(report.headers).toBe(4)
    expect(report.primed).toBe(1)
    expect(report.pausedMs).toBeGreaterThan(0)
  })

  it('stops parking when the signal aborts, without reading further', async () => {
    const root = await makeRoot()
    for (let index = 0; index < 3; index += 1) await seed(root, `session-${String(index)}`)
    const controller = new AbortController()
    const running = warmRecentSessions({
      root,
      settings: SETTINGS,
      executor: executor(),
      sessions: 0,
      waitStepMs: 2,
      quiet: () => false,
      signal: controller.signal,
    })
    setTimeout(() => {
      controller.abort()
    }, 8)
    const report = await running
    // An abort while parked must end the wait, not sit in it until the app is idle.
    expect(report.headers).toBe(0)
  })
})

describe('warming the search index', () => {
  /** A store from before the index existed must be searchable without the reader paying for the build. */
  it('builds a missing index before anyone searches', async () => {
    const root = await makeRoot()
    const path = await seed(root, 'session-legacy')
    const raw = SessionDatabase.open(path, SETTINGS) as unknown as {
      statement: (sql: string) => { run: (...args: unknown[]) => unknown }
      close: () => void
    }
    try {
      raw.statement('DROP TABLE event_fts').run()
      raw.statement('DROP TABLE event_fts_state').run()
    } finally {
      raw.close()
    }

    const report = await warmRecentSessions({ root, settings: SETTINGS, executor: executor(), sessions: 1 })
    expect(report.indexed).toBe(1)

    // A read-only reader now answers, which it could not do before the warm-up:
    // it has no way to write the index itself.
    const reader = new InlineExecutor(2)
    executors.push(reader)
    const readOnly: SqliteSettings = { ...SETTINGS, readOnly: true, repair: false }
    const hits = await reader.searchStore(path, readOnly, matchQueryFor('warm') ?? '', 5)
    expect((hits ?? []).length).toBeGreaterThan(0)
  })

  it('can be told to skip the index work', async () => {
    const root = await makeRoot()
    await seed(root, 'session-plain')
    const report = await warmRecentSessions({
      root,
      settings: SETTINGS,
      executor: executor(),
      sessions: 1,
      indexSearch: false,
    })
    expect(report.indexed).toBe(0)
    expect(report.primed).toBe(1)
  })
})
