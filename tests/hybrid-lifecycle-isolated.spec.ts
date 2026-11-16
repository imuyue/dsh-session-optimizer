import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { describe, it, expect } from 'vitest'
import * as Optimizer from '../src/index.ts'

describe('hybrid isolated lifecycle on host-valid paths', () => {
  for (const storageThread of ['inline', 'worker'] as const) it(`drains acknowledged events on disposal and preserves lists across three mounts (${storageThread})`, async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-hybrid-lifecycle-'))
    const config = { hybrid: true, root: join(base, 'sqlite'), jsonlRoot: join(base, 'jsonl'), stateDirectory: join(base, 'state'), storageThread, warmupSessions: 0 }
    const expected = new Map<string, unknown[]>()
    try {
      for (let round = 0; round < 3; round++) {
        const ctx = new Context()
        try {
          await ctx.plugin(SessionStore)
          await ctx.plugin(Optimizer, { ...config, newSessionBackend: round === 1 ? 'sqlite' : 'jsonl' })
          const persistence = ctx.get('sessionPersistence')
          expect((await persistence.list()).map(s=>String(s.header.id)).sort()).toEqual([...expected.keys()].sort())
          for (const [id, events] of expected) {
            const reader = await persistence.open(id as SessionId, 'read')
            try { expect((await reader.read(0)).events).toEqual(events) } finally { await reader.close() }
          }
          const id = `lifecycle-${storageThread}-${round}` as SessionId
          const sessions = ctx.get('sessions')
          const session = sessions.prepare(id, { meta: { cwd: base, isSeeded: false } })
          const writer = await persistence.create(session.header, {})
          sessions.enter(session); sessions.announce(session)
          session.append('turn/start', { turn: 1 })
          session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
          await sessions.flush(session)
          const reader = await persistence.open(id, 'read')
          try { const events = (await reader.read(0)).events; expect(events).toHaveLength(2); expected.set(id, [...events]) } finally { await reader.close() }
          // The owning Context must drain/close this still-open writer on unload.
          void writer
          expect((await persistence.list()).map(s=>String(s.header.id)).sort()).toEqual([...expected.keys()].sort())
        } finally { await ctx.fiber.dispose() }
      }
      const verify = new Context()
      try {
        await verify.plugin(SessionStore)
        await verify.plugin(Optimizer, { ...config, newSessionBackend: 'sqlite' })
        for (const [id, events] of expected) {
          const reader = await verify.get('sessionPersistence').open(id as SessionId, 'read')
          try { expect((await reader.read(0)).events).toEqual(events) } finally { await reader.close() }
        }
        expect((await verify.get('sessionPersistence').list()).map(s=>String(s.header.id)).sort()).toEqual([...expected.keys()].sort())
      } finally { await verify.fiber.dispose() }
    } finally { await rm(base, { recursive: true, force: true }) }
  }, 20000)
})
