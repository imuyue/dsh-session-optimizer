import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionBackendCatalog } from '../src/catalog.ts'
import { mountJsonl, findJsonlArtifact } from '../src/transfer.ts'
import { runMigration } from '../src/migrate.ts'
import type { Context } from '@deepseek-ai/cordis'
import { registerConsole } from '../src/console.ts'
import { findDatabasePath } from '../src/storage.ts'
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run() })
const cases = ['same-path', 'directory-alias'].flatMap(kind => [ { kind, namedLease: false }, { kind, namedLease: true } ])
it.each(cases)('preserves a shared physical root: $kind, named-lease model $namedLease', async ({ kind, namedLease }) => {
  const base = await mkdtemp(join(tmpdir(), 'dso-root-collision-'))
  cleanup.push(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const actual = join(base, 'actual'), alias = join(base, 'alias')
  await mkdir(actual)
  await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const jsonl = await mountJsonl(actual, 'jsonl'); cleanup.push(() => jsonl.dispose())
  const id = 'session-root-collision-fixture' as SessionId
  const writer = await jsonl.persistence.create({ version: 4, id, cwd: base, createdAt: 1700000000000, isSeeded: false, delegationDepth: 0 } as SessionHeader)
  cleanup.push(() => writer.close())
  await writer.append([{ type: 'session/title', seq: 0, time: 1700000000001, data: { title: 'root collision fixture', messageSeqs: [], source: { kind: 'user' } } }] as never)
  await writer.flush(); await writer.close()
  const leaseProvider = await mountJsonl(actual); cleanup.push(() => leaseProvider.dispose())
  if (namedLease) {
    // Model the relevant Windows semaphore property: it is held independently of
    // SQLite's marker/flock. This does not simulate Windows filesystem sharing.
    const original = Object.getOwnPropertyDescriptor(leaseProvider.persistence, 'acquireLease')
    Object.defineProperty(leaseProvider.persistence, 'acquireLease', { configurable: true, value: async () => ({ release: async () => {} }) })
    cleanup.push(async () => { if (original === undefined) Reflect.deleteProperty(leaseProvider.persistence, 'acquireLease'); else Object.defineProperty(leaseProvider.persistence, 'acquireLease', original) })
  }
  const catalog = await SessionBackendCatalog.open(join(base, 'state'))
  catalog.route(id, 'jsonl'); await catalog.save()
  const source = { id: 'jsonl' as const, root: actual, persistence: jsonl.persistence }
  const target = { id: 'sqlite' as const, root: kind === 'same-path' ? actual : alias }
  const outcome = await runMigration(catalog, source, target, { mode: 'overwrite', verify: true, sessions: [id] }).then(report => ({ report, error: undefined }), error => ({ report: undefined, error: String(error) }))
  const observed = { blocked: outcome.error !== undefined && /same.*directory/i.test(outcome.error), sourcePresent: (await findJsonlArtifact(actual, id)) !== undefined, routedTo: catalog.backendOf(id), targetPresent: (await findDatabasePath(target.root, id)) !== undefined, reportStatus: outcome.report?.status ?? null, itemErrors: outcome.report?.items.map(item => item.error) ?? [] }
  if (namedLease) expect(observed, JSON.stringify(observed)).toMatchObject({ blocked: true, sourcePresent: true, routedTo: 'jsonl' })
  else {
    // Negative control: the POSIX file lease already prevents the second writer.
    expect(observed, JSON.stringify(observed)).toMatchObject({ sourcePresent: true, routedTo: 'jsonl' })
    expect(observed.blocked || observed.reportStatus === 'failed').toBe(true)
  }
})
it.each([['jsonl_to_sqlite', 'overwrite'], ['sqlite_to_jsonl', 'clone']] as const)('HTTP preflight rejects a root alias: %s/%s', async (direction, mode) => {
  const base = await mkdtemp(join(tmpdir(), 'dso-root-http-'))
  cleanup.push(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const actual = join(base, 'actual'), alias = join(base, 'alias')
  await mkdir(actual); await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const catalog = await SessionBackendCatalog.open(join(base, 'state'))
  type Route = { path: string; fetch(request: Request): Promise<Response> }
  const routes = new Map<string, Route>()
  const ctx = { connection: { fetch: { register(route: Route) { routes.set(route.path, route); return async () => {} } } } } as unknown as Context
  registerConsole(ctx, { root: actual, jsonlRoot: alias, storageThread: 'inline', settings: { journalMode: 'wal', synchronous: 'full', busyTimeoutMs: 5000 }, migrations: { catalog, sqlite: { id: 'sqlite', root: actual }, jsonl: { id: 'jsonl', root: alias } } })
  const answer = await routes.get('/api/session-optimizer/migrate')!.fetch(new Request('http://fixture/api/session-optimizer/migrate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ direction, mode }) }))
  expect(answer.status).toBe(400)
  expect(await answer.text()).toContain('same directory')
})
