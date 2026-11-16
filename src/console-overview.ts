import { inspectOverview, type InspectOverview, type InspectTarget, type InspectUsage } from './inspect.ts'
import { sourceInventory, type SourceSession } from './migrate.ts'
import { pickerTitles, pickerPreviewTitles } from './source-picker.ts'
import { sessionParents, sessionChildCounts } from './session-groups.ts'
import type { SessionBackendCatalog } from './catalog.ts'

export interface HybridOverview extends InspectOverview {
  readonly usageTotal?: number
  readonly childSessions?: number
  readonly usageOffset?: number
  readonly usageLimit?: number
  readonly usage: readonly (InspectUsage & { readonly titlePending?: boolean; readonly detailsPending?: boolean; readonly childCount?: number; readonly removed?: boolean })[]
  readonly eventsPending?: boolean
  readonly backends?: { readonly sqliteSessions: number; readonly jsonlSessions: number; readonly sqliteBytes: number; readonly jsonlBytes: number }
}

/** Logical sessions are counted once; space includes both physical copies. */
export function mergeOverview(sqlite: InspectOverview, jsonl: readonly SourceSession[], catalog?: Pick<SessionBackendCatalog, 'backendOf'>): HybridOverview {
  const usage = new Map<string, InspectUsage>(sqlite.usage.map(row => [row.id, row]))
  for (const row of jsonl) {
    const physical: InspectUsage & { detailsPending?: boolean } = { id: row.id, ...(row.origin === 'subagent' ? { origin: 'subagent' as const, ...(row.parentSession === undefined ? {} : { parentSession: row.parentSession }) } : {}), title: row.title, eventCount: row.eventCount, sizeBytes: row.sizeBytes, walBytes: 0, state: row.detailsPending === true ? 'unknown' : 'ready', problem: row.problem, ...(row.detailsPending === true ? {detailsPending:true} : {}) }
    const other = usage.get(row.id)
    if (other === undefined) usage.set(row.id, physical)
    else {
      const selected = catalog?.backendOf(row.id) === 'jsonl' ? physical : other
      usage.set(row.id, { ...selected, sizeBytes: other.sizeBytes + row.sizeBytes, walBytes: other.walBytes })
    }
  }
  const rows = [...usage.values()].sort((a, b) => b.sizeBytes - a.sizeBytes || a.id.localeCompare(b.id))
  const jsonlBytes = jsonl.reduce((sum, row) => sum + row.sizeBytes, 0)
  return {
    ...sqlite, sessions: rows.length, eventsPending: jsonl.some(row => row.detailsPending === true),
    ready: rows.filter(row => row.state === 'ready' && row.problem === undefined).length,
    importing: rows.filter(row => row.state === 'importing').length,
    damaged: rows.filter(row => row.problem !== undefined).length,
    events: rows.reduce((sum, row) => sum + row.eventCount, 0),
    databaseBytes: sqlite.databaseBytes + jsonlBytes,
    usage: rows, checkedAt: Date.now(),
    backends: { sqliteSessions: sqlite.sessions, jsonlSessions: jsonl.length, sqliteBytes: sqlite.databaseBytes, jsonlBytes },
  }
}
export function groupOverview(overview: HybridOverview, parent?: string): HybridOverview {
  const owners = sessionParents(overview.usage)
  const roots = overview.usage.filter(row => !owners.has(row.id))
  const childCount = sessionChildCounts(owners)
  const selected = parent === undefined ? roots : overview.usage.filter(row => owners.get(row.id) === parent)
  return { ...overview, sessions: roots.length, childSessions: owners.size, eventsPending: roots.some(row => row.detailsPending === true),
    ready: roots.filter(row => row.state === 'ready' && row.problem === undefined).length,
    damaged: roots.filter(row => row.problem !== undefined).length,
    importing: roots.filter(row => row.state === 'importing').length,
    events: roots.reduce((sum,row)=>sum+row.eventCount,0),
    usage: selected.map(row => ({ ...row, childCount: childCount.get(row.id) ?? 0 })) }
}

export function overviewPage(overview: HybridOverview, offset = 0, limit = 50): HybridOverview {
  const size = Math.min(100, Math.max(1, Number.isSafeInteger(limit) ? limit : 50))
  const start = Math.min(Math.max(0, Number.isSafeInteger(offset) ? offset : 0), Math.max(0, Math.ceil(overview.usage.length / size) - 1) * size)
  return { ...overview, usageTotal: overview.usage.length, usageOffset: start, usageLimit: size, usage: overview.usage.slice(start, start + size) }
}
export async function inspectConsoleOverview(target: InspectTarget, jsonlRoot?: string, catalog?: Pick<SessionBackendCatalog, 'backendOf'>, options: { offset?: number; limit?: number; signal?: AbortSignal; titles?: boolean; parent?: string; ids?: readonly string[] } = {}): Promise<HybridOverview> {
  options.signal?.throwIfAborted()
  const sqlite = inspectOverview(target)
  const all = jsonlRoot === undefined ? sqlite : mergeOverview(sqlite, await sourceInventory({ id: 'jsonl', root: jsonlRoot }, options.signal), catalog)
  const grouped = groupOverview(all, options.parent)
  const page = options.ids === undefined ? overviewPage(grouped, options.offset, options.limit)
    : { ...grouped, usage: all.usage.filter(row => options.ids!.includes(row.id)) }
  if (jsonlRoot === undefined) return page
  const sqliteIds = new Set(sqlite.usage.map(row => row.id))
  const ids = new Set(page.usage.filter(row => !sqliteIds.has(row.id) || catalog?.backendOf(row.id) === 'jsonl').map(row => row.id))
  const titles = options.titles === false ? await pickerPreviewTitles(jsonlRoot, ids, options.signal) : await pickerTitles(jsonlRoot, ids, options.signal)
  options.signal?.throwIfAborted()
  return { ...page, usage: page.usage.map(row => {
    const title = titles.get(row.id)
    if (!ids.has(row.id)) return row
    return title === undefined ? { ...row, removed: true } : { ...row, title: title.title, titlePending: title.titlePending === true, problem: row.problem ?? title.problem }
  }) }
}
