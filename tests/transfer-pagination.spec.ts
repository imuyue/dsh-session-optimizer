import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { registerConsole } from '../src/console.ts'
import type { SourceListing } from '../client/types.ts'
import { appendTransferPage, nextTransferOffset, resetTransferPages, type TransferPageState } from '../client/transfer-pagination.ts'

// This test imports the production helper used by TransferTab. No copy of its
// algorithm and no DOM/string inspection substitutes for behavioral execution.
// Baseline 5f3fc19 has no helper, so this file's baseline status is NOT_RUN;
// missing import is infrastructure failure, not evidence of MERGED-04 red.
const roots: string[] = []
interface Route { path: string; fetch: (request: Request) => Promise<Response> }
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })
async function source(total: number): Promise<(offset: number, limit: number, query?: string) => Promise<SourceListing>> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-transfer-pagination-'))
  roots.push(root)
  for (let i = 0; i < total; i++) {
    const id = `session-${String(i).padStart(3, '0')}`, dir = join(root, '--work-pagination--', id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.v4.jsonl'), `${JSON.stringify({ type: 'session', version: 4, id, createdAt: 1700000000000 + i, cwd: '/work/pagination', isSeeded: false, delegationDepth: 0 })}\n`)
  }
  const routes = new Map<string, Route>()
  registerConsole({ connection: { fetch: { register: (route: Route) => { routes.set(route.path, route); return async () => {} } } } } as unknown as Context, {
    root: join(root, 'unused-sqlite'), jsonlRoot: root,
    settings: { journalMode: 'wal', synchronous: 'full', busyTimeoutMs: 1000 }, storageThread: 'inline',
  })
  return async (offset, limit, query) => {
    const params = new URLSearchParams({ backend: 'jsonl', root, offset: String(offset), limit: String(limit), ...(query ? { q: query } : {}) })
    const response = await routes.get('/api/session-optimizer/source')!.fetch(new Request(`http://regression/api/session-optimizer/source?${params}`))
    expect(response.status).toBe(200)
    return response.json() as Promise<SourceListing>
  }
}
function blank(): TransferPageState { return { generation: 0, listing: undefined } }
function page(offset: number, limit: number, ids: string[], total = 405, backend: 'sqlite' | 'jsonl' = 'jsonl', root = '/fixture'): SourceListing {
  return { backend, root, encoding: 'none', total, offset, limit, sessions: ids.map(id => ({ id, eventCount: 0, sizeBytes: 0, path: `${root}/${id}` })) }
}

describe('MERGED-04: real source handler plus production page state', () => {
  it.each([200, 201, 205, 405])('loads all %s conversations using returned offset/limit, without duplicates', async (total) => {
    const fetch = await source(total)
    let state = resetTransferPages(blank())
    const offsets: number[] = []
    for (let step = 0; step < 8; step++) {
      const offset = nextTransferOffset(state)
      if (offset === undefined) break
      offsets.push(offset)
      // Deliberately request 400; the real handler clamps to 200.
      const incoming = await fetch(offset, 400)
      expect(incoming.offset).toBe(offset)
      expect(incoming.limit).toBe(200)
      state = appendTransferPage(state, state.generation, incoming)
    }
    const ids = state.listing?.sessions.map(session => session.id) ?? []
    expect(ids).toHaveLength(total)
    expect(new Set(ids).size).toBe(total)
    expect(new Set(ids)).toEqual(new Set(Array.from({ length: total }, (_, i) => `session-${String(i).padStart(3, '0')}`)))
    expect(offsets).toEqual(total <= 200 ? [0] : total <= 400 ? [0, 200] : [0, 200, 400])
    expect(nextTransferOffset(state)).toBeUndefined()
  }, 20000)

  it('query reset starts at zero and a real filtered listing replaces the prior query', async () => {
    const fetch = await source(205)
    let state = resetTransferPages(blank())
    state = appendTransferPage(state, state.generation, await fetch(0, 200))
    const oldGeneration = state.generation
    const stalePage = await fetch(200, 200)
    state = resetTransferPages(state)
    expect(state.listing).toBeUndefined()
    expect(nextTransferOffset(state)).toBe(0)
    const current = await fetch(0, 200, 'session-204')
    state = appendTransferPage(state, state.generation, current)
    expect(state.listing?.sessions.map(row => row.id)).toEqual(['session-204'])
    const settled = state
    state = appendTransferPage(state, oldGeneration, stalePage)
    expect(state).toBe(settled)
    expect(nextTransferOffset(state)).toBeUndefined()
  })

  it('direction/root switch ignores the old asynchronous success even if transport ignores abort', async () => {
    let resolveOld!: (listing: SourceListing) => void
    const delayed = new Promise<SourceListing>(resolve => { resolveOld = resolve })
    let state = resetTransferPages(blank())
    const generation = state.generation
    const completion = delayed.then(incoming => { state = appendTransferPage(state, generation, incoming) })
    state = resetTransferPages(state)
    state = appendTransferPage(state, state.generation, page(0, 200, ['sqlite-new'], 1, 'sqlite', '/new'))
    const current = state
    resolveOld(page(0, 200, ['jsonl-old'], 1, 'jsonl', '/old'))
    await completion
    expect(state).toBe(current)
    expect(state.listing?.sessions.map(row => row.id)).toEqual(['sqlite-new'])
  })

  it('deduplicates a replay and rejects out-of-order/root/backend mismatches', () => {
    let state = resetTransferPages(blank())
    const first = page(0, 200, ['one', 'two'])
    state = appendTransferPage(state, state.generation, first)
    const accepted = state
    expect(appendTransferPage(state, state.generation, page(400, 200, ['too-early']))).toBe(accepted)
    expect(appendTransferPage(state, state.generation, page(200, 200, ['wrong-root'], 405, 'jsonl', '/other'))).toBe(accepted)
    expect(appendTransferPage(state, state.generation, page(200, 200, ['wrong-backend'], 405, 'sqlite'))).toBe(accepted)
    state = appendTransferPage(state, state.generation, page(200, 200, ['two', 'three']))
    expect(state.listing?.sessions.map(row => row.id)).toEqual(['one', 'two', 'three'])
    expect(nextTransferOffset(state)).toBe(400)
    const afterSecond = state
    state = appendTransferPage(state, state.generation, page(200, 200, ['two', 'three']))
    expect(state).toBe(afterSecond)
  })
})
