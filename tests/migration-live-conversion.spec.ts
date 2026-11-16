import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it } from 'vitest'
import { SessionBackendCatalog } from '../src/catalog.ts'
import { runMigration } from '../src/migrate.ts'
import { MigrationRuntime } from '../src/migration-runtime.ts'
import { mountJsonl, readJsonlSession, readSqliteSessionById, writeSqliteSession } from '../src/transfer.ts'
import { databasePath } from '../src/format.ts'
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const run of cleanups.splice(0).reverse()) await run() })
async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'dso-live-convert-')); cleanups.push(() => rm(base, { recursive: true, force: true }))
  const mounted = await mountJsonl(join(base, 'jsonl'), 'jsonl'); cleanups.push(() => mounted.dispose())
  const id = 'session-live-fixture' as SessionId
  const header = { version: 4, id, cwd: base, createdAt: 1700000000000, isSeeded: false, delegationDepth: 0 } as SessionHeader
  const events = [{ type: 'session/title', seq: 0, time: 1700000000001, data: { title: 'fixture source' } }] as never
  return { base, mounted, id, header, events, catalog: await SessionBackendCatalog.open(join(base, 'state')), jsonl: { id: 'jsonl' as const, root: join(base, 'jsonl'), persistence: mounted.persistence }, sqlite: { id: 'sqlite' as const, root: join(base, 'sqlite') } }
}
it('first rejects an owned real JSONL writer, then flushes/releases its captured handle before a verified conversion', async () => {
  const f = await setup(), writer = await f.mounted.persistence.create(f.header)
  await writer.append(f.events); await writer.flush(); cleanups.push(() => writer.close())
  const blocked = await runMigration(f.catalog, f.jsonl, f.sqlite, { mode: 'overwrite', verify: true, session: f.id })
  expect(blocked.status).toBe('failed')
  const agent = { id: f.id, status: 'idle', phase: { kind: 'idle' }, inbox: { hasPending: false } }; let active = true
  const handle = { agent, async dispose() { await writer.close(); active = false } }
  const loop = { resume: async () => handle }
  const runtime = new MigrationRuntime({ agentLoop: loop, agents: { get: () => active ? agent : undefined }, sessions: { get: () => ({}), flush: async () => { await writer.flush(); return true } }, sessionController: { state: async () => ({ running: false, queue: [], pendingInput: [] }) } })
  cleanups.push(async () => { runtime.dispose() }); await loop.resume()
  const report = await runMigration(f.catalog, f.jsonl, f.sqlite, { mode: 'overwrite', verify: true, session: f.id }, id => runtime.prepare(id))
  expect(report.status, JSON.stringify(report)).toBe('completed'); expect(active).toBe(false)
  expect((await readSqliteSessionById(f.sqlite.root, f.id, { force: false, verify: true, digest: false, readOnlySources: true }))?.events).toEqual(f.events)
})
it('does not publish over an unrelated active target JSONL kernel lease', async () => {
  const f = await setup()
  await writeSqliteSession(databasePath(f.sqlite.root, f.base, f.id), { header: f.header, events: f.events, inheritedEventCount: 0 })
  const writer = await f.mounted.persistence.create(f.header); cleanups.push(() => writer.close())
  const targetEvents = [{ type: 'session/title', seq: 0, time: 1700000000001, data: { title: 'keep target' } }] as never
  await writer.append(targetEvents); await writer.flush()
  const report = await runMigration(f.catalog, f.sqlite, f.jsonl, { mode: 'overwrite', verify: true, session: f.id })
  expect(report.status, JSON.stringify(report)).toBe('failed')
  await writer.close()
  expect((await readJsonlSession(f.jsonl.root, f.id))?.events).toEqual(targetEvents)
  expect((await readSqliteSessionById(f.sqlite.root, f.id, { force: false, verify: true, digest: false, readOnlySources: true }))?.events).toEqual(f.events)
})
