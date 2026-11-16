import { performanceFetch, hasPerformanceCarrier } from './performance-transport.ts'

export interface PerformanceFlags { enabled: boolean; historyWindow: boolean; virtualChat: boolean }
export interface PerformanceState {
  revision: string
  generation: number
  desired: PerformanceFlags
  effective: PerformanceFlags
  capabilities: Record<'historyWindow' | 'virtualChat', { supported: boolean; reason: string }>
  clientApplied: 'unconfirmed'
  disposed: boolean
}
export interface PerformanceApplied { historyWindow: boolean; virtualChat: boolean; reason?: string }
export interface PerformanceSnapshot {
  state: PerformanceState | null
  status: 'loading' | 'ready' | 'offline'
  error: string | undefined
  localSuppressed: boolean
  saving: boolean
  applied: PerformanceApplied
}
const OFF: PerformanceApplied = Object.freeze({ historyWindow: false, virtualChat: false })
let snapshot: PerformanceSnapshot = Object.freeze({ state: null, status: 'loading', error: undefined, localSuppressed: true, saving: false, applied: OFF })
const listeners = new Set<() => void>()
let users = 0
let interval: ReturnType<typeof setInterval> | undefined
let controller: AbortController | undefined
let mutationController: AbortController | undefined
let mutation = false
let manualSuppression = false
let actionEpoch = 0
let queue: Promise<unknown> = Promise.resolve()
let disabling: Promise<void> | undefined
let reportController: AbortController | undefined
let reportedSignature = ''
let reportScheduled = false
function scheduleClientReport(): void {
  if (reportScheduled || reportController !== undefined || !hasPerformanceCarrier() || users === 0) return
  reportScheduled = true
  queueMicrotask(() => {
    reportScheduled = false
    if (users === 0 || !hasPerformanceCarrier() || reportController !== undefined) return
    const page = typeof document === 'undefined' ? 'worker' : new URL(document.baseURI).protocol
    const body = { revision: snapshot.state?.revision ?? '', generation: snapshot.state?.generation ?? 0, status: snapshot.status, historyWindow: !snapshot.localSuppressed && snapshot.applied.historyWindow, virtualChat: !snapshot.localSuppressed && snapshot.applied.virtualChat, reason: `${String(snapshot.applied.reason ?? snapshot.error ?? '')};page:${page}`.slice(0, 512) }
    const signature = JSON.stringify(body)
    if (signature === reportedSignature) return
    const active = new AbortController(); reportController = active
    const timer = setTimeout(() => active.abort(), 4000)
    void performanceFetch('performance/client-report', { method: 'POST', body: signature, signal: active.signal }).then(response => {
      if (response.ok && users > 0 && !active.signal.aborted) reportedSignature = signature
    }).catch(() => undefined).finally(() => { clearTimeout(timer); if (reportController === active) reportController = undefined })
  })
}

export function getPerformanceSnapshot(): PerformanceSnapshot { return snapshot }
export function subscribePerformance(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }
function publish(patch: Partial<PerformanceSnapshot>): void {
  snapshot = Object.freeze({ ...snapshot, ...patch })
  for (const listener of [...listeners]) { try { listener() } catch { /* A view cannot break the control gate. */ } }
  scheduleClientReport()
}
export function reportPerformanceApplied(applied: PerformanceApplied): void {
  if (snapshot.applied.historyWindow === applied.historyWindow && snapshot.applied.virtualChat === applied.virtualChat && snapshot.applied.reason === applied.reason) return
  publish({ applied: Object.freeze({ ...applied }) })
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function flags(value: unknown): value is PerformanceFlags { return record(value) && ['enabled', 'historyWindow', 'virtualChat'].every((key) => typeof value[key] === 'boolean') }
function stateOf(value: unknown): PerformanceState {
  if (!record(value) || typeof value.revision !== 'string' || !Number.isSafeInteger(value.generation) || !flags(value.desired) || !flags(value.effective) || !record(value.capabilities) ||
    !['historyWindow', 'virtualChat'].every((key) => record(value.capabilities) && record(value.capabilities[key]) && typeof value.capabilities[key].supported === 'boolean' && typeof value.capabilities[key].reason === 'string')) throw new Error('Host performance controls are unavailable or incompatible')
  return value as unknown as PerformanceState
}
async function request(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await performanceFetch(path, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal === undefined ? {} : { signal }),
  })
  const answer: unknown = await response.json()
  if (!response.ok) {
    const error = new Error(record(answer) && typeof answer.error === 'string' ? answer.error : `HTTP ${response.status}`)
    if (response.status === 409 && record(answer) && record(answer.state)) Object.assign(error, { currentState: stateOf(answer.state) })
    throw error
  }
  return answer
}
async function refresh(): Promise<void> {
  if (mutation || controller !== undefined || users === 0) return
  const currentEpoch = actionEpoch
  const active = new AbortController()
  controller = active
  const timer = setTimeout(() => active.abort(), 4000)
  try {
    const state = stateOf(await request('performance', undefined, active.signal))
    if (currentEpoch === actionEpoch && users > 0) publish({ state, status: 'ready', error: manualSuppression ? snapshot.error : undefined, localSuppressed: manualSuppression })
  } catch (error) {
    if (currentEpoch === actionEpoch && users > 0) publish({ status: 'offline', localSuppressed: true, error: String(error), applied: OFF })
  } finally { clearTimeout(timer); if (controller === active) controller = undefined }
}

