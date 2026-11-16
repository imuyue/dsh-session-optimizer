import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerPerformanceRpc, PERFORMANCE_RPC_ENDPOINT, type PerformanceRpcRegistry } from '../src/performance-rpc.ts'
import { installPerformanceTransport, performanceFetch } from '../client/performance-transport.ts'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.unstubAllGlobals() })
function bridge() {
  let handler!: Parameters<PerformanceRpcRegistry['handle']>[1]
  const owner = new AbortController()
  const seen: Request[] = []
  const routes = new Map([
    ['performance', { methods: ['GET', 'POST'], fetch: async (request: Request) => { seen.push(request); return new Response(JSON.stringify({ saved: request.method === 'POST', body: request.method === 'POST' ? await request.json() : null }), { status: request.method === 'POST' ? 409 : 200 }) } }],
    ['history-preview', { methods: ['GET'], fetch: async (request: Request) => { seen.push(request); return new Response(JSON.stringify({ id: new URL(request.url).searchParams.get('id') })) } }],
    ['performance/disable', { methods: ['POST'], fetch: async () => new Response('{}') }],
  ])
  registerPerformanceRpc({ handle: (channel, fn) => { expect(channel).toBe('/session-optimizer-control'); handler = fn; return async () => undefined } }, routes)
  const call = (payload: unknown, signal = new AbortController().signal, kind = 'owner') => handler(PERFORMANCE_RPC_ENDPOINT, payload, signal, { principal: { kind }, signal: owner.signal })
  return { call, owner, seen }
}
describe('performance RPC and carrier compatibility', () => {
  it('dispatches only owner requests and preserves exact Fetch status/body', async () => {
    const { call, seen } = bridge()
    expect((await call({ path: 'performance' }, undefined, 'api')).ok).toBe(false)
    expect(seen).toHaveLength(0)
    expect(await call({ path: 'performance', body: '{"expectedRevision":"old"}' })).toEqual({ ok: true, value: { status: 409, body: '{"saved":true,"body":{"expectedRevision":"old"}}' } })
    expect(seen).toHaveLength(1)
  })
  it('rejects arbitrary routes, normalization, methods and oversized payloads before dispatch', async () => {
    const { call, seen } = bridge()
    for (const payload of [{ path: '../settings' }, { path: 'http://external/' }, { path: 'performance?x=1' }, { path: 'performance/disable' }, { path: 'history-preview?id=a&id=b' }, { path: 'performance', body: 'x'.repeat(8193) }, { path: 'performance', extra: true }]) expect((await call(payload)).ok).toBe(false)
    expect(seen).toHaveLength(0)
  })
  it('links caller and peer cancellation to the same preview Request', async () => {
    const { call, owner, seen } = bridge()
    const active = new AbortController()
    expect((await call({ path: 'history-preview?id=a&revision=r' }, active.signal)).ok).toBe(true)
    expect(seen[0]!.signal.aborted).toBe(false)
    owner.abort()
    expect(seen[0]!.signal.aborted).toBe(true)
    expect((await call({ path: 'performance' })).ok).toBe(false)
  })
  it('uses the injected carrier, preserves conflict status and never uses bare fetch', async () => {
    const { call } = bridge()
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    cleanups.push(installPerformanceTransport({ rpc: { call: async (channel: string, endpoint: string, payload: unknown, signal?: AbortSignal) => {
      expect(channel).toBe('/session-optimizer-control'); expect(endpoint).toBe(PERFORMANCE_RPC_ENDPOINT)
      return call(payload, signal)
    } } }))
    const response = await performanceFetch('performance', { method: 'POST', body: '{"expectedRevision":"r"}' })
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ saved: true, body: { expectedRevision: 'r' } }); expect(fetcher).not.toHaveBeenCalled()
  })
  it('does not replay an RPC failure via HTTP and rejects late cancelled responses', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    const abort = new AbortController()
    let done!: (value: unknown) => void
    cleanups.push(installPerformanceTransport({ rpc: { call: () => new Promise(resolve => { done = resolve }) } }))
    const pending = performanceFetch('performance', { signal: abort.signal })
    abort.abort(); done({ status: 200, body: '{}' })
    await expect(pending).rejects.toThrow('cancelled')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('unwraps an official failure Result without replaying or accepting bare values', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    const dispose = installPerformanceTransport({ rpc: { call: async () => ({ ok: false, error: { code: 'FORBIDDEN', message: 'owner access required', details: {} } }) } })
    await expect(performanceFetch('performance')).rejects.toThrow('owner access required')
    dispose()
    cleanups.push(installPerformanceTransport({ rpc: { call: async () => ({ status: 200, body: '{}' }) } }))
    await expect(performanceFetch('performance')).rejects.toThrow('incompatible performance RPC result')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('selects exact authenticated Web routes before dispatch even with a carrier', async () => {
    vi.stubGlobal('document', { baseURI: 'http://vm:3925/' })
    const rpc = vi.fn(); const fetcher = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetcher)
    cleanups.push(installPerformanceTransport({ rpc: { call: rpc } }))
    await performanceFetch('performance/disable', { method: 'POST', credentials: 'same-origin', body: '{"expectedRevision":"r"}' })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledWith('http://vm:3925/api/session-optimizer/performance/disable', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }))
    expect(rpc).not.toHaveBeenCalled()
  })
  it('uses exact routes for dsh-app pages without a native fetch override', async () => {
    vi.stubGlobal('document', { baseURI: 'dsh-app://app/' })
    vi.stubGlobal('__DSH_TRANSPORT__', undefined)
    const rpc = vi.fn(async () => { throw new Error('transport failure: HTTP 405') })
    const fetcher = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetcher)
    cleanups.push(installPerformanceTransport({ rpc: { call: rpc } }))
    const abort = new AbortController()
    for (const [path, body] of [['performance', undefined], ['performance', '{"patch":{"enabled":true},"expectedRevision":"r"}'], ['performance/disable', '{"expectedRevision":"r"}'], ['performance/client-report', '{}'], ['history-preview?id=s&revision=r', undefined]] as const) {
      const init = { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin' as const, signal: abort.signal, ...(body === undefined ? {} : { body }) }
      await performanceFetch(path, init)
      expect(fetcher).toHaveBeenLastCalledWith(`dsh-app://app/api/session-optimizer/${path}`, init)
    }
    expect(rpc).not.toHaveBeenCalled()
  })
  it('does not replay failed Desktop Fetch writes and never dispatches an aborted request', async () => {
    vi.stubGlobal('document', { baseURI: 'dsh-app://app/' })
    const rpc = vi.fn()
    cleanups.push(installPerformanceTransport({ rpc: { call: rpc } }))
    const fetcher = vi.fn(async () => { throw new Error('Host disconnected') })
    vi.stubGlobal('fetch', fetcher)
    await expect(performanceFetch('performance/disable', { method: 'POST', body: '{}' })).rejects.toThrow('Host disconnected')
    const abort = new AbortController(); abort.abort()
    await expect(performanceFetch('performance', { signal: abort.signal })).rejects.toThrow('cancelled')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(rpc).not.toHaveBeenCalled()
  })
  it('falls back to browser fetch only when no connection carrier is installed', async () => {
    vi.stubGlobal('document', { baseURI: 'https://host/prefix/' })
    const fetcher = vi.fn(async () => new Response('{}')); vi.stubGlobal('fetch', fetcher)
    await performanceFetch('performance')
    expect(fetcher).toHaveBeenCalledWith('https://host/prefix/api/session-optimizer/performance', {})
  })
})
