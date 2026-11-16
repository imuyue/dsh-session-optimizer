import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { patchController, ORIGINAL_SHA256, sha256 } from '../scripts/patch-initial-history.mjs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInitialHistoryRemote, INITIAL_HISTORY_FACTORY, installInitialHistoryFactory, type InitialHistoryPolicy } from '../client/initial-history.ts'

const request = () => ({ address: { kind: 'session', sessionId: 'fixture' }, activate: true, assistantStream: true, maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } })
const snapshot = (label = 'small', firstType = 'turn/start') => ({ type: 'snapshot', cursor: { seq: 8 }, records: [{ event: { seq: 3, type: firstType } }], hasMore: true, projections: { label }, assistantStream: { revision: 7 } })
function remoteOf(follow?: (req: ReturnType<typeof request>, signal?: AbortSignal) => AsyncIterable<unknown>) {
  const seen: { request: ReturnType<typeof request>; signal?: AbortSignal }[] = []
  const page = vi.fn(function (this: unknown, ...args: unknown[]) { return { receiver: this, args } })
  const stream = vi.fn(function (this: unknown, ...args: unknown[]) { return { receiver: this, args } })
  const originalFollow = function (req: ReturnType<typeof request>, signal?: AbortSignal) {
    seen.push({ request: req, signal })
    return follow?.(req, signal) ?? (async function* () { yield snapshot(); yield { type: 'event', event: { seq: 9 } } })()
  }
  const session = Object.create(null) as { follow: typeof originalFollow; page: typeof page }
  Object.defineProperties(session, { follow: { configurable: false, get: () => originalFollow }, page: { configurable: false, get: () => page } })
  Object.freeze(session)
  const remote = Object.freeze({ session, $stream: stream })
  return { remote, seen, page, stream }
}
afterEach(() => vi.useRealTimers())

