/**
 * The tail a crashed writer leaves behind.
 *
 * `dsh-agent-loop` resumes by reading the stored log, deriving closers with
 * `interruptedTurnClosers`, and appending them to the same handle before the
 * session is prepared. This backend does not invent those events — the host owns
 * the repair — but it has to accept them, keep them, and hand them back on the
 * next open, or every resume of a crashed conversation fails validation.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

import * as plugin from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []

const CWD = '/work/closers'

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshsql-closers-'))
  roots.push(root)
  return root
}

async function mount(root: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(plugin, { root, storageThread: 'inline' })
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

/** A turn that started, called a tool, and never ended: the crash shape. */
function crashed(): SessionEvent[] {
  const at = (seq: number): number => 1_700_000_000_000 + seq
  const event = (seq: number, type: string, data: unknown): SessionEvent =>
    ({ type, seq, time: at(seq), data }) as SessionEvent
  return [
    event(0, 'turn/start', { turn: 1 }),
    {
      ...event(1, 'user/message', {
        id: 'msg-user-1',
        role: 'user',
        content: [{ type: 'text', text: '跑一下测试' }],
        source: { kind: 'user' },
      }),
      surfaceOp: 'append',
    } as SessionEvent,
    event(2, 'step/start', { turn: 1, step: 1 }),
    {
      ...event(3, 'assistant/message', {
        turn: 1,
        step: 1,
        message: {
          id: 'msg-assistant-1',
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        },
        stream: [],
      }),
      surfaceOp: 'append',
    } as SessionEvent,
  ]
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

describe('an interrupted turn', () => {
  it('keeps the closers the host derives and reads them back', async () => {
    const ctx = await mount(await makeRoot())
    const handle = await ctx.sessionPersistence.create(headerOf('session-crashed'), { inheritedEventCount: 0 })
    const stored = crashed()
    await handle.append(stored)
    const closers = interruptedTurnClosers(stored)
    expect(closers.map((event) => event.type)).toEqual(['tool/result', 'step/end', 'turn/end'])
    await handle.append(closers)
    await handle.flush()
    await handle.close()

    const reopened = await ctx.sessionPersistence.open('session-crashed' as SessionId, 'read')
    const page = await reopened.read(0)
    await reopened.close()
    // The repair is part of the log now, not a view the next reader has to
    // rebuild: the surviving process would otherwise contradict it.
    expect(page.events.map((event) => event.type)).toEqual([
      'turn/start',
      'user/message',
      'step/start',
      'assistant/message',
      'tool/result',
      'step/end',
      'turn/end',
    ])
    expect((page.events.at(-1)?.data as { reason?: { kind?: string } }).reason?.kind).toBe('interrupted')
  })

  it('does not invent closers for a turn that already ended', async () => {
    const ctx = await mount(await makeRoot())
    const handle = await ctx.sessionPersistence.create(headerOf('session-clean'), { inheritedEventCount: 0 })
    const stored = [
      ...crashed(),
      { type: 'tool/result', seq: 4, time: 1_700_000_000_004, data: {
        turn: 1,
        step: 1,
        message: {
          id: 'msg-tool-1',
          role: 'tool',
          toolCallId: 'call-1',
          source: { kind: 'tool', callId: 'call-1' },
          content: [{ type: 'text', text: 'ok' }],
        },
      } } as SessionEvent,
      { type: 'step/end', seq: 5, time: 1_700_000_000_005, data: { turn: 1, step: 1 } } as SessionEvent,
      { type: 'turn/end', seq: 6, time: 1_700_000_000_006, data: { turn: 1, reason: { kind: 'completed' } } } as SessionEvent,
    ]
    await handle.append(stored)
    await handle.flush()
    await handle.close()
    // Nothing left to close: a repair pass must stay quiet on a whole log.
    expect(interruptedTurnClosers(stored)).toEqual([])
  })
})
