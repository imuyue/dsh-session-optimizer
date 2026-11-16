import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionDatabase, ensureSessionDirectory, type SqliteSettings } from '../src/database.ts'
import { databasePath } from '../src/format.ts'
import { PreviewReader } from '../src/history-preview.ts'

const SETTINGS: SqliteSettings = { journalMode: 'wal', synchronous: 'full', busyTimeoutMs: 5000 }
const roots: string[] = []
const readers: PreviewReader[] = []
async function fixture(options: { missingSeal?: boolean; replace?: boolean; source?: boolean; parent?: boolean; long?: boolean; turns?: number; giant?: boolean; wide?: boolean; seeded?: boolean; inherited?: number; depth?: number; noCompact?: boolean; toolSource?: boolean; toolReplace?: boolean; ignoredType?: string; corruptSeal?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-preview-'))
  roots.push(root)
  const id = SessionId('preview-session')
  const header: SessionHeader = { version: 4, id, createdAt: 1700000000000, cwd: '/preview', isSeeded: options.seeded ?? false, delegationDepth: options.depth ?? 0, ...(options.parent ? { parentSession: SessionId('parent') } : {}) }
  const events: SessionEvent[] = []
  const push = (event: object) => events.push({ ...event, seq: events.length, time: 1700000000000 + events.length } as SessionEvent)
  for (let turn = 1; turn <= (options.turns ?? (options.long ? 15 : 1)); turn++) {
    push({ type: 'turn/start', data: { turn } })
    push({ type: 'user/message', surfaceOp: options.replace ? { op: 'replace', startSeq: 0, endSeq: 0 } : 'append', ...(options.source ? { sourceEventSeqs: [0] } : {}), data: { id: `u${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: options.giant ? 'q'.repeat(3 * 1024 * 1024) : options.wide ? 'q'.repeat(7000) : options.long ? 'q'.repeat(2500) : 'plain question' }, { type: 'image', data: 'image-secret' }] } })
    push({ type: 'step/start', data: { turn, step: 1 } })
    push({ type: 'assistant/message', surfaceOp: 'append', data: { turn, step: 1, message: { id: `a${turn}`, role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' }, content: [{ type: 'text', text: options.wide ? 'a'.repeat(10000) : options.long ? 'a'.repeat(3000) : 'plain answer' }, { type: 'thinking', text: 'private reasoning' }, { type: 'tool-call', name: 'exec', arguments: 'tool-secret' }] }, stream: [] } })
    if (options.toolSource || options.toolReplace) {
      const sourceSeq = events.length - 1
      push({ type: 'tool/result', surfaceOp: options.toolReplace ? { op: 'replace', startSeq: 0, endSeq: 0 } : 'append', sourceEventSeqs: [sourceSeq], data: {
        turn, step: 1, message: { id: `r${turn}`, role: 'tool', toolCallId: `c${turn}`, source: { kind: 'tool', callId: `c${turn}` }, content: [{ type: 'text', text: 'private tool result' }] },
      } })
    }
    push({ type: 'step/end', data: { turn, step: 1 } })
    push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  if (options.ignoredType) push({ type: options.ignoredType, ignorable: true, data: {} })
  const path = databasePath(root, header.cwd!, id)
  ensureSessionDirectory(dirname(path))
  const db = SessionDatabase.open(path, { ...SETTINGS, ...(options.noCompact ? { seal: false } : {}) })
  try { db.appendImported(header, events, options.inherited ?? 0); db.markReady(); if (!options.noCompact && (options.turns || options.giant)) db.compact() } finally { db.close() }
  if (options.missingSeal || options.corruptSeal) {
    const raw = new DatabaseSync(path)
    try { raw.exec(options.missingSeal ? 'DELETE FROM session_seal' : "UPDATE session_seal SET checksum = 'corrupt'") } finally { raw.close() }
  }
  return { root, id, path }
}
function reader(root: string, timeout = 1500) {
  const value = new PreviewReader(root, SETTINGS, timeout)
  readers.push(value)
  return value
}
afterEach(async () => {
  await Promise.all(readers.splice(0).map(r => r.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('bounded read-only loading preview', () => {
  it('reads actual trusted SQLite events as ordinary text, without tool or reasoning payloads', async () => {
    const { root, id } = await fixture()
    const answer = await reader(root).read(id)
    expect(answer.available).toBe(true)
    if (!answer.available) return
    expect(answer.sessionId).toBe(id)
    expect(answer.messages.map(m => [m.seq, m.role, m.text])).toEqual([[1, 'user', 'plain question'], [3, 'assistant', 'plain answer']])
    expect(answer).toMatchObject({ from: 0, to: 6, total: 6 })
    expect(answer.messages.every(message => message.seq >= answer.from && message.seq < answer.to)).toBe(true)
    expect(JSON.stringify(answer)).not.toContain('secret')
    expect(JSON.stringify(answer)).not.toContain('private reasoning')
  })

  it('bounds message count and each text before crossing the worker boundary', async () => {
    const { root, id } = await fixture({ long: true })
    const answer = await reader(root).read(id)
    expect(answer.available).toBe(true)
    if (!answer.available) return
    expect(answer.messages).toHaveLength(20)
    expect(answer.messages.every(m => m.text.length <= 2000)).toBe(true)
    expect(answer.messages.reduce((n, m) => n + m.text.length, 0)).toBeLessThanOrEqual(40000)
    expect(answer.messages[0].seq).toBeGreaterThan(1)
  })

  it('reads only the suffix of a larger framed database with exclusive absolute sequence bounds', async () => {
    const { root, id, path } = await fixture({ long: true, turns: 200 })
    const raw = new DatabaseSync(path, { readOnly: true })
    try { expect(Number(raw.prepare('SELECT count(*) AS n FROM event_chunk').get()!.n)).toBeGreaterThan(1) } finally { raw.close() }
    const answer = await reader(root).read(id)
    expect(answer.available).toBe(true)
    if (!answer.available) return
    expect(answer).toMatchObject({ from: 432, to: 1200, total: 1200 })
    expect(answer.messages).toHaveLength(20)
    expect(answer.messages[0].seq).toBeGreaterThan(432)
  })

  it('shrinks an over-budget large-text suffix without enlarging its byte allowance', async () => {
    const { root, id, path } = await fixture({ wide: true, turns: 200 })
    const answer = await reader(root).read(id)
    expect(answer.available).toBe(true)
    if (!answer.available) return
    expect(answer.total).toBe(1200)
    expect(answer.to - answer.from).toBeLessThan(768)
    expect(answer.to - answer.from).toBeGreaterThanOrEqual(48)
    expect(answer.messages).toHaveLength(20)
    const db = SessionDatabase.open(path, { ...SETTINGS, readOnly: true, repair: false })
    try {
      const complete = db.loadSession()!
      for (const message of answer.messages) {
        const event = complete.events[message.seq]!
        expect(event.type).toBe(message.role === 'user' ? 'user/message' : 'assistant/message')
      }
      expect(complete.events).toHaveLength(1200)
    } finally { db.close() }
  })

  it('declines oversized header metadata before materializing JSON', async () => {
    const { root, id, path } = await fixture()
    const raw = new DatabaseSync(path)
    try { raw.prepare("UPDATE session SET header_json = json_set(header_json, '$.previewOversize', ?) WHERE singleton = 1").run('x'.repeat(300 * 1024)) } finally { raw.close() }
    expect(await reader(root).read(id)).toMatchObject({ available: false })
  })

  it('limits actual decompression even when frame raw_bytes understates its payload', async () => {
    const { root, id, path } = await fixture({ giant: true })
    const raw = new DatabaseSync(path)
    try { raw.exec('UPDATE event_chunk SET raw_bytes = 64') } finally { raw.close() }
    expect(await reader(root).read(id)).toMatchObject({ available: false })
  })

  it('declines a giant compressed frame before trying an unbounded full-log fallback', async () => {
    const { root, id } = await fixture({ giant: true })
    expect(await reader(root).read(id)).toEqual({ available: false, reason: 'unavailable' })
  })

  it('accepts a sealed materialized seed with local history and parent provenance', async () => {
    const { root, id } = await fixture({ seeded: true, parent: true })
    const answer = await reader(root).read(id)
    expect(answer.available).toBe(true)
    if (answer.available) expect(answer.messages.map(m => m.text)).toEqual(['plain question', 'plain answer'])
  })

  it.each([{ inherited: 1 }, { depth: 1 }])('declines a nonmaterialized or delegated seed %j', async branch => {
    const { root, id } = await fixture({ seeded: true, parent: true, ...branch })
    expect(await reader(root).read(id)).toMatchObject({ available: false })
  })

  it('ignores append tool-result provenance without exposing its content', async () => {
    const { root, id } = await fixture({ seeded: true, parent: true, toolSource: true })
    const answer = await reader(root).read(id)
    expect(answer.available).toBe(true)
    if (answer.available) expect(answer.messages.map(m => m.text)).toEqual(['plain question', 'plain answer'])
    expect(JSON.stringify(answer)).not.toContain('private tool result')
  })

  it('still declines a replacement on an ignored tool result', async () => {
    const { root, id } = await fixture({ toolReplace: true })
    expect(await reader(root).read(id)).toMatchObject({ available: false })
  })

  it.each(['image/offload', 'feedback/message-put', 'plugin/message-update'])('declines a potential visible-message mutation %s', async ignoredType => {
    const { root, id } = await fixture({ ignoredType })
    expect(await reader(root).read(id)).toMatchObject({ available: false })
  })

  it('declines a corrupt seal on a materialized seed', async () => {
    const { root, id } = await fixture({ seeded: true, parent: true, corruptSeal: true })
    expect(await reader(root).read(id)).toMatchObject({ available: false })
  })

  it('allows a bounded window from a sealed uncompressed tail above the old 16384-event cap', async () => {
    const { root, id, path } = await fixture({ seeded: true, parent: true, turns: 2731, noCompact: true })
    const raw = new DatabaseSync(path, { readOnly: true })
    try { expect(raw.prepare('SELECT count(*) AS n FROM session_event').get()!.n).toBe(16386) } finally { raw.close() }
    const answer = await reader(root).read(id)
    expect(answer.available).toBe(true)
    if (answer.available) expect(answer).toMatchObject({ from: 15618, to: 16386, total: 16386 })
  })

  it('stops before seal scanning when raw tail metadata exceeds 100000 rows', async () => {
    const { path } = await fixture()
    const raw = new DatabaseSync(path)
    try {
      raw.exec(`WITH RECURSIVE extra(seq) AS (VALUES(6) UNION ALL SELECT seq + 1 FROM extra WHERE seq < 100000)
        INSERT INTO session_event(seq, event_type, event_time_ms, event_json)
        SELECT seq, 'turn/start', 0, '{}' FROM extra`)
    } finally { raw.close() }
    const db = SessionDatabase.open(path, { ...SETTINGS, readOnly: true, repair: false })
    const proof = vi.spyOn(db, 'trustedLength')
    try {
      expect(db.loadPreviewWindow()).toBeUndefined()
      expect(proof).not.toHaveBeenCalled()
    } finally { proof.mockRestore(); db.close() }
  })

  it.each([{ missingSeal: true }, { replace: true }, { source: true }, { parent: true }])('declines unproved data %j without a full-log fallback', async options => {
    const { root, id } = await fixture(options)
    expect(await reader(root).read(id)).toEqual({ available: false, reason: 'unavailable' })
  })

  it('declines missing and duplicate paths', async () => {
    const { root, id } = await fixture()
    expect(await reader(root).read('missing')).toEqual({ available: false, reason: 'unavailable' })
    const second = databasePath(root, '/another-project', id)
    ensureSessionDirectory(dirname(second))
    const duplicate = SessionDatabase.open(second, SETTINGS)
    try { duplicate.appendImported({ version: 4, id, cwd: '/another-project', createdAt: 1, isSeeded: false }, [], 0); duplicate.markReady() } finally { duplicate.close() }
    expect(await reader(root).read(id)).toEqual({ available: false, reason: 'unavailable' })
  })

  it('does not queue work while another worker is active', async () => {
    const { root, id } = await fixture()
    const value = reader(root)
    const first = value.read(id)
    expect(await value.read(id)).toEqual({ available: false, reason: 'busy' })
    expect((await first).available).toBe(true)
  })

  it('settles aborts once and ignores later worker results', async () => {
    const { root, id } = await fixture()
    const value = reader(root)
    const abort = new AbortController()
    const pending = value.read(id, abort.signal)
    abort.abort()
    expect(await pending).toEqual({ available: false, reason: 'aborted' })
    await value.close()
    expect(await value.read(id)).toEqual({ available: false, reason: 'disposed' })
  })

  it('declines pre-aborted requests without launching work', async () => {
    const { root, id } = await fixture()
    const abort = new AbortController()
    abort.abort()
    expect(await reader(root).read(id, abort.signal)).toEqual({ available: false, reason: 'aborted' })
  })

  it('terminates actual worker work at its deadline', async () => {
    const { root, id } = await fixture()
    expect(await reader(root, 1).read(id)).toEqual({ available: false, reason: 'timeout' })
  })

  it('idempotently disposes active work and settles its caller', async () => {
    const { root, id } = await fixture()
    const value = reader(root)
    const pending = value.read(id)
    value.dispose()
    value.dispose()
    expect(await pending).toEqual({ available: false, reason: 'disposed' })
    await value.close()
  })
})
