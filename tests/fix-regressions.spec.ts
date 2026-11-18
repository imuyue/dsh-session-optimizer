import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import * as Plugin from '../src/index.ts'
import { InlineExecutor } from '../src/executor.ts'
import { SessionDatabase } from '../src/database.ts'
import { SessionWriteLease } from '../src/lease.ts'
import { databasePath, sessionDir } from '../src/format.ts'
import { publishDatabase, writeSqliteSession, mountJsonl, findJsonlArtifact, readJsonlSession, type LogCopy } from '../src/transfer.ts'
import { SessionBackendCatalog } from '../src/catalog.ts'
import { runMigration, migrationById, type MigrationJob } from '../src/migrate.ts'
import { registerConsole, type ConsoleConfig } from '../src/console.ts'

// Independent regressions for the five adjudicated runtime defects.
// All runtime execution is restricted to local_vm_linux and synthetic mkdtemp roots.
const settings = { journalMode: 'wal', synchronous: 'full', busyTimeoutMs: 1000 } as const
const roots: string[] = []
const cleanup: Array<() => Promise<unknown> | void> = []
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-five-regressions-'))
  roots.push(path)
  return path
}
function header(id: string): SessionHeader {
  return { version: 4, id: SessionId(id), createdAt: 1700000000000, cwd: '/work/regressions', isSeeded: false, delegationDepth: 0 }
}
function events(tag: string, count: number, size = 1, start = 0): SessionEvent[] {
  return Array.from({ length: count }, (_, i) => {
    const seq = start + i
    return { type: seq % 2 ? 'turn/end' : 'turn/start', seq, time: 1700000000000 + seq,
      data: { turn: (seq >> 1) + 1, ...(seq % 2 ? { reason: { kind: 'completed' } } : {}), note: tag.repeat(size) } }
  }) as SessionEvent[]
}
function copy(id: string, tag: string, count: number, size = 1): LogCopy {
  return { header: header(id), events: events(tag, count, size), inheritedEventCount: 0 }
}
function disk(path: string): readonly SessionEvent[] {
  const db = SessionDatabase.open(path, { ...settings, readOnly: true, repair: false })
  try { return db.loadSession()?.events ?? [] } finally { db.close() }
}
function tagOf(log: readonly SessionEvent[]): unknown {
  return (log[0]?.data as { note?: string } | undefined)?.note?.[0]
}
async function mount(path: string, mode: 'inline' | 'worker', live = false): Promise<Context> {
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  if (live) await ctx.plugin(SessionStore)
  await ctx.plugin(Plugin, { root: path, storageThread: mode, writeBatchMaxDelayMs: 60000 })
  return ctx
}
function injectSealFault(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec("CREATE TRIGGER regression_fail_seal BEFORE UPDATE ON session_seal BEGIN SELECT RAISE(FAIL,'regression reseal failure'); END")
  cleanup.push(() => { try { db.exec('DROP TRIGGER IF EXISTS regression_fail_seal') } finally { db.close() } })
  return db
}
function durableCount(db: DatabaseSync): number {
  return Number((db.prepare('SELECT event_count FROM session').get() as { event_count: number }).event_count)
}
async function outcome(body: () => Promise<unknown>): Promise<boolean> {
  try { await body(); return true } catch { return false }
}
interface Route { path: string; fetch: (request: Request) => Promise<Response> }
function routes(config: ConsoleConfig): Map<string, Route> {
  const result = new Map<string, Route>()
  registerConsole({ connection: { fetch: { register: (route: Route) => { result.set(route.path, route); return async () => {} } } } } as unknown as Context, config)
  return result
}
async function hostClone(routeMap: Map<string, Route>, explicit?: string, direction: 'jsonl_to_sqlite' | 'sqlite_to_jsonl' = 'jsonl_to_sqlite'): Promise<{ response: Response; job?: MigrationJob }> {
  const response = await routeMap.get('/api/session-optimizer/migrate')!.fetch(new Request('http://regression/api/session-optimizer/migrate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ direction, mode: 'clone', verify: true, sessions: ['source'], ...(explicit ? { newSessionId: explicit } : {}) }),
  }))
  if (response.status !== 202) return { response }
  const initial = await response.json() as { id: string }
  await expect.poll(() => migrationById(initial.id)?.status, { timeout: 5000 }).not.toBe('running')
  return { response, job: migrationById(initial.id) }
}

afterEach(async () => {
  vi.restoreAllMocks()
  const failures: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) { try { await close() } catch (error) { failures.push(error) } }
  for (const path of roots.splice(0)) { try { await rm(path, { recursive: true, force: true }) } catch (error) { failures.push(error) } }
  if (failures.length) throw new AggregateError(failures, 'regression fixture cleanup failed')
})

