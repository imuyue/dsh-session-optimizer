/**
 * Filesystem layout for the SQLite session backend: one database directory per
 * stored session, nested under the same project bucket the JSONL backend uses.
 *
 * Layout: `<root>/--<projectKey(cwd)>--/<encodeSegment(sessionId)>/session.db`
 * plus the SQLite sidecars (`session.db-wal`, `session.db-shm`) and the
 * cross-process write lease (`session.lock`) that live in the same directory.
 *
 * The segment encoding is intentionally byte-identical to the JSONL backend so
 * a stored session id occupies the same directory name in both backends, which
 * keeps side-by-side migration/export comprehensible.
 *
 * @module dsh-session-optimizer/format
 */

import { join } from 'node:path'

/** File name of the per-session database. */
export const DATABASE_FILENAME = 'session.db'

/** Directory bucket name used for sessions with no recorded cwd. */
export const NO_CWD_SEGMENT = '_no-cwd'

/**
 * Encode one raw path segment so it is safe on every filesystem and never
 * collides after decoding.
 *
 * `.` and `..` are fully escaped (they would otherwise traverse); every
 * character outside `[A-Za-z0-9._-]` — including `~` itself — becomes
 * `~XXXX` with uppercase hex of its UTF-16 code unit.
 *
 * @param raw - the segment to encode.
 * @returns the encoded segment.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index++) {
    const ch = raw[index] as string
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${raw.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * Reverse `encodeSegment`, for callers that only have a directory name.
 *
 * Only a name this module produced decodes: a stray `~` that is not followed by
 * four hex digits makes the name foreign, and `undefined` says so instead of
 * inventing an id.
 *
 * @param segment - one escaped path segment.
 * @returns the original segment, or `undefined` when it is not escaped form.
 */
export function decodeSegment(segment: string): string | undefined {
  if (segment.length === 0) return undefined
  let out = ''
  for (let index = 0; index < segment.length; index++) {
    const ch = segment[index] as string
    if (ch !== '~') {
      out += ch
      continue
    }
    const hex = segment.slice(index + 1, index + 5)
    if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return undefined
    out += String.fromCharCode(Number.parseInt(hex, 16))
    index += 4
  }
  return out
}

/**
 * Derive the project bucket name for a working directory.
 *
 * Path separators are folded into a single `-` run, everything else that is
 * not a safe character is `~XXXX`-escaped, leading dashes are dropped, and the
 * result is wrapped in `--` with at most 251 characters of payload.
 *
 * @param cwd - the session working directory.
 * @returns the bucket directory name.
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let out = ''
  let inSeparator = false
  for (let index = 0; index < cwd.length; index++) {
    const ch = cwd[index] as string
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!inSeparator) {
        out += '-'
        inSeparator = true
      }
      continue
    }
    inSeparator = false
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${cwd.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0')}`
  }
  const slug = out.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/** Project bucket directory for a cwd, or the shared `_no-cwd` bucket. */
export function projectDir(root: string, cwd: string | undefined): string {
  return cwd === undefined ? join(root, NO_CWD_SEGMENT) : join(root, projectKey(cwd))
}

/** Directory holding one session's database, sidecars, and write lease. */
export function sessionDir(root: string, cwd: string | undefined, id: string): string {
  return join(projectDir(root, cwd), encodeSegment(id))
}

/** Absolute path of one session's database file. */
export function databasePath(root: string, cwd: string | undefined, id: string): string {
  return join(sessionDir(root, cwd, id), DATABASE_FILENAME)
}
