import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionBackendCatalog } from '../src/catalog.ts'
import { runMigration, sourceSessions, type MigrationBackend } from '../src/migrate.ts'
import { mountJsonl, writeSqliteSession, readJsonlSession, readSqliteSessionById, type LogCopy } from '../src/transfer.ts'
import { databasePath } from '../src/format.ts'
import { groupedSessions } from '../src/session-groups.ts'
for (const kind of ['jsonl', 'sqlite'] as const) for (const mode of ['overwrite', 'clone'] as const) it(`${kind} ${mode} converts explicitly selected parent and subagent without losing either log`, async () => {
  const base = await mkdtemp(join(tmpdir(), 'dso-child-conversion-')), jsonlRoot = join(base, 'jsonl'), sqliteRoot = join(base, 'sqlite'), cwd = join(base, 'project')
  await mkdir(cwd)
  const jsonl = await mountJsonl(jsonlRoot, 'jsonl')
  const backends = { jsonl: { id: 'jsonl', root: jsonlRoot, persistence: jsonl.persistence }, sqlite: { id: 'sqlite', root: sqliteRoot } } as const
  const source: MigrationBackend = backends[kind], target: MigrationBackend = backends[kind === 'jsonl' ? 'sqlite' : 'jsonl']
  const read = (backend: MigrationBackend, id: string) => backend.id === 'jsonl' ? readJsonlSession(backend.root, id) : readSqliteSessionById(backend.root, id, { force: false, verify: false, digest: false, readOnlySources: true })
  const logs = new Map<string, LogCopy>()
  try {
    for (const id of ['parent', 'child']) {
      const header = { version: 4, id: id as SessionId, cwd, createdAt: 1700000000000, isSeeded: false, delegationDepth: id === 'parent' ? 0 : 1, ...(id === 'child' ? { origin: 'subagent', parentSession: 'parent' } : {}) } as SessionHeader
      const relation = id === 'parent' ? { type: 'subagent/catalog', data: { version: 0, childId: 'child', childCreatedAt: 1700000000000, mode: 'continuable', label: 'Child' } } : { type: 'subagent/descriptor', data: { version: 3, mode: 'continuable', provider: 'local', label: 'Child' } }
      const copy = { header, inheritedEventCount: 0, events: [{ type: 'session/title', seq: 0, time: 1700000000000, data: { title: id, messageSeqs: [], source: { kind: 'user' } } }, { type: 'turn/start', seq: 1, time: 1700000000001, data: { turn: 1 } }, { type: 'turn/end', seq: 2, time: 1700000000002, data: { turn: 1, reason: { kind: 'completed' } } }, { ...relation, seq: 3, time: 1700000000003 }] } as unknown as LogCopy
      if (kind === 'sqlite') await writeSqliteSession(databasePath(sqliteRoot, cwd, header.id), copy)
      else { const handle = await jsonl.persistence.create(header); try { await handle.append([...copy.events]); await handle.flush() } finally { await handle.close() } }
      logs.set(id, (await read(source, id))!)
    }
    const catalog = await SessionBackendCatalog.open(join(base, 'state'))
    const report = await runMigration(catalog, source, target, { mode, verify: true, sessions: ['parent', 'child'] })
    expect(report.status, JSON.stringify(report)).toBe('completed'); expect(report.items).toHaveLength(2)
    for (const item of report.items) {
      expect(item.error).toBeUndefined()
      const produced = (await read(target, item.targetSession))!, original = logs.get(item.sourceSession)!
      expect(produced.header.id).toBe(item.targetSession)
      const expectedParent = mode === 'clone' && original.header.origin === 'subagent'
        ? report.items.find(value => value.sourceSession === String(original.header.parentSession))?.targetSession ?? original.header.parentSession
        : original.header.parentSession
      expect(produced.header.parentSession).toBe(expectedParent)
      expect(produced.header.origin).toBe(original.header.origin)
      const expectedEvents = mode === 'clone' ? original.events.map(event => {
        if (String(event.type) !== 'subagent/catalog') return event
        const data = event.data as unknown as { childId: string }
        return { ...event, data: { ...event.data, childId: report.items.find(value => value.sourceSession === data.childId)!.targetSession } }
      }) : original.events
      expect(mode === 'clone' ? produced.events.slice(0, -1) : produced.events).toEqual(expectedEvents)
      if (mode === 'clone') { expect(produced.events.at(-1)).toMatchObject({ type: 'session/title', data: { title: '副本-' + item.sourceSession } }); expect(await read(source, item.sourceSession)).toEqual(original) }
      expect(catalog.get(item.targetSession)?.backend).toBe(target.id)
    }
    const parentId = report.items.find(item => item.sourceSession === 'parent')!.targetSession
    const childId = report.items.find(item => item.sourceSession === 'child')!.targetSession
    const rows = await sourceSessions(target)
    expect(groupedSessions(rows).map(row => row.id)).toEqual([parentId])
    expect(groupedSessions(rows, '', parentId).map(row => row.id)).toEqual([childId])
  } finally { await jsonl.dispose(); await rm(base, { recursive: true, force: true }) }
}, 30000)