describe('MERGED-01: cache identity after real publish', () => {
  it.each([false, true])('same executor reads replacement (compressed=%s)', async (compressed) => {
    const base = await root(), path = databasePath(base, header('cache').cwd, SessionId('cache'))
    await writeSqliteSession(path, copy('cache', 'A', 80, compressed ? 9000 : 1))
    const executor = new InlineExecutor(2), fresh = new InlineExecutor(1)
    cleanup.push(() => executor.close(), () => fresh.close())
    const before = await executor.loadSession(path, settings, { offset: 0, length: 11 })
    expect(tagOf(before?.events ?? [])).toBe('A')
    if (compressed) expect(executor.frameBytes()).toBeGreaterThan(0)
    else expect(executor.frameBytes()).toBe(0)
    const oldInode = statSync(path).ino
    await writeSqliteSession(`${path}.staged`, copy('cache', 'B', 80, compressed ? 9000 : 1))
    await publishDatabase(`${path}.staged`, path)
    expect(statSync(path).ino).not.toBe(oldInode)
    expect(tagOf((await fresh.loadSession(path, settings, { offset: 0, length: 11 }))?.events ?? [])).toBe('B')
    expect(tagOf(disk(path))).toBe('B')
    expect(tagOf((await executor.loadSession(path, settings, { offset: 0, length: 11 }))?.events ?? [])).toBe('B')
  })

  it('an evicted compressed connection cannot reuse stale frames when the path is republished', async () => {
    const base = await root(), h = header('evicted'), path = databasePath(base, h.cwd, h.id)
    const other = databasePath(base, h.cwd, SessionId('other'))
    await writeSqliteSession(path, copy('evicted', 'A', 80, 9000))
    await writeSqliteSession(other, copy('other', 'X', 2))
    const executor = new InlineExecutor(1)
    cleanup.push(() => executor.close())
    expect(tagOf((await executor.loadSession(path, settings, { offset: 0, length: 11 }))?.events ?? [])).toBe('A')
    expect(executor.frameBytes()).toBeGreaterThan(0)
    // Capacity one guarantees that reading 'other' closes the cached A connection.
    expect(tagOf((await executor.loadSession(other, settings))?.events ?? [])).toBe('X')
    await writeSqliteSession(`${path}.staged`, copy('evicted', 'B', 80, 9000))
    await publishDatabase(`${path}.staged`, path)
    expect(tagOf(disk(path))).toBe('B')
    expect(tagOf((await executor.loadSession(path, settings, { offset: 0, length: 11 }))?.events ?? [])).toBe('B')
  })
})

