import type { SessionId } from '@deepseek-ai/dsh-session'

/** Public Workspace subset; no dependency on internal registry state. */
export interface MigrationWorkspaceRegistry {
  list(): Array<{
    readonly id?: string
    readonly path?: string
    readonly title?: string
    readonly createdAt?: string
    readonly updatedAt?: string
    readonly sessionIds: readonly SessionId[]
    attachSession(id: SessionId): Promise<void>
  }>
}
export interface WorkspaceMembership { sessionId: string; workspaceId: string }
export interface WorkspaceProjection {
  workspaceId: string; path: string; title: string; createdAt: string; updatedAt: string; sessionIds: readonly string[]
}
export interface WorkspaceMembershipSnapshot { memberships: WorkspaceMembership[]; workspaces: WorkspaceProjection[] }
/** Detached, read-only projections of existing official accounts. Never infer ownership from cwd. */
export function readWorkspaceMemberships(registry: () => MigrationWorkspaceRegistry | undefined, ids: readonly string[]): WorkspaceMembershipSnapshot | undefined {
  const current = registry()
  if (current === undefined) return undefined
  const wanted = new Set(ids), memberships: WorkspaceMembership[] = [], workspaces: WorkspaceProjection[] = []
  for (const workspace of current.list()) {
    if (typeof workspace.id !== 'string') continue
    const sessionIds = [...workspace.sessionIds], matches = sessionIds.filter(id => wanted.has(id))
    if (!matches.length) continue
    for (const sessionId of matches) memberships.push({ sessionId, workspaceId: workspace.id })
    if (typeof workspace.path === 'string' && typeof workspace.title === 'string' && typeof workspace.createdAt === 'string' && typeof workspace.updatedAt === 'string') {
      workspaces.push({ workspaceId: workspace.id, path: workspace.path, title: workspace.title, createdAt: workspace.createdAt, updatedAt: workspace.updatedAt, sessionIds })
    }
  }
  return { memberships, workspaces }
}

/** Preserve the source's explicit account, including deliberately ungrouped sources. */
export function cloneWorkspaceAttacher(
  registry: () => MigrationWorkspaceRegistry | undefined,
): (sourceId: string, targetId: string) => Promise<void> {
  return async (sourceId, targetId) => {
    const owner = registry()?.list().find(workspace => workspace.sessionIds.includes(sourceId as SessionId))
    await owner?.attachSession(targetId as SessionId)
  }
}
