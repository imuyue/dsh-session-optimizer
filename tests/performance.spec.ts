import { mkdtemp, rm } from 'node:fs/promises'
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_PERFORMANCE_PREFERENCES,
  PreferencesUsageError,
  createPreferencesHost,
  patchOf,
  preferencesPath,
  readPreferences,
} from '../src/preferences.ts'
import {
  PerformanceController,
  PerformanceConflictError,
  PerformanceDisposedError,
  PerformanceLeaseExpiredError,
  type PerformanceCapabilities,
} from '../src/performance.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-performance-'))
  roots.push(root)
  const path = preferencesPath(root)
  const store = createPreferencesHost(path, ['sqlite', 'jsonl'], () => undefined)
  return { root, path, store }
}
const available: PerformanceCapabilities = {
  historyWindow: { supported: true, reason: 'bounded read-only loading preview; official recovery unchanged' },
  virtualChat: { supported: true, reason: 'layout-only content-visibility; nodes retained' },
}

describe('persisted performance preferences', () => {
  it('keeps old preferences and defaults each missing or invalid performance field off', async () => {
    const { path } = await fixture()
    writeFileSync(path, JSON.stringify({ format: 'jsonl', language: 'en', stabilityFixes: false }))
    expect(readPreferences(path)).toEqual({ format: 'jsonl', language: 'en', stabilityFixes: false, performance: DEFAULT_PERFORMANCE_PREFERENCES })
    writeFileSync(path, JSON.stringify({ performance: { enabled: true, historyWindow: 'true', virtualChat: null } }))
    expect(readPreferences(path).performance).toEqual({ enabled: true, historyWindow: false, virtualChat: false })
  })

  it('merges subfields and preserves them when an old setting changes', async () => {
    const { store, path } = await fixture()
    store.update({ performance: { virtualChat: true } })
    store.update({ performance: { enabled: true } })
    store.update({ language: 'en' })
    expect(readPreferences(path).performance).toEqual({ enabled: true, virtualChat: true, historyWindow: false })
    expect(store.read().language).toBe('en')
    expect(Object.isFrozen(store.read().performance)).toBe(true)
  })

  it.each([null, [], 'on', {}, { enabled: 1 }, { historyWindow: 'yes' }, { virtualChat: undefined }, { unknown: true }])('rejects malformed nested performance patch %j', (performance) => {
    expect(() => patchOf({ performance })).toThrow(PreferencesUsageError)
  })

  it('does not publish or replace in-memory state after a real atomic-save failure', async () => {
    const { store, path } = await fixture()
    const controller = new PerformanceController(store, available)
    const before = controller.read()
    const seen: string[] = []
    controller.subscribe(state => seen.push(state.revision))
    // Renaming the temp file onto an existing directory must fail on every platform.
    mkdirSync(path)
    expect(() => controller.update({ enabled: true, historyWindow: true }, before.revision)).toThrow()
    expect(controller.read()).toEqual(before)
    expect(store.read().performance).toEqual(DEFAULT_PERFORMANCE_PREFERENCES)
    expect(seen).toEqual([])
    controller.dispose()
  })
})

