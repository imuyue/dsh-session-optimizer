import { expect, it, vi } from 'vitest'
import { syncWorkspaceMemberships } from '../client/workspace-memberships.ts'
import type { MigrationReport } from '../client/types.ts'
const api = vi.hoisted(() => ({ fetchWorkspaceMemberships: vi.fn() }))
vi.mock('../client/api.ts', () => api)
const report = { status: 'completed', items: [{ status: 'migrated', targetSession: 'copy' }, { status: 'failed', targetSession: 'failed-copy' }] } as MigrationReport
const view = { workspaceId: 'project', path: '/project', title: 'Project', createdAt: '2026-01-01', updatedAt: '2026-01-02', sessionIds: ['original', 'copy'] }
const answer = { available: true, dshVersion: '0.2.2-rc.1', memberships: [{ sessionId: 'copy', workspaceId: 'project' }], workspaces: [view] }
const service = () => { const model = { upsertView: vi.fn() }; return { model, list: model, create: vi.fn(), insertSessionBefore: vi.fn() } }
it('only merges Host-confirmed migrated IDs, without using any project mutation command', async () => {
  api.fetchWorkspaceMemberships.mockResolvedValue({ ...answer, memberships: [{ sessionId: 'foreign', workspaceId: 'wrong' }, ...answer.memberships, ...answer.memberships] })
  const target = service()
  await syncWorkspaceMemberships(target, report, new AbortController().signal)
  expect(api.fetchWorkspaceMemberships).toHaveBeenLastCalledWith(['copy'], expect.any(AbortSignal))
  expect(target.model.upsertView).toHaveBeenCalledExactlyOnceWith(view)
  expect(target.create).not.toHaveBeenCalled(); expect(target.insertSessionBefore).not.toHaveBeenCalled()
})
it('leaves originally ungrouped conversations and unavailable registry untouched', async () => {
  const target = service()
  for (const available of [false, true]) {
    api.fetchWorkspaceMemberships.mockResolvedValue({ ...answer, available, memberships: [], workspaces: [] })
    await syncWorkspaceMemberships(target, report, new AbortController().signal)
  }
  expect(target.model.upsertView).not.toHaveBeenCalled()
})
it('suppresses late account updates after cancellation', async () => {
  const abort = new AbortController(), target = service()
  api.fetchWorkspaceMemberships.mockImplementationOnce(async () => { abort.abort(); return answer })
  await syncWorkspaceMemberships(target, report, abort.signal)
  expect(target.model.upsertView).not.toHaveBeenCalled()
})
it('chunks identity sets to the bounded Owner route', async () => {
  api.fetchWorkspaceMemberships.mockClear().mockResolvedValue({ ...answer, memberships: [], workspaces: [] })
  const many = { ...report, items: Array.from({ length: 101 }, (_, i) => ({ status: 'migrated', targetSession: String(i) })) } as MigrationReport
  await syncWorkspaceMemberships(service(), many, new AbortController().signal)
  expect(api.fetchWorkspaceMemberships.mock.calls.map(call => call[0].length)).toEqual([50, 50, 1])
})
it('declines unknown Core versions and inconsistent projections', async () => {
  const target = service()
  for (const result of [{ ...answer, dshVersion: '0.3.0' }, { ...answer, workspaces: [{ ...view, sessionIds: ['foreign'] }] }]) {
    api.fetchWorkspaceMemberships.mockResolvedValue(result)
    await syncWorkspaceMemberships(target, report, new AbortController().signal)
  }
  expect(target.model.upsertView).not.toHaveBeenCalled()
})
