import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { registerConsole } from '../src/console.ts'
import { createPreferencesHost } from '../src/preferences.ts'
import { PerformanceController } from '../src/performance.ts'
import type { PreviewAnswer } from '../src/history-preview.ts'
import { createPerformanceTool } from '../src/performance-tool.ts'

const roots: string[] = []
const hosts: PerformanceController[] = []
afterEach(async () => { hosts.splice(0).forEach(h => h.dispose()); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function mount(read: (id: string, signal?: AbortSignal) => Promise<PreviewAnswer> = async () => ({ available: false, reason: 'unavailable' })) {
  const root = await mkdtemp(join(tmpdir(), 'dso-performance-route-')); roots.push(root)
  const preferences = createPreferencesHost(join(root, 'preferences.json'), ['sqlite'], () => undefined)
  const host = new PerformanceController(preferences, { historyWindow: { supported: true, reason: 'preview' }, virtualChat: { supported: true, reason: 'layout' } }); hosts.push(host)
  const routes = new Map<string, { fetch(request: Request): Promise<Response> }>()
  const ctx = { connection: { fetch: { register: (route: { path: string; fetch(request: Request): Promise<Response> }) => { routes.set(route.path, route); return async () => { routes.delete(route.path) } } } } } as unknown as Context
  registerConsole(ctx, { root, settings: { journalMode: 'wal', synchronous: 'full', busyTimeoutMs: 5000 }, storageThread: 'inline', preferences: { host: preferences, formats: ['sqlite'] }, performance: host, historyPreview: { read } })
  const call = async (path: string, body?: unknown, signal?: AbortSignal) => {
    const route = routes.get(`/api/session-optimizer${path.split('?')[0]}`)!
    const response = await route.fetch(new Request(`http://host/api/session-optimizer${path}`, { ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), ...(signal === undefined ? {} : { signal }) }))
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  return { host, preferences, call }
}

describe('performance Fetch routes share the Host controller', () => {
  it('keeps HTTP alive while the RPC child waits for its webServer dependency', async () => {
    const { host } = await mount()
    const ctx = new Context()
    const paths = new Set<string>()
    let rpcCalls = 0
    ctx.provide('connection', {
      fetch: { register(route: { path: string }) { paths.add(route.path); ctx.effect(() => () => { paths.delete(route.path) }); return async () => { paths.delete(route.path) } } },
      rpc: { handle() { rpcCalls++; return async () => {} } },
    })
    try {
      await ctx.plugin({ name: 'performance-route-dependency-test', inject: ['connection'], apply(scope: Context) {
        registerConsole(scope, { root: '/', settings: { journalMode: 'wal', synchronous: 'full', busyTimeoutMs: 100 }, storageThread: 'inline', performance: host })
      } })
      expect(paths.has('/api/session-optimizer/performance')).toBe(true)
      expect(rpcCalls).toBe(0)
      ctx.provide('webServer', {})
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(rpcCalls).toBe(1)
      expect(paths.has('/api/session-optimizer/performance')).toBe(true)
    } finally { await ctx.fiber.dispose() }
  })
  it('bounds the latest page report without changing settings or accepting it as a global ACK', async () => {
    const { call, host } = await mount()
    const report = { revision: host.read().revision, generation: host.read().generation, status: 'ready', historyWindow: false, virtualChat: false, reason: 'official' }
    expect((await call('/performance/client-report', report)).status).toBe(200)
    expect(host.read().lastClientReport?.current).toBe(true)
    expect(host.read().clientApplied).toBe('unconfirmed')
    expect((await call('/performance/client-report', { ...report, reason: 'x'.repeat(513) })).status).toBe(400)
    host.update({ enabled: true, virtualChat: true })
    expect(host.read().lastClientReport?.current).toBe(false)
    expect(host.read().desired.enabled).toBe(true)
  })
  it('exposes exactly the same saved state to the tool and UI callers', async () => {
    const { call, host, preferences } = await mount()
    const tool = createPerformanceTool(host)
    const initial = await tool.execute({ action: 'status' }) as { revision: string }
    const updated = await tool.execute({ action: 'update', patch: { enabled: true, virtualChat: true }, expectedRevision: initial.revision })
    expect((await call('/performance')).body).toEqual(updated)
    expect(preferences.read().performance.virtualChat).toBe(true)
    await expect(tool.execute({ action: 'disable', expectedRevision: initial.revision })).rejects.toThrow()
    const disabled = await tool.execute({ action: 'disable', expectedRevision: host.read().revision })
    expect((await call('/performance')).body).toEqual(disabled)
    expect(preferences.read().performance).toEqual({ enabled: false, historyWindow: false, virtualChat: false })
    await expect(tool.execute({ action: 'status', patch: {} })).rejects.toThrow()
  })
  it('accepts inert adapter placeholders without hiding enabling intent', async () => {
    const { host } = await mount()
    const tool = createPerformanceTool(host)
    const off = { enabled: false, historyWindow: false, virtualChat: false }
    expect(await tool.execute({ action: 'status', expectedRevision: '', patch: off })).toEqual(host.read())
    host.update({ enabled: true, historyWindow: true })
    const revision = host.read().revision
    await expect(tool.execute({ action: 'status', expectedRevision: '', patch: { ...off, enabled: true } })).rejects.toThrow()
    expect(host.read().desired.enabled).toBe(true)
    await expect(tool.execute({ action: 'disable', expectedRevision: revision, patch: { ...off, enabled: true } })).rejects.toThrow()
    await tool.execute({ action: 'disable', expectedRevision: revision, patch: off })
    expect(host.read().desired).toEqual(off)
  })
  it('defaults off, requires CAS, and persists disable through the same store', async () => {
    const { call, host, preferences } = await mount()
    expect((await call('/performance')).body.desired).toEqual({ enabled: false, historyWindow: false, virtualChat: false })
    expect((await call('/performance', { patch: { enabled: true } })).status).toBe(400)
    expect((await call('/performance', { patch: { enabled: true, historyWindow: true }, expectedRevision: host.read().revision })).status).toBe(200)
    const stale = await call('/performance', { patch: { enabled: false }, expectedRevision: 'old:0' })
    expect(stale.status).toBe(409); expect(stale.body.state).toBeDefined()
    expect((await call('/performance/disable', { expectedRevision: host.read().revision })).status).toBe(200)
    expect(preferences.read().performance).toEqual({ enabled: false, historyWindow: false, virtualChat: false })
  })
  it('blocks settings-route bypass and malformed patches', async () => {
    const { call, host } = await mount()
    expect((await call('/settings', { performance: { enabled: true } })).status).toBe(400)
    expect((await call('/performance', { patch: { enabled: 'yes' }, expectedRevision: host.read().revision })).status).toBe(400)
    expect(host.read().desired.enabled).toBe(false)
  })
  it('never starts the optional reader for disabled or stale configuration', async () => {
    let calls = 0
    const { call, host } = await mount(async () => { calls++; return { available: false, reason: 'unavailable' } })
    expect((await call(`/history-preview?id=a&revision=${encodeURIComponent(host.read().revision)}`)).body.available).toBe(false)
    expect((await call('/history-preview?id=a&revision=stale')).body.available).toBe(false)
    expect(calls).toBe(0)
  })
  it('aborts and discards a late preview when disable commits', async () => {
    let finish: ((value: PreviewAnswer) => void) | undefined, activeSignal: AbortSignal | undefined
    const { call, host } = await mount((_id, signal) => { activeSignal = signal; return new Promise(resolve => { finish = resolve }) })
    host.update({ enabled: true, historyWindow: true })
    const pending = call(`/history-preview?id=a&revision=${encodeURIComponent(host.read().revision)}`)
    expect(host.read().pendingRequests).toBe(1)
    await call('/performance/disable', { expectedRevision: host.read().revision })
    expect(activeSignal?.aborted).toBe(true)
    finish!({ available: true, sessionId: 'a', from: 0, to: 2, total: 2, revision: 1, messages: [] })
    expect((await pending).body.available).toBe(false)
    expect(host.read().pendingRequests).toBe(0)
  })
  it('preserves separate configuration and database revisions and disposes leases', async () => {
    const { call, host } = await mount(async () => ({ available: true, sessionId: 'a', from: 0, to: 2, total: 2, revision: 7, messages: [] }))
    host.update({ enabled: true, historyWindow: true })
    const answer = await call(`/history-preview?id=a&revision=${encodeURIComponent(host.read().revision)}`)
    expect(answer.body.revision).toBe(7)
    expect(answer.body.configurationRevision).toBe(host.read().revision)
    expect(answer.body.generation).toBe(host.read().generation)
    expect(host.read().pendingRequests).toBe(0)
  })
})
