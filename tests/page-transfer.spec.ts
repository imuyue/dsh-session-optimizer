import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionDatabase, ensureSessionDirectory, type LoadedHeader, type LogPage, type SqliteSettings } from '../src/database.ts'
import { InlineExecutor, assemblePaged } from '../src/executor.ts'
import { WorkerExecutor } from '../src/worker-client.ts'
import { databasePath } from '../src/format.ts'
import { SqliteSessionPersistence } from '../src/index.ts'
import { SqliteBackendTracker } from '../src/storage.ts'
import { registerPageTransferPolicy } from '../src/page-transfer.ts'
import * as policy from '../src/page-transfer.ts'

const SETTINGS: SqliteSettings = { journalMode: 'wal', synchronous: 'full', busyTimeoutMs: 5000, readOnly: true, repair: false }
const roots: string[] = [], cleanup: Array<() => void | Promise<void>> = []
async function fixture(turns = 1, compressed = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-page-wire-')); roots.push(root)
  const id = SessionId('page-wire-test')
  const header: SessionHeader = { version: 4, id, createdAt: 1700000000000, cwd: join(root, 'work'), isSeeded: false }
  const events: SessionEvent[] = []
  const push = (event: object) => events.push({ ...event, seq: events.length, time: 1700000000000 + events.length } as SessionEvent)
  for (let turn = 1; turn <= turns; turn++) {
    push({ type: 'turn/start', data: { turn } })
    push({ type: 'user/message', surfaceOp: 'append', data: { id: `u${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '测试 😀 ASCII '.repeat(80) }] } })
    push({ type: 'step/start', data: { turn, step: 1 } })
    push({ type: 'assistant/message', surfaceOp: 'append', data: { turn, step: 1, message: { id: `a${turn}`, role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'answer 中文 '.repeat(80) }] }, stream: [] } })
    push({ type: 'step/end', data: { turn, step: 1 } })
    push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  const path = databasePath(root, header.cwd!, id); ensureSessionDirectory(dirname(path))
  const db = SessionDatabase.open(path, { ...SETTINGS, readOnly: false, seal: false })
  try { db.appendImported(header, events, 0); db.markReady(); if (compressed) db.compact() } finally { db.close() }
  const read = SessionDatabase.open(path, SETTINGS)
  let meta: LoadedHeader
  try { meta = read.pagedHeader()!; expect(meta).toBeDefined() } finally { read.close() }
  return { root, id, path, events, meta }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const f of cleanup.splice(0).reverse()) await f()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('raw JSON page wire', () => {
  it.each([false, true])('preserves every raw row and envelope for row/framed layout (compressed=%s)', async compressed => {
    const f = await fixture(300, compressed), db = SessionDatabase.open(f.path, SETTINGS)
    try {
      const bytes = db.readPageBytes(1, 1700)!, lines = db.readPageBytes(1, 1700, 'lines')!
      expect(bytes.format).not.toBe('lines'); expect(lines.format).toBe('lines')
      if (bytes.format === 'lines' || lines.format !== 'lines') return
      expect(lines.lines.map(s => JSON.parse(s))).toEqual(f.events.slice(1, 1700))
      expect(new TextDecoder().decode(bytes.bytes).split('\n')).toEqual(lines.lines)
      expect(db.readPageBytes(6, 6, 'lines')).toEqual({ firstSeq: 6, count: 0, format: 'lines', lines: [] })
      expect(db.readPageBytes(0, 6, 'bad' as never)).toBeUndefined()
      expect(db.readPageBytes(0, 99999, 'lines')).toBeUndefined()
    } finally { db.close() }
  })

  it('automatically returns the old byte wire when string budget declines', async () => {
    const f = await fixture(), db = SessionDatabase.open(f.path, SETTINGS)
    try {
      vi.spyOn(policy, 'pageLinesWithinBudget').mockReturnValue(false)
      const page = db.readPageBytes(0, 6, 'lines')!
      expect(page.format).not.toBe('lines')
      if (page.format !== 'lines') expect(JSON.parse(new TextDecoder().decode(page.bytes).split('\n')[0]!)).toEqual(f.events[0])
    } finally { db.close() }
  })

  it.each(['inline', 'worker'] as const)('uses actual %s replies in both modes, accepts in-flight lines after disable, and defaults back on unload', async kind => {
    const f = await fixture(300, true)
    const exec = kind === 'worker' ? new WorkerExecutor(1) : new InlineExecutor(1)
    cleanup.push(() => exec.close())
    expect((await exec.readPage(f.path, SETTINGS, 0, 6))?.format).not.toBe('lines')
    let enabled = true
    const off = registerPageTransferPolicy(() => enabled); cleanup.push(off)
    const first = await exec.readPage(f.path, SETTINGS, 0, 6)
    expect(first?.format).toBe('lines')
    const inflight = Promise.resolve(exec.readPage(f.path, SETTINGS, 0, f.events.length))
    enabled = false
    const oldReply = await inflight
    expect(oldReply?.format).toBe('lines')
    const assembled = await assemblePaged(f.path, f.meta, async () => oldReply, undefined)
    expect(assembled?.events).toEqual(f.events)
    expect((await exec.readPage(f.path, SETTINGS, 0, 6))?.format).not.toBe('lines')
    enabled = true
    expect((await exec.loadSessionPaged(f.path, SETTINGS))?.events).toEqual(f.events)
    off()
    expect((await exec.readPage(f.path, SETTINGS, 0, 6))?.format).not.toBe('lines')
    expect((await exec.loadSessionPaged(f.path, SETTINGS))?.events).toEqual(f.events)
  })

  it.each([
    { name: 'missing', page: undefined },
    { name: 'wrong sequence', page: { firstSeq: 1, count: 6, format: 'lines', lines: [] } },
    { name: 'wrong count', page: { firstSeq: 0, count: 5, format: 'lines', lines: [] } },
    { name: 'unknown wire', page: { firstSeq: 0, count: 6, format: 'future', bytes: new Uint8Array(0) } },
    { name: 'two payloads', page: { firstSeq: 0, count: 6, format: 'lines', lines: [], bytes: new Uint8Array(0) } },
    { name: 'bad line type', page: { firstSeq: 0, count: 6, format: 'lines', lines: [1, 2, 3, 4, 5, 6] } },
    { name: 'malformed JSON', page: { firstSeq: 0, count: 6, format: 'lines', lines: ['{', '{}', '{}', '{}', '{}', '{}'] } },
  ])('declines $name pages so the caller can use the original fallback', async ({ page }) => {
    const f = await fixture()
    expect(await assemblePaged(f.path, f.meta, async () => page as LogPage | undefined, undefined)).toBeUndefined()
  })

  it('continues to validate every parsed event including its absolute sequence', async () => {
    const f = await fixture()
    const lines = f.events.map(e => JSON.stringify(e)); lines[1] = JSON.stringify({ ...f.events[1], seq: 100 })
    expect(await assemblePaged(f.path, f.meta, async () => ({ firstSeq: 0, count: 6, format: 'lines', lines }), undefined)).toBeUndefined()
    lines[1] = JSON.stringify({ ...f.events[1], type: 'future/unsupported' })
    await expect(assemblePaged(f.path, f.meta, async () => ({ firstSeq: 0, count: 6, format: 'lines', lines }), undefined)).rejects.toThrow()
  })

  it('cancels before posting work and after a pending final page resolves', async () => {
    const f = await fixture(), before = new AbortController(), read = vi.fn()
    before.abort(new Error('cancel before'))
    await expect(assemblePaged(f.path, f.meta, read, before.signal)).rejects.toThrow('cancel before')
    expect(read).not.toHaveBeenCalled()
    const pending = new AbortController(); let finish!: (v: LogPage) => void
    const result = assemblePaged(f.path, f.meta, () => new Promise(resolve => { finish = resolve }), pending.signal)
    pending.abort(new Error('cancel pending'))
    finish({ firstSeq: 0, count: 6, format: 'lines', lines: f.events.map(e => JSON.stringify(e)) })
    await expect(result).rejects.toThrow('cancel pending')
  })

  it('rechecks policy after three-page prefetch and accepts a mixed wire log after disabling', async () => {
    const f = await fixture(), total = 30000
    let enabled = true
    cleanup.push(registerPageTransferPolicy(() => enabled))
    const base = f.events.map(e => JSON.parse(JSON.stringify(e)) as SessionEvent)
    for (const e of base) {
      if (e.type === 'user/message') e.data.content = [{ type: 'text', text: 'u' }]
      if (e.type === 'assistant/message') e.data.message.content = [{ type: 'text', text: 'a' }]
    }
    const formats: string[] = []
    let finishFirst!: () => void
    const result = assemblePaged(f.path, { ...f.meta, eventCount: total }, (from, to) => {
      const format = policy.currentPageTransferFormat(); formats.push(format)
      const lines = Array.from({ length: to - from }, (_, index) => {
        const seq = from + index, original = base[seq % 6]!
        return JSON.stringify({ ...original, seq, time: 1700000000000 + seq, data: { ...original.data, turn: Math.floor(seq / 6) + 1 } })
      })
      const page: LogPage = format === 'lines' ? { firstSeq: from, count: to - from, format, lines }
        : { firstSeq: from, count: to - from, bytes: new TextEncoder().encode(lines.join('\n')) }
      return from === 0 ? new Promise(resolve => { finishFirst = () => resolve(page) }) : Promise.resolve(page)
    }, undefined)
    expect(formats).toEqual(['lines', 'lines', 'lines'])
    enabled = false
    finishFirst()
    const loaded = await result
    expect(formats).toEqual(['lines', 'lines', 'lines', 'bytes'])
    expect(loaded?.events).toHaveLength(total)
    expect(loaded?.events.at(-1)?.seq).toBe(total - 1)
  })

  it('takes the actual persistence full-read fallback when a page is absent', async () => {
    const f = await fixture(260), ctx = new Context()
    const p = new SqliteSessionPersistence(ctx, { root: f.root, ...SETTINGS, storageThread: 'inline', writeBatchMaxDelayMs: 0, preparedSessionCacheSize: 1, jsonlRoot: '' }, new SqliteBackendTracker('page-fallback'))
    cleanup.push(async () => { await p.closeStorage(); await ctx.fiber.dispose() })
    cleanup.push(registerPageTransferPolicy(() => true))
    vi.spyOn(SessionDatabase.prototype, 'readPageBytes').mockReturnValue(undefined)
    const fallback = vi.spyOn(SessionDatabase.prototype, 'loadSession')
    const handle = await p.open(f.id, 'read')
    expect(handle).toBeDefined()
    try { expect((await handle!.read(0)).events).toEqual(f.events); expect(fallback).toHaveBeenCalled() } finally { await handle!.close() }
  })

  it('uses the original torn-prefix diagnostic after a malformed raw JSON row', async () => {
    const f = await fixture(260), raw = new DatabaseSync(f.path)
    try { raw.exec('PRAGMA ignore_check_constraints = ON'); raw.prepare('UPDATE session_event SET event_json = ? WHERE seq = ?').run('{', 1000) } finally { raw.close() }
    const exec = new InlineExecutor(1); cleanup.push(() => exec.close()); cleanup.push(registerPageTransferPolicy(() => true))
    expect(await exec.loadSessionPaged(f.path, SETTINGS)).toBeUndefined()
    const fallback = await exec.loadSession(f.path, SETTINGS)
    expect(fallback?.tornTruncateTo).toBe(1000)
    expect(fallback?.events).toEqual(f.events.slice(0, 1000))
  })
})
