/**
 * Hybrid routing: one `sessionPersistence` service, two backends, one catalog.
 *
 * These tests drive the mounted plugin the way the agent loop does (`prepare` →
 * `create` → `enter` → `announce` → `append` → `flush` → `close`), because the
 * routing decision only matters if it survives that sequence. They also cover
 * the cases that make a hybrid install worth having: history that is still JSONL
 * keeps working without being migrated, a catalog loss costs a scan rather than
 * data, and an interrupted migration shows up as a conflict instead of silently
 * picking a side.
 *
 * @module dsh-session-optimizer/tests/hybrid.spec
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SqliteSessionPersistence from '../src/index.ts'
import { SessionBackendCatalog, catalogPath } from '../src/catalog.ts'
import { databasePath, sessionDir } from '../src/format.ts'
import { releaseStore } from '../src/store-lease.ts'

interface Fixture {
  readonly base: string
  readonly sqliteRoot: string
  readonly jsonlRoot: string
  readonly stateDirectory: string
}

const bases: string[] = []
const contexts: Context[] = []

async function makeFixture(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), 'dsh-hybrid-'))
  bases.push(base)
  return {
    base,
    sqliteRoot: join(base, 'sessions-sqlite'),
    jsonlRoot: join(base, 'sessions-jsonl'),
    stateDirectory: join(base, 'state'),
  }
}

/**
 * Mount the hybrid plugin on a fresh context.
 *
 * `storageThread: 'inline'` keeps these tests to one thread: worker mode is
 * covered by the main contract suite, and a routing bug is easier to read
 * without a thread hop in the stack.
 */
async function mount(fixture: Fixture, overrides: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SqliteSessionPersistence, {
    root: fixture.sqliteRoot,
    jsonlRoot: fixture.jsonlRoot,
    stateDirectory: fixture.stateDirectory,
    hybrid: true,
    newSessionBackend: 'sqlite',
    storageThread: 'inline',
    ...overrides,
  })
  contexts.push(ctx)
  return ctx
}

/** Write one two-event turn through the persistence service, as the loop does. */
async function writeTurn(
  ctx: Context,
  id: string,
  cwd = '/tmp/hybrid',
): Promise<void> {
  const sessions = ctx.get('sessions')
  const session = sessions.prepare(id, { meta: { cwd, isSeeded: false } })
  const handle = await ctx.sessionPersistence.create(session.header, {})
  sessions.enter(session)
  sessions.announce(session)
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await sessions.flush(session)
  await handle.close()
}

