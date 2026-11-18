import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'

// Only the selected rename fails. Everything else, including SQLite/WAL and the
// write lease, is real. This models a Windows sharing error, not its OS kernel.
const fault = vi.hoisted(() => ({ from: '', to: '', hits: 0, restoreFrom: '', restoreTo: '', restoreHits: 0 }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: async (from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) => {
    if (String(from) === fault.from && String(to) === fault.to) {
      fault.hits++
      throw Object.assign(new Error('fixture: Windows sharing violation'), { code: 'EBUSY' })
    }
    if (String(from) === fault.restoreFrom && String(to) === fault.restoreTo) {
      fault.restoreHits++
      throw Object.assign(new Error('fixture: restoration sharing violation'), { code: 'EACCES' })
    }
    return actual.rename(from, to)
  } }
})
import { SessionDatabase } from '../src/database.ts'
import { publishDatabase, writeSqliteSession } from '../src/transfer.ts'

const settings = { journalMode: 'wal', synchronous: 'full', busyTimeoutMs: 1000 } as const
const roots: string[] = []
const header: SessionHeader = { version: 4, id: SessionId('publish-fixture'), createdAt: 1700000000000, cwd: '/work/publish-fixture', isSeeded: false, delegationDepth: 0 }
function title(name: string): SessionEvent {
  return { type: 'session/title', seq: 0, time: 1700000000001, data: { title: name, messageSeqs: [], source: { kind: 'user' } } } as SessionEvent
}
function diskTitle(path: string): unknown {
  const db = SessionDatabase.open(path, { ...settings, readOnly: true, repair: false })
  try { return (db.loadSession()?.events[0]?.data as { title?: string } | undefined)?.title } finally { db.close() }
}
afterEach(async () => {
  fault.from = ''; fault.to = ''; fault.hits = 0
  fault.restoreFrom = ''; fault.restoreTo = ''; fault.restoreHits = 0
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-publish-rollback-')); roots.push(base)
  const target = join(base, 'target', 'session.db'), staged = join(base, 'staged', 'session.db')
  await writeSqliteSession(target, { header, events: [], inheritedEventCount: 0 })
  const childCode = `
    import { SessionDatabase } from ${JSON.stringify(new URL('../src/database.ts', import.meta.url).href)};
    const db = SessionDatabase.open(${JSON.stringify(target)}, ${JSON.stringify(settings)});
    db.appendBatch(${JSON.stringify(header)}, [${JSON.stringify(title('old committed title'))}], true, 0);
    process.stdout.write(JSON.stringify(db.loadSession()?.events));
    process.kill(process.pid, 'SIGKILL');
  `
  const child = spawnSync(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', childCode], { encoding: 'utf8', timeout: 10000 })
  // Windows has no signals: `process.kill(pid, 'SIGKILL')` terminates the process
  // through `TerminateProcess`, so `signal` is null and only the status reports
  // the kill. The child's work is the point — it died after a committed append —
  // so the assertion is that it did not exit cleanly.
  if (process.platform === 'win32') {
    expect(child.signal, child.stderr).toBeNull()
    expect(child.status, child.stderr).not.toBe(0)
  } else {
    expect(child.signal, child.stderr).toBe('SIGKILL')
  }
  expect(JSON.parse(child.stdout)[0]?.data?.title).toBe('old committed title')
  // A fresh private writer dies only after a FULL committed append. No live
  // reader or writer holds the real WAL/SHM during the publication attempt.
  expect(existsSync(`${target}-wal`)).toBe(true)
  expect((await readFile(`${target}-wal`)).length).toBeGreaterThan(32)
  await writeSqliteSession(staged, { header, events: [title('new staged title')], inheritedEventCount: 0 })
  return { target, staged, main: await readFile(target), wal: await readFile(`${target}-wal`) }
}

it.each(['-wal', '-shm', '', 'staged'] as const)('preserves a committed WAL when rename fails at %s', async point => {
  const f = await fixture()
  fault.from = point === 'staged' ? f.staged : `${f.target}${point}`
  fault.to = point === 'staged' ? f.target : `${f.target}.replaced${point}`
  await expect(publishDatabase(f.staged, f.target)).rejects.toMatchObject({ code: 'EBUSY' })
  expect(fault.hits).toBe(1)
  const snapshot = {
    failurePoint: point, mainPresent: existsSync(f.target), walPresent: existsSync(`${f.target}-wal`),
    shmPresent: existsSync(`${f.target}-shm`), backupWalPresent: existsSync(`${f.target}.replaced-wal`),
  }
  expect(snapshot, JSON.stringify(snapshot)).toMatchObject({ mainPresent: true, walPresent: true, shmPresent: true, backupWalPresent: false })
  expect(await readFile(f.target)).toEqual(f.main)
  expect(await readFile(`${f.target}-wal`)).toEqual(f.wal)
  expect(existsSync(f.staged)).toBe(true)
  fault.from = ''; fault.to = ''
  expect(diskTitle(f.target)).toBe('old committed title')
})
it('reports both failures and preserves the backup when WAL restoration also fails', async () => {
  const f = await fixture()
  fault.from = `${f.target}-shm`; fault.to = `${f.target}.replaced-shm`
  fault.restoreFrom = `${f.target}.replaced-wal`; fault.restoreTo = `${f.target}-wal`
  const error: unknown = await publishDatabase(f.staged, f.target).then(() => undefined, value => value)
  expect(error).toBeInstanceOf(AggregateError)
  expect((error as AggregateError).errors).toMatchObject([{ code: 'EBUSY' }, { code: 'EACCES' }])
  expect(fault.hits).toBe(1); expect(fault.restoreHits).toBe(1)
  expect(await readFile(f.target)).toEqual(f.main)
  expect(await readFile(`${f.target}.replaced-wal`)).toEqual(f.wal)
  expect(existsSync(f.staged)).toBe(true)
  expect(existsSync(`${f.target}-wal`)).toBe(false)
})
it('publishes a complete replacement without the injected error', async () => {
  const f = await fixture()
  await publishDatabase(f.staged, f.target)
  expect(diskTitle(f.target)).toBe('new staged title')
  expect(existsSync(`${f.target}.replaced`)).toBe(false)
})
