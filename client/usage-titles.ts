import { hydrateSessionTitles } from './session-titles.ts'
import type { Overview, UsageRow } from './types.ts'

/** The overview uses the same current-page title reader as conversion. */
export async function hydrateUsageTitles(page: Overview, signal: AbortSignal, publish: (rows: readonly UsageRow[]) => void): Promise<void> {
  await hydrateSessionTitles(page.usage, signal, publish)
}
