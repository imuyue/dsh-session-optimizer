import type { ClientContext } from './context.ts'

/**
 * The Host-only performance add-on ships an inert Client entry for compatibility.
 * The dsh-session-optimizer Client owns the unified 会话优化 settings page,
 * performance transport and chat effects. Keeping this entry inert avoids a
 * second sidebar panel and duplicate performance stores or flow registrations
 * when both existing Host plugins are mounted.
 *
 * Install/update the optimizer Client alongside this Host add-on to expose the
 * controls; this entry intentionally registers no UI or performance effects.
 */
export const inject: string[] = []

export function apply(_ctx: ClientContext): void {}
