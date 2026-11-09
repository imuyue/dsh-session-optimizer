/**
 * `flush()` on a write handle drains the live buffer.
 *
 * `session/flush` already drains before it calls `flush()`, so the tracker path
 * hides the difference between "flush drains" and "flush only writes the
 * header". A caller holding the handle directly does not go through that event,
 * and for it a resolved `flush()` has to mean everything handed over so far is
 * on disk. The batching window is set to a minute here so the timer cannot
 * account for anything: whatever a flush finds on disk, the flush itself put
 * there.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as SqliteSessionPersistence from '../src/index.ts'

const roots: string[] = []
const contexts: Context[] = []

/** A window long enough that no timer can fire inside one test. */
const NO_TIMER_WINDOW_MS = 60_000

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await ctx.fiber.dispose().catch(() => undefined)
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function mount(): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-flush-'))
  roots.push(root)
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SqliteSessionPersistence, {
    root,
    storageThread: 'inline',
    writeBatchMaxDelayMs: NO_TIMER_WINDOW_MS,
  })
  contexts.push(ctx)
  return ctx
}

async function readAll(persistence: Context['sessionPersistence'], id: ReturnType<typeof SessionId>): Promise<readonly SessionEvent[]> {
  const reader = await persistence.open(id, 'read')
  try {
    return (await reader.read()).events
  } finally {
    await reader.close()
  }
}

describe('flushing a write handle', () => {
  it('writes the events still inside the batching window', async () => {
    const ctx = await mount()
    const session = ctx.sessions.create(SessionId('flush-drains-buffer'))
    const handle = await ctx.sessionPersistence.create(session.header)

    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    // Nothing has reached the database yet: the buffer is waiting out a window
    // that this test never lets expire.
    expect(await readAll(ctx.sessionPersistence, session.id)).toEqual([])

    await handle.flush()

    expect((await readAll(ctx.sessionPersistence, session.id)).map(event => event.seq)).toEqual([0, 1])
    await handle.close()
  })

  it('reports the flush as the barrier even when the window is long', async () => {
    const ctx = await mount()
    const session = ctx.sessions.create(SessionId('flush-then-append'))
    const handle = await ctx.sessionPersistence.create(session.header)

    session.append('turn/start', { turn: 1 })
    await handle.flush()
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await handle.flush()

    // The second flush covered the second event, not just the first.
    expect((await readAll(ctx.sessionPersistence, session.id)).map(event => event.seq)).toEqual([0, 1])
    await handle.close()
  })
})
