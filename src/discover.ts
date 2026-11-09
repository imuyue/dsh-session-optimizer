/**
 * Find the session roots this machine actually has, instead of asking for them.
 *
 * A profile knows one root by configuration; everything else a person might want
 * to migrate from lives where DSH puts things: `DSH_HOME` (default `~/.dsh`) with
 * `sessions` for the official JSONL backend and `sessions-sqlite` for this one.
 * Reading those directory names is cheap and total — a wrong guess costs one
 * failed `readdir`, not a failed migration — so the console can offer a list
 * rather than a text box the operator has to fill from memory.
 *
 * Nothing here opens a session log or creates a directory: `readdir` at depth two
 * is enough to count what a root holds, and the picker loads the detail.
 *
 * @module dsh-session-optimizer/discover
 */

import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { JsonlCompression } from './transfer.ts'

/** What a discovered root holds, and why it is on the list. */
export interface RootCandidate {
  /** Absolute path of the root. */
  readonly path: string
  /** Backend the root belongs to. */
  readonly backend: 'jsonl' | 'sqlite'
  /** Physical encoding, for a JSONL root. */
  readonly encoding: JsonlCompression | undefined
  /** Session directories found at depth two. */
  readonly sessions: number
  /** Why this path is a candidate, for the picker's second line. */
  readonly source: 'configured' | 'dsh-home' | 'sibling-of-root' | 'sessions-subdirectory'
}

/** `DSH_HOME` when set, else the platform default DSH uses. */
export function dshHome(): string {
  const override = process.env.DSH_HOME
  return override !== undefined && override !== '' ? resolve(override) : join(homedir(), '.dsh')
}

/** Count session directories at depth two without opening anything. */
async function countSessions(root: string): Promise<number> {
  let projects: string[]
  try {
    projects = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return 0
  }
  let total = 0
  for (const project of projects) {
    try {
      const children = await readdir(join(root, project), { withFileTypes: true })
      total += children.filter((entry) => entry.isDirectory() || entry.isFile()).length
    } catch {
      continue
    }
  }
  return total
}

/**
 * Encoding of a JSONL root, decided by the files it holds.
 *
 * `.jsonl.zstd` wins when both appear: a root that grew from a compressed profile
 * keeps compressed artifacts, and reading it as plain would fail on every one.
 */
async function encodingOf(root: string): Promise<JsonlCompression | undefined> {
  let projects: string[]
  try {
    projects = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return undefined
  }
  let plain = false
  for (const project of projects) {
    let children: import('node:fs').Dirent[]
    try {
      children = await readdir(join(root, project), { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      if (child.name.endsWith('.jsonl.zstd')) return 'zstd'
      if (child.name.endsWith('.jsonl')) plain = true
    }
  }
  return plain ? 'none' : undefined
}

/** A path on the list, with its facts filled in. */
async function describe(
  path: string,
  backend: 'jsonl' | 'sqlite',
  source: RootCandidate['source'],
): Promise<RootCandidate | undefined> {
  if (!isAbsolute(path)) return undefined
  const root = resolve(path)
  const sessions = await countSessions(root)
  if (backend === 'sqlite') return { path: root, backend, encoding: undefined, sessions, source }
  const encoding = await encodingOf(root)
  if (encoding === undefined && sessions === 0) return undefined
  return { path: root, backend, encoding: encoding ?? 'zstd', sessions, source }
}

/**
 * Every root worth offering as a side of a migration.
 *
 * `configured` is the root this profile mounts (so it is always first and always
 * labelled), the DSH home supplies the conventional locations, and the siblings
 * of a mounted root cover a profile that keeps its libraries side by side.
 */
export async function discoverRoots(options: {
  readonly sqliteRoot: string
  readonly jsonlRoot?: string | undefined
}): Promise<readonly RootCandidate[]> {
  const home = dshHome()
  const wanted: Array<{ path: string; backend: 'jsonl' | 'sqlite'; source: RootCandidate['source'] }> = [
    { path: options.sqliteRoot, backend: 'sqlite', source: 'configured' },
    { path: join(home, 'sessions'), backend: 'jsonl', source: 'dsh-home' },
    { path: join(home, 'sessions-sqlite'), backend: 'sqlite', source: 'dsh-home' },
    { path: join(dirname(resolve(options.sqliteRoot)), 'sessions'), backend: 'jsonl', source: 'sibling-of-root' },
  ]
  if (options.jsonlRoot !== undefined && options.jsonlRoot !== '') {
    wanted.unshift({ path: options.jsonlRoot, backend: 'jsonl', source: 'configured' })
  }

  const found: RootCandidate[] = []
  const seen = new Set<string>()
  for (const entry of wanted) {
    if (!isAbsolute(entry.path)) continue
    const key = `${entry.backend}\u0000${resolve(entry.path)}`
    if (seen.has(key)) continue
    seen.add(key)
    const candidate = await describe(entry.path, entry.backend, entry.source)
    if (candidate === undefined) continue
    // A configured root is listed even when it is empty: it is where the next
    // session lands, and hiding it would look like the profile lost its root.
    if (candidate.sessions === 0 && candidate.source !== 'configured') continue
    found.push(candidate)
  }
  return found
}