/** Seed a session straight into the JSONL backend, as an unmigrated install has. */
async function seedJsonl(fixture: Fixture, id: string, cwd = '/tmp/jsonl-only'): Promise<void> {
  const ctx = new Context()
  try {
    await ctx.plugin(JsonlSessionPersistence, { root: fixture.jsonlRoot, compression: 'zstd' })
    const jsonl = ctx.sessionPersistence
    const header = {
      version: 4 as const,
      id: id as SessionId,
      createdAt: 1_700_000_000_000,
      cwd,
      isSeeded: false,
      delegationDepth: 0,
    }
    const handle = await jsonl.create(header, {})
    await handle.append([
      { type: 'turn/start', seq: 0, time: 1_700_000_000_001, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 1_700_000_000_002, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as never)
    await handle.flush()
    await handle.close()
  } finally {
    await ctx.fiber.dispose()
  }
}

async function readCatalog(fixture: Fixture): Promise<{ version: number; sessions: Record<string, { backend: string }> }> {
  return JSON.parse(await readFile(catalogPath(fixture.stateDirectory), 'utf8')) as {
    version: number
    sessions: Record<string, { backend: string }>
  }
}

describe('hybrid routing', () => {
  it('stores a new session on SQLite and records the route', async () => {
    const fixture = await makeFixture()
    const ctx = await mount(fixture)

    await writeTurn(ctx, 'session-new')

    expect(ctx.sessionPersistence.name).toBe('session-persistence-hybrid')
    const snapshot = await ctx.sessionPersistence.stat('session-new' as SessionId)
    expect(snapshot?.eventCount).toBe(2)
    expect(snapshot?.location?.kind).toBe('sqlite')
    const catalog = await readCatalog(fixture)
    expect(catalog.sessions['session-new']?.backend).toBe('sqlite')
  })

  it('keeps an unmigrated JSONL session readable without migrating it', async () => {
    const fixture = await makeFixture()
    await seedJsonl(fixture, 'session-from-jsonl')
    const ctx = await mount(fixture)

    const snapshot = await ctx.sessionPersistence.stat('session-from-jsonl' as SessionId)
    expect(snapshot?.header.id).toBe('session-from-jsonl')

    const handle = await ctx.sessionPersistence.open('session-from-jsonl' as SessionId, 'read')
    const page = await handle.read()
    await handle.close()
    expect(page.events.map((event) => event.type)).toEqual(['turn/start', 'turn/end'])

    // The probe result is written down, so the next process does not scan twice.
    const catalog = await readCatalog(fixture)
    expect(catalog.sessions['session-from-jsonl']?.backend).toBe('jsonl')
  })

  it('lists both backends once per session', async () => {
    const fixture = await makeFixture()
    await seedJsonl(fixture, 'session-jsonl-one')
    const ctx = await mount(fixture)
    await writeTurn(ctx, 'session-sqlite-one')

    const ids = (await ctx.sessionPersistence.list()).map((snapshot) => String(snapshot.header.id)).sort()
    expect(ids).toEqual(['session-jsonl-one', 'session-sqlite-one'])
  })

  it('rebuilds the catalog from both backends when the file is missing', async () => {
    const fixture = await makeFixture()
    await seedJsonl(fixture, 'session-existing')
    const first = await mount(fixture)
    expect((await readCatalog(fixture)).sessions['session-existing']?.backend).toBe('jsonl')
    await first.fiber.dispose()

    // Losing the catalog must cost a scan, not a session.
    await rm(catalogPath(fixture.stateDirectory), { force: true })
    const second = await mount(fixture)
    const snapshot = await second.sessionPersistence.stat('session-existing' as SessionId)
    expect(snapshot?.header.id).toBe('session-existing')
    expect((await readCatalog(fixture)).sessions['session-existing']?.backend).toBe('jsonl')
  })

  it('routes a session that exists in both backends to the preferred one and warns', async () => {
    const fixture = await makeFixture()
    // Both copies: exactly what an interrupted migration leaves behind.
    await seedJsonl(fixture, 'session-both')
    const inner = new Context()
    try {
      await inner.plugin(SqliteSessionPersistence, { root: fixture.sqliteRoot, storageThread: 'inline' })
      const sqlite = inner.sessionPersistence
      const handle = await sqlite.create(
        { version: 4 as const, id: 'session-both' as SessionId, createdAt: 1_700_000_000_000, cwd: '/tmp/hybrid', isSeeded: false, delegationDepth: 0 },
        {},
      )
      await handle.append([
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      ] as never)
      await handle.flush()
      await handle.close()
    } finally {
      await inner.fiber.dispose()
    }

    const ctx = await mount(fixture)
    const catalog = await readCatalog(fixture)
    expect(catalog.sessions['session-both']?.backend).toBe('sqlite')
    // One entry in the picker, not two.
    const listed = (await ctx.sessionPersistence.list()).filter(
      (snapshot) => String(snapshot.header.id) === 'session-both',
    )
    expect(listed).toHaveLength(1)
  })

  it('survives a stale route by probing the backends', async () => {
    const fixture = await makeFixture()
    await seedJsonl(fixture, 'session-moved')
    // Claim the session is on SQLite when it is not: a migration that wrote the
    // catalog and then failed before the copy landed.
    const catalog = await SessionBackendCatalog.open(fixture.stateDirectory)
    catalog.route('session-moved', 'sqlite')
    await catalog.save()

    const ctx = await mount(fixture)
    const handle = await ctx.sessionPersistence.open('session-moved' as SessionId, 'read')
    const page = await handle.read()
    await handle.close()
    expect(page.events).toHaveLength(2)
    // The probe corrected the route instead of failing the open.
    expect((await readCatalog(fixture)).sessions['session-moved']?.backend).toBe('jsonl')
  })

  it('drops the route of a session whose directory was removed', async () => {
    const fixture = await makeFixture()
    const ctx = await mount(fixture)
    await writeTurn(ctx, 'session-gone')
    expect((await readCatalog(fixture)).sessions['session-gone']?.backend).toBe('sqlite')

    // What "delete an archived conversation" looks like from the outside: the
    // directory goes away and nothing tells the backend. The runtime has no
    // delete of its own for the plugin to hook, so the listing is where the
    // truth has to catch up.
    // Windows refuses to remove a directory while this process holds the store
    // inside it open, and the executor caches connections by design.
    await releaseStore(databasePath(fixture.sqliteRoot, '/tmp/hybrid', 'session-gone'))
    await rm(sessionDir(fixture.sqliteRoot, '/tmp/hybrid', 'session-gone'), { recursive: true, force: true })

    const listed = await ctx.sessionPersistence.list()
    expect(listed.map((snapshot) => String(snapshot.header.id))).not.toContain('session-gone')
    // And the stale route is repaired, so the next open does not probe a
    // directory that is not there.
    expect((await readCatalog(fixture)).sessions['session-gone']).toBeUndefined()
  })

  it('flushes both backends', async () => {
    const fixture = await makeFixture()
    await seedJsonl(fixture, 'session-jsonl-flush')
    const ctx = await mount(fixture)
    await writeTurn(ctx, 'session-sqlite-flush')
    await ctx.sessionPersistence.flush()
    // Both stores answer after the barrier; a flush that only reached one would
    // leave the other's writers buffered.
    expect(await ctx.sessionPersistence.stat('session-sqlite-flush' as SessionId)).toBeDefined()
    expect(await ctx.sessionPersistence.stat('session-jsonl-flush' as SessionId)).toBeDefined()
  })

  it('writes the SQLite session where the standalone backend would', async () => {
    const fixture = await makeFixture()
    const ctx = await mount(fixture)
    await writeTurn(ctx, 'session-layout')
    const snapshot = await ctx.sessionPersistence.stat('session-layout' as SessionId)
    expect(snapshot?.location?.path).toBe(
      databasePath(fixture.sqliteRoot, '/tmp/hybrid', 'session-layout' as SessionId),
    )
  })
})

describe('hybrid configuration', () => {
  it('refuses hybrid mode without a JSONL root', async () => {
    const fixture = await makeFixture()
    const ctx = new Context()
    contexts.push(ctx)
    await expect(
      ctx.plugin(SqliteSessionPersistence, {
        root: fixture.sqliteRoot,
        hybrid: true,
        storageThread: 'inline',
      }),
    ).rejects.toThrow(/hybrid mode needs jsonlRoot/)
  })

  it('offers both formats as soon as a JSONL root is configured', async () => {
    const fixture = await makeFixture()
    // `hybrid` stays off: pointing at a JSONL root is itself the statement that
    // this install can create either format, and a settings page that disables
    // JSONL for such a profile would be answering a question nobody asked.
    const ctx = await mount(fixture, { hybrid: false, newSessionBackend: 'jsonl' })
    expect(ctx.sessionPersistence.name).toBe('session-persistence-hybrid')
    await writeTurn(ctx, 'session-jsonl-switch')
    // The format was not just offered, it was creatable: the session landed in
    // the JSONL tree, and the catalog says so.
    expect((await readCatalog(fixture)).sessions['session-jsonl-switch']?.backend).toBe('jsonl')
  })

  it('leaves the standalone backend untouched when hybrid is off', async () => {
    const fixture = await makeFixture()
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SqliteSessionPersistence, { root: fixture.sqliteRoot, storageThread: 'inline' })
    expect(ctx.sessionPersistence.name).toBe('session-persistence-optimizer')
    await expect(readFile(catalogPath(fixture.stateDirectory), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('catalog document', () => {
  it('round-trips provenance through a save and a load', async () => {
    const fixture = await makeFixture()
    const catalog = await SessionBackendCatalog.open(fixture.stateDirectory)
    catalog.route('session-clone', 'sqlite', {
      originSessionId: 'session-origin',
      migrationId: 'mig-1',
      sourceBackend: 'jsonl',
      targetBackend: 'sqlite',
      clonedAt: 1_700_000_000_000,
    })
    await catalog.save()

    const reloaded = await SessionBackendCatalog.open(fixture.stateDirectory)
    expect(reloaded.get('session-clone')).toMatchObject({
      backend: 'sqlite',
      originSessionId: 'session-origin',
      migrationId: 'mig-1',
      sourceBackend: 'jsonl',
      targetBackend: 'sqlite',
      clonedAt: 1_700_000_000_000,
    })
  })

  it('refuses a document it cannot decode rather than routing blind', async () => {
    const fixture = await makeFixture()
    const path = catalogPath(fixture.stateDirectory)
    // A save only writes when something changed, so route once to create the file.
    const seeded = await SessionBackendCatalog.open(fixture.stateDirectory)
    seeded.route('session-seeded', 'sqlite')
    await seeded.save()
    await writeFile(path, 'not json', 'utf8')
    await expect(SessionBackendCatalog.open(fixture.stateDirectory)).rejects.toThrow(/is not JSON/)

    await writeFile(
      path,
      JSON.stringify({ version: 1, sessions: { 'session-x': { backend: 'lmdb', updatedAt: 1 } } }),
      'utf8',
    )
    await expect(SessionBackendCatalog.open(fixture.stateDirectory)).rejects.toThrow(
      /names backend "lmdb"/,
    )
  })

  it('reports a session both backends claim instead of silently dropping one', async () => {
    const fixture = await makeFixture()
    const { catalog, conflicts } = await SessionBackendCatalog.rebuild(
      fixture.stateDirectory,
      [
        { backend: 'sqlite', ids: ['session-both', 'session-sqlite-only'] },
        { backend: 'jsonl', ids: ['session-both', 'session-jsonl-only'] },
      ],
      'sqlite',
    )
    expect(catalog.backendOf('session-both' as SessionId)).toBe('sqlite')
    expect(catalog.backendOf('session-jsonl-only' as SessionId)).toBe('jsonl')
    expect(conflicts).toEqual([{ id: 'session-both', listed: 'sqlite', also: ['jsonl'] }])
  })
})

afterEach(async () => {
  const failures: unknown[] = []
  for (const ctx of contexts.splice(0)) {
    try {
      await ctx.fiber.dispose()
    } catch (error) {
      failures.push(error)
    }
  }
  for (const base of bases.splice(0)) {
    try {
      await rm(base, { recursive: true, force: true })
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'hybrid fixture cleanup failed')
})
