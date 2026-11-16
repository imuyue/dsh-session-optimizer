import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import * as history from '../client/initial-history.ts'
import { chatPerformanceGate } from '../client/chat-window.ts'
import type { ClientContext } from '../client/context.ts'

function fixture(workspaceReady = true, initialJobs: unknown[] = []) {
  const target = {}, listeners = new Set<() => void>(), cleanups: Array<() => void> = []
  const flags = { enabled: false, historyWindow: false, virtualChat: false }
  let snapshot = { status: 'ready', localSuppressed: false, state: { revision: 'cfg:0', generation: 0, desired: { ...flags }, effective: { ...flags } } }
  const reports: Array<{ historyWindow: boolean; virtualChat: boolean; reason: string }> = []
  const recoveries: unknown[][] = [], workspaceRecoveries: unknown[][] = [], workspaceSyncs: unknown[][] = [], titleRefreshes: unknown[][] = []
  const workspaceRelease = vi.fn()
  const libraryListeners = new Set<(report?: unknown) => void>()
  const sessions = { refresh: vi.fn(async () => undefined) }
  let depth = 0
  const notify = () => { for (const fn of [...listeners]) fn() }
  const reportPerformanceApplied = (report: typeof reports[number]) => {
    if (++depth > 10) throw new Error('report/reconcile recursion')
    try { reports.push(report); notify() } finally { depth-- }
  }
  const code = ts.transpileModule(readFileSync(new URL('../client/index.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2024, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const module = { exports: {} as typeof import('../client/index.ts') }
  let previewStatus: (value: { historyPreview: boolean; reason: string }) => void = () => undefined
  runInNewContext(code, { module, exports: module.exports, AbortController,
    require(id: string) {
      if (id === './initial-history.ts') return { installInitialHistoryFactory: (get: history.InitialHistoryPolicyGetter, _target: object, options: history.InitialHistoryFactoryOptions) => history.installInitialHistoryFactory(get, target, options) }
      if (id === './chat-window.ts') return { chatPerformanceGate }
      if (id === './ConsolePage.tsx') return { ConsolePage: () => undefined }
      if (id === './ConsoleIcon.tsx') return { ConsoleIcon: () => undefined }
      if (id === './library.ts') return { onLibraryChanged: (listener: (report?: unknown) => void) => { libraryListeners.add(listener); return () => { libraryListeners.delete(listener) } } }
      if (id === './api.ts') return { fetchSettings: async () => ({ about: { dshVersion: '0.2.2-rc.1' } }), fetchMigrations: async () => ({ available: true, jobs: initialJobs }) }
      if (id === './migration-titles.ts') return { refreshMigratedTitles: async (...args: unknown[]) => { titleRefreshes.push(args) } }
      if (id === './workspace-memberships.ts') return { syncWorkspaceMemberships: async (...args: unknown[]) => { workspaceSyncs.push(args) } }
      if (id === './workspace-recovery.ts') return { installWorkspaceRecovery: (...args: unknown[]) => { workspaceRecoveries.push(args); return workspaceRelease } }
      if (id === './session-recovery.ts') return { recoverMigratedSessions: async (...args: unknown[]) => { recoveries.push(args); return [] } }
      if (id === './performance-transport.ts') return { installPerformanceTransport: () => () => undefined }
      if (id === './performance-client.ts') return {
        getPerformanceSnapshot: () => snapshot, installPerformanceClient: () => () => undefined,
        subscribePerformance: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }, reportPerformanceApplied,
      }
      if (id === './chat-performance.tsx') return { installChatPerformance: (_ctx: unknown, _source: unknown, options: { onEffectiveChange: typeof previewStatus }) => {
        previewStatus = options.onEffectiveChange
        previewStatus({ historyPreview: true, reason: 'preview-seat-ready' })
      } }
      throw new Error(`unexpected root Client import ${id}`)
    },
  })
  module.exports.apply({ effect: (fn: () => unknown) => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup as () => void) }, get: (name: string) => name === 'sessions' ? sessions : (name === 'workspaces' || name === 'remote') && !workspaceReady ? undefined : {}, slots: { inject: () => () => undefined } } as unknown as ClientContext)
  return {
    enableWorkspaces: () => { workspaceReady = true },
    reports, recoveries, workspaceRecoveries, workspaceSyncs, titleRefreshes, workspaceRelease, sessions, announce: (report?: unknown) => { for (const fn of [...libraryListeners]) fn(report) }, target, factory: () => Object.getOwnPropertyDescriptor(target, history.INITIAL_HISTORY_FACTORY)?.value,
    update: (revision: string, state: Partial<typeof flags>, options: { suppressed?: boolean; status?: string } = {}) => {
      snapshot = { status: options.status ?? 'ready', localSuppressed: options.suppressed ?? false, state: { revision, generation: 1, desired: { ...flags, ...state }, effective: { ...flags, ...state } } }
      notify()
    },
    stop: () => { for (const cleanup of cleanups.reverse()) cleanup() },
  }
}
const request = () => ({ address: { kind: 'session', sessionId: 'fixture' }, activate: true, assistantStream: true, maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } })
function remote() {
  const seen: unknown[] = []
  return {
    seen, value: { $stream: () => undefined, session: { page: () => undefined, async *follow(value: unknown) {
      seen.push(value)
      yield { type: 'snapshot', records: [{ event: { seq: 1, type: 'turn/start' } }], hasMore: true }
    } } },
  }
}

