import { beforeAll, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import * as Sqlite from '../src/index.ts'
import { HybridSessionPersistence } from '../src/router.ts'
import { SessionBackendCatalog } from '../src/catalog.ts'
import * as CurrentMigration from '../src/migrate.ts'
import { mountJsonl } from '../src/transfer.ts'
const officialRoot = process.env.DSH_TEST_OFFICIAL_ROOT
let historyModule: any, catalogDefinition: any, identityDefinition: any, migration: typeof CurrentMigration
beforeAll(async () => {
  migration = process.env.DSH_GRAPH_BASELINE === '1' ? await import(pathToFileURL(join(process.cwd(), 'distribution/windows-0126/lib/migrate.js')).href) : CurrentMigration
  if (!officialRoot) return
  const load = (file: string) => import(pathToFileURL(join(officialRoot, 'node_modules/@deepseek-ai', file)).href)
  ;[historyModule, { subagentCatalogProjectionDefinition: catalogDefinition }, { subagentIdentityProjectionDefinition: identityDefinition }] = await Promise.all([
    load('dsh-api-session-controller/lib/types/history/controller.js'), load('dsh-subagent/lib/types/catalog.js'), load('dsh-subagent/lib/types/projection.js'),
  ])
})
const test = it.skipIf(!officialRoot)
function fold(definition: any, header: SessionHeader, inherited: number, events: readonly SessionEvent[]) {
  let state = definition.init(header, inherited)
  for (const event of events) state = definition.apply(state, event)
  return definition.wire.view(state)
}
for (const kind of ['jsonl', 'sqlite'] as const) for (const mixed of [false, true]) for (const mode of ['clone', 'overwrite'] as const) test(`${kind} ${mode}${mixed ? ' mixed-backend' : ''}: actual history events authorize every nested child after selecting only the main conversation`, async () => {
  const base = await mkdtemp(join(tmpdir(), 'dso-owned-tree-')), cwd = join(base, 'project'), sqliteRoot = join(base, 'sqlite'), jsonlRoot = join(base, 'jsonl')
  await mkdir(cwd)
  const sqliteCtx = new Context(), rootCtx = new Context(), jsonl = await mountJsonl(jsonlRoot, 'jsonl')
  try {
    await sqliteCtx.plugin(Sqlite, { root: sqliteRoot, stateDirectory: join(base, 'sqlite-state'), storageThread: 'inline', warmupSessions: 0 })
    const sqlite = sqliteCtx.get('sessionPersistence')!
    const catalog = await SessionBackendCatalog.open(join(base, 'catalog'))
    const router = new HybridSessionPersistence(rootCtx, catalog, [{ id: 'sqlite', persistence: sqlite, label: 'SQLite' }, { id: 'jsonl', persistence: jsonl.persistence, label: 'JSONL' }], { newSessionBackend: kind, preference: ['sqlite', 'jsonl'] })
    const backend = { sqlite: { id: 'sqlite' as const, root: sqliteRoot, persistence: sqlite }, jsonl: { id: 'jsonl' as const, root: jsonlRoot, persistence: jsonl.persistence } }
    const relations = [{ id: 'main', children: ['child'] }, { id: 'child', parent: 'main', children: ['nested'] }, { id: 'nested', parent: 'child', children: [] }]
    const read = async (id: string) => { const handle = await router.open(id as SessionId, 'read', { allowMigration: false }); try { const result = await handle.read(); return { header: handle.header, inheritedEventCount: handle.inheritedEventCount, events: result.events } } finally { await handle.close() } }
    const before = new Map<string, unknown>()
    for (const entry of relations) {
      const header = { version: 4, id: entry.id as SessionId, cwd, createdAt: 1700000000000, isSeeded: false, delegationDepth: entry.id === 'main' ? 0 : entry.id === 'child' ? 1 : 2, ...(entry.parent ? { origin: 'subagent', parentSession: entry.parent as SessionId } : {}) } as SessionHeader
      const values: Array<{ type: string; data: unknown }> = [{ type: 'turn/start', data: { turn: 1 } }]
      if (entry.parent) values.push({ type: 'subagent/descriptor', data: { version: 3, mode: entry.id === 'nested' ? 'one-shot' : 'continuable', provider: 'local', label: entry.id } })
      if (entry.id !== 'nested') values.push({ type: 'session/title', data: { title: entry.id, messageSeqs: [], source: { kind: 'user' } } })
      for (const childId of entry.children) values.push({ type: 'subagent/catalog', data: { version: 0, childId, childCreatedAt: 1700000000000, mode: childId === 'nested' ? 'one-shot' : 'continuable', label: childId } })
      if (entry.id === 'main') values.push({ type: 'subagent/catalog', data: { version: 2, childId: 'external-execution', childCreatedAt: 1700000000000, mode: 'external', label: 'External' } })
      values.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      const events = values.map((event, seq) => ({ ...event, seq, time: 1700000000000 + seq })) as unknown as SessionEvent[]
      if (mixed && entry.parent) catalog.route(header.id, kind === 'jsonl' ? 'sqlite' : 'jsonl')
      const writer = await router.create(header); await writer.append(events); await writer.flush(); await writer.close()
      before.set(entry.id, await read(entry.id))
    }
    const source = backend[kind], target = backend[kind === 'jsonl' ? 'sqlite' : 'jsonl']
    const report = await migration.runMigration(catalog, source, target, { mode, verify: true, sessions: ['main'], ...(mode === 'clone' ? { newSessionId: 'main-copy' } : {}) })
    expect(report.status, JSON.stringify(report)).toBe('completed')
    const parentId = mode === 'clone' ? 'main-copy' : 'main'
    const controller = new historyModule.HistoryController({ on: rootCtx.on.bind(rootCtx), effect: rootCtx.effect.bind(rootCtx), sessionQuery: { observeSession: async (id: string) => {
      const snapshot = await read(id)
      return { ...snapshot, cursor: snapshot.events.at(-1)?.seq ?? -1, projections: { asOfSeq: snapshot.events.at(-1)?.seq ?? -1, values: { subagent: fold(identityDefinition, snapshot.header, snapshot.inheritedEventCount, snapshot.events) } }, [Symbol.dispose]() {} }
    } } })
    const visited = new Set<string>()
    async function inspect(parent: string, expectedBackend = target.id): Promise<void> {
      const snapshot = await read(parent), children = fold(catalogDefinition, snapshot.header, snapshot.inheritedEventCount, snapshot.events)
      for (const child of children) {
        if (child.mode === 'external') { expect(child.id).toBe('external-execution'); continue }
        const page = await controller.events({ address: { kind: 'subagent', parentSessionId: parent, childSessionId: child.id, mode: child.mode }, maxMessages: 50 }, new AbortController().signal)
        expect(page.records.length).toBeGreaterThan(0)
        const stored = await read(child.id)
        expect(stored.header.parentSession).toBe(parent)
        if (mode === 'clone' && child.mode === 'one-shot') expect(stored.events.at(-1)).toMatchObject({ type: 'session/title', data: { title: '副本-nested' } })
        expect(catalog.get(child.id)?.backend).toBe(expectedBackend)
        if (mode === 'clone') expect(['main', 'child', 'nested']).not.toContain(child.id)
        visited.add(child.id); await inspect(child.id, expectedBackend)
      }
    }
    await inspect(parentId)
    expect(visited.size).toBe(2)
    expect(report.items).toHaveLength(3)
    if (mode === 'clone') {
      const legacy = await import(pathToFileURL(join(process.cwd(), 'distribution/windows-0126/lib/migrate.js')).href)
      const bad = await legacy.runMigration(catalog, source, target, { mode: 'clone', verify: true, session: 'main', newSessionId: 'legacy-copy' })
      expect(bad.status).toBe('completed')
      const initial = await read('legacy-copy')
      const writer = await target.persistence.open('legacy-copy' as SessionId, 'write')
      try { await writer.append([{ type: 'session/title', seq: Number(initial.events.at(-1)!.seq) + 1, time: 1700000000100, data: { title: 'Added after the old copy', messageSeqs: [], source: { kind: 'user' } } }] as never); await writer.flush() } finally { await writer.close() }
      const preserved = await read('legacy-copy')
      const oldCatalog = fold(catalogDefinition, preserved.header, preserved.inheritedEventCount, preserved.events)
      const oldChild = oldCatalog.find((entry: any) => entry.mode !== 'external')
      await expect(controller.events({ address: { kind: 'subagent', parentSessionId: 'legacy-copy', childSessionId: oldChild.id, mode: oldChild.mode }, maxMessages: 50 }, new AbortController().signal)).rejects.toMatchObject({ code: 'subagent/unauthorized' })
      const repaired = await CurrentMigration.runMigration(catalog, target, source, { mode: 'clone', verify: true, session: 'legacy-copy', newSessionId: 'repaired-copy' })
      expect(repaired.status, JSON.stringify(repaired)).toBe('completed')
      visited.clear(); await inspect('repaired-copy', source.id); expect(visited.size).toBe(2)
      const output = await read('repaired-copy')
      expect(output.events.slice(0, -1).filter(event => event.type !== 'subagent/catalog')).toEqual(preserved.events.filter(event => event.type !== 'subagent/catalog'))
      expect(output.events.at(-1)).toMatchObject({ type: 'session/title', data: { title: '副本-Added after the old copy' } })
      const movedBack = await CurrentMigration.runMigration(catalog, source, target, { mode: 'overwrite', verify: true, session: 'repaired-copy' })
      expect(movedBack.status, JSON.stringify(movedBack)).toBe('completed')
      expect(catalog.get('repaired-copy')?.originSessionId).toBe('legacy-copy')
      visited.clear(); await inspect('repaired-copy', target.id); expect(visited.size).toBe(2)
      expect(await read('legacy-copy')).toEqual(preserved)
    }
    if (mode === 'clone') for (const [id, expected] of before) { const actual = await read(id); expect(actual.header).toEqual((expected as any).header); expect(actual.events).toEqual((expected as any).events) }
  } finally { await rootCtx.fiber.dispose(); await sqliteCtx.fiber.dispose(); await jsonl.dispose(); await rm(base, { recursive: true, force: true }) }
}, 30000)
