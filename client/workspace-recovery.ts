import { supportedHost } from './host-compat.ts'

/** 0.2.x compatibility for a Workspace follow consumer stopped by service replacement. */

type Snapshot = { state?: string; error?: { code?: string; details?: { endpoint?: string } } | null }
type Model = {
  getSnapshot(): Snapshot
  subscribe(listener: () => void): () => void
  replaceBaseline(value: unknown): void
  upsertView(value: unknown): void
  removeView(value: unknown): void
  replaceOrder(value: unknown): void
  replaceArchived(value: unknown): void
  replacePinned(value: unknown): void
  handleCarrierFailure(): void
  handleStreamFailure(error: unknown): void
}
type Control = { start(): void; dispose(): Promise<void> }
type Factory = (remote: unknown, options: { accept: Model; carrierFailed(): void; failed(error: unknown): void }) => Control
const owners = new WeakSet<object>()
const methods = ['getSnapshot', 'subscribe', 'replaceBaseline', 'upsertView', 'removeView', 'replaceOrder', 'replaceArchived', 'replacePinned', 'handleCarrierFailure', 'handleStreamFailure'] as const
type RemoteFailure = { isDSHRemoteError: true; code: string; details?: { endpoint?: string } }
const isRemoteFailure = (value: unknown): value is RemoteFailure => typeof value === 'object' && value !== null
  && (value as Partial<RemoteFailure>).isDSHRemoteError === true && typeof (value as Partial<RemoteFailure>).code === 'string'
const unavailable = (s: Snapshot) => s.state === 'error' && isRemoteFailure(s.error)
  && s.error.code === 'gateway/service-unavailable' && s.error.details?.endpoint === 'workspace/follow'

/** Uses the Host's exported stream implementation; never changes Workspace registrations. */

export function installWorkspaceRecovery(workspaces: unknown, remote: unknown, version: string | undefined, load: () => unknown): () => void {
  const noop = () => undefined
  if (!supportedHost(version) || !workspaces || typeof workspaces !== 'object') return noop
  const service = workspaces as { model?: Model; list?: unknown }
  const model = service.model
  if (!model || service.list !== model || methods.some(key => typeof model[key] !== 'function') || owners.has(model)) return noop
  if (!remote || typeof (remote as { $stream?: unknown }).$stream !== 'function') return noop
  owners.add(model)
  let active = true, running = false, attempts = 0, generation = 0, control: Control | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let terminal: unknown, hasOwnedStream = false
  const check = () => {
    if (!active || running || timer !== undefined || attempts >= 6 || !unavailable(model.getSnapshot())) return
    terminal = model.getSnapshot().error
    timer = setTimeout(start, attempts === 0 ? 0 : Math.min(250 * 2 ** (attempts - 1), 4000))
  }
  const start = () => {
    timer = undefined
    if (!active || running || !unavailable(model.getSnapshot())) return
    attempts++; running = true
    const currentGeneration = ++generation
    const current = () => active && generation === currentGeneration
    const guarded = Object.fromEntries(methods.map(key => [key, (...args: unknown[]) => {
      if (current()) return (model[key] as (...values: unknown[]) => unknown).apply(model, args)
    }])) as Model
    let candidate: Control | undefined
    let failedSynchronously = false
    const failed = (error: unknown) => {
      if (!current()) return
      generation++
      failedSynchronously = true
      if (isRemoteFailure(error)) model.handleStreamFailure(error)
      else {
        attempts = 6
        console.warn('[session-optimizer] Workspace recovery stopped after a local failure:', error)
      }
      // The failed official consumer has ended. Dispose before creating another.
      void Promise.resolve().then(() => candidate?.dispose()).catch(() => undefined).then(() => {
        if (!active) return
        if (control === candidate) control = undefined
        running = false
        check()
      })
    }
    try {
      const module = load() as { createWorkspaceStateStream?: Factory } | undefined
      if (typeof module?.createWorkspaceStateStream !== 'function') throw new Error('Workspace stream factory is unavailable')
      candidate = module.createWorkspaceStateStream(remote, {
        accept: guarded,
        carrierFailed: () => { if (current()) model.handleCarrierFailure() },
        failed,
      })
      if (typeof candidate?.start !== 'function' || typeof candidate.dispose !== 'function') throw new Error('Unsupported Workspace stream control')
      control = candidate; hasOwnedStream = true
      candidate.start()
    } catch (error) {
      // A loader/shape error must preserve the original terminal state, not erase it.
      if (!failedSynchronously) {
        generation++
        console.warn('[session-optimizer] Workspace stream recovery:', error)
        void Promise.resolve().then(() => candidate?.dispose?.()).catch(() => undefined).then(() => {
          if (!active) return
          if (control === candidate) control = undefined
          running = false
          check()
        })
      }
    }
  }
  const unsubscribe = model.subscribe(check)
  check()
  return () => {
    if (!active) return
    active = false
    owners.delete(model)
    unsubscribe()
    if (timer !== undefined) clearTimeout(timer)
    const current = control
    control = undefined
    void Promise.resolve().then(() => current?.dispose()).catch(error => console.warn('[session-optimizer] Workspace stream disposal:', error))
    // The original consumer is still terminal. Keep the last baseline, but expose
    // that there is no subscription after this compatibility owner is removed.
    if (hasOwnedStream && isRemoteFailure(terminal)) model.handleStreamFailure(terminal)
  }
}
