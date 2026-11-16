/**
 * The two migration modes, driven the way the console and the CLI drive them.
 *
 * Migration converts a *conversation*, not a file: an overwrite keeps the id and
 * replaces the log the backend reads, a clone adds a second conversation under a
 * new id. Three things have to hold for either: the copy holds every event, the
 * conversation is readable from exactly one place afterwards, and the catalog
 * only moves once the copy is proven. The tests below check each separately,
 * because a migration that loses the last of them turns a backup into the only
 * copy without ever saying so.
 *
 * @module dsh-session-optimizer/tests/migrate.spec
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionBackendCatalog, catalogPath } from '../src/catalog.ts'
import { SessionDatabase, ensureSessionDirectory, type SqliteSettings } from '../src/database.ts'
import { databasePath, sessionDir } from '../src/format.ts'
import {
  archiveSource,
  listSourceRoot,
  pruneSource,
  runMigration,
  sourceSessions,
  type MigrationBackend,
} from '../src/migrate.ts'
import { mountJsonl, storableHeader, writeSqliteSession, type JsonlMount, type LogCopy } from '../src/transfer.ts'

const READ_SETTINGS: SqliteSettings = { journalMode: 'wal', synchronous: 'full', busyTimeoutMs: 5000 }

const tempDirs: string[] = []
const mounts = new Set<JsonlMount>()

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** A mount the tests can hand to `runMigration` as a backend. */
async function backendOf(root: string, id: 'sqlite' | 'jsonl'): Promise<MigrationBackend> {
  if (id === 'sqlite') {
    // A SQLite backend is read through `SessionDatabase` in these tests, and
    // `runMigration` only asks the *source* for `list()`; the target side is
    // written by path. So the member is a placeholder that is never consulted.
    return { id, root, persistence: undefined as never }
  }
  const mount = await mountJsonl(root, 'jsonl')
  mounts.add(mount)
  return { id, root, persistence: mount.persistence }
}

function headerOf(id: string, cwd = '/work/migrate'): SessionHeader {
  return {
    version: 4,
    id: id as SessionId,
    createdAt: 1_700_000_000_000,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
  }
}

function oneTurn(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 1_700_000_000_001, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 1_700_000_000_002, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as never
}

/** Write one session into a JSONL root with the official provider. */
async function seedJsonl(root: string, id: string, cwd = '/work/migrate'): Promise<void> {
  const mount = await mountJsonl(root, 'jsonl')
  mounts.add(mount)
  const header = headerOf(id, cwd)
  const handle = await mount.persistence.create(header)
  try {
    await handle.append(oneTurn() as never)
    await handle.flush()
  } finally {
    await handle.close()
  }
}

/** Write one session into a SQLite root through the engine the backend uses. */
async function seedSqlite(root: string, id: string, cwd = '/work/migrate'): Promise<void> {
  const path = databasePath(root, cwd, id as SessionId)
  await ensureSessionDirectory(dirname(path))
  const db = SessionDatabase.open(path, READ_SETTINGS)
  try {
    db.appendImported(headerOf(id, cwd) as never, oneTurn() as never, 0)
    db.markReady()
  } finally {
    db.close()
  }
}

/** Read the events a SQLite store holds. */
function sqliteEvents(path: string): { header: SessionHeader | undefined; events: readonly SessionEvent[] } {
  const db = SessionDatabase.open(path, READ_SETTINGS)
  try {
    const loaded = db.loadSession()
    return { header: loaded?.header, events: loaded?.events ?? [] }
  } finally {
    db.close()
  }
}

