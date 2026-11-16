import { describe,it,expect } from 'vitest'
import { unlinkSync } from 'node:fs'
import { mkdtemp,writeFile,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants, zstdCompressSync } from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { inspectJsonlArtifact,salvageJsonlArtifact } from '../src/transfer.ts'

describe('JSONL artifact decoder lifetime',()=>{
  async function fixture(bytes:Buffer,suffix='.zstd') {
    const dir=await mkdtemp(join(tmpdir(),'dso-decode-'))
    const path=join(dir,`session.v4.jsonl${suffix}`)
    await writeFile(path,bytes)
    return {path,close:()=>rm(dir,{recursive:true,force:true})}
  }
  it('reports an invalid compressed frame without an unhandled stream error',async()=>{
    const f=await fixture(Buffer.from('not a zstd frame'))
    try {
      const shape=await inspectJsonlArtifact(f.path)
      expect(shape?.contiguous).toBeUndefined()
      expect(shape?.problem).toMatch(/frame|decompress|zstd/i)
      expect(await salvageJsonlArtifact(f.path)).toBeUndefined()
      await new Promise(r=>setImmediate(r))
    }finally{await f.close()}
  })
  it('preserves UTF8, CRLF, concatenated frames and an unterminated last line',async()=>{
    const head={type:'session',id:'fixture',cwd:'C:/fixture',createdAt:1}
    const event={type:'session/title',seq:0,time:1,data:{title:'中文🙂'}}
    const first=zstdCompressSync(Buffer.from(JSON.stringify(head)+'\r\n'))
    const second=zstdCompressSync(Buffer.from(JSON.stringify(event)))
    for(const compressed of [false,true]){
      const f=await fixture(compressed?Buffer.concat([first,second]):Buffer.from(JSON.stringify(head)+'\r\n'+JSON.stringify(event)),compressed?'.zstd':'')
      try{
        const shape=await inspectJsonlArtifact(f.path)
        expect(shape?.contiguous).toBe(true)
        expect(shape?.title).toBe('中文🙂')
        expect(shape?.eventCount).toBe(1)
        expect((await salvageJsonlArtifact(f.path))?.events).toEqual([event])
      }finally{await f.close()}
    }
  })
  it('closes the file/decoder after an early invalid-JSON prefix without consuming the large tail',async()=>{
    const f=await fixture(zstdCompressSync(Buffer.from(JSON.stringify({type:'session',id:'fixture'})+'\ninvalid-json\n'+randomBytes(512*1024).toString('base64'))))
    try{
      const result=await salvageJsonlArtifact(f.path)
      expect(result?.events).toEqual([])
      expect(result?.problem).toContain('breaks after 0 events')
      await new Promise(r=>setImmediate(r))
    }finally{await f.close()}
  })
  for (const compressed of [false, true]) it(`reports a source removed before open (compressed=${compressed})`, async () => {
    const bytes=Buffer.from(JSON.stringify({type:'session',id:'fixture'})+'\n')
    const f=await fixture(compressed?zstdCompressSync(bytes):bytes,compressed?'.zstd':'')
    try {
      const reading=inspectJsonlArtifact(f.path)
      unlinkSync(f.path)
      const result=await reading
      expect(result?.contiguous).toBeUndefined()
      expect(result?.problem).toMatch(/ENOENT/)
      await new Promise(r=>setImmediate(r))
    } finally {await f.close()}
  })
  it('keeps a UTF8 character split between independently decoded frames and reads every later frame', async () => {
    const head=Buffer.from(JSON.stringify({type:'session',id:'fixture'})+'\n')
    const event=Buffer.from(JSON.stringify({type:'session/title',seq:0,data:{title:'中文🙂'}})+'\n')
    const cut=event.indexOf(Buffer.from('中'))+1
    const frames=[zstdCompressSync(head),zstdCompressSync(event.subarray(0,cut)),zstdCompressSync(event.subarray(cut))]
    for(let seq=1;seq<25;seq++) frames.push(zstdCompressSync(Buffer.from(JSON.stringify({type:'session/title',seq,data:{title:`tail-${seq}`}})+'\n')))
    const f=await fixture(Buffer.concat(frames))
    try {const shape=await inspectJsonlArtifact(f.path);expect(shape?.contiguous).toBe(true);expect(shape?.eventCount).toBe(25);expect(shape?.title).toBe('tail-24');expect((await salvageJsonlArtifact(f.path))?.events[0]).toEqual(JSON.parse(event.toString()))}finally{await f.close()}
  })
  it('rejects a damaged checksum and every structurally truncated frame prefix',async()=>{
    const bytes=zstdCompressSync(Buffer.from(JSON.stringify({type:'session',id:'fixture'})+'\n'),{params:{[constants.ZSTD_c_checksumFlag]:1}})
    const bad=Buffer.from(bytes);bad[bad.length-1]!^=1
    for(const data of [bad,...Array.from({length:bytes.length-1},(_,i)=>bytes.subarray(0,i+1))]) {
      const f=await fixture(data)
      try {const shape=await inspectJsonlArtifact(f.path);expect(shape?.contiguous).toBeUndefined();expect(shape?.problem).toBeTruthy()}finally{await f.close()}
    }
  })
  it('reports a truncated final compressed frame as incomplete instead of a successful full log',async()=>{
    const head=zstdCompressSync(Buffer.from(JSON.stringify({type:'session',id:'fixture'})+'\n'))
    const body=zstdCompressSync(Buffer.from(JSON.stringify({type:'session/title',seq:0,data:{title:'x'.repeat(10000)}})+'\n'))
    const f=await fixture(Buffer.concat([head,body.subarray(0,body.length-2)]))
    try{expect((await inspectJsonlArtifact(f.path))?.contiguous).toBeUndefined()}finally{await f.close()}
  })
})
