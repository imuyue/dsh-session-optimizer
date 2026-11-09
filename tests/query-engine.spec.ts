/**
 * `ctx.sessionQuery`, answered by this backend instead of a second index.
 *
 * The engine subclasses a class from `@deepseek-ai/dsh-session-query`, which
 * belongs to the host: a profile that keeps the released search plugin does not
 * install it, and neither does a checkout without the registry. The suite skips
 * itself when that module cannot be resolved, and says so, rather than failing
 * on an environment it cannot control.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import sessionPlugin from '@deepseek-ai/dsh-session'

import * as plugin from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []

const CWD = '/work/query-engine'

async function hostAvailable(): Promise<boolean> {
  try {
    await import('@deepseek-ai/dsh-session-query')
    return true
  } catch {
    return false
  }
}

const available = await hostAvailable()

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshsql-query-'))
  roots.push(root)
  return root
}

/** Mount the way a profile does: the sessions service first, then the backend. */
async function mount(root: string): Promise<Context> {
  const ctx = new Context()
  ctx.plugin(sessionPlugin, {})
  await ctx.plugin(plugin, {
    root,
    stateDirectory: join(root, 'state'),
    storageThread: 'inline',
    jsonlRoot: '',
    ownSearch: true,
  })
  contexts.push(ctx)
  return ctx
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

function turn(startingAt: number, prompt: string, reply: string): SessionEvent[] {
  const base = 1_700_000_000_000 + startingAt
  return [
    { type: 'turn/start', seq: startingAt, time: base, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: startingAt + 1,
      time: base + 1,
      data: {
        id: `msg-user-${String(startingAt)}`,
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      },
      surfaceOp: 'append',
    },
    { type: 'step/start', seq: startingAt + 2, time: base + 2, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message',
      seq: startingAt + 3,
      time: base + 3,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: `msg-assistant-${String(startingAt)}`,
          role: 'assistant',
          content: [{ type: 'text', text: reply }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        },
        stream: [],
      },
      surfaceOp: 'append',
    },
    { type: 'step/end', seq: startingAt + 4, time: base + 4, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: startingAt + 5, time: base + 5, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

async function seeded(root: string): Promise<Context> {
  const ctx = await mount(root)
  const handle = await ctx.sessionPersistence.create(headerOf('session-search'), { inheritedEventCount: 0 })
  await handle.append(turn(0, '今天的排位赛输了三把，帮我看看后台面板', '排队逻辑里少了一次重试'))
  await handle.flush()
  await handle.close()
  return ctx
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    try {
      await ctx.fiber.dispose()
    } catch {
      // Teardown is best effort; a failure here would mask the assertion.
    }
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe.skipIf(!available)('the session query engine', () => {
  it('answers a session search from the stored log', async () => {
    const ctx = await seeded(await makeRoot())
    const page = await ctx.sessionQuery.searchSessions({ query: '排位' })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.header.id).toBe('session-search')
    expect(page.items[0]?.bestMatch.seq).toBe(1)
    expect(page.items[0]?.bestMatch.snippet).toContain('排位赛')
  })

  it('answers an event search inside one session', async () => {
    const ctx = await seeded(await makeRoot())
    const page = await ctx.sessionQuery.searchEvents({ sessionId: 'session-search', query: '排位' })
    expect(page.items.map((hit) => hit.seq)).toEqual([1])
    expect(page.items[0]?.snippet).toContain('排位赛')
  })

  it('returns nothing for a word the log does not contain', async () => {
    const ctx = await seeded(await makeRoot())
    const page = await ctx.sessionQuery.searchSessions({ query: '不存在的词' })
    expect(page.items).toEqual([])
  })

  it('refuses a page size that cannot be served', async () => {
    const ctx = await seeded(await makeRoot())
    await expect(ctx.sessionQuery.searchSessions({ query: '排位', limit: 0 })).rejects.toThrow(/positive integer/u)
  })
})
