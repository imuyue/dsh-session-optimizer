import { beforeAll, afterEach, expect, it, vi } from 'vitest'
import { installWorkspaceRecovery } from '../client/workspace-recovery.ts'
import { loadOfficialWorkspace, frameQueue } from './fixtures/official/official-workspace.mjs'
const root = process.env.DSH_TEST_OFFICIAL_ROOT
let official: Awaited<ReturnType<typeof loadOfficialWorkspace>>
beforeAll(async () => { if (root) official = await loadOfficialWorkspace(root) })
const contexts: Array<{ fiber: { dispose(): Promise<void> } }> = []
afterEach(async () => { for (const context of contexts.splice(0)) await context.fiber.dispose() })
const test = it.skipIf(!root)
const workspace = (ids: string[]) => ({ workspaceId: 'workspace-project', title: 'Project', path: 'C:\\Project', sessionIds: ids, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: new Date().toISOString() })
function fixture() {
  const { client, gateway, protocol } = official
  const queue = frameQueue(); let calls = 0, available = false
  const connection = { generation: { getSnapshot: () => 1, subscribe: () => () => {} } }
  const remote = { $stream: (options: unknown) => new gateway.RemoteStream(connection, options), workspace: {
    async *follow(signal: AbortSignal) {
      calls++
      if (!available) throw new protocol.RemoteError('gateway/service-unavailable', 'Workspace service is restarting', { endpoint: 'workspace/follow' })
      yield { type: 'baseline', value: { items: [workspace(['original'])], archivedSessionIds: [], pinnedSessionIds: [] } }
      yield* queue.read(signal)
    },
  } }
  const model = new client.ClientWorkspaceModel(remote.workspace)
  const context = new official.cordis.Context(); contexts.push(context)
  new client.WorkspaceController(context, model)
  const service = context.get('workspaces')
  return { client, model, service, remote, queue, calls: () => calls, ready: () => { available = true }, error: () => new protocol.RemoteError('gateway/service-unavailable', 'offline reproduction', { endpoint: 'workspace/follow' }) }
}
test('official terminated stream resumes and receives a new clone through actual baseline and delta consumers', async () => {
  const f = fixture()
  const original = f.client.createWorkspaceStateStream(f.remote, { accept: f.model, failed: (error: unknown) => f.model.handleStreamFailure(error) })
  original.start()
  await vi.waitFor(() => expect(f.model.getSnapshot().error?.code).toBe('gateway/service-unavailable'))
  await original.dispose()
  const stop = installWorkspaceRecovery(f.service, f.remote, '0.2.2-rc.1', () => f.client)
  try {
    await vi.waitFor(() => expect(f.calls()).toBe(2)); f.ready()
    await vi.waitFor(() => expect(f.model.getSnapshot().state).toBe('idle'), { timeout: 2000 })
    f.queue.push({ type: 'upsert', workspace: workspace(['copy', 'original']) })
    await vi.waitFor(() => expect(f.model.getSnapshot().items[0].sessionIds).toEqual(['copy', 'original']))
    expect(f.model.getSnapshot().error).toBeNull()
  } finally { stop() }
})
test('a healthy official consumer is left as the only owner', async () => {
  const f = fixture(); f.ready()
  const original = f.client.createWorkspaceStateStream(f.remote, { accept: f.model, failed: (error: unknown) => f.model.handleStreamFailure(error) })
  original.start()
  await vi.waitFor(() => expect(f.model.getSnapshot().state).toBe('idle'))
  const load = vi.fn(() => f.client), stop = installWorkspaceRecovery(f.service, f.remote, '0.2.2-rc.1', load)
  try {
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(load).not.toHaveBeenCalled(); expect(f.calls()).toBe(1)
    stop(); expect(f.model.getSnapshot().state).toBe('idle')
  } finally { stop(); await original.dispose() }
})
test('malformed local errors are contained instead of being passed to the official model', async () => {
  const f = fixture(); f.model.handleStreamFailure(f.error())
  let opened = false, failed: (error: unknown) => void = () => {}
  const stop = installWorkspaceRecovery(f.service, f.remote, '0.2.2-rc.1', () => ({ createWorkspaceStateStream: (_remote: unknown, options: { failed: typeof failed }) => {
    opened = true
    failed = options.failed
    return { start() {}, async dispose() {} }
  } }))
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await vi.waitFor(() => expect(opened).toBe(true))
    // The real official predicate rejects these, even though a marker property exists.
    const invalid = { isDSHRemoteError: false, code: 'gateway/service-unavailable' }
    expect(official.gateway.isRemoteFailure(invalid)).toBe(false)
    expect(() => failed(invalid)).not.toThrow()
    expect(f.model.getSnapshot().error.code).toBe('gateway/service-unavailable')
    expect(() => stop()).not.toThrow()
  } finally { stop(); warn.mockRestore() }
})
test('unmarked initial errors do not qualify for takeover of the official model', async () => {
  const f = fixture()
  const invalid = { code: 'gateway/service-unavailable', details: { endpoint: 'workspace/follow' } }
  expect(() => f.model.handleStreamFailure(invalid)).toThrow()
  const fakeService = { model: Object.assign(Object.create(f.model), { getSnapshot: () => ({ state: 'error', error: invalid }) }) } as { model: unknown; list?: unknown }
  fakeService.list = fakeService.model
  const load = vi.fn(() => f.client), stop = installWorkspaceRecovery(fakeService, f.remote, '0.2.2-rc.1', load)
  await new Promise(resolve => setTimeout(resolve, 30)); stop()
  expect(load).not.toHaveBeenCalled()
})
