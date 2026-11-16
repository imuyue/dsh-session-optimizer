import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionBackendCatalog } from '../src/catalog.ts'
import { attachMigrationJournal, detachMigrationJournal, listMigrations, startMigration } from '../src/migrate.ts'
import { findJsonlArtifact, mountJsonl } from '../src/transfer.ts'
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { await detachMigrationJournal(); for (const run of cleanup.splice(0).reverse()) await run() })
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
it.each(['current', 'detached', 'other-profile'] as const)('contains a late aborted migration in its originating history: %s', async disposition => {
  const base = await mkdtemp(join(tmpdir(), 'dso-job-history-generation-')); cleanup.push(() => rm(base, { recursive: true, force: true }))
  const firstState = join(base, 'state-a'), secondState = join(base, 'state-b')
  const catalog = await SessionBackendCatalog.open(firstState)
  await attachMigrationJournal(firstState)
  const jsonlRoot = join(base, 'jsonl'), sqliteRoot = join(base, 'sqlite')
  const mounted = await mountJsonl(jsonlRoot, 'jsonl'); cleanup.push(() => mounted.dispose())
  const id = 'session-job-generation-fixture' as SessionId
  const writer = await mounted.persistence.create({ version: 4, id, cwd: base, createdAt: 1700000000000, isSeeded: false, delegationDepth: 0 } as SessionHeader)
  await writer.append([{ type: 'session/title', seq: 0, time: 1700000000001, data: { title: 'private fixture', messageSeqs: [], source: { kind: 'user' } } }] as never)
  await writer.flush(); await writer.close()
  catalog.route(id, 'jsonl'); await catalog.save()
  const artifact = await findJsonlArtifact(jsonlRoot, id); expect(artifact).toBeDefined()
  const before = hash(await readFile(artifact!.path))
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  const job = startMigration({ catalog, jsonl: { id: 'jsonl', root: jsonlRoot, persistence: mounted.persistence }, sqlite: { id: 'sqlite', root: sqliteRoot, persistence: undefined as never }, prepareSession: async (_id, notice) => {
    notice?.('private fixture awaiting idle'); entered.resolve(); await gate.promise
  } }, 'jsonl_to_sqlite', { mode: 'overwrite', verify: true, sessions: [id] })
  await entered.promise
  if (disposition !== 'current') await detachMigrationJournal()
  if (disposition === 'other-profile') {
    await mkdir(secondState, { recursive: true })
    await writeFile(join(secondState, 'migrations.json'), JSON.stringify({ version: 1, jobs: [{ id: 'only-profile-b', direction: 'jsonl_to_sqlite', mode: 'overwrite', sourceRoot: 'private-b-source', targetRoot: 'private-b-target', status: 'completed', startedAt: 1 }] }))
    await attachMigrationJournal(secondState)
  }
  // Mirrors a pending prepare being rejected by lifecycle teardown, without converting data.
  gate.reject(new Error('private fixture preparation was disposed'))
  await vi.waitFor(() => { expect(job.finishedAt).toBeDefined() })
  await new Promise(resolve => setTimeout(resolve, 350))
  const expected = disposition === 'current' ? [job.id] : disposition === 'other-profile' ? ['only-profile-b'] : []
  const memory = listMigrations().map(value => value.id)
  const path = join(disposition === 'other-profile' ? secondState : firstState, 'migrations.json')
  const disk = existsSync(path) ? JSON.parse(await readFile(path, 'utf8')).jobs.map((value: { id: string }) => value.id) : []
  const observed = { disposition, oldStatus: job.status, memory, disk, sourceUnchanged: hash(await readFile(artifact!.path)) === before, route: catalog.backendOf(id) }
  expect(observed, JSON.stringify(observed)).toMatchObject({ oldStatus: 'failed', memory: expected, sourceUnchanged: true, route: 'jsonl' })
  if (disposition !== 'detached') expect(disk).toEqual(expected)
}, 10000)
