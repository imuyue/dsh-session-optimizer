import type { MigrationReport } from './types.ts'

export interface ProjectionSessions { refreshProjections?(id: string): Promise<void> }
/** Populate the official sidebar title projections after the header-only list has refreshed. */
export async function refreshMigratedTitles(sessions: ProjectionSessions, report: MigrationReport, signal: AbortSignal, active: () => boolean = () => true): Promise<void> {
  if (typeof sessions.refreshProjections !== 'function' || (report.status !== 'completed' && report.status !== 'partial')) return
  const ids = [...new Set(report.items.filter(item => item.status === 'migrated' || (item.status === 'skipped' && item.error === undefined)).map(item => item.targetSession))]
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < ids.length) {
      if (signal.aborted || !active()) return
      const id = ids[cursor++]!
      await sessions.refreshProjections!(id)
    }
  }
  await Promise.all([worker(), worker()])
}
