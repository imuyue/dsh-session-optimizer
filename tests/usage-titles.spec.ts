import { expect, it, vi, beforeEach } from 'vitest'
vi.mock('../client/api.ts',()=>({fetchSessionTitles:vi.fn()}))
import { fetchSessionTitles } from '../client/api.ts'
import { hydrateUsageTitles } from '../client/usage-titles.ts'
import type { Overview } from '../client/types.ts'
const fetch = vi.mocked(fetchSessionTitles)
const page = {usageOffset:50,usage:Array.from({length:12},(_,i)=>({id:'id-'+i,titlePending:true}))} as Overview
beforeEach(()=>{fetch.mockReset()})
it('hydrates current-page identities in at most two concurrent bounded batches',async()=>{
 let active=0,max=0
 fetch.mockImplementation(async(ids)=>{
  max=Math.max(max,++active); await Promise.resolve();active--
  return {titles:page.usage.filter(row=>ids.includes(row.id)).reverse().map(row=>({...row,title:'Title '+row.id,titlePending:false}))}
 })
 const rows:unknown[]=[]
 await hydrateUsageTitles(page,new AbortController().signal,value=>rows.push(...value))
 expect(max).toBe(2);expect(fetch).toHaveBeenCalledTimes(3);expect(rows).toHaveLength(12)
 expect(fetch.mock.calls.map(c=>c[0])).toEqual([0,5,10].map(start=>page.usage.slice(start,start+5).map(row=>row.id)))
 expect(rows.every(row=>(row as {titlePending:boolean}).titlePending===false)).toBe(true)
})
it('does not publish late titles after switching pages or cancelling',async()=>{
 const abort=new AbortController(), publish=vi.fn()
 fetch.mockImplementation(async()=>{await Promise.resolve();abort.abort(new Error('new page'));return {titles:[]}})
 await expect(hydrateUsageTitles(page,abort.signal,publish)).rejects.toThrow('new page')
 expect(publish).not.toHaveBeenCalled();expect(fetch.mock.calls.length).toBeLessThanOrEqual(2)
})
it('removes missing identities but keeps read failures explicit',async()=>{
 fetch.mockResolvedValue({titles:[]})
 const published:Array<{removed?:boolean;problem?:string;titlePending?:boolean}>=[]
 await hydrateUsageTitles(page,new AbortController().signal,rows=>published.push(...rows))
 expect(published).toHaveLength(12);expect(published.every(row=>row.removed===true&&row.titlePending===false)).toBe(true)
 fetch.mockRejectedValue(new Error('failed title read'))
 const failed:typeof published=[]
 await hydrateUsageTitles(page,new AbortController().signal,rows=>failed.push(...rows))
 expect(failed.every(row=>row.problem==='failed title read'&&row.removed!==true)).toBe(true)
})
it('never attaches a shifted or foreign session title to a deleted row',async()=>{
 const one={...page,usage:[page.usage[0]!]} as Overview
 fetch.mockResolvedValue({titles:[{...page.usage[1]!,title:'Other title'}]})
 const publish=vi.fn(); await hydrateUsageTitles(one,new AbortController().signal,publish)
 expect(publish).toHaveBeenCalledWith([expect.objectContaining({id:'id-0',removed:true})])
 expect(JSON.stringify(publish.mock.calls)).not.toContain('Other title')
})
