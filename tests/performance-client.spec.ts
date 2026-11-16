import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const off = { enabled: false, historyWindow: false, virtualChat: false }
const on = { enabled: true, historyWindow: true, virtualChat: true }
function state(enabled = true, revision = 'epoch:1') {
  return { revision, generation: 1, desired: { ...(enabled ? on : off) }, effective: { ...(enabled ? on : off) }, capabilities: { historyWindow: { supported: true, reason: 'preview' }, virtualChat: { supported: true, reason: 'layout' } }, clientApplied: 'unconfirmed', disposed: false }
}
function answer(value: unknown, status = 200) { return Promise.resolve(new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })) }
const cleanups: (() => void)[] = []
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers()
  vi.stubGlobal('document', { baseURI: 'http://localhost/', visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() })
})
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })
async function start() {
  const store = await import('../client/performance-store.ts')
  cleanups.push(store.installPerformanceClient())
  await vi.advanceTimersByTimeAsync(0)
  return store
}

describe('Client performance control lifecycle', () => {
  it('synchronizes and disables through Desktop exact Fetch with bounded page reports', async () => {
    const transport = await import('../client/performance-transport.ts')
    vi.stubGlobal('document', { baseURI: 'dsh-app://app/', visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() })
    let saved = state(false), reports = 0
    const rpc = vi.fn(async () => { throw new Error('HTTP 405: Desktop Web RPC must not run') })
    const fetcher = vi.fn(async (url: string) => {
      expect(url.startsWith('dsh-app://app/api/session-optimizer/')).toBe(true)
      if (url.endsWith('/client-report')) { reports++; return new Response('{"accepted":true}') }
      if (url.endsWith('/disable')) saved = state(false, 'epoch:closed')
      return new Response(JSON.stringify(saved))
    })
    vi.stubGlobal('fetch', fetcher)
    cleanups.push(transport.installPerformanceTransport({ rpc: { call: rpc } }))
    const store = await start()
    expect(store.getPerformanceSnapshot().status).toBe('ready')
    await store.disablePerformance()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getPerformanceSnapshot().state?.revision).toBe('epoch:closed')
    const reportCount = reports
    for (let index = 0; index < 1000; index++) store.reportPerformanceApplied({ historyWindow: false, virtualChat: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(reports).toBe(reportCount)
    expect(fetcher).toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })
  it('starts official and only publishes confirmed Host preferences', async () => {
    vi.stubGlobal('fetch', vi.fn(() => answer(state(false))))
    const store = await import('../client/performance-store.ts')
    expect(store.getPerformanceSnapshot().localSuppressed).toBe(true)
    cleanups.push(store.installPerformanceClient())
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getPerformanceSnapshot().state?.desired).toEqual(off)
    expect(store.getPerformanceSnapshot().status).toBe('ready')
    cleanups.pop()!()
    expect(store.getPerformanceSnapshot().localSuppressed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps this page official after failed disable even when polling resumes', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => init.method === 'POST' ? answer({ error: 'disk full' }, 500) : answer(state())))
    const store = await start()
    const closing = store.disablePerformance()
    expect(store.getPerformanceSnapshot().localSuppressed).toBe(true)
    await expect(closing).rejects.toThrow('disk full')
    await vi.advanceTimersByTimeAsync(2100)
    expect(store.getPerformanceSnapshot().status).toBe('ready')
    expect(store.getPerformanceSnapshot().localSuppressed).toBe(true)
    expect(store.getPerformanceSnapshot().error).toContain('disk full')
  })

  it('coalesces repeated emergency closes and cancels an in-flight enable', async () => {
    let postedEnable = false, disablePosts = 0
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
      if (init.method !== 'POST') return answer(state(false))
      if (url.endsWith('/disable')) { disablePosts++; return answer(state(false, 'epoch:2')) }
      postedEnable = true
      return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    }))
    const store = await start()
    const enabling = store.updatePerformance(on).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(postedEnable).toBe(true)
    const closing = store.disablePerformance()
    for (let i = 0; i < 1000; i++) expect(store.disablePerformance()).toBe(closing)
    await closing; await enabling
    expect(disablePosts).toBe(1)
    expect(store.getPerformanceSnapshot().state?.desired).toEqual(off)
    expect(store.getPerformanceSnapshot().saving).toBe(false)
  })

  it('skips queued writes after unload and releases timers', async () => {
    let gets = 0, posts = 0
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      if (init.method === 'POST') { posts++; return answer(state()) }
      if (++gets === 1) return answer(state(false))
      return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    }))
    const store = await start()
    const enabling = store.updatePerformance(on).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    const closing = store.disablePerformance()
    cleanups.pop()!()
    await enabling; await closing
    expect(posts).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(store.getPerformanceSnapshot().localSuppressed).toBe(true)
  })

  it('retries an absolute disable once with the conflict revision', async () => {
    let posts = 0
    const fetcher = vi.fn((_url: string, init: RequestInit) => {
      if (init.method !== 'POST') return answer(state())
      if (++posts === 1) return answer({ error: 'conflict', state: state(true, 'epoch:2') }, 409)
      expect(JSON.parse(String(init.body)).expectedRevision).toBe('epoch:2')
      return answer(state(false, 'epoch:3'))
    })
    vi.stubGlobal('fetch', fetcher)
    const store = await start()
    await store.disablePerformance()
    expect(posts).toBe(2)
    expect(store.getPerformanceSnapshot().state?.desired).toEqual(off)
  })

  it('discards a late poll response after the close committed', async () => {
    let gets = 0, resolveLate: ((value: Response) => void) | undefined
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      if (init.method === 'POST') return answer(state(false, 'epoch:2'))
      if (++gets === 2) return new Promise<Response>(resolve => { resolveLate = resolve })
      return answer(state())
    }))
    const store = await start()
    await vi.advanceTimersByTimeAsync(2000)
    await store.disablePerformance()
    resolveLate!(new Response(JSON.stringify(state(true)), { status: 200 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getPerformanceSnapshot().state?.desired).toEqual(off)
    expect(store.getPerformanceSnapshot().localSuppressed).toBe(false)
  })
})
