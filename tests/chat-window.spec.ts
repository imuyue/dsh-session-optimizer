import { describe, expect, it } from 'vitest'
import {
  acceptHistoryPreview,
  chatPerformanceGate,
  compatibleOfficialFlow,
  createFlowOverride,
  createChatPaintSchedule,
  flowOverrideOptions,
  CHAT_PAINT_LIMIT,
  buildChatPaintCss,
} from '../client/chat-window.ts'
import type { ChatAdapterStatus, FlowEntry, FlowSlots } from '../client/chat-window.ts'

function officialEntry(): FlowEntry {
  return {
    component: { $$typeof: Symbol.for('react.memo'), type: function OfficialFlow() {} },
    options: { priority: 0 }, registrant: 'tk', locale: 'chat',
    store: { create() {} }, inject: () => ({ hooks: {} }),
    children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session', inject: {} } },
  }
}

/** Models only public registry signatures, not a browser or the production Slot renderer. */
class Registry implements FlowSlots {
  original = officialEntry()
  rows: FlowEntry[] = [this.original]
  listeners = new Set<() => void>()
  registrations = 0
  removals = 0
  injections = 0
  kind = 'single'
  registerThrows = false
  spec() { return { kind: this.kind, scope: 'session' } }
  entries() { return this.rows }
  entriesOfSlot() { return [...this.rows].sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0)).slice(0, 1) }
  subscribe(_key: string, callback: () => void) { this.listeners.add(callback); return () => { this.listeners.delete(callback) } }
  inject(_key: string, callback: () => unknown) {
    this.injections++
    const cleanup = callback()
    let active = true
    return () => { if (!active) return; active = false; this.injections--; if (typeof cleanup === 'function') cleanup() }
  }
  register(options: Record<string, unknown>, component: unknown) {
    if (this.registerThrows) throw new Error('fixture failure')
    if (options.children !== undefined) throw new Error('slot "conversation.chat.node" is already declared')
    this.registrations++
    const row: FlowEntry = { component, options, registrant: options.registrant as string }
    this.rows.push(row)
    let active = true
    return () => { if (!active) return; active = false; this.removals++; this.rows = this.rows.filter(e => e !== row) }
  }
  flush() { for (const listener of [...this.listeners]) listener() }
}

describe('phase-one official flow compatibility', () => {
  it('keeps official metadata references, not a guessed replacement kit', () => {
    const official = officialEntry()
    expect(compatibleOfficialFlow([official])).toBe(official)
    const options = flowOverrideOptions(official)
    expect(options.store).toBe(official.store)
    expect(options.inject).toBe(official.inject)
    expect(options.children).toBeUndefined()
    expect(official.children?.['conversation.chat.node']).toEqual(expect.objectContaining({ kind: 'keyed', scope: 'session' }))
    expect(options.locale).toBe('chat')
    expect(options.priority).toBe(-1)
    expect(official.options.priority).toBe(0)
  })

  it('declines unknown providers, metadata, child scope and competing registrations', () => {
    const original = officialEntry()
    for (const change of [
      { registrant: 'another-provider' }, { locale: 'other' }, { store: undefined },
      { inject: undefined }, { component: {} }, { options: { priority: 1 } },
      { children: { 'conversation.chat.node': { kind: 'single', scope: 'session' } } },
    ]) expect(compatibleOfficialFlow([{ ...original, ...change }])).toBeUndefined()
    expect(compatibleOfficialFlow([])).toBeUndefined()
    expect(compatibleOfficialFlow([original, originalEntryCopy()])).toBeUndefined()
  })
})
function originalEntryCopy() { return officialEntry() }

