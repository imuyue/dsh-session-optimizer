import { consoleFetch, nativePageFetch } from './host-fetch.ts'

interface PerformanceConnection {
  readonly rpc: { call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> }
}
let connection: PerformanceConnection | undefined
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
/** Use the Harness carrier (desktop IPC or authenticated Web RPC) when present. */
export function installPerformanceTransport(value: unknown): () => void {
  if (!record(value) || !record(value.rpc) || typeof value.rpc.call !== 'function') return () => undefined
  const installed = value as unknown as PerformanceConnection
  connection = installed
  return () => { if (connection === installed) connection = undefined }
}
export function hasPerformanceCarrier(): boolean { return connection !== undefined }
/** Fail closed on carrier errors; never retry a possibly committed write through another transport. */
export async function performanceFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (init.signal?.aborted) throw new Error('performance request cancelled')
  // Desktop's dsh-app://app protocol forwards exact API requests to its Host,
  // even when __DSH_TRANSPORT__.fetch is absent. A document is not evidence of
  // a native RPC channel: Connection.rpc may itself be the Web POST adapter.
  // Use the same exact Fetch routes as the other console pages, for every page
  // protocol. Only a document-less caller uses the injected RPC carrier.
  if (nativePageFetch() !== undefined || typeof document !== 'undefined') return consoleFetch(path, init)
  const active = connection
  if (active === undefined) throw new Error('performance transport unavailable')
  const body = init.body
  if (body !== undefined && body !== null && typeof body !== 'string') throw new Error('unsupported performance request body')
  const method = init.method ?? 'GET'
  if (method !== (body == null ? 'GET' : 'POST')) throw new Error('unsupported performance request method')
  const result = await active.rpc.call('/session-optimizer-control', 'request', { path, ...(body == null ? {} : { body }) }, init.signal ?? undefined)
  if (init.signal?.aborted) throw new Error('performance request cancelled')
  if (!record(result) || typeof result.ok !== 'boolean') throw new Error('incompatible performance RPC result')
  if (!result.ok) {
    const error = record(result.error) ? result.error : undefined
    throw new Error(typeof error?.message === 'string' ? error.message : 'performance RPC request failed')
  }
  const answer = result.value
  if (!record(answer) || !Number.isInteger(answer.status) || Number(answer.status) < 200 || Number(answer.status) > 599 || typeof answer.body !== 'string' || answer.body.length > 2 * 1024 * 1024 || new TextEncoder().encode(answer.body).byteLength > 2 * 1024 * 1024) throw new Error('incompatible performance RPC response')
  return new Response(answer.body, { status: Number(answer.status), headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
