/**
 * Host half of the Web GUI console: exact Fetch routes under
 * `/api/session-optimizer/*` that report this backend's on-disk state, its real
 * latencies, and the conversation converter.
 *
 * The console shows four views — storage overview, conversation conversion,
 * latency, settings — so the routes are exactly what those four need. Anything
 * the removed views used to read (per-conversation summaries, raw event pages,
 * diagnostics) is gone from here as well as from the panel: an unread endpoint
 * is still maintained code.
 *
 * The routes are registered only when the profile also runs a Web GUI
 * (`connection` present), so a headless profile keeps the persistence backend
 * without carrying an unused surface. The read routes open session databases with
 * `readOnly: true` (see `inspect.ts`); the routes that write are `/migrate`,
 * which goes through the migration engine (`migrate.ts`) — stage, verify, then
 * publish — and `POST /settings`, which writes this plugin's own preferences
 * file and no session data at all.
 *
 * Exact routes on the shared `/api` channel are reachable by the owner Peer only;
 * every other principal is answered 403 by the transport itself.
 *
 * @module dsh-session-optimizer/console
 */

import type { Context } from '@deepseek-ai/cordis'
import { overlappingDirectories } from './path-identity.ts'
import type { WorkspaceMembershipSnapshot } from './migration-workspace.ts'
import type { PluginAbout } from './about.ts'
import { checkForUpdate } from './update.ts'
import type { SqliteSettings } from './database.ts'
import { discoverRoots } from './discover.ts'
import type { InspectTarget } from './inspect.ts'
import { inspectConsoleOverview } from './console-overview.ts'
import { pickerTitles } from './source-picker.ts'
import type { MetricsRegistry } from './metrics.ts'
import { PreferencesUsageError, type PreferencesHost, type SessionFormat } from './preferences.ts'
import { PerformanceConflictError, type PerformanceController } from './performance.ts'
import { registerPerformanceRpc, type PerformanceRpcRegistry } from './performance-rpc.ts'
import { PAGE_TRANSFER_POLICY } from './page-transfer.ts'
import type { PreviewReader } from './history-preview.ts'
import { clearDiagnostics, listDiagnostics, recordDiagnostic, uninstallCheck } from './diagnostics.ts'
import type { SearchHit } from './search.ts'
import {
  DEFAULT_MIGRATION_OPTIONS,
  listMigrations,
  clearMigrationHistory,
  listSourceRoot,
  migrationById,
  startMigration,
  type MigrationBackend,
  type MigrationHost,
  type MigrationMode,
  type MigrationOptions,
} from './migrate.ts'

/** Route prefix, absolute; the browser requests it relative to `document.baseURI`. */
export const CONSOLE_ROUTE_PREFIX = '/api/session-optimizer'

/**
 * The slice of the Host `connection` service this module uses.
 *
 * Declared locally on purpose: the persistence backend must not depend on the
 * Web transport package just to reach it, and `connection` is injected by name.
 */
