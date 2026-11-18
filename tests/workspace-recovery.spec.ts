import { afterEach, describe, expect, it, vi } from 'vitest'
import { installWorkspaceRecovery } from '../client/workspace-recovery.ts'
const error = { isDSHRemoteError: true, code: 'gateway/service-unavailable', details: { endpoint: 'workspace/follow' } }
function fixture(initial: unknown = error) {
  const listeners = new Set<() => void>()
  let state = { state: initial ? 'error' : 'idle', error: initial }
  const publish = () => { for (const fn of [...listeners]) fn() }
  const model = {
    getSnapshot: () => state,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    replaceBaseline: vi.fn((_v: unknown) => { state = { state: 'idle', error: null }; publish() }),
    upsertView: vi.fn(), removeView: vi.fn(), replaceOrder: vi.fn(), replaceArchived: vi.fn(), replacePinned: vi.fn(),
    handleCarrierFailure: vi.fn(),
    handleStreamFailure: vi.fn((e: unknown) => { state = { state: 'error', error: e }; publish() }),
  }
  const options: Array<{ accept: typeof model; failed(error: unknown): void; carrierFailed(): void }> = []
  const controls: Array<{ start: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> = []
  const create = vi.fn((_r, opts) => { options.push(opts); const c = { start: vi.fn(), dispose: vi.fn(async () => undefined) }; controls.push(c); return c })
  const load = vi.fn(() => ({ createWorkspaceStateStream: create }))
  const service = { model, list: model }, remote = { $stream() {} }
  return { service, remote, model, listeners, options, controls, create, load,
    install: (version = '0.2.2-rc.1') => installWorkspaceRecovery(service, remote, version, load) }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
describe('terminal Workspace follow recovery', () => {
  it('replaces the terminal baseline using the official factory and continues all increment kinds', async () => {
    vi.useFakeTimers(); const f = fixture(), stop = f.install()
    await vi.runOnlyPendingTimersAsync()
    expect(f.create).toHaveBeenCalledTimes(1); expect(f.controls[0]!.start).toHaveBeenCalledTimes(1)
    const a = f.options[0]!.accept
    a.replaceBaseline({ items: [{ sessionIds: ['clone'] }] }); a.upsertView({}); a.removeView('id'); a.replaceOrder([]); a.replaceArchived([]); a.replacePinned([])
    expect(f.model.getSnapshot()).toEqual({ state: 'idle', error: null })
    expect(f.model.replaceBaseline).toHaveBeenCalledTimes(1); expect(f.model.upsertView).toHaveBeenCalledTimes(1)
    expect(f.model.removeView).toHaveBeenCalledWith('id'); expect(f.model.replacePinned).toHaveBeenCalledWith([])
    stop(); await Promise.resolve(); expect(f.controls[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(f.listeners.size).toBe(0); expect(f.model.getSnapshot().error).toBe(error)
    a.upsertView({ late: true }); f.options[0]!.failed(new Error('late'))
    expect(f.model.upsertView).toHaveBeenCalledTimes(1); expect(f.model.getSnapshot().error).toBe(error)
  })
  it('does not open a second consumer for healthy, permission, endpoint or below-floor models, and does open one on a later build', async () => {
    vi.useFakeTimers()
    for (const e of [null, { code: 'gateway/forbidden', details: { endpoint: 'workspace/follow' } }, { ...error, details: { endpoint: 'session/follow' } }]) {
      const f = fixture(e), stop = f.install(); await vi.runOnlyPendingTimersAsync(); expect(f.load).not.toHaveBeenCalled(); stop()
    }
    const off = fixture(), stopOff = off.install('0.2.1'); await vi.runOnlyPendingTimersAsync(); expect(off.load).not.toHaveBeenCalled(); stopOff()
    const f = fixture(), stop = f.install('0.2.2-rc.3'); await vi.runOnlyPendingTimersAsync(); expect(f.load).toHaveBeenCalledTimes(1); stop()
    const ahead = fixture(), stopAhead = ahead.install('0.3.1'); await vi.runOnlyPendingTimersAsync(); expect(ahead.load).toHaveBeenCalledTimes(1); stopAhead()
    expect(installWorkspaceRecovery({ model: {}, list: {} }, f.remote, '0.2.2-rc.1', f.load)).toBeTypeOf('function')
    expect(installWorkspaceRecovery({ model: {}, list: {} }, f.remote, '0.2.2-rc.3', f.load)).toBeTypeOf('function')
  })
  it('reacts to a later terminal error but coalesces duplicate owners and notifications', async () => {
    vi.useFakeTimers(); const f = fixture(null), stop = f.install(), duplicate = f.install()
    f.model.handleStreamFailure(error); f.model.handleStreamFailure(error)
    await vi.runOnlyPendingTimersAsync(); expect(f.create).toHaveBeenCalledTimes(1)
    duplicate(); expect(f.controls[0]!.dispose).not.toHaveBeenCalled(); stop()
  })
  it('bounds service-unavailable retries, disposes each ended stream, and stops for other errors', async () => {
    vi.useFakeTimers(); const f = fixture(), stop = f.install(); await vi.runOnlyPendingTimersAsync()
    for (let n = 0; n < 6; n++) { f.options.at(-1)!.failed(error); await vi.runOnlyPendingTimersAsync() }
    expect(f.create).toHaveBeenCalledTimes(6); expect(vi.getTimerCount()).toBe(0); stop()
    const g = fixture(), end = g.install(); await vi.runOnlyPendingTimersAsync()
    g.options[0]!.failed({ isDSHRemoteError: true, code: 'gateway/forbidden' }); await vi.runAllTimersAsync()
    expect(g.create).toHaveBeenCalledTimes(1); end()
  })
  it('cancels pending startup and allows a fresh owner after unload', async () => {
    vi.useFakeTimers(); const f = fixture(), stop = f.install(); stop(); await vi.runAllTimersAsync(); expect(f.create).not.toHaveBeenCalled()
    const end = f.install(); await vi.runOnlyPendingTimersAsync(); expect(f.create).toHaveBeenCalledTimes(1); end()
  })
  it('ignores late callbacks from an ended generation after retry', async () => {
    vi.useFakeTimers(); const f = fixture(), stop = f.install(); await vi.runOnlyPendingTimersAsync()
    const old = f.options[0]!; old.failed(error); await vi.runOnlyPendingTimersAsync()
    expect(f.create).toHaveBeenCalledTimes(2)
    f.options[1]!.accept.replaceBaseline({ current: true })
    old.accept.replaceBaseline({ stale: true }); old.failed(error); old.carrierFailed()
    expect(f.model.replaceBaseline).toHaveBeenCalledTimes(1)
    expect(f.model.handleCarrierFailure).not.toHaveBeenCalled(); expect(f.model.getSnapshot().state).toBe('idle'); stop()
  })
  it('preserves the original failure if the optional host export is missing', async () => {
    vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = fixture(); const stop = installWorkspaceRecovery(f.service, f.remote, '0.2.2-rc.1', () => ({}))
    await vi.runAllTimersAsync(); expect(f.model.getSnapshot().error).toBe(error); expect(vi.getTimerCount()).toBe(0); stop()
  })
})