describe('reversible owned registration', () => {
  it('enables idempotently and releases only its own registration on disable/dispose', () => {
    const registry = new Registry(), reports: ChatAdapterStatus[] = []
    const wrapped = function PerformanceFlow() {}
    const control = createFlowOverride(registry, entry => {
      expect(entry).toBe(registry.original); return wrapped
    }, s => reports.push(s))
    expect(registry.rows).toEqual([registry.original])
    control.enable(); control.enable()
    expect(registry.registrations).toBe(1)
    expect(registry.entriesOfSlot()[0]?.component).toBe(wrapped)
    control.disable(); control.disable()
    expect(registry.rows).toEqual([registry.original])
    expect(registry.listeners.size).toBe(0)
    expect(registry.injections).toBe(0)
    expect(registry.removals).toBe(1)
    control.enable(); control.dispose(); control.dispose(); control.enable()
    expect(registry.rows).toEqual([registry.original])
    expect(registry.registrations).toBe(2)
    expect(registry.removals).toBe(2)
    expect(reports.at(-1)?.effective).toBe(false)
  })

  it('keeps official unchanged for incompatible declarations and register exceptions', () => {
    for (const failure of ['kind', 'register'] as const) {
      const registry = new Registry(), reports: ChatAdapterStatus[] = []
      if (failure === 'kind') registry.kind = 'keyed'
      else registry.registerThrows = true
      const control = createFlowOverride(registry, () => function Wrapped() {}, x => reports.push(x))
      control.enable()
      expect(registry.rows).toEqual([registry.original])
      expect(reports.at(-1)?.effective).toBe(false)
      control.dispose()
      expect(registry.injections).toBe(0)
      expect(registry.listeners.size).toBe(0)
    }
  })

  it('releases the alternative if the official provider changes or a competitor arrives', () => {
    const registry = new Registry()
    const control = createFlowOverride(registry, () => function Wrapped() {}, () => {})
    control.enable()
    const competitor = { ...officialEntry(), registrant: 'new-provider', options: { priority: 3 } }
    registry.rows.push(competitor)
    registry.flush()
    expect(registry.rows).toEqual([registry.original, competitor])
    expect(registry.listeners.size).toBe(0)
    control.dispose()
    expect(registry.rows).toContain(registry.original)
  })

  it('does not accumulate listeners or replacement entries across repeated switches', () => {
    const registry = new Registry()
    const control = createFlowOverride(registry, () => function Wrapped() {}, () => {})
    for (let i = 0; i < 100; i++) { control.enable(); registry.flush(); control.disable() }
    expect(registry.rows).toEqual([registry.original])
    expect(registry.listeners.size).toBe(0)
    expect(registry.injections).toBe(0)
    expect(registry.registrations).toBe(registry.removals)
    control.dispose()
  })
})

describe('Host and immediate local close qualification', () => {
  const flags = { enabled: true, historyWindow: true, virtualChat: true }
  const state = { desired: flags, effective: flags }
  const off = { historyPreview: false, virtualChat: false }
  it('requires ready, desired and effective and rejects missing snapshots', () => {
    expect(chatPerformanceGate({ status: 'ready', state })).toEqual({ historyPreview: true, virtualChat: true })
    expect(chatPerformanceGate({ status: 'loading', state })).toEqual(off)
    expect(chatPerformanceGate({ status: 'ready', state: null })).toEqual(off)
    expect(chatPerformanceGate({ status: 'ready', state: { desired: flags } })).toEqual(off)
    expect(chatPerformanceGate({ status: 'ready', localSuppressed: true, state })).toEqual(off)
    expect(chatPerformanceGate({ status: 'ready', state: { ...state, effective: { ...flags, enabled: false } } })).toEqual(off)
  })
  it('keeps independent toggles and never turns desired into effective', () => {
    expect(chatPerformanceGate({ status: 'ready', state: { desired: flags, effective: { ...flags, historyWindow: false } } }))
      .toEqual({ historyPreview: false, virtualChat: true })
    expect(chatPerformanceGate({ status: 'ready', state: { desired: { ...flags, virtualChat: false }, effective: flags } }))
      .toEqual({ historyPreview: true, virtualChat: false })
  })
})