interface ConsoleTransport {
  readonly rpc?: PerformanceRpcRegistry
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
      readonly requestBody: 'buffered' | 'streaming'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/** A context that has the `connection` service mounted. */
interface ConsoleContext extends Context {
  readonly connection: ConsoleTransport
}

/** What the console needs to resolve a target for one request. */
export interface ConsoleConfig {
  readonly root: string
  readonly settings: SqliteSettings
  readonly storageThread: 'worker' | 'inline'
  /** Live latency registry of the running backend; omitted when there is none. */
  readonly metrics?: MetricsRegistry | undefined
  /** JSONL root this profile came from, offered as the default export target. */
  readonly jsonlRoot?: string | undefined
  /**
   * Migration engine, present only when the profile runs both backends.
   *
   * A standalone install has nowhere to migrate to, so the route reports that
   * rather than offering a button that cannot work.
   */
  readonly migrations?: MigrationHost | undefined
  readonly workspaceMemberships?: ((ids: readonly string[]) => WorkspaceMembershipSnapshot | undefined) | undefined
  /**
   * The operator's own switches, present only when the mount created them.
   *
   * `formats` is the list this install can actually serve, so the panel can grey
   * out a card instead of offering a choice that would be silently ignored.
   */
  readonly preferences?:
    | { readonly host: PreferencesHost; readonly formats: readonly SessionFormat[] }
    | undefined
  /**
   * Version and links for the settings view; absent on a mount that has none.
   *
   * A thunk, not a value: "检查更新" re-requests this block, so a snapshot taken
   * at mount would report the version from before an in-place upgrade and then
   * let the panel claim to be up to date.
   */
  readonly about?: (() => PluginAbout) | undefined
  /**
   * Full-text search over this root's stores; absent when nothing can answer it.
   *
   * Returns hits already merged and ranked, so the route does no scoring of its
   * own and the inline and worker mounts answer identically.
   */
  readonly search?: ((query: string, limit: number) => Promise<SearchHit[]>) | undefined
  readonly performance?: PerformanceController | undefined
  readonly historyPreview?: Pick<PreviewReader, 'read'> | undefined
}

/** A JSON response a browser must never cache. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function failure(message: string, status: number): Response {
  // A 4xx is the caller's mistake and says nothing about the install; a 5xx is
  // ours, and the operator who opens the diagnostics tab is looking for exactly
  // that. The response body still carries the message for the caller.
  if (status >= 500) recordDiagnostic('error', 'console', message)
  return json({ error: message }, status)
}

/** `undefined` when absent, `null` when malformed. */
function numberParam(raw: string | null): number | undefined | null {
  if (raw === null || raw === '') return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) return null
  return value
}

/** Turn an unexpected failure into a 500 instead of a dropped socket. */
function guard(body: () => Response): Response {
  try {
    return body()
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error), 500)
  }
}

