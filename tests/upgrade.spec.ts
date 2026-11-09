import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  SessionDatabase,
  layoutVersionOf,
  type LoadedHeader,
  type SqliteSettings,
} from '../src/database.ts'
import { SCHEMA_VERSION } from '../src/schema.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const SETTINGS: SqliteSettings = { journalMode: 'wal', synchronous: 'full', busyTimeoutMs: 5000 }
const CWD = '/work/upgrade'
const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshsql-upgrade-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function headerOf(id: string): LoadedHeader['header'] {
  return {
    version: 4,
    id,
    createdAt: 1_700_000_000_000,
    cwd: CWD,
    isSeeded: false,
    delegationDepth: 0,
  } as unknown as LoadedHeader['header']
}

function eventAt(seq: number): SessionEvent {
  const turn = Math.floor(seq / 2) + 1
  return seq % 2 === 0
    ? ({ type: 'turn/start', seq, time: 1_700_000_000_000 + seq, data: { turn } } as unknown as SessionEvent)
    : ({
        type: 'turn/end',
        seq,
        time: 1_700_000_000_000 + seq,
        data: { turn, reason: { kind: 'completed' } },
      } as unknown as SessionEvent)
}

function log(count: number): SessionEvent[] {
  return Array.from({ length: count }, (_, index) => eventAt(index))
}

/** Rewrite a store the way the first build left it: version 1, no auxiliary tables. */
function downgrade(path: string): void {
  const db = new DatabaseSync(path)
  try {
    db.exec('DROP TABLE IF EXISTS event_chunk')
    db.exec('DROP TABLE IF EXISTS session_seal')
    db.exec('DROP TABLE IF EXISTS event_fts')
    db.exec('DROP TABLE IF EXISTS event_fts_state')
    db.exec('PRAGMA user_version = 1')
    db.prepare('UPDATE storage_meta SET schema_version = 1 WHERE singleton = 1').run()
  } finally {
    db.close()
  }
}

function tablesOf(path: string): string[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as { name: string }[])
      .map((row) => row.name)
  } finally {
    db.close()
  }
}

describe('the layout upgrader', () => {
  it('moves an old store forward and rewrites both stamps', async () => {
    const directory = await makeRoot()
    const path = join(directory, 'session.db')
    const store = SessionDatabase.open(path, SETTINGS)
    store.appendImported(headerOf('session-old'), log(4), 0)
    store.markReady()
    store.close()

    downgrade(path)
    expect(layoutVersionOf(path)).toBe(1)
    expect(tablesOf(path)).not.toContain('event_chunk')

    const reopened = SessionDatabase.open(path, SETTINGS)
    try {
      // Opening leaves the version alone — that is what keeps a v1 store openable
      // by an older build. The move is the caller's call.
      expect(reopened.upgradedFrom).toBeUndefined()
      expect(reopened.upgradeLayout()).toBe(1)
      expect(layoutVersionOf(path)).toBe(SCHEMA_VERSION)
      expect(tablesOf(path)).toContain('event_chunk')
      // The rows survived: an upgrade is not a rewrite.
      expect(reopened.loadSession()?.events).toHaveLength(4)
    } finally {
      reopened.close()
    }
  })

  it('leaves an already current store alone and says so', async () => {
    const directory = await makeRoot()
    const path = join(directory, 'session.db')
    const store = SessionDatabase.open(path, SETTINGS)
    store.appendImported(headerOf('session-current'), log(2), 0)
    store.markReady()
    store.close()

    const reopened = SessionDatabase.open(path, SETTINGS)
    try {
      expect(reopened.upgradedFrom).toBeUndefined()
      expect(layoutVersionOf(path)).toBe(SCHEMA_VERSION)
    } finally {
      reopened.close()
    }
  })

  it('does not restamp a store it only reads', async () => {
    const directory = await makeRoot()
    const path = join(directory, 'session.db')
    const store = SessionDatabase.open(path, SETTINGS)
    store.appendImported(headerOf('session-read'), log(2), 0)
    store.markReady()
    store.close()

    downgrade(path)
    const reader = SessionDatabase.open(path, { ...SETTINGS, readOnly: true, repair: false })
    try {
      expect(reader.upgradedFrom).toBeUndefined()
      expect(reader.loadSession()?.events).toHaveLength(2)
    } finally {
      reader.close()
    }
    // A reader created its own tables, but the version a writer left behind is
    // still 1: `user_version` is not a reader's to move.
    expect(layoutVersionOf(path)).toBe(1)
  })
})
