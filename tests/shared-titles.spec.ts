import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('node:fs/promises', async original => { const fs=await original<typeof import('node:fs/promises')>(); return {...fs, stat:vi.fn(fs.stat)} })
vi.mock('../src/transfer.ts', async original => { const module=await original<typeof import('../src/transfer.ts')>(); return {...module,readJsonlTitle:vi.fn(module.readJsonlTitle)} })
import { readJsonlTitle } from '../src/transfer.ts'
import { forgetPickerInventory, pickerFiles, pickerPage, pickerTitles } from '../src/source-picker.ts'
import { inspectConsoleOverview } from '../src/console-overview.ts'
import { registerConsole } from '../src/console.ts'
import type { Context } from '@deepseek-ai/cordis'
const roots:string[]=[]
afterEach(async()=>{forgetPickerInventory();vi.clearAllMocks();for(const root of roots.splice(0))await removeTree(root)})
/** Windows refuses to unlink a directory whose last handle closed a moment ago (ENOTEMPTY/EBUSY), so retry briefly instead of failing the next test's cleanup. */
async function removeTree(root:string,attempts=20){for(let attempt=1;;attempt++){try{await rm(root,{recursive:true,force:true});return}catch(error){const code=(error as NodeJS.ErrnoException).code;if(attempt>=attempts||(code!=='ENOTEMPTY'&&code!=='EBUSY'&&code!=='EPERM'))throw error;await new Promise(resolve=>setTimeout(resolve,25*attempt))}}}
async function fixture(count=1){
 const root=await mkdtemp(join(tmpdir(),'dso-shared-titles-'));roots.push(root)
 const jsonl=join(root,'jsonl'),sqlite=join(root,'sqlite');await mkdir(sqlite)
 for(let i=0;i<count;i++){const dir=join(jsonl,'project','session-'+i);await mkdir(dir,{recursive:true});await writeFile(join(dir,'session.v4.jsonl'),[
  {type:'session',id:'session-'+i,cwd:root}, {type:'session/title',data:{title:'Early '+i}},
  ...Array.from({length:40},()=>({type:'user/message',data:{content:'body'}})),{type:'session/title',data:{title:'Latest '+i}},
 ].map(row=>JSON.stringify(row)).join('\n')+'\n')}
 return {jsonl,sqlite,target:{root:sqlite,storageThread:'inline' as const,settings:{journalMode:'wal' as const,synchronous:'full' as const,busyTimeoutMs:1000}}}
}
it('selected warm title reads stat only selected artifacts instead of all library files',async()=>{
 const {jsonl}=await fixture(80);await pickerFiles(jsonl);vi.mocked(stat).mockClear()
 expect((await pickerTitles(jsonl,new Set(['session-0']))).get('session-0')?.title).toBe('Latest 0')
 // 80 artifacts exist; only the selected one may be stat'ed (its directory and
 // its file both count as that one artifact).
 const statted=vi.mocked(stat).mock.calls.map(call=>String(call[0]))
 expect(statted.filter(path=>/session-\d+/.test(path)&&!path.includes('session-0'))).toEqual([])
 expect(statted.filter(path=>path.includes('session-0')).length).toBeGreaterThan(0)
})
it('shares the confirmed latest title with the conversion picker and overview preview',async()=>{
 const {jsonl,target}=await fixture();const options={offset:0,limit:50}
 expect((await pickerPage(jsonl,options)).sessions[0]?.title).toBe('Early 0')
 await pickerTitles(jsonl,new Set(['session-0']))
 expect((await pickerPage(jsonl,options)).sessions[0]?.title).toBe('Latest 0')
 expect((await inspectConsoleOverview(target,jsonl,undefined,{titles:false})).usage[0]).toMatchObject({title:'Latest 0',titlePending:false})
})
it('coalesces concurrent title reads and keeps another subscriber alive when one cancels',async()=>{
 const {jsonl}=await fixture();await pickerFiles(jsonl)
 const original=vi.mocked(readJsonlTitle).getMockImplementation()!
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve})
 vi.mocked(readJsonlTitle).mockImplementationOnce(async(...args)=>{await gate;return original(...args)})
 const abort=new AbortController(),one=pickerTitles(jsonl,new Set(['session-0']),abort.signal),two=pickerTitles(jsonl,new Set(['session-0']))
 // Wait until both subscribers have resolved their own selected-file stat.
 await vi.waitFor(()=>expect(vi.mocked(readJsonlTitle)).toHaveBeenCalled())
 abort.abort(new Error('page changed'));release()
 await expect(one).rejects.toThrow('page changed')
 expect((await two).get('session-0')?.title).toBe('Latest 0')
 expect(readJsonlTitle).toHaveBeenCalledTimes(1)
})
it('serves bounded exact identities through the common title route without overview scans',async()=>{
 const {jsonl,target}=await fixture();await pickerFiles(jsonl)
 const routes=new Map<string,(request:Request)=>Promise<Response>>()
 const ctx={connection:{fetch:{register:(route:{path:string;fetch:(request:Request)=>Promise<Response>})=>routes.set(route.path,route.fetch)}}} as unknown as Context
 registerConsole(ctx,{...target,jsonlRoot:jsonl})
 const route=routes.get('/api/session-optimizer/titles')!
 const request=(ids:unknown)=>new Request('http://localhost/api/session-optimizer/titles?ids='+encodeURIComponent(JSON.stringify(ids)))
 vi.mocked(stat).mockClear()
 expect((await route(request(Array(6).fill('session-0')))).status).toBe(400)
 expect(stat).not.toHaveBeenCalled()
 const answer=await route(request(['session-0','missing']))
 expect(answer.status).toBe(200)
 expect(await answer.json()).toEqual({titles:[{id:'session-0',title:'Latest 0',titlePending:false},{id:'missing',removed:true,titlePending:false}]})
 // Only the two requested identities may be touched. Asserted as a set of paths
 // rather than a raw call count: a repeat stat on the same artifact is harmless,
 // while a stat of an unselected artifact would mean an overview scan. Stats of a
 // root itself are not scans — that is how a route confirms the root it was handed
 // is one this machine offers — so the claim is about artifacts inside the root.
 const statted=vi.mocked(stat).mock.calls.map(call=>String(call[0]))
 const insideRoot=statted.filter(path=>path.startsWith(jsonl))
 expect(insideRoot.every(path=>path===jsonl||path.includes('session-0')||path.includes('missing'))).toBe(true)
 expect(statted.filter(path=>path.includes('session-0')).length).toBeGreaterThan(0)
})
it('shows the same quick title in both views while the latest title is pending',async()=>{
 const {jsonl,target}=await fixture()
 const page=await pickerPage(jsonl,{offset:0,limit:50})
 const overview=await inspectConsoleOverview(target,jsonl,undefined,{titles:false})
 expect(page.sessions[0]).toMatchObject({title:'Early 0',titlePending:true})
 expect(overview.usage[0]).toMatchObject({title:'Early 0',titlePending:true})
})
it('stops a shared reader after every subscriber cancels and permits a new request',async()=>{
 const {jsonl}=await fixture();await pickerFiles(jsonl)
 let stop:AbortSignal|undefined
 vi.mocked(readJsonlTitle).mockImplementationOnce(async(_path,_id,signal)=>{
  stop=signal
  return await new Promise((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true}))
 })
 const abort=new AbortController(),request=pickerTitles(jsonl,new Set(['session-0']),abort.signal)
 const failed=expect(request).rejects.toThrow('all closed')
 await vi.waitFor(()=>expect(stop).toBeDefined());abort.abort(new Error('all closed'));await failed
 expect(stop!.aborted).toBe(true)
 expect((await pickerTitles(jsonl,new Set(['session-0']))).get('session-0')?.title).toBe('Latest 0')
})
it('invalidates both views after append and omits deleted artifacts despite cached titles',async()=>{
 const {jsonl}=await fixture();await pickerTitles(jsonl,new Set(['session-0']))
 const path=join(jsonl,'project','session-0','session.v4.jsonl')
 await writeFile(path,JSON.stringify({type:'session',id:'session-0'})+'\n'+JSON.stringify({type:'session/title',data:{title:'Renamed'}})+'\n')
 expect((await pickerPage(jsonl,{offset:0,limit:50})).sessions[0]?.title).toBe('Renamed')
 await rm(path);expect((await pickerTitles(jsonl,new Set(['session-0']))).size).toBe(0)
})
