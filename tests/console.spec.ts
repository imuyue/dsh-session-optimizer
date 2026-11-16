/**
 * Coverage for the console surface: the read-only inspector, the operator
 * preferences file, and the seven Fetch routes that expose them to the Web GUI.
 *
 * The routes are exercised through a fake transport that records each
 * registration, which is the same seam the real Host `connection` service
 * provides — so the assertions cover path, method and status handling without a
 * browser.
 *
 * The inspector is asked one question: what is in this root and is it healthy.
 * A session list, an event reader and a diagnostics page all existed once and
 * were removed with their routes; the tests for them went with them.
 *
 * @module dsh-session-optimizer/tests/console.spec
 */

import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import * as SqliteSessionPersistence from '../src/index.ts'
import { registerConsole, type ConsoleConfig } from '../src/console.ts'
import { databasePath } from '../src/format.ts'
import { METRIC_OPS, MetricsRegistry } from '../src/metrics.ts'
import { SCHEMA_VERSION } from '../src/schema.ts'
import { clearDiagnostics, recordDiagnostic } from '../src/diagnostics.ts'
import { inspectOverview, type InspectTarget } from '../src/inspect.ts'
import {
  createPreferencesHost,
  preferencesPath,
  readPreferences,
  type Preferences,
  type PreferencesHost,
  type SessionFormat,
} from '../src/preferences.ts'

const roots: string[] = []
const contexts: Context[] = []

const SETTINGS = { journalMode: 'wal', synchronous: 'full', busyTimeoutMs: 5000 } as const

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-console-'))
  roots.push(root)
  return root
}

function makeTarget(root: string): InspectTarget {
  return { root, settings: SETTINGS, storageThread: 'inline' }
}

function header(id: string, cwd: string): SessionHeader {
  return {
    version: 4,
    id: id as SessionId,
    createdAt: 1_700_000_000_000,
    cwd,
    isSeeded: false,
  } as SessionHeader
}

/**
 * Write one real session through the backend, so the files are authentic.
 *
 * Events are complete turns (`turn/start` + `turn/end`) because the session
 * format validator refuses a start without its end, and an unknown event type
 * fails closed. One turn is two rows.
 */
async function seedSession(root: string, id: string, cwd: string, turns = 2): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(SqliteSessionPersistence, { root, storageThread: 'inline' })
  contexts.push(ctx)
  const handle = await ctx.sessionPersistence.create(header(id, cwd))
  const events = Array.from({ length: turns }, (_, index) => [
    { type: 'turn/start', seq: index * 2, time: 1_700_000_000_000 + index * 2, data: { turn: index + 1 } },
    {
      type: 'turn/end',
      seq: index * 2 + 1,
      time: 1_700_000_000_001 + index * 2,
      data: { turn: index + 1, reason: { kind: 'completed' } },
    },
  ]).flat()
  await handle.append(events)
  await handle.close()
}

/**
 * Write one JSONL log by hand.
 *
 * The listing reads artifacts the way a migration source does — directory walk
 * plus a streaming scan — so the file only has to be a valid log, not one the
 * provider just wrote. Writing the lines directly keeps this fixture free of a
 * second mounted backend.
 */
async function seedJsonlRoot(root: string, id: string, cwd: string): Promise<void> {
  const directory = join(root, `--${cwd.replaceAll('/', '-').replace(/^-+|-+$/g, '')}--`, id)
  await mkdir(directory, { recursive: true })
  const lines = [
    JSON.stringify({ type: 'session', ...header(id, cwd) }),
    JSON.stringify({ type: 'turn/start', seq: 0, time: 1_700_000_000_001, data: { turn: 1 } }),
    JSON.stringify({ type: 'turn/end', seq: 1, time: 1_700_000_000_002, data: { turn: 1, reason: { kind: 'completed' } } }),
  ]
  await writeFile(join(directory, 'session.v4.jsonl'), `${lines.join('\n')}\n`)
}

