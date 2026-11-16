import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { overlappingDirectories, sameDirectory } from '../src/path-identity.ts'
const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
async function fixture(){const root=await mkdtemp(join(tmpdir(),'dso-path-id-'));roots.push(root);return root}
it('keeps exact normalized paths compatible and does not invent identities for missing different roots',async()=>{
 const base=await fixture()
 expect(await sameDirectory(join(base,'missing'),join(base,'other','..','missing'))).toBe(true)
 expect(await sameDirectory(join(base,'missing'),join(base,'different'))).toBe(false)
})
it('recognizes directory symlinks/junctions but not unrelated directories or files',async()=>{
 const base=await fixture(), actual=join(base,'actual'), other=join(base,'other'), alias=join(base,'alias')
 await mkdir(actual);await mkdir(other);await writeFile(join(base,'file'),'fixture')
 await symlink(actual,alias,process.platform==='win32'?'junction':'dir')
 expect(await sameDirectory(actual,alias)).toBe(true)
 expect(await sameDirectory(actual,other)).toBe(false)
 expect(await sameDirectory(actual,join(base,'file'))).toBe(false)
})
it.runIf(process.platform!=='win32')('does not lowercase distinct paths on a case-sensitive filesystem',async()=>{
 const base=await fixture();await mkdir(join(base,'Store'));await mkdir(join(base,'store'))
 expect(await sameDirectory(join(base,'Store'),join(base,'store'))).toBe(false)
})
it('detects not-yet-created descendants through a parent alias',async()=>{
 const base=await fixture(), actual=join(base,'actual'), alias=join(base,'alias')
 await mkdir(actual);await symlink(actual,alias,process.platform==='win32'?'junction':'dir')
 expect(await overlappingDirectories(actual,join(alias,'new','store'))).toBe(true)
 expect(await overlappingDirectories(join(alias,'new','store'),actual)).toBe(true)
 expect(await overlappingDirectories(actual,alias)).toBe(true)
})
it('keeps similarly-prefixed siblings and case-sensitive siblings independent',async()=>{
 const base=await fixture();await mkdir(join(base,'store'));await mkdir(join(base,'store-other'))
 expect(await overlappingDirectories(join(base,'store'),join(base,'store-other'))).toBe(false)
 expect(await overlappingDirectories(join(base,'missing'),join(base,'missing-other'))).toBe(false)
 if(process.platform!=='win32'){
  await mkdir(join(base,'Store'))
  expect(await overlappingDirectories(join(base,'store'),join(base,'Store','new'))).toBe(false)
 }
})
it('blocks a descendant access path even when its symlink points outside the source',async()=>{
 const base=await fixture(), source=join(base,'source'), outside=join(base,'outside')
 await mkdir(source);await mkdir(outside)
 await symlink(outside,join(source,'shortcut'),process.platform==='win32'?'junction':'dir')
 expect(await overlappingDirectories(source,join(source,'shortcut','new-store'))).toBe(true)
 expect(await overlappingDirectories(source,outside)).toBe(false)
})