describe('first-follow-only lightweight history', () => {
  it('forwards frozen readonly Remote accessors and leaves page/$stream and source request unchanged', async () => {
    const { remote, seen, page, stream } = remoteOf()
    const facade = createInitialHistoryRemote(remote, () => true)
    const original = request(); const before = structuredClone(original)
    const frames = await Array.fromAsync(facade.session.follow(original))
    expect(seen[0]!.request).toEqual({ ...before, turnWindow: { minMessages: 1, minTurns: 1 } })
    expect(original).toEqual(before)
    expect(frames[0]).toEqual(snapshot())
    const pageArgs = { beforeSeq: 3, ...request() }
    expect(facade.session.page(pageArgs)).toEqual({ receiver: remote.session, args: [pageArgs] })
    expect(facade.$stream('options')).toEqual({ receiver: remote, args: ['options'] })
    expect(page).toHaveBeenCalledTimes(1); expect(stream).toHaveBeenCalledTimes(1)
    expect(Object.getOwnPropertyDescriptor(remote.session, 'follow')!.set).toBeUndefined()
  })
  it('uses the small request only until the first snapshot and preserves every original frame identity', async () => {
    const first = snapshot(); const append = { type: 'assistant-stream', frame: { revision: 8 } }
    const { remote, seen } = remoteOf(() => (async function* () { yield first; yield append })())
    const facade = createInitialHistoryRemote(remote, () => true)
    const delivered = await Array.fromAsync(facade.session.follow(request()))
    expect(delivered[0]).toBe(first); expect(delivered[1]).toBe(append)
    for (let i = 0; i < 4; i++) {
      const original = request()
      await Array.fromAsync(facade.session.follow(original))
      expect(seen.at(-1)!.request).toBe(original)
    }
  })
  it('does not shrink an official request when disabled or unsupported', async () => {
    const { remote, seen } = remoteOf()
    const base = request()
    const subagent = { ...base, address: { kind: 'subagent', sessionId: 'child' } }
    await Array.fromAsync(createInitialHistoryRemote(remote, () => false).session.follow(base))
    await Array.fromAsync(createInitialHistoryRemote(remote, () => true).session.follow(subagent))
    const altered = { ...base, maxMessages: 200 }
    await Array.fromAsync(createInitialHistoryRemote(remote, () => true).session.follow(altered))
    expect(seen.map(item => item.request)).toEqual([base, subagent, altered])
    const unsupported = { session: {} }
    expect(createInitialHistoryRemote(unsupported, () => true)).toBe(unsupported)
  })
  it('keeps HISTORY and JUMP page arguments, caller signal, and Gateway initial request unchanged', async () => {
    const { remote, page } = remoteOf()
    const facade = createInitialHistoryRemote(remote, () => true)
    const initialRequest = request()
    await Array.fromAsync(facade.session.follow(initialRequest))
    const signal = new AbortController().signal
    const older = { ...initialRequest, beforeSeq: 3 }
    const jump = { ...older, turnWindow: { minMessages: 200, minTurns: 2 } }
    facade.session.page(older, signal); facade.session.page(jump, signal)
    expect(page.mock.calls).toEqual([[older, signal], [jump, signal]])
    expect(initialRequest.turnWindow).toEqual({ minMessages: 50, minTurns: 2 })
  })
  it.each(['disable', 'generation'] as const)('discards an uncommitted small snapshot after %s and closes it before official fallback', async reason => {
    let state: InitialHistoryPolicy = { enabled: true, generation: 1 }
    const order: string[] = []
    const smallFrame = snapshot('small'); const official = snapshot('official')
    const { remote, seen } = remoteOf(req => (async function* () {
      const small = req.turnWindow.minTurns === 1
      order.push(small ? 'small-open' : 'official-open')
      try {
        if (small) state = { enabled: reason !== 'disable', generation: 2 }
        yield small ? smallFrame : official
      } finally { order.push(small ? 'small-close' : 'official-close') }
    })())
    const signal = new AbortController().signal
    const result = await Array.fromAsync(createInitialHistoryRemote(remote, () => state).session.follow(request(), signal))
    expect(result).toEqual([official]); expect(result).not.toContain(smallFrame)
    expect(order).toEqual(['small-open', 'small-close', 'official-open', 'official-close'])
    expect(seen[1]!.signal).toBe(signal)
    expect(seen[1]!.request.turnWindow).toEqual({ minMessages: 50, minTurns: 2 })
  })
  it('polls only before commit and cancels an awaiting small carrier before opening the official one', async () => {
    vi.useFakeTimers()
    let state: InitialHistoryPolicy = { enabled: true, generation: 1 }
    let oldClosed = false
    const { remote, seen } = remoteOf((req, signal) => (async function* () {
      if (req.turnWindow.minTurns === 1) {
        try { await new Promise((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })) }
        finally { oldClosed = true }
      } else { expect(oldClosed).toBe(true); yield snapshot('official') }
    })())
    const pending = Array.fromAsync(createInitialHistoryRemote(remote, () => state).session.follow(request()))
    await Promise.resolve()
    state = { enabled: false, generation: 2 }
    await vi.advanceTimersByTimeAsync(25)
    expect(await pending).toEqual([snapshot('official')])
    expect(seen).toHaveLength(2); expect(vi.getTimerCount()).toBe(0)
  })
  it('does not restart or discard the already delivered snapshot when disabled afterwards', async () => {
    let enabled = true
    const { remote, seen } = remoteOf()
    const iterator = createInitialHistoryRemote(remote, () => enabled).session.follow(request())[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toEqual(snapshot())
    enabled = false
    expect((await iterator.next()).value).toEqual({ type: 'event', event: { seq: 9 } })
    await iterator.return?.()
    expect(seen).toHaveLength(1)
  })
  it('preserves caller cancellation instead of treating it as internal fallback', async () => {
    const controller = new AbortController(); const failure = new Error('caller cancelled')
    const { remote, seen } = remoteOf((_req, signal) => (async function* () {
      await new Promise((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }))
    })())
    const pending = Array.fromAsync(createInitialHistoryRemote(remote, () => true).session.follow(request(), controller.signal))
    controller.abort(failure)
    await expect(pending).rejects.toBe(failure)
    expect(seen).toHaveLength(1)
  })
  it('avoids any carrier call for an already cancelled caller', async () => {
    const { remote, seen } = remoteOf(); const controller = new AbortController(); controller.abort(new Error('before open'))
    await expect(Array.fromAsync(createInitialHistoryRemote(remote, () => true).session.follow(request(), controller.signal))).rejects.toThrow('before open')
    expect(seen).toHaveLength(0)
  })
  it('closes the small iterator and cancels its owned signal on consumer return', async () => {
    let closed = false
    const { remote, seen } = remoteOf(() => (async function* () { try { yield snapshot(); yield snapshot() } finally { closed = true } })())
    const caller = new AbortController()
    const iterator = createInitialHistoryRemote(remote, () => true).session.follow(request(), caller.signal)[Symbol.asyncIterator]()
    await iterator.next(); await iterator.return?.()
    expect(closed).toBe(true); expect(seen[0]!.signal!.aborted).toBe(true); expect(caller.signal.aborted).toBe(false)
  })
  it('rejects a cap-truncated turn boundary by using one original follow without publishing the small page', async () => {
    const { remote, seen } = remoteOf(req => (async function* () { yield snapshot(req.turnWindow.minTurns === 1 ? 'truncated' : 'official', req.turnWindow.minTurns === 1 ? 'assistant/message' : 'turn/start') })())
    const frames = await Array.fromAsync(createInitialHistoryRemote(remote, () => true).session.follow(request()))
    expect(frames).toEqual([snapshot('official')]); expect(seen).toHaveLength(2)
  })
  it('leaves original errors visible and never retries one merely because it is an error', async () => {
    const error = new Error('permission denied')
    const { remote, seen } = remoteOf(() => (async function* () { throw error })())
    await expect(Array.fromAsync(createInitialHistoryRemote(remote, () => true).session.follow(request()))).rejects.toBe(error)
    expect(seen).toHaveLength(1)
  })
  it('registers a readonly factory, refuses collision, and makes existing facades official after disposal', async () => {
    const target = {}; const dispose = installInitialHistoryFactory(() => true, target)
    const descriptor = Object.getOwnPropertyDescriptor(target, INITIAL_HISTORY_FACTORY)!
    expect(descriptor.writable).toBe(false); expect(descriptor.enumerable).toBe(false)
    expect(() => installInitialHistoryFactory(() => true, target)).toThrow('already installed')
    const { remote, seen } = remoteOf()
    const facade = descriptor.value(remote) as typeof remote
    dispose(); dispose()
    expect(Object.getOwnPropertyDescriptor(target, INITIAL_HISTORY_FACTORY)).toBeUndefined()
    const original = request(); await Array.fromAsync(facade.session.follow(original))
    expect(seen[0]!.request).toBe(original)
  })
  it('reports real hook and small-snapshot use separately, with readonly coalesced diagnostics', async () => {
    const target = {}, reports: unknown[] = []
    const dispose = installInitialHistoryFactory(() => ({ enabled: true, generation: 'cfg:1' }), target, { onChange: value => reports.push(value) })
    const factory = Object.getOwnPropertyDescriptor(target, INITIAL_HISTORY_FACTORY)!.value
    expect(factory.diagnostics).toMatchObject({ hookCalls: 0, attempts: 0, used: 0 })
    expect(Object.isFrozen(factory.diagnostics)).toBe(true)
    expect(Reflect.set(factory.diagnostics, 'used', 99)).toBe(false)
    const { remote } = remoteOf()
    let facade = remote
    for (let i = 0; i < 1000; i++) facade = factory(remote)
    expect(factory.diagnostics).toMatchObject({ hookCalls: 1000, attempts: 0, used: 0, lastHookCompatible: true })
    await Promise.resolve()
    expect(reports).toHaveLength(1)
    await Array.fromAsync(facade.session.follow(request()))
    expect(factory.diagnostics).toMatchObject({ attempts: 1, used: 1, fallbacks: 0, lastUsedGeneration: 'cfg:1' })
    expect(Object.getOwnPropertyDescriptor(factory, 'diagnostics')?.set).toBeUndefined()
    dispose()
    const count = reports.length
    factory(remote)
    await Promise.resolve()
    expect(reports).toHaveLength(count)
  })
  it('records fallback without claiming use and suppresses a pending notification on disposal', async () => {
    const target = {}, notify = vi.fn()
    const dispose = installInitialHistoryFactory(() => ({ enabled: true, generation: 'cfg:1' }), target, { onChange: notify })
    const factory = Object.getOwnPropertyDescriptor(target, INITIAL_HISTORY_FACTORY)!.value
    const { remote } = remoteOf(req => (async function* () { yield snapshot('page', req.turnWindow.minTurns === 1 ? 'assistant/message' : 'turn/start') })())
    await Array.fromAsync(factory(remote).session.follow(request()))
    expect(factory.diagnostics).toMatchObject({ attempts: 1, used: 0, fallbacks: 1 })
    expect(factory.diagnostics.lastUsedGeneration).toBeUndefined()
    factory(remote)
    const before = notify.mock.calls.length
    dispose()
    await Promise.resolve()
    expect(notify).toHaveBeenCalledTimes(before)
  })
})

