/**
 * `ctx.sessionQuery`, answered from the stores this plugin owns.
 *
 * The released search plugin keeps a second database — a derived index that has
 * to be reconciled against the logs before it can answer. This engine asks the
 * logs themselves: every store carries its own full-text index as an auxiliary
 * table, updated inside the same transaction as the events it covers, so there
 * is nothing to reconcile and nothing that can be one append behind.
 *
 * It is a drop-in replacement for `@deepseek-ai/dsh-session-query-sqlite`, not a
 * companion: a profile loads one engine or the other, because the service name
 * `sessionQuery` has one owner.
 *
 * The base class is loaded lazily and resolved twice. An installed plugin sits
 * inside the application's `node_modules`, where the sibling resolves normally.
 * A linked install (`link:`, `file:`) resolves this file through its realpath,
 * which is outside that tree, so the second attempt borrows the resolution path
 * from `@deepseek-ai/dsh-session` — a package that is always beside it.
 *
 * @module dsh-session-optimizer/query-engine
 */

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  SessionEventSearchDocument,
  SessionEventSearchHit,
  SessionEventSearchPage,
  SessionEventSearchRequest,
  SessionRecord,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'

import { matchQueryFor, type SearchHit } from './search.ts'

/** Rows one search may consider before ranking, whatever the caller asked for. */
const MAX_CANDIDATES = 2_000
/** Page size the service defaults to, matching the released engine. */
const DEFAULT_LIMIT = 20
/** Largest page a caller may ask for. */
const MAX_LIMIT = 100

type QueryModule = typeof import('@deepseek-ai/dsh-session-query')

/**
 * The host module, once.
 *
 * `undefined` until `queryEnginePlugin()` runs, and never read before it: the
 * class it builds is the only caller.
 */
let api: QueryModule

async function importQueryModule(): Promise<QueryModule> {
  try {
    return await import('@deepseek-ai/dsh-session-query')
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ERR_MODULE_NOT_FOUND') throw error
    const anchor = createRequire(import.meta.resolve('@deepseek-ai/dsh-session'))
    const resolved = anchor.resolve('@deepseek-ai/dsh-session-query')
    return (await import(pathToFileURL(resolved).href)) as QueryModule
  }
}

/** The members the host base class contributes; see `SqliteSessionQueryEngine.host`. */
interface HostSurface {
  readonly ctx: { readonly sessionPersistence?: unknown }
  listSessions(signal?: AbortSignal): Promise<SessionRecord[]>
  readSession(sessionId: SessionId): Promise<{ header: SessionRecord['header']; events: readonly unknown[] }>
}

/** What this engine needs from the backend that owns the stores. */
interface SearchCapablePersistence {
  search(query: string, limit: number, sessionId?: string): Promise<SearchHit[]>
}

function isSearchCapable(value: unknown): value is SearchCapablePersistence {
  return typeof (value as { search?: unknown } | undefined)?.search === 'function'
}

function limitOf(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_LIMIT
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new api.SessionQueryError('search limit must be a positive integer', 'SESSION_QUERY_INVALID_QUERY')
  }
  return Math.min(requested, MAX_LIMIT)
}

function queryOf(request: { readonly query?: unknown }): string {
  const query = request.query
  if (typeof query !== 'string') {
    throw new api.SessionQueryError('search query must be a string', 'SESSION_QUERY_INVALID_QUERY')
  }
  return query.trim()
}

function encodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string, scope: string, fingerprint: string, total: number): number {
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new api.SessionQueryError('session-search cursor is not readable', 'SESSION_QUERY_STALE_CURSOR')
  }
  const payload = decoded as { s?: unknown; f?: unknown; n?: unknown; o?: unknown }
  if (payload.s !== scope || payload.f !== fingerprint || payload.n !== total) {
    throw new api.SessionQueryError(
      'session-search cursor is stale because its relevant corpus changed',
      'SESSION_QUERY_STALE_CURSOR',
    )
  }
  const offset = payload.o
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
    throw new api.SessionQueryError('session-search cursor is not readable', 'SESSION_QUERY_STALE_CURSOR')
  }
  return offset
}

