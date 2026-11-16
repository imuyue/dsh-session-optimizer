import { mkdtemp, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import { apply } from '../src/performance-addon.ts'
import type { PerformanceToolDefinition } from '../src/performance-tool.ts'
import { currentPageTransferFormat } from '../src/page-transfer.ts'

const roots: string[] = []
const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
  expect(currentPageTransferFormat()).toBe('bytes')
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('mounts only four performance routes and one shared tool, defaults off, and never creates a session root', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dso-performance-addon-')); roots.push(home)
  const root = join(home, 'sessions-sqlite'), preferencesPath = join(home, 'performance', 'preferences.json')
  const routes = new Map<string, { fetch(request: Request): Promise<Response> }>()
  let tool: PerformanceToolDefinition | undefined
  const injections: string[][] = []
  const connection = { fetch: { register(route: { path: string; fetch(request: Request): Promise<Response> }) { routes.set(route.path, route); return async () => { routes.delete(route.path) } } } }
  const tools = { register(value: PerformanceToolDefinition) { tool = value; return () => { tool = undefined } } }
  const ctx = {
    connection,
    get: (key: string) => key === 'tools' ? tools : undefined,
    // Run the same resource generators used by the Host, retaining each yielded disposer.
    effect(callback: () => Generator<() => unknown> | (() => unknown)) {
      const result = callback()
      if (typeof result === 'function') cleanup.push(result)
      else for (const dispose of result) cleanup.push(dispose)
    },
    inject(names: string[], callback: (context: Context) => unknown) { injections.push(names); callback(ctx as unknown as Context) },
    plugin() { throw new Error('an independent add-on must not mount a provider') },
  }
  apply(ctx as unknown as Context, { root, preferencesPath })
  expect(injections).toEqual([['connection'], ['tools']])
  expect([...routes.keys()].sort()).toEqual(['/api/session-optimizer/history-preview', '/api/session-optimizer/performance', '/api/session-optimizer/performance/client-report', '/api/session-optimizer/performance/disable'])
  expect(tool?.name).toBe('session_performance')
  const status = await tool!.execute({ action: 'status' }) as { revision: string; desired: unknown }
  expect(status.desired).toEqual({ enabled: false, historyWindow: false, virtualChat: false })
  await expect(access(root)).rejects.toThrow()
  await expect(access(preferencesPath)).rejects.toThrow()
  const request = new Request('http://host/api/session-optimizer/performance')
  expect(await (await routes.get('/api/session-optimizer/performance')!.fetch(request)).json()).toEqual(await tool!.execute({ action: 'status' }))
  expect(currentPageTransferFormat()).toBe('bytes')
  const changed = await tool!.execute({ action: 'update', expectedRevision: status.revision, patch: { enabled: true, historyWindow: true, virtualChat: true } }) as { revision: string }
  expect(currentPageTransferFormat()).toBe('lines')
  await tool!.execute({ action: 'disable', expectedRevision: changed.revision })
  expect(currentPageTransferFormat()).toBe('bytes')
  await expect(access(preferencesPath)).resolves.toBeUndefined()
  await expect(access(root)).rejects.toThrow()
})

it('rejects relative storage or preferences paths before mounting any resources', () => {
  const ctx = { effect() { throw new Error('resources must not mount') } } as unknown as Context
  expect(() => apply(ctx, { root: 'relative-root', preferencesPath: join(tmpdir(), 'prefs.json') })).toThrow('must be absolute')
  expect(() => apply(ctx, { root: tmpdir(), preferencesPath: 'relative.json' })).toThrow('must be absolute')
})
