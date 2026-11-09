/**
 * The shape of `@deepseek-ai/dsh-session-query` that this plugin uses.
 *
 * The package belongs to the host: a profile may not have it installed, and this
 * plugin must compile and load without it. So the module is declared here — the
 * optional engine (`src/query-engine.ts`) imports it normally, and only the code
 * path that mounts that engine resolves it at runtime. Keeping the declaration
 * local means the compiler checks our usage without making the package a
 * dependency of every install.
 *
 * The signatures are deliberately loose (`unknown`/`any` in the plumbing) because
 * they are a copy of someone else's contract: a wrong guess here must not turn
 * into a claim about behaviour. The behaviour this plugin depends on is tested
 * through the engine itself, not through these types.
 *
 * @module dsh-session-optimizer/dsh-session-query
 */

declare module '@deepseek-ai/dsh-session-query' {
  export class SessionQueryError extends Error {
    constructor(message: string, code?: string)
    readonly code?: string
  }

  export abstract class SessionQueryEngine {
    constructor(ctx: unknown, config?: unknown)
    static inject: string[]
    protected readonly ctx: any
    abstract searchSessions(request: any, exec?: any): Promise<any>
    abstract searchEvents(request: any, exec?: any): Promise<any>
    listSessions(signal?: AbortSignal): Promise<any[]>
    readSession(sessionId: any): Promise<{ header: any; events: any[] }>
  }

  export default SessionQueryEngine

  export function buildSessionEventSearchDocuments(sessionId: any, events: readonly any[]): any[]
  export function buildSessionEventRecords(sessionId: any, events: readonly any[]): any[]
  export function filterSessionResults<T>(records: readonly T[], filters?: readonly any[]): T[]
  export function filterSessionEventDocuments<T>(documents: readonly T[], filters?: readonly any[]): T[]
  export function materializeSessionResultFilters(filters: readonly any[]): any[]
  export function materializeSessionEventResultFilters(filters: readonly any[]): any[]

  export type SessionEventSearchDocument = any
  export type SessionRecord = any
  export type SessionSearchHit = any
  export type SessionSearchPage<T> = any
  export type SessionSearchRequest = any
  export type SessionEventSearchHit = any
  export type SessionEventSearchPage = any
  export type SessionEventSearchRequest = any
  export type SessionSearchExecContext = any
}
