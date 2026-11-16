import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionBackendCatalog } from '../src/catalog.ts'
import { mountJsonl, findJsonlArtifact, readJsonlSession } from '../src/transfer.ts'
import { runMigration } from '../src/migrate.ts'
import { findDatabasePath } from '../src/storage.ts'
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run() })
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
async function fixture(refused = true, broken = true) {
  const base = await mkdtemp(join(tmpdir(), 'dso-torn-migration-'))
  cleanup.push(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const sourceRoot = join(base, 'jsonl'), targetRoot = join(base, 'sqlite')
  const jsonl = await mountJsonl(sourceRoot, 'jsonl'); cleanup.push(() => jsonl.dispose())
  const id = 'session-torn-migration-fixture' as SessionId, cloneId = 'session-torn-clone-fixture' as SessionId
  const writer = await jsonl.persistence.create({ version: 4, id, cwd: base, createdAt: 1700000000000, isSeeded: false, delegationDepth: 0 } as SessionHeader)
  cleanup.push(() => writer.close())
  const title = { type: 'session/title', seq: 0, time: 1700000000001, data: { title: 'valid prefix', messageSeqs: [], source: { kind: 'user' } } }
  await writer.append([title] as never); await writer.flush(); await writer.close()
  const artifact = await findJsonlArtifact(sourceRoot, id); expect(artifact).toBeDefined()
  const first = refused ? { ...title, data: { title: 'provider-refused prefix' } } : title
  const last = { ...title, seq: 1, data: { ...title.data, title: 'data beyond corruption' } }
  const headerLine = (await readFile(artifact!.path, 'utf8')).split('\n')[0]!
  await writeFile(artifact!.path, headerLine + '\n' + JSON.stringify(first) + (broken ? '\n{not JSON}\n' : '\n') + JSON.stringify(last) + '\n')
  return { base, sourceRoot, targetRoot, jsonl, id, cloneId, artifact: artifact!, first, last }
}
it.each((['overwrite', 'clone'] as const).flatMap(mode => [true, false].map(verify => ({ mode, verify }))))('does not publish a damaged-source prefix: $mode verify=$verify', async ({mode, verify}) => {
  const {base, sourceRoot, targetRoot, jsonl, id, cloneId, artifact, first} = await fixture()
  const before = digest(await readFile(artifact.path))
  const copy = await readJsonlSession(sourceRoot, id)
  expect(copy?.events).toEqual([first]); expect(copy?.incomplete).toBe(true)
  expect(copy?.problem).toContain('copied that prefix')
  const catalog = await SessionBackendCatalog.open(join(base, 'catalog'))
  catalog.route(id, 'jsonl'); await catalog.save()
  const report = await runMigration(catalog, { id: 'jsonl', root: sourceRoot, persistence: jsonl.persistence }, { id: 'sqlite', root: targetRoot }, { mode, verify, sessions: [id], newSessionId: cloneId })
  const remaining = await findJsonlArtifact(sourceRoot, id)
  const target = await findDatabasePath(targetRoot, mode === 'clone' ? cloneId : id)
  const observed = { status: report.items[0]?.status, sourcePresent: remaining !== undefined, sourceUnchanged: remaining !== undefined && digest(await readFile(remaining.path)) === before, targetPresent: target !== undefined, routedTo: catalog.backendOf(mode === 'clone' ? cloneId : id), error: report.items[0]?.error }
  expect(observed, JSON.stringify(observed)).toMatchObject({ status: 'failed', sourcePresent: true, sourceUnchanged: true, targetPresent: false, routedTo: mode === 'clone' ? undefined : 'jsonl' })
  expect(observed.error).toContain('incomplete')
})
it('keeps the official provider committed-prefix recovery contract', async () => {
  const f = await fixture(false, true), copy = await readJsonlSession(f.sourceRoot, f.id)
  expect(copy?.events).toEqual([f.first]); expect(copy?.incomplete).toBeUndefined(); expect(copy?.problem).toBeUndefined()
})
it('distinguishes complete provider-refused copies from incomplete salvage', async () => {
  const f = await fixture(true, false), copy = await readJsonlSession(f.sourceRoot, f.id)
  expect(copy?.events).toEqual([f.first, f.last]); expect(copy?.incomplete).toBeUndefined()
  expect(copy?.problem).toContain('copied the whole log')
})
