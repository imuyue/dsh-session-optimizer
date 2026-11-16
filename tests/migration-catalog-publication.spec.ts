import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionBackendCatalog } from '../src/catalog.ts'
import { mountJsonl, findJsonlArtifact } from '../src/transfer.ts'
import { runMigration } from '../src/migrate.ts'
import { findDatabasePath } from '../src/storage.ts'
const cleanups: (() => Promise<unknown>)[]=[]
afterEach(async()=>{for(const run of cleanups.splice(0).reverse())await run()})
it.each(['overwrite','clone']as const)('does not publish an in-memory route after catalog persistence fails: %s',async mode=>{
 const base=await mkdtemp(join(tmpdir(),'dso-route-publication-'))
 cleanups.push(()=>rm(base,{recursive:true,force:true,maxRetries:5,retryDelay:50}))
 const sourceRoot=join(base,'jsonl'),targetRoot=join(base,'sqlite'),state=join(base,'state'),saved=join(base,'state-before')
 const jsonl=await mountJsonl(sourceRoot,'jsonl');cleanups.push(()=>jsonl.dispose())
 const id='session-route-publication-source'as SessionId,clone='session-route-publication-clone'as SessionId
 const writer=await jsonl.persistence.create({version:4,id,cwd:base,createdAt:1700000000000,isSeeded:false,delegationDepth:0}as SessionHeader)
 cleanups.push(()=>writer.close())
 await writer.append([{type:'session/title',seq:0,time:1700000000001,data:{title:'private publication fixture',messageSeqs:[],source:{kind:'user'}}}]as never)
 await writer.flush();await writer.close()
 const artifact=await findJsonlArtifact(sourceRoot,id);expect(artifact).toBeDefined()
 const original=await readFile(artifact!.path)
 const catalog=await SessionBackendCatalog.open(state);catalog.route(id,'jsonl');await catalog.save()
 // Real filesystem error, not a mock save(): preserve the previous document,
 // then replace its parent directory with a file so mkdir/write must fail.
 await rename(state,saved);await writeFile(state,'not a directory')
 const targetId=mode==='clone'?clone:id
 const report=await runMigration(catalog,{id:'jsonl',root:sourceRoot,persistence:jsonl.persistence},{id:'sqlite',root:targetRoot},{mode,verify:true,session:id,...(mode==='clone'?{newSessionId:clone}:{})})
 const observed={status:report.status,route:catalog.backendOf(targetId)??null,sourcePresent:(await findJsonlArtifact(sourceRoot,id))!==undefined,targetPresent:(await findDatabasePath(targetRoot,targetId))!==undefined,error:report.items[0]?.error}
 expect(observed,JSON.stringify(observed)).toMatchObject({status:'failed',route:mode==='clone'?null:'jsonl',sourcePresent:true})
 expect(await readFile(artifact!.path)).toEqual(original)
 await rm(state);await rename(saved,state)
 const reopened=await SessionBackendCatalog.open(state)
 expect(reopened.backendOf(id)).toBe('jsonl');expect(reopened.backendOf(clone)).toBeUndefined()
 // A later successful save must not make the failed route visible after restart.
 await catalog.save()
 expect((await SessionBackendCatalog.open(state)).backendOf(targetId)).toBe(mode==='clone'?undefined:'jsonl')
})
