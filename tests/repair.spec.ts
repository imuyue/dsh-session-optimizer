/**
 * What a store says about itself when the file and the row disagree.
 *
 * Every case here was a real hole: a log cut short went on claiming the old
 * length (so the picker promised events the file did not have, a reader refused
 * the log as "shrank", and the next append wrote over seqs whose contents were
 * lost); a truncation accepted a length the log never had; a root holding one id
 * under two project keys listed it twice and then refused to open either. A
 * publish that died between its two renames left the conversation under
 * `<target>.replaced`, invisible to listing and one step from deletion.
 *
 * The scenarios are produced the way they happen in the field: a stray `DELETE`,
 * a copy of a project directory, a crash during a copy. None of them go through
 * the plugin's own write path, because the write path is what has to survive
 * them.
 *
 * @module dsh-session-optimizer/tests/repair
 */

import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, rename, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import * as SqliteSessionPersistence from '../src/index.ts'
import { SessionDatabase, ensureSessionDirectory, fileStamp, type SqliteSettings } from '../src/database.ts'
import { databasePath } from '../src/format.ts'
import { publishDatabase } from '../src/transfer.ts'

const SETTINGS: SqliteSettings = { journalMode: 'wal', synchronous: 'full', busyTimeoutMs: 5000 }
const READ_SETTINGS: SqliteSettings = { ...SETTINGS, readOnly: true, repair: false }
const CWD = '/work/repair'

const roots: string[] = []
const contexts: Context[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshsql-repair-'))
  roots.push(root)
  return root
}

async function mount(root: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SqliteSessionPersistence, { root, storageThread: 'inline' })
  contexts.push(ctx)
  return ctx
}

function headerOf(id: string, cwd = CWD): SessionHeader {
  return {
    version: 4,
    id: id as SessionId,
    createdAt: 1_700_000_000_000,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
  }
}

/** Complete turns: the format refuses a start without its end. */
function turns(count: number, from = 0): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let index = 0; index < count; index += 1) {
    const turn = from + index + 1
    events.push(
      { type: 'turn/start', seq: (from + index) * 2, time: 1_700_000_000_000 + (from + index) * 2, data: { turn } } as never,
      {
        type: 'turn/end',
        seq: (from + index) * 2 + 1,
        time: 1_700_000_000_001 + (from + index) * 2,
        data: { turn, reason: { kind: 'completed' } },
      } as never,
    )
  }
  return events
}

/** Write a store through the engine; the caller then damages it out of band. */
function seedStore(root: string, id: string, count: number, cwd = CWD): string {
  const path = databasePath(root, cwd, id as SessionId)
  ensureSessionDirectory(join(path, '..'))
  const db = SessionDatabase.open(path, SETTINGS)
  try {
    db.appendImported(headerOf(id, cwd), turns(count), 0)
    db.markReady()
  } finally {
    db.close()
  }
  return path
}

/** Take rows away behind the store's back, keeping the row's claim. */
function dropRows(path: string, from: number): void {
  const raw = new DatabaseSync(path)
  try {
    // Exactly what an interrupted restore or a hand-run DELETE leaves: the rows
    // are gone, the session row still claims them.
    raw.prepare('DELETE FROM session_event WHERE seq >= ?').run(from)
  } finally {
    raw.close()
  }
}

afterEach(async () => {
  const failures: unknown[] = []
  for (const ctx of contexts.splice(0)) {
    await ctx.fiber.dispose().catch((error: unknown) => failures.push(error))
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
  }
  if (failures.length > 0) throw new AggregateError(failures, 'repair test cleanup failed')
})

describe('a log that was cut short', () => {
  it('reports the events it holds instead of the ones the row claims', async () => {
    const root = await makeRoot()
    const id = 'session-cut'
    dropRows(seedStore(root, id, 3), 4)
    const ctx = await mount(root)

    // The listing is what the picker draws: a count it cannot deliver is a
    // damaged conversation that looks healthy.
    const [listed] = await ctx.sessionPersistence.list()
    expect(listed?.eventCount).toBe(4)
    expect((await ctx.sessionPersistence.stat(id as SessionId))?.eventCount).toBe(4)
  })

  it('serves the surviving prefix to a reader instead of refusing the log', async () => {
    const root = await makeRoot()
    const id = 'session-read'
    dropRows(seedStore(root, id, 3), 4)
    const ctx = await mount(root)

    const handle = await ctx.sessionPersistence.open(id as SessionId, 'read')
    try {
      const page = await handle.read()
      expect(page.events.map((event) => event.seq)).toStrictEqual([0, 1, 2, 3])
    } finally {
      await handle.close()
    }
  })

  it('cuts the claim down before an append lands on the missing seqs', async () => {
    const root = await makeRoot()
    const id = 'session-append'
    const path = seedStore(root, id, 3)
    dropRows(path, 4)
    const ctx = await mount(root)

    const handle = await ctx.sessionPersistence.open(id as SessionId, 'write')
    try {
      // seq 4 is free again: the events that used to sit there are gone.
      await handle.append(turns(1, 2))
      await handle.flush()
    } finally {
      await handle.close()
    }

    const db = SessionDatabase.open(path, READ_SETTINGS)
    try {
      const loaded = db.loadSession()
      expect(loaded?.eventCount).toBe(6)
      expect(loaded?.events.map((event) => event.seq)).toStrictEqual([0, 1, 2, 3, 4, 5])
      expect(db.loadHeader()?.eventCount).toBe(6)
    } finally {
      db.close()
    }
  })
})

