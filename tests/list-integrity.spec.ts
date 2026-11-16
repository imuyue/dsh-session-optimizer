import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { SessionBackendCatalog } from '../src/catalog.ts'
import { HybridSessionPersistence } from '../src/router.ts'

const dirs: string[] = []
const contexts: Context[] = []
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-list-integrity-'))
  dirs.push(dir)
  const ctx = new Context(); contexts.push(ctx)
  const catalog = await SessionBackendCatalog.open(dir)
  return { dir, ctx, catalog }
}
function snapshot(id: string, backend: string): SessionPersistenceSnapshot {
  return { header: { version: 4, id: id as SessionId, createdAt: 1, isSeeded: false }, revision: backend as never, location: { kind: backend, path: backend } }
}
function backend(entries: Map<string, SessionPersistenceSnapshot>, list?: () => Promise<SessionPersistenceSnapshot[]>) {
  return { list: list ?? (async () => [...entries.values()]), stat: async (id: string) => entries.get(id), flush: async () => {} } as unknown as SessionPersistence
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
describe('hybrid list integrity', () => {
  for (const staleBackend of ['sqlite', 'jsonl'] as const) it(`returns a session on the first list when its ${staleBackend} route is stale`, async () => {
    const { ctx, catalog } = await fixture()
    const actual = staleBackend === 'sqlite' ? 'jsonl' : 'sqlite'
    catalog.route('history', staleBackend); await catalog.save()
    const row = snapshot('history', actual)
    const router = new HybridSessionPersistence(ctx, catalog, [
      { id: 'sqlite', label: 'SQLite', persistence: backend(new Map(actual === 'sqlite' ? [['history', row]] : [])) },
      { id: 'jsonl', label: 'JSONL', persistence: backend(new Map(actual === 'jsonl' ? [['history', row]] : [])) },
    ])
    expect((await router.list()).map(x => x.header.id)).toEqual(['history'])
    expect(catalog.backendOf('history')).toBe(actual)
    expect((await router.list()).map(x => x.header.id)).toEqual(['history'])
  })
  it('retains a route created while an older list is in flight', async () => {
    const { ctx, catalog } = await fixture()
    const rows = new Map<string, SessionPersistenceSnapshot>()
    const started = deferred(), finish = deferred()
    const router = new HybridSessionPersistence(ctx, catalog, [
      { id: 'sqlite', label: 'SQLite', persistence: backend(rows, async () => { const old = [...rows.values()]; started.resolve(); await finish.promise; return old }) },
      { id: 'jsonl', label: 'JSONL', persistence: backend(new Map()) },
    ])
    const listing = router.list(); await started.promise
    rows.set('new', snapshot('new', 'sqlite')); catalog.route('new', 'sqlite'); await catalog.save()
    finish.resolve(); await listing
    expect(catalog.backendOf('new')).toBe('sqlite')
  })
  it('retains an existing route if a session appears after the backend enumeration', async () => {
    const { ctx, catalog } = await fixture()
    catalog.route('restored', 'sqlite'); await catalog.save()
    const rows = new Map<string, SessionPersistenceSnapshot>()
    const router = new HybridSessionPersistence(ctx, catalog, [
      { id: 'sqlite', label: 'SQLite', persistence: backend(rows, async () => { rows.set('restored', snapshot('restored', 'sqlite')); return [] }) },
      { id: 'jsonl', label: 'JSONL', persistence: backend(new Map()) },
    ])
    expect((await router.list()).map(x => x.header.id)).toContain('restored')
    expect(catalog.backendOf('restored')).toBe('sqlite')
  })
  it('honors a valid nonpreferred route for duplicates and removes only confirmed missing entries', async () => {
    const { ctx, catalog } = await fixture()
    catalog.route('both', 'jsonl'); catalog.route('gone', 'sqlite'); await catalog.save()
    const router = new HybridSessionPersistence(ctx, catalog, [
      { id: 'sqlite', label: 'SQLite', persistence: backend(new Map([['both', snapshot('both', 'sqlite')]])) },
      { id: 'jsonl', label: 'JSONL', persistence: backend(new Map([['both', snapshot('both', 'jsonl')]])) },
    ])
    const listed = await router.list()
    expect(listed).toHaveLength(1); expect(listed[0]?.location?.kind).toBe('jsonl')
    expect(catalog.backendOf('gone')).toBeUndefined()
  })
  it('does not alter routes when the second backend rejects a listing', async () => {
    const { ctx, catalog } = await fixture()
    catalog.route('kept', 'sqlite'); await catalog.save()
    const router = new HybridSessionPersistence(ctx, catalog, [
      { id: 'sqlite', label: 'SQLite', persistence: backend(new Map()) },
      { id: 'jsonl', label: 'JSONL', persistence: backend(new Map(), async () => { throw new Error('list-failed') }) },
    ])
    await expect(router.list()).rejects.toThrow('list-failed')
    expect(catalog.backendOf('kept')).toBe('sqlite')
  })
  it('leaves all routes unchanged if absence confirmation fails', async () => {
    const { ctx, catalog } = await fixture()
    catalog.route('gone', 'sqlite'); catalog.route('uncertain', 'jsonl'); await catalog.save()
    const jsonl = backend(new Map())
    jsonl.stat = async (id) => { if (id === 'uncertain') throw new Error('stat-failed'); return undefined }
    const router = new HybridSessionPersistence(ctx, catalog, [
      { id: 'sqlite', label: 'SQLite', persistence: backend(new Map()) },
      { id: 'jsonl', label: 'JSONL', persistence: jsonl },
    ])
    await expect(router.list()).rejects.toThrow('stat-failed')
    expect(catalog.backendOf('gone')).toBe('sqlite'); expect(catalog.backendOf('uncertain')).toBe('jsonl')
  })
  it('does not replace a newer migration route with a stale listed copy', async () => {
    const { ctx, catalog } = await fixture()
    catalog.route('moved', 'sqlite'); await catalog.save()
    const router = new HybridSessionPersistence(ctx, catalog, [
      { id: 'sqlite', label: 'SQLite', persistence: backend(new Map([['moved', snapshot('moved', 'sqlite')]])) },
      { id: 'jsonl', label: 'JSONL', persistence: backend(new Map(), async () => { catalog.route('moved', 'jsonl', { migrationId: 'new-migration' }); return [] }) },
    ])
    await router.list()
    expect(catalog.get('moved')).toMatchObject({ backend: 'jsonl', migrationId: 'new-migration' })
  })
  it('does not reconcile routes after cancellation', async () => {
    const { ctx, catalog } = await fixture()
    catalog.route('history', 'sqlite'); await catalog.save()
    const controller = new AbortController()
    const router = new HybridSessionPersistence(ctx, catalog, [
      { id: 'sqlite', label: 'SQLite', persistence: backend(new Map()) },
      { id: 'jsonl', label: 'JSONL', persistence: backend(new Map([['history', snapshot('history', 'jsonl')]]), async () => { controller.abort(new Error('cancel-list')); return [snapshot('history', 'jsonl')] }) },
    ])
    await expect(router.list({ signal: controller.signal })).rejects.toThrow('cancel-list')
    expect(catalog.backendOf('history')).toBe('sqlite')
  })
})
describe('catalog asynchronous persistence', () => {
  it('does not lose a mutation made while save is awaiting filesystem I/O', async () => {
    const { dir, catalog } = await fixture()
    catalog.route('first', 'sqlite')
    const firstSave = catalog.save()
    catalog.route('second', 'jsonl')
    await firstSave
    await catalog.save()
    const loaded = await SessionBackendCatalog.open(dir)
    expect(loaded.backendOf('first')).toBe('sqlite')
    expect(loaded.backendOf('second')).toBe('jsonl')
  })
  it('coalesces concurrent saves without publishing an older snapshot last', async () => {
    const { dir, catalog } = await fixture()
    const saves: Promise<void>[] = []
    for (let i = 0; i < 80; i++) {
      catalog.route(`session-${i}`, i % 2 === 0 ? 'sqlite' : 'jsonl')
      saves.push(catalog.save())
      if (i % 7 === 0) await Promise.resolve()
    }
    await Promise.all(saves)
    const loaded = await SessionBackendCatalog.open(dir)
    expect(loaded.list()).toEqual(catalog.list())
    expect(loaded.size).toBe(80)
  })
  it('retains dirty changes after a failed save so an explicit retry persists them', async () => {
    const { dir } = await fixture()
    const blocked = join(dir, 'blocked')
    const catalog = await SessionBackendCatalog.open(blocked)
    await writeFile(blocked, 'not-a-directory')
    catalog.route('first', 'sqlite')
    await expect(catalog.save()).rejects.toThrow()
    catalog.route('second', 'jsonl')
    await rm(blocked)
    await catalog.save()
    expect((await SessionBackendCatalog.open(blocked)).list()).toEqual(catalog.list())
  })
  it('drains replacement and deletion performed during a pending save', async () => {
    const { dir, catalog } = await fixture()
    catalog.route('old', 'sqlite')
    const saving = catalog.save()
    catalog.replaceAll([['replacement', { backend: 'jsonl', updatedAt: 123 }]])
    catalog.route('removed', 'sqlite'); catalog.forget('removed')
    await saving
    expect((await SessionBackendCatalog.open(dir)).list()).toEqual(catalog.list())
    expect(catalog.list().map(([id]) => id)).toEqual(['replacement'])
  })
})
