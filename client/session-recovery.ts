import type { MigrationReport } from './types.ts'

/** Public binding lookup; the implementation-specific adapter stays below. */
export interface RecoverySessions {
  binding?(id: string): { session: unknown } | undefined
}
export interface RecoveryResult { id: string; status: 'restored' | 'skipped' | 'unsupported' | 'failed'; error?: string }
interface Rc1Session {
  removed: boolean
  openGeneration: number
  getSnapshot(): { removed: boolean; openState: string; running: boolean; pendingSubmissions: readonly unknown[]; openError?: unknown }
  resync(): Promise<void>
  notifier: { markDirty(): void }
}
const pending = new WeakMap<object, Promise<RecoveryResult>>()

/**
 * Compatibility for the verified 0.2.2-rc.1 Client only. Its disposal relay sets
 * removed permanently; refresh() only reloads the sidebar. resync is a concrete
 * implementation method, NOT a public SessionsService reset API. Reuse it only
 * for successful migration IDs and the exact known shape; keep the same binding,
 * drafts, retained references and independently owned projection state.
 */
export async function recoverMigratedSessions(
  sessions: RecoverySessions,
  report: MigrationReport,
  hostVersion: string | undefined,
  active: () => boolean = () => true,
): Promise<RecoveryResult[]> {
  if (!active() || (report.status !== 'completed' && report.status !== 'partial')) return []
  const ids = new Set(report.items.filter(item => item.status === 'migrated').flatMap(item => [item.sourceSession, item.targetSession]))
  const results: RecoveryResult[] = []
  for (const id of ids) {
    if (!active()) break
    const face = sessions.binding?.(id)?.session
    if (typeof face !== 'object' || face === null) continue
    const value = face as Rc1Session
    if (typeof value.getSnapshot !== 'function' || value.getSnapshot().removed !== true) continue
    if (hostVersion !== '0.2.2-rc.1') { results.push({ id, status: 'unsupported' }); continue }
    const removed = Object.getOwnPropertyDescriptor(face, 'removed')
    if (removed?.value !== true || removed.writable !== true || typeof value.resync !== 'function'
      || !Number.isSafeInteger(value.openGeneration) || typeof value.notifier?.markDirty !== 'function') {
      results.push({ id, status: 'unsupported' }); continue
    }
    const joining = pending.get(face)
    if (joining) { results.push(await joining); continue }
    const snapshot = value.getSnapshot()
    if (snapshot.running || snapshot.pendingSubmissions.length !== 0 || snapshot.openState === 'cold') {
      results.push({ id, status: 'skipped' }); continue
    }
    const generation = value.openGeneration
    const operation = (async (): Promise<RecoveryResult> => {
      try {
        if (!active() || sessions.binding?.(id)?.session !== face) return { id, status: 'skipped' }
        value.removed = false
        await value.resync()
        if (sessions.binding?.(id)?.session !== face) return { id, status: 'skipped' }
        const after = value.getSnapshot()
        if (after.removed || after.openState !== 'open' || after.openError) throw new Error('restored conversation did not reopen')
        return { id, status: 'restored' }
      } catch (error) {
        // A newer resync, replacement binding, or genuine removal owns its state.
        if (sessions.binding?.(id)?.session === face && (value.openGeneration === generation || value.openGeneration === generation + 1) && value.removed === false) {
          value.removed = true
          value.notifier.markDirty()
        }
        return { id, status: 'failed', error: error instanceof Error ? error.message : String(error) }
      }
    })()
    pending.set(face, operation)
    try { results.push(await operation) } finally { if (pending.get(face) === operation) pending.delete(face) }
  }
  return results
}
