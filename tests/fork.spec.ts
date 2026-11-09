/**
 * A forked conversation is a seeded header, a cut, and a seed that carries the
 * cut marker. All three have to survive a round trip.
 *
 * The runtime forks by creating a *new* session whose header carries
 * `isSeeded: true`, whose seed is the parent's events through the boundary,
 * followed by a `session/end-seed` marker (`data.inherited === true`) sitting
 * exactly at the cut index, and `inheritedEventCount` set to the number of
 * *copied source events* — the marker and any synthetic closers come after the
 * cut and are not counted. Nothing here was covered before: every other fixture
 * creates unseeded sessions with a cut of zero, so a backend could drop the cut
 * without failing a single test.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

import * as SqliteSessionPersistence from '../src/index.ts'
import { databasePath } from '../src/format.ts'
import { readSqliteCopy } from '../src/transfer.ts'

const contexts: Context[] = []
const roots: string[] = []

const SETTINGS = { journalMode: 'wal', synchronous: 'full', busyTimeoutMs: 5000 } as const
const CWD = '/work/fork'

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshsql-fork-'))
  roots.push(root)
  return root
}

/** Mount the plugin the way a profile does, so create/open go through the contract. */
async function mount(root: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SqliteSessionPersistence, { root, storageThread: 'inline' })
  contexts.push(ctx)
  return ctx
}

function headerOf(id: string, seeded = false): SessionHeader {
  return {
    version: 4,
    id: id as SessionId,
    createdAt: 1_700_000_000_000,
    cwd: CWD,
    isSeeded: seeded,
    delegationDepth: 0,
  }
}

/** One complete turn, starting at `from`. */
function turn(startingAt: number): SessionEvent[] {
  const number = (startingAt >> 1) + 1
  return [
    { type: 'turn/start', seq: startingAt, time: 1_700_000_000_000 + startingAt, data: { turn: number } },
    {
      type: 'turn/end',
      seq: startingAt + 1,
      time: 1_700_000_000_001 + startingAt,
      data: { turn: number, reason: { kind: 'completed' } },
    },
  ] as unknown as SessionEvent[]
}

/** Two turns, seq 0..3 — the parent a fork copies. */
function parentLog(): SessionEvent[] {
  return [...turn(0), ...turn(2)]
}

/**
 * Exactly what `buildForkSeed` produces for a boundary at the parent's last
 * event: the copied prefix, the inherited-cut marker at `cut`, and the child's
 * own events after it.
 */
function forkSeed(cut: number): SessionEvent[] {
  const prefix = parentLog().slice(0, cut)
  return [
    ...prefix,
    {
      type: 'session/end-seed',
      seq: cut,
      time: 1_700_000_000_000 + cut,
      data: { inherited: true },
    } as unknown as SessionEvent,
  ]
}

afterEach(async () => {
  const failures: unknown[] = []
  for (const ctx of contexts.splice(0)) {
    try {
      await ctx.fiber.dispose()
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
  if (failures.length > 0) throw new AggregateError(failures, 'fork fixture cleanup failed')
})

describe('a forked conversation', () => {
  it('keeps its cut across append, read, and reopen', async () => {
    const root = await makeRoot()
    const ctx = await mount(root)
    const persistence = ctx.sessionPersistence

    const parent = await persistence.create(headerOf('session-parent'))
    await parent.append(parentLog())
    await parent.flush()
    await parent.close()

    const cut = 4
    const child = await persistence.create(headerOf('session-child', true), {
      inheritedEventCount: cut as never,
    })
    expect(child.inheritedEventCount).toBe(cut)
    // The seed is contiguous from 0; the cut is where the marker sits, and the
    // child's own turn follows it.
    await child.append([...forkSeed(cut), ...turn(cut + 1)])
    await child.flush()
    await child.close()

    // A restarted process reads the cut from the store, not from memory.
    const second = new Context()
    await second.plugin(SqliteSessionPersistence, { root, storageThread: 'inline' })
    contexts.push(second)
    const reopened = await second.sessionPersistence.open('session-child' as SessionId, 'read')

    expect(reopened.inheritedEventCount).toBe(cut)
    expect(reopened.header.isSeeded).toBe(true)
    const log = await reopened.read()
    expect(log.events.map((event) => event.seq)).toStrictEqual([0, 1, 2, 3, 4, 5, 6])
    // The marker survives the store, which is what lets a reader tell an
    // inherited cut from an ordinary event at the same index.
    const marker = log.events[cut] as unknown as { type: string; data: { inherited?: boolean } }
    expect(marker.type).toBe('session/end-seed')
    expect(marker.data.inherited).toBe(true)
    await reopened.close()
  })

  it('reports the cut in the listing, beside the header that names the lineage', async () => {
    const root = await makeRoot()
    const ctx = await mount(root)
    const persistence = ctx.sessionPersistence

    const cut = 2
    const child = await persistence.create(headerOf('session-listed', true), {
      inheritedEventCount: cut as never,
    })
    await child.append(forkSeed(cut))
    await child.flush()
    await child.close()

    const listed = await persistence.list()
    const entry = listed.find((candidate) => candidate.header.id === 'session-listed')
    expect(entry?.header.isSeeded).toBe(true)
    // Every event is counted, inherited prefix included: the log is the whole
    // conversation, not just the part the child wrote.
    expect(entry?.eventCount).toBe(3)
  })

  it('refuses a seeded header with no cut, and a cut on an unseeded header', async () => {
    const root = await makeRoot()
    const ctx = await mount(root)
    const persistence = ctx.sessionPersistence

    // Both refusals are the JSONL backend's own, kept identical here so a fork
    // that works on one backend does not fail on the other.
    await expect(persistence.create(headerOf('session-uncut', true))).rejects.toThrow(
      /seeded session header requires an inherited event count/,
    )
    await expect(
      persistence.create(headerOf('session-unseeded'), { inheritedEventCount: 2 as never }),
    ).rejects.toThrow(/unseeded session header inherited event count must be 0/)
  })

  it('survives an export and import round trip through the migration engine', async () => {
    const root = await makeRoot()
    const ctx = await mount(root)
    const persistence = ctx.sessionPersistence

    const cut = 2
    const child = await persistence.create(headerOf('session-roundtrip', true), {
      inheritedEventCount: cut as never,
    })
    await child.append(forkSeed(cut))
    await child.flush()
    await child.close()

    // Read the copy the converter would export: without the cut, the imported
    // conversation would look like a fork of nothing.
    const path = databasePath(root, CWD, 'session-roundtrip' as SessionId)
    const copy = await readSqliteCopy(path, 'read', { settings: SETTINGS })
    expect(copy.header.isSeeded).toBe(true)
    expect(copy.inheritedEventCount).toBe(cut)
    expect(copy.events.map((event) => event.seq)).toStrictEqual([0, 1, 2])
  })
})
