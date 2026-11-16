/**
 * Whether a newer release of this package exists on npm.
 *
 * "检查更新" can only ever answer "the version you already have" while it re-reads
 * the manifest on disk: an update feed is the one fact that cannot be derived
 * from the installed copy. This module is that feed — one unauthenticated GET of
 * the registry's abbreviated packument, compared with the version the panel
 * already shows.
 *
 * Three decisions worth keeping:
 *
 * - **A failure is a state, not a throw.** An offline machine, a proxy that
 *   answers 407 and a package that was never published are all ordinary
 *   outcomes; the panel names which one it hit instead of spinning forever.
 * - **Nothing is cached.** The answer is a fact about the registry at the moment
 *   the operator asked. A remembered "up to date" is the one wrong answer that
 *   makes the button worthless.
 * - **No dependency.** A range library would be another runtime dependency for
 *   fifty lines of precedence rules that the semver specification fixes, not this
 *   package.
 *
 * @module dsh-session-optimizer/update
 */

/** The name this package is published under; the update feed is keyed by it. */
export const PACKAGE_NAME = 'dsh-session-optimizer'

/** Where the page for a version lives, once the registry named one. */
const PACKAGE_PAGE = 'https://www.npmjs.com/package'

/** The public registry, used when the profile sets none. */
const PUBLIC_REGISTRY = 'https://registry.npmjs.org'

/** Long enough for a slow link, short enough that the panel is not a hung tab. */
const DEFAULT_TIMEOUT_MS = 8_000

/**
 * What a caller can learn, one variant per thing the panel has to say.
 *
 * `current` travels in every variant so the view can print the version it
 * compared even when the comparison itself failed.
 */
export type UpdateCheck =
  | {
    readonly state: 'up-to-date'
    readonly current: string
    readonly latest: string
  }
  | {
    readonly state: 'outdated'
    readonly current: string
    readonly latest: string
    /** The registry page for the newer version. */
    readonly page: string
    /** The command an operator would run to take it. */
    readonly install: string
  }
  | {
    /** The registry answered 404: this name has no published version at all. */
    readonly state: 'unpublished'
    readonly current: string
  }
  | {
    readonly state: 'unavailable'
    readonly current: string
    readonly detail: string
  }

/** The part of `Response` this module reads, so a test can answer without sockets. */
export interface UpdateResponse {
  readonly ok: boolean
  readonly status: number
  json: () => Promise<unknown>
}

/** The part of `fetch` this module needs. */
export type UpdateFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<UpdateResponse>

export interface UpdateOptions {
  /** Registry base; defaults to `NPM_CONFIG_REGISTRY`, then the public registry. */
  readonly registry?: string | undefined
  readonly timeoutMs?: number | undefined
  /** Test seam. Production leaves this out and the global `fetch` is used. */
  readonly fetchImpl?: UpdateFetch | undefined
}

interface ParsedVersion {
  readonly core: readonly [number, number, number]
  /** `undefined` for a release; the identifiers of a prerelease otherwise. */
  readonly prerelease: readonly string[] | undefined
}

/**
 * A version split into the pieces precedence cares about, or `undefined` when it
 * is not a version.
 *
 * Deliberately narrower than the specification's full grammar: this package
 * publishes `major.minor.patch` with an optional prerelease, and a build
 * metadatum (the `+sha` npm tolerates) is dropped because it never affects
 * precedence.
 */
function parseVersion(version: string): ParsedVersion | undefined {
  const stripped = version.trim().replace(/^[=v]\s*/, '')
  const withoutBuild = stripped.split('+')[0] ?? ''
  const dash = withoutBuild.indexOf('-')
  const coreText = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash)
  const prereleaseText = dash === -1 ? undefined : withoutBuild.slice(dash + 1)
  const parts = coreText.split('.')
  if (parts.length === 0 || parts.length > 3) return undefined
  const numbers: number[] = []
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined
    numbers.push(Number(part))
  }
  // `1.2` and `1.2.0` are the same version; the missing pieces are zero.
  while (numbers.length < 3) numbers.push(0)
  return {
    core: [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0],
    prerelease: prereleaseText === undefined || prereleaseText === '' ? undefined : prereleaseText.split('.'),
  }
}

