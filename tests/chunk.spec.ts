/**
 * Chunked storage: what a sealed frame must preserve.
 *
 * Compressing a log moves rows out of `session_event` into opaque frames, so
 * every guarantee the log made before now depends on four things: the frame set
 * reconstructs the same events, a window can still be cut at any seq, a
 * truncation can still cut through the middle of a frame, and an append still
 * continues where the log ended. Each is a separate test because each fails
 * silently: a log that loses its last events still opens, and a window read that
 * silently skips a frame still returns plausible looking events.
 *
 * @module dsh-session-optimizer/tests/chunk
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants as zlibConstants, zstdCompressSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionDatabase, ensureSessionDirectory, type SqliteSettings } from '../src/database.ts'
import { CHUNK_BYTES, decodeChunkLines, encodeChunk } from '../src/chunk.ts'
import { databasePath } from '../src/format.ts'

const SETTINGS: SqliteSettings = { journalMode: 'wal', synchronous: 'full', busyTimeoutMs: 5000 }

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-chunk-'))
  roots.push(root)
  return root
}

function headerOf(id: string, cwd = '/work/chunk'): SessionHeader {
  return {
    version: 4,
    id: id as SessionId,
    createdAt: 1_700_000_000_000,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
  }
}

/**
 * A log long enough to need frames, in the shape the released format accepts:
 * a turn opens, one user message carries most of the weight, a step produces the
 * reply, and the turn closes. `turns` × `textBytes` decides the file size.
 */
