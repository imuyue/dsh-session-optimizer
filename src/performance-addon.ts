import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isAbsolute } from 'node:path'
import { registerPerformanceConsole } from './console.ts'
import { PreviewReader } from './history-preview.ts'
import { PerformanceController } from './performance.ts'
import { createPreferencesHost } from './preferences.ts'
import { createPerformanceTool, type PerformanceToolRegistry } from './performance-tool.ts'
import { PAGE_TRANSFER_POLICY, registerPageTransferPolicy } from './page-transfer.ts'

/** Standalone add-on: deliberately owns no sessionPersistence or sessionQuery service. */
export const name = 'dsh-session-performance'
export interface Config { root: string; preferencesPath: string }
export const Config: z<Config> = z.object({ root: z.string().required(), preferencesPath: z.string().required() })

export function apply(ctx: Context, config: Config): void {
  if (!isAbsolute(config.root) || !isAbsolute(config.preferencesPath)) {
    throw new Error('performance root and preferencesPath must be absolute paths')
  }
  // Root and add-on share one optional control owner. An existing own face,
  // even an unknown or unusable one, is never replaced or disposed by this row.
  // No await separates this guard from the registration below.
  if (Object.hasOwn(globalThis, PAGE_TRANSFER_POLICY)) return
  // A linked workspace can be rebuilt while the Host row is disabled. Publish
  // completed bytes through the official module table; unchanged artifacts are a no-op.
  const modules = ctx.get('clientModules') as { rebuilt(id: string): string | undefined } | undefined
  modules?.rebuilt(name)
  // No backend switch callback: format is an unused compatibility field in this
  // independent preferences file, and can never change the profile's provider.
  const preferences = createPreferencesHost(config.preferencesPath, ['jsonl'], () => undefined, { format: 'jsonl' })
  const performance = new PerformanceController(preferences, {
    historyWindow: { supported: true, reason: 'Bounded read-only loading preview and opt-in raw JSON page transport; complete recovery and validation remain unchanged.' },
    virtualChat: { supported: true, reason: 'Optional first-follow history window on a compatible exact-version Client hook; complete projection and subsequent history paging remain official.' },
  })
  ctx.effect(() => registerPageTransferPolicy(() => performance.read().effective.historyWindow), `${name}: page transport policy`)
  const preview = new PreviewReader(config.root, { journalMode: 'wal', synchronous: 'full', busyTimeoutMs: 100, readOnly: true, repair: false })
  ctx.effect(function* () {
    yield async () => { performance.dispose(); await preview.close() }
  }, `${name}: optional performance lifetime`)
  ctx.inject(['connection'], (routeCtx) => registerPerformanceConsole(routeCtx, { performance, historyPreview: preview }))
  ctx.inject(['tools'], (toolCtx) => {
    const tools = toolCtx.get('tools') as PerformanceToolRegistry | undefined
    if (tools === undefined) return
    toolCtx.effect(function* () { yield tools.register(createPerformanceTool(performance)) }, `${name}: versioned performance tool`)
  })
}