afterEach(async () => {
  const failures: unknown[] = []
  for (const mount of mounts) {
    try {
      await mount.dispose()
    } catch (error) {
      failures.push(error)
    }
  }
  mounts.clear()
  for (const dir of tempDirs.splice(0)) {
    try {
      await rm(dir, { recursive: true, force: true })
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'migration fixture cleanup failed')
})

describe('overwrite migration', () => {
  it('moves the conversation to SQLite, keeps the id, and sets the old log aside', async () => {
    const base = await makeDir('dsh-migrate-')
    const jsonlRoot = join(base, 'jsonl')
    const sqliteRoot = join(base, 'sqlite')
    const stateDirectory = join(base, 'state')
    await seedJsonl(jsonlRoot, 'session-keep-id')

    const catalog = await SessionBackendCatalog.open(stateDirectory)
    const source = await backendOf(jsonlRoot, 'jsonl')
    const target = await backendOf(sqliteRoot, 'sqlite')

    const report = await runMigration(catalog, source, target, { mode: 'overwrite', verify: true })

    expect(report.status).toBe('completed')
    expect(report.items).toHaveLength(1)
    expect(report.items[0]?.status).toBe('migrated')
    expect(report.items[0]?.targetSession).toBe('session-keep-id')
    expect(report.items[0]?.expected).toBe(2)
    expect(report.items[0]?.transferred).toBe(2)
    expect(report.items[0]?.cwd).toBe('/work/migrate')

    // The copy holds every event, in order, and the id did not change.
    const stored = sqliteEvents(databasePath(sqliteRoot, '/work/migrate', 'session-keep-id' as SessionId))
    expect(stored.header?.id).toBe('session-keep-id')
    expect(stored.events.map((event) => [event.type, event.seq])).toEqual([
      ['turn/start', 0],
      ['turn/end', 1],
    ])

    // The conversation left the source library: an overwrite replaces the log, so
    // the same id is not readable from two backends at once.
    expect(existsSync(sessionDir(jsonlRoot, '/work/migrate', 'session-keep-id' as SessionId))).toBe(false)
    const archived = report.items[0]?.archivedTo
    expect(archived).toBeDefined()
    expect(existsSync(join(archived as string, 'session.v4.jsonl'))).toBe(true)

    // The route moved, so the router sends this id to SQLite from now on.
    const document = JSON.parse(await readFile(catalogPath(stateDirectory), 'utf8')) as {
      sessions: Record<string, { backend: string; migrationId: string; sourceBackend: string; targetBackend: string }>
    }
    const entry = document.sessions['session-keep-id']
    expect(entry?.backend).toBe('sqlite')
    expect(entry?.migrationId).toBe(report.migrationId)
    expect(entry?.sourceBackend).toBe('jsonl')
    expect(entry?.targetBackend).toBe('sqlite')
  })

  it('reports a session the source does not hold instead of migrating nothing quietly', async () => {
    const base = await makeDir('dsh-migrate-')
    const jsonlRoot = join(base, 'jsonl')
    const sqliteRoot = join(base, 'sqlite')
    await seedJsonl(jsonlRoot, 'session-only-one')

    const catalog = await SessionBackendCatalog.open(join(base, 'state'))
    const source = await backendOf(jsonlRoot, 'jsonl')
    const target = await backendOf(sqliteRoot, 'sqlite')

    const report = await runMigration(catalog, source, target, {
      mode: 'overwrite',
      verify: true,
      session: 'session-absent',
    })

    expect(report.status).toBe('failed')
    expect(report.items).toHaveLength(0)
    expect(report.error).toContain('does not hold "session-absent"')
  })

  it('refuses to run when both sides are the same backend', async () => {
    const base = await makeDir('dsh-migrate-')
    const jsonlRoot = join(base, 'jsonl')
    await seedJsonl(jsonlRoot, 'session-same')

    const catalog = await SessionBackendCatalog.open(join(base, 'state'))
    const source = await backendOf(jsonlRoot, 'jsonl')

    await expect(
      runMigration(catalog, source, source, { mode: 'overwrite', verify: true }),
    ).rejects.toThrow(/a migration needs two backends/)
  })
})

describe('clone migration', () => {
  it('assigns a new session id and records where the copy came from', async () => {
    const base = await makeDir('dsh-migrate-')
    const jsonlRoot = join(base, 'jsonl')
    const sqliteRoot = join(base, 'sqlite')
    const stateDirectory = join(base, 'state')
    await seedJsonl(jsonlRoot, 'session-origin')

    const catalog = await SessionBackendCatalog.open(stateDirectory)
    const source = await backendOf(jsonlRoot, 'jsonl')
    const target = await backendOf(sqliteRoot, 'sqlite')

    const report = await runMigration(catalog, source, target, {
      mode: 'clone',
      verify: true,
      newSessionId: 'session-clone-1',
    })

    expect(report.status).toBe('completed')
    expect(report.items[0]?.sourceSession).toBe('session-origin')
    expect(report.items[0]?.targetSession).toBe('session-clone-1')

    const stored = sqliteEvents(databasePath(sqliteRoot, '/work/migrate', 'session-clone-1' as SessionId))
    expect(stored.header?.id).toBe('session-clone-1')
    // Every original event is preserved; only the new conversation is renamed.
    expect(stored.events.slice(0, -1).map((event) => event.type)).toEqual(['turn/start', 'turn/end'])
    expect(stored.events.at(-1)).toMatchObject({ type: 'session/title', seq: 2, data: { title: '副本-未命名' } })

    // Both logs are live: the original is still on disk under its own id.
    expect(existsSync(join(sessionDir(jsonlRoot, '/work/migrate', 'session-origin' as SessionId), 'session.v4.jsonl'))).toBe(true)

    const document = JSON.parse(await readFile(catalogPath(stateDirectory), 'utf8')) as {
      sessions: Record<string, { backend: string; originSessionId?: string; clonedAt?: number }>
    }
    expect(document.sessions['session-clone-1']?.backend).toBe('sqlite')
    expect(document.sessions['session-clone-1']?.originSessionId).toBe('session-origin')
    expect(typeof document.sessions['session-clone-1']?.clonedAt).toBe('number')
  })

  it('produces a conversation the session list can enumerate', async () => {
    // The point of a clone is a new row in the conversation list, not a second
    // file. The list is fed by the persistence `list()` the router exposes, so
    // the target root has to report the copy with the id, cwd and title a list
    // entry needs — a `cwd`-less header is dropped by the Host before it reaches
    // the sidebar.
    const base = await makeDir('dsh-migrate-')
    const jsonlRoot = join(base, 'jsonl')
    const sqliteRoot = join(base, 'sqlite')
    await seedJsonl(jsonlRoot, 'session-listed', '/work/migrate')

    const catalog = await SessionBackendCatalog.open(join(base, 'state'))
    const source = await backendOf(jsonlRoot, 'jsonl')
    const target = await backendOf(sqliteRoot, 'sqlite')

    await runMigration(catalog, source, target, {
      mode: 'clone',
      verify: true,
      newSessionId: 'session-listed-copy',
    })

    const listed = await sourceSessions(target)
    const row = listed.find((entry) => entry.id === 'session-listed-copy')
    expect(row).toBeDefined()
    expect(row?.cwd).toBe('/work/migrate')
    expect(row?.eventCount).toBe(3)
    expect(row?.title).toBe('副本-未命名')
    expect(row?.problem).toBeUndefined()
    // The original stays listed too: a clone adds a conversation, it does not move one.
    expect(listed.some((entry) => entry.id === 'session-listed')).toBe(false)
  })

  it('refuses one fixed name for several copies instead of keeping only the last', async () => {
    // The picker lets an operator name the copy, and a run can cover a selection.
    // Both together would write every clone to the same id, so each copy would
    // land on the previous one and the result would claim more conversions than
    // the disk holds.
    const base = await makeDir('dsh-migrate-')
    const jsonlRoot = join(base, 'jsonl')
    const sqliteRoot = join(base, 'sqlite')
    await seedJsonl(jsonlRoot, 'session-a')
    await seedJsonl(jsonlRoot, 'session-b')

    const catalog = await SessionBackendCatalog.open(join(base, 'state'))
    const source = await backendOf(jsonlRoot, 'jsonl')
    const target = await backendOf(sqliteRoot, 'sqlite')

    const report = await runMigration(catalog, source, target, {
      mode: 'clone',
      verify: true,
      newSessionId: 'session-shared',
    })

    expect(report.status).toBe('failed')
    expect(report.error).toMatch(/names one copy, but 2 sessions/)
    expect(report.items).toHaveLength(0)
    expect(existsSync(databasePath(sqliteRoot, '/work/migrate', 'session-shared' as SessionId))).toBe(false)
  })
})

describe('sqlite_to_jsonl overwrite', () => {
  it('hands the conversation back to the JSONL root and sets the store aside', async () => {
    // The reverse direction matters as much as the forward one: a profile that
    // switches back must end up with the official provider reading the
    // conversation, not with two logs that disagree about which is current.
    const base = await makeDir('dsh-migrate-')
    const sqliteRoot = join(base, 'sqlite')
    const jsonlRoot = join(base, 'jsonl')
    await seedSqlite(sqliteRoot, 'session-back')

    const catalog = await SessionBackendCatalog.open(join(base, 'state'))
    const source = await backendOf(sqliteRoot, 'sqlite')
    const target = await backendOf(jsonlRoot, 'jsonl')

    const report = await runMigration(catalog, source, target, { mode: 'overwrite', verify: true })

    expect(report.status).toBe('completed')
    expect(report.items[0]?.targetSession).toBe('session-back')
    expect(report.items[0]?.transferred).toBe(2)

    // The official provider can open it, which is the only proof that matters.
    const handle = await target.persistence?.open('session-back' as SessionId, 'read')
    const read = await handle?.read()
    expect(read?.events.map((event) => event.type)).toEqual(['turn/start', 'turn/end'])
    await handle?.close()

    // The store is out of the live library and parked under the backup root.
    expect(existsSync(databasePath(sqliteRoot, '/work/migrate', 'session-back' as SessionId))).toBe(false)
    expect(report.items[0]?.archivedTo).toBeDefined()
  })
})

describe('archiveSource', () => {
  it('parks a store without deleting it, so a mistaken migration is reversible', async () => {
    const base = await makeDir('dsh-migrate-')
    const sqliteRoot = join(base, 'sqlite')
    await seedSqlite(sqliteRoot, 'session-park')
    const source = await backendOf(sqliteRoot, 'sqlite')

    const parked = await archiveSource(source, 'session-park', 'mig-test')
    expect(parked).toBeDefined()
    expect(existsSync(join(parked as string, 'session.db'))).toBe(true)
    expect(existsSync(databasePath(sqliteRoot, '/work/migrate', 'session-park' as SessionId))).toBe(false)

    // Nothing left to move: the second call reports that instead of failing.
    expect(await archiveSource(source, 'session-park', 'mig-test')).toBeUndefined()
  })
})

/**
 * Write a log the way a Windows host left it, bypassing this host's writer.
 *
 * The provider refuses to *create* a header whose cwd is absolute for another
 * platform, which is exactly the situation a real migration starts from: the log
 * already exists, written on machine A, and is being read on machine B. Writing
 * the lines directly is the only way to build that fixture here.
 */
async function seedForeignJsonl(root: string, id: string, cwd: string): Promise<void> {
  const directory = sessionDir(root, cwd, id as SessionId)
  await ensureSessionDirectory(directory)
  const lines = [JSON.stringify({ type: 'session', ...headerOf(id, cwd) })]
  for (const event of oneTurn()) lines.push(JSON.stringify(event))
  await writeFile(join(directory, 'session.v4.jsonl'), `${lines.join('\n')}\n`)
}

describe('cwd on the host that opens the copy', () => {
  it('stores a conversation written on Windows under a path this host accepts', async () => {
    // The source log records `C:\APP\x`, which `path.isAbsolute` rejects here, so
    // a store copying it verbatim opens as corrupt — every event intact and the
    // conversation unreadable. The migration therefore translates the cwd, and the
    // proof is that the store reads back with an absolute path on this host.
    const base = await makeDir('dsh-migrate-')
    const jsonlRoot = join(base, 'jsonl')
    const sqliteRoot = join(base, 'sqlite')
    await seedForeignJsonl(jsonlRoot, 'session-windows', 'C:\\APP\\jjm-server-plus')

    const catalog = await SessionBackendCatalog.open(join(base, 'state'))
    const source = await backendOf(jsonlRoot, 'jsonl')
    const target = await backendOf(sqliteRoot, 'sqlite')

    const report = await runMigration(catalog, source, target, { mode: 'overwrite', verify: true })
    expect(report.status).toBe('completed')
    expect(report.items[0]?.status).toBe('migrated')

    const cwd = report.items[0]?.cwd
    expect(cwd).toBeDefined()
    expect(isAbsolute(cwd as string)).toBe(true)
    expect(cwd).not.toContain('\\')

    // The store reads back through its own validator, which is the check the
    // runtime applies when a conversation is opened from the list.
    const stored = sqliteEvents(databasePath(sqliteRoot, cwd, 'session-windows' as SessionId))
    expect(stored.header?.cwd).toBe(cwd)
    expect(stored.events.map((event) => event.type)).toEqual(['turn/start', 'turn/end'])

    const listed = await sourceSessions(target)
    const row = listed.find((entry) => entry.id === 'session-windows')
    expect(row?.cwd).toBe(cwd)
    expect(row?.problem).toBeUndefined()
    expect(row?.eventCount).toBe(2)
  })

  it('refuses a relative cwd instead of hiding the conversation it wrote', async () => {
    const base = await makeDir('dsh-migrate-')
    const target = join(base, 'session.db')
    const copy: LogCopy = {
      header: headerOf('session-relative', 'relative/path'),
      inheritedEventCount: 0,
      events: oneTurn(),
    }

    expect(() => storableHeader(copy.header)).toThrow(/is not an absolute path on this host/)
    await expect(writeSqliteSession(target, copy)).rejects.toThrow(/is not an absolute path on this host/)
    expect(existsSync(target)).toBe(false)
  })
})

describe('source listing marks what the target already holds', () => {
  it('flags a conversation the other backend already stores', async () => {
    // Converting a conversation twice is the mistake this flag exists to stop:
    // the picker has to say «already in SQLite» rather than silently offering a
    // second copy that looks like the first conversion never happened.
    const base = await makeDir('dsh-migrate-')
    const jsonlRoot = join(base, 'jsonl')
    const sqliteRoot = join(base, 'sqlite')
    await seedJsonl(jsonlRoot, 'session-here')
    await seedJsonl(jsonlRoot, 'session-elsewhere')
    await seedSqlite(sqliteRoot, 'session-here')

    const listing = await listSourceRoot(
      { id: 'jsonl', root: jsonlRoot },
      { target: { id: 'sqlite', root: sqliteRoot } },
    )
    const marked = listing.sessions.find((entry) => entry.id === 'session-here')
    const plain = listing.sessions.find((entry) => entry.id === 'session-elsewhere')
    expect(marked?.inTarget).toBe(true)
    expect(plain?.inTarget).toBe(false)

    // Without a target the flag is absent, not false: a caller that asked
    // nothing must not be told the conversation is missing from a store it
    // never named.
    const bare = await listSourceRoot({ id: 'jsonl', root: jsonlRoot })
    expect(bare.sessions.every((entry) => entry.inTarget === undefined)).toBe(true)
  })

  it('counts a clone as converted, even though the copy has its own id', async () => {
    // A clone is a second conversation, so its id never appears on the source
    // side. Marking by id alone would leave the source looking untouched and the
    // operator would convert it again on the next visit; the catalog is what
    // remembers which copy came from which original.
    const base = await makeDir('dsh-migrate-')
    const jsonlRoot = join(base, 'jsonl')
    const sqliteRoot = join(base, 'sqlite')
    const stateDirectory = join(base, 'state')
    await seedJsonl(jsonlRoot, 'session-origin')
    await seedJsonl(jsonlRoot, 'session-untouched')

    const catalog = await SessionBackendCatalog.open(stateDirectory)
    const source = await backendOf(jsonlRoot, 'jsonl')
    const target = await backendOf(sqliteRoot, 'sqlite')
    await runMigration(catalog, source, target, {
      mode: 'clone',
      verify: true,
      sessions: ['session-origin'],
      newSessionId: 'session-origin-copy',
    })

    const listing = await listSourceRoot(
      { id: 'jsonl', root: jsonlRoot },
      { target: { id: 'sqlite', root: sqliteRoot }, catalog },
    )
    expect(listing.sessions.find((entry) => entry.id === 'session-origin')?.inTarget).toBe(true)
    expect(listing.sessions.find((entry) => entry.id === 'session-untouched')?.inTarget).toBe(false)
  })
})

describe('pruneSource', () => {
  it('removes the source only once the route points elsewhere', async () => {
    const base = await makeDir('dsh-migrate-')
    const jsonlRoot = join(base, 'jsonl')
    const sqliteRoot = join(base, 'sqlite')
    const stateDirectory = join(base, 'state')
    await seedJsonl(jsonlRoot, 'session-prune')

    const catalog = await SessionBackendCatalog.open(stateDirectory)
    const source = await backendOf(jsonlRoot, 'jsonl')
    const target = await backendOf(sqliteRoot, 'sqlite')

    // Before the migration the guard refuses: deleting here would leave no copy.
    await expect(pruneSource(catalog, source, 'session-prune')).rejects.toThrow(
      /not routed anywhere yet|still routed to jsonl/,
    )

    expect((await runMigration(catalog, source, target, { mode: 'overwrite', verify: true })).status).toBe('completed')

    // The overwrite already set the source log aside, so there is nothing to
    // prune; the call stays harmless instead of claiming a removal it did not do.
    expect(await pruneSource(catalog, source, 'session-prune')).toBe('absent')
    expect(existsSync(sessionDir(jsonlRoot, '/work/migrate', 'session-prune' as SessionId))).toBe(false)
  })
})
