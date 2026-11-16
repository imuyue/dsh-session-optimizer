/** First-follow-only history budget. No React, log mutation, or global Remote replacement. */
export const INITIAL_HISTORY_FACTORY = Symbol.for('dsh.session-optimizer.initial-history')
export interface InitialHistoryPolicy { enabled: boolean; generation: string | number }
export type InitialHistoryPolicyGetter = () => InitialHistoryPolicy | boolean
export interface InitialHistoryDiagnostics {
  readonly hookCalls: number
  readonly attempts: number
  readonly used: number
  readonly fallbacks: number
  readonly lastHookCompatible: boolean
  readonly lastUsedGeneration?: string | number
}
export interface InitialHistoryFactoryOptions {
  readonly onChange?: (diagnostics: InitialHistoryDiagnostics) => void
}
type HistoryEvent = { kind: 'attempt' | 'used' | 'fallback'; generation: string | number }
interface RemoteShape {
  $stream(...args: unknown[]): unknown
  session: {
    follow(request: Record<string, unknown>, signal?: AbortSignal): AsyncIterable<unknown>
    page(...args: unknown[]): unknown
  }
}
const POLICY_CHANGED = Symbol('initial-history-policy-changed')
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function policy(get: InitialHistoryPolicyGetter): InitialHistoryPolicy {
  try {
    const state = get()
    if (typeof state === 'boolean') return { enabled: state, generation: 0 }
    if (record(state) && typeof state.enabled === 'boolean' && (typeof state.generation === 'string' || Number.isSafeInteger(state.generation))) return state as unknown as InitialHistoryPolicy
  } catch { /* A missing/disposed plugin always selects the official path. */ }
  return { enabled: false, generation: 0 }
}
function eligible(request: Record<string, unknown>): boolean {
  return record(request.address) && request.address.kind === 'session' && typeof request.address.sessionId === 'string' &&
    request.activate === true && request.assistantStream === true && request.maxMessages === 500 &&
    record(request.turnWindow) && request.turnWindow.minMessages === 50 && request.turnWindow.minTurns === 2
}
function completeBoundary(frame: Record<string, unknown>): boolean {
  if (!Array.isArray(frame.records)) return false
  if (frame.records.length === 0) return frame.hasMore === false
  const first: unknown = frame.records[0]
  return record(first) && record(first.event) && first.event.type === 'turn/start'
}
function compatible(remote: unknown): remote is RemoteShape {
  return record(remote) && typeof remote.$stream === 'function' && record(remote.session) &&
    typeof remote.session.follow === 'function' && typeof remote.session.page === 'function'
}
/**
 * Keep Gateway.open(HISTORY_PAGE_OPTIONS) unchanged. Only rewrite the first outbound
 * follow request; page/repair and all reconnects retain the original request.
 * Boolean policies are supported, but revision-aware callers should return generation.
 */
