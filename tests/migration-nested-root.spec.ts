import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionBackendCatalog } from '../src/catalog.ts'
import { mountJsonl, findJsonlArtifact } from '../src/transfer.ts'
import { runMigration } from '../src/migrate.ts'
import { findDatabasePath } from '../src/storage.ts'
import type { Context } from '@deepseek-ai/cordis'
import { registerConsole } from '../src/console.ts'
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run() })
it.each(['direct', 'directory-alias'] as const)('blocks a target nested inside the source session: %s', async kind => {
  const base = await mkdtemp(join(tmpdir(), 'dso-nested-migration-'))
  cleanup.push(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const sourceRoot = join(base, 'sessions')
  const jsonl = await mountJsonl(sourceRoot, 'jsonl'); cleanup.push(() => jsonl.dispose())
  const id = 'session-nested-root-fixture' as SessionId
  const writer = await jsonl.persistence.create({ version: 4, id, cwd: base, createdAt: 1700000000000, isSeeded: false, delegationDepth: 0 } as SessionHeader)
  cleanup.push(() => writer.close())
  await writer.append([{ type: 'session/title', seq: 0, time: 1700000000001, data: { title: 'nested fixture', messageSeqs: [], source: { kind: 'user' } } }] as never)
  await writer.flush(); await writer.close()
  const artifact = await findJsonlArtifact(sourceRoot, id)
  expect(artifact).toBeDefined()
  const holder = dirname(artifact!.path)
  const alias = join(base, 'session-alias')
  await symlink(holder, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const targetRoot = join(kind === 'direct' ? holder : alias, 'sqlite-output')
  const catalog = await SessionBackendCatalog.open(join(base, 'catalog'))
  catalog.route(id, 'jsonl'); await catalog.save()
  const outcome = await runMigration(catalog, { id: 'jsonl', root: sourceRoot, persistence: jsonl.persistence }, { id: 'sqlite', root: targetRoot }, { mode: 'overwrite', verify: true, sessions: [id] }).then(report => ({ report, error: undefined }), error => ({ report: undefined, error: String(error) }))
  const observed = { blocked: outcome.error !== undefined, sourcePresent: (await findJsonlArtifact(sourceRoot, id)) !== undefined, targetPresent: (await findDatabasePath(targetRoot, id)) !== undefined, routedTo: catalog.backendOf(id), reportStatus: outcome.report?.status, itemErrors: outcome.report?.items.map(item => item.error) }
  expect(observed, JSON.stringify(observed)).toMatchObject({ blocked: true, sourcePresent: true, targetPresent: false, routedTo: 'jsonl' })
})
it.each(['jsonl_to_sqlite', 'sqlite_to_jsonl'].flatMap(direction => ['overwrite', 'clone'].map(mode => ({direction,mode}))))('HTTP blocks nested roots before starting $direction/$mode',async({direction,mode})=>{
  const base=await mkdtemp(join(tmpdir(),'dso-nested-http-'))
  cleanup.push(()=>rm(base,{recursive:true,force:true,maxRetries:5,retryDelay:50}))
  const jsonlRoot=join(base,'jsonl'), alias=join(base,'alias')
  const {mkdir}=await import('node:fs/promises');await mkdir(jsonlRoot)
  await symlink(jsonlRoot,alias,process.platform==='win32'?'junction':'dir')
  const sqliteRoot=join(alias,'not-created','sqlite')
  const catalog=await SessionBackendCatalog.open(join(base,'state'))
  type Route={path:string;fetch(request:Request):Promise<Response>}
  const routes=new Map<string,Route>()
  const ctx={connection:{fetch:{register(route:Route){routes.set(route.path,route);return async()=>{}}}}}as unknown as Context
  registerConsole(ctx,{root:sqliteRoot,jsonlRoot,storageThread:'inline',settings:{journalMode:'wal',synchronous:'full',busyTimeoutMs:5000},migrations:{catalog,sqlite:{id:'sqlite',root:sqliteRoot},jsonl:{id:'jsonl',root:jsonlRoot}}})
  const response=await routes.get('/api/session-optimizer/migrate')!.fetch(new Request('http://fixture/api/session-optimizer/migrate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({direction,mode})}))
  expect(response.status).toBe(400)
  expect(await response.text()).toContain('contain one another')
})
