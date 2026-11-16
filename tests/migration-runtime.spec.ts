import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import { MigrationRuntime, installMigrationRuntime } from '../src/migration-runtime.ts'
const id = 'migration-runtime-test' as SessionId
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers() })
function fixture(subagents?: { listDescendants(id: SessionId, signal?: AbortSignal): Promise<{ kind: string; id: SessionId; activity?: string }[]> }) {
  const agent = { id, status: 'idle', phase: { kind: 'idle' }, inbox: { hasPending: false } }
  const agents = new Map<SessionId, typeof agent>()
  const session = {}
  const state = { running: false, queue: [] as unknown[], pendingInput: [] as unknown[] }
  const calls: string[] = []
  const handle = { agent, dispose: vi.fn(async () => { calls.push('dispose'); agents.delete(id) }) }
  const loop = {
    createAgent: vi.fn(async function(this: unknown, ..._args: unknown[]) { agents.set(id, agent); return handle }),
    resumeWith: vi.fn(async function(this: unknown, ..._args: unknown[]) { agents.set(id, agent); return handle }),
    resume: vi.fn(async function(this: unknown, ..._args: unknown[]) { agents.set(id, agent); return handle }),
  }
  const runtime = {
    agentLoop: loop, agents: { get: (key: SessionId) => agents.get(key) },
    sessions: { get: () => session, flush: vi.fn(async () => { calls.push('flush'); return true }) },
    sessionController: { state: vi.fn(async () => { calls.push('state'); return state }) },
    ...(subagents === undefined ? {} : { subagents }),
  }
  const watcher = new MigrationRuntime(runtime); cleanups.push(() => { watcher.dispose() })
  return { watcher, runtime, loop, agents, agent, handle, state, calls }
}
it.each(['createAgent', 'resume', 'resumeWith'] as const)('forwards original factory and releases via the exact official handle: %s', async name => {
  const f = fixture(), owner = {}, options = { sessionId: id }
  const result = await f.loop[name](owner, options)
  expect(result).toBe(f.handle)
  expect(f.loop[name]).not.toBeUndefined()
  await f.watcher.prepare(id)
  expect(f.calls).toEqual(['state', 'flush', 'state', 'dispose'])
  expect(f.handle.dispose).toHaveBeenCalledTimes(1)
  expect(f.agents.has(id)).toBe(false)
})
it('preserves the original factory promise and synchronous failures', async () => {
  const f = fixture(); f.watcher.dispose()
  const promise = Promise.resolve(f.handle), original = f.loop.resume
  original.mockReturnValueOnce(promise)
  const watcher = new MigrationRuntime(f.runtime); cleanups.push(() => { watcher.dispose() })
  expect(f.loop.resume()).toBe(promise)
  await promise
  const failure = new Error('synchronous factory failure')
  original.mockImplementationOnce(() => { throw failure })
  expect(() => f.loop.resume()).toThrow(failure)
  watcher.dispose()
  expect(f.loop.resume).toBe(original)
})
it('does not remove a later factory owner when this observer unloads', () => {
  const f = fixture(), later = vi.fn(async () => f.handle)
  Object.defineProperty(f.loop, 'resume', { value: later, configurable: true, writable: true })
  f.watcher.dispose()
  expect(f.loop.resume).toBe(later)
})
it('does not activate or query a cold session', async () => {
  const f = fixture(); await f.watcher.prepare(id)
  expect(f.runtime.sessionController.state).not.toHaveBeenCalled(); expect(f.handle.dispose).not.toHaveBeenCalled()
})
it.each(['running', 'queue', 'pendingInput', 'maintenance', 'inbox'] as const)('waits without cancelling work, then releases when idle: %s', async reason => {
  vi.useFakeTimers(); const f = fixture(); await f.loop.resume()
  if (reason === 'running') f.state.running = true
  if (reason === 'queue') f.state.queue = [{}]
  if (reason === 'pendingInput') f.state.pendingInput = [{}]
  if (reason === 'maintenance') f.agent.phase.kind = 'maintenance'
  if (reason === 'inbox') f.agent.inbox.hasPending = true
  const notice = vi.fn(), operation = f.watcher.prepare(id, notice)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.handle.dispose).not.toHaveBeenCalled(); expect(notice).toHaveBeenCalledWith(expect.stringContaining('结束后自动继续'))
  f.state.running = false; f.state.queue = []; f.state.pendingInput = []; f.agent.phase.kind = 'idle'; f.agent.inbox.hasPending = false
  await vi.advanceTimersByTimeAsync(1000); await operation
  expect(f.handle.dispose).toHaveBeenCalledTimes(1); expect(notice).toHaveBeenLastCalledWith()
})
it('rechecks after flush, joins the same pending release and never disposes while busy', async () => {
  vi.useFakeTimers(); const f = fixture(); await f.loop.resume()
  f.runtime.sessions.flush.mockImplementationOnce(async () => { f.state.running = true; return true })
  const first = f.watcher.prepare(id), second = f.watcher.prepare(id)
  expect(first).toBe(second)
  await vi.advanceTimersByTimeAsync(0); expect(f.handle.dispose).not.toHaveBeenCalled()
  f.state.running = false; await vi.advanceTimersByTimeAsync(1000); await first
  expect(f.handle.dispose).toHaveBeenCalledTimes(1)
})
it('does not steal handles created before observation and does not dispose agents on uninstall', async () => {
  const f = fixture(); f.agents.set(id, f.agent)
  await expect(f.watcher.prepare(id)).rejects.toThrow('监听启用前')
  f.watcher.dispose(); expect(f.handle.dispose).not.toHaveBeenCalled(); expect(f.agents.has(id)).toBe(true)
})
it('aborts passive waiting on uninstall and restores factories', async () => {
  vi.useFakeTimers(); const f = fixture(), wrapped = f.loop.resume; await f.loop.resume(); f.state.running = true
  const operation = f.watcher.prepare(id), rejected = expect(operation).rejects.toThrow('卸载')
  await vi.advanceTimersByTimeAsync(0); f.watcher.dispose(); await rejected
  expect(f.loop.resume).not.toBe(wrapped); expect(f.handle.dispose).not.toHaveBeenCalled()
})
it('waits for progressing descendants instead of cancelling them with parent teardown', async () => {
  vi.useFakeTimers(); let activity = 'running'
  const f = fixture({ listDescendants: async () => [{ kind: 'child', id: 'child' as SessionId, activity }] }); await f.loop.resume()
  const operation = f.watcher.prepare(id)
  await vi.advanceTimersByTimeAsync(0); expect(f.handle.dispose).not.toHaveBeenCalled()
  activity = 'inactive'; await vi.advanceTimersByTimeAsync(1000); await operation
  expect(f.handle.dispose).toHaveBeenCalledOnce()
})
it('preserves the parent handle when descendant state has an unavailable diagnostic', async () => {
  const f = fixture({ listDescendants: async () => [{ kind: 'diagnostic', id: 'child' as SessionId }] }); await f.loop.resume()
  await expect(f.watcher.prepare(id)).rejects.toThrow('子对话状态尚未确认')
  expect(f.handle.dispose).not.toHaveBeenCalled()
})
it('restores prototype factories through a real traceable Service on observer unload', async () => {
  const f = fixture(); f.watcher.dispose()
  const ctx = new Context(); cleanups.push(async () => { await ctx.fiber.dispose() })
  for (const [name, value] of Object.entries(f.runtime)) if (name !== 'agentLoop') ctx.provide(name, value)
  const callerNames: string[] = []
  class Loop extends Service {
    constructor(scope: Context) { super(scope, 'agentLoop') }
    async resume(...args: unknown[]) { callerNames.push(this.ctx.fiber.name); return await f.loop.resume(...args) }
  }
  let concrete: Loop | undefined
  await ctx.plugin({ name: 'loop-provider', apply(scope: Context) { concrete = new Loop(scope) } })
  let prepare: ((id: string) => Promise<void>) | undefined
  const observer = ctx.plugin({ name: 'observer', apply(scope: Context) { prepare = installMigrationRuntime(scope) } })
  await observer.await()
  await ctx.plugin({ name: 'caller', inject: ['agentLoop'], async apply(scope: Context) {
    const loop = scope.get('agentLoop') as Loop
    await loop.resume()
  } })
  expect(callerNames).toEqual(['caller'])
  await prepare!(id)
  expect(f.handle.dispose).toHaveBeenCalledOnce()
  await observer.dispose()
  expect(Object.getOwnPropertyDescriptor(concrete!, 'resume')).toBeUndefined()
})

it('tracks factory handles through the real Cordis injected service view', async () => {
  const f = fixture(); f.watcher.dispose()
  const ctx = new Context(); cleanups.push(async () => { await ctx.fiber.dispose() })
  for (const [name, service] of Object.entries(f.runtime)) ctx.provide(name, service)
  let prepare: ((id: string) => Promise<void>) | undefined
  await ctx.plugin({ name: 'migration-runtime-fixture', apply(scope: Context) { prepare = installMigrationRuntime(scope) } })
  await f.loop.resume()
  await prepare!(id)
  expect(f.handle.dispose).toHaveBeenCalledTimes(1)
})
