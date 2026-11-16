// Carrier-independent bridge to the exact performance handlers. No action is reimplemented here.
export const PERFORMANCE_RPC_CHANNEL = '/session-optimizer-control'
export const PERFORMANCE_RPC_ENDPOINT = 'request'
export interface PerformanceRoutes { get(path: string): { methods: readonly string[]; fetch(request: Request): Promise<Response> } | undefined }
export interface PerformanceRpcPeer { readonly principal: { readonly kind: string }; readonly signal: AbortSignal }
export type PerformanceRpcResult = { ok: true; value: { status: number; body: string } } | { ok: false; error: { code: string; message: string; details: object } }
export interface PerformanceRpcRegistry {
  handle(channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal, peer: PerformanceRpcPeer) => Promise<PerformanceRpcResult>): () => Promise<void>
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function fail(code: string, message: string): PerformanceRpcResult { return { ok: false, error: { code, message, details: {} } } }
export function registerPerformanceRpc(registry: PerformanceRpcRegistry, routes: PerformanceRoutes): () => Promise<void> {
  return registry.handle(PERFORMANCE_RPC_CHANNEL, async (endpoint, payload, signal, peer) => {
    if (peer.principal.kind !== 'owner') return fail('FORBIDDEN', 'owner access required')
    if (endpoint !== PERFORMANCE_RPC_ENDPOINT || !record(payload) || Object.keys(payload).some(key => key !== 'path' && key !== 'body') || typeof payload.path !== 'string' || payload.path.length > 2048) return fail('BAD_REQUEST', 'invalid performance request')
    // Validate the raw path before URL normalization; no arbitrary route or authority is accepted.
    const parts = payload.path.split('?')
    const path = parts[0]!
    if (parts.length > 2 || !['performance', 'performance/disable', 'performance/client-report', 'history-preview'].includes(path)) return fail('BAD_REQUEST', 'unknown performance route')
    if (payload.body !== undefined && (typeof payload.body !== 'string' || Buffer.byteLength(payload.body, 'utf8') > 8192)) return fail('BAD_REQUEST', 'performance body too large or incompatible')
    const query = new URLSearchParams(parts[1])
    if ([...query.keys()].some(key => !['id', 'revision'].includes(key)) || (path !== 'history-preview' && query.size > 0) || query.getAll('id').length > 1 || query.getAll('revision').length > 1) return fail('BAD_REQUEST', 'invalid performance query')
    const method = payload.body === undefined ? 'GET' : 'POST'
    const route = routes.get(path)
    if (route === undefined || !route.methods.includes(method)) return fail('BAD_REQUEST', 'unsupported performance method')
    const combined = AbortSignal.any([signal, peer.signal])
    if (combined.aborted) return fail('CANCELLED', 'request cancelled')
    const request = new Request(`http://session-optimizer.local/api/session-optimizer/${path}${parts[1] === undefined ? '' : `?${parts[1]}`}`, { method, signal: combined, ...(payload.body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: payload.body }) })
    const response = await route.fetch(request)
    // Handler output is controlled and bounded (preview text <=40,000 characters).
    const body = await response.text()
    if (Buffer.byteLength(body, 'utf8') > 2 * 1024 * 1024) return fail('TOO_LARGE', 'performance response too large')
    if (combined.aborted) return fail('CANCELLED', 'request cancelled')
    return { ok: true, value: { status: response.status, body } }
  })
}