function fingerprintOf(parts: readonly unknown[]): string {
  return createHash('sha1').update(JSON.stringify(parts)).digest('base64url').slice(0, 16)
}

/**
 * One page of `items`, with the cursor that continues it.
 *
 * The cursor carries the total it was cut from, so a log that grew or shrank
 * between pages invalidates it instead of silently skipping or repeating rows.
 */
function page<T>(
  items: readonly T[],
  limit: number,
  offset: number,
  cursorFor: (offset: number) => string,
): { items: readonly T[]; nextCursor?: string } {
  const slice = items.slice(offset, offset + limit)
  const next = offset + slice.length
  return next < items.length ? { items: slice, nextCursor: cursorFor(next) } : { items: slice }
}

/**
 * The plugin class, built once the host module is in hand.
 *
 * A class extends its base at definition time, so the module has to arrive
 * before the definition — which is why this is a factory and not a top-level
 * `export class`.
 */
export async function queryEnginePlugin(): Promise<unknown> {
  api ??= await importQueryModule()
  const Base = api.default as unknown as new (...args: never[]) => object

  class SqliteSessionQueryEngine extends Base {
    static inject = ['sessions']

    /**
     * This engine as the base class declared it.
     *
     * The base arrives through a dynamic import, so its members are not visible
     * to the checker; this is the one place that says what they are.
     */
    private host(): HostSurface {
      return this as unknown as HostSurface
    }

    /** The backend whose stores answer the queries. */
    private backend(): SearchCapablePersistence {
      const persistence = this.host().ctx.sessionPersistence
      if (!isSearchCapable(persistence)) {
        throw new api.SessionQueryError(
          'session search needs the SQLite session backend to be mounted',
          'SESSION_QUERY_SEARCH_DISABLED',
        )
      }
      return persistence
    }

    async searchSessions(
      request: SessionSearchRequest,
      exec?: SessionSearchExecContext,
    ): Promise<SessionSearchPage<SessionSearchHit>> {
      const query = queryOf(request)
      const limit = limitOf(request.limit)
      const filters = api.materializeSessionResultFilters(request.sessionFilters ?? [])
      const match = matchQueryFor(query)
      if (match === undefined) return { items: [] }

      const hits = await this.backend().search(query, MAX_CANDIDATES, undefined)
      exec?.signal?.throwIfAborted()
      const best = new Map<string, SearchHit>()
      for (const hit of hits) {
        const current = best.get(hit.sessionId)
        if (current === undefined || hit.score < current.score) best.set(hit.sessionId, hit)
      }
      if (best.size === 0) return { items: [] }

      const records = await this.host().listSessions(exec?.signal)
      const withHits = records.filter((record: SessionRecord) => best.has(record.header.id))
      const accepted = api.filterSessionResults(withHits, filters)
      const ranked = accepted.map((record: SessionRecord): SessionSearchHit => {
        const hit = best.get(record.header.id) as SearchHit
        return {
          ...record,
          bestMatch: {
            sessionId: record.header.id,
            seq: hit.seq as never,
            type: hit.type as never,
            time: hit.time,
            // A persisted log has one surface: nothing shadows it, so every event
            // in it is what the log says. Live-only rows are not in these stores.
            surface: 'log-only' as const,
            snippet: hit.snippet,
          },
        }
      })
      ranked.sort((left: SessionSearchHit, right: SessionSearchHit) => {
        const leftScore = best.get(left.header.id)?.score ?? 0
        const rightScore = best.get(right.header.id)?.score ?? 0
        // Strongest match first; the more recent conversation breaks a tie.
        return leftScore === rightScore ? right.bestMatch.time - left.bestMatch.time : leftScore - rightScore
      })

      const fingerprint = fingerprintOf([query, filters, limit])
      const offset = request.cursor === undefined
        ? 0
        : decodeCursor(request.cursor, 'sessions', fingerprint, ranked.length)
      const result = page(ranked, limit, offset, (next) =>
        encodeCursor({ s: 'sessions', f: fingerprint, n: ranked.length, o: next }),
      )
      return result.nextCursor === undefined
        ? { items: result.items }
        : { items: result.items, nextCursor: result.nextCursor }
    }

    async searchEvents(
      request: SessionEventSearchRequest,
      exec?: SessionSearchExecContext,
    ): Promise<SessionEventSearchPage> {
      if (typeof request.sessionId !== 'string') {
        throw new api.SessionQueryError('event search needs a session id', 'SESSION_QUERY_INVALID_QUERY')
      }
      const sessionId = request.sessionId as SessionId
      const query = queryOf(request)
      const limit = limitOf(request.limit)
      const filters = api.materializeSessionEventResultFilters(request.filters ?? [])
      const match = matchQueryFor(query)
      const snapshot = await this.host().readSession(sessionId)
      exec?.signal?.throwIfAborted()
      if (match === undefined) return { session: snapshot.header, items: [] }

      const documents = api.buildSessionEventSearchDocuments(sessionId, snapshot.events)
      const accepted = api.filterSessionEventDocuments(documents, filters)
      const terms = termsOf(query)

      const scored: Array<{ document: SessionEventSearchDocument; score: number }> = []
      for (const document of accepted) {
        const haystack = document.text.toLowerCase()
        let score = 0
        let matched = true
        for (const term of terms) {
          const at = haystack.indexOf(term)
          if (at < 0) {
            matched = false
            break
          }
          score += countOf(haystack, term)
        }
        if (!matched) continue
        scored.push({ document, score })
      }
      // Best first, and a tie goes to the later event: the newest mention of a
      // term is the one a reader is usually looking for.
      scored.sort((left, right) =>
        right.score === left.score
          ? Number(right.document.seq) - Number(left.document.seq)
          : right.score - left.score,
      )

      const fingerprint = fingerprintOf([sessionId, query, filters, limit, snapshot.events.length])
      const offset = request.cursor === undefined
        ? 0
        : decodeCursor(request.cursor, 'events', fingerprint, scored.length)
      const result = page(
        scored,
        limit,
        offset,
        (next) => encodeCursor({ s: 'events', f: fingerprint, n: scored.length, o: next }),
      )
      const items = result.items.map((item): SessionEventSearchHit => ({
        sessionId,
        seq: item.document.seq,
        type: item.document.type,
        time: item.document.time,
        surface: item.document.surface,
        snippet: snippetOf(item.document.text, terms),
      }))
      return result.nextCursor === undefined
        ? { session: snapshot.header, items }
        : { session: snapshot.header, items, nextCursor: result.nextCursor }
    }
  }

  return SqliteSessionQueryEngine
}

/** The literal terms a query requires, lowercased; CJK terms stay whole. */
function termsOf(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/u)
    .filter((term) => term !== '')
}

function countOf(haystack: string, needle: string): number {
  let count = 0
  let at = haystack.indexOf(needle)
  while (at >= 0) {
    count += 1
    at = haystack.indexOf(needle, at + needle.length)
  }
  return count
}

/** Cut the excerpt around the first term that appears in the text. */
function snippetOf(text: string, terms: readonly string[], width = 240): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim()
  if (collapsed.length <= width) return collapsed
  const lower = collapsed.toLowerCase()
  const at = terms.reduce((found, term) => {
    const index = lower.indexOf(term)
    return index >= 0 && (found < 0 || index < found) ? index : found
  }, -1)
  const start = at <= width / 3 ? 0 : Math.min(at - Math.floor(width / 3), collapsed.length - width)
  const piece = collapsed.slice(start, start + width)
  return start === 0 ? `${piece}…` : `…${piece}…`
}