interface Route {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody: string
  readonly fetch: (request: Request) => Promise<Response>
}

/** Mount the routes on a stub transport and index them by path. */
function mountRoutes(config: ConsoleConfig): Map<string, Route> {
  const routes = new Map<string, Route>()
  const ctx = {
    connection: {
      fetch: {
        register: (route: Route): (() => Promise<void>) => {
          routes.set(route.path, route)
          return async () => { routes.delete(route.path) }
        },
      },
    },
  } as unknown as Context
  registerConsole(ctx, config)
  return routes
}

async function call(
  routes: Map<string, Route>,
  path: string,
  query = '',
): Promise<{ status: number; body: Record<string, unknown> }> {
  const route = routes.get(path)
  if (route === undefined) throw new Error(`route ${path} was not registered`)
  const response = await route.fetch(new Request(`http://host${path}${query}`))
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

/** POST a JSON body to one route. */
async function post(
  routes: Map<string, Route>,
  path: string,
  payload: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const route = routes.get(path)
  if (route === undefined) throw new Error(`route ${path} was not registered`)
  const response = await route.fetch(
    new Request(`http://host${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

afterEach(async () => {
  const failures: unknown[] = []
  for (const ctx of contexts.splice(0)) {
    try {
      await ctx.fiber.dispose()
    } catch (error) {
      failures.push(error)
    }
  }
  for (const root of roots.splice(0)) {
    try {
      await rm(root, { recursive: true, force: true })
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'console fixture cleanup failed')
})

describe('inspect', () => {
  it('lists usage per conversation, largest first, with no problems', async () => {
    const root = await makeRoot()
    await seedSession(root, 'session-one', '/work/demo', 3)
    await seedSession(root, 'session-two', '/work/demo', 9)

    const overview = inspectOverview(makeTarget(root))
    // Largest first, so the table answers "what is taking the room" unaided.
    // Equal sizes fall back to the id, which is why the order is asserted as a
    // sort rather than as a fixed pair: two stores can round to the same size.
    const sizes = overview.usage.map((row) => row.sizeBytes)
    expect(sizes).toEqual([...sizes].sort((left, right) => right - left))
    expect(overview.usage.map((row) => row.id).sort()).toEqual(['session-one', 'session-two'])
    for (const row of overview.usage) {
      expect(row.state).toBe('ready')
      expect(row.problem).toBeUndefined()
      expect(row.sizeBytes).toBeGreaterThan(0)
    }
    const events = new Map(overview.usage.map((row) => [row.id, row.eventCount]))
    expect(events.get('session-two')).toBe(18)
    expect(events.get('session-one')).toBe(6)
    expect(overview.sessions).toBe(2)
    expect(overview.events).toBe(24)
  })

  it('never creates files: an absent root stays absent', async () => {
    const parent = await makeRoot()
    const root = join(parent, 'not-created')
    const overview = inspectOverview(makeTarget(root))
    expect(overview.sessions).toBe(0)
    expect(overview.usage).toEqual([])
  })

  it('reports a foreign file as a problem without throwing or hiding siblings', async () => {
    const root = await makeRoot()
    await seedSession(root, 'session-good', '/work/demo', 1)
    const foreign = databasePath(root, '/work/demo', 'session-foreign' as SessionId)
    await mkdir(dirname(foreign), { recursive: true })
    const db = new DatabaseSync(foreign)
    db.exec('CREATE TABLE unrelated (x INTEGER)')
    db.close()

    const overview = inspectOverview(makeTarget(root))
    expect(overview.usage).toHaveLength(2)
    expect(overview.damaged).toBe(1)
    const good = overview.usage.find((row) => row.id === 'session-good')
    expect(good?.problem).toBeUndefined()
    const bad = overview.usage.find((row) => row.id !== 'session-good')
    expect(bad?.problem).toMatch(/^not a dsh-session-optimizer store: application_id is 0, expected /)
  })

  it('flags a directory whose name does not encode its stored id', async () => {
    const root = await makeRoot()
    await seedSession(root, 'session-moved', '/work/demo', 1)
    const original = databasePath(root, '/work/demo', 'session-moved' as SessionId)
    const renamed = join(dirname(dirname(original)), 'not-the-encoded-id', 'session.db')
    await rename(dirname(original), dirname(renamed))

    // The id lives in the header, so the conversation is still listed under its
    // real id; only the directory name is wrong, which is what gets flagged.
    const overview = inspectOverview(makeTarget(root))
    expect(overview.usage).toHaveLength(1)
    expect(overview.usage[0]?.id).toBe('session-moved')
    expect(overview.usage[0]?.problem).toMatch(/directory name|stored under/)
  })

  it('reports the pragmas, the root mode and the totals for a healthy store', async () => {
    const root = await makeRoot()
    await seedSession(root, 'session-a', '/work/demo', 2)
    await seedSession(root, 'session-b', '/work/demo', 4)

    const overview = inspectOverview(makeTarget(root))
    expect(overview.sessions).toBe(2)
    expect(overview.ready).toBe(2)
    expect(overview.importing).toBe(0)
    expect(overview.damaged).toBe(0)
    expect(overview.events).toBe(12)
    expect(overview.applicationId).toBe(0x44534853)
    expect(overview.schemaVersion).toBe(SCHEMA_VERSION)
    expect(overview.journalMode).toBe('wal')
    expect(overview.synchronous).toBe('full')
    expect(overview.busyTimeoutMs).toBe(5000)
    expect(overview.rootMode).toMatch(/^0[0-7]{3}$/)
    expect(overview.databaseBytes).toBeGreaterThan(0)
  })
})

describe('console routes', () => {
  const OVERVIEW = '/api/session-optimizer/overview'
  const METRICS = '/api/session-optimizer/metrics'
  const SEARCH = '/api/session-optimizer/search'
  const MIGRATIONS = '/api/session-optimizer/migrations'
  const MIGRATE = '/api/session-optimizer/migrate'
  const ROOTS = '/api/session-optimizer/roots'
  const SOURCE = '/api/session-optimizer/source'
  const SETTINGS_ROUTE = '/api/session-optimizer/settings'
  const DIAGNOSTICS = '/api/session-optimizer/diagnostics'
  const DIAGNOSTICS_CLEAR = '/api/session-optimizer/diagnostics/clear'
  const UNINSTALL_CHECK = '/api/session-optimizer/uninstall-check'

  it('registers the five views they serve, and nothing else', async () => {
    const root = await makeRoot()
    const routes = mountRoutes({ root, ...makeTarget(root) })
    // The session list and the event reader are gone; their routes went with
    // them, so an unread endpoint cannot rot here.
    expect([...routes.keys()].sort()).toEqual(
      [OVERVIEW, METRICS, SEARCH, MIGRATIONS, '/api/session-optimizer/migrations/clear', MIGRATE, ROOTS, SOURCE, SETTINGS_ROUTE, DIAGNOSTICS, DIAGNOSTICS_CLEAR, UNINSTALL_CHECK, '/api/session-optimizer/titles', '/api/session-optimizer/workspace-memberships', '/api/session-optimizer/update', '/api/session-optimizer/performance', '/api/session-optimizer/performance/client-report', '/api/session-optimizer/performance/disable', '/api/session-optimizer/history-preview'].sort(),
    )
    for (const [path, route] of routes) {
      expect(route.requestBody).toBe('buffered')
      // `/settings` is the one path that both reads and writes; the other writes
      // are the migration start and clearing the diagnostic ring.
      const expected = path === '/api/session-optimizer/migrations/clear' || path === MIGRATE || path === DIAGNOSTICS_CLEAR || path.endsWith('/performance/disable') || path.endsWith('/performance/client-report')
        ? ['POST']
        : path === SETTINGS_ROUTE || path.endsWith('/performance') ? ['GET', 'POST'] : ['GET']
      expect(route.methods).toEqual(expected)
    }
  })

  it('answers the overview with totals, pragmas and one row per conversation', async () => {
    const root = await makeRoot()
    await seedSession(root, 'session-route', '/work/demo', 4)
    const routes = mountRoutes({ root, ...makeTarget(root) })

    const overview = await call(routes, OVERVIEW)
    expect(overview.status).toBe(200)
    expect(overview.body.sessions).toBe(1)
    expect(overview.body.events).toBe(8)
    expect(overview.body.journalMode).toBe('wal')
    expect(overview.body.rootMode).toMatch(/^0[0-7]{3}$/)
    const usage = overview.body.usage as Array<{ id: string; eventCount: number }>
    expect(usage).toHaveLength(1)
    expect(usage[0]?.id).toBe('session-route')
    expect(usage[0]?.eventCount).toBe(8)
  })

  it('reports real latencies, or says there are none', async () => {
    const root = await makeRoot()
    await seedSession(root, 'session-metrics', '/work/demo', 2)
    const routes = mountRoutes({ root, ...makeTarget(root) })

    const absent = await call(routes, METRICS)
    expect(absent.status).toBe(200)
    expect(absent.body.available).toBe(false)

    const registry = new MetricsRegistry()
    await registry.time('read', async () => { await Promise.resolve() })
    const withMetrics = mountRoutes({ root, ...makeTarget(root), metrics: registry })
    const answered = await call(withMetrics, METRICS)
    expect(answered.status).toBe(200)
    expect(answered.body.available).toBe(true)
    const snapshot = answered.body.snapshot as {
      count: number
      errors: number
      ops: Array<{ op: string; count: number }>
    }
    expect(snapshot.ops.map((series) => series.op)).toEqual([...METRIC_OPS])
    expect(snapshot.ops.find((series) => series.op === 'read')?.count).toBe(1)
    // The header reads "N samples in the last five minutes", so N counts the
    // window rather than the process lifetime.
    expect(snapshot.count).toBe(1)
    expect(snapshot.errors).toBe(0)
  })

  it('stops counting samples once they leave the window', () => {
    const registry = new MetricsRegistry()
    registry.observe('read', 1.5, true)
    registry.observe('read', 2.5, false)

    const live = registry.snapshot()
    expect(live.count).toBe(2)
    expect(live.errors).toBe(1)

    // Ten minutes later the same two samples are still retained in their rings,
    // but the summary must not claim them for a five-minute window.
    const stale = registry.snapshot(Date.now() + 10 * 60_000)
    expect(stale.count).toBe(0)
    expect(stale.errors).toBe(0)
    expect(stale.ops.every((series) => series.count === 0)).toBe(true)
  })

  it('marks responses no-store so the browser never caches a snapshot', async () => {
    const root = await makeRoot()
    const routes = mountRoutes({ root, ...makeTarget(root) })
    const route = routes.get(OVERVIEW)
    const response = await route?.fetch(new Request(`http://host${OVERVIEW}`))
    expect(response?.headers.get('cache-control')).toBe('no-store')
    expect(response?.headers.get('content-type')).toContain('application/json')
  })

  it('reports that a single-backend profile cannot migrate, and refuses to start one', async () => {
    // Migrating changes which backend owns a session. With one backend mounted
    // there is no target, so the view must say so instead of failing per session.
    const root = await makeRoot()
    const routes = mountRoutes({ root, ...makeTarget(root) })

    const listed = await call(routes, MIGRATIONS)
    expect(listed.status).toBe(200)
    expect(listed.body.available).toBe(false)
    expect(listed.body.jobs).toEqual([])

    const refused = await post(routes, MIGRATE, { direction: 'jsonl_to_sqlite', mode: 'overwrite' })
    expect(refused.status).toBe(409)
    expect(String(refused.body.error)).toContain('hybrid')

    expect((await call(routes, MIGRATIONS, '?id=absent')).status).toBe(404)
  })

  it('rejects a migration request whose content type is not JSON', async () => {
    const root = await makeRoot()
    const routes = mountRoutes({ root, ...makeTarget(root) })
    const route = routes.get(MIGRATE)
    const response = await route?.fetch(
      new Request(`http://host${MIGRATE}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ direction: 'jsonl_to_sqlite', mode: 'overwrite' }),
      }),
    )
    expect(response?.status).toBe(415)
  })

  it('tells the listing which conversations the other backend already holds', async () => {
    // The picker's «already in SQLite» mark comes from this route: the browser
    // sends only a root, so the Host has to pair it with the opposite one.
    const sqliteRoot = await makeRoot()
    const jsonlRoot = await makeRoot()
    await seedSession(sqliteRoot, 'session-stored', '/work/demo', 1)
    await seedJsonlRoot(jsonlRoot, 'session-stored', '/work/demo')
    await seedJsonlRoot(jsonlRoot, 'session-loose', '/work/demo')

    const routes = mountRoutes({ root: sqliteRoot, ...makeTarget(sqliteRoot), jsonlRoot })
    const answer = await call(routes, SOURCE, `?backend=jsonl&root=${encodeURIComponent(jsonlRoot)}`)
    expect(answer.status).toBe(200)
    const sessions = answer.body.sessions as Array<{ id: string; inTarget?: boolean }>
    expect(sessions.find((entry) => entry.id === 'session-stored')?.inTarget).toBe(true)
    expect(sessions.find((entry) => entry.id === 'session-loose')?.inTarget).toBe(false)
  })
})

describe('the settings route', () => {
  const SETTINGS_ROUTE = '/api/session-optimizer/settings'

  /**
   * A preference store over a fresh directory, plus what it applied.
   *
   * `formats` is passed to the store and to the route together, because the
   * store is the authority that rejects an unusable format: a test that gave the
   * two different lists would be testing a configuration the Host never builds
   * (`mountStandalone` and `mountHybrid` both derive both from `formatsOf`).
   */
  function makeStore(formats: readonly SessionFormat[] = ['sqlite', 'jsonl']): {
    readonly directory: string
    readonly applied: Preferences[]
    readonly host: PreferencesHost
  } {
    const directory = join(tmpdir(), `dsh-sqlite-prefs-${Math.random().toString(36).slice(2)}`)
    const applied: Preferences[] = []
    const host = createPreferencesHost(preferencesPath(directory), formats, (saved) => {
      applied.push(saved)
    })
    return { directory, applied, host }
  }

  it('reports that a mount without a store cannot offer the switches', async () => {
    const root = await makeRoot()
    const routes = mountRoutes({ root, ...makeTarget(root) })
    const answer = await call(routes, SETTINGS_ROUTE)
    expect(answer.status).toBe(200)
    expect(answer.body.available).toBe(false)
    expect(answer.body.formats).toEqual([])
    expect(String(answer.body.reason)).toContain('preference store')
  })

  it('answers the switches in force and the formats this install can serve', async () => {
    const root = await makeRoot()
    const store = makeStore()
    roots.push(store.directory)
    const routes = mountRoutes({
      root,
      ...makeTarget(root),
      preferences: { host: store.host, formats: ['sqlite', 'jsonl'] },
    })

    const answer = await call(routes, SETTINGS_ROUTE)
    expect(answer.status).toBe(200)
    expect(answer.body.available).toBe(true)
    expect(answer.body.formats).toEqual(['sqlite', 'jsonl'])
    expect(answer.body.preferences).toEqual({ format: 'sqlite', stabilityFixes: true, language: 'zh', performance: { enabled: false, historyWindow: false, virtualChat: false } })
    // The store applies what it read before the first request, so the running
    // backend is already on the saved switches rather than the compiled defaults.
    expect(store.applied).toHaveLength(1)
  })

  it('writes one patch, applies it, and answers with the result in force', async () => {
    const root = await makeRoot()
    const store = makeStore()
    roots.push(store.directory)
    const routes = mountRoutes({
      root,
      ...makeTarget(root),
      preferences: { host: store.host, formats: ['sqlite', 'jsonl'] },
    })

    const written = await post(routes, SETTINGS_ROUTE, { format: 'jsonl' })
    expect(written.status).toBe(200)
    expect(written.body).toEqual({ format: 'jsonl', stabilityFixes: true, language: 'zh', performance: { enabled: false, historyWindow: false, virtualChat: false } })
    // Persisted, not just held: a restart reads the same file.
    expect(readPreferences(preferencesPath(store.directory)).format).toBe('jsonl')
    // And applied: the last call the backend saw carries the new format.
    expect(store.applied.at(-1)?.format).toBe('jsonl')
    expect(store.applied.at(-1)?.stabilityFixes).toBe(true)

    const second = await post(routes, SETTINGS_ROUTE, { stabilityFixes: false })
    expect(second.body).toEqual({ format: 'jsonl', stabilityFixes: false, language: 'zh', performance: { enabled: false, historyWindow: false, virtualChat: false } })
  })

  it('refuses a value it cannot honour and leaves the file untouched', async () => {
    const root = await makeRoot()
    // A standalone install serves SQLite only, so JSONL must be refused rather
    // than written and silently ignored on the next append.
    const store = makeStore(['sqlite'])
    roots.push(store.directory)
    const routes = mountRoutes({
      root,
      ...makeTarget(root),
      preferences: { host: store.host, formats: ['sqlite'] },
    })

    const refused = await post(routes, SETTINGS_ROUTE, { format: 'jsonl' })
    expect(refused.status).toBe(400)
    expect(readPreferences(preferencesPath(store.directory)).format).toBe('sqlite')

    const nonsense = await post(routes, SETTINGS_ROUTE, { stabilityFixes: 'yes' })
    expect(nonsense.status).toBe(400)

    const empty = await post(routes, SETTINGS_ROUTE, {})
    expect(empty.status).toBe(400)
  })

  it('rejects a non-JSON body and a missing store', async () => {
    const root = await makeRoot()
    const store = makeStore(['sqlite'])
    roots.push(store.directory)
    const routes = mountRoutes({
      root,
      ...makeTarget(root),
      preferences: { host: store.host, formats: ['sqlite'] },
    })
    const route = routes.get(SETTINGS_ROUTE)
    const plain = await route?.fetch(
      new Request(`http://host${SETTINGS_ROUTE}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'format=jsonl',
      }),
    )
    expect(plain?.status).toBe(415)

    const bare = mountRoutes({ root, ...makeTarget(root) })
    const refused = await post(bare, SETTINGS_ROUTE, { format: 'sqlite' })
    expect(refused.status).toBe(409)
  })

  it('blames the caller only for a value, not for a write it could not make', async () => {
    const root = await makeRoot()
    // A state directory the process cannot write to (a read-only mount, a full
    // disk) is a server fault: a 400 would send the operator hunting for a typo
    // in a body that was perfectly valid.
    const broken: PreferencesHost = {
      read: () => ({ format: 'sqlite', stabilityFixes: true, language: 'zh', performance: { enabled: false, historyWindow: false, virtualChat: false } }),
      update: () => {
        throw new Error('ENOSPC: no space left on device')
      },
    }
    const routes = mountRoutes({
      root,
      ...makeTarget(root),
      preferences: { host: broken, formats: ['sqlite'] },
    })
    const answer = await post(routes, SETTINGS_ROUTE, { stabilityFixes: false })
    expect(answer.status).toBe(500)
    expect(String(answer.body.error)).toContain('ENOSPC')
    // Named as a write, not as a bad body: the sentence the operator reads has to
    // point at the state directory they can fix.
    expect(String(answer.body.error)).toContain('cannot write the preferences file')
  })

  it('is a 500, not a 400, when the preferences path is a directory', async () => {
    const root = await makeRoot()
    // Reachable by a stale backup restored next to the state directory. The body
    // is valid; the destination is not.
    const directory = join(tmpdir(), `dsh-sqlite-prefs-dir-${Math.random().toString(36).slice(2)}`)
    roots.push(directory)
    await mkdir(preferencesPath(directory), { recursive: true })
    const host = createPreferencesHost(preferencesPath(directory), ['sqlite'], () => undefined)
    const routes = mountRoutes({
      root,
      ...makeTarget(root),
      preferences: { host, formats: ['sqlite'] },
    })
    const answer = await post(routes, SETTINGS_ROUTE, { language: 'en' })
    expect(answer.status).toBe(500)
    expect(String(answer.body.error)).toContain('cannot write the preferences file')
  })

  it('refuses a field that is not a setting', async () => {
    const root = await makeRoot()
    const store = makeStore()
    roots.push(store.directory)
    const routes = mountRoutes({
      root,
      ...makeTarget(root),
      preferences: { host: store.host, formats: ['sqlite', 'jsonl'] },
    })
    const answer = await post(routes, SETTINGS_ROUTE, { format: 'jsonl', nonsense: 1 })
    expect(answer.status).toBe(400)
    expect(String(answer.body.error)).toContain('nonsense')
    // A rejected request writes nothing, so the switch it half-named is unchanged.
    expect(readPreferences(preferencesPath(store.directory))).toEqual({
      format: 'sqlite',
      stabilityFixes: true,
      language: 'zh',
      performance: { enabled: false, historyWindow: false, virtualChat: false },
    })
  })

  it('asks for the version on every request instead of answering a mount-time snapshot', async () => {
    const root = await makeRoot()
    // "检查更新" re-requests this block; a snapshot would name the version from
    // before an in-place upgrade and then report it as up to date.
    let calls = 0
    const links = { repository: undefined, feedback: undefined, license: undefined }
    const routes = mountRoutes({
      root,
      ...makeTarget(root),
      about: () => {
        calls += 1
        return { pluginVersion: `0.1.${String(calls)}`, dshVersion: '0.2.2-rc.1', links }
      },
    })
    const first = await call(routes, SETTINGS_ROUTE)
    const second = await call(routes, SETTINGS_ROUTE)
    expect(first.body.about).toEqual({ pluginVersion: '0.1.1', dshVersion: '0.2.2-rc.1', links })
    expect(second.body.about).toEqual({ pluginVersion: '0.1.2', dshVersion: '0.2.2-rc.1', links })
    expect(calls).toBe(2)
  })
})