describe('prepared exact-controller patch', () => {
  it('rejects an unknown controller without creating a backup or changing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-initial-history-test-'))
    try {
      const file = join(dir, 'client.js'); const bytes = Buffer.from('const otherVersion = true')
      writeFileSync(file, bytes)
      expect(() => patchController('apply', file)).toThrow('unsupported')
      expect(readFileSync(file)).toEqual(bytes)
      expect(existsSync(`${file}.initial-history-${ORIGINAL_SHA256}.original`)).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  const installed = process.env.DSH_INITIAL_HISTORY_FIXTURE ?? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-api-session-controller', 'lib', 'client.js')
  it.skipIf(!existsSync(installed))('round-trips a supported installed-source copy and refuses edits after patching', () => {
    const source = readFileSync(installed)
    expect(sha256(source)).toBe(ORIGINAL_SHA256)
    const dir = mkdtempSync(join(tmpdir(), 'dsh-initial-history-golden-'))
    try {
      const file = join(dir, 'client.js'); writeFileSync(file, source)
      expect(patchController('inspect', file).stateAfter).toBe('original')
      const applied = patchController('apply', file)
      expect(applied.stateBefore).toBe('original'); expect(applied.stateAfter).toBe('patched')
      const patched = readFileSync(file)
      expect(readFileSync(applied.backup)).toEqual(source)
      expect(patchController('apply', file).stateBefore).toBe('patched')
      expect(readFileSync(file)).toEqual(patched)
      writeFileSync(file, Buffer.concat([patched, Buffer.from('\n// concurrent edit')]))
      expect(() => patchController('revert', file)).toThrow('exact supported original')
      expect(readFileSync(file)).toEqual(Buffer.concat([patched, Buffer.from('\n// concurrent edit')]))
      writeFileSync(file, patched)
      expect(patchController('revert', file).stateAfter).toBe('original')
      expect(readFileSync(file)).toEqual(source)
      expect(patchController('revert', file).stateBefore).toBe('original')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
