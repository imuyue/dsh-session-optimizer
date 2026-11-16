import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionBackendCatalog } from '../src/catalog.ts'
import { attachMigrationJournal, clearMigrationHistory, detachMigrationJournal, listMigrations, startMigration } from '../src/migrate.ts'
import { createMigrationHistoryTool } from '../src/migration-history-tool.ts'
import { mountJsonl, readSqliteSessionById } from '../src/transfer.ts'
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { await detachMigrationJournal(); for (const run of cleanup.splice(0).reverse()) await run() })
it('clears finished jobs, keeps a waiting job, persists the cleared history and leaves conversation data intact', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dso-clear-history-')); cleanup.push(() => rm(base, { recursive: true, force: true }))
  const journal = join(base, 'state'); const catalog = await SessionBackendCatalog.open(journal)
  await mkdir(journal, { recursive: true })
  await writeFile(join(journal, 'migrations.json'), JSON.stringify({ version: 1, jobs: [
    { id: 'finished', direction: 'jsonl_to_sqlite', mode: 'overwrite', sourceRoot: 'source', targetRoot: 'target', status: 'completed', startedAt: 1 },
    { id: 'failed', direction: 'jsonl_to_sqlite', mode: 'overwrite', sourceRoot: 'source', targetRoot: 'target', status: 'failed', startedAt: 2 },
  ] }))
  await attachMigrationJournal(journal)
  const jsonl = await mountJsonl(join(base, 'jsonl'), 'jsonl'); cleanup.push(() => jsonl.dispose())
  const id = 'session-history-fixture' as SessionId
  const handle = await jsonl.persistence.create({ version: 4, id, cwd: base, createdAt: 1700000000000, isSeeded: false, delegationDepth: 0 } as SessionHeader)
  await handle.append([{ type: 'session/title', seq: 0, time: 1700000000001, data: { title: 'history fixture' } }] as never)
  await handle.flush()
  await handle.close()
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  const sqlite = { id: 'sqlite' as const, root: join(base, 'sqlite'), persistence: undefined as never }
  const job = startMigration({ catalog, sqlite, jsonl: { id: 'jsonl', root: join(base, 'jsonl'), persistence: jsonl.persistence },
    prepareSession: async (_id, notice) => { notice?.('等待结束'); entered.resolve(); await gate.promise; notice?.() },
  }, 'jsonl_to_sqlite', { mode: 'overwrite', verify: true, sessions: [id] })
  await entered.promise
  expect(job.notice).toBe('等待结束')
  expect(await clearMigrationHistory()).toEqual({ cleared: 2, retainedRunning: 1 })
  expect(listMigrations().map(value => value.id)).toEqual([job.id])
  expect(JSON.parse(await readFile(join(journal, 'migrations.json'), 'utf8')).jobs.map((value: { id: string }) => value.id)).toEqual([job.id])
  gate.resolve(); await vi.waitFor(() => { expect(job.status).toBe('completed') }, { timeout: 5000 })
  expect(job.notice).toBeUndefined()
  const tool = createMigrationHistoryTool()
  expect(await tool.execute({ action: 'status' })).toEqual({ total: 1, running: 0, finished: 1 })
  expect(await tool.execute({ action: 'clear' })).toEqual({ cleared: 1, retainedRunning: 0 })
  await detachMigrationJournal(); await attachMigrationJournal(journal)
  expect(listMigrations()).toEqual([])
  expect((await readSqliteSessionById(sqlite.root, id, { force: false, verify: true, digest: false, readOnlySources: true }))?.header.id).toBe(id)
})
it('keeps finished history visible if persisting its removal fails', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dso-clear-history-atomic-')); cleanup.push(() => rm(base, { recursive: true, force: true }))
  const path = join(base, 'state')
  await mkdir(path, { recursive: true })
  const original = { version: 1, jobs: [{ id: 'must-remain', direction: 'jsonl_to_sqlite', mode: 'overwrite', sourceRoot: 'source', targetRoot: 'target', status: 'completed', startedAt: 1 }] }
  await writeFile(join(path, 'migrations.json'), JSON.stringify(original))
  await attachMigrationJournal(path)
  await rm(path, { recursive: true, force: true }); await writeFile(path, 'not a directory')
  await expect(clearMigrationHistory()).rejects.toThrow()
  expect(listMigrations().map(job => job.id)).toEqual(['must-remain'])
  await rm(path); await mkdir(path)
  expect(await clearMigrationHistory()).toEqual({ cleared: 1, retainedRunning: 0 })
  expect(listMigrations()).toEqual([])
  expect(JSON.parse(await readFile(join(path, 'migrations.json'), 'utf8')).jobs).toEqual([])
})
it('commits overlapping clears once, after persistence, without resurrecting history', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dso-clear-history-overlap-')); cleanup.push(() => rm(base, { recursive: true, force: true }))
  await mkdir(join(base, 'state'))
  await writeFile(join(base, 'state', 'migrations.json'), JSON.stringify({ version: 1, jobs: [
    { id: 'once', direction: 'jsonl_to_sqlite', mode: 'overwrite', sourceRoot: 'source', targetRoot: 'target', status: 'completed', startedAt: 1 },
  ] }))
  await attachMigrationJournal(join(base, 'state'))
  const first = clearMigrationHistory(), second = clearMigrationHistory()
  expect(listMigrations().map(job => job.id)).toEqual(['once'])
  const result = await Promise.all([first, second])
  expect(result.map(value => value.cleared)).toEqual([1, 0])
  expect(JSON.parse(await readFile(join(base, 'state', 'migrations.json'), 'utf8')).jobs).toEqual([])
  await detachMigrationJournal(); await attachMigrationJournal(join(base, 'state'))
  expect(listMigrations()).toEqual([])
})
it('does not claim persistence success when the history path cannot be written', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dso-clear-history-fail-')); cleanup.push(() => rm(base, { recursive: true, force: true }))
  const path = join(base, 'state'); await SessionBackendCatalog.open(path); await attachMigrationJournal(path)
  await rm(path, { recursive: true, force: true }); await writeFile(path, 'not a directory')
  await expect(clearMigrationHistory()).rejects.toThrow()
})