describe('the search route', () => {
  const SEARCH_ROUTE = '/api/session-optimizer/search'

  it('says so when this mount has nothing to search with', async () => {
    const root = await makeRoot()
    const routes = mountRoutes({ root, ...makeTarget(root) })
    const answer = await call(routes, SEARCH_ROUTE)
    expect(answer.status).toBe(200)
    expect(answer.body.available).toBe(false)
    expect(String(answer.body.reason)).toContain('no search')
  })

  it('returns the hits it was given, capped by the limit it was asked for', async () => {
    const root = await makeRoot()
    const asked: Array<[string, number]> = []
    const routes = mountRoutes({
      root,
      ...makeTarget(root),
      search: (query, limit) => {
        asked.push([query, limit])
        return Promise.resolve([
          { sessionId: 'session-one', seq: 3, type: 'user/message', time: 1, score: -1, snippet: '排位赛' },
        ])
      },
    })
    const answer = await call(routes, SEARCH_ROUTE, '?q=%E6%8E%92%E4%BD%8D&limit=5')
    expect(answer.status).toBe(200)
    expect(asked).toEqual([['排位', 5]])
    expect((answer.body.hits as unknown[]).length).toBe(1)
  })

  it('answers an empty query without asking the backend', async () => {
    const root = await makeRoot()
    let asked = 0
    const routes = mountRoutes({
      root,
      ...makeTarget(root),
      search: () => {
        asked += 1
        return Promise.resolve([])
      },
    })
    const answer = await call(routes, SEARCH_ROUTE, '?q=%20%20')
    expect(answer.status).toBe(200)
    expect(answer.body.hits).toEqual([])
    expect(asked).toBe(0)
  })

  it('refuses a limit that is not a positive integer', async () => {
    const root = await makeRoot()
    const routes = mountRoutes({
      root,
      ...makeTarget(root),
      search: () => Promise.resolve([]),
    })
    expect((await call(routes, SEARCH_ROUTE, '?q=x&limit=0')).status).toBe(400)
    expect((await call(routes, SEARCH_ROUTE, '?q=x&limit=-2')).status).toBe(400)
  })
})

