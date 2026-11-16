import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'

// Run the actual Windows marker algorithm in its own VM context. Only the OS
// selection and process liveness are controlled; filesystem operations are real.
// This does not claim to exercise Windows CreateFile/antivirus sharing behavior.
const require = createRequire(import.meta.url)
type Lease = { release(): Promise<void> }
function windowsMarker() {
  const source = readFileSync(new URL('../src/lease.ts', import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: Record<string, unknown> = {}
  runInNewContext(code, {
    exports, module: { exports },
    process: { pid: process.pid, platform: 'win32', kill(pid: number) {
      if (pid === process.pid) return
      throw Object.assign(new Error('fixture process is not alive'), { code: 'ESRCH' })
    } },
    require(name: string) {
      if (name === '@deepseek-ai/dsh-session-persistence') return { SessionAlreadyOwnedError }
      if (name === '@deepseek-ai/node-addon-system/flock') return { tryLockExclusive() { throw new Error('unexpected POSIX branch') } }
      return require(name)
    },
  })
  return exports.SessionWriteLease as { acquire(dir: string, id: string): Promise<Lease> }
}
const roots: string[] = []
async function root() { const dir = await mkdtemp(join(tmpdir(), 'win32-marker-')); roots.push(dir); return dir }
afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }) })
describe('Windows marker ownership algorithm', () => {
  it('does not reclaim a lease held by another writer in the same process', async () => {
    const dir = await root(), lease = windowsMarker()
    const first = await lease.acquire(dir, 'same-process')
    const before = await readFile(join(dir, 'session.lock'), 'utf8')
    let unexpected: Lease | undefined
    try {
      await expect(lease.acquire(dir, 'same-process').then(value => { unexpected = value; return value })).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
      expect(await readFile(join(dir, 'session.lock'), 'utf8')).toBe(before)
    } finally { await unexpected?.release(); await first.release() }
  })
  it('allows a new owner after normal release', async () => {
    const dir = await root(), lease = windowsMarker()
    const first = await lease.acquire(dir, 'released'); await first.release()
    const next = await lease.acquire(dir, 'released'); await next.release()
  })
  it('reclaims a marker only after a valid owner PID is known dead', async () => {
    const dir = await root(), lease = windowsMarker()
    await writeFile(join(dir, 'session.lock'), JSON.stringify({ pid: process.pid + 1000, startedAt: 1 }))
    const next = await lease.acquire(dir, 'dead'); await next.release()
  })
  it('preserves malformed and invalid-PID markers instead of treating them as dead owners', async () => {
    const dir = await root(), lease = windowsMarker()
    for (const text of ['', '{', '{}', '{"pid":-1}', '{"pid":0}', '{"pid":1.5}', '{"pid":2147483648}', '{"pid":null}']) {
      await writeFile(join(dir, 'session.lock'), text)
      let unexpected: Lease | undefined
      try {
        await expect(lease.acquire(dir, 'invalid').then(value => { unexpected = value; return value })).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
        expect(await readFile(join(dir, 'session.lock'), 'utf8')).toBe(text)
      } finally { await unexpected?.release() }
    }
  })
})
