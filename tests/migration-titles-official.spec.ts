import { beforeAll, expect, it, vi } from 'vitest'
import { refreshMigratedTitles } from '../client/migration-titles.ts'
import { loadOfficialSessions } from './fixtures/official/official-sessions.mjs'
import type { MigrationReport } from '../client/types.ts'
const root = process.env.DSH_TEST_OFFICIAL_ROOT
let official: Awaited<ReturnType<typeof loadOfficialSessions>>
beforeAll(async () => { if (root) official = await loadOfficialSessions(root) })
it.skipIf(!root)('official sidebar changes untitled parent and child rows to stored titles without retaining or opening an Agent', async () => {
  const ctx = new official.cordis.Context()
  const names = { parent: '副本-主对话', child: '副本-子对话' } as Record<string, string>
  const projections = vi.fn(async ({ sessionId }: { sessionId: string }) => ({ ok: true, value: { kind: 'sequenced', asOfSeq: 4, values: { title: names[sessionId], sessionListMetadata: { blank: false, lastPromptAt: null } } } }))
  const follow = vi.fn(() => { throw new Error('No history opening is allowed') })
  const remote = { session: {
    list: async () => ({ ok: true, value: { items: [{ sessionId: 'parent', agentAvailable: false, updatedAt: 1, running: false, blank: false, cwd: '/project' }, { sessionId: 'child', agentAvailable: false, updatedAt: 1, running: false, blank: false, cwd: '/project', origin: 'subagent', parentSessionId: 'parent' }] } }), projections, follow,
  } }
  const sessions = new official.sessionClient.ClientSessions(ctx, remote)
  try {
    await sessions.refresh()
    expect(sessions.list.getSnapshot().byId.parent.title).toBeUndefined()
    expect(sessions.list.getSnapshot().byId.child.title).toBeUndefined()
    expect(projections).not.toHaveBeenCalled()
    const report = { status: 'completed', items: [{ status: 'migrated', targetSession: 'parent' }, { status: 'migrated', targetSession: 'child' }] } as MigrationReport
    await refreshMigratedTitles(sessions, report, new AbortController().signal)
    await vi.waitFor(() => expect(sessions.list.getSnapshot().byId.parent.title).toBe(names.parent))
    expect(sessions.list.getSnapshot().byId.child.title).toBe(names.child)
    expect(sessions.list.getSnapshot().byId.child.parentId).toBe('parent')
    expect(projections.mock.calls.map(call => call[0].sessionId).sort()).toEqual(['child', 'parent'])
    expect(sessions.retainInfo('parent').getSnapshot().referenceCount).toBe(0)
    expect(follow).not.toHaveBeenCalled()
  } finally { await ctx.fiber.dispose() }
})
