/**
 * The deferred seal has to keep its bargain at both ends.
 *
 * With compaction off nothing folds the tail, so every seal is an aggregate over
 * the whole log. Resealing after every batch would make writing one long
 * conversation quadratic, so the seal is refreshed once per `RESEAL_ROWS` rows
 * — and *not* on the batches in between.
 *
 * Both halves are observable through the seal row itself: it records the marker
 * (`event_count@revision`) of the log it describes, so a seal that matches the
 * session row is current and one that does not is stale. A policy that quietly
 * stopped resealing, or one that resealed on every batch, fails one of these.
 *
 * @module dsh-session-optimizer/tests/reseal
 */

import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionDatabase, ensureSessionDirectory, fileStamp, type SqliteSettings } from '../src/database.ts'
import { databasePath } from '../src/format.ts'

const NO_SEAL: SqliteSettings = {
  journalMode: 'wal',
  synchronous: 'full',
  busyTimeoutMs: 5000,
  seal: false,
}
const SEAL: SqliteSettings = { journalMode: 'wal', synchronous: 'full', busyTimeoutMs: 5000 }
const CWD = '/work/reseal'

/** `RESEAL_ROWS` in `src/database.ts`: a batch at least this long must refresh. */
const RESEAL_ROWS = 4096

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshsql-reseal-'))
  roots.push(root)
  return root
}

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
    const type = seq % 2 === 0 ? 'turn/start' : 'turn/end'
    const data = seq % 2 === 0 ? { turn } : { turn, reason: { kind: 'completed' } }
    events.push({ type, data, seq, time: 1_700_000_000_000 + seq } as SessionEvent)
  }
  return events
}

function pathOf(root: string, id: string): string {
  return databasePath(root, CWD, id as SessionId)
}

/**
 * What the seal claims against what the session row now says.
 *
 * Read through a separate read-only connection, so it cannot be answered from
 * anything the writing store remembers in memory.
 */
function sealOf(path: string): { marker: string; claimed: string } {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const seal = db.prepare('SELECT marker FROM session_seal WHERE singleton = 1').get() as
      | { marker: unknown }
      | undefined
    const row = db.prepare('SELECT event_count, revision FROM session WHERE singleton = 1').get() as {
      event_count: unknown
      revision: unknown
    }
    return {
      marker: seal === undefined ? 'none' : String(seal.marker),
      claimed: `${String(row.event_count)}@${String(row.revision)}`,
    }
  } finally {
    db.close()
  }
}

afterEach(async () => {
  const failures: unknown[] = []
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
  }
  if (failures.length > 0) throw new AggregateError(failures, 'reseal test cleanup failed')
})

describe('the deferred seal', () => {
  it('refreshes once a batch reaches the row budget', async () => {
    const root = await makeRoot()
    const path = pathOf(root, 'seal-after-budget')
    ensureSessionDirectory(join(path, '..'))

    const id = 'seal-after-budget'
    const writer = SessionDatabase.open(path, NO_SEAL)
    try {
      writer.appendImported(headerOf(id), log(4), 0)
      writer.markReady()
      // The seal from `markReady` describes four events and no longer matches.
      // Only the row budget can bring it back, and only if the policy counts
      // rows: one big batch is one batch, so a batch-counting policy stays stale
      // here and every later reader walks the log instead of trusting it.
      writer.appendBatch(headerOf(id), log(RESEAL_ROWS + 12).slice(4), true, 0)
    } finally {
      writer.close()
    }

    const seal = sealOf(path)
    expect(seal.marker).toBe(seal.claimed)
  })

  it('stays put across batches that are below the budget', async () => {
    const root = await makeRoot()
    const path = pathOf(root, 'seal-short-tail')
    ensureSessionDirectory(join(path, '..'))

    const id = 'seal-short-tail'
    const writer = SessionDatabase.open(path, NO_SEAL)
    try {
      writer.appendImported(headerOf(id), log(4), 0)
      writer.markReady()
      writer.appendBatch(headerOf(id), log(10).slice(4), true, 0)
    } finally {
      writer.close()
    }

    // The seal still describes the four-event log: six rows are not worth an
    // aggregate over everything written so far, and the next reader is told to
    // walk instead of being told the log is fine.
    const seal = sealOf(path)
    expect(seal.marker).not.toBe(seal.claimed)
  })

  it('refreshes on every batch when compaction is on', async () => {
    const root = await makeRoot()
    const path = pathOf(root, 'seal-compacting')
    ensureSessionDirectory(join(path, '..'))

    const id = 'seal-compacting'
    const writer = SessionDatabase.open(path, SEAL)
    try {
      writer.appendImported(headerOf(id), log(4), 0)
      writer.markReady()
      writer.appendBatch(headerOf(id), log(10).slice(4), true, 0)
    } finally {
      writer.close()
    }

    // A fold rewrote the layout the seal describes, so the seal has to be
    // re-taken; leaving it behind would make every read distrust the store.
    const seal = sealOf(path)
    expect(seal.marker).toBe(seal.claimed)
  })
})

describe('the file stamp', () => {
  it('moves when a rewrite keeps the size and restores the mtime', async () => {
    const root = await makeRoot()
    // A plain file, not a store: the point is the stamp itself, and a database
    // would also move the `-wal` sidecar, which would answer for the wrong
    // reason. Same length, same inode, `mtime` put back by hand — only the
    // inode change time can tell this file apart from the one stamped before.
    const file = join(root, 'stamp.db')
    writeFileSync(file, 'aaaa')
    const { atime, mtime } = statSync(file)
    // `utimes` takes `Date`s, so it lands on a whole millisecond. Doing it once
    // up front means the value the second call restores is the exact value the
    // first stamp recorded — otherwise the comparison would differ on the
    // fractional part of `mtimeMs` and prove nothing about `ctime`.
    await utimes(file, atime, mtime)
    const before = fileStamp(file)
    writeFileSync(file, 'bbbb')
    await utimes(file, atime, mtime)
    expect(fileStamp(file)).not.toBe(before)
  })
})
