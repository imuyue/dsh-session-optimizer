/**
 * Reads from the Host console routes.
 *
 * The routes live on the shared `/api` channel: registered absolute
 * (`/api/session-optimizer/...`), requested relative to `document.baseURI` so a
 * deployment mounted under a path prefix keeps working.
 *
 * @module dsh-session-optimizer/client/api
 */

import type {
  DiagnosticsAnswer,
  MetricsAnswer,
  MigrationJob,
  MigrationsAnswer,
  Overview,
  Preferences,
  RootCandidate,
  SettingsAnswer,
  SourceListing,
  UninstallReport,
  UpdateCheck,
} from './types.ts'

import { consoleFetch } from './host-fetch.ts'

const ROUTE = 'api/session-optimizer'

function endpoint(path: string, params?: Record<string, string | number | undefined>): string {
  const url = new URL(`${ROUTE}/${path}`, document.baseURI)
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === '') continue
    url.searchParams.set(key, String(value))
  }
  return `${path}${url.search}`
}

/** One response body, or a thrown error carrying the route's message. */
async function read<T>(
  path: string,
  params?: Record<string, string | number | undefined>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await consoleFetch(endpoint(path, params), {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`
    try {
      const body = (await response.json()) as { error?: unknown }
      if (typeof body.error === 'string') detail = body.error
    } catch {
      // A non-JSON body keeps the status line as the message.
    }
    throw new Error(detail)
  }
  return (await response.json()) as T
}

export function fetchOverview(signal?: AbortSignal, page: { offset?: number; limit?: number; titles?: boolean; parent?: string; ids?: readonly string[] } = {}): Promise<Overview> {
  return read<Overview>('overview', { offset: page.offset ?? 0, limit: page.limit ?? 50, titles: page.titles === true ? 1 : undefined, parent: page.parent, ids: page.ids === undefined ? undefined : JSON.stringify(page.ids) }, signal)
}

export interface SessionTitle { id: string; title?: string | undefined; problem?: string | undefined; removed?: boolean | undefined; titlePending?: boolean | undefined }
export function fetchSessionTitles(ids: readonly string[], signal?: AbortSignal, root?: string): Promise<{ titles: SessionTitle[] }> {
  return read('titles', { ids: JSON.stringify(ids), root }, signal)
}

export interface WorkspaceMembership { sessionId: string; workspaceId: string }
export interface WorkspaceProjection { workspaceId: string; path: string; title: string; createdAt: string; updatedAt: string; sessionIds: readonly string[] }
export function fetchWorkspaceMemberships(ids: readonly string[], signal?: AbortSignal): Promise<{ available: boolean; memberships: WorkspaceMembership[]; workspaces: WorkspaceProjection[]; dshVersion?: string }> {
  return read('workspace-memberships', { ids: JSON.stringify(ids) }, signal)
}

/** Real latency series, or an explicit "nothing sampled yet". */
export function fetchMetrics(signal?: AbortSignal): Promise<MetricsAnswer> {
  return read<MetricsAnswer>('metrics', undefined, signal)
}

/** Every migration this Host process has run, newest last. */
export async function clearMigrations(): Promise<{ cleared: number; retainedRunning: number }> {
  return await post('migrations/clear', {})
}

export async function fetchMigrations(signal?: AbortSignal): Promise<MigrationsAnswer> {
  const body = await read<MigrationsAnswer>('migrations', undefined, signal)
  return { ...body, jobs: body.jobs ?? [], available: body.available === true }
}

/** Roots this machine has, so a picker replaces a text box. */
export function fetchRoots(signal?: AbortSignal): Promise<RootCandidate[]> {
  return read<{ roots?: RootCandidate[] }>('roots', undefined, signal).then((body) => body.roots ?? [])
}

/**
 * What one root holds: paged, searchable, titles included.
 *
 * The `sessions` array is normalised here: a listing that arrives without it
 * must render as "no sessions", never crash the tab that reads `.length`.
 */
export async function fetchSource(
  options: {
    backend: 'jsonl' | 'sqlite'
    root: string
    offset?: number
    limit?: number
    query?: string
    parent?: string
    refresh?: boolean
  },
  signal?: AbortSignal,
): Promise<SourceListing> {
  const body = await read<SourceListing>(
    'source',
    {
      backend: options.backend,
      root: options.root,
      offset: options.offset,
      limit: options.limit,
      q: options.query,
      refresh: options.refresh === true ? 1 : undefined,
      summary: 1,
      grouped: 1,
      parent: options.parent,
    },
    signal,
  )
  return { ...body, sessions: body.sessions ?? [], total: body.total ?? 0 }
}

/**
 * Start one backend-to-backend migration.
 *
 * Only the side the operator read is named. The Host fills in the other side from
 * the profile, because the target is a property of the installation and not of
 * the conversation: a browser must not be able to pick it.
 */
export async function startMigration(body: {
  direction: 'jsonl_to_sqlite' | 'sqlite_to_jsonl'
  mode: 'overwrite' | 'clone'
  jsonlRoot?: string
  sqliteRoot?: string
  sessions?: readonly string[]
  verify?: boolean
}): Promise<MigrationJob> {
  return await post<MigrationJob>('migrate', body)
}

/**
 * The switches in force, what this install can serve, and the version block.
 *
 * A mount without a preference store answers `available: false` with the about
 * block still filled in: the view then shows the version panel and no switch,
 * which is the truth for a headless-capable but console-less mount.
 */
export async function fetchSettings(signal?: AbortSignal): Promise<SettingsAnswer> {
  const body = await read<SettingsAnswer>('settings', undefined, signal)
  return { ...body, formats: body.formats ?? [] }
}

/** Write one patch of the switches; the Host answers with the result in force. */
export function saveSettings(patch: Partial<Preferences>): Promise<Preferences> {
  return post<Preferences>('settings', patch)
}

/**
 * Ask the Host whether a newer release exists on npm.
 *
 * No `signal`: the request outlives the render that started it by design — the
 * Host has already spent the registry round-trip, and aborting on unmount would
 * only throw that away. The Host's own timeout bounds it instead.
 */
export function checkForUpdate(): Promise<UpdateCheck> {
  return read<UpdateCheck>('update')
}

/** What the plugin has complained about since it started. */
export async function fetchDiagnostics(signal?: AbortSignal): Promise<DiagnosticsAnswer> {
  const body = await read<DiagnosticsAnswer>('diagnostics', undefined, signal)
  return { ...body, entries: body.entries ?? [] }
}

/** Empty the ring; the answer says how many entries went. */
export function clearDiagnostics(): Promise<{ cleared: number }> {
  return post<{ cleared: number }>('diagnostics/clear', {})
}

/** Which conversations would disappear if the plugin were removed. */
export async function fetchUninstallCheck(signal?: AbortSignal): Promise<UninstallReport> {
  const body = await read<UninstallReport>('uninstall-check', undefined, signal)
  return { ...body, orphaned: body.orphaned ?? [], unreadable: body.unreadable ?? [] }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await consoleFetch(endpoint(path), {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`
    try {
      const parsed = (await response.json()) as { error?: unknown }
      if (typeof parsed.error === 'string') detail = parsed.error
    } catch {
      // keep the status line
    }
    throw new Error(detail)
  }
  return (await response.json()) as T
}
