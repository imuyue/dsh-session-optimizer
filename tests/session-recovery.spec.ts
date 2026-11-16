import { describe, expect, it, vi } from 'vitest'
import { recoverMigratedSessions } from '../client/session-recovery.ts'
import { announceLibraryChanged, onLibraryChanged } from '../client/library.ts'
import type { MigrationReport } from '../client/types.ts'
function report(status: MigrationReport['status'] = 'completed'): MigrationReport {
  return { migrationId: 'private-job', mode: 'overwrite', sourceBackend: 'jsonl', targetBackend: 'sqlite', sourceRoot: 'a', targetRoot: 'b', startedAt: 1, status, items: [{ sourceSession: 'selected', targetSession: 'selected', status: 'migrated', expected: 4, transferred: 4 }] }
}
function fixture() {
  const draft = { text: 'keep unsent text' }, projection = { cursor: 42 }
  const face = { removed: true, openGeneration: 0, openState: 'open', running: false, pendingSubmissions: [] as unknown[], openError: null as unknown, draft, projection,
    getSnapshot() { return { removed: this.removed, openState: this.openState, running: this.running, pendingSubmissions: this.pendingSubmissions, openError: this.openError } },
    notifier: { markDirty: vi.fn() }, resync: vi.fn(async () => { face.openGeneration++; face.notifier.markDirty() }) }
  const unrelated = { ...face, removed: true, notifier: { markDirty: vi.fn() }, resync: vi.fn() }
  const bindings = new Map([['selected', { session: face }], ['unrelated-deleted', { session: unrelated }]])
  return { face, unrelated, bindings, sessions: { binding: (id: string) => bindings.get(id) } }
}
describe('migration rc1 Client recovery', () => {
  it('reopens only a successfully migrated removed binding, keeping draft/projection/reference identity', async () => {
    const f = fixture(), binding = f.bindings.get('selected'), draft = f.face.draft, projection = f.face.projection
    expect(await recoverMigratedSessions(f.sessions, report(), '0.2.2-rc.1')).toEqual([{ id: 'selected', status: 'restored' }])
    expect(f.face.removed).toBe(false); expect(f.face.resync).toHaveBeenCalledTimes(1)
    expect(f.bindings.get('selected')).toBe(binding); expect(f.face.draft).toBe(draft); expect(f.face.projection).toBe(projection)
    expect(f.unrelated.removed).toBe(true); expect(f.unrelated.resync).not.toHaveBeenCalled()
  })
  it('does not restore failed items, failed reports or arbitrary deletion notifications', async () => {
    const f = fixture(), failed = report(); failed.items[0]!.status = 'failed'
    expect(await recoverMigratedSessions(f.sessions, failed, '0.2.2-rc.1')).toEqual([])
    expect(await recoverMigratedSessions(f.sessions, report('failed'), '0.2.2-rc.1')).toEqual([])
    expect(f.face.resync).not.toHaveBeenCalled(); expect(f.face.removed).toBe(true)
  })
  it('leaves unsupported versions/shapes, active submissions and running conversations untouched', async () => {
    const f = fixture()
    expect((await recoverMigratedSessions(f.sessions, report(), '0.2.3'))[0]?.status).toBe('unsupported')
    f.face.running = true
    expect((await recoverMigratedSessions(f.sessions, report(), '0.2.2-rc.1'))[0]?.status).toBe('skipped')
    f.face.running = false; f.face.pendingSubmissions.push({})
    expect((await recoverMigratedSessions(f.sessions, report(), '0.2.2-rc.1'))[0]?.status).toBe('skipped')
    f.face.pendingSubmissions = []; Object.defineProperty(f.face, 'removed', { value: true, writable: false })
    expect((await recoverMigratedSessions(f.sessions, report(), '0.2.2-rc.1'))[0]?.status).toBe('unsupported')
    expect(f.face.resync).not.toHaveBeenCalled()
  })
  it('restores the removed flag after a failed reopen and preserves the error', async () => {
    const f = fixture(); f.face.resync.mockImplementation(async () => { f.face.openGeneration++; throw Error('missing backing store') })
    expect((await recoverMigratedSessions(f.sessions, report(), '0.2.2-rc.1'))[0]).toEqual({ id: 'selected', status: 'failed', error: 'missing backing store' })
    expect(f.face.removed).toBe(true); expect(f.face.notifier.markDirty).toHaveBeenCalled()
  })
  it('does not overwrite a replacement binding or a newer removal while awaiting resync', async () => {
    const f = fixture(); f.face.resync.mockImplementation(async () => { f.face.openGeneration++; f.bindings.delete('selected'); throw Error('retired') })
    expect((await recoverMigratedSessions(f.sessions, report(), '0.2.2-rc.1'))[0]?.status).toBe('failed')
    expect(f.face.notifier.markDirty).not.toHaveBeenCalled()
    const g = fixture(); g.face.resync.mockImplementation(async () => { g.face.openGeneration++; g.face.removed = true })
    expect((await recoverMigratedSessions(g.sessions, report(), '0.2.2-rc.1'))[0]?.status).toBe('failed')
    expect(g.face.removed).toBe(true)
  })
  it('does not start after unload and does not resync twice for overlapping announcements', async () => {
    const f = fixture()
    expect(await recoverMigratedSessions(f.sessions, report(), '0.2.2-rc.1', () => false)).toEqual([])
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve })
    f.face.resync.mockImplementation(async () => { f.face.openGeneration++; await held })
    const first = recoverMigratedSessions(f.sessions, report(), '0.2.2-rc.1')
    const second = recoverMigratedSessions(f.sessions, report(), '0.2.2-rc.1')
    release(); await Promise.all([first, second]); expect(f.face.resync).toHaveBeenCalledTimes(1)
  })
  it('carries the settled report through the existing notification and keeps independent listeners running', () => {
    const seen: unknown[] = [], value = report()
    const remove = onLibraryChanged(() => { throw Error('unrelated panel') })
    const stop = onLibraryChanged(change => { seen.push(change) })
    try { announceLibraryChanged(value); announceLibraryChanged(); expect(seen).toEqual([value, undefined]) }
    finally { remove(); stop() }
  })
})
