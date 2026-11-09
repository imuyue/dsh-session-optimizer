/**
 * Sidebar glyph for the console panel.
 *
 * Rendered by the sidebar as the row's direct icon child, which is why this
 * returns the icon itself and not a wrapper: an inline wrapper becomes the
 * baseline of a line box inside the row's glyph slot and lifts the glyph above
 * its label (the same reason `ui-schedule`'s `TaskManagerIcon` does this).
 *
 * @module dsh-session-optimizer/client/ConsoleIcon
 */

import { IconDatabaseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Render the database glyph at the size the sidebar asks for. The sidebar owns
 * the row's accessible name, so the glyph stays decorative.
 * @param props.size - edge length in px requested by the sidebar row.
 * @returns the glyph.
 */
export function ConsoleIcon({ size }: { size?: number }) {
  return <IconDatabaseOutlineRegular size={size} />
}
