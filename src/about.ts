/**
 * What the settings view reports about this build.
 *
 * The design shows a version, a build line and three links. A version is read
 * from the plugin's own manifest; the DSH version is read from the peer package
 * that is actually installed, so the line describes the runtime this build runs
 * against instead of a number someone typed into a template.
 *
 * The three links are configuration, not invented URLs. This package has no
 * upstream repository of its own, so `repository`, `bugs` and a license URL can
 * only appear when the manifest carries them; the console disables a control it
 * cannot point anywhere rather than opening a 404.
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
  return {
    pluginVersion: versionOf(manifest),
    dshVersion: resolvedDshVersion(),
    links: {
      repository: urlOf(manifest.repository) ?? urlOf(manifest.homepage),
      feedback: urlOf(manifest.bugs),
      // A license *page* is not the same thing as the SPDX id: `"license": "MIT"`
      // names no URL, so the row is only a link when the manifest adds one.
      license: urlOf(manifest.licenseUrl),
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
