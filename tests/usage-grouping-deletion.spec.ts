import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { groupOverview, inspectConsoleOverview } from '../src/console-overview.ts'
import { forgetPickerInventory, pickerPage, pickerTitles } from '../src/source-picker.ts'
import type { HybridOverview } from '../src/console-overview.ts'
const roots: string[]=[]
afterEach(async()=>{forgetPickerInventory();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
const row=(id:string,origin?:'subagent',parentSession?:string)=>({id,origin,parentSession,eventCount:7,sizeBytes:100,walBytes:0,state:'ready',problem:undefined,title:id})
const overview=(rows:ReturnType<typeof row>[])=>({sessions:rows.length,databaseBytes:rows.length*100,events:rows.length*7,usage:rows}) as HybridOverview
it('shows main rows and their own totals, without treating ordinary forks as children',()=>{
 const input=overview([row('main'),row('child','subagent','main'),row('nested','subagent','child'),row('fork',undefined,'main')])
 const main=groupOverview(input)
 expect(main).toMatchObject({sessions:2,childSessions:2,events:14,databaseBytes:400})
 expect(main.usage.map(x=>x.id)).toEqual(['main','fork'])
 expect(main.usage[0]).toMatchObject({eventCount:7,sizeBytes:100,childCount:1})
 expect(groupOverview(input,'main').usage.map(x=>x.id)).toEqual(['child'])
 expect(groupOverview(input,'child').usage.map(x=>x.id)).toEqual(['nested'])
 expect(input.usage).toHaveLength(4)
})
it('does not hide orphans, self references or cycles, or invent a deleted parent',()=>{
 const result=groupOverview(overview([row('orphan','subagent','gone'),row('self','subagent','self'),row('a','subagent','b'),row('b','subagent','a')]))
 expect(result.usage).toHaveLength(4);expect(result.sessions).toBe(4);expect(result.childSessions).toBe(0)
 expect(result.usage.some(x=>x.id==='gone')).toBe(false)
})
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'dso-group-delete-'));roots.push(root)
 const jsonl=join(root,'jsonl'),sqlite=join(root,'sqlite');await mkdir(sqlite)
 for(const header of [{id:'main'},{id:'child',origin:'subagent',parentSession:'main'},{id:'fork',parentSession:'main'}]){
  const dir=join(jsonl,'project',header.id);await mkdir(dir,{recursive:true})
  await writeFile(join(dir,'session.v4.jsonl.zstd'),zstdCompressSync(Buffer.from(JSON.stringify({type:'session',cwd:root,createdAt:1,...header})+'\n'+JSON.stringify({type:'session/title',data:{title:'Title '+header.id}})+'\n')))
 }
 const target={root:sqlite,storageThread:'inline' as const,settings:{journalMode:'wal' as const,synchronous:'full' as const,busyTimeoutMs:1000}}
 return {jsonl,target}
}
it('reads subagent headers and expands only existing direct children',async()=>{
 const {jsonl,target}=await fixture()
 const main=await inspectConsoleOverview(target,jsonl,undefined,{titles:false})
 expect(main).toMatchObject({sessions:2,childSessions:1,usageTotal:2})
 expect(main.usage.find(x=>x.id==='main')?.childCount).toBe(1)
 const child=await inspectConsoleOverview(target,jsonl,undefined,{parent:'main',titles:false})
 expect(child.usage.map(x=>x.id)).toEqual(['child'])
 const titled=await inspectConsoleOverview(target,jsonl,undefined,{ids:['child'],titles:true})
 expect(titled.usage[0]?.title).toBe('Title child')
})
it('drops a deleted artifact from warm inventory and never returns its cached title',async()=>{
 const {jsonl,target}=await fixture()
 await pickerTitles(jsonl,new Set(['child']))
 await inspectConsoleOverview(target,jsonl,undefined,{titles:false})
 await rm(join(jsonl,'project','child'),{recursive:true})
 expect((await pickerTitles(jsonl,new Set(['child']))).size).toBe(0)
 const result=await inspectConsoleOverview(target,jsonl,undefined,{ids:['child'],titles:true})
 expect(result.usage).toHaveLength(0)
 expect((await inspectConsoleOverview(target,jsonl,undefined,{titles:false})).childSessions).toBe(0)
 expect((await pickerPage(jsonl,{offset:0,limit:50})).sessions.some(x=>x.id==='child')).toBe(false)
})
it('keeps a subagent visible after deleting its parent and never recreates the parent row',async()=>{
 const {jsonl,target}=await fixture()
 await inspectConsoleOverview(target,jsonl,undefined,{titles:false})
 await rm(join(jsonl,'project','main'),{recursive:true})
 const result=await inspectConsoleOverview(target,jsonl,undefined,{titles:false})
 expect(result.usage.map(x=>x.id).sort()).toEqual(['child','fork'])
 expect(result).toMatchObject({sessions:2,childSessions:0})
})
