/**
 * What the settings view reports about this build.
 *
 * The design shows a version, a build line and three links. A version is read
 * from the plugin's own manifest; the DSH version is read from the peer package
 * that is actually installed, so the line describes the runtime this build runs
 * against instead of a number someone typed into a template.
 *
 * The three links are derived from the manifest, never from a template. Two of
 * them are configuration (`repository`, `bugs`); the third is a small piece of
 * reasoning: npm records a license as an *identifier* (`"license": "MIT"`), which
 * names no page, so an identifier is turned into the page that defines it and the
 * row stays plain text when not even that is possible.
 *
 * @module dsh-session-optimizer/about
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The manifest sits one level above the compiled module (`lib/`). */
const MANIFEST_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')

interface Manifest {
  readonly version?: string
  readonly repository?: string | { readonly url?: string }
  readonly bugs?: string | { readonly url?: string }
  readonly homepage?: string
  /** An SPDX identifier (`MIT`) or, for an unpublished license, `SEE LICENSE IN x`. */
  readonly license?: string | { readonly type?: string }
  /** Where the license text lives; the SPDX id in `license` names no page. */
  readonly licenseUrl?: string
}

function readManifest(): Manifest {
  try {
    const parsed: unknown = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    return parsed as Manifest
  } catch {
    // A build without its manifest still runs; it just cannot name a version.
    return {}
  }
}

function urlOf(value: string | { readonly url?: string } | undefined): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value
  if (typeof value === 'object' && value !== null && typeof value.url === 'string' && value.url !== '') {
    return value.url
  }
  return undefined
}

/**
 * A git URL turned into the page a browser can actually open.
 *
 * npm records a repository as a *git* URL — `git+https://…`, `git+ssh://…`,
 * `ssh://git@host/owner/repo.git`, or the scp form `git@host:owner/repo.git` —
 * and none of those open in a browser: `git+https` is not a scheme any browser
 * knows, and the scp form has no scheme at all. The panel's button says "打开仓库",
 * so what it points at has to be the web page for that repository.
 *
 * A scheme this function does not recognise yields `undefined` and the row falls
 * back to plain text, which is the honest answer for a location that is not a web
 * address.
 *
 * Exported because the git forms it has to swallow are exactly the ones a browser
 * refuses, and each of them deserves a case of its own.
 */
export function webUrlOf(value: string | { readonly url?: string } | undefined): string | undefined {
  const raw = urlOf(value)
  if (raw === undefined) return undefined
  // `#readme` survives from older manifests and names a fragment, not a page.
  const text = raw.trim().replace(/^git\+/, '').replace(/#.*$/, '')
  const withoutSuffix = (path: string): string => path.replace(/\.git$/, '').replace(/\/+$/, '')

  const scp = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/.exec(text)
  if (scp !== null) return `https://${scp[1] ?? ''}/${withoutSuffix(scp[2] ?? '')}`

  const shorthand = /^github:([^/]+\/[^/]+)$/.exec(text)
  if (shorthand !== null) return `https://github.com/${withoutSuffix(shorthand[1] ?? '')}`

  if (text.startsWith('git://')) return `https://${withoutSuffix(text.slice('git://'.length))}`
  if (/^https?:\/\//.test(text)) return withoutSuffix(text)
  return undefined
}

/** `license` of a manifest as one identifier, when it is a bare SPDX id. */
function licenseIdOf(manifest: Manifest): string | undefined {
  const value = manifest.license
  const text = typeof value === 'string'
    ? value
    : (typeof value === 'object' && value !== null && typeof value.type === 'string' ? value.type : '')
  const trimmed = text.trim()
  // `SEE LICENSE IN COPYING` and `(MIT OR Apache-2.0)` are not identifiers and
  // have no canonical page; the row falls back to repository text for those.
  return /^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(trimmed) ? trimmed : undefined
}

/**
 * The page a license row links to, or `undefined` when there is none.
 *
 * Order of preference: an explicit `licenseUrl` (the manifest saying exactly
 * where to look), then the SPDX page for the identifier — canonical, stable, and
 * independent of how the repository lays its files out — and only then the
 * repository's own `LICENSE` blob, which is a guess about a path. The row is
 * rendered as plain text when all three miss, because a license control that
 * opens a 404 is worse than one that does not pretend to be a link.
 */
function licensePageOf(manifest: Manifest, repository: string | undefined): string | undefined {
  const explicit = urlOf(manifest.licenseUrl)
  if (explicit !== undefined) return explicit
  const identifier = licenseIdOf(manifest)
  if (identifier !== undefined) return `https://spdx.org/licenses/${identifier}.html`
  if (repository === undefined) return undefined
  const base = repository.replace(/\.git$/, '').replace(/\/+$/, '')
  return `${base}/blob/HEAD/LICENSE`
}

/**
 * The version this process loaded, used only when the manifest cannot be read.
 *
 * Kept apart from {@link installedVersion} because the two answer different
 * questions: what is running now, and what is on disk. The panel reports the one
 * on disk, so after an in-place upgrade it names the new version while the old
 * code still runs — a restart is what closes that gap, and nothing here tries to
 * detect it. This constant is the fallback for a build whose manifest is gone,
 * so the row still says something instead of nothing.
 */
const LOADED_VERSION = readManifest().version ?? '0.0.0'

/** The installed DSH version, or `undefined` when the peer cannot be resolved. */
function resolvedDshVersion(): string | undefined {
  try {
    const require = createRequire(import.meta.url)
    const manifest: unknown = require('@deepseek-ai/dsh-session/package.json')
    if (typeof manifest !== 'object' || manifest === null) return undefined
    const version = (manifest as { version?: unknown }).version
    return typeof version === 'string' && version !== '' ? version : undefined
  } catch {
    return undefined
  }
}

/** Everything the settings view prints under "DSH Session Optimizer". */
export interface PluginAbout {
  readonly pluginVersion: string
  readonly dshVersion: string | undefined
  /**
   * The SPDX identifier, when the manifest names one. The view prints the name
   * only because this is known: a hard-coded "MIT" in a translation string would
   * keep saying MIT after the license changed.
   */
  readonly licenseId?: string | undefined
  readonly links: {
    readonly repository: string | undefined
    readonly feedback: string | undefined
    readonly license: string | undefined
  }
}

/**
 * Build facts for this process, read fresh every time.
 *
 * `pluginVersion` is the copy on disk, not the one that was loaded: "检查更新"
 * re-requests this block, and a version frozen at mount would answer with the
 * number from before an in-place upgrade and then claim to be up to date.
 */
export function pluginAbout(): PluginAbout {
  // One read for the version and the links: two reads could straddle an upgrade
  // and describe a build that never existed.
  const manifest = readManifest()
  const repository = webUrlOf(manifest.repository) ?? webUrlOf(manifest.homepage)
  return {
    pluginVersion: versionOf(manifest),
    dshVersion: resolvedDshVersion(),
    licenseId: licenseIdOf(manifest),
    links: {
      repository,
      feedback: urlOf(manifest.bugs),
      license: licensePageOf(manifest, repository),
    },
  }
}

/** The version on disk right now — newer than {@link LOADED_VERSION} after an upgrade. */
export function installedVersion(): string {
  return versionOf(readManifest())
}

/** `version` of a manifest, or the loaded one when that manifest does not name it. */
function versionOf(manifest: ReturnType<typeof readManifest>): string {
  const version = manifest.version
  return typeof version === 'string' && version !== '' ? version : LOADED_VERSION
}