describe('the diagnostics routes', () => {
  const DIAGNOSTICS = '/api/session-optimizer/diagnostics'
  const DIAGNOSTICS_CLEAR = '/api/session-optimizer/diagnostics/clear'

  it('hands back what the plugin recorded, and clears it', async () => {
    clearDiagnostics()
    const root = await makeRoot()
    const routes = mountRoutes({ root, ...makeTarget(root) })
    recordDiagnostic('warn', 'list', 'skipping "/x/session.db" while listing sessions: disk on fire')

    const listed = await call(routes, DIAGNOSTICS)
    expect(listed.status).toBe(200)
    const entries = listed.body.entries as Array<Record<string, unknown>>
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ level: 'warn', scope: 'list' })
    expect(String(entries[0].message)).toContain('disk on fire')

    const cleared = await post(routes, DIAGNOSTICS_CLEAR, {})
    expect(cleared.status).toBe(200)
    expect(cleared.body.cleared).toBe(1)
    expect((await call(routes, DIAGNOSTICS)).body.entries).toEqual([])
  })

  it('records a store the listing had to skip', async () => {
    clearDiagnostics()
    const root = await makeRoot()
    await seedSession(root, 'session-broken', '/work/demo', 1)
    // A file that is not a database: `list()` reports it and keeps going, which
    // is exactly the case an operator cannot see from a shorter session list.
    // The sidecars have to go first: a valid `-wal` carries full pages, so
    // SQLite recovers a readable database from a clobbered main file and the
    // store would simply list fine.
    const broken = databasePath(root, '/work/demo', 'session-broken' as SessionId)
    await rm(`${broken}-wal`, { force: true })
    await rm(`${broken}-shm`, { force: true })
    await writeFile(broken, 'not a database')

    const ctx = new Context()
    await ctx.plugin(SqliteSessionPersistence, { root, storageThread: 'inline' })
    contexts.push(ctx)
    await ctx.sessionPersistence.list()

    const routes = mountRoutes({ root, ...makeTarget(root) })
    const entries = (await call(routes, DIAGNOSTICS)).body.entries as Array<Record<string, unknown>>
    expect(entries.some((entry) => entry.scope === 'list')).toBe(true)
  })
})

describe('the uninstall check', () => {
  const UNINSTALL_CHECK = '/api/session-optimizer/uninstall-check'

  it('names the conversations an uninstall would hide', async () => {
    const root = await makeRoot()
    const jsonl = await makeRoot()
    await seedSession(root, 'session-kept', '/work/demo', 1)
    await seedSession(root, 'session-only-here', '/work/demo', 1)
    await seedJsonlRoot(jsonl, 'session-kept', '/work/demo')

    const routes = mountRoutes({ root, ...makeTarget(root), jsonlRoot: jsonl })
    const answer = await call(routes, UNINSTALL_CHECK)
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({ available: true, sqlite: 2, jsonl: 1, ok: false })
    expect(answer.body.orphaned).toEqual(['session-only-here'])
  })

  it('refuses to guess when the mount has no JSONL root', async () => {
    const root = await makeRoot()
    const routes = mountRoutes({ root, ...makeTarget(root) })
    const answer = await call(routes, UNINSTALL_CHECK)
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({ available: false })
    expect(String(answer.body.reason)).toContain('JSONL')
  })
})
