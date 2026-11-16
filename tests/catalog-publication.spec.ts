import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SessionBackendCatalog } from '../src/catalog.ts'
const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50})})
async function setup(){const root=await mkdtemp(join(tmpdir(),'dso-catalog-commit-'));roots.push(root);const c=await SessionBackendCatalog.open(root);c.route('session-a','jsonl',{originSessionId:'original'},1);await c.save();return c}
it('keeps the prior route visible until the atomic write finishes',async()=>{
 const c=await setup(),before=c.get('session-a')
 const committing=c.commitRoute('session-a','sqlite',{migrationId:'new-migration'},2)
 expect(c.get('session-a')).toBe(before)
 const committed=await committing
 expect(c.get('session-a')).toBe(committed)
 expect((await SessionBackendCatalog.open(dirname(c.location))).get('session-a')).toEqual(committed)
 expect((await readdir(dirname(c.location))).filter(n=>n.endsWith('.tmp'))).toEqual([])
})
it('preserves a different-id mutation and a save queued during commit',async()=>{
 const c=await setup(),committing=c.commitRoute('session-a','sqlite')
 c.route('session-other','jsonl',{migrationId:'other'})
 await Promise.all([committing,c.save()])
 const reopened=await SessionBackendCatalog.open(dirname(c.location))
 expect(reopened.list()).toEqual(c.list());expect(reopened.backendOf('session-a')).toBe('sqlite');expect(reopened.backendOf('session-other')).toBe('jsonl')
})
it('rejects same-id supersession without overwriting or persisting over the newer entry',async()=>{
 const c=await setup(),committing=c.commitRoute('session-a','sqlite',{migrationId:'obsolete'})
 const newer=c.route('session-a','jsonl',{migrationId:'newer'},3)
 await expect(committing).rejects.toThrow('changed during migration commit')
 expect(c.get('session-a')).toBe(newer)
 expect((await SessionBackendCatalog.open(dirname(c.location))).get('session-a')).toEqual(newer)
})
it('does not resurrect a route forgotten while a proposed entry was being written',async()=>{
 const c=await setup(),committing=c.commitRoute('session-a','sqlite')
 c.forget('session-a')
 await expect(committing).rejects.toThrow('changed during migration commit')
 expect(c.get('session-a')).toBeUndefined();expect((await SessionBackendCatalog.open(dirname(c.location))).get('session-a')).toBeUndefined()
})
it('serializes independent durable commits and preserves their provenance',async()=>{
 const c=await setup()
 await Promise.all(Array.from({length:20},(_,i)=>c.commitRoute(`session-${i}`,'sqlite',{migrationId:`m-${i}`},i+10)))
 const reopened=await SessionBackendCatalog.open(dirname(c.location))
 expect(reopened.list()).toEqual(c.list());expect(reopened.size).toBe(21)
 for(let i=0;i<20;i++)expect(reopened.get(`session-${i}`)?.migrationId).toBe(`m-${i}`)
})
it('does not let two competing commits of the same identity silently replace one another',async()=>{
 const c=await setup()
 const outcomes=await Promise.allSettled([c.commitRoute('session-a','sqlite',{migrationId:'first'}),c.commitRoute('session-a','jsonl',{migrationId:'second'})])
 expect(outcomes.map(v=>v.status)).toEqual(['fulfilled','rejected'])
 expect(c.get('session-a')?.migrationId).toBe('first')
 expect(JSON.parse(await readFile(c.location,'utf8')).sessions['session-a']).toEqual(c.get('session-a'))
})
