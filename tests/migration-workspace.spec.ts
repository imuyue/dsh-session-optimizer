import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { cloneWorkspaceAttacher } from '../src/migration-workspace.ts'

const source = 'session-source' as SessionId, copy = 'session-copy' as SessionId

describe('clone Workspace accounting', () => {
  it('attaches to the explicit source account through the public entity', async () => {
    const wrong = vi.fn(), attach = vi.fn(async () => {})
    const owner = { sessionIds: [source], attachSession: attach }
    const registry = { list: () => [{ sessionIds: ['unrelated' as SessionId], attachSession: wrong }, owner] }
    await cloneWorkspaceAttacher(() => registry)(source, copy)
    expect(attach).toHaveBeenCalledExactlyOnceWith(copy)
    expect(wrong).not.toHaveBeenCalled()
  })
  it('preserves an explicitly ungrouped source', async () => {
    const attach = vi.fn(async () => {})
    await cloneWorkspaceAttacher(() => ({ list: () => [{ sessionIds: [], attachSession: attach }] }))(source, copy)
    expect(attach).not.toHaveBeenCalled()
  })
  it('works in standalone hosts without a Workspace registry', async () => {
    await expect(cloneWorkspaceAttacher(() => undefined)(source, copy)).resolves.toBeUndefined()
  })
  it('resolves the current service at action time rather than retaining a retired registry', async () => {
    const attach = vi.fn(async () => {})
    let registry: { list: () => Array<{ sessionIds: SessionId[]; attachSession: typeof attach }> } | undefined
    const complete = cloneWorkspaceAttacher(() => registry)
    await complete(source, copy)
    registry = { list: () => [{ sessionIds: [source], attachSession: attach }] }
    await complete(source, copy)
    expect(attach).toHaveBeenCalledExactlyOnceWith(copy)
  })
  it('propagates official durability errors for the migration warning', async () => {
    const failure = Error('workspace durable write failed')
    const attachSession = async () => { throw failure }
    await expect(cloneWorkspaceAttacher(() => ({ list: () => [{ sessionIds: [source], attachSession }] }))(source, copy)).rejects.toBe(failure)
  })
})
