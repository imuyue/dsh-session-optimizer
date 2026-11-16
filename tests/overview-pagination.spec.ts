import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { inspectConsoleOverview, overviewPage } from '../src/console-overview.ts'
import { pickerTitles, forgetPickerInventory } from '../src/source-picker.ts'
import type { InspectOverview } from '../src/inspect.ts'
const roots: string[]=[]
afterEach(async()=>{forgetPickerInventory();for(const root of roots.splice(0)) await rm(root,{recursive:true,force:true})})
async function fixture(n=3) {
 const root=await mkdtemp(join(tmpdir(),'dso-usage-')); roots.push(root)
 const jsonl=join(root,'jsonl'), sqlite=join(root,'sqlite'); await mkdir(sqlite)
 for(let i=0;i<n;i++) {
  const id='session-'+i, dir=join(jsonl,'project',id); await mkdir(dir,{recursive:true})
  const records=[{type:'session',id,cwd:root,createdAt:1},{type:'session/title',data:{title:'Old '+i}},...Array.from({length:45},(_,seq)=>({seq,type:'user/message',data:{content:'body'}})),{type:'session/title',data:{title:'Latest '+i}}]
  await writeFile(join(dir,'session.v4.jsonl.zstd'),zstdCompressSync(Buffer.from(records.map(x=>JSON.stringify(x)).join('\n')+'\n')))
 }
 return {root,jsonl,sqlite}
}
it('paginates space rows without changing library totals and clamps a deleted last page',()=>{
 const input={sessions:123,events:999,databaseBytes:500,usage:Array.from({length:123},(_,i)=>({id:String(i)}))} as InspectOverview
 const pages=[0,50,100].map(offset=>overviewPage(input,offset,50))
 expect(pages.map(p=>p.usage.length)).toEqual([50,50,23])
 expect(pages.every(p=>p.sessions===123&&p.events===999&&p.databaseBytes===500&&p.usageTotal===123)).toBe(true)
 expect(new Set(pages.flatMap(p=>p.usage.map(row=>row.id))).size).toBe(123)
 expect(overviewPage(input,999,50).usageOffset).toBe(100)
 expect(overviewPage({...input,usage:[]},50,50).usageOffset).toBe(0)
})
it('loads only the selected space page and reads the latest title beyond the metadata window',async()=>{
 const {jsonl,sqlite}=await fixture()
 const target={root:sqlite,storageThread:'inline' as const,settings:{journalMode:'wal' as const,synchronous:'full' as const,busyTimeoutMs:1000}}
 const first=await inspectConsoleOverview(target,jsonl,undefined,{offset:0,limit:2})
 const last=await inspectConsoleOverview(target,jsonl,undefined,{offset:2,limit:2})
 expect(first).toMatchObject({sessions:3,usageTotal:3,usageOffset:0,usageLimit:2,eventsPending:true})
 expect(first.usage).toHaveLength(2); expect(last.usage).toHaveLength(1)
 const fast=await inspectConsoleOverview(target,jsonl,undefined,{offset:0,limit:2,titles:false})
 expect(fast.usage.every(row=>row.titlePending===false&&row.title?.startsWith('Latest '))).toBe(true)
 expect([...first.usage,...last.usage].map(row=>row.title).sort()).toEqual(['Latest 0','Latest 1','Latest 2'])
})
it('does not read an unselected damaged artifact and invalidates title cache after a rename append',async()=>{
 const {jsonl}=await fixture(2)
 await writeFile(join(jsonl,'project','session-1','session.v4.jsonl.zstd'),'invalid frame')
 const titles=await pickerTitles(jsonl,new Set(['session-0']))
 expect([...titles]).toEqual([['session-0',{title:'Latest 0'}]])
 const path=join(jsonl,'project','session-0','session.v4.jsonl.zstd')
 await writeFile(path,zstdCompressSync(Buffer.from(JSON.stringify({type:'session',id:'session-0'})+'\n'+JSON.stringify({type:'session/title',data:{title:'Renamed'}})+'\n')))
 expect((await pickerTitles(jsonl,new Set(['session-0']))).get('session-0')?.title).toBe('Renamed')
 expect((await pickerTitles(jsonl,new Set(['session-1']))).get('session-1')?.problem).toBeDefined()
})
it('distinguishes truly untitled sessions and caller cancellation',async()=>{
 const {jsonl}=await fixture(1)
 await writeFile(join(jsonl,'project','session-0','session.v4.jsonl.zstd'),zstdCompressSync(Buffer.from(JSON.stringify({type:'session',id:'session-0'})+'\n')))
 expect((await pickerTitles(jsonl,new Set(['session-0']))).get('session-0')).toEqual({title:undefined})
 const abort=new AbortController(); abort.abort(new Error('cancel usage'))
 await expect(pickerTitles(jsonl,new Set(['session-0']),abort.signal)).rejects.toThrow('cancel usage')
})