describe('a truncation that names more than the log holds', () => {
  it('is refused, and the store keeps what it had', async () => {
    const root = await makeRoot()
    const id = 'session-over'
    const path = seedStore(root, id, 3)
    const db = SessionDatabase.open(path, SETTINGS)
    try {
      // One call used to invent rows: `event_count` went to 250 while the log
      // held 200, which is the same shape as a crash-cut store.
      expect(() => { db.truncateTail(250) }).toThrow(/its log holds 6 events/u)
      expect(db.loadHeader()?.eventCount).toBe(6)
      expect(db.loadSession()?.events).toHaveLength(6)
    } finally {
      db.close()
    }
  })
})

describe('a root that holds one id twice', () => {
  it('lists the conversation once instead of listing it and refusing to open it', async () => {
    const root = await makeRoot()
    const id = 'session-twice'
    seedStore(root, id, 1)
    // The same conversation under a second project key: WSL's `/mnt/c/x` and
    // Windows' `C:\x` name one directory, and a copied project directory carries
    // its sessions with it.
    seedStore(root, id, 1, '/work/elsewhere')

    const ctx = await mount(root)
    const listed = await ctx.sessionPersistence.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.header.id).toBe(id)
    // Two buckets is still ambiguity for a *lookup*, and saying so beats guessing.
    await expect(ctx.sessionPersistence.open(id as SessionId, 'read')).rejects.toThrow(
      /stored more than once/u,
    )
  })
})

describe('a publish that died between its two renames', () => {
  it('puts the old store back under its own name before replacing anything', async () => {
    const root = await makeRoot()
    const id = 'session-half'
    const path = seedStore(root, id, 2)
    // Exactly what a crash in `publishDatabase` leaves: the store under
    // `<target>.replaced`, and nothing at the name the plugin scans for.
    await rename(path, `${path}.replaced`)
    expect(existsSync(path)).toBe(false)

    // The staged copy is what a failed run would have written; it is not there,
    // so the publish fails — but it must fail with the old store visible again,
    // not with the conversation hidden one rename away from deletion.
    await expect(publishDatabase(`${path}.staging`, path)).rejects.toThrow()
    expect(existsSync(path)).toBe(true)
    const db = SessionDatabase.open(path, READ_SETTINGS)
    try {
      expect(db.loadSession()?.events).toHaveLength(4)
    } finally {
      db.close()
    }
  })
})

describe('an append that starts inside the log', () => {
  it('is refused instead of rewriting events that are already committed', async () => {
    const root = await makeRoot()
    const path = seedStore(root, 'session-rewrite', 3)
    const db = SessionDatabase.open(path, SETTINGS)
    try {
      // Starting below the end would `INSERT OR REPLACE` over seqs 4 and 5
      // while the frames sealing that prefix still describe the old events:
      // the log would change its history and disagree with its own seal.
      expect(() => { db.appendBatch(headerOf('session-rewrite'), turns(2, 1), true, 0) })
        .toThrow(/already holds 6 events/u)
      expect(db.loadHeader()?.eventCount).toBe(6)
    } finally {
      db.close()
    }
  })
})

describe('a listing after the store was replaced', () => {
  it('reads the replacement instead of the file it first opened', async () => {
    const root = await makeRoot()
    const id = 'session-swap'
    const path = seedStore(root, id, 2)
    const ctx = await mount(root)
    expect((await ctx.sessionPersistence.list())[0]?.eventCount).toBe(4)

    // The same conversation re-imported: same id, same directory, different
    // contents, replaced by rename.
    const other = await makeRoot()
    const replacement = seedStore(other, id, 3, CWD)
    await publishDatabase(replacement, path)

    expect((await ctx.sessionPersistence.list())[0]?.eventCount).toBe(6)
  })

  it('cannot be mistaken for the file it replaced, even byte-for-byte', async () => {
    const root = await makeRoot()
    const path = seedStore(root, 'session-twin', 2)
    const copy = join(root, 'twin-copy.db')
    // An identical copy, made to look unchanged by every measure but identity:
    // same bytes, same size, same mtime. This is what a re-import of the same
    // conversation produces, and a stamp built from size and mtime alone calls
    // it "the same file" while every byte behind the connection is stale.
    await copyFile(path, copy)
    const info = await stat(path)
    await utimes(copy, info.atime, info.mtime)

    expect(fileStamp(copy)).not.toBe(fileStamp(path))
  })
})

describe('the trusted length a write open uses', () => {
  it('accepts a sealed store and declines one whose claim disagrees', async () => {
    const root = await makeRoot()
    const path = seedStore(root, 'session-trust', 3)
    const db = SessionDatabase.open(path, READ_SETTINGS)
    try {
      expect(db.trustedLength()).toBe(6)
    } finally {
      db.close()
    }

    dropRows(path, 4)
    const after = SessionDatabase.open(path, READ_SETTINGS)
    try {
      // The rows that remain are still sealed and contiguous, so the fast path
      // has to step aside on the count alone — otherwise it would hand a write
      // handle cursor 6 for a log of four.
      expect(after.trustedLength()).toBeUndefined()
    } finally {
      after.close()
    }
  })
})
