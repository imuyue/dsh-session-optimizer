import { beforeAll, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as Optimizer from '../src/index.ts'
import { migrationById } from '../src/migrate.ts'
import { syncWorkspaceMemberships } from '../client/workspace-memberships.ts'
const membershipApi = vi.hoisted(() => ({ fetchWorkspaceMemberships: vi.fn() }))
vi.mock('../client/api.ts', () => membershipApi)
import { installWorkspaceRecovery } from '../client/workspace-recovery.ts'
import { loadOfficialWorkspace } from './fixtures/official/official-workspace.mjs'
const root = process.env.DSH_TEST_OFFICIAL_ROOT
let official: Awaited<ReturnType<typeof loadOfficialWorkspace>>
beforeAll(async () => { if (root) official = await loadOfficialWorkspace(root) })
const test = it.skipIf(!root)
for (const kind of ['jsonl', 'sqlite'] as const) test(`${kind} real conversion preserves official account and reaches the recovered official Client model`, async () => {
  const base = await mkdtemp(join(tmpdir(), 'dso-real-workspace-'))
  const ctx = new official.cordis.Context(), staleCtx = new official.cordis.Context()
  let stop = () => {}, original: { dispose(): Promise<void> } | undefined
  try {
    const project = join(base, 'project'); await mkdir(project)
    const [storage, json, domain, workspace, feedModule] = await Promise.all([
      official.load('dsh-storage'), official.load('dsh-storage-json'), official.load('dsh-storage-domain'), official.load('dsh-workspace'),
      import(pathToFileURL(join(root!, 'node_modules/@deepseek-ai/dsh-api-workspace-controller/lib/types/feed.js')).href),
    ])
    ctx.provide('agentLoop', {})
    ctx.provide('agents', { get: () => undefined })
    ctx.provide('sessions', { get: () => undefined, list: () => [], flush: async () => false })
    ctx.provide('sessionController', { state: async () => { throw new Error('No live Agent may be resumed by this fixture') } })
    const routes = new Map<string, { fetch(request: Request): Promise<Response> }>()
    ctx.provide('connection', { fetch: { register(entry: { path: string; fetch(request: Request): Promise<Response> }) {
      routes.set(entry.path, entry); return () => { routes.delete(entry.path) }
    } } })
    await ctx.plugin(Optimizer, { root: join(base, 'sqlite'), jsonlRoot: join(base, 'jsonl'), stateDirectory: join(base, 'state'), hybrid: true, newSessionBackend: kind, storageThread: 'inline', warmupSessions: 0 })
    const persistence = ctx.get('sessionPersistence')
    const sourceId = 'session-original'
    const handle = await persistence.create({ version: 4, id: sourceId, cwd: project, createdAt: 1700000000000, isSeeded: false, delegationDepth: 0 })
    await handle.append([{ type: 'session/title', seq: 0, time: 1700000000000, data: { title: 'Original project conversation', messageSeqs: [], source: { kind: 'user' } } }])
    await handle.flush(); await handle.close()
    const before = await persistence.stat(sourceId)
    await ctx.plugin(storage.default)
    await ctx.plugin(json, { root: join(base, 'storages') })
    await ctx.plugin(domain, { backend: 'json' })
    await ctx.plugin(workspace.default)
    const registry = ctx.get('workspaceRegistry'), owner = await registry.resolveByPath(project)
    expect(owner.sessionIds).toContain(sourceId)
    const feed = new feedModule.WorkspaceFeed({ workspaceRegistry: registry, on: ctx.on.bind(ctx), effect: ctx.effect.bind(ctx) })
    let available = false
    const remote = { $stream: (options: unknown) => new official.gateway.RemoteStream({ generation: { getSnapshot: () => 1, subscribe: () => () => {} } }, options), workspace: {
      async *follow(signal: AbortSignal) {
        if (!available) throw new official.protocol.RemoteError('gateway/service-unavailable', 'Isolated service replacement', { endpoint: 'workspace/follow' })
        yield* feed.follow(signal)
      },
    } }
    const model = new official.client.ClientWorkspaceModel(remote.workspace)
    original = official.client.createWorkspaceStateStream(remote, { accept: model, failed: (error: unknown) => model.handleStreamFailure(error) })
    original!.start()
    await vi.waitFor(() => expect(model.getSnapshot().error?.code).toBe('gateway/service-unavailable'))
    await original!.dispose()
    new official.client.WorkspaceController(ctx, model)
    stop = installWorkspaceRecovery(ctx.get('workspaces'), remote, '0.2.2-rc.1', () => official.client)
    available = true
    await vi.waitFor(() => expect(model.getSnapshot().state).toBe('idle'))
    await vi.waitFor(() => expect(routes.has('/api/session-optimizer/migrate')).toBe(true))
    const response = await routes.get('/api/session-optimizer/migrate')!.fetch(new Request('http://isolated/api/session-optimizer/migrate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ direction: kind === 'jsonl' ? 'jsonl_to_sqlite' : 'sqlite_to_jsonl', mode: 'clone', verify: true, sessions: [sourceId],
        sqliteRoot: join(base, 'sqlite').replaceAll('\\', '/'), jsonlRoot: join(base, 'jsonl').replaceAll('\\', '/') }),
    }))
    expect(response.status).toBe(202)
    const answer = await response.json(), job = migrationById(answer.id)!
    await vi.waitFor(() => expect(job.status).not.toBe('running'), { timeout: 10000 })
    expect(job.status, JSON.stringify(job)).toBe('completed')
    expect(job.report!.items[0].error, JSON.stringify(job.report)).toBeUndefined()
    const copyId = job.report!.items[0].targetSession
    expect(owner.sessionIds).toContain(copyId)
    await vi.waitFor(() => expect(model.getSnapshot().items.find((row: { workspaceId: string }) => row.workspaceId === owner.id).sessionIds).toContain(copyId))
    const stored = JSON.parse(await readFile(join(base, 'storages/workspace.json'), 'utf8'))
    expect(stored.tables.workspaces[owner.id].sessionIds).toContain(copyId)
    const storedBytes = await readFile(join(base, 'storages/workspace.json'))
    const staleModel = new official.client.ClientWorkspaceModel(remote.workspace)
    staleModel.replaceBaseline({ items: [{ workspaceId: owner.id, title: owner.title, path: owner.path, createdAt: owner.createdAt, updatedAt: owner.updatedAt, sessionIds: [sourceId] }], archivedSessionIds: [], pinnedSessionIds: [] })
    new official.client.WorkspaceController(staleCtx, staleModel)
    expect(staleModel.getSnapshot().state).toBe('idle')
    expect(staleModel.getSnapshot().items[0].sessionIds).not.toContain(copyId)
    const tooMany = await routes.get('/api/session-optimizer/workspace-memberships')!.fetch(new Request('http://isolated/api/session-optimizer/workspace-memberships?ids=' + encodeURIComponent(JSON.stringify(Array(51).fill(copyId)))))
    expect(tooMany.status).toBe(400)
    membershipApi.fetchWorkspaceMemberships.mockImplementation(async (ids: string[]) => {
      const answer = await routes.get('/api/session-optimizer/workspace-memberships')!.fetch(new Request('http://isolated/api/session-optimizer/workspace-memberships?ids=' + encodeURIComponent(JSON.stringify(ids))))
      expect(answer.status).toBe(200)
      return answer.json()
    })
    await syncWorkspaceMemberships(staleCtx.get('workspaces'), job.report!, new AbortController().signal)
    expect(staleModel.getSnapshot().items[0].sessionIds).toContain(copyId)
    expect(staleModel.getSnapshot().state).toBe('idle')
    expect(await readFile(join(base, 'storages/workspace.json'))).toEqual(storedBytes)
    expect(await persistence.stat(sourceId)).toEqual(before)
    expect(model.getSnapshot().error).toBeNull()
  } finally { stop(); await original?.dispose(); await staleCtx.fiber.dispose(); await ctx.fiber.dispose(); await rm(base, { recursive: true, force: true }) }
}, 30000)