/** Read the JSON body of a POST, refusing anything that is not an object. */
async function bodyOf(request: Request): Promise<Record<string, unknown> | undefined> {
  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** `undefined` when absent, so "no selection" stays distinguishable from "empty selection". */
function stringListField(body: Record<string, unknown>, key: string): string[] | undefined {
  const value = body[key]
  if (!Array.isArray(value)) return undefined
  const listed = value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
  return listed
}

function flagField(body: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = body[key]
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Register the console routes.
 *
 * `connection` registers each route inside the caller's fiber, so disposing the
 * plugin removes them; the same path cannot be registered twice.
 */
export function registerConsole(ctx: Context, config: ConsoleConfig): void {
  const transport = (ctx as ConsoleContext).connection
  const target: InspectTarget = {
    root: config.root,
    settings: config.settings,
    storageThread: config.storageThread,
  }
  const register = (
    path: string,
    methods: readonly ('GET' | 'HEAD' | 'POST')[],
    fetch: (request: Request) => Promise<Response>,
  ): void => {
    transport.fetch.register({ path: `${CONSOLE_ROUTE_PREFIX}${path}`, methods, requestBody: 'buffered', fetch })
  }

  // One question, one answer: what is in this root and is it healthy. The panel
  // shows it as four totals, a space-usage table and the pragmas in force.
  register('/overview', ['GET'], async (request) => {
    const params = new URL(request.url).searchParams
    const offset = numberParam(params.get('offset')), limit = numberParam(params.get('limit'))
    if (offset === null || limit === null || (offset !== undefined && !Number.isSafeInteger(offset)) || limit === 0) return failure('invalid overview page', 400)
    let ids: string[] | undefined
    if (params.has('ids')) {
      try { const value: unknown = JSON.parse(params.get('ids')!); if (!Array.isArray(value) || value.length > 5 || !value.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256)) return failure('invalid title identities',400); ids = value as string[] } catch { return failure('invalid title identities',400) }
    }
    const parent = params.get('parent') ?? undefined
    if (parent !== undefined && (parent.length === 0 || parent.length > 256)) return failure('invalid parent identity',400)
    try { return json(await inspectConsoleOverview(target, config.jsonlRoot, config.migrations?.catalog, { offset: offset ?? 0, limit: limit ?? 50, signal: request.signal, titles: params.get('titles') === '1', ...(parent === undefined ? {} : { parent }), ...(ids === undefined ? {} : { ids }) })) }
    catch (error) { return failure(error instanceof Error ? error.message : String(error), 500) }
  })

  register('/titles', ['GET'], async request => {
    const params = new URL(request.url).searchParams
    let ids: string[]
    try {
      const value: unknown = JSON.parse(params.get('ids') ?? 'null')
      if (!Array.isArray(value) || value.length > 5 || !value.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256)) return failure('invalid title identities', 400)
      ids = [...new Set(value as string[])]
    } catch { return failure('invalid title identities', 400) }
    const root = params.get('root') || config.jsonlRoot
    if (root === undefined) return failure('this mount has no JSONL root', 400)
    try {
      const titles = await pickerTitles(root, new Set(ids), request.signal)
      return json({ titles: ids.map(id => { const value = titles.get(id); return value === undefined ? { id, removed: true, titlePending: false } : { id, ...value, titlePending: false } }) })
    } catch (error) { return failure(error instanceof Error ? error.message : String(error), 500) }
  })

  // Real latencies only: an empty registry reports empty series rather than
  // invented points, and the client says so instead of drawing a flat line.
  register('/metrics', ['GET'], () =>
    Promise.resolve(
      guard(() => {
        if (config.metrics === undefined) {
          return json({ available: false, reason: 'this profile has no metrics registry', snapshot: undefined })
        }
        return json({ available: !config.metrics.empty, snapshot: config.metrics.historySnapshot() })
      }),
    ))

  // Migrations, unlike nothing else here, change which backend owns a
  // conversation, so they are only offered when both backends are mounted.
  register('/search', ['GET'], async (request) => {
    const search = config.search
    if (search === undefined) {
      return json({ available: false, reason: 'this mount has no search of its own' })
    }
    const url = new URL(request.url)
    const query = url.searchParams.get('q') ?? ''
    if (query.trim() === '') return json({ available: true, query: '', hits: [] })
    const limit = numberParam(url.searchParams.get('limit'))
    if (limit === null || limit === 0) return failure('limit must be a positive integer', 400)
    const hits = await search(query, Math.min(limit ?? 20, 100))
    return json({ available: true, query, hits })
  })

  register('/migrations', ['GET'], (request: Request) => {
    const id = new URL(request.url).searchParams.get('id')
    return Promise.resolve(
      guard(() => {
        if (id === null || id === '') {
          return json({
            available: config.migrations !== undefined,
            jobs: listMigrations(),
            jsonlRoot: config.jsonlRoot,
            sqliteRoot: config.root,
          })
        }
        const job = migrationById(id)
        return job === undefined ? failure(`migration "${id}" is not known to this process`, 404) : json(job)
      }),
    )
  })

  register('/migrations/clear', ['POST'], async () => {
    try { return json(await clearMigrationHistory()) } catch (error) { return failure(error instanceof Error ? error.message : String(error), 500) }
  })

  // Every root this machine actually has, so the operator picks one instead of
  // typing a path from memory. Discovery only lists directories.
  register('/roots', ['GET'], async () => {
    try {
      const roots = await discoverRoots({ sqliteRoot: config.root, jsonlRoot: config.jsonlRoot })
      return json({ roots })
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error), 500)
    }
  })

  // What one root holds: id, title, event count and size per session, paged and
  // searchable. Reading a JSONL root means streaming its artifacts, so the Host
  // keeps the answer for a few seconds and `refresh=1` forces a rescan.
  register('/source', ['GET'], async (request: Request) => {
    const params = new URL(request.url).searchParams
    const backend = params.get('backend') === 'sqlite' ? 'sqlite' : 'jsonl'
    const root = params.get('root')
    if (root === null || root === '') return failure('the root parameter is required', 400)
    const parent = params.get('parent')
    if (parent !== null && (parent.length === 0 || parent.length > 256)) return failure('invalid parent session id', 400)
    const offset = numberParam(params.get('offset'))
    const limit = numberParam(params.get('limit'))
    if (offset === null || limit === null) {
      return failure('offset and limit must be non-negative integers', 400)
    }
    // `listSourceRoot` streams the root's artifacts, so the answer is awaited
    // here: serializing the promise itself would answer `{}`.
    try {
      const listing = await listSourceRoot(
        { id: backend, root },
        {
          ...(offset === undefined ? {} : { offset }),
          ...(limit === undefined ? {} : { limit }),
          ...(params.get('q') === null ? {} : { query: params.get('q') ?? '' }),
          refresh: params.get('refresh') === '1',
           summary: params.get('summary') === '1',
           grouped: params.get('grouped') === '1',
           ...(params.get('parent') === null ? {} : { parent: params.get('parent')! }),
          signal: request.signal,
          // The opposite root lets the listing say which conversations it already
          // holds: an operator who cannot see that converts the same conversation
          // twice and wonders why nothing changed.
          ...(backend === 'sqlite'
            ? config.jsonlRoot === undefined ? {} : { target: { id: 'jsonl', root: config.jsonlRoot } }
            : { target: { id: 'sqlite', root: config.root } }),
          // A clone carries a new id, so the copy alone cannot tell the source it
          // came from; the catalog recorded that origin at conversion time.
          ...(config.migrations === undefined ? {} : { catalog: config.migrations.catalog }),
        },
      )
      return json(listing)
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error), 500)
    }
  })

  register('/workspace-memberships', ['GET'], async request => {
    let ids: string[]
    try {
      const value: unknown = JSON.parse(new URL(request.url).searchParams.get('ids') ?? 'null')
      if (!Array.isArray(value) || value.length > 50 || !value.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256)) return failure('invalid session identities', 400)
      ids = [...new Set(value as string[])]
    } catch { return failure('invalid session identities', 400) }
    request.signal.throwIfAborted()
    const snapshot = config.workspaceMemberships?.(ids)
    return json({ available: snapshot !== undefined, memberships: snapshot?.memberships ?? [], workspaces: snapshot?.workspaces ?? [], dshVersion: config.about?.().dshVersion })
  })

  register('/migrate', ['POST'], async (request: Request) => {
    // Same reasoning as `/transfer`: only a JSON body requires a preflight.
    const contentType = request.headers.get('content-type') ?? ''
    if (!contentType.toLowerCase().startsWith('application/json')) {
      return failure('this endpoint accepts application/json bodies only', 415)
    }
    if (config.migrations === undefined) {
      return failure(
        'this profile runs a single backend, so there is nothing to migrate to; enable hybrid mode first',
        409,
      )
    }
    const host = config.migrations
    const body = await bodyOf(request)
    if (body === undefined) return failure('a JSON object body is required', 400)
    const direction = stringField(body, 'direction')
    if (direction !== 'jsonl_to_sqlite' && direction !== 'sqlite_to_jsonl') {
      return failure('direction must be "jsonl_to_sqlite" or "sqlite_to_jsonl"', 400)
    }
    const mode = stringField(body, 'mode') ?? 'overwrite'
    if (mode !== 'overwrite' && mode !== 'clone') {
      return failure('mode must be "overwrite" or "clone"', 400)
    }
    // The roots come from the picker, so both sides are the directories the
    // operator actually looked at — not whatever this profile happens to mount.
    const jsonlRoot = stringField(body, 'jsonlRoot') ?? config.jsonlRoot
    const sqliteRoot = stringField(body, 'sqliteRoot') ?? config.root
    if (jsonlRoot === undefined || jsonlRoot === '') {
      return failure('the JSONL root is unknown: pass jsonlRoot (this profile exposes no default)', 400)
    }
    if (await overlappingDirectories(jsonlRoot, sqliteRoot)) {
      return failure('the JSONL and SQLite roots are the same directory or contain one another', 400)
    }
    const sessions = stringListField(body, 'sessions')
    const options: MigrationOptions = {
      mode: mode as MigrationMode,
      verify: flagField(body, 'verify', DEFAULT_MIGRATION_OPTIONS.verify),
      ...(sessions === undefined ? {} : { sessions }),
      newSessionId: stringField(body, 'newSessionId'),
    }
    const jsonlEnd: MigrationBackend = { id: 'jsonl', root: jsonlRoot, persistence: host.jsonl.persistence }
    const sqliteEnd: MigrationBackend = { id: 'sqlite', root: sqliteRoot, persistence: host.sqlite.persistence }
    const ends = direction === 'jsonl_to_sqlite'
      ? { source: jsonlEnd, target: sqliteEnd }
      : { source: sqliteEnd, target: jsonlEnd }
    return guard(() => json(startMigration(host, direction, options, ends), 202))
  })

  // `about` is asked per request, not captured at mount: an in-place upgrade must
  // be visible without restarting the process. Guarded at runtime rather than
  // trusted from the type, because a JavaScript caller that still passes the old
  // snapshot object would otherwise throw inside this async handler, where nothing
  // turns the throw into a response.
  const aboutOf = (): PluginAbout | undefined => {
    const about = config.about
    return typeof about === 'function' ? about() : undefined
  }

  // A Root whose optional controls yielded to an existing owner must not mount
  // duplicate unavailable routes. A console with no owner keeps its old surface.
  if (config.performance !== undefined || !Object.hasOwn(globalThis, PAGE_TRANSFER_POLICY)) {
    registerPerformanceConsole(ctx, config)
  }

  // What the settings view shows: the switches in force, which of them this
  // install can honour, and the version block. The same answer carries the about
  // block because the view renders both in one pass, and a second request would
  // only add a second spinner.
  //
  // One registration serves both methods: a transport keys routes by path, so
  // two `register` calls for `/settings` would be the same route entered twice —
  // and whichever landed second would answer the other method too.
  register('/settings', ['GET', 'POST'], async (request: Request) => {
    if (request.method !== 'POST') {
      if (config.preferences === undefined) {
        return json({
          available: false,
          reason: 'this mount created no preference store',
          preferences: undefined,
          formats: [],
          about: aboutOf(),
        })
      }
      return json({
        available: true,
        preferences: config.preferences.host.read(),
        formats: config.preferences.formats,
        about: aboutOf(),
      })
    }
    // Changing a switch writes one small file next to the backend catalog and
    // applies it to the running backend — no session data is touched. A rejected
    // value is a 400 and leaves the file as it was: `update` validates before it
    // writes, so a half-applied patch cannot exist. A write that fails for a
    // reason the caller cannot fix (a read-only state directory) is a 500.
    const contentType = request.headers.get('content-type') ?? ''
    if (!contentType.toLowerCase().startsWith('application/json')) {
      return failure('this endpoint accepts application/json bodies only', 415)
    }
    if (config.preferences === undefined) {
      return failure('this mount has no preference store to write to', 409)
    }
    const body = await bodyOf(request)
    if (body === undefined) return failure('a JSON object body is required', 400)
    if (Object.hasOwn(body, 'performance')) return failure('use the versioned performance endpoint for performance settings', 400)
    try {
      return json(config.preferences.host.update(body))
    } catch (error) {
      // A rejected value is the caller's mistake; a failed write is ours. Saying
      // 400 to "disk is full" would tell the operator to fix their body.
      if (error instanceof PreferencesUsageError) return failure(error.message, 400)
      // The detail stays in the body: this route is owner-only, and "which path
      // refused the write" is the one fact that makes the failure actionable.
      return failure(`cannot write the preferences file: ${String(error)}`, 500)
    }
  })

  // Whether a newer release exists on npm. Deliberately *not* part of the
  // `/settings` answer: that route runs on every panel open, while this one
  // reaches the network, so folding it in would put the registry's latency in
  // front of the panel's first paint and ask it again on every visit.
  //
  // The version compared is the one on disk, the same one the panel prints — not
  // the loaded one — so "up to date" stays consistent with the row above it.
  register('/update', ['GET'], async () => {
    const about = aboutOf()
    if (about === undefined) {
      return failure('this mount reports no plugin version, so there is nothing to compare', 409)
    }
    return json(await checkForUpdate(about.pluginVersion))
  })

  // What the plugin has been complaining about. In memory only: a warning about
  // a store that has since been repaired should not outlive the repair, and the
  // sessions themselves are on disk where an operator can inspect them.
  register('/diagnostics', ['GET'], () =>
    Promise.resolve(json({ available: true, entries: listDiagnostics() })))

  register('/diagnostics/clear', ['POST'], () =>
    Promise.resolve(json({ cleared: clearDiagnostics() })))

  // Which conversations an uninstall would hide. The CLI has answered this for a
  // while; the console had no way to ask, which is the moment an operator needs
  // it most. Header-only reads: the question is which ids exist, not whether
  // every event parses.
  register('/uninstall-check', ['GET'], () => {
    const jsonlRoot = config.jsonlRoot
    if (jsonlRoot === undefined || jsonlRoot === '') {
      return Promise.resolve(json({
        available: false,
        reason: 'this mount has no JSONL root to compare against',
      }))
    }
    return uninstallCheck(config.root, jsonlRoot).then(
      (report) => json(report),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        recordDiagnostic('error', 'uninstall-check', message)
        return failure(`cannot compare the two roots: ${message}`, 500)
      },
    )
  })
}