describe('MERGED-02: acknowledgement, durable state and cursor agree', () => {
  it.each(['inline', 'worker'] as const)('%s append recovers on the same public handle after seal fault', async (mode) => {
    const base = await root(), ctx = await mount(base, mode), h = header('commit')
    const writer = await ctx.sessionPersistence.create(h)
    cleanup.push(() => writer.close())
    await writer.append(events('A', 1))
    const db = injectSealFault(databasePath(base, h.cwd, h.id))
    const acknowledged = await outcome(() => writer.append(events('B', 1, 1, 1)))
    // Either atomic rejection or successful commit is valid; reject+commit is not.
    const expected = acknowledged ? 2 : 1
    expect(durableCount(db)).toBe(expected)
    db.exec('DROP TRIGGER regression_fail_seal')
    await writer.append(events('C', 2, 1, expected))
    await writer.flush()
    const actual = disk(databasePath(base, h.cwd, h.id))
    expect(actual.map(event => Number(event.seq))).toEqual(Array.from({ length: expected + 2 }, (_, i) => i))
    expect(durableCount(db)).toBe(expected + 2)
    await writer.close()
    const reopened = await ctx.sessionPersistence.open(h.id, 'write')
    cleanup.push(() => reopened.close())
    await reopened.append(events('D', 1, 1, expected + 2))
    await reopened.flush()
    expect(disk(databasePath(base, h.cwd, h.id))).toHaveLength(expected + 3)
  })

  it.each(['inline', 'worker'] as const)('%s public live-buffer flush recovers without duplicate or lost events', async (mode) => {
    const base = await root(), ctx = await mount(base, mode, true)
    const session = ctx.sessions.create(SessionId('live-buffer'))
    const writer = await ctx.sessionPersistence.create(session.header)
    cleanup.push(() => writer.close())
    session.append('turn/start', { turn: 1 })
    await writer.flush()
    const path = databasePath(base, session.header.cwd, session.id), db = injectSealFault(path)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const acknowledged = await outcome(() => writer.flush())
    expect(durableCount(db)).toBe(acknowledged ? 2 : 1)
    db.exec('DROP TRIGGER regression_fail_seal')
    await writer.flush() // rejected batch is retained; committed batch is not replayed
    session.append('turn/start', { turn: 2 })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await ctx.sessions.flush(session)
    expect(disk(path).map(event => Number(event.seq))).toEqual([0, 1, 2, 3])
    expect(durableCount(db)).toBe(4)
  })

  it.each(['inline', 'worker'] as const)('%s automatic chunk maintenance failure acknowledges the committed append and keeps cached reads coherent', async (mode) => {
    const base = await root(), ctx = await mount(base, mode), h = header('compact-auto')
    const writer = await ctx.sessionPersistence.create(h)
    cleanup.push(() => writer.close())
    await writer.append(events('A', 80, 9000))
    const path = databasePath(base, h.cwd, h.id), cache = new InlineExecutor(1)
    cleanup.push(() => cache.close())
    expect(tagOf((await cache.loadSession(path, settings, { offset: 0, length: 11 }))?.events ?? [])).toBe('A')
    expect(cache.frameBytes()).toBeGreaterThan(0)
    const db = new DatabaseSync(path)
    cleanup.push(() => { try { db.exec('DROP TRIGGER IF EXISTS regression_fail_chunk') } finally { db.close() } })
    const framesBefore = Number((db.prepare('SELECT count(*) AS n FROM event_chunk').get() as { n: number }).n)
    expect(framesBefore).toBeGreaterThan(0)
    db.exec("CREATE TRIGGER regression_fail_chunk BEFORE INSERT ON event_chunk BEGIN SELECT RAISE(FAIL,'regression chunk maintenance failure'); END")
    const appended = await writer.append(events('B', 80, 9000, 80)).then(() => 'resolved', () => 'rejected')
    expect(durableCount(db)).toBe(160)
    expect(Number((db.prepare('SELECT count(*) AS n FROM event_chunk').get() as { n: number }).n)).toBe(framesBefore)
    const cached = await cache.loadSession(path, settings, { offset: 70, length: 20 })
    expect(cached?.eventCount).toBe(160)
    expect(cached?.events.map(event => Number(event.seq))).toEqual(Array.from({ length: 20 }, (_, i) => i + 70))
    expect(disk(path)).toHaveLength(160)
    expect({ appended, durable: durableCount(db), cached: cached?.eventCount }).toEqual({ appended: 'resolved', durable: 160, cached: 160 })
    db.exec('DROP TRIGGER regression_fail_chunk')
    await writer.append(events('C', 2, 1, 160)); await writer.flush()
    expect((await writer.read()).events.map(event => Number(event.seq))).toEqual(Array.from({ length: 162 }, (_, i) => i))
    expect((await cache.loadSession(path, settings, { offset: 150, length: 20 }))?.events.map(event => Number(event.seq))).toEqual(Array.from({ length: 12 }, (_, i) => i + 150))
    expect(durableCount(db)).toBe(162)
  })

  it('inline post-commit reclaim failure still acknowledges append, invalidates reads, and retries maintenance', async () => {
    const base = await root(), ctx = await mount(base, 'inline'), h = header('reclaim-auto')
    const writer = await ctx.sessionPersistence.create(h); cleanup.push(() => writer.close())
    await writer.append(events('A', 80, 9000))
    const path = databasePath(base, h.cwd, h.id), cache = new InlineExecutor(1)
    cleanup.push(() => cache.close())
    expect(tagOf((await cache.loadSession(path, settings, { offset: 0, length: 11 }))?.events ?? [])).toBe('A')
    expect(cache.frameBytes()).toBeGreaterThan(0)
    const db = new DatabaseSync(path); cleanup.push(() => db.close())
    const framesBefore = Number((db.prepare('SELECT count(*) AS n FROM event_chunk').get() as { n: number }).n)
    // Spy the real private method at its failure boundary, preserving all real
    // append/compact/commit/cache code. Worker SQL-trigger case is separate.
    const prototype = SessionDatabase.prototype as unknown as { reclaim(freedBytes: number): void }
    const realReclaim = prototype.reclaim
    let faulty = true
    const reclaim = vi.spyOn(prototype, 'reclaim').mockImplementation(function(this: SessionDatabase, freedBytes: number) {
      if (faulty) throw new Error('regression post-commit reclaim failure')
      realReclaim.call(this, freedBytes)
    })
    const appended = await writer.append(events('B', 80, 9000, 80)).then(() => 'resolved', () => 'rejected')
    expect(reclaim).toHaveBeenCalled()
    expect(durableCount(db)).toBe(160)
    expect(Number((db.prepare('SELECT count(*) AS n FROM event_chunk').get() as { n: number }).n)).toBeGreaterThan(framesBefore)
    expect((await writer.read()).events).toHaveLength(160)
    const cached = await cache.loadSession(path, settings, { offset: 70, length: 20 })
    expect(cached?.eventCount).toBe(160)
    expect(cached?.events.map(event => Number(event.seq))).toEqual(Array.from({ length: 20 }, (_, i) => i + 70))
    expect({ appended, durable: durableCount(db), cached: cached?.eventCount }).toEqual({ appended: 'resolved', durable: 160, cached: 160 })
    faulty = false
    await writer.append(events('C', 2, 1, 160)); await writer.flush()
    expect(reclaim.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(durableCount(db)).toBe(162)
    expect((await cache.loadSession(path, settings, { offset: 150, length: 20 }))?.events.map(event => Number(event.seq))).toEqual(Array.from({ length: 12 }, (_, i) => i + 150))
  })

  it('explicit compact surfaces the real chunk failure without changing events/count/cache and can retry', async () => {
    const base = await root(), h = header('compact-explicit'), path = databasePath(base, h.cwd, h.id)
    await writeSqliteSession(path, copy('compact-explicit', 'A', 0))
    const store = SessionDatabase.open(path, { ...settings, seal: false })
    cleanup.push(() => store.close())
    store.appendBatch(h, events('A', 80, 9000), true, 0)
    const cache = new InlineExecutor(1)
    cleanup.push(() => cache.close())
    const before = (await cache.loadSession(path, settings, { offset: 10, length: 20 }))?.events
    const db = new DatabaseSync(path)
    cleanup.push(() => { try { db.exec('DROP TRIGGER IF EXISTS regression_fail_chunk') } finally { db.close() } })
    expect(Number((db.prepare('SELECT count(*) AS n FROM event_chunk').get() as { n: number }).n)).toBe(0)
    db.exec("CREATE TRIGGER regression_fail_chunk BEFORE INSERT ON event_chunk BEGIN SELECT RAISE(FAIL,'regression explicit compact failure'); END")
    expect(() => store.compact()).toThrow(/regression explicit compact failure/)
    expect(durableCount(db)).toBe(80)
    expect(disk(path).map(event => Number(event.seq))).toEqual(Array.from({ length: 80 }, (_, i) => i))
    expect((await cache.loadSession(path, settings, { offset: 10, length: 20 }))?.events).toEqual(before)
    expect(store.loadHeader()?.eventCount).toBe(80)
    db.exec('DROP TRIGGER regression_fail_chunk')
    expect(() => store.compact()).not.toThrow()
    expect(Number((db.prepare('SELECT count(*) AS n FROM event_chunk').get() as { n: number }).n)).toBeGreaterThan(0)
    expect((await cache.loadSession(path, settings, { offset: 10, length: 20 }))?.events).toEqual(before)
    store.appendBatch(h, events('C', 2, 1, 80), true, 0)
    expect(durableCount(db)).toBe(82)
    expect((await cache.loadSession(path, settings, { offset: 70, length: 20 }))?.events.map(event => Number(event.seq))).toEqual(Array.from({ length: 12 }, (_, i) => i + 70))
    store.appendBatch(h, events('B', 80, 9000, 82), true, 0)
    const prototype = SessionDatabase.prototype as unknown as { reclaim(freedBytes: number): void }
    const reclaim = vi.spyOn(prototype, 'reclaim').mockImplementation(() => { throw new Error('regression explicit post-commit reclaim failure') })
    expect(() => store.compact()).toThrow(/regression explicit post-commit reclaim failure/)
    expect(reclaim).toHaveBeenCalled()
    expect(durableCount(db)).toBe(162)
    expect(store.loadHeader()?.eventCount).toBe(162)
    expect(store.loadSession()?.events.map(event => Number(event.seq))).toEqual(Array.from({ length: 162 }, (_, i) => i))
    expect((await cache.loadSession(path, settings, { offset: 150, length: 20 }))?.events.map(event => Number(event.seq))).toEqual(Array.from({ length: 12 }, (_, i) => i + 150))
    reclaim.mockRestore()
    expect(() => store.compact()).not.toThrow()
    expect(durableCount(db)).toBe(162)
  })

  it.each(['inline', 'worker'] as const)('%s event INSERT fault rolls back the whole batch and keeps handle/count/cache consistent', async (mode) => {
    const base = await root(), ctx = await mount(base, mode), h = header('event-insert')
    const writer = await ctx.sessionPersistence.create(h)
    cleanup.push(() => writer.close())
    await writer.append(events('A', 80, 9000))
    const path = databasePath(base, h.cwd, h.id), cache = new InlineExecutor(1)
    cleanup.push(() => cache.close())
    expect((await cache.loadSession(path, settings, { offset: 0, length: 11 }))?.events).toHaveLength(11)
    expect(cache.frameBytes()).toBeGreaterThan(0)
    expect((await cache.loadSession(path, settings, { offset: 70, length: 20 }))?.events).toHaveLength(10)
    const db = new DatabaseSync(path)
    cleanup.push(() => { try { db.exec('DROP TRIGGER IF EXISTS regression_fail_event') } finally { db.close() } })
    db.exec("CREATE TRIGGER regression_fail_event BEFORE INSERT ON session_event WHEN NEW.seq = 81 BEGIN SELECT RAISE(FAIL,'regression second event INSERT failure'); END")
    await expect(writer.append(events('B', 2, 1, 80))).rejects.toThrow(/regression second event INSERT failure/)
    expect(durableCount(db)).toBe(80)
    expect(Number((db.prepare('SELECT count(*) AS n FROM session_event WHERE seq >= 80').get() as { n: number }).n)).toBe(0)
    const cached = await cache.loadSession(path, settings, { offset: 70, length: 20 })
    expect(cached?.eventCount).toBe(80)
    expect(cached?.events.map(event => Number(event.seq))).toEqual(Array.from({ length: 10 }, (_, i) => i + 70))
    expect((await writer.read()).events).toHaveLength(80)
    db.exec('DROP TRIGGER regression_fail_event')
    await writer.append(events('B', 2, 1, 80)); await writer.flush()
    expect(durableCount(db)).toBe(82)
    expect((await cache.loadSession(path, settings, { offset: 70, length: 20 }))?.events.map(event => Number(event.seq))).toEqual(Array.from({ length: 12 }, (_, i) => i + 70))
  })
})

describe('MERGED-03: overwrite excludes an active source writer', () => {
  it('blocks before any source/target/catalog mutation, then migrates the acknowledged prefix after release', async () => {
    const base = await root(), sourceRoot = join(base, 'sqlite'), targetRoot = join(base, 'jsonl')
    const ctx = await mount(sourceRoot, 'inline'), h = header('leased-source')
    const writer = await ctx.sessionPersistence.create(h)
    cleanup.push(() => writer.close())
    await writer.append(events('S', 2)); await writer.flush()
    const path = databasePath(sourceRoot, h.cwd, h.id), sourceBefore = disk(path)
    const catalog = await SessionBackendCatalog.open(join(base, 'state'))
    catalog.route(h.id, 'sqlite'); await catalog.save()
    const catalogBytes = await readFile(catalog.location), routesBefore = catalog.list()
    const contention = await outcome(async () => { const lease = await SessionWriteLease.acquire(dirname(path), h.id); await lease.release() })
    expect(contention).toBe(false)
    const blocked = await runMigration(catalog, { id: 'sqlite', root: sourceRoot, persistence: ctx.sessionPersistence }, { id: 'jsonl', root: targetRoot }, { mode: 'overwrite', verify: true, session: h.id })
    expect(blocked.status).toBe('failed')
    expect(blocked.items[0]?.error ?? blocked.error).toMatch(/owned|active|lease|lock/i)
    expect(disk(path)).toEqual(sourceBefore)
    expect(existsSync(targetRoot)).toBe(false)
    expect(catalog.list()).toEqual(routesBefore)
    expect(await readFile(catalog.location)).toEqual(catalogBytes)
    expect(existsSync(`${sourceRoot}.replaced`)).toBe(false)
    await writer.append(events('N', 2, 1, 2)); await writer.flush()
    const acknowledged = disk(path)
    expect(acknowledged).toHaveLength(4)
    await writer.close()
    const completed = await runMigration(catalog, { id: 'sqlite', root: sourceRoot }, { id: 'jsonl', root: targetRoot }, { mode: 'overwrite', verify: true, session: h.id })
    expect(completed.status).toBe('completed')
    expect(catalog.backendOf(h.id)).toBe('jsonl')
    const target = await mountJsonl(targetRoot, 'jsonl'); cleanup.push(() => target.dispose())
    const reader = await target.persistence.open(h.id, 'read'); cleanup.push(() => reader.close())
    expect((await reader.read()).events).toEqual(acknowledged)
    const archived = completed.items[0]?.archivedTo
    expect(archived).toBeDefined()
    expect(disk(join(archived!, 'session.db'))).toEqual(acknowledged)
  }, 10000)

  it('blocks an active JSONL source writer, preserves its bytes/routes, then migrates its acknowledged events after release', async () => {
    const base = await root(), jsonlRoot = join(base, 'jsonl'), sqliteRoot = join(base, 'sqlite'), h = header('jsonl-live')
    const source = await mountJsonl(jsonlRoot, 'jsonl'); cleanup.push(() => source.dispose())
    const writer = await source.persistence.create(h); cleanup.push(() => writer.close())
    await writer.append(events('J', 2)); await writer.flush()
    const original = await findJsonlArtifact(jsonlRoot, String(h.id))
    expect(original).toBeDefined()
    const before = await readFile(original!.path)
    const catalog = await SessionBackendCatalog.open(join(base, 'state'))
    catalog.route(h.id, 'jsonl'); await catalog.save()
    const beforeCatalog = await readFile(catalog.location), beforeRoutes = catalog.list()
    const blocked = await runMigration(catalog, { id: 'jsonl', root: jsonlRoot, persistence: source.persistence }, { id: 'sqlite', root: sqliteRoot }, { mode: 'overwrite', verify: true, session: h.id })
    expect(blocked.status).toBe('failed')
    expect(blocked.items[0]?.error ?? blocked.error).toMatch(/owned|active|lease|lock/i)
    expect(await readFile(original!.path)).toEqual(before)
    expect(existsSync(sqliteRoot)).toBe(false)
    expect(existsSync(`${jsonlRoot}.replaced`)).toBe(false)
    expect(catalog.list()).toEqual(beforeRoutes)
    expect(await readFile(catalog.location)).toEqual(beforeCatalog)
    await writer.append(events('N', 2, 1, 2)); await writer.flush()
    const acknowledged = await readFile(original!.path)
    await writer.close()
    const completed = await runMigration(catalog, { id: 'jsonl', root: jsonlRoot, persistence: source.persistence }, { id: 'sqlite', root: sqliteRoot }, { mode: 'overwrite', verify: true, session: h.id })
    expect(completed.status).toBe('completed')
    expect(disk(databasePath(sqliteRoot, h.cwd, h.id)).map(event => Number(event.seq))).toEqual([0, 1, 2, 3])
    expect(catalog.backendOf(h.id)).toBe('sqlite')
    const archived = completed.items[0]!.archivedTo!
    expect(archived).toBeDefined()
    const archivedFile = statSync(archived).isFile() ? archived : join(archived, 'session.v4.jsonl')
    expect(await readFile(archivedFile)).toEqual(acknowledged)
  }, 10000)

  it('target-lock contention releases the source lease and preserves source/target/catalog', async () => {
    const base = await root(), sqliteRoot = join(base, 'sqlite'), jsonlRoot = join(base, 'jsonl'), h = header('contended')
    const path = databasePath(sqliteRoot, h.cwd, h.id)
    await writeSqliteSession(path, copy('contended', 'S', 2))
    const target = await mountJsonl(jsonlRoot, 'jsonl'); cleanup.push(() => target.dispose())
    const targetWriter = await target.persistence.create(h); await targetWriter.append(events('T', 4)); await targetWriter.close()
    const targetBefore = await readJsonlSession(jsonlRoot, String(h.id)), sourceBefore = disk(path)
    const catalog = await SessionBackendCatalog.open(join(base, 'state'))
    catalog.route(h.id, 'sqlite'); await catalog.save()
    const catalogBefore = await readFile(catalog.location)
    // The JSONL provider arbitrates its own writers: POSIX `flock` on
    // `session.lock`, a named kernel semaphore on Windows. Taking this plugin's
    // marker lease here would prove nothing about the provider's exclusion, so
    // the contention is set up through the provider's own arbiter.
    const provider = target.persistence as typeof target.persistence & {
      acquireLease(id: SessionId, cwd: string | undefined, dir: string): Promise<{ release(): Promise<void> }>
    }
    const heldTarget = await provider.acquireLease(h.id, h.cwd, sessionDir(jsonlRoot, h.cwd, h.id))
    cleanup.push(() => heldTarget.release())
    const blocked = await runMigration(catalog, { id: 'sqlite', root: sqliteRoot }, { id: 'jsonl', root: jsonlRoot }, { mode: 'overwrite', verify: true, session: h.id })
    expect(blocked.status).toBe('failed')
    expect(disk(path)).toEqual(sourceBefore)
    expect((await readJsonlSession(jsonlRoot, String(h.id)))?.events).toEqual(targetBefore?.events)
    expect(await readFile(catalog.location)).toEqual(catalogBefore)
    const releasedSource = await SessionWriteLease.acquire(dirname(path), h.id)
    await releasedSource.release()
    await heldTarget.release()
  }, 10000)

  it('a source-archive failure reports a recoverable leftover and releases both leases for retry', async () => {
    const base = await root(), sqliteRoot = join(base, 'sqlite'), jsonlRoot = join(base, 'jsonl'), h = header('archive-retry')
    const path = databasePath(sqliteRoot, h.cwd, h.id), acknowledged = copy('archive-retry', 'S', 4)
    await writeSqliteSession(path, acknowledged)
    const catalog = await SessionBackendCatalog.open(join(base, 'state'))
    catalog.route(h.id, 'sqlite'); await catalog.save()
    // ENOTDIR is deterministic, including privileged VM users, unlike chmod.
    await writeFile(`${sqliteRoot}.replaced`, 'archive parent deliberately blocked')
    const first = await runMigration(catalog, { id: 'sqlite', root: sqliteRoot }, { id: 'jsonl', root: jsonlRoot }, { mode: 'overwrite', verify: true, session: h.id })
    expect(first.status).toBe('completed')
    expect(first.items[0]?.error).toMatch(/set aside|archive/i)
    expect(disk(path)).toEqual(acknowledged.events)
    expect((await readJsonlSession(jsonlRoot, String(h.id)))?.events).toEqual(acknowledged.events)
    expect(catalog.backendOf(h.id)).toBe('jsonl')
    await rm(`${sqliteRoot}.replaced`)
    const retried = await runMigration(catalog, { id: 'sqlite', root: sqliteRoot }, { id: 'jsonl', root: jsonlRoot }, { mode: 'overwrite', verify: true, session: h.id })
    expect(retried.status).toBe('completed')
    expect(retried.items[0]?.error).toBeUndefined()
    expect(retried.items[0]?.archivedTo).toBeDefined()
    expect(disk(join(retried.items[0]!.archivedTo!, 'session.db'))).toEqual(acknowledged.events)
    expect((await readJsonlSession(jsonlRoot, String(h.id)))?.events).toEqual(acknowledged.events)
  }, 10000)

  it('two reverse-direction migrations settle without deadlock and retain every source event', async () => {
    const base = await root(), sqliteRoot = join(base, 'sqlite'), jsonlRoot = join(base, 'jsonl')
    await writeSqliteSession(databasePath(sqliteRoot, header('left').cwd, SessionId('left')), copy('left', 'L', 2))
    const jsonl = await mountJsonl(jsonlRoot, 'jsonl'); cleanup.push(() => jsonl.dispose())
    const writer = await jsonl.persistence.create(header('right')); await writer.append(events('R', 2)); await writer.close()
    const catalog = await SessionBackendCatalog.open(join(base, 'state'))
    const [left, right] = await Promise.all([
      runMigration(catalog, { id: 'sqlite', root: sqliteRoot }, { id: 'jsonl', root: jsonlRoot }, { mode: 'overwrite', verify: true, session: 'left' }),
      runMigration(catalog, { id: 'jsonl', root: jsonlRoot, persistence: jsonl.persistence }, { id: 'sqlite', root: sqliteRoot }, { mode: 'overwrite', verify: true, session: 'right' }),
    ])
    expect([left.status, right.status]).toEqual(['completed', 'completed'])
    expect(tagOf(disk(databasePath(sqliteRoot, header('right').cwd, SessionId('right'))))).toBe('R')
    const reader = await jsonl.persistence.open(SessionId('left'), 'read'); cleanup.push(() => reader.close())
    expect(tagOf((await reader.read()).events)).toBe('L')
  }, 10000)
})

describe('MERGED-05: Host clone never replaces an existing identity', () => {
  async function fixture() {
    const base = await root(), jsonlRoot = join(base, 'jsonl'), sqliteRoot = join(base, 'sqlite')
    const source = await mountJsonl(jsonlRoot, 'jsonl'); cleanup.push(() => source.dispose())
    const writer = await source.persistence.create(header('source')); await writer.append(events('S', 2)); await writer.close()
    const catalog = await SessionBackendCatalog.open(join(base, 'state'))
    const config: ConsoleConfig = { root: sqliteRoot, jsonlRoot, settings, storageThread: 'inline', migrations: { catalog, jsonl: { id: 'jsonl', root: jsonlRoot, persistence: source.persistence }, sqlite: { id: 'sqlite', root: sqliteRoot } } }
    return { source, catalog, sqliteRoot, jsonlRoot, routeMap: routes(config) }
  }
  it('explicit existing sqlite id fails with original bytes/events/catalog preserved; random id succeeds', async () => {
    const f = await fixture(), dest = databasePath(f.sqliteRoot, header('existing').cwd, SessionId('existing'))
    await writeSqliteSession(dest, copy('existing', 'T', 4))
    const before = await readFile(dest), beforeEvents = disk(dest), beforeCatalog = f.catalog.list()
    const collision = await hostClone(f.routeMap, 'existing')
    expect(collision.response.status >= 400 || collision.job?.status === 'failed').toBe(true)
    expect(await readFile(dest)).toEqual(before)
    expect(disk(dest)).toEqual(beforeEvents)
    expect(f.catalog.list()).toEqual(beforeCatalog)
    const successful = await hostClone(f.routeMap)
    expect(successful.response.status).toBe(202)
    expect(successful.job?.status).toBe('completed')
    const cloneId = successful.job?.report?.items[0]?.targetSession
    expect(cloneId).toBeDefined(); expect(cloneId).not.toBe('source'); expect(cloneId).not.toBe('existing')
    expect(tagOf(disk(databasePath(f.sqliteRoot, header('source').cwd, SessionId(cloneId!))))).toBe('S')
    expect(await readFile(dest)).toEqual(before)
    const source = await f.source.persistence.open(SessionId('source'), 'read'); cleanup.push(() => source.close())
    expect((await source.read()).events).toHaveLength(2)
  })

  it('rechecks a target created by a competing lease holder immediately before target acquisition', async () => {
    const f = await fixture(), dest = databasePath(f.sqliteRoot, header('race').cwd, SessionId('race'))
    const acquire = SessionWriteLease.acquire.bind(SessionWriteLease)
    let injected = false
    vi.spyOn(SessionWriteLease, 'acquire').mockImplementation(async (dir, id) => {
      if (!injected && dir === dirname(dest)) {
        injected = true
        const competing = await acquire(dir, id)
        try { await writeSqliteSession(dest, copy('race', 'T', 4)) } finally { await competing.release() }
      }
      return acquire(dir, id)
    })
    const collision = await hostClone(f.routeMap, 'race')
    expect(injected).toBe(true)
    expect(collision.response.status >= 400 || collision.job?.status === 'failed').toBe(true)
    expect(tagOf(disk(dest))).toBe('T')
    expect(disk(dest)).toHaveLength(4)
    expect(f.catalog.get('race')).toBeUndefined()
  })

  it('an existing sqlite id in another cwd is preserved instead of duplicating its identity', async () => {
    const f = await fixture(), oldHeader = { ...header('elsewhere'), cwd: '/different/project' }
    const existing = databasePath(f.sqliteRoot, oldHeader.cwd, oldHeader.id)
    const planned = databasePath(f.sqliteRoot, header('source').cwd, oldHeader.id)
    await writeSqliteSession(existing, { ...copy('elsewhere', 'T', 4), header: oldHeader })
    const before = await readFile(existing), beforeEvents = disk(existing), beforeCatalog = f.catalog.list()
    const collision = await hostClone(f.routeMap, 'elsewhere')
    expect(collision.response.status >= 400 || collision.job?.status === 'failed').toBe(true)
    expect(await readFile(existing)).toEqual(before)
    expect(disk(existing)).toEqual(beforeEvents)
    expect(existsSync(planned)).toBe(false)
    expect(f.catalog.list()).toEqual(beforeCatalog)
  })

  it('actual Host sqlite-to-jsonl clone preserves an existing JSONL identity in another cwd', async () => {
    const f = await fixture()
    await writeSqliteSession(databasePath(f.sqliteRoot, header('source').cwd, SessionId('source')), copy('source', 'S', 2))
    const oldHeader = { ...header('jsonl-existing'), cwd: '/different/jsonl' }
    const writer = await f.source.persistence.create(oldHeader)
    await writer.append(events('T', 4)); await writer.close()
    const existing = await findJsonlArtifact(f.jsonlRoot, 'jsonl-existing')
    expect(existing).toBeDefined()
    const before = await readFile(existing!.path), beforeEvents = (await readJsonlSession(f.jsonlRoot, 'jsonl-existing'))?.events
    const beforeCatalog = f.catalog.list()
    const collision = await hostClone(f.routeMap, 'jsonl-existing', 'sqlite_to_jsonl')
    expect(collision.response.status >= 400 || collision.job?.status === 'failed').toBe(true)
    expect(await readFile(existing!.path)).toEqual(before)
    expect((await readJsonlSession(f.jsonlRoot, 'jsonl-existing'))?.events).toEqual(beforeEvents)
    expect(f.catalog.list()).toEqual(beforeCatalog)
    expect(existsSync(sessionDir(f.jsonlRoot, header('source').cwd, SessionId('jsonl-existing')))).toBe(false)
  })

  it('catalog-only identity is also reserved', async () => {
    const f = await fixture()
    f.catalog.route('reserved', 'jsonl'); await f.catalog.save()
    const before = await readFile(f.catalog.location), entries = f.catalog.list()
    const collision = await hostClone(f.routeMap, 'reserved')
    expect(collision.response.status >= 400 || collision.job?.status === 'failed').toBe(true)
    expect(f.catalog.list()).toEqual(entries)
    expect(await readFile(f.catalog.location)).toEqual(before)
    expect(existsSync(databasePath(f.sqliteRoot, header('reserved').cwd, SessionId('reserved')))).toBe(false)
  })
})