function longLog(turns: number, textBytes = 40_000, startSeq = 0, startTurn = 1): SessionEvent[] {
  const events: SessionEvent[] = []
  let seq = startSeq
  for (let index = 0; index < turns; index += 1) {
    const turn = startTurn + index
    const text = `${String(turn)}:`.padEnd(textBytes, 'x')
    events.push({ type: 'turn/start', seq, time: seq, data: { turn } } as never)
    seq += 1
    events.push({
      type: 'user/message',
      seq,
      time: seq,
      data: {
        id: `msg-user-${String(turn)}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      },
      surfaceOp: 'append',
    } as never)
    seq += 1
    events.push({ type: 'step/start', seq, time: seq, data: { turn, step: 1 } } as never)
    seq += 1
    events.push({
      type: 'assistant/message',
      seq,
      time: seq,
      data: {
        turn,
        step: 1,
        message: {
          id: `msg-assistant-${String(turn)}`,
          role: 'assistant',
          content: [{ type: 'text', text: 'ack' }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        },
        stream: [
          { type: 'chunk', time: seq, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
          { type: 'text-chunks', time0: seq, index: 0, dt: [], texts: ['ack'] },
          { type: 'chunk', time: seq, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'ack' } } },
          { type: 'chunk', time: seq, chunk: { type: 'finish', reason: { kind: 'stop' } } },
        ],
      },
      surfaceOp: 'append',
    } as never)
    seq += 1
    events.push({ type: 'step/end', seq, time: seq, data: { turn, step: 1 } } as never)
    seq += 1
    events.push({
      type: 'turn/end',
      seq,
      time: seq,
      data: { turn, reason: { kind: 'completed' } },
    } as never)
    seq += 1
  }
  return events
}

/** Write one store through the engine, letting `appendImported` seal it. */
function seed(root: string, id: string, events: readonly SessionEvent[]): string {
  const path = databasePath(root, '/work/chunk', id as SessionId)
  ensureSessionDirectory(join(path, '..'))
  const db = SessionDatabase.open(path, SETTINGS)
  try {
    db.appendImported(headerOf(id), events, 0)
    db.markReady()
  } finally {
    db.close()
  }
  return path
}

function layoutOf(path: string): {
  frames: number
  rows: number
  sealedEnd: number
  eventCount: number
  version: number
} {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const frames = db.prepare('SELECT count(*) AS n FROM event_chunk').get() as { n: number }
    const rows = db.prepare('SELECT count(*) AS n FROM session_event').get() as { n: number }
    const end = db.prepare('SELECT coalesce(max(last_seq) + 1, 0) AS n FROM event_chunk').get() as { n: number }
    const session = db.prepare('SELECT event_count AS n FROM session WHERE singleton = 1').get() as { n: number }
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
    return {
      frames: Number(frames.n),
      rows: Number(rows.n),
      sealedEnd: Number(end.n),
      eventCount: Number(session.n),
      version: Number(version.user_version),
    }
  } finally {
    db.close()
  }
}

afterEach(async () => {
  const failures: unknown[] = []
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
  }
  if (failures.length > 0) throw new AggregateError(failures, 'cleanup failed')
})

describe('chunked log', () => {
  it('seals a long import into frames and still reads back every event', async () => {
    const root = await makeRoot()
    const events = longLog(30)
    const path = seed(root, 'session-framed', events)
    const layout = layoutOf(path)
    // Frames are the point: most rows must have moved, and a tail may remain.
    expect(layout.frames).toBeGreaterThan(0)
    expect(layout.rows).toBeLessThan(events.length)
    expect(layout.sealedEnd + layout.rows).toBe(events.length)
    expect(layout.eventCount).toBe(events.length)
    expect(layout.version).toBe(2)

    const db = SessionDatabase.open(path, SETTINGS)
    try {
      const loaded = db.loadSession()
      expect(loaded?.events.map(event => event.seq)).toEqual(events.map(event => event.seq))
      expect(loaded?.events.map(event => event.type)).toEqual(events.map(event => event.type))
      expect(loaded?.tornTruncateTo).toBeUndefined()
      expect(loaded?.eventCount).toBe(events.length)
      expect(db.loadHeader()?.eventCount).toBe(events.length)
    } finally {
      db.close()
    }
  })

  it('cuts a window that straddles a frame boundary exactly as the full read would', async () => {
    const root = await makeRoot()
    const events = longLog(30)
    const path = seed(root, 'session-window', events)
    const layout = layoutOf(path)
    // A cut placed inside the sealed region must cross at least one frame edge.
    const offset = Math.max(0, Math.floor(layout.sealedEnd / 2) - 5)
    const db = SessionDatabase.open(path, SETTINGS)
    try {
      const whole = db.loadSession()
      const window = db.loadSession({ offset, length: 20 })
      expect(window?.events).toEqual(whole?.events.slice(offset, offset + 20))
      expect(window?.eventCount).toBe(events.length)
      // The tail beyond the sealed region is served from rows, not frames.
      const tailWindow = db.loadSession({ offset: layout.sealedEnd - 2, length: 6 })
      expect(tailWindow?.events).toEqual(whole?.events.slice(layout.sealedEnd - 2, layout.sealedEnd + 4))
    } finally {
      db.close()
    }
  })

  it('truncates through the middle of a frame and leaves a contiguous log', async () => {
    const root = await makeRoot()
    const events = longLog(30)
    const path = seed(root, 'session-truncate', events)
    const layout = layoutOf(path)
    // A cut well inside the sealed region: the frame holding it has to be
    // opened, and what survives of it has to come back as rows.
    const cut = Math.max(1, Math.floor(layout.sealedEnd / 2))
    const db = SessionDatabase.open(path, SETTINGS)
    try {
      db.truncateTail(cut)
      const trimmed = db.loadSession()
      expect(trimmed?.events).toHaveLength(cut)
      expect(trimmed?.events[cut - 1]?.seq).toBe(cut - 1)
      expect(trimmed?.eventCount).toBe(cut)
      expect(trimmed?.tornTruncateTo).toBeUndefined()
      expect(db.loadHeader()?.eventCount).toBe(cut)
    } finally {
      db.close()
    }
    const after = layoutOf(path)
    // No surviving frame may describe an event that was cut away.
    expect(after.sealedEnd).toBeLessThanOrEqual(cut)
  })

  it('continues the log after the frame boundary once an append lands', async () => {
    const root = await makeRoot()
    const events = longLog(30)
    const path = seed(root, 'session-append', events)
    const extra = longLog(4, 40_000, events.length, 31)
    const db = SessionDatabase.open(path, SETTINGS)
    try {
      db.appendBatch(headerOf('session-append'), extra, true, 0)
      const loaded = db.loadSession()
      expect(loaded?.eventCount).toBe(events.length + extra.length)
      expect(loaded?.events.map(event => event.seq)).toEqual(
        [...events, ...extra].map(event => event.seq),
      )
      expect(loaded?.tornTruncateTo).toBeUndefined()
      const window = db.loadSession({ offset: events.length - 3, length: 6 })
      expect(window?.events.map(event => event.seq)).toEqual([events.length - 3, events.length - 2, events.length - 1, events.length, events.length + 1, events.length + 2])
    } finally {
      db.close()
    }
  })

  it('reads a framed store whose seal was dropped by walking frames then rows', async () => {
    const root = await makeRoot()
    const events = longLog(30)
    const path = seed(root, 'session-unsealed', events)
    const db = new DatabaseSync(path)
    try {
      db.exec('DELETE FROM session_seal')
    } finally {
      db.close()
    }
    const store = SessionDatabase.open(path, SETTINGS)
    try {
      const loaded = store.loadSession()
      // Without a seal the walk has to establish the prefix itself, and it must
      // reach the same log: a frame path that only works when trusted would make
      // the seal load-bearing for correctness instead of for speed.
      expect(loaded?.events.map(event => event.seq)).toEqual(events.map(event => event.seq))
      expect(loaded?.tornTruncateTo).toBeUndefined()
      const window = store.loadSession({ offset: 100, length: 10 })
      expect(window?.events.map(event => event.seq)).toEqual(events.slice(100, 110).map(event => event.seq))
    } finally {
      store.close()
    }
  })

  it('refuses a frame that expands past the size it claims', () => {
    const honest = encodeChunk(longLog(1, 200))
    expect(honest).toBeDefined()
    const bomb = 'x'.repeat(8 * 1024 * 1024)
    const payload = zstdCompressSync(Buffer.from(bomb), {
      params: { [zlibConstants.ZSTD_c_compressionLevel]: 9 },
    })
    expect(payload.byteLength).toBeLessThan(honest!.rawBytes)
    expect(() => decodeChunkLines(payload, {
      firstSeq: honest!.firstSeq,
      eventCount: honest!.eventCount,
      rawBytes: honest!.rawBytes,
    })).toThrow(/too large|maxOutputLength|cannot be decoded|ERR_BUFFER_TOO_LARGE|larger than/i)
    expect(decodeChunkLines(honest!.payload, {
      firstSeq: honest!.firstSeq,
      eventCount: honest!.eventCount,
      rawBytes: honest!.rawBytes,
    })).toHaveLength(honest!.eventCount)
  })

  it('keeps a short log as rows and leaves a pre-frame store readable', async () => {
    const root = await makeRoot()
    const events = longLog(2, 200)
    const path = seed(root, 'session-small', events)
    const layout = layoutOf(path)
    // Below half a frame there is nothing worth sealing; the log stays rows.
    expect(layout.frames).toBe(0)
    expect(layout.rows).toBe(events.length)
    expect(CHUNK_BYTES).toBeGreaterThan(events.length)

    // A store written before frames existed carries layout version 1 and no
    // chunk table rows. Sealing is what promotes a store to 2, so a store that
    // never seals must stay readable at 1 — that is the whole compatibility
    // promise, and it is one `PRAGMA` away from being testable here.
    const raw = new DatabaseSync(path)
    try {
      raw.exec('PRAGMA user_version = 1')
    } finally {
      raw.close()
    }
    expect(layoutOf(path).version).toBe(1)
    const db = SessionDatabase.open(path, SETTINGS)
    try {
      const loaded = db.loadSession()
      expect(loaded?.events.map(event => event.seq)).toEqual(events.map(event => event.seq))
      expect(loaded?.tornTruncateTo).toBeUndefined()
      // Reading a v1 store must not silently rewrite it to v2.
      expect(layoutOf(path).version).toBe(1)
    } finally {
      db.close()
    }
  })
})