/** Mount only the optional performance surface; never mounts storage or query services. */
export function registerPerformanceConsole(ctx: Context, config: Pick<ConsoleConfig, 'performance' | 'historyPreview'>): void {
  const transport = (ctx as ConsoleContext).connection
  const routes = new Map<string, { methods: readonly string[]; fetch(request: Request): Promise<Response> }>()
  const register = (path: string, methods: readonly ('GET' | 'HEAD' | 'POST')[], fetch: (request: Request) => Promise<Response>): void => {
    routes.set(path.slice(1), { methods, fetch })
    transport.fetch.register({ path: `${CONSOLE_ROUTE_PREFIX}${path}`, methods, requestBody: 'buffered', fetch })
  }
  register('/performance', ['GET', 'POST'], async (request: Request) => {
    const host = config.performance
    if (host === undefined) return json({ available: false, reason: 'performance controls are unavailable' }, 409)
    if (request.method !== 'POST') return json(host.read())
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return failure('this endpoint accepts application/json bodies only', 415)
    const body = await bodyOf(request)
    if (body === undefined || Object.keys(body).some((key) => key !== 'patch' && key !== 'expectedRevision') || typeof body.expectedRevision !== 'string' || body.expectedRevision.length > 128) {
      return failure('patch and expectedRevision are required', 400)
    }
    try { return json(host.update(body.patch, body.expectedRevision)) } catch (error) {
      if (error instanceof PerformanceConflictError) return json({ error: error.message, state: host.read() }, 409)
      if (error instanceof PreferencesUsageError) return failure(error.message, 400)
      return failure(`performance settings write failed: ${String(error)}`, 500)
    }
  })

  register('/performance/disable', ['POST'], async (request: Request) => {
    const host = config.performance
    if (host === undefined) return failure('performance controls are unavailable', 409)
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return failure('this endpoint accepts application/json bodies only', 415)
    const body = await bodyOf(request)
    if (body === undefined || Object.keys(body).some((key) => key !== 'expectedRevision') || typeof body.expectedRevision !== 'string' || body.expectedRevision.length > 128) return failure('expectedRevision is required', 400)
    try { return json(host.disableAll(body.expectedRevision)) } catch (error) {
      if (error instanceof PerformanceConflictError) return json({ error: error.message, state: host.read() }, 409)
      return failure(`performance settings write failed: ${String(error)}`, 500)
    }
  })

  register('/history-preview', ['GET'], async (request: Request) => {
    const host = config.performance
    const reader = config.historyPreview
    const url = new URL(request.url)
    const id = url.searchParams.get('id')
    if (host === undefined || reader === undefined) return json({ available: false, reason: 'preview unavailable' })
    const state = host.read()
    if (url.searchParams.get('revision') !== state.revision) return json({ available: false, reason: 'configuration changed' })
    if (id === null || id.length === 0 || id.length > 256) return failure('a bounded session id is required', 400)
    if (request.signal.aborted) return json({ available: false, reason: 'cancelled' })
    const lease = host.acquire('historyWindow', request.signal)
    if (lease === undefined) return json({ available: false, reason: 'preview disabled' })
    try {
      const answer = await reader.read(id, lease.signal)
      if (!lease.isCurrent()) return json({ available: false, reason: 'configuration changed' })
      return json({ ...answer, configurationRevision: state.revision, generation: lease.generation })
    } catch {
      return json({ available: false, reason: 'preview declined; official loading continues' })
    } finally { lease.dispose() }
  })
  register('/performance/client-report', ['POST'], async request => {
    const host = config.performance
    if (host === undefined) return failure('performance controls are unavailable', 409)
    try { host.reportClient(await bodyOf(request)); return json({ accepted: true }) } catch (error) {
      return failure(error instanceof Error ? error.message : 'invalid Client report', 400)
    }
  })
  if (transport.rpc !== undefined) ctx.inject(['connection', 'webServer'], (rpcCtx) => {
    const rpc = (rpcCtx as ConsoleContext).connection.rpc
    if (rpc !== undefined) registerPerformanceRpc(rpc, routes)
  })
}
