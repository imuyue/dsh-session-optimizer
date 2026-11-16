import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'

interface Handle { agent: { id: SessionId }; dispose(): Promise<void> }
interface State { running: boolean; queue: readonly unknown[] | null; pendingInput: readonly unknown[] }
interface Runtime {
  agentLoop: object
  agents: { get(id: SessionId): Handle['agent'] | undefined }
  sessions: { get(id: SessionId): unknown; flush(session: never): Promise<boolean> }
  sessionController: { state(request: { sessionId: SessionId }, signal: AbortSignal): Promise<State> }
  subagents?: { listDescendants(id: SessionId, signal?: AbortSignal): Promise<readonly { kind: string; id: SessionId; activity?: string }[]> }
}
export class MigrationSessionBusyError extends Error {
  constructor(readonly sessionId: string, message = '对话正在运行、排队或等待输入，请等待结束后再转换。', readonly waitable = true) { super(message); this.name = 'MigrationSessionBusyError' }
}

/** Borrow official factory handles; never dispose private fibers or remove file locks. */
export class MigrationRuntime {
  private readonly handles = new WeakMap<object, Handle>()
  private readonly pending = new Map<string, Promise<void>>()
  private active = true
  private readonly lifetime = new AbortController()
  private readonly restore: (() => void)[] = []
  constructor(private readonly runtime: Runtime) {
    try { for (const name of ['createAgent', 'resume', 'resumeWith'] as const) {
      const target = runtime.agentLoop
      const descriptor = Object.getOwnPropertyDescriptor(target, name)
      let declared = descriptor
      let prototype: object | null = target
      while (declared === undefined && (prototype = Object.getPrototypeOf(prototype) as object | null) !== null) declared = Object.getOwnPropertyDescriptor(prototype, name)
      const original: unknown = declared?.value
      if (typeof original !== 'function') continue
      const owner = this
      const remember = (result: unknown): void => {
        if (owner.active && result !== null && typeof result === 'object') {
          const candidate = result as Partial<Handle>
          if (candidate.agent !== undefined && typeof candidate.agent === 'object' && typeof candidate.dispose === 'function') owner.handles.set(candidate.agent, candidate as Handle)
        }
      }
      const wrapped = function(this: unknown, ...args: unknown[]): unknown {
        const result: unknown = Reflect.apply(original, this, args)
        if (result instanceof Promise) void result.then(remember, () => undefined)
        else remember(result)
        return result
      }
      Object.defineProperty(target, name, { value: wrapped, configurable: true, writable: true })
      this.restore.push(() => {
        if (Object.getOwnPropertyDescriptor(target, name)?.value !== wrapped) return
        if (descriptor === undefined) Reflect.deleteProperty(target, name)
        else Object.defineProperty(target, name, descriptor)
      })
    } } catch (error) { this.dispose(); throw error }
  }
  dispose(): void { this.active = false; this.lifetime.abort(new Error('会话生命周期监听已卸载')); for (const undo of this.restore.reverse()) undo() }
  prepare(id: string, notice?: (message?: string) => void): Promise<void> {
    const old = this.pending.get(id)
    if (old !== undefined) return old
    if (this.pending.size >= 128) return Promise.reject(new Error('等待转换的对话过多，请稍后重试。'))
    const operation = this.waitAndRelease(id as SessionId, notice)
    this.pending.set(id, operation)
    void operation.then(() => { if (this.pending.get(id) === operation) this.pending.delete(id) }, () => { if (this.pending.get(id) === operation) this.pending.delete(id) })
    return operation
  }
  private async waitAndRelease(id: SessionId, notice?: (message?: string) => void): Promise<void> {
    const deadline = Date.now() + 30 * 60_000
    try {
      for (;;) {
        this.lifetime.signal.throwIfAborted()
        try { await this.release(id); return } catch (error) {
          if (!(error instanceof MigrationSessionBusyError) || !error.waitable) throw error
          if (Date.now() >= deadline) throw new Error('等待对话结束已超过30分钟，请在对话空闲后重新转换。')
          notice?.('对话正在运行、排队或等待输入，结束后自动继续转换。')
          await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(this.lifetime.signal.reason) }
            const timer = setTimeout(() => { this.lifetime.signal.removeEventListener('abort', abort); resolve() }, 1000)
            this.lifetime.signal.addEventListener('abort', abort, { once: true })
            if (this.lifetime.signal.aborted) abort()
          })
        }
      }
    } finally { notice?.() }
  }
  private async assertIdle(id: SessionId): Promise<void> {
    const state = await this.runtime.sessionController.state({ sessionId: id }, AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(5000)]))
    if (state.running || (state.queue?.length ?? 0) > 0 || state.pendingInput.length > 0) throw new MigrationSessionBusyError(id)
  }
  private async release(id: SessionId): Promise<void> {
    if (!this.active) throw new Error('会话生命周期监听已卸载，请刷新后重试。')
    const agent = this.runtime.agents.get(id)
    if (agent === undefined) return
    await this.assertIdle(id)
    const descendants = await this.runtime.subagents?.listDescendants(id, AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(5000)])) ?? []
    if (descendants.some(row => row.kind !== 'child')) throw new MigrationSessionBusyError(id, '子对话状态尚未确认，请稍后重试转换。', false)
    if (descendants.some(row => row.activity === 'running')) throw new MigrationSessionBusyError(id)
    for (const row of descendants) if (this.runtime.agents.get(row.id) !== undefined) await this.assertIdle(row.id)
    const session = this.runtime.sessions.get(id)
    if (session !== undefined) await this.runtime.sessions.flush(session as never)
    await this.assertIdle(id)
    if (!this.active) throw new Error('会话生命周期监听已卸载，请刷新后重试。')
    const current = this.runtime.agents.get(id)
    if (current !== agent) throw new MigrationSessionBusyError(id, '对话的运行状态发生变化，请稍后重试转换。')
    if (agent === undefined) return
    const handle = this.handles.get(agent)
    if (handle === undefined) throw new MigrationSessionBusyError(id, '该对话在生命周期监听启用前已打开。请重启 DSH 后再转换；正在运行的对话请先等待结束。', false)
    const phase: unknown = Reflect.get(agent, 'phase')
    const inbox: unknown = Reflect.get(agent, 'inbox')
    if (Reflect.get(agent, 'status') !== 'idle' || phase === null || typeof phase !== 'object' || Reflect.get(phase, 'kind') !== 'idle' || inbox === null || typeof inbox !== 'object' || Reflect.get(inbox, 'hasPending') !== false) throw new MigrationSessionBusyError(id)
    for (const row of descendants) {
      const child = this.runtime.agents.get(row.id)
      if (child !== undefined && (Reflect.get(child, 'status') !== 'idle' || Reflect.get(Reflect.get(child, 'phase') ?? {}, 'kind') !== 'idle' || Reflect.get(Reflect.get(child, 'inbox') ?? {}, 'hasPending') !== false)) throw new MigrationSessionBusyError(id)
    }
    // No asynchronous gap between the final idle snapshot and invoking the official teardown.
    await handle.dispose()
    if (this.runtime.agents.get(id) === agent) throw new Error('对话尚未完成释放，请稍后重试。')
    this.handles.delete(agent)
  }
}

export function installMigrationRuntime(ctx: Context): (id: string, notice?: (message?: string) => void) => Promise<void> {
  let current: MigrationRuntime | undefined
  ctx.inject(['agentLoop', 'agents', 'sessions', 'sessionController'], runtimeCtx => {
    const services = runtimeCtx as unknown as Runtime
    const subagents = runtimeCtx.get('subagents') as Runtime['subagents']
    const runtime = new MigrationRuntime({ agentLoop: services.agentLoop, agents: services.agents, sessions: services.sessions, sessionController: services.sessionController, ...(subagents === undefined ? {} : { subagents }) })
    current = runtime
    runtimeCtx.effect(() => () => { if (current === runtime) current = undefined; runtime.dispose() })
  })
  return async (id, notice) => {
    if (current === undefined) throw new Error('会话生命周期服务尚未就绪，请稍后重试转换。')
    await current.prepare(id, notice)
  }
}
