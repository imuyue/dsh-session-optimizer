import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import type { Context } from '@deepseek-ai/cordis'
import { registerConsole } from '../src/console.ts'
import { forgetPickerInventory } from '../src/source-picker.ts'
import { groupedSessions } from '../src/session-groups.ts'
import type { SourceListing } from '../src/migrate.ts'
const roots: string[] = []
afterEach(async () => { forgetPickerInventory(); for (const root of roots.splice(0)) await rm(root, {recursive:true,force:true}) })
async function fixture() {
 const root=await mkdtemp(join(tmpdir(),'dso-transfer-groups-')); roots.push(root)
 const headers: Array<{id:string;origin?:'subagent';parentSession?:string}> = Array.from({length:53},(_,i)=>({id:`main-${i}`}))
 headers.push({id:'child-one',origin:'subagent',parentSession:'main-0'},{id:'child-two',origin:'subagent',parentSession:'main-0'},{id:'nested',origin:'subagent',parentSession:'child-one'},{id:'fork',parentSession:'main-0'})
 for(const header of headers){const dir=join(root,'project',header.id);await mkdir(dir,{recursive:true});await writeFile(join(dir,'session.v4.jsonl.zstd'),zstdCompressSync(Buffer.from(JSON.stringify({type:'session',version:4,cwd:root,createdAt:1,...header})+'\n'+JSON.stringify({type:'session/title',seq:0,data:{title:'Title '+header.id}})+'\n')))}
 const routes=new Map<string,{fetch:(request:Request)=>Promise<Response>}>()
 registerConsole({connection:{fetch:{register:(route:{path:string;fetch:(request:Request)=>Promise<Response>})=>{routes.set(route.path,route);return async()=>{}}}}}as unknown as Context,{root:join(root,'empty-sqlite'),jsonlRoot:root,settings:{journalMode:'wal',synchronous:'full',busyTimeoutMs:1000},storageThread:'inline'})
 const get=async(params:Record<string,string>)=>{const query=new URLSearchParams({backend:'jsonl',root,summary:'1',grouped:'1',limit:'50',...params});return routes.get('/api/session-optimizer/source')!.fetch(new Request('http://test/api/session-optimizer/source?'+query))}
 const page=async(params:Record<string,string>={})=>{const response=await get(params);expect(response.status).toBe(200);return response.json() as Promise<SourceListing>}
 return{root,page,get}
}
it('pages main conversations before slicing and expands only direct children without adding their values',async()=>{
 const {page}=await fixture(),a=await page(),b=await page({offset:'50'})
 expect([a.total,a.sessions.length,b.sessions.length]).toEqual([54,50,4])
 const all=[...a.sessions,...b.sessions];expect(new Set(all.map(x=>x.id)).size).toBe(54)
 expect(all.some(x=>x.id==='child-one'||x.id==='nested')).toBe(false)
 const main=all.find(x=>x.id==='main-0')!;expect(main.childCount).toBe(2)
 const child=await page({parent:'main-0'});expect(child.sessions.map(x=>x.id).sort()).toEqual(['child-one','child-two'])
 expect(child.sessions.find(x=>x.id==='child-one')?.childCount).toBe(1)
 expect((await page({parent:'child-one'})).sessions.map(x=>x.id)).toEqual(['nested'])
 expect(main.eventCount).toBe(0);expect(main.detailsPending).toBe(true)
 expect(all.some(x=>x.id==='fork')).toBe(true)
})
it('keeps the parent entry when searching a descendant and does not require a search match to expand',async()=>{
 const {page}=await fixture();const result=await page({q:'nested'})
 expect(result.total).toBe(1);expect(result.sessions[0]?.id).toBe('main-0')
 expect((await page({parent:'main-0',q:'nested'})).sessions).toHaveLength(2)
})
it('does not resurrect deleted parent rows and preserves legacy flat requests',async()=>{
 const {root,page}=await fixture();await page();await rm(join(root,'project','main-0'),{recursive:true})
 const result=await page({limit:'100'});expect(result.sessions.some(x=>x.id==='main-0')).toBe(false)
 expect(result.sessions.some(x=>x.id==='child-one')).toBe(true)
 const flat=await page({grouped:'0',limit:'100'});expect(flat.sessions).toHaveLength(56)
})
it('rejects malformed parent parameters at the actual endpoint',async()=>{
 const {get}=await fixture();expect((await get({parent:''})).status).toBe(400);expect((await get({parent:'x'.repeat(257)})).status).toBe(400)
})
it('keeps forks, orphan chains and cycles visible with their original independent values',()=>{
 const rows=[{id:'parent',eventCount:7,sizeBytes:100},{id:'child',origin:'subagent' as const,parentSession:'parent',eventCount:9,sizeBytes:200},{id:'orphan',origin:'subagent' as const,parentSession:'gone'},{id:'cycle-a',origin:'subagent' as const,parentSession:'cycle-b'},{id:'cycle-b',origin:'subagent' as const,parentSession:'cycle-a'},{id:'fork',parentSession:'parent'}]
 const grouped=groupedSessions(rows);expect(grouped.map(x=>x.id)).toEqual(['parent','orphan','cycle-a','cycle-b','fork'])
 expect(grouped[0]).toMatchObject({eventCount:7,sizeBytes:100,childCount:1});expect(groupedSessions(rows,'','parent')[0]).toMatchObject({eventCount:9,sizeBytes:200})
})