export function createInitialHistoryRemote<T>(remote: T, getPolicy: InitialHistoryPolicyGetter, onEvent?: (event: HistoryEvent) => void): T {
  const notify = (kind: HistoryEvent['kind'], generation: string | number) => { try { onEvent?.({ kind, generation }) } catch { /* Diagnostic callbacks do not alter the journal. */ } }
  if (!compatible(remote)) return remote
  let snapshotSeen = false
  const facade: RemoteShape = {
    $stream: (...args) => remote.$stream(...args),
    session: {
      page: (...args) => remote.session.page(...args),
      async *follow(request, callerSignal) {
        callerSignal?.throwIfAborted()
        const initial = policy(getPolicy)
        const small = !snapshotSeen && initial.enabled && eligible(request)
        if (small) notify('attempt', initial.generation)
        let useSmall = small
        while (true) {
          const controller = new AbortController()
          let changed = false
          let committed = false
          let timer: ReturnType<typeof setInterval> | undefined
          const invalidate = () => {
            if (!useSmall || committed || changed) return
            const current = policy(getPolicy)
            if (!current.enabled || current.generation !== initial.generation) {
              changed = true
              controller.abort(POLICY_CHANGED)
            }
          }
          const cancel = () => controller.abort(callerSignal?.reason)
          callerSignal?.addEventListener('abort', cancel, { once: true })
          if (callerSignal?.aborted) cancel()
          if (useSmall) timer = setInterval(invalidate, 25)
          const outbound = useSmall ? { ...request, turnWindow: { minMessages: 1, minTurns: 1 } } : request
          let iterator: AsyncIterator<unknown> | undefined
          let fallback = false
          let finished = false
          try {
            iterator = remote.session.follow(outbound, useSmall ? controller.signal : callerSignal)[Symbol.asyncIterator]()
            while (true) {
              const item = await iterator.next()
              callerSignal?.throwIfAborted()
              invalidate()
              if (changed) { fallback = true; break }
              if (item.done) { finished = true; return }
              if (useSmall && !committed) {
                if (!record(item.value) || item.value.type !== 'snapshot' || !completeBoundary(item.value)) { fallback = true; break }
                // There is no await between the last generation check and publication.
                committed = true
                snapshotSeen = true
                notify('used', initial.generation)
                if (timer !== undefined) { clearInterval(timer); timer = undefined }
              } else if (record(item.value) && item.value.type === 'snapshot') snapshotSeen = true
              yield item.value
            }
          } catch (error) {
            callerSignal?.throwIfAborted()
            if (useSmall && changed && !committed) fallback = true
            else throw error
          } finally {
            if (timer !== undefined) clearInterval(timer)
            callerSignal?.removeEventListener('abort', cancel)
            controller.abort(POLICY_CHANGED)
            // Close the old iterator before opening the official replacement. The
            // installed Gateway carrier observes AbortSignal; never overlap follows.
            if (!finished && iterator?.return !== undefined) {
              try { await iterator.return() } catch { /* Teardown must not mask the original failure/cancellation. */ }
            }
          }
          if (!fallback) return
          notify('fallback', initial.generation)
          callerSignal?.throwIfAborted()
          useSmall = false
        }
      }
    }
  }
  return facade as unknown as T
}
/** Read-only factory used by an exact-version doOpen hook. Parent owns installation. */
export function installInitialHistoryFactory(getPolicy: InitialHistoryPolicyGetter, target: object = globalThis, options: InitialHistoryFactoryOptions = {}): () => void {
  if (Object.getOwnPropertyDescriptor(target, INITIAL_HISTORY_FACTORY) !== undefined) throw new Error('initial history factory is already installed')
  let active = true, queued = false
  let diagnostics: InitialHistoryDiagnostics = Object.freeze({ hookCalls: 0, attempts: 0, used: 0, fallbacks: 0, lastHookCompatible: false })
  const increment = (value: number) => Math.min(value + 1, 65535)
  const update = (patch: Partial<InitialHistoryDiagnostics>) => {
    diagnostics = Object.freeze({ ...diagnostics, ...patch })
    if (queued) return
    queued = true
    queueMicrotask(() => { queued = false; if (active) { try { options.onChange?.(diagnostics) } catch { /* Bounded diagnostics only. */ } } })
  }
  const factory = <T>(remote: T): T => {
    if (!active) return remote
    update({ hookCalls: increment(diagnostics.hookCalls), lastHookCompatible: compatible(remote) })
    return createInitialHistoryRemote(remote, () => active ? policy(getPolicy) : false, event => {
      if (!active) return
      if (event.kind === 'attempt') update({ attempts: increment(diagnostics.attempts) })
      else if (event.kind === 'used') update({ used: increment(diagnostics.used), lastUsedGeneration: event.generation })
      else update({ fallbacks: increment(diagnostics.fallbacks) })
    })
  }
  Object.defineProperty(factory, 'diagnostics', { get: () => diagnostics, configurable: false, enumerable: true })
  Object.defineProperty(target, INITIAL_HISTORY_FACTORY, { value: factory, configurable: true, writable: false, enumerable: false })
  return () => {
    active = false
    if (Object.getOwnPropertyDescriptor(target, INITIAL_HISTORY_FACTORY)?.value === factory) Reflect.deleteProperty(target, INITIAL_HISTORY_FACTORY)
  }
}
