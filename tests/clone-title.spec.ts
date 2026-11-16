import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionBackendCatalog } from '../src/catalog.ts'
import { runMigration, startMigration, sourceSessions, type MigrationBackend } from '../src/migrate.ts'
import { mountJsonl, findJsonlArtifact, readJsonlSession, readSqliteSessionById, writeSqliteSession, type JsonlMount, type LogCopy } from '../src/transfer.ts'
import { databasePath } from '../src/format.ts'
import { textOf } from '../client/i18n.ts'

const fixtures: Array<{ base: string; jsonl: JsonlMount }> = []
async function setup(sourceKind: 'jsonl' | 'sqlite', events: readonly SessionEvent[]) {
  const base = await mkdtemp(join(tmpdir(), 'dso-copy-title-'))
  const jsonlRoot = join(base, 'jsonl'), sqliteRoot = join(base, 'sqlite')
  const jsonl = await mountJsonl(jsonlRoot, 'jsonl')
  fixtures.push({ base, jsonl })
  const id = 'session-original' as SessionId
  const header = { version: 4, id, createdAt: 1700000000000, cwd: join(base, 'project'), isSeeded: false, delegationDepth: 0 } as SessionHeader
  const copy: LogCopy = { header, events, inheritedEventCount: 0 }
  const jsonlBackend: MigrationBackend = { id: 'jsonl', root: jsonlRoot, persistence: jsonl.persistence }
  const sqliteBackend: MigrationBackend = { id: 'sqlite', root: sqliteRoot, persistence: undefined as never }
  const source = sourceKind === 'jsonl' ? jsonlBackend : sqliteBackend
  const target = sourceKind === 'jsonl' ? sqliteBackend : jsonlBackend
  if (sourceKind === 'sqlite') await writeSqliteSession(databasePath(sqliteRoot, header.cwd, id), copy)
  else {
    const handle = await jsonl.persistence.create(header)
    try { if (events.length) await handle.append([...events]); await handle.flush() } finally { await handle.close() }
  }
  const catalog = await SessionBackendCatalog.open(join(base, 'state'))
  return { source, target, catalog, id }
}
async function read(backend: MigrationBackend, id: string) {
  return backend.id === 'jsonl' ? await readJsonlSession(backend.root, id)
    : await readSqliteSessionById(backend.root, id, { force: false, verify: false, digest: false, readOnlySources: true })
}
function history(): SessionEvent[] {
  return [
    { type: 'session/title', seq: 0, time: 1700000000000, data: { title: '旧名称', messageSeqs: [], source: { kind: 'user' } } },
    { type: 'turn/start', seq: 1, time: 1700000000001, data: { turn: 1 } },
    { type: 'turn/end', seq: 2, time: 1700000000002, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'session/title', seq: 3, time: 1700000000003, data: { title: '最新项目🙂', messageSeqs: [], source: { kind: 'user' } } },
  ] as unknown as SessionEvent[]
}
afterEach(async () => { for (const { base, jsonl } of fixtures.splice(0).reverse()) { await jsonl.dispose(); await rm(base, { recursive: true, force: true }) } })