/** Start once for the Client fiber; polling is bounded and stops on unload. */
export function installPerformanceClient(): () => void {
  users++
  if (users === 1) {
    void refresh()
    interval = setInterval(() => { void refresh() }, 2000)
    document.addEventListener('visibilitychange', onVisible)
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    users--
    if (users > 0) return
    actionEpoch++
    controller?.abort()
    mutationController?.abort()
    reportController?.abort()
    reportedSignature = ''
    controller = undefined
    clearInterval(interval)
    document.removeEventListener('visibilitychange', onVisible)
    publish({ state: null, status: 'offline', localSuppressed: true, applied: OFF, saving: false })
  }
}
function onVisible(): void { if (document.visibilityState === 'visible') void refresh() }

function change(patch: Partial<PerformanceFlags> | undefined): Promise<void> {
  if (patch !== undefined && snapshot.saving) return Promise.reject(new Error('a performance settings write is already pending'))
  // Gate locally before I/O: a failed disk write never leaves this page optimized.
  const epoch = ++actionEpoch
  manualSuppression = true
  mutationController?.abort()
  controller?.abort()
  controller = undefined
  publish({ localSuppressed: true, saving: true, error: undefined })
  const operation = async () => {
    if (users === 0 || epoch !== actionEpoch) return
    mutation = true
    const active = new AbortController()
    mutationController = active
    const timer = setTimeout(() => active.abort(), 5000)
    try {
      let state = stateOf(await request('performance', undefined, active.signal))
      if (users === 0 || epoch !== actionEpoch) return
      let answer: unknown
      try {
        answer = await request(patch === undefined ? 'performance/disable' : 'performance', { ...(patch === undefined ? {} : { patch }), expectedRevision: state.revision }, active.signal)
      } catch (error) {
        // Disabling is absolute operator intent; one fresh-CAS retry is bounded.
        if (patch !== undefined || !record(error) || !record(error.currentState)) throw error
        state = stateOf(error.currentState)
        answer = await request('performance/disable', { expectedRevision: state.revision }, active.signal)
      }
      state = stateOf(answer)
      if (epoch === actionEpoch && users > 0) {
        manualSuppression = false
        publish({ state, status: 'ready', error: undefined, localSuppressed: false })
      }
    } catch (error) {
      if (epoch === actionEpoch) publish({ status: 'offline', localSuppressed: true, error: `本页面已恢复官方；Host 设置尚未确认保存：${String(error)}`, applied: OFF })
      throw error
    } finally {
      clearTimeout(timer)
      if (mutationController === active) mutationController = undefined
      mutation = false
      if (epoch === actionEpoch) publish({ saving: false })
    }
  }
  const running = queue.then(operation, operation)
  queue = running.catch(() => undefined)
  return running
}
export function updatePerformance(patch: Partial<PerformanceFlags>): Promise<void> { return change(patch) }
export function disablePerformance(): Promise<void> {
  if (disabling !== undefined) return disabling
  const running = change(undefined)
  disabling = running
  void running.then(() => { if (disabling === running) disabling = undefined }, () => { if (disabling === running) disabling = undefined })
  return running
}
