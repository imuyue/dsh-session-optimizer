/**
 * Browser half of the plugin: the storage console.
 *
 * Two seats: a `main` panel that owns the whole page, and a `sidebar.panellist`
 * row (icon + label) that navigates to it. The page itself never touches the
 * filesystem — it reads the Host routes registered in `src/console.ts`.
 *
 * The bundle also owns one piece of Shell state: after a migration changes which
 * backend a conversation lives on, the Shell's session list has to be re-read,
 * otherwise a newly cloned conversation is on disk but absent from the sidebar
 * until the page is reloaded. That is the only reason `sessions` is injected.
 *
 * @module dsh-session-optimizer/client
 */

import type { ClientContext, MainPanelId, SessionsService } from './context.ts'
import { ConsolePage } from './ConsolePage.tsx'
import { ConsoleIcon } from './ConsoleIcon.tsx'
import { onLibraryChanged } from './library.ts'
import { fetchSettings, fetchMigrations } from './api.ts'
import { refreshMigratedTitles } from './migration-titles.ts'
import { syncWorkspaceMemberships } from './workspace-memberships.ts'
import type { MigrationReport } from './types.ts'
import { installWorkspaceRecovery } from './workspace-recovery.ts'
// The CJS factory resolves this optional rc.1 module from the Host module table.
declare const require: (id: string) => unknown
import { recoverMigratedSessions } from './session-recovery.ts'
import { installPerformanceTransport } from './performance-transport.ts'
import { installChatPerformance, type ChatPerformanceContext } from './chat-performance.tsx'
import { getPerformanceSnapshot, installPerformanceClient, reportPerformanceApplied, subscribePerformance } from './performance-client.ts'
import { chatPerformanceGate } from './chat-window.ts'
import { installInitialHistoryFactory, type InitialHistoryDiagnostics } from './initial-history.ts'

/** Panel id; also the sidebar row id, so the two seats stay in step. */
export const PANEL_ID = 'session-storage' as MainPanelId

/** Services this bundle needs from the host assembly. */
export const inject = ['slots', 'sessions', 'connection']

/** Sidebar label; plain text so no dictionary has to be registered. */
const LABEL = '会话优化'

/**
 * Register the console's two seats.
 * @param ctx - browser root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    let active = true, loading = false, release: (() => void) | undefined
    const controller = new AbortController()
    const initialize = () => {
      if (!active || loading || release) return
      if (!ctx.get('workspaces') || !ctx.get('remote')) return
      loading = true
      void fetchSettings(controller.signal).then(settings => {
        if (!active) return
        release = installWorkspaceRecovery(ctx.get('workspaces'), ctx.get('remote'), settings.about?.dshVersion,
          () => require('@deepseek-ai/dsh-api-workspace-controller'))
      }).catch(error => { if (active) console.warn('[session-optimizer] Workspace recovery initialization:', error) })
        .finally(() => { loading = false })
    }
    const unsubscribe = onLibraryChanged(initialize)
    initialize()
    return () => { active = false; controller.abort(); unsubscribe(); release?.() }
  }, 'session-optimizer: recover terminated Workspace subscription')
  ctx.effect(() => installPerformanceTransport(ctx.get('connection')), 'session performance carrier')
  ctx.effect(() => installPerformanceClient(), 'session-optimizer performance settings sync')
  const source = { getSnapshot: getPerformanceSnapshot, subscribe: subscribePerformance }
  let previewApplied = false, previewReason = 'disabled'
  let factoryRegistered = false, reporting = false
  let historyDiagnostics: InitialHistoryDiagnostics | undefined
  const report = () => {
    if (reporting) return
    const snapshot = getPerformanceSnapshot(), gate = chatPerformanceGate(snapshot)
    const used = factoryRegistered && gate.virtualChat && historyDiagnostics?.lastUsedGeneration === snapshot.state?.revision
    const reason = !gate.virtualChat ? 'initial-history-disabled' : !factoryRegistered ? 'initial-history-factory-unavailable'
      : used ? 'initial-history-small-snapshot-used' : !historyDiagnostics?.hookCalls ? 'initial-history-hook-unconfirmed'
        : historyDiagnostics.lastHookCompatible ? 'initial-history-hook-ready' : 'initial-history-hook-incompatible'
    reporting = true
    try { reportPerformanceApplied({ historyWindow: previewApplied && gate.historyPreview, virtualChat: used, reason: `preview:${previewReason};${reason}` }) }
    finally { reporting = false }
  }
  ctx.effect(() => {
    let release: (() => void) | undefined
    try {
      release = installInitialHistoryFactory(() => {
        const snapshot = getPerformanceSnapshot()
        return { enabled: chatPerformanceGate(snapshot).virtualChat, generation: snapshot.state?.revision ?? '' }
      }, globalThis, { onChange: diagnostics => { historyDiagnostics = diagnostics; report() } })
      factoryRegistered = true
    } catch { /* Another owner or unsupported realm keeps the official path. */ }
    const unsubscribe = subscribePerformance(report)
    report()
    return () => { unsubscribe(); release?.(); factoryRegistered = false; report() }
  }, 'session-optimizer: first-follow history factory')
  installChatPerformance(ctx as unknown as ChatPerformanceContext, source, {
    onEffectiveChange: status => { previewApplied = status.historyPreview; previewReason = status.reason; report() },
  })
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
  }, ConsolePage))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 30,
    label: () => LABEL,
  }, ConsoleIcon))

  ctx.effect(() => {
    let active = true, announced = false
    const controller = new AbortController()
    const reconcile = (report?: MigrationReport) => {
      if (!active || !report) return
      const sessions = ctx.get('sessions') as SessionsService | undefined
      if (sessions) void sessions.refresh().then(() => {
        if (active && !controller.signal.aborted) return refreshMigratedTitles(sessions, report, controller.signal, () => active)
      })
        .catch(error => { if (active) console.warn('[session-optimizer] converted conversation titles:', error) })
      void syncWorkspaceMemberships(ctx.get('workspaces'), report, controller.signal, () => active)
        .catch(error => { if (active) console.warn('[session-optimizer] project grouping sync:', error) })
    }
    const unsubscribe = onLibraryChanged(report => {
      if (report) announced = true
      reconcile(report)
      const sessions = ctx.get('sessions') as SessionsService | undefined
      if (!report) void sessions?.refresh().catch(() => undefined)
      if (!sessions || !report) return
      void fetchSettings(controller.signal).then(async settings => {
        if (!active) return
        const results = await recoverMigratedSessions(sessions, report, settings.about?.dshVersion, () => active)
        for (const result of results) if (result.status === 'failed' || result.status === 'unsupported') {
          console.warn('[session-optimizer] conversation recovery:', result.id, result.status, result.error ?? '')
        }
      }).catch(error => { if (active) console.warn('[session-optimizer] conversation recovery:', error) })
    })
    void fetchMigrations(controller.signal).then(answer => {
      if (!active || announced) return
      const latest = answer.jobs.filter(job => job.status === 'completed' || job.status === 'partial').at(-1)
      reconcile(latest?.report)
    }).catch(error => { if (active) console.warn('[session-optimizer] initial project grouping sync:', error) })
    return () => { active = false; controller.abort(); unsubscribe() }
  }, 'dsh-session-optimizer: refresh and restore successfully migrated conversations')
}
