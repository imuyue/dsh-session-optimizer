/**
 * Regression: a v1 store must be readable by a pure reader.
 *
 * The inspector opens stores with `readOnly: true, repair: false`, so it cannot
 * create tables. A store written before frames existed has no `event_chunk` at
 * all; every query that named it used to throw `no such table: event_chunk` and
 * the whole conversation became unreadable. The store open must therefore decide
 * once whether the table is there.
 *
 * @module dsh-session-optimizer/tests/legacy
 */

import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionDatabase, ensureSessionDirectory } from '../src/database.ts'
import { databasePath } from '../src/format.ts'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'

const SETTINGS = { journalMode: 'wal', synchronous: 'full', busyTimeoutMs: 5000 } as const
const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshsql-legacy-'))
  roots.push(root)
  return root
}

function headerOf(id: string, cwd = '/work/legacy'): SessionHeader {
  return {
    id,
    version: 4,
    createdAt: 1_700_000_000_000,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
  } as unknown as SessionHeader
}

function turn(startSeq: number, turn: number): SessionEvent[] {
  return [
    { type: 'turn/start', seq: startSeq, time: startSeq * 10, data: { turn } },
    { type: 'turn/end', seq: startSeq + 1, time: startSeq * 10 + 1, data: { turn } },
  ] as unknown as SessionEvent[]
}

/** A store as the build before frames wrote it: rows only, no chunk table. */
async function seedV1(root: string, id: string, events: SessionEvent[]): Promise<string> {
  const path = databasePath(root, '/work/legacy', id as never)
  ensureSessionDirectory(join(root, '--work-legacy--', id))
  const db = SessionDatabase.open(path, SETTINGS)
  db.appendImported(headerOf(id), events, 0)
  db.markReady()
  db.close()
  const raw = new DatabaseSync(path)
  try {
    // What v1 means: the log is the rows, and the table that would seal them
    // does not exist. Dropping it (rather than never creating it) is the same
    // file state a store from the older build has.
    raw.exec('DROP TABLE IF EXISTS event_chunk')
    raw.exec('PRAGMA user_version = 1')
  } finally {
    raw.close()
  }
  return path
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('a store without the chunk table', () => {
  it('reads its whole log, and reports it as unsealed', async () => {
    const root = await makeRoot()
    const events = [...turn(0, 1), ...turn(2, 2)]
    const path = await seedV1(root, 'session-v1', events)

    const reader = SessionDatabase.open(path, { ...SETTINGS, readOnly: true, repair: false })
    try {
      const loaded = reader.loadSession()
      expect(loaded.events.map((event) => event.seq)).toEqual([0, 1, 2, 3])
      expect(loaded.eventCount).toBe(4)
      expect(loaded.tornTruncateTo).toBeUndefined()
    } finally {
      reader.close()
    }
  })

  it('serves a window without the chunk table', async () => {
    const root = await makeRoot()
    const events = [...turn(0, 1), ...turn(2, 2), ...turn(4, 3)]
    const path = await seedV1(root, 'session-v1-window', events)

    const reader = SessionDatabase.open(path, { ...SETTINGS, readOnly: true, repair: false })
    try {
      const window = reader.loadSession({ offset: 1, length: 2 })
      expect(window.events.map((event) => event.seq)).toEqual([1, 2])
    } finally {
      reader.close()
    }
  })

  it('does not create the table behind a reader\'s back', async () => {
    const root = await makeRoot()
    const path = await seedV1(root, 'session-v1-untouched', turn(0, 1))
    const before = (await fs.stat(path)).size

    const reader = SessionDatabase.open(path, { ...SETTINGS, readOnly: true, repair: false })
    try {
      reader.loadSession()
    } finally {
      reader.close()
    }

    const raw = new DatabaseSync(path, { readOnly: true })
    try {
      const row = raw
        .prepare(`SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'event_chunk'`)
        .get()
      expect(row).toBeUndefined()
      expect((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1)
    } finally {
      raw.close()
    }
    expect((await fs.stat(path)).size).toBe(before)
  })
})
