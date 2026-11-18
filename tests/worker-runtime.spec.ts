import { afterEach, describe, expect, it } from 'vitest'
import { getEnvironmentData, setEnvironmentData, Worker } from 'node:worker_threads'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { workerRuntimeExecArgv } from '../src/worker-runtime.ts'
const key = '@deepseek-ai/dsh-app-boot/profile-resolution'
const previous = getEnvironmentData(key)
afterEach(() => { setEnvironmentData(key, previous) })
describe('worker inherited runtime resolution', () => {
  it('keeps plain Node/type-transform startup independent of DSH', () => {
    setEnvironmentData(key, undefined)
    const args = ['--enable-source-maps']
    expect(workerRuntimeExecArgv(args, () => { throw new Error('must not resolve DSH') })).toEqual(args)
    expect(workerRuntimeExecArgv(args)).not.toBe(args)
  })
  it('resolves the Worker peer graph in the parent without a native bootstrap', () => {
    setEnvironmentData(key, { resolution: { linkedRoots: [] } })
    const requested: string[] = []
    const result = workerRuntimeExecArgv(['--enable-source-maps'], name => {
      requested.push(name)
      return `file:///host/${name}/index.js`
    })
    expect(requested).toEqual(['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-persistence'])
    expect(result[0]).toBe('--import')
    expect(result[2]).toBe('--enable-source-maps')
    const source = decodeURIComponent(result[1].slice('data:text/javascript,'.length))
    expect(source).toContain('registerHooks')
    expect(source).not.toContain('profile-resolution-bootstrap')
    expect(source).not.toContain('requireBuiltin')
  })
  it('surfaces unresolved peers before spawning a broken Worker', () => {
    setEnvironmentData(key, { resolution: { linkedRoots: [] } })
    expect(() => workerRuntimeExecArgv([], () => { throw new Error('host peer missing') })).toThrow('host peer missing')
  })
  it('loads detached peers through encoded URLs and keeps relative and builtin imports', async () => {
    setEnvironmentData(key, { resolution: { linkedRoots: [] } })
    const dir = await mkdtemp(join(tmpdir(), 'worker peers 中文 # % '))
    let worker: Worker | undefined
    try {
      await writeFile(join(dir, 'relative.mjs'), 'export const value = 41\n')
      await writeFile(join(dir, 'session.mjs'), "import { value } from './relative.mjs'; export { value };\n")
      await writeFile(join(dir, 'persistence.mjs'), "import { value } from '@deepseek-ai/dsh-session'; export const total = value + 1;\n")
      await writeFile(join(dir, 'entry.mjs'), "import {parentPort} from 'node:worker_threads'; import {basename} from 'node:path'; import {total} from '@deepseek-ai/dsh-session-persistence'; parentPort.postMessage([total,basename('/a/b')]);\n")
      const execArgv = workerRuntimeExecArgv([], name => pathToFileURL(join(dir, name.endsWith('persistence') ? 'persistence.mjs' : 'session.mjs')).href)
      worker = new Worker(pathToFileURL(join(dir, 'entry.mjs')), { execArgv })
      const answer = await new Promise<unknown>((resolve, reject) => {
        worker!.once('message', resolve)
        worker!.once('error', reject)
        worker!.once('exit', code => { if (code !== 0) reject(new Error(`worker exit ${code}`)) })
      })
      expect(answer).toEqual([42, 'b'])
    } finally {
      await worker?.terminate()
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })
})
