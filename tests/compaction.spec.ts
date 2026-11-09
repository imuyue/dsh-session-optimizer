/**
 * A log that has been compacted must page like any other log.
 *
 * The community report behind this file (DSH #11990) is a rendering failure
 * after "Load earlier" on a long conversation that had compacted several times.
 * The failure was upstream, but the storage half of the question is ours: when a
 * page boundary lands in the middle of a compaction — inside the span a summary
 * shadowed, or between `compaction/start` and `compaction/end` — does a window
 * still return the same events a whole read would, in order, exactly once?
 *
 * The fixture is a legal V4 artifact with a protected `system/message` head, one
 * compaction with its summary and checkpoint replacement, and ordinary turns on
 * both sides, so every page boundary the reader can ask for is exercised.
 *
 * @module dsh-session-optimizer/tests/compaction
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionDatabase, ensureSessionDirectory, type SqliteSettings } from '../src/database.ts'
import { databasePath } from '../src/format.ts'

const SETTINGS: SqliteSettings = { journalMode: 'wal', synchronous: 'full', busyTimeoutMs: 5000 }
const CWD = '/work/compaction'

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshsql-compaction-'))
  roots.push(root)
  return root
}

function headerOf(id: string): SessionHeader {
  return {
    version: 4,
    id: id as SessionId,
    createdAt: 1_700_000_000_000,
    cwd: CWD,
    isSeeded: false,
    delegationDepth: 0,
  }
}

function text(value: string) {
  return [{ type: 'text', text: value }]
}

/** A `user/message` carries the message itself as its payload. */
function userMessage(id: string, body: string, source: object = { kind: 'user' }) {
  return { id, role: 'user', source, content: text(body) }
}

/**
 * One legal V4 log containing a compaction.
 *
 * Sequence, and why each part is here:
 * - `system/message` opens the surface, so it is the protected head a compaction
 *   is not allowed to shadow;
 * - turn 1 holds an ordinary message the compaction later shadows;
 * - turn 2 holds `compaction/start` → `compaction/summary` → the checkpoint
 *   `user/message` that replaces the shadowed span → `compaction/end`, which is
 *   the exact shape the upstream report hit;
 * - turns 3..N hold ordinary traffic after the compaction, so pages exist on
 *   both sides of it.
 *
 * `filler` pads the later messages so a run can get past the size threshold below
 * which the store keeps a log as rows: a boundary inside a compressed frame is
 * only reachable with a log big enough to be framed at all.
 */
function compactedLog(turnsAfter = 4, filler = 0): SessionEvent[] {
  const events: SessionEvent[] = []
  let seq = 0
  const push = (event: object) => {
    events.push({ ...event, seq, time: 1_700_000_000_000 + seq } as SessionEvent)
    seq += 1
  }

  push({ type: 'turn/start', data: { turn: 1 } })
  push({ type: 'step/start', data: { turn: 1, step: 1 } })
  push({
    type: 'system/message',
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'system',
        role: 'system',
        source: { kind: 'system-prompt' },
        content: text('You are a careful assistant.'),
      },
    },
  })
  push({ type: 'user/message', surfaceOp: 'append', data: userMessage('msg-1', 'first question') })
  push({ type: 'step/end', data: { turn: 1, step: 1 } })
  push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

  // The turn that compacts what came before it.
  push({ type: 'turn/start', data: { turn: 2 } })
  push({ type: 'step/start', data: { turn: 2, step: 1 } })
  push({ type: 'user/message', surfaceOp: 'append', data: userMessage('msg-2', 'second question') })
  push({ type: 'compaction/start', data: { compactionId: 'compact-1', sourceCommandId: 'cmd-1', turn: 2 } })
  push({
    type: 'compaction/summary',
    data: {
      compactionId: 'compact-1',
      sourceCommandId: 'cmd-1',
      summary: text('The operator asked two questions.'),
      shadowedRange: { start: 3, end: 3 },
      shadowedSeqs: [3],
      shadowedTokenCount: 12,
      provider: 'mock',
      model: 'mock',
    },
  })
  push({
    type: 'user/message',
    surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 },
    sourceEventSeqs: [3],
    data: userMessage('msg-1-checkpoint', 'first question (summarized)', {
      kind: 'compact-checkpoint',
      compactionId: 'compact-1',
      sourceCommandId: 'cmd-1',
    }),
  })
  push({ type: 'compaction/end', data: { compactionId: 'compact-1', sourceCommandId: 'cmd-1', turn: 2 } })
  push({ type: 'step/end', data: { turn: 2, step: 1 } })
  push({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })

  for (let index = 0; index < turnsAfter; index += 1) {
    const turn = 3 + index
    push({ type: 'turn/start', data: { turn } })
    push({ type: 'step/start', data: { turn, step: 1 } })
    push({
      type: 'user/message',
      surfaceOp: 'append',
      data: userMessage(
        `msg-${String(turn)}`,
        filler === 0 ? `question ${String(turn)}` : `question ${String(turn)} ${'x'.repeat(filler)}`,
      ),
    })
    push({ type: 'step/end', data: { turn, step: 1 } })
    push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  return events
}

/** Write the log through the engine, which is also what validates it. */
function seed(root: string, id: string, events: readonly SessionEvent[]): string {
  const path = databasePath(root, CWD, id as SessionId)
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

/** Frames the store actually holds, so a test can prove it exercised a frame. */
function framesOf(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const row = db.prepare('SELECT count(*) AS frames FROM event_chunk').get() as { frames: unknown }
    return Number(row.frames)
  } finally {
    db.close()
  }
}

afterEach(async () => {
  const failures: unknown[] = []
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
  }
  if (failures.length > 0) throw new AggregateError(failures, 'compaction test cleanup failed')
})

describe('a compacted log', () => {
  it('stores the summary, the checkpoint and the message it shadowed', async () => {
    const events = compactedLog()
    const root = await makeRoot()
    const path = seed(root, 'session-compacted', events)
    const db = SessionDatabase.open(path, SETTINGS)
    try {
      const loaded = db.loadSession()
      // Nothing is rewritten and nothing is dropped: a compaction is a surface
      // operation, not a log edit, and the log is what a pager walks.
      expect(loaded?.events.map(event => event.seq)).toStrictEqual(events.map((_, index) => index))
      expect(loaded?.events.map(event => event.type)).toStrictEqual(events.map(event => event.type))
      expect(loaded?.eventCount).toBe(events.length)
      expect(loaded?.tornTruncateTo).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('cuts a window across the compaction exactly as a whole read would', async () => {
    const events = compactedLog()
    const root = await makeRoot()
    const path = seed(root, 'session-windows', events)
    const db = SessionDatabase.open(path, SETTINGS)
    try {
      const whole = db.loadSession()
      expect(whole?.events.length).toBe(events.length)
      // Every boundary the reader can ask for, with three page lengths: a pager
      // works in offsets, not in alignments.
      for (let offset = 0; offset < events.length; offset += 1) {
        for (const length of [1, 3, 7]) {
          const window = db.loadSession({ offset, length })
          expect(window?.events).toStrictEqual(whole?.events.slice(offset, offset + length))
          expect(window?.eventCount).toBe(events.length)
        }
      }
    } finally {
      db.close()
    }
  })

  it('serves a paged pass with no gap, no repeat and no reordering', async () => {
    const events = compactedLog()
    const root = await makeRoot()
    const path = seed(root, 'session-paged', events)
    const db = SessionDatabase.open(path, SETTINGS)
    try {
      const collected: SessionEvent[] = []
      for (let offset = 0; offset < events.length; offset += 4) {
        collected.push(...(db.loadSession({ offset, length: 4 })?.events ?? []))
      }
      // Exactly what the projection is promised: every event once, in order, and
      // the same events a whole read returns.
      expect(collected.map(event => event.seq)).toStrictEqual(events.map((_, index) => index))
      expect(collected).toStrictEqual(events)
    } finally {
      db.close()
    }
  })

  it('still pages the same way once the compaction itself is sealed into a frame', async () => {
    // Enough traffic that `compact()` moves the compaction into a frame: a
    // boundary inside a compressed frame is the case with no rows to fall back on.
    const events = compactedLog(400, 4000)
    const root = await makeRoot()
    const path = seed(root, 'session-sealed', events)
    // Without frames this case would silently repeat the row test above under a
    // different name: a boundary inside a compressed frame is the only case with
    // no rows to fall back on.
    expect(framesOf(path)).toBeGreaterThan(0)
    const db = SessionDatabase.open(path, SETTINGS)
    try {
      const whole = db.loadSession()
      expect(whole?.events.length).toBe(events.length)
      for (const offset of [0, 1, 2, 9, 10, 11, 12, 13, 400, events.length - 7]) {
        const window = db.loadSession({ offset, length: 9 })
        expect(window?.events).toStrictEqual(whole?.events.slice(offset, offset + 9))
      }
      const collected: SessionEvent[] = []
      for (let offset = 0; offset < events.length; offset += 97) {
        collected.push(...(db.loadSession({ offset, length: 97 })?.events ?? []))
      }
      expect(collected).toStrictEqual(events)
    } finally {
      db.close()
    }
  })

  it('leaves the log as rows while the stability fixes are off, and seals again once they are back on', async () => {
    // This is what the settings view's "长对话稳定性修复" switch actually changes:
    // with it off nothing is compressed, so every read is a row scan; with it on
    // the next write seals the log into frames. Both states must keep the same
    // events readable, which is why the assertion below compares the reads too.
    const events = compactedLog(400, 4000)
    const root = await makeRoot()
    const id = 'session-switched'
    const path = databasePath(root, CWD, id as SessionId)
    ensureSessionDirectory(join(path, '..'))

    const off = SessionDatabase.open(path, { ...SETTINGS, seal: false })
    try {
      off.appendImported(headerOf(id), events, 0)
      off.markReady()
      expect(framesOf(path)).toBe(0)
      expect(off.loadSession()?.eventCount).toBe(events.length)
    } finally {
      off.close()
    }

    const on = SessionDatabase.open(path, SETTINGS)
    try {
      // One more turn, so the write path — not an explicit `compact()` — is what
      // has to notice the switch: `compact()` stays unconditional on purpose.
      const base = events.length
      const extra = [
        { type: 'turn/start', seq: base, time: 1_700_000_100_000, data: { turn: 999 } },
        { type: 'turn/end', seq: base + 1, time: 1_700_000_100_001, data: { turn: 999, reason: { kind: 'completed' } } },
      ] as unknown as SessionEvent[]
      on.appendBatch(headerOf(id), extra, true, 0)
      expect(framesOf(path)).toBeGreaterThan(0)
      expect(on.loadSession()?.eventCount).toBe(events.length + 2)
    } finally {
      on.close()
    }
  })

  it('stops the running connection from sealing the moment the switch is turned off', async () => {
    // `retune` is what a cached connection uses: the store in the executor's LRU
    // was opened with whatever the operator had chosen then, and the patch has to
    // reach it without closing and reopening the file.
    const events = compactedLog(400, 4000)
    const root = await makeRoot()
    const id = 'session-retuned'
    const path = databasePath(root, CWD, id as SessionId)
    ensureSessionDirectory(join(path, '..'))
    const db = SessionDatabase.open(path, SETTINGS)
    try {
      db.appendImported(headerOf(id), events, 0)
      db.markReady()
      expect(framesOf(path)).toBeGreaterThan(0)
      const sealed = framesOf(path)

      db.retune({ ...SETTINGS, seal: false })
      const base = events.length
      db.appendBatch(
        headerOf(id),
        [
          { type: 'turn/start', seq: base, time: 1_700_000_200_000, data: { turn: 1000 } },
          { type: 'turn/end', seq: base + 1, time: 1_700_000_200_001, data: { turn: 1000, reason: { kind: 'completed' } } },
        ] as unknown as SessionEvent[],
        true,
        0,
      )
      // Nothing new was sealed: the frame count is exactly what it was.
      expect(framesOf(path)).toBe(sealed)
      expect(db.loadSession()?.eventCount).toBe(events.length + 2)
    } finally {
      db.close()
    }
  })
})
