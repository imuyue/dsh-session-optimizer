/** Host authority for opt-in performance paths. No official service is replaced here. */
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_PERFORMANCE_PREFERENCES,
  PreferencesUsageError,
  performancePatchOf,
  type PerformancePreferences,
  type PreferencesHost,
} from './preferences.ts'

export type PerformanceFeature = 'historyWindow' | 'virtualChat'
export interface PerformanceCapability { readonly supported: boolean; readonly reason: string }
export type PerformanceCapabilities = Readonly<Record<PerformanceFeature, PerformanceCapability>>
export interface PerformanceClientReport {
  readonly revision: string
  readonly generation: number
  readonly status: string
  readonly historyWindow: boolean
  readonly virtualChat: boolean
  readonly reason: string
  readonly receivedAt: number
}
export interface PerformanceState {
  /** Opaque process epoch plus monotonic counter; never reuse after a Host restart. */
  readonly revision: string
  readonly generation: number
  readonly desired: PerformancePreferences
  /** Host eligibility only, never an acknowledgement that a Client applied it. */
  readonly effective: PerformancePreferences
  readonly capabilities: PerformanceCapabilities
  readonly clientApplied: 'unconfirmed'
  /** Most recent page self-report only; does not attest all Clients or change eligibility. */
  readonly lastClientReport?: PerformanceClientReport & { readonly current: boolean }
  readonly disposed: boolean
  readonly pendingRequests: number
  readonly runtimeSuppressed: boolean
}
export class PerformanceConflictError extends Error {
  override readonly name = 'PerformanceConflictError'
  readonly currentRevision: string
  constructor(currentRevision: string) {
    super('performance settings changed; reload before saving')
    this.currentRevision = currentRevision
  }
}
export class PerformanceDisposedError extends Error {
  override readonly name = 'PerformanceDisposedError'
  constructor() { super('performance controller is disposed') }
}
export class PerformanceLeaseExpiredError extends Error {
  override readonly name = 'PerformanceLeaseExpiredError'
  constructor() { super('performance request belongs to an inactive generation') }
}
export interface PerformanceLease extends Disposable {
  readonly feature: PerformanceFeature
  readonly generation: number
  readonly signal: AbortSignal
  isCurrent(): boolean
  assertCurrent(): void
  dispose(): void
}
const DEFAULT_CAPABILITIES: PerformanceCapabilities = Object.freeze({
  historyWindow: Object.freeze({ supported: false, reason: 'No bounded history adapter is registered.' }),
  virtualChat: Object.freeze({ supported: false, reason: 'No compatible Client layout adapter is registered.' }),
})
function same(a: PerformancePreferences, b: PerformancePreferences): boolean {
  return a.enabled === b.enabled && a.historyWindow === b.historyWindow && a.virtualChat === b.virtualChat
}
function capabilitiesOf(value: PerformanceCapabilities): PerformanceCapabilities {
  for (const feature of ['historyWindow', 'virtualChat'] as const) {
    const capability = value[feature]
    if (!capability || typeof capability.supported !== 'boolean' || typeof capability.reason !== 'string') {
      throw new PreferencesUsageError(`invalid ${feature} capability`)
    }
  }
  return Object.freeze({ historyWindow: Object.freeze({ ...value.historyWindow }), virtualChat: Object.freeze({ ...value.virtualChat }) })
}

/**
 * Sync persistence serializes writes in the Host event loop. Persist first,
 * then advance generation and abort leases, then publish to subscribers.
 * All configuration lives in PreferencesHost; snapshots are immutable views.
 */
export class PerformanceController implements Disposable {
  private lastClientReport: PerformanceClientReport | undefined
  private readonly epoch = randomUUID()
  private sequence = 0
  private generation = 0
  private runtimeSuppressed = false
  private suppressionEpoch = 0
  private disposed = false
  private desired: PerformancePreferences
  private capabilities: PerformanceCapabilities
  private readonly pending = new Set<AbortController>()
  private readonly listeners = new Set<(state: PerformanceState) => void>()
  private readonly unsubscribePreferences: () => void
  private readonly preferences: PreferencesHost
  private readonly maxPendingRequests: number

  constructor(
    preferences: PreferencesHost,
    capabilities: PerformanceCapabilities = DEFAULT_CAPABILITIES,
    maxPendingRequests = 128,
  ) {
    if (!Number.isSafeInteger(maxPendingRequests) || maxPendingRequests < 1) {
      throw new PreferencesUsageError('maxPendingRequests must be a positive integer')
    }
    this.preferences = preferences
    this.maxPendingRequests = maxPendingRequests
    this.capabilities = capabilitiesOf(capabilities)
    this.desired = preferences.read().performance
    this.unsubscribePreferences = preferences.subscribe((next) => {
      if (this.disposed || same(next.performance, this.desired)) return
      this.desired = next.performance
      this.invalidate()
      this.publish()
    })
  }

  read(): PerformanceState {
    const desired = this.desired
    const historyWindow = !this.disposed && !this.runtimeSuppressed && desired.enabled && desired.historyWindow && this.capabilities.historyWindow.supported
    const virtualChat = !this.disposed && !this.runtimeSuppressed && desired.enabled && desired.virtualChat && this.capabilities.virtualChat.supported
    return Object.freeze({
      revision: `${this.epoch}:${this.sequence}`,
      generation: this.generation,
      desired,
      effective: Object.freeze({ enabled: historyWindow || virtualChat, historyWindow, virtualChat }),
      capabilities: this.capabilities,
      clientApplied: 'unconfirmed',
      ...(this.lastClientReport === undefined ? {} : { lastClientReport: Object.freeze({ ...this.lastClientReport, current: this.lastClientReport.revision === `${this.epoch}:${this.sequence}` && this.lastClientReport.generation === this.generation }) }),
      disposed: this.disposed,
      pendingRequests: this.pending.size,
      runtimeSuppressed: this.runtimeSuppressed,
    })
  }