describe('Host performance controller', () => {
  it('is off by default and reports unsupported adapters rather than pretending enabled', async () => {
    const { store } = await fixture()
    const c = new PerformanceController(store)
    expect(c.read().desired).toEqual(DEFAULT_PERFORMANCE_PREFERENCES)
    c.update({ enabled: true, historyWindow: true, virtualChat: true })
    expect(c.read().desired.enabled).toBe(true)
    expect(c.read().effective).toEqual(DEFAULT_PERFORMANCE_PREFERENCES)
    expect(c.read().capabilities.historyWindow.supported).toBe(false)
    expect(c.read().clientApplied).toBe('unconfirmed')
    expect(c.acquire('historyWindow')).toBeUndefined()
    c.dispose()
  })

  it('persists before notification and rejects stale CAS including another Host lifetime', async () => {
    const { store, path } = await fixture()
    const c = new PerformanceController(store, available)
    const revision = c.read().revision
    let notified = 0
    c.subscribe(state => {
      expect(readPreferences(path).performance).toEqual(state.desired)
      notified++
    })
    c.update({ enabled: true, virtualChat: true }, revision)
    const saved = readFileSync(path, 'utf8')
    expect(() => c.update({ historyWindow: true }, revision)).toThrow(PerformanceConflictError)
    expect(readFileSync(path, 'utf8')).toBe(saved)
    expect(notified).toBe(1)
    const other = new PerformanceController(store, available)
    expect(() => other.disableAll(c.read().revision)).toThrow(PerformanceConflictError)
    other.dispose(); c.dispose()
  })

  it('aborts an old lease and prevents a late result from committing after disableAll', async () => {
    const { store, path } = await fixture()
    const c = new PerformanceController(store, available)
    c.update({ enabled: true, historyWindow: true, virtualChat: true })
    const lease = c.acquire('historyWindow')!
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    let committed = false
    const work = pending.then(() => { lease.assertCurrent(); committed = true })
    const next = c.disableAll(c.read().revision)
    expect(next.desired).toEqual(DEFAULT_PERFORMANCE_PREFERENCES)
    expect(readPreferences(path).performance).toEqual(DEFAULT_PERFORMANCE_PREFERENCES)
    expect(lease.signal.aborted).toBe(true)
    expect(lease.isCurrent()).toBe(false)
    release()
    await expect(work).rejects.toThrow(PerformanceLeaseExpiredError)
    expect(committed).toBe(false)
    expect(c.acquire('historyWindow')).toBeUndefined()
    expect(c.read().pendingRequests).toBe(0)
    lease.dispose(); lease.dispose(); c.dispose()
  })

  it('stops this Host before a failed disable save, and only an explicit successful write can reopen it', async () => {
    const { store, path } = await fixture()
    const c = new PerformanceController(store, available)
    c.update({ enabled: true, historyWindow: true })
    const lease = c.acquire('historyWindow')!
    const before = c.read().revision
    unlinkSync(path); mkdirSync(path)
    expect(() => c.disableAll(before)).toThrow()
    expect(lease.signal.aborted).toBe(true)
    expect(c.read().effective.enabled).toBe(false)
    expect(c.read().runtimeSuppressed).toBe(true)
    expect(c.read().desired.enabled).toBe(true) // Saved success is never fabricated.
    expect(c.acquire('historyWindow')).toBeUndefined()
    expect(() => c.update({ enabled: true }, c.read().revision)).toThrow()
    expect(c.read().effective.enabled).toBe(false)
    rmdirSync(path)
    c.update({ enabled: true }, c.read().revision)
    expect(c.read().runtimeSuppressed).toBe(false)
    expect(c.read().effective.historyWindow).toBe(true)
    expect(readPreferences(path).performance.enabled).toBe(true)
    c.dispose()
  })

  it('tracks direct Host setting changes and independent gates', async () => {
    const { store } = await fixture()
    const c = new PerformanceController(store, available)
    store.update({ performance: { enabled: true, historyWindow: true } })
    expect(c.acquire('virtualChat')).toBeUndefined()
    const lease = c.acquire('historyWindow')!
    store.update({ performance: { historyWindow: false, virtualChat: true } })
    expect(lease.signal.aborted).toBe(true)
    expect(c.read().effective).toEqual({ enabled: true, historyWindow: false, virtualChat: true })
    c.dispose()
  })

  it('distinguishes caller abort, bounds leases and invalidates adapter changes', async () => {
    const { store } = await fixture()
    const c = new PerformanceController(store, available, 1)
    c.update({ enabled: true, historyWindow: true })
    const caller = new AbortController()
    const lease = c.acquire('historyWindow', caller.signal)!
    expect(c.acquire('historyWindow')).toBeUndefined()
    caller.abort('user cancelled')
    expect(lease.signal.reason).toBe('user cancelled')
    expect(c.read().pendingRequests).toBe(0)
    expect(() => c.acquire('historyWindow', caller.signal)).toThrow()
    const next = c.acquire('historyWindow')!
    c.setCapabilities({ ...available, historyWindow: { supported: false, reason: 'adapter removed' } })
    expect(next.signal.aborted).toBe(true)
    expect(c.acquire('historyWindow')).toBeUndefined()
    c.dispose()
  })

  it('never sends an old enabled snapshot after a subscriber synchronously disables', async () => {
    const { store } = await fixture()
    const c = new PerformanceController(store, available)
    const seen: boolean[] = []
    c.subscribe(state => { if (state.effective.enabled) c.disableAll() })
    c.subscribe(state => { seen.push(state.effective.enabled) })
    c.update({ enabled: true, historyWindow: true })
    expect(c.read().effective.enabled).toBe(false)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(value => value === false)).toBe(true)
    c.dispose()
  })

  it('releases subscriptions and repeated unload, isolating an observer exception', async () => {
    const { store } = await fixture()
    const c = new PerformanceController(store, available)
    let calls = 0
    c.subscribe(() => { throw new Error('view failed') })
    const stop = c.subscribe(() => { calls++ })
    c.update({ enabled: true, historyWindow: true })
    expect(calls).toBe(1)
    stop(); stop()
    const lease = c.acquire('historyWindow')!
    c.dispose(); c.dispose(); c[Symbol.dispose]()
    expect(lease.signal.aborted).toBe(true)
    expect(c.read().disposed).toBe(true)
    expect(c.read().effective.enabled).toBe(false)
    expect(() => c.update({ enabled: true })).toThrow(PerformanceDisposedError)
    expect(() => c.acquire('historyWindow')).toThrow(PerformanceDisposedError)
    expect(() => c.subscribe(() => undefined)).toThrow(PerformanceDisposedError)
    store.update({ performance: { historyWindow: false } })
    expect(calls).toBe(1)
  })
})
