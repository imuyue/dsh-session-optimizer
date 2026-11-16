import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionBackendCatalog } from '../src/catalog.ts'
import { mountJsonl } from '../src/transfer.ts'
import { startMigration, detachMigrationJournal } from '../src/migrate.ts'
const cleanup:(()=>Promise<unknown>)[]=[]
afterEach(async()=>{await detachMigrationJournal();for(const run of cleanup.splice(0).reverse())await run()})
it.each(['mounted', 'alias'] as const)('recognizes mounted directories when source is an alias and target is %s',async(targetKind)=>{
 const base=await mkdtemp(join(tmpdir(),'dso-mounted-alias-'));cleanup.push(()=>rm(base,{recursive:true,force:true,maxRetries:5,retryDelay:50}))
 const actual=join(base,'actual'), alias=join(base,'alias'), sqliteRoot=join(base,'sqlite'), sqliteAlias=join(base,'sqlite-alias');await mkdir(actual);await mkdir(sqliteRoot)
 await symlink(actual,alias,process.platform==='win32'?'junction':'dir')
 await symlink(sqliteRoot,sqliteAlias,process.platform==='win32'?'junction':'dir')
 const jsonl=await mountJsonl(actual,'jsonl');cleanup.push(()=>jsonl.dispose())
 const id='session-alias-fixture' as SessionId
 const writer=await jsonl.persistence.create({version:4,id,cwd:base,createdAt:1700000000000,isSeeded:false,delegationDepth:0} as SessionHeader)
 cleanup.push(()=>writer.close())
 await writer.append([{type:'session/title',seq:0,time:1700000000001,data:{title:'alias fixture',messageSeqs:[],source:{kind:'user'}}}] as never)
 await writer.flush()
 const catalog=await SessionBackendCatalog.open(join(base,'state'))
 const released:string[]=[]
 const host={catalog,jsonl:{id:'jsonl' as const,root:actual,persistence:jsonl.persistence},sqlite:{id:'sqlite' as const,root:sqliteRoot,persistence:undefined as never},prepareSession:async(value:string)=>{released.push(value);await writer.close()}}
 const job=startMigration(host,'jsonl_to_sqlite',{mode:'overwrite',verify:true,sessions:[id]},{source:{...host.jsonl,root:alias},target:{...host.sqlite,root:targetKind==='alias'?sqliteAlias:sqliteRoot}})
 await vi.waitFor(()=>expect(job.status).not.toBe('running'),{timeout:5000})
 expect(released).toEqual([id])
 expect(job.status).toBe('completed')
})