/**
 * Semver precedence: negative when `left` sorts below `right`, `0` when they are
 * the same version, `undefined` when either is unparsable.
 *
 * The part that surprises people is prerelease ordering: `1.0.0-rc.1` sorts
 * *below* `1.0.0`, and a numeric identifier sorts below an alphanumeric one, so
 * `0.1.0-2` precedes `0.1.0-alpha`. Getting this backwards would tell an
 * operator on a prerelease that the final release is older than what they run.
 */
export function compareVersions(left: string, right: string): number | undefined {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === undefined || b === undefined) return undefined
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  const preA = a.prerelease
  const preB = b.prerelease
  if (preA === undefined && preB === undefined) return 0
  // A release outranks every prerelease of the same core version.
  if (preA === undefined) return 1
  if (preB === undefined) return -1
  const length = Math.max(preA.length, preB.length)
  for (let index = 0; index < length; index += 1) {
    const one = preA[index]
    const other = preB[index]
    // A shorter identifier set is the smaller one when it is a strict prefix.
    if (one === undefined) return -1
    if (other === undefined) return 1
    const oneNumeric = /^\d+$/.test(one)
    const otherNumeric = /^\d+$/.test(other)
    if (oneNumeric && otherNumeric) {
      const difference = Number(one) - Number(other)
      if (difference !== 0) return difference < 0 ? -1 : 1
      continue
    }
    if (oneNumeric) return -1
    if (otherNumeric) return 1
    if (one !== other) return one < other ? -1 : 1
  }
  return 0
}

/** A registry base with no trailing slash, or the public registry. */
function registryBase(configured: string | undefined): string {
  const candidate = configured?.trim() ?? ''
  const fromEnvironment = candidate === ''
    ? (process.env['NPM_CONFIG_REGISTRY'] ?? process.env['npm_config_registry'] ?? '').trim()
    : candidate
  if (fromEnvironment === '') return PUBLIC_REGISTRY
  try {
    const url = new URL(fromEnvironment)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return PUBLIC_REGISTRY
    return url.href.replace(/\/+$/, '')
  } catch {
    return PUBLIC_REGISTRY
  }
}

/** `dist-tags.latest` of a packument, or `undefined` when the answer is not one. */
function latestVersionOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const tags: unknown = (body as Record<string, unknown>)['dist-tags']
  if (typeof tags !== 'object' || tags === null) return undefined
  const latest: unknown = (tags as Record<string, unknown>)['latest']
  return typeof latest === 'string' && latest !== '' ? latest : undefined
}

/** A message for the panel: a timeout says so, anything else is passed through. */
function detailOf(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return `the registry did not answer within ${String(DEFAULT_TIMEOUT_MS / 1000)}s`
    }
    return error.message
  }
  return String(error)
}

/**
 * Ask the registry what the newest published version is.
 *
 * Never throws: every failure mode is one of {@link UpdateCheck}'s variants,
 * because a checker that can reject forces every caller to invent wording for a
 * case it cannot describe.
 */
export async function checkForUpdate(
  current: string,
  options: UpdateOptions = {},
): Promise<UpdateCheck> {
  const registry = registryBase(options.registry)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const request: UpdateFetch = options.fetchImpl
    ?? (async (url, init) => await fetch(url, init))

  let response: UpdateResponse
  try {
    response = await request(`${registry}/${PACKAGE_NAME}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return { state: 'unavailable', current, detail: detailOf(error) }
  }

  // A 404 is information, not a failure: the name exists and has no release yet,
  // which is exactly the state a package is in before its first `npm publish`.
  if (response.status === 404) return { state: 'unpublished', current }
  if (!response.ok) {
    return { state: 'unavailable', current, detail: `the registry answered HTTP ${String(response.status)}` }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { state: 'unavailable', current, detail: 'the registry answer was not JSON' }
  }

  const latest = latestVersionOf(body)
  if (latest === undefined) {
    return { state: 'unavailable', current, detail: 'the registry answer names no latest version' }
  }

  const order = compareVersions(latest, current)
  if (order === undefined) {
    return { state: 'unavailable', current, detail: `cannot compare ${current} with ${latest}` }
  }
  // A local build ahead of the registry is not an update: reporting one would
  // invite an operator to "upgrade" to an older version.
  if (order <= 0) return { state: 'up-to-date', current, latest }

  return {
    state: 'outdated',
    current,
    latest,
    page: `${PACKAGE_PAGE}/${PACKAGE_NAME}/v/${latest}`,
    install: `dsh plugin add ${PACKAGE_NAME}@${latest}`,
  }
}
