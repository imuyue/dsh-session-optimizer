/**
 * The slice of the client root context this bundle uses.
 *
 * Declared locally so the bundle typechecks without the full Client assembly
 * (`@deepseek-ai/dsh-client-*`), which is not installable on the build machine.
 * Only the shape actually used is modelled; the runtime object is the real
 * context handed to `apply`.
 *
 * @module dsh-session-optimizer/client/context
 */

/**
 * Branded panel id. The layout layer keys main panels by this value; the
 * sidebar row uses the same string, so one constant names both seats.
 */
export type MainPanelId = string & { readonly __mainPanelId?: never }

/** Registration options the console passes; the renderer adds the component. */
export interface SlotRegisterOptions {
  name: string
  key?: string
  id?: string
  order?: number
  label?: () => string
  locale?: string
}

/** The `slots` service: inject a seat's lifetime, then register into it. */
export interface SlotsService {
  inject(seat: string, callback: () => unknown): unknown
  register(options: SlotRegisterOptions, component: unknown): unknown
}

/**
 * The `sessions` service, as far as this bundle uses it.
 *
 * Only `refresh` is called: after a migration changes which backend owns a
 * conversation, the list the sidebar shows is stale until the client re-reads
 * `session.list`. The service lives at `packages/api/session-controller/src/client/sessions/service.ts`,
 * where `refresh()` forwards to `SessionManager.refreshList()`.
 */
export interface SessionsService {
  refresh(): Promise<void>
}

/** Browser root context as far as this plugin is concerned. */
export interface ClientContext {
  readonly slots: SlotsService
  get(name: string): unknown
  effect(callback: () => unknown, label?: string): unknown
}
