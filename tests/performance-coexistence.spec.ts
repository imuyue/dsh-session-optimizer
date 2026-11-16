import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it } from 'vitest'
import * as Root from '../src/index.ts'
import * as Addon from '../src/performance-addon.ts'
import { PAGE_TRANSFER_POLICY, currentPageTransferFormat, registerPageTransferPolicy } from '../src/page-transfer.ts'
import type { PerformanceToolDefinition } from '../src/performance-tool.ts'

const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  Reflect.deleteProperty(globalThis, PAGE_TRANSFER_POLICY)
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'dso-performance-coexist-'))
  directories.push(home)
  const ctx = new Context(); contexts.push(ctx)
  const routes = new Map<string, { fetch(request: Request): Promise<Response> }>()
  const tools = new Map<string, PerformanceToolDefinition>()
  const fetchRegistry = {
    ctx,
    [Service.tracker]: { property: 'ctx' },
    register(route: { path: string; fetch(request: Request): Promise<Response> }) {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route)
      const dispose = async () => { if (routes.get(route.path) === route) routes.delete(route.path) }
      this.ctx.effect(() => dispose)
      return dispose
    },
  }
  ctx.provide('connection', { ctx, [Service.tracker]: { property: 'ctx' }, fetch: fetchRegistry })
  ctx.provide('tools', { register(tool: PerformanceToolDefinition) {
    if (tools.has(tool.name)) throw new Error(`duplicate tool ${tool.name}`)
    tools.set(tool.name, tool)
    return () => { if (tools.get(tool.name) === tool) tools.delete(tool.name) }
  } })
  const rootConfig = { root: join(home, 'sqlite'), stateDirectory: join(home, 'root-state'), storageThread: 'inline' as const, warmupSessions: 0 }
  const addonConfig = { root: rootConfig.root, preferencesPath: join(home, 'addon-state', 'preferences.json') }
  const root = () => ctx.plugin(Root, rootConfig)
  const addon = () => ctx.plugin(Addon, addonConfig)
  return { ctx, home, routes, tools, root, addon, addonConfig }
}

async function verifyBackend(ctx: Context, home: string) {
  const backend = ctx.sessionPersistence
  expect(backend.name).toBe(Root.name)
  const header = { version: 4, id: 'coexist-session' as SessionId, createdAt: 1700000000000, cwd: home, isSeeded: false, delegationDepth: 0 } as SessionHeader
  const handle = await backend.create(header, {})
  await handle.append([
    { type: 'turn/start', seq: 0, time: 1700000000001, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 1700000000002, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as never)
  await handle.close()
  const read = await backend.open(header.id, 'read')
  try { expect((await read.read()).events.map(event => event.type)).toEqual(['turn/start', 'turn/end']) }
  finally { await read.close() }
}

it.each(['root-first', 'addon-first'] as const)('keeps SQLite and the original console with one optional owner: %s', async order => {
  const f = await fixture()
  const first = await (order === 'root-first' ? f.root() : f.addon())
  const face = Reflect.get(globalThis, PAGE_TRANSFER_POLICY)
  const performanceRoute = f.routes.get('/api/session-optimizer/performance')
  const ownerTool = f.tools.get('session_performance')!
  expect(face).toBeDefined(); expect(ownerTool).toBeDefined()
  const second = await (order === 'root-first' ? f.addon() : f.root())
  expect(Reflect.get(globalThis, PAGE_TRANSFER_POLICY)).toBe(face)
  expect(f.routes.get('/api/session-optimizer/performance')).toBe(performanceRoute)
  expect(f.tools.get('session_performance')).toBe(ownerTool)
  expect(f.routes.has('/api/session-optimizer/overview')).toBe(true)
  expect(f.routes.has('/api/session-optimizer/settings')).toBe(true)
  await verifyBackend(f.ctx, f.home)
  const status = await ownerTool.execute({ action: 'status' }) as { revision: string }
  await ownerTool.execute({ action: 'update', expectedRevision: status.revision, patch: { enabled: true, historyWindow: true } })
  expect(currentPageTransferFormat()).toBe('lines')
  if (order === 'root-first') await expect(access(f.addonConfig.preferencesPath)).rejects.toThrow()
  await second.dispose()
  expect(Reflect.get(globalThis, PAGE_TRANSFER_POLICY)).toBe(face)
  expect(currentPageTransferFormat()).toBe('lines')
  // A skipped row never becomes owner automatically when the original leaves.
  await first.dispose()
  expect(Object.hasOwn(globalThis, PAGE_TRANSFER_POLICY)).toBe(false)
})

it.each([undefined, null, {}, { version: 99, enabled: () => true }])('treats an unknown own policy as occupied without inspecting its face: %j', async face => {
  const f = await fixture()
  Object.defineProperty(globalThis, PAGE_TRANSFER_POLICY, { value: face, configurable: true })
  await f.addon()
  await f.root()
  expect(Reflect.get(globalThis, PAGE_TRANSFER_POLICY)).toBe(face)
  expect(f.tools.size).toBe(0)
  expect(f.routes.has('/api/session-optimizer/performance')).toBe(false)
  expect(f.routes.has('/api/session-optimizer/overview')).toBe(true)
  await expect(access(f.addonConfig.preferencesPath)).rejects.toThrow()
  await verifyBackend(f.ctx, f.home)
  await f.ctx.fiber.dispose()
  expect(Object.hasOwn(globalThis, PAGE_TRANSFER_POLICY)).toBe(true)
  expect(Reflect.get(globalThis, PAGE_TRANSFER_POLICY)).toBe(face)
})

it('skips an accessor owner without invoking it and keeps duplicate registration strict', async () => {
  const f = await fixture()
  const get = () => { throw new Error('foreign getter must not execute') }
  Object.defineProperty(globalThis, PAGE_TRANSFER_POLICY, { get, configurable: true })
  await f.addon(); await f.root()
  expect(Object.getOwnPropertyDescriptor(globalThis, PAGE_TRANSFER_POLICY)?.get).toBe(get)
  expect(() => registerPageTransferPolicy(() => false)).toThrow('already registered')
  expect(f.routes.has('/api/session-optimizer/settings')).toBe(true)
  expect(f.tools.size).toBe(0)
})

it('keeps a skipped Root backend alive after the add-on owner unloads without taking over', async () => {
  const f = await fixture()
  const owner = await f.addon()
  await f.root()
  await owner.dispose()
  expect(Object.hasOwn(globalThis, PAGE_TRANSFER_POLICY)).toBe(false)
  expect(f.tools.size).toBe(0)
  expect(f.routes.has('/api/session-optimizer/performance')).toBe(false)
  expect(f.routes.has('/api/session-optimizer/settings')).toBe(true)
  await verifyBackend(f.ctx, f.home)
})

it('does not let a stale owner disposer delete a later policy', async () => {
  const f = await fixture()
  const owner = await f.addon()
  Reflect.deleteProperty(globalThis, PAGE_TRANSFER_POLICY)
  const disposeNew = registerPageTransferPolicy(() => true)
  try {
    const current = Reflect.get(globalThis, PAGE_TRANSFER_POLICY)
    await owner.dispose()
    expect(Reflect.get(globalThis, PAGE_TRANSFER_POLICY)).toBe(current)
    expect(currentPageTransferFormat()).toBe('lines')
  } finally { disposeNew() }
})
