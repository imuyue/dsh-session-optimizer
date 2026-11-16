import { fetchWorkspaceMemberships, type WorkspaceProjection } from './api.ts'
import type { MigrationReport } from './types.ts'

interface Model { upsertView(workspace: WorkspaceProjection): void }
/** rc.1 adapter: merge detached official views only; never reset errors or mutate project accounts. */
export async function syncWorkspaceMemberships(workspaces: unknown, report: MigrationReport, signal: AbortSignal, active: () => boolean = () => true): Promise<void> {
  if (!workspaces || typeof workspaces !== 'object' || (report.status !== 'completed' && report.status !== 'partial')) return
  const service = workspaces as { model?: Model; list?: unknown }, model = service.model
  if (!model || service.list !== model || typeof model.upsertView !== 'function') return
  const ids = [...new Set(report.items.filter(item => item.status === 'migrated').map(item => item.targetSession))]
  const refreshed = new Set<string>()
  for (let offset = 0; offset < ids.length; offset += 50) {
    if (!active() || signal.aborted) return
    const selected = ids.slice(offset, offset + 50), expected = new Set(selected)
    const result = await fetchWorkspaceMemberships(selected, signal)
    if (!active() || signal.aborted || !result.available || result.dshVersion !== '0.2.2-rc.1'
      || !Array.isArray(result.workspaces) || !Array.isArray(result.memberships)) return
    const views = new Map(result.workspaces.map(view => [view.workspaceId, view]))
    for (const membership of result.memberships) {
      if (!active() || signal.aborted) return
      if (!expected.has(membership.sessionId) || refreshed.has(membership.workspaceId)) continue
      const view = views.get(membership.workspaceId)
      if (!view || typeof view.path !== 'string' || typeof view.title !== 'string' || typeof view.createdAt !== 'string'
        || typeof view.updatedAt !== 'string' || !Array.isArray(view.sessionIds) || !view.sessionIds.every(id => typeof id === 'string')
        || !view.sessionIds.includes(membership.sessionId)) continue
      model.upsertView(view)
      refreshed.add(membership.workspaceId)
    }
  }
}
