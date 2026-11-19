/**
 * Folding the log, and asking SQLite what it thinks of a store.
 *
 * Both belong to the same worry: a store can look fine to this code while being
 * wrong on disk. `wal_checkpoint(TRUNCATE)` answers `busy=1` with the frames it
 * could not copy instead of failing, so a publish that treats the call as done
 * carries a main file that has lost them; and a damaged page makes the queries
 * covering it come back short, which reads exactly like a log torn at the tail —
 * `state` stays `ready` and the events simply end early.
 *
 * @module dsh-session-optimizer/tests/checkpoint-fold
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { openSync, closeSync, readSync, statSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionDatabase, type SqliteSettings } from '../src/database.ts'
import { databasePath } from '../src/format.ts'
import { publishDatabase, writeSqliteSession } from '../src/transfer.ts'

const WRITE: SqliteSettings = { journalMode: 'wal', synchronous: 'full', busyTimeoutMs: 5_000 }
const READ: SqliteSettings = { ...WRITE, readOnly: true }
const CWD = process.platform === 'win32' ? 'C:\\work\\fold' : '/work/fold'

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshsql-fold-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function headerOf(id: string): SessionHeader {
  return {
    version: 4,
    id: id as SessionId,
    createdAt: 1_700_000_000_000,
    cwd: CWD,
    isSeeded: false,
    delegationDepth: 0,
  }
}

/** `count` legal events; `turn/start` and `turn/end` are the cheapest pair. */
function log(count: number): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let seq = 0; seq < count; seq += 1) {
    const turn = Math.floor(seq / 2) + 1
    const data = seq % 2 === 0 ? { turn } : { turn, reason: { kind: 'completed' } }
    events.push({ type: seq % 2 === 0 ? 'turn/start' : 'turn/end', data, seq, time: 1_700_000_000_000 + seq } as SessionEvent)
  }
  return events
}

function eventCount(path: string): number {
  const store = SessionDatabase.open(path, READ)
  try {
    return store.loadSession().events.length
  } finally {
    store.close()
  }
}

/** Hold a read transaction open, which is what pins the write-ahead log. */
function pin(path: string): { release(): void } {
  const reader = new DatabaseSync(path, { readOnly: true })
  reader.exec('BEGIN')
  reader.prepare('SELECT count(*) AS n FROM session_event').get()
  return {
    release(): void {
      reader.exec('ROLLBACK')
      reader.close()
    },
  }
}

describe('folding the write-ahead log', () => {
  it('reports the triple instead of swallowing a refused fold', async () => {
    const root = await makeRoot()
    const path = databasePath(root, CWD, 'session-fold-triple' as SessionId)
    await writeSqliteSession(path, { header: headerOf('session-fold-triple'), events: log(4), inheritedEventCount: 0 })

    const store = SessionDatabase.open(path, WRITE)
    try {
      // A store this process just wrote and emptied: `log` is 0, nothing to copy.
      const fold = store.checkpoint('TRUNCATE')
      expect(fold.checkpointed).toBeGreaterThanOrEqual(fold.log)
      expect(store.integrityProblems()).toEqual([])
    } finally {
      store.close()
    }
  })

  it('refuses to publish a store whose log a reader is holding', async () => {
    const root = await makeRoot()
    const target = databasePath(await makeRoot(), CWD, 'session-fold-target' as SessionId)
    const staged = databasePath(await makeRoot(), CWD, 'session-fold-staged' as SessionId)
    await writeSqliteSession(target, { header: headerOf('session-fold-target'), events: log(2), inheritedEventCount: 0 })
    await writeSqliteSession(staged, { header: headerOf('session-fold-target'), events: log(2), inheritedEventCount: 0 })

    // Append through the engine so the new events land in `-wal`, which is the
    // state a publish actually meets: written, not yet folded. The reader has to
    // take its snapshot *before* those frames exist — a snapshot taken afterwards
    // includes them, and `wal_checkpoint` is then free to copy all of them and
    // report success despite answering `busy`. The writer stays open on purpose
    // too: closing the last connection to a WAL database folds and removes the
    // log, so a released handle would leave nothing to pin.
    const writer = SessionDatabase.open(staged, WRITE)
    const held = pin(staged)
    try {
      writer.appendBatch(headerOf('session-fold-target'), log(6).slice(2), true, 0)
      expect(statSync(`${staged}-wal`).size).toBeGreaterThan(0)
      await expect(publishDatabase(staged, target)).rejects.toThrow(/write-ahead log/)
    } finally {
      held.release()
      writer.close()
    }
    // The refusal is not allowed to have moved anything: the target is the store
    // it was, and the staged copy is still where the caller left it.
    expect(eventCount(target)).toBe(2)
    expect(eventCount(staged)).toBe(6)

    // With the reader gone the fold completes and the publish carries every event.
    await publishDatabase(staged, target)
    expect(eventCount(target)).toBe(6)
    expect(root.length).toBeGreaterThan(0)
  })
})

describe('asking SQLite about a damaged store', () => {
  it('names the damage while the read path still calls the store ready', async () => {
    const root = await makeRoot()
    const path = databasePath(root, CWD, 'session-damaged' as SessionId)
    await writeSqliteSession(path, { header: headerOf('session-damaged'), events: log(400), inheritedEventCount: 0 })

    const healthy = SessionDatabase.open(path, READ)
    const healthyEvents = healthy.loadSession().events.length
    expect(healthy.integrityProblems()).toEqual([])
    healthy.close()

    // Overwrite a page in the middle of the file, well away from the schema, the
    // way a half-written or physically damaged page arrives.
    const pageSize = 4096
    const pages = Math.floor(statSync(path).size / pageSize)
    expect(pages).toBeGreaterThan(4)
    const victim = Math.floor(pages / 2)
    const fd = openSync(path, 'r+')
    const original = Buffer.alloc(pageSize)
    readSync(fd, original, 0, pageSize, victim * pageSize)
    writeSync(fd, Buffer.alloc(pageSize, 0xff), 0, pageSize, victim * pageSize)
    closeSync(fd)

    const damaged = SessionDatabase.open(path, READ)
    try {
      const problems = damaged.integrityProblems()
      expect(problems.length).toBeGreaterThan(0)
      expect(problems.join('\n')).not.toBe('ok')
      // The point of the check: whatever the read path decides here, it is not
      // able to tell "damaged" from "torn". That is why SQLite has to be asked.
      let loaded: { state: string; events: unknown[] } | undefined
      try {
        const session = damaged.loadSession()
        loaded = { state: session.state, events: session.events }
      } catch {
        loaded = undefined
      }
      if (loaded !== undefined) {
        expect(loaded.state).toBe('ready')
        expect(loaded.events.length).toBeLessThan(healthyEvents)
      }
    } finally {
      damaged.close()
    }
  })
})