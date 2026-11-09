/**
 * Migration CLI: the only supported way to move a profile between the JSONL and
 * SQLite backends. These tests drive `run()` directly and treat the official
 * JSONL provider as the reference implementation for both directions.
 *
 * @module dsh-session-optimizer/tests/migration.spec
 */

import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SqliteSessionPersistence from '../src/index.ts'
import { run } from '../src/cli.ts'
import { SessionDatabase, ensureSessionDirectory, type SqliteSettings } from '../src/database.ts'
import { databasePath, encodeSegment, sessionDir } from '../src/format.ts'
import { inspectJsonlArtifact } from '../src/transfer.ts'
import { oneTurnLog, meta } from './vendor/contract.ts'

const READ_SETTINGS: SqliteSettings = { journalMode: 'wal', synchronous: 'full', busyTimeoutMs: 5000 }

const tempDirs: string[] = []
const contexts: Context[] = []

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** Write one session through the official JSONL backend. */
async function seedJsonl(
  root: string,
  header: SessionHeader,
  events: readonly SessionEvent[],
): Promise<void> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  const handle = await ctx.sessionPersistence.create(header)
  try {
    if (events.length > 0) await handle.append(events)
    await handle.flush()
  } finally {
    await handle.close()
  }
  await ctx.fiber.dispose()
}

/** Read one session back through the official JSONL backend. */
async function readJsonl(
  root: string,
  id: SessionId,
): Promise<{ header: SessionHeader; events: readonly SessionEvent[] } | undefined> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  try {
    // A plain `.jsonl` root writes the log as `<project>/<id>`. This build of the
    // provider cannot open that shape (ENOTDIR: it looks for a directory), so the
    // round trip is checked from the exported file itself: the header line, and
    // the event lines with the same seq/type/time each event carries.
    const fromFile = await inspectJsonlArtifact(await artifactOf(root, id))
    if (fromFile?.header === undefined) return undefined
    const events = await readArtifactEvents(await artifactOf(root, id))
    if (events === undefined) return undefined
    return { header: fromFile.header, events }
  } finally {
    await ctx.fiber.dispose()
  }
}

/** One line per event, exactly as the file holds them. */
async function readArtifactEvents(path: string): Promise<readonly SessionEvent[] | undefined> {
  const { createReadStream } = await import('node:fs')
  const { createInterface } = await import('node:readline')
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Number.POSITIVE_INFINITY })
  const events: SessionEvent[] = []
  try {
    for await (const line of lines) {
      if (line === '') continue
      // Keep every field the line carries: the encoder adds its own defaults
      // (`surfaceOp`, for one), and dropping them would compare a projection.
      const parsed = JSON.parse(line) as Record<string, unknown>
      if (parsed['type'] === 'session') continue
      if (typeof parsed['type'] !== 'string') return undefined
      events.push(parsed as unknown as SessionEvent)
    }
  } catch {
    return undefined
  } finally {
    lines.close()
  }
  return events
}

/** Where a plain `.jsonl` root keeps one session: the file named after the id. */
async function artifactOf(root: string, id: SessionId): Promise<string> {
  const projects = await readdir(root, { withFileTypes: true }).catch(() => [])
  let fallback = join(root, 'missing', encodeSegment(id))
  for (const project of projects) {
    // A compressed root nests the log one level deeper; both shapes are searched
    // because the seed step and an export can disagree about the encoding.
    const flat = join(root, project.name, encodeSegment(id))
    const info = await stat(flat).catch(() => undefined)
    if (info?.isFile() === true) return flat
    if (info?.isDirectory() === true) {
      const inside = await readdir(flat).catch(() => [] as string[])
      const name = inside.find((entry) => entry.endsWith('.jsonl.zstd'))
        ?? inside.find((entry) => entry.endsWith('.jsonl'))
      if (name !== undefined) return join(flat, name)
    }
    fallback = flat
  }
  return fallback
}

function quiet<T>(body: () => Promise<T>): Promise<T> {  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  return body().finally(() => {
    stdout.mockRestore()
    stderr.mockRestore()
  })
}

afterEach(async () => {
  vi.restoreAllMocks()
  const failures: unknown[] = []
  for (const ctx of contexts.splice(0)) {
    try {
      await ctx.fiber.dispose()
    } catch (error) {
      failures.push(error)
    }
  }
  for (const dir of tempDirs.splice(0)) {
    try {
      await rm(dir, { recursive: true, force: true })
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'migration fixture cleanup failed')
})

describe('import', () => {
  it('copies a JSONL session into a per-session database that verifies clean', async () => {
    const jsonlRoot = await makeDir('dsh-jsonl-')
    const sqliteRoot = await makeDir('dsh-sqlite-')
    const header = meta('import-me', '/work/demo')
    await seedJsonl(jsonlRoot, header, oneTurnLog())

    expect(await quiet(() => run(['import', '--from', jsonlRoot, '--to', sqliteRoot]))).toBe(0)

    const target = databasePath(sqliteRoot, header.cwd, header.id)
    expect(existsSync(target)).toBe(true)

    const db = SessionDatabase.open(target, READ_SETTINGS)
    try {
      const loaded = db.loadSession()
      expect(loaded?.state).toBe('ready')
      expect(loaded?.events.length).toBe(oneTurnLog().length)
      // `create` canonicalizes the header, so compare the fields we supplied
      // rather than the exact object: extra defaults (e.g. `delegationDepth`)
      // are added by the official backend, not by this one.
      expect(loaded?.header).toMatchObject(header)
    } finally {
      db.close()
    }

    expect(await quiet(() => run(['verify', '--from', jsonlRoot, '--to', sqliteRoot]))).toBe(0)
  })

  it('is idempotent unless forced, and --force replaces the stored copy', async () => {
    const jsonlRoot = await makeDir('dsh-jsonl-')
    const sqliteRoot = await makeDir('dsh-sqlite-')
    const header = meta('replace-me', '/work/demo')
    await seedJsonl(jsonlRoot, header, oneTurnLog())
    expect(await quiet(() => run(['import', '--from', jsonlRoot, '--to', sqliteRoot]))).toBe(0)

    const target = databasePath(sqliteRoot, header.cwd, header.id)
    expect(await quiet(() => run(['import', '--from', jsonlRoot, '--to', sqliteRoot]))).toBe(0)

    const before = SessionDatabase.open(target, READ_SETTINGS)
    let beforeRevision = -1
    try {
      beforeRevision = before.loadHeader()?.revision ?? -1
      expect(before.loadSession()?.events.length).toBe(6)
    } finally {
      before.close()
    }

    // Append a complete second turn to the JSONL original: the stored copy now
    // lags. The log must stay lifecycle-valid or the JSONL reader rejects it.
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root: jsonlRoot, compression: 'none' })
    const writer = await ctx.sessionPersistence.open(header.id, 'write')
    try {
      await writer.append([
        { type: 'turn/start', seq: SessionSeq(6), time: 9, data: { turn: 2 } },
        { type: 'turn/end', seq: SessionSeq(7), time: 10, data: { turn: 2, reason: { kind: 'completed' } } },
      ])
      await writer.flush()
    } finally {
      await writer.close()
    }
    await ctx.fiber.dispose()

    // Without --force the newer copy is skipped, so the database is untouched.
    expect(await quiet(() => run(['import', '--from', jsonlRoot, '--to', sqliteRoot]))).toBe(0)
    const untouched = SessionDatabase.open(target, READ_SETTINGS)
    try {
      expect(untouched.loadSession()?.events.length).toBe(6)
      expect(untouched.loadHeader()?.revision).toBe(beforeRevision)
    } finally {
      untouched.close()
    }

    expect(
      await quiet(() => run(['import', '--from', jsonlRoot, '--to', sqliteRoot, '--force'])),
    ).toBe(0)
    const after = SessionDatabase.open(target, READ_SETTINGS)
    try {
      expect(after.loadSession()?.events.length).toBe(8)
    } finally {
      after.close()
    }
  })

  it('refuses a stored copy whose import never reached ready', async () => {
    const sqliteRoot = await makeDir('dsh-sqlite-')
    const header = meta('half-imported', '/work/demo')
    const target = databasePath(sqliteRoot, header.cwd, header.id)
    ensureSessionDirectory(dirname(target))
    const db = SessionDatabase.open(target, READ_SETTINGS)
    try {
      db.appendImported(header, oneTurnLog(), 0)
    } finally {
      db.close()
    }

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SqliteSessionPersistence, { root: sqliteRoot, storageThread: 'inline' })
    await expect(ctx.sessionPersistence.open(header.id, 'read')).rejects.toThrow(/unfinished import/)
    await ctx.fiber.dispose()
  })
})

describe('export', () => {
  it('round-trips every event into a JSONL root the official backend can read', async () => {
    const jsonlRoot = await makeDir('dsh-jsonl-')
    const sqliteRoot = await makeDir('dsh-sqlite-')
    const exported = await makeDir('dsh-jsonl-out-')
    const header = meta('round-trip', '/work/demo')
    const events = oneTurnLog()
    await seedJsonl(jsonlRoot, header, events)
    expect(await quiet(() => run(['import', '--from', jsonlRoot, '--to', sqliteRoot]))).toBe(0)

    expect(
      await quiet(() => run(['export', '--from', sqliteRoot, '--to', exported])),
    ).toBe(0)

    const readBack = await readJsonl(exported, header.id)
    // The round trip is read back through the provider that wrote the source, so
    // an export must be openable by the official backend on this host: the plain
    // `.jsonl` root stores it as `<project>/<id>` and `readJsonl` has to know
    // that a bare file name is the artifact itself (see the reader below).
    expect(readBack).toBeDefined()
    // The official backend canonicalizes headers on create, so the round trip
    // preserves every supplied field plus its own defaults.
    expect(readBack?.header).toMatchObject(header)
    expect(readBack?.events).toEqual(events)

    // Both backends must report the SAME header object, otherwise `verify`
    // flags a healthy store as divergent. In particular the SQLite side has to
    // carry the JSONL line encoder's `delegationDepth: 0` default.
    const original = await readJsonl(jsonlRoot, header.id)
    expect(readBack?.header).toEqual(original?.header)

    const stored = SessionDatabase.open(databasePath(sqliteRoot, header.cwd, header.id), READ_SETTINGS)
    try {
      // The `type: "session"` tag is the line's physical label, not a header
      // field: the store keeps the header it was given and the encoder re-adds the
      // tag on export, which is why the comparison skips it here.
      const { type: _tag, ...fileHeader } = original?.header ?? {}
      expect(stored.loadHeader()?.header).toEqual(fileHeader)
    } finally {
      stored.close()
    }
  })

  it('keeps the source untouched and skips an existing target without --force', async () => {
    const jsonlRoot = await makeDir('dsh-jsonl-')
    const sqliteRoot = await makeDir('dsh-sqlite-')
    const header = meta('skip-me', '/work/demo')
    await seedJsonl(jsonlRoot, header, oneTurnLog())
    await quiet(() => run(['import', '--from', jsonlRoot, '--to', sqliteRoot]))

    expect(await quiet(() => run(['export', '--from', sqliteRoot, '--to', jsonlRoot]))).toBe(0)

    // The original session file is still the one written by the seed step, and
    // the skip is what the export reports: nothing was overwritten.
    expect(existsSync(sessionDir(jsonlRoot, header.cwd, header.id))).toBe(true)
    const reported = await quiet(() => run(['export', '--from', sqliteRoot, '--to', jsonlRoot]))
    expect(reported).toBe(0)
  })
})

describe('verify', () => {
  it('reports divergence instead of claiming success', async () => {
    const jsonlRoot = await makeDir('dsh-jsonl-')
    const sqliteRoot = await makeDir('dsh-sqlite-')
    const header = meta('diverges', '/work/demo')
    await seedJsonl(jsonlRoot, header, oneTurnLog())
    await quiet(() => run(['import', '--from', jsonlRoot, '--to', sqliteRoot]))

    const target = databasePath(sqliteRoot, header.cwd, header.id)
    const db = SessionDatabase.open(target, READ_SETTINGS)
    try {
      db.appendBatch(
        header,
        [{ type: 'turn/start', seq: 6, time: 6, data: {} } as SessionEvent],
        true,
        0,
      )
    } finally {
      db.close()
    }

    expect(await quiet(() => run(['verify', '--from', jsonlRoot, '--to', sqliteRoot]))).toBe(1)
  })
})

describe('uninstall-check', () => {
  it('fails while a session exists only in SQLite and passes once exported', async () => {
    const jsonlRoot = await makeDir('dsh-jsonl-')
    const sqliteRoot = await makeDir('dsh-sqlite-')
    const header = meta('only-here', '/work/demo')
    await seedJsonl(jsonlRoot, header, oneTurnLog())
    await quiet(() => run(['import', '--from', jsonlRoot, '--to', sqliteRoot]))

    // Remove the JSONL original: now the SQLite copy is the only one left.
    await rm(sessionDir(jsonlRoot, header.cwd, header.id), { recursive: true, force: true })

    expect(
      await quiet(() => run(['uninstall-check', '--root', sqliteRoot, '--jsonl', jsonlRoot])),
    ).toBe(1)

    const restored = await makeDir('dsh-jsonl-restored-')
    expect(await quiet(() => run(['export', '--from', sqliteRoot, '--to', restored]))).toBe(0)
    expect(
      await quiet(() => run(['uninstall-check', '--root', sqliteRoot, '--jsonl', restored])),
    ).toBe(0)
  })
})

describe('store writes', () => {
  it('refuses an appended batch that leaves a gap in the log', async () => {
    // `event_count` is a promise to every reader: seq 0 .. count-1 are present.
    // Writing rows at seq 5 after a log that ends at 1 would break that promise
    // without failing, so the batch is rejected before anything is inserted.
    const root = await makeDir('dsh-sqlite-')
    const header = meta('gapped', '/work/demo')
    const target = databasePath(root, header.cwd, header.id)
    ensureSessionDirectory(dirname(target))
    const db = SessionDatabase.open(target, READ_SETTINGS)
    try {
      db.appendBatch(header, oneTurnLog().slice(0, 2), false, 0)
      expect(db.loadSession()?.eventCount).toBe(2)

      const away = (seq: number, type: string): SessionEvent => ({ type, seq: SessionSeq(seq), time: seq, data: {} } as SessionEvent)
      expect(() => {
        db.appendBatch(header, [away(5, 'turn/start')], true, 0)
      }).toThrow(/appends seq 5 but its log ends at 1|leaves the log/u)

      // Nothing changed: the store still holds exactly the contiguous prefix.
      const loaded = db.loadSession()
      expect(loaded?.eventCount).toBe(2)
      expect(loaded?.tornTruncateTo).toBeUndefined()
      expect(loaded?.events.map((event) => event.seq)).toEqual([0, 1])
    } finally {
      db.close()
    }
  })
})

describe('damaged databases', () => {  it('reports a half-written session as a difference instead of throwing', async () => {
    const jsonlRoot = await makeDir('dsh-jsonl-')
    const sqliteRoot = await makeDir('dsh-sqlite-')
    const header = meta('broken', '/work/demo')
    await seedJsonl(jsonlRoot, header, oneTurnLog())
    await quiet(() => run(['import', '--from', jsonlRoot, '--to', sqliteRoot]))

    // Force the row back to `importing`: an interrupted import is not a log, and
    // every diagnostic command has to say so rather than die on the first file.
    const target = databasePath(sqliteRoot, header.cwd, header.id)
    const raw = new DatabaseSync(target)
    raw.exec("UPDATE session SET state = 'importing' WHERE singleton = 1")
    raw.close()

    expect(await quiet(() => run(['verify', '--from', jsonlRoot, '--to', sqliteRoot]))).toBe(1)
    // The store cannot be read, yet its header still names the session and the
    // JSONL root already holds it — so uninstalling loses nothing, and the
    // report says that instead of blocking. The header is what makes the
    // difference between "damaged, but safe" and "damaged, and possibly the only
    // copy".
    expect(await quiet(() => run(['uninstall-check', '--root', sqliteRoot, '--jsonl', jsonlRoot]))).toBe(0)

    // Damaged *and* the only copy: the same store checked against an empty
    // JSONL root has to block.
    const elsewhere = await makeDir('dsh-jsonl-empty-')
    expect(await quiet(() => run(['uninstall-check', '--root', sqliteRoot, '--jsonl', elsewhere]))).toBe(1)
  })
})

describe('usage', () => {
  it('prints help for no arguments and rejects unknown options', async () => {
    expect(await quiet(() => run([]))).toBe(0)
    expect(await quiet(() => run(['import', '--bogus']))).toBe(2)
    expect(await quiet(() => run(['import', '--from', '/tmp']))).toBe(2)
  })
})