describe('conversion copy names', () => {
  it.each(['jsonl', 'sqlite'] as const)('%s creates a new named conversation while preserving every source event', async kind => {
    const { source, target, catalog, id } = await setup(kind, history())
    const before = await read(source, id)
    const report = await runMigration(catalog, source, target, { mode: 'clone', verify: true, session: id, newSessionId: 'session-copy' })
    expect(report.status, JSON.stringify(report)).toBe('completed')
    expect(report.items[0]).toMatchObject({ status: 'migrated', title: '副本-最新项目🙂', expected: 5, transferred: 5 })
    const cloned = await read(target, 'session-copy')
    expect(cloned?.header.id).toBe('session-copy')
    expect(cloned?.events.slice(0, -1)).toEqual(before?.events)
    expect(cloned?.events.at(-1)).toMatchObject({ type: 'session/title', seq: 4, data: { title: '副本-最新项目🙂' } })
    expect(await read(source, id)).toEqual(before)
    expect((await sourceSessions(target)).find(row => row.id === 'session-copy')?.title).toBe('副本-最新项目🙂')
    expect(catalog.get('session-copy')?.originSessionId).toBe(id)
  })
  it.each(['jsonl', 'sqlite'] as const)('%s assigns an untitled empty copy a valid title at sequence zero', async kind => {
    const { source, target, catalog, id } = await setup(kind, [])
    const report = await runMigration(catalog, source, target, { mode: 'clone', verify: true, session: id, newSessionId: 'session-empty-copy' })
    expect(report.status, JSON.stringify(report)).toBe('completed')
    const cloned = await read(target, 'session-empty-copy')
    expect(cloned?.events).toHaveLength(1)
    expect(cloned?.events[0]).toMatchObject({ type: 'session/title', seq: 0, data: { title: '副本-未命名' } })
    expect((await read(source, id))?.events).toEqual([])
  })
  it.each(['jsonl', 'sqlite'] as const)('overwrite from %s preserves the existing title and event count', async kind => {
    const { source, target, catalog, id } = await setup(kind, history())
    const before = await read(source, id)
    const report = await runMigration(catalog, source, target, { mode: 'overwrite', verify: true, session: id })
    expect(report.status, JSON.stringify(report)).toBe('completed')
    expect(report.items[0]).toMatchObject({ targetSession: id, expected: 4, transferred: 4 })
    expect((await read(target, id))?.events).toEqual(before?.events)
    expect((await sourceSessions(target)).find(row => row.id === id)?.title).toBe('最新项目🙂')
  })
  it('copies the current copy title without changing either earlier conversation', async () => {
    const { source, target, catalog, id } = await setup('jsonl', history())
    expect((await runMigration(catalog, source, target, { mode: 'clone', verify: true, session: id, newSessionId: 'session-first-copy' })).status).toBe('completed')
    const first = await read(target, 'session-first-copy')
    const report = await runMigration(catalog, target, source, { mode: 'clone', verify: true, session: 'session-first-copy', newSessionId: 'session-second-copy' })
    expect(report.status, JSON.stringify(report)).toBe('completed')
    const second = await read(source, 'session-second-copy')
    expect(second?.events.slice(0, -1)).toEqual(first?.events)
    expect(second?.events.at(-1)).toMatchObject({ type: 'session/title', seq: 5, data: { title: '副本-副本-最新项目🙂' } })
    expect(await read(target, 'session-first-copy')).toEqual(first)
    expect((await read(source, id))?.events).toEqual(history())
  })
  it.each(['jsonl', 'sqlite'] as const)('%s clone reopens through the official released-format decoder', async kind => {
    const { source, target, catalog, id } = await setup(kind, history())
    const report = await runMigration(catalog, source, target, { mode: 'clone', verify: true, session: id, newSessionId: 'session-official-copy' })
    expect(report.status, JSON.stringify(report)).toBe('completed')
    const cloned = await read(target, 'session-official-copy')
    expect(cloned).toBeDefined()
    const oracleRoot = join(source.root, '..', 'official-replay')
    const oracle = await mountJsonl(oracleRoot, 'jsonl')
    fixtures.push({ base: oracleRoot, jsonl: oracle })
    const writer = await oracle.persistence.create(cloned!.header)
    try { await writer.append([...cloned!.events]); await writer.flush() } finally { await writer.close() }
    const reader = await oracle.persistence.open(cloned!.header.id, 'read')
    try { expect((await reader.read(0)).events).toEqual(cloned!.events) } finally { await reader.close() }
  })
  it.each(['jsonl', 'sqlite'] as const)('%s registers a clone only after the new route and log are readable', async kind => {
    const { source, target, catalog, id } = await setup(kind, history())
    const registered: string[] = []
    const report = await runMigration(catalog, source, target, { mode: 'clone', verify: true, session: id, newSessionId: 'session-grouped-copy' }, undefined, async (original, copy) => {
      expect(original).toBe(id)
      expect(catalog.get(copy)?.backend).toBe(target.id)
      expect((await read(target, copy))?.header.id).toBe(copy)
      registered.push(copy)
    })
    expect(report.items[0]?.status).toBe('migrated')
    expect(registered).toEqual(['session-grouped-copy'])
  })
  it('reports a failed account write as a warning on the already created copy', async () => {
    const { source, target, catalog, id } = await setup('jsonl', history())
    const report = await runMigration(catalog, source, target, { mode: 'clone', verify: true, session: id, newSessionId: 'session-warning-copy' }, undefined, async () => { throw Error('workspace disk full') })
    expect(report.items[0]).toMatchObject({ status: 'migrated', targetSession: 'session-warning-copy' })
    expect(report.items[0]?.error).toContain('workspace disk full')
    expect(catalog.get('session-warning-copy')?.backend).toBe('sqlite')
    expect((await read(target, 'session-warning-copy'))?.events).toHaveLength(5)
    expect((await read(source, id))?.events).toEqual(history())
  })
  it('does not register an overwrite as a new conversation', async () => {
    const { source, target, catalog, id } = await setup('jsonl', history())
    let invoked = false
    const report = await runMigration(catalog, source, target, { mode: 'overwrite', verify: true, session: id }, undefined, async () => { invoked = true })
    expect(report.status).toBe('completed')
    expect(invoked).toBe(false)
  })
  it.each(['jsonl', 'sqlite'] as const)('%s background jobs attach copies only for both mounted ends', async kind => {
    const { source, target, catalog, id } = await setup(kind, history())
    const attachClone = vi.fn(async () => {})
    const host = { catalog, jsonl: kind === 'jsonl' ? source : target, sqlite: kind === 'sqlite' ? source : target, attachClone }
    const direction = kind === 'jsonl' ? 'jsonl_to_sqlite' : 'sqlite_to_jsonl'
    const job = startMigration(host, direction, { mode: 'clone', verify: true, session: id, newSessionId: 'session-mounted-copy' })
    await vi.waitFor(() => expect(job.status).not.toBe('running'), { timeout: 10000 })
    expect(job.status, JSON.stringify(job)).toBe('completed')
    expect(attachClone).toHaveBeenCalledExactlyOnceWith(id, 'session-mounted-copy')
    for (const external of ['source', 'target'] as const) {
      attachClone.mockClear()
      // The job operates on the same real fixture; the host mounts a different
      // root on the chosen side, as with an external library picker selection.
      const mounted = { ...host, [external === 'source' ? source.id : target.id]: { ...(external === 'source' ? source : target), root: join(source.root, '..', `external-${external}`) } }
      const foreign = startMigration(mounted, direction, { mode: 'clone', verify: true, session: id, newSessionId: `session-external-${external}` }, { source, target })
      await vi.waitFor(() => expect(foreign.status).not.toBe('running'), { timeout: 10000 })
      expect(foreign.status, JSON.stringify(foreign)).toBe('completed')
      expect(attachClone).not.toHaveBeenCalled()
    }
  })
  it('does not impose a mounted JSONL encoding on a physically different external target', async () => {
    const { source, target, catalog, id } = await setup('sqlite', history())
    const host = { catalog, sqlite: source, jsonl: { ...target, root: join(source.root, '..', 'other-mounted-jsonl'), compression: 'zstd' as const } }
    const job = startMigration(host, 'sqlite_to_jsonl', { mode: 'clone', verify: true, session: id, newSessionId: 'session-external-encoding' }, { source, target })
    await vi.waitFor(() => expect(job.status).not.toBe('running'), { timeout: 10000 })
    expect(job.status, JSON.stringify(job)).toBe('completed')
    expect((await findJsonlArtifact(target.root, 'session-external-encoding'))?.path.endsWith('.jsonl')).toBe(true)
    expect((await read(target, 'session-external-encoding'))?.header.id).toBe('session-external-encoding')
  })
  it('uses the exact requested Chinese action labels', () => {
    const text = textOf('zh')
    expect(text.transfer.modeOverwrite).toBe('转换后覆盖原对话')
    expect(text.transfer.modeClone).toBe('转换后创建新对话')
  })
})
