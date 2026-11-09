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

/** Panel id; also the sidebar row id, so the two seats stay in step. */
export const PANEL_ID = 'session-storage' as MainPanelId

/** Services this bundle needs from the host assembly. */
export const inject = ['slots', 'sessions']

/** Sidebar label; plain text so no dictionary has to be registered. */
const LABEL = '会话存储'

/**
 * Register the console's two seats.
 * @param ctx - browser root context.
 */
export function apply(ctx: ClientContext): void {
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

  ctx.effect(
    () => onLibraryChanged(() => {
      const sessions = ctx.get('sessions') as SessionsService | undefined
      // A failed re-read only leaves the list stale; the migration itself
      // already committed, so this must not raise into the panel.
      void sessions?.refresh().catch(() => undefined)
    }),
    'dsh-session-optimizer: refresh the session list after a migration',
  )
}
