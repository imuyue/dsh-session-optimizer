/**
 * What the plugin complained about, and what an uninstall would cost.
 *
 * Two things the console could not answer before:
 *
 * 1. **Which sessions did the plugin skip?** `list()` reports a store it cannot
 *    read as a warning and keeps going — the right behaviour, and invisible: the
 *    operator sees a shorter session list and no reason. The ring below keeps the
 *    last few of those, in memory only. It is a diagnostic, not a log file: a
 *    restart clears it, because a warning about a store that has since been
 *    repaired should not outlive the repair.
 * 2. **What is lost if the plugin is removed?** Sessions that live only in SQLite
 *    have no JSONL original, so uninstalling the plugin (and going back to the
 *    official provider) hides them. The CLI has said so for a while; the console
 *    could not.
 *
 * @module dsh-session-optimizer/diagnostics
 */

import { listJsonlSessions, readSqliteHeader, scanSqliteSessions } from './transfer.ts'

export type DiagnosticLevel = 'warn' | 'error'

export interface DiagnosticEntry {
  readonly at: number
  readonly level: DiagnosticLevel
  /** Where it happened, e.g. `list` or `catalog`. */
  readonly scope: string
  readonly message: string
}

/** Entries kept before the oldest is dropped. */
const DIAGNOSTIC_HISTORY = 200

const entries: DiagnosticEntry[] = []

/** Remember one complaint. Never throws: a diagnostic must not fail the caller. */
export function recordDiagnostic(level: DiagnosticLevel, scope: string, message: string): void {
  entries.push({ at: Date.now(), level, scope, message: message.slice(0, 4000) })
  if (entries.length > DIAGNOSTIC_HISTORY) entries.splice(0, entries.length - DIAGNOSTIC_HISTORY)
}

/** Newest last, the order they happened. */
export function listDiagnostics(): readonly DiagnosticEntry[] {
  return entries
}

/** Drop the ring; returns how many entries went. */
export function clearDiagnostics(): number {
  const cleared = entries.length
  entries.length = 0
  return cleared
}

export interface UninstallBlocker {
  readonly id: string
  readonly error: string
}

export interface UninstallReport {
  readonly available: true
  readonly checkedAt: number
  readonly sqliteRoot: string
  readonly jsonlRoot: string
  /** Sessions stored under the SQLite root. */
  readonly sqlite: number
  /** Sessions the JSONL root already holds. */
  readonly jsonl: number
  /** Ids that exist only in SQLite: removing the plugin hides them. */
  readonly orphaned: readonly string[]
  /** Stores whose header could not be read, so their ids are unknown. */
  readonly unreadable: readonly UninstallBlocker[]
  /** True when an uninstall loses nothing. */
  readonly ok: boolean
}

/**
 * Compare the two roots by id, reading only headers.
 *
 * The CLI's version reads every event to prove the stores are sound. This one
 * answers the question the button asks — *which conversations would I lose* — and
 * a header is enough for that: it is the id. A store whose header cannot be read
 * is reported as a blocker, because its ids are unknown rather than absent.
 */
export async function uninstallCheck(sqliteRoot: string, jsonlRoot: string): Promise<UninstallReport> {
  const stores = await scanSqliteSessions(sqliteRoot)
  const present = new Set((await listJsonlSessions(jsonlRoot)).map((header) => header.id))
  const orphaned: string[] = []
  const unreadable: UninstallBlocker[] = []
  for (const store of stores) {
    let header
    try {
      header = await readSqliteHeader(store.path)
    } catch (error) {
      unreadable.push({
        id: store.directory,
        error: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    if (!present.has(header.header.id)) orphaned.push(header.header.id)
  }
  orphaned.sort()
  return {
    available: true,
    checkedAt: Date.now(),
    sqliteRoot,
    jsonlRoot,
    sqlite: stores.length,
    jsonl: present.size,
    orphaned,
    unreadable,
    ok: orphaned.length === 0 && unreadable.length === 0,
  }
}