describe('root Client first-history integration', () => {
  it('refreshes converted titles after the list pull and cancels a late pull on unload', async () => {
    const f = fixture(), report = { status: 'completed', items: [] }
    let release: (() => void) | undefined
    f.sessions.refresh.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    f.announce(report)
    expect(f.titleRefreshes).toHaveLength(0)
    release!(); await Promise.resolve(); await Promise.resolve()
    expect(f.titleRefreshes).toHaveLength(1)
    expect(f.titleRefreshes[0]?.[1]).toBe(report)
    f.stop()
    const late = fixture()
    late.sessions.refresh.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    late.announce(report); late.stop(); release!()
    await Promise.resolve(); await Promise.resolve()
    expect(late.titleRefreshes).toHaveLength(0)
  })
  it('reconciles the latest completed conversion on startup and handles later conversions independently', async () => {
    const old = { status: 'completed', items: [] }, latest = { status: 'partial', items: [] }
    const f = fixture(true, [{ status: 'completed', report: old }, { status: 'partial', report: latest }])
    await Promise.resolve(); await Promise.resolve()
    expect(f.workspaceSyncs).toHaveLength(1)
    expect(f.workspaceSyncs[0]?.[1]).toBe(latest)
    const next = { status: 'completed', items: [] }; f.announce(next)
    expect(f.workspaceSyncs[1]?.[1]).toBe(next)
    const signal = f.workspaceSyncs[0]?.[2] as AbortSignal
    f.stop(); expect(signal.aborted).toBe(true)
  })
  it('installs version-gated Workspace recovery and releases it, ignoring late startup after unload', async () => {
    const f = fixture(); await Promise.resolve(); await Promise.resolve()
    expect(f.workspaceRecoveries).toHaveLength(1)
    expect(f.workspaceRecoveries[0]?.[2]).toBe('0.2.2-rc.1')
    f.stop(); expect(f.workspaceRelease).toHaveBeenCalledTimes(1)
    const late = fixture(); late.stop(); await Promise.resolve(); await Promise.resolve()
    expect(late.workspaceRecoveries).toHaveLength(0)
  })
  it('initializes recovery after Workspace services become available on a later library change', async () => {
    const f = fixture(false)
    await Promise.resolve(); await Promise.resolve()
    expect(f.workspaceRecoveries).toHaveLength(0)
    f.enableWorkspaces(); f.announce()
    await Promise.resolve(); await Promise.resolve()
    expect(f.workspaceRecoveries).toHaveLength(1)
    f.stop(); expect(f.workspaceRelease).toHaveBeenCalledTimes(1)
  })
  it('keeps defaults official, gates by virtualChat independently, and reports use only after a small snapshot', async () => {
    const f = fixture()
    try {
      expect(f.reports.at(-1)?.virtualChat).toBe(false)
      const first = remote()
      await Array.fromAsync(f.factory()(first.value).session.follow(request()))
      expect(first.seen[0]).toEqual(request())
      f.update('cfg:history-only', { enabled: true, historyWindow: true })
      const historyOnly = remote()
      await Array.fromAsync(f.factory()(historyOnly.value).session.follow(request()))
      expect(historyOnly.seen[0]).toEqual(request())
      expect(f.reports.at(-1)).toMatchObject({ historyWindow: true, virtualChat: false })
      f.update('cfg:virtual-only', { enabled: true, virtualChat: true })
      expect(f.reports.at(-1)).toMatchObject({ historyWindow: false, virtualChat: false })
      const small = remote()
      await Array.fromAsync(f.factory()(small.value).session.follow(request()))
      expect(small.seen[0]).toEqual({ ...request(), turnWindow: { minMessages: 1, minTurns: 1 } })
      expect(f.reports.at(-1)).toMatchObject({ historyWindow: false, virtualChat: true })
      expect(f.reports.at(-1)?.reason).toContain('small-snapshot-used')
      f.update('cfg:new', { enabled: true, virtualChat: true })
      expect(f.reports.at(-1)?.virtualChat).toBe(false)
    } finally { f.stop() }
  })
  it('blocks offline/local suppression, avoids report loops, and unloads the factory and old facades', async () => {
    const f = fixture()
    const r = remote()
    const facade = f.factory()(r.value)
    try {
      for (let i = 0; i < 1000; i++) f.update('cfg:on', { enabled: true, virtualChat: true })
      expect(f.reports.length).toBeLessThan(2005)
      f.update('cfg:on', { enabled: true, virtualChat: true }, { suppressed: true })
      await Array.fromAsync(facade.session.follow(request()))
      expect(r.seen.at(-1)).toEqual(request())
      f.update('cfg:on', { enabled: true, virtualChat: true }, { status: 'offline' })
      await Array.fromAsync(facade.session.follow(request()))
      expect(r.seen.at(-1)).toEqual(request())
      expect(f.reports.at(-1)?.virtualChat).toBe(false)
      f.stop()
      expect(f.factory()).toBeUndefined()
      await Array.fromAsync(facade.session.follow(request()))
      expect(r.seen.at(-1)).toEqual(request())
    } finally { f.stop() }
  })
  it('passes settled migration identity and the verified version to recovery, then stops on unload', async () => {
    const f = fixture(), report = { migrationId: 'private-committed', status: 'completed', items: [] }
    try {
      f.announce(report)
      await Promise.resolve(); await Promise.resolve()
      expect(f.sessions.refresh).toHaveBeenCalledTimes(1)
      expect(f.recoveries).toHaveLength(1)
      expect(f.recoveries[0]?.slice(0, 3)).toEqual([f.sessions, report, '0.2.2-rc.1'])
      f.stop(); f.announce(report)
      await Promise.resolve()
      expect(f.recoveries).toHaveLength(1)
    } finally { f.stop() }
    const late = fixture()
    late.announce(report); late.stop()
    await Promise.resolve(); await Promise.resolve()
    expect(late.recoveries).toHaveLength(0)
  })
})