describe('layout measurement scheduling', () => {
  it('coalesces bursts, waits two frames and fences late callbacks after dispose', () => {
    let nextId = 0, measures = 0
    const pending = new Map<number, () => void>(), cancelled: number[] = []
    const queue = createChatPaintSchedule(callback => { const id = nextId++; pending.set(id, callback); return id }, id => { cancelled.push(id); pending.delete(id) }, () => { measures++ })
    const run = () => { const [id, callback] = [...pending.entries()][0]!; pending.delete(id); callback(); return callback }
    queue.schedule(); queue.schedule()
    expect(pending.size).toBe(1)
    run(); expect(measures).toBe(0)
    queue.schedule(); expect(pending.size).toBe(1)
    run(); expect(measures).toBe(1)
    queue.schedule(); run()
    const late = [...pending.values()][0]!
    queue.dispose(); queue.dispose(); queue.schedule(); late()
    expect(pending.size).toBe(0)
    expect(cancelled).toHaveLength(1)
    expect(measures).toBe(1)
  })
})

describe('bounded read-only preview response', () => {
  const preview = {
    available: true, sessionId: 'session', from: 100, to: 110, total: 110,
    revision: 7, configurationRevision: 'config-opaque', generation: 3,
    messages: [{ seq: 101, role: 'user', text: '<script>plain text</script>' }, { seq: 105, role: 'assistant', text: 'hello' }],
  }
  const accept = (value: unknown) => acceptHistoryPreview(value, 'session', 'config-opaque', 3)
  it('preserves bounded text and different DB/config revisions', () => {
    expect(accept(preview)).toBe(preview)
    expect(accept({ ...preview, messages: [] })).toBeDefined()
  })
  it('declines stale generations/revisions, duplicate seq and boundary violations', () => {
    for (const patch of [
      { configurationRevision: 'old' }, { generation: 2 }, { sessionId: 'other' },
      { revision: Number.NaN }, { available: false }, { from: -1 }, { to: 111 },
      { messages: [{ seq: 99, role: 'user', text: 'x' }] },
      { messages: [{ seq: 110, role: 'user', text: 'x' }] },
      { messages: [preview.messages[0], preview.messages[0]] },
      { messages: [{ seq: 101, role: 'system', text: 'x' }] },
      { messages: [{ seq: 101, role: 'user', text: 'x'.repeat(2001) }] },
    ]) expect(accept({ ...preview, ...patch })).toBeUndefined()
    expect(accept({ ...preview, from: 0, to: 100, total: 100, messages: Array.from({ length: 21 }, (_, seq) => ({ seq, role: 'user', text: 'x' })) })).toBeUndefined()
  })
  it('keeps full DOM and uses bounded real measured sizes with scoped CSS escaping', () => {
    const css = buildChatPaintCss('dso-cv-1', Array.from({ length: 500 }, (_, i) => ({ key: `row-${i}`, blockSize: 120.25 })))
    expect((css.match(/content-visibility:auto/g) ?? []).length).toBe(CHAT_PAINT_LIMIT)
    expect(css).toContain(':has(>style[data-dso-chat-performance="dso-cv-1"])')
    expect(css).toContain('contain-intrinsic-block-size:auto 120.250px')
    expect(css).toContain(':not(:nth-last-child(-n+12))')
    expect(css).not.toContain('display:none')
    expect(buildChatPaintCss('arbitrary-marker', [{ key: 'k', blockSize: 2 }])).toBe('')
    expect(buildChatPaintCss('dso-cv-2', [{ key: 'k', blockSize: 0 }, { key: 'k', blockSize: NaN }])).toBe('')
    const escaped = buildChatPaintCss('dso-cv-2', [{ key: 'quote"\\line\n]', blockSize: 10 }])
    expect(escaped.split('\n')).toHaveLength(1)
    expect(escaped).toContain('quote\\"\\\\line\\a ]')
    expect(buildChatPaintCss('dso-cv-2', [{ key: 'k', blockSize: 10 }, { key: 'k', blockSize: 20 }]).match(/content-visibility:auto/g)).toHaveLength(1)
  })
})