  reportClient(value: unknown): void {
    this.assertActive()
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new PreferencesUsageError('invalid Client report')
    const row = value as Record<string, unknown>
    if (Object.keys(row).some(key => !['revision', 'generation', 'status', 'historyWindow', 'virtualChat', 'reason'].includes(key)) || typeof row.revision !== 'string' || row.revision.length > 128 || !Number.isSafeInteger(row.generation) || Number(row.generation) < 0 || !['loading', 'ready', 'offline'].includes(String(row.status)) || typeof row.historyWindow !== 'boolean' || typeof row.virtualChat !== 'boolean' || typeof row.reason !== 'string' || row.reason.length > 512) throw new PreferencesUsageError('invalid Client report')
    this.lastClientReport = Object.freeze({ revision: row.revision, generation: Number(row.generation), status: String(row.status), historyWindow: row.historyWindow, virtualChat: row.virtualChat, reason: row.reason, receivedAt: Date.now() })
  }

  /** expectedRevision is optional for trusted local callers; HTTP writers should require it. */
  update(patch: unknown, expectedRevision?: string): PerformanceState {
    this.assertActive()
    const validated = performancePatchOf(patch)
    this.checkRevision(expectedRevision)
    const next = { ...this.desired, ...validated }
    if (same(next, this.desired) && !this.runtimeSuppressed) return this.read()
    const suppressionEpoch = this.suppressionEpoch
    this.preferences.update({ performance: validated })
    // A reentrant emergency disable wins over this older configuration write.
    if (this.runtimeSuppressed && this.suppressionEpoch === suppressionEpoch) {
      this.runtimeSuppressed = false
      this.invalidate()
      this.publish()
    }
    return this.read()
  }

  disableAll(expectedRevision?: string): PerformanceState {
    this.assertActive()
    this.checkRevision(expectedRevision)
    this.suppressionEpoch++
    this.runtimeSuppressed = true
    this.invalidate()
    this.publish()
    // Failure is reported to the caller, but this Host remains off. Restart
    // persistence is never claimed until the atomic preferences write succeeds.
    this.preferences.update({ performance: DEFAULT_PERFORMANCE_PREFERENCES })
    return this.read()
  }

  /** Set adapter availability, never claim that a Client acknowledged its DOM state. */
  setCapabilities(capabilities: PerformanceCapabilities): PerformanceState {
    this.assertActive()
    const next = capabilitiesOf(capabilities)
    if (JSON.stringify(next) === JSON.stringify(this.capabilities)) return this.read()
    this.capabilities = next
    this.invalidate()
    this.publish()
    return this.read()
  }

  /** Subscription does not invoke immediately; call read() before registering UI listeners. */
  subscribe(listener: (state: PerformanceState) => void): () => void {
    this.assertActive()
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Undefined means use the unchanged official path. Caller cancellation throws. */
  acquire(feature: PerformanceFeature, callerSignal?: AbortSignal): PerformanceLease | undefined {
    this.assertActive()
    callerSignal?.throwIfAborted()
    if (!this.read().effective[feature]) return undefined
    // Bound queued work even if a caller forgets to release a completed lease.
    if (this.pending.size >= this.maxPendingRequests) return undefined
    const controller = new AbortController()
    const generation = this.generation
    let released = false
    const dispose = () => {
      if (released) return
      released = true
      callerSignal?.removeEventListener('abort', abort)
      this.pending.delete(controller)
    }
    const abort = () => {
      controller.abort(callerSignal?.reason)
      dispose()
    }
    const current = () => !released && !controller.signal.aborted && !this.disposed && generation === this.generation
    controller.signal.addEventListener('abort', dispose, { once: true })
    callerSignal?.addEventListener('abort', abort, { once: true })
    this.pending.add(controller)
    return Object.freeze({
      feature,
      generation,
      signal: controller.signal,
      isCurrent: current,
      assertCurrent: () => { if (!current()) throw new PerformanceLeaseExpiredError() },
      dispose,
      [Symbol.dispose]: dispose,
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribePreferences()
    this.invalidate()
    this.publish()
    this.listeners.clear()
  }

  [Symbol.dispose](): void { this.dispose() }

  private assertActive(): void { if (this.disposed) throw new PerformanceDisposedError() }
  private checkRevision(revision?: string): void {
    if (revision !== undefined && revision !== this.read().revision) throw new PerformanceConflictError(this.read().revision)
  }
  private invalidate(): void {
    this.sequence++
    this.generation++
    // Abort callbacks may reenter; clear first and never leave old-generation work registered.
    const pending = [...this.pending]
    this.pending.clear()
    for (const controller of pending) controller.abort(new PerformanceLeaseExpiredError())
  }
  private publish(): void {
    const state = this.read()
    for (const listener of [...this.listeners]) {
      // A subscriber may synchronously disable/dispose or change capabilities.
      // Its nested publication already carries the newer generation; never
      // subsequently overwrite another observer with this older snapshot.
      if (this.read().revision !== state.revision) break
      if (!this.listeners.has(listener)) continue
      try { listener(state) } catch { /* Optional observers cannot prevent shutdown or roll back persistence. */ }
    }
  }
}
