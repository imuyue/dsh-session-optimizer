import { expect, it } from 'vitest'
import { mergeOverview } from '../src/console-overview.ts'
import type { InspectOverview } from '../src/inspect.ts'
import type { SourceSession } from '../src/migrate.ts'
const sqlite: InspectOverview = { root: 'C:/sqlite', storageThread:'worker', applicationId:1,schemaVersion:2,journalMode:'wal',synchronous:'full',busyTimeoutMs:5000,sessions:1,ready:1,importing:0,damaged:0,events:10,databaseBytes:100,walBytes:20,checkedAt:1,rootMode:'0666',rootPrivate:undefined,usage:[{id:'both',title:'sql',eventCount:10,sizeBytes:100,walBytes:20,state:'ready',problem:undefined}] }
const row=(id:string,eventCount=5,problem?:string):SourceSession=>({id,eventCount,problem,sizeBytes:30,title:id,createdAt:1,path:'C:/jsonl/'+id,cwd:'C:/project'})
it('includes JSONL sessions, events, problems and physical storage space',()=>{
 const value=mergeOverview(sqlite,[row('old'),row('broken',2,'truncated')])
 expect(value).toMatchObject({sessions:3,events:17,databaseBytes:160,walBytes:20,ready:2,damaged:1,backends:{sqliteSessions:1,jsonlSessions:2,sqliteBytes:100,jsonlBytes:60}})
 expect(value.usage.map(x=>x.id)).toEqual(['both','broken','old'])
})
it('counts duplicate identities once but includes space for both physical copies',()=>{
 const value=mergeOverview(sqlite,[row('both',7)],{backendOf:()=> 'jsonl'})
 expect(value).toMatchObject({sessions:1,events:7,databaseBytes:130})
 expect(value.usage[0]).toMatchObject({id:'both',eventCount:7,sizeBytes:130,walBytes:20,title:'both'})
})
it('uses SQLite when the duplicate catalog route is absent or stale',()=>{
 expect(mergeOverview(sqlite,[row('both',7)]).events).toBe(10)
 expect(sqlite.databaseBytes).toBe(100)
 expect(sqlite.usage[0]!.sizeBytes).toBe(100)
})
