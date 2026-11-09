/**
 * The whole acceptance gate for this backend: the two contracts the official
 * `session-persistence` package exports, run against the SQLite backend in both
 * storage modes, plus the layout helpers it must share with the JSONL backend.
 *
 * @module dsh-session-optimizer/tests/sqlite.spec
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import * as SqliteSessionPersistence from '../src/index.ts'
import { databasePath, encodeSegment, projectKey } from '../src/format.ts'
import { DEFAULT_WRITE_BATCH_MAX_DELAY_MS } from '../src/storage.ts'
import { runPersistenceContract } from './vendor/contract.ts'
import { runLiveWritePathContract } from './vendor/live-write-contract.ts'

const roots: string[] = []
const contexts: Context[] = []

type StorageThread = 'inline' | 'worker'

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-'))
  roots.push(root)
  return root
}

async function mount(root: string, storageThread: StorageThread): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SqliteSessionPersistence, { root, storageThread })
  contexts.push(ctx)
  return ctx
}

/** The live path also needs the session store that publishes events. */
async function mountLive(root: string, storageThread: StorageThread): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SqliteSessionPersistence, { root, storageThread })
  contexts.push(ctx)
  return ctx
}

/**
 * Emulate a torn physical tail. SQLite itself is transactional, so the only way
 * a bad row can exist is an out-of-band write; this inserts half a JSON payload
 * with the CHECK constraints disabled, exactly what a truncated append would
 * leave behind.
 */
async function corruptTail(root: string, id: SessionId, cwd: string | undefined): Promise<void> {
  const path = databasePath(root, cwd, id)
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA ignore_check_constraints = ON')
    db.prepare(
      'INSERT INTO session_event (seq, event_type, event_time_ms, event_json) VALUES (?, ?, ?, ?)',
    ).run(6, 'assistant/chunk', 7, '{"type":"assistant/chunk","seq":6,"ti')
  } finally {
    db.close()
  }
}

describe('layout encoding', () => {
  it('escapes everything outside the safe set, matching the JSONL backend', () => {
    expect(encodeSegment('abc-123_x.y')).toBe('abc-123_x.y')
    expect(encodeSegment('.')).toBe('~002E')
    expect(encodeSegment('..')).toBe('~002E~002E')
    expect(encodeSegment('a/b')).toBe('a~002Fb')
    expect(encodeSegment('~')).toBe('~007E')
    expect(() => encodeSegment('')).toThrow(/empty path segment/)
  })

  it('folds separators and rejects an empty project path', () => {
    expect(projectKey('/work/demo')).toBe('--work-demo--')
    expect(projectKey('/work//demo')).toBe('--work-demo--')
    expect(projectKey('C:\\work\\demo')).toBe('--C-work-demo--')
    expect(projectKey('/')).toBe('--root--')
    expect(() => projectKey('')).toThrow(/empty project path/)
  })

  it('places the database one level below the encoded session directory', () => {
    const root = '/sessions'
    expect(databasePath(root, '/work', 'abc' as SessionId)).toBe(
      join(root, '--work--', 'abc', 'session.db'),
    )
    expect(databasePath(root, undefined, 'abc' as SessionId)).toBe(
      join(root, '_no-cwd', 'abc', 'session.db'),
    )
  })
})

const STORAGE_THREADS: readonly StorageThread[] = ['inline', 'worker']

for (const storageThread of STORAGE_THREADS) {
  runPersistenceContract(`sqlite-${storageThread}`, async () => {
    const root = await makeRoot()
    const instance = async () => {
      const ctx = await mount(root, storageThread)
      return {
        persistence: ctx.sessionPersistence,
        dispose: async () => {
          await ctx.fiber.dispose()
        },
      }
    }
    const live = await instance()
    return {
      ...live,
      reopen: instance,
      corruptTail: async (id: SessionId, cwd: string | undefined) => {
        await corruptTail(root, id, cwd)
      },
    }
  })

  runLiveWritePathContract(`sqlite-${storageThread}`, DEFAULT_WRITE_BATCH_MAX_DELAY_MS, async () => {
    const root = await makeRoot()
    const remount = async () => mountLive(root, storageThread)
    return { ctx: await remount(), remount }
  })
}

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
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
  if (failures.length > 0) {
    throw new AggregateError(failures, 'sqlite fixture cleanup failed')
  }
})
