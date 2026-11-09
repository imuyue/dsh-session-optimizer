/**
 * Full-text search: what an event says, and what a query turns into.
 *
 * The index lives with its log, so the two questions worth testing are separate:
 * does the indexed text say what the event means (a tool result is its output,
 * not its JSON envelope), and does a query survive FTS5's own grammar (a user
 * typing `AND` is searching for the word, not asking for a boolean operator).
 * Both fail quietly: a bad extraction still returns hits, just the wrong ones.
 *
 * @module dsh-session-optimizer/tests/search
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionDatabase, ensureSessionDirectory, type SqliteSettings } from '../src/database.ts'
import { InlineExecutor } from '../src/executor.ts'
import { databasePath } from '../src/format.ts'
import { matchQueryFor, searchableText, semanticTextOf } from '../src/search.ts'

const SETTINGS: SqliteSettings = { journalMode: 'wal', synchronous: 'full', busyTimeoutMs: 5000 }

const roots: string[] = []
const stores: SessionDatabase[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-search-'))
  roots.push(root)
  return root
}

function headerOf(id: string, cwd = '/work/search'): SessionHeader {
  return {
    version: 4,
    id: id as SessionId,
    createdAt: 1_700_000_000_000,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
  }
}

/** One turn whose user text and reply are both searchable, and whose seq order is fixed. */
function turn(startSeq: number, turnNumber: number, prompt: string, reply: string): SessionEvent[] {
  const base = startSeq
  return [
    { type: 'turn/start', seq: base, time: base, data: { turn: turnNumber } },
    {
      type: 'user/message',
      seq: base + 1,
      time: base + 1,
      data: {
        id: `msg-user-${String(turnNumber)}`,
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      },
      surfaceOp: 'append',
    },
    { type: 'step/start', seq: base + 2, time: base + 2, data: { turn: turnNumber, step: 1 } },
    {
      type: 'assistant/message',
      seq: base + 3,
      time: base + 3,
      data: {
        turn: turnNumber,
        step: 1,
        message: {
          id: `msg-assistant-${String(turnNumber)}`,
          role: 'assistant',
          content: [{ type: 'text', text: reply }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        },
        stream: [],
      },
      surfaceOp: 'append',
    },
    { type: 'step/end', seq: base + 4, time: base + 4, data: { turn: turnNumber, step: 1 } },
    {
      type: 'turn/end',
      seq: base + 5,
      time: base + 5,
      data: { turn: turnNumber, reason: { kind: 'completed' } },
    },
  ] as never
}

/** A store with one turn about a ranked match, and one about an English error. */
async function seededStore(): Promise<SessionDatabase> {
  const root = await makeRoot()
  await ensureSessionDirectory(root)
  const path = databasePath(root, '/work/search', 'session-search')
  const store = SessionDatabase.open(path, SETTINGS)
  stores.push(store)
  store.appendImported(
    headerOf('session-search'),
    [
      ...turn(0, 1, '今天的排位赛输了三把，帮我看看后台面板', '我看了一下，问题应该在排队逻辑'),
      ...turn(6, 2, 'quick brown fox', 'ENOSPC: no space left on device'),
    ],
    0,
  )
  store.markReady()
  return store
}

afterEach(async () => {
  for (const store of stores.splice(0)) {
    try {
      store.close()
    } catch {
      // A test that already closed its store is not a cleanup failure.
    }
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('the indexed text', () => {
  it('reads a message body and a tool output, not their envelopes', () => {
    expect(semanticTextOf({ type: 'user/message', data: { content: [{ type: 'text', text: '排位赛' }] } } as never)).toBe(
      '排位赛',
    )
    expect(
      semanticTextOf({
        type: 'tool/result',
        data: { message: { content: [{ type: 'text', text: 'exit code 2' }] }, error: { name: 'ENOSPC' } },
      } as never),
    ).toContain('exit code 2')
  })

  it('leaves reasoning and turn closers out of the index', () => {
    expect(
      semanticTextOf({
        type: 'assistant/message',
        data: { message: { content: [{ type: 'reasoning', text: 'private chain of thought' }] } },
      } as never),
    ).toBe('')
    expect(semanticTextOf({ type: 'turn/end', data: { reason: { kind: 'completed' } } } as never)).toBe('')
  })

  it('adds every adjacent CJK pair, so a two-character query can match', () => {
    expect(searchableText('排位赛')).toBe('排位赛 排位 位赛')
  })
})

describe('the query', () => {
  it('quotes operators instead of obeying them', () => {
    expect(matchQueryFor('AND OR')).toBe('"AND" AND "OR"')
    expect(matchQueryFor('NEAR(')).toBe('"NEAR("')
  })

  it('requires every adjacent pair of a CJK term', () => {
    expect(matchQueryFor('排位赛')).toBe('("排位" AND "位赛")')
    expect(matchQueryFor('排位 quick')).toBe('("排位") AND "quick"')
  })

  it('has nothing to search for when only single characters remain', () => {
    expect(matchQueryFor('排')).toBeUndefined()
    expect(matchQueryFor('   ')).toBeUndefined()
  })
})

describe('searching a store', () => {
  it('finds a Chinese pair inside a longer sentence', async () => {
    const store = await seededStore()
    const hits = store.searchHits(matchQueryFor('排位') ?? '', 10)
    expect(hits?.map((hit) => hit.seq)).toContain(1)
    expect(hits?.[0]?.text).toContain('排位赛')
  })

  it('finds English and reports it with the event it came from', async () => {
    const store = await seededStore()
    const hits = store.searchHits(matchQueryFor('ENOSPC') ?? '', 10)
    expect(hits?.map((hit) => hit.seq)).toEqual([9])
    expect(hits?.[0]?.type).toBe('assistant/message')
  })

  it('answers an empty list, not an error, for a word nobody wrote', async () => {
    const store = await seededStore()
    expect(store.searchHits(matchQueryFor('不存在的词') ?? '', 10)).toEqual([])
  })

  it('keeps the index across a close and reopen', async () => {
    const store = await seededStore()
    const path = store.path
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const reopened = SessionDatabase.open(path, SETTINGS)
    stores.push(reopened)
    expect(reopened.searchHits(matchQueryFor('后台面板') ?? '', 10)?.map((hit) => hit.seq)).toEqual([1])
  })

  it('drops the hits a truncation removed', async () => {
    const store = await seededStore()
    expect(store.searchHits(matchQueryFor('ENOSPC') ?? '', 10)).toHaveLength(1)
    store.truncateTail(6)
    expect(store.searchHits(matchQueryFor('ENOSPC') ?? '', 10)).toEqual([])
  })

  it('builds the index for a store written before it existed', async () => {
    const store = await seededStore()
    // Emulate an older store: forget the covered row count and the index rows.
    const raw = store as unknown as { statement: (sql: string) => { run: (...args: unknown[]) => unknown } }
    raw.statement('DELETE FROM event_fts').run()
    raw.statement('UPDATE event_fts_state SET built_rows = 0').run()
    expect(store.searchHits(matchQueryFor('排位') ?? '', 10)?.map((hit) => hit.seq)).toEqual([1])
  })
})

describe('searching a store that predates the index', () => {
  /** A read-only handle cannot build an index, which is the case that used to answer "not found". */
  it('builds the index through a borrowed writable handle, then answers', async () => {
    const store = await seededStore()
    const path = store.path
    const raw = store as unknown as { statement: (sql: string) => { run: (...args: unknown[]) => unknown } }
    raw.statement('DELETE FROM event_fts').run()
    raw.statement('UPDATE event_fts_state SET built_rows = 0').run()
    store.close()
    stores.splice(stores.indexOf(store), 1)

    const executor = new InlineExecutor(2)
    try {
      const readOnly: SqliteSettings = { ...SETTINGS, readOnly: true, repair: false }
      const hits = await executor.searchStore(path, readOnly, matchQueryFor('排位') ?? '', 10)
      expect(hits?.map((hit) => hit.seq)).toEqual([1])
      // The index is written down, so asking again does not rebuild it.
      const again = await executor.searchStore(path, readOnly, matchQueryFor('排位') ?? '', 10)
      expect(again?.map((hit) => hit.seq)).toEqual([1])
    } finally {
      await executor.close()
    }
  })

  it('answers a store written before the index tables existed at all', async () => {
    const store = await seededStore()
    const path = store.path
    const raw = store as unknown as { statement: (sql: string) => { run: (...args: unknown[]) => unknown } }
    raw.statement('DROP TABLE event_fts').run()
    raw.statement('DROP TABLE event_fts_state').run()
    store.close()
    stores.splice(stores.indexOf(store), 1)

    const executor = new InlineExecutor(2)
    try {
      const readOnly: SqliteSettings = { ...SETTINGS, readOnly: true, repair: false }
      const hits = await executor.searchStore(path, readOnly, matchQueryFor('排位') ?? '', 10)
      expect(hits?.map((hit) => hit.seq)).toEqual([1])
    } finally {
      await executor.close()
    }
  })

  it('still reports nothing when the store cannot be written at all', async () => {
    const store = await seededStore()
    const path = store.path
    const raw = store as unknown as { statement: (sql: string) => { run: (...args: unknown[]) => unknown } }
    raw.statement('DELETE FROM event_fts').run()
    raw.statement('UPDATE event_fts_state SET built_rows = 0').run()
    store.close()
    stores.splice(stores.indexOf(store), 1)

    const { chmod } = await import('node:fs/promises')
    await chmod(path, 0o400)
    const executor = new InlineExecutor(2)
    try {
      const readOnly: SqliteSettings = { ...SETTINGS, readOnly: true, repair: false }
      const hits = await executor.searchStore(path, readOnly, matchQueryFor('排位') ?? '', 10)
      // Either the rebuild worked despite the mode (root, Windows) or it refused.
      // What must not happen is an exception escaping into the caller: the
      // panel would show a server error for a word the log may well contain.
      expect(hits === undefined || hits.length === 1).toBe(true)
    } finally {
      await executor.close()
      await chmod(path, 0o600)
    }
  })
})
