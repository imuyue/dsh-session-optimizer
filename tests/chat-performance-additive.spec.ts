import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import * as chatWindow from '../client/chat-window.ts'
import type { ChatPerformanceApplied, ChatPerformanceSnapshot, ChatPerformanceSource } from '../client/chat-performance.tsx'
import type { FlowEntry, FlowSlots } from '../client/chat-window.ts'

// This exercises the current installer and bounded DOM lookup without mounting a
// second React copy. Hooks/portals must remain dormant until DSH mounts the seat.
function loadInstaller() {
  const code = ts.transpileModule(readFileSync(new URL('../client/chat-performance.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2024, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const module = { exports: {} as typeof import('../client/chat-performance.tsx') }
  const unexpectedMount = () => { throw new Error('installer eagerly mounted React effects') }
  runInNewContext(code, {
    module, exports: module.exports, CSS: { supports: () => true },
    require(id: string) {
      if (id === './chat-window.ts') return chatWindow
      if (id === './history-preview.tsx') return { HistoryPreview: unexpectedMount }
      if (id === 'react-dom') return { createPortal: unexpectedMount }
      if (id === 'react/jsx-runtime') return { jsx: unexpectedMount, jsxs: unexpectedMount, Fragment: Symbol.for('react.fragment') }
      if (id === 'react') return { useEffect: unexpectedMount, useRef: unexpectedMount, useState: unexpectedMount, useSyncExternalStore: unexpectedMount }
      throw new Error(`unexpected installer dependency: ${id}`)
    },
  })
  return module.exports
}
const { installChatPerformance, findChatFlowHost } = loadInstaller()
const FLOW = 'conversation.chat.flow', DOCK = 'conversation.composer.dock'
function state(revision = 'cfg:1', enabled = true): ChatPerformanceSnapshot {
  return {
    status: 'ready', state: { revision, generation: 1,
      desired: { enabled, historyWindow: enabled, virtualChat: enabled },
      effective: { enabled, historyWindow: enabled, virtualChat: enabled } },
  }
}
function fixture(options: { flow?: { kind?: string; scope?: string }; dock?: { kind?: string; scope?: string }; failRegistration?: boolean } = {}) {
  let snapshot = state()
  const sourceListeners = new Set<() => void>(), flowListeners = new Set<() => void>()
  const official: FlowEntry = Object.freeze({
    component: () => undefined, options: Object.freeze({ priority: 0 }), registrant: 'tk', locale: 'chat',
    store: Object.freeze({ retained: true }), inject: () => undefined,
    children: Object.freeze({ 'conversation.chat.node': Object.freeze({ kind: 'keyed', scope: 'session' }) }),
  })
  let entries: readonly FlowEntry[] = [official]
  const remove = vi.fn(), injectionDisposed = vi.fn()
  const register = vi.fn((_options: Record<string, unknown>, _component: unknown) => {
    if (options.failRegistration) throw new Error('registration rejected by current Host')
    return remove
  })
  const inject = vi.fn((key: string, callback: () => unknown) => {
    expect(key).toBe(DOCK)
    const cleanup = callback()
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true; injectionDisposed()
      if (typeof cleanup === 'function') cleanup()
    }
  })
  const slots: FlowSlots = {
    spec: key => key === FLOW ? options.flow ?? { kind: 'single', scope: 'session' } : key === DOCK ? options.dock ?? { kind: 'list', scope: 'session' } : undefined,
    entries: key => key === FLOW ? entries : [], entriesOfSlot: key => key === FLOW ? entries : [], inject, register,
    subscribe: (key, fn) => { expect(key).toBe(FLOW); flowListeners.add(fn); return () => { flowListeners.delete(fn) } },
  }
  const source: ChatPerformanceSource = {
    getSnapshot: () => snapshot,
    subscribe: fn => { sourceListeners.add(fn); return () => { sourceListeners.delete(fn) } },
  }
  const reports: ChatPerformanceApplied[] = [], contextCleanups: Array<() => void> = []
  const dispose = installChatPerformance({ slots, effect: callback => { const cleanup = callback(); if (cleanup) contextCleanups.push(cleanup) } }, source,
    { onEffectiveChange: report => { reports.push(report) } })
  return {
    official, register, inject, remove, injectionDisposed, reports, dispose, contextCleanups, sourceListeners, flowListeners,
    entries: () => entries,
    update: (next: ChatPerformanceSnapshot) => { snapshot = next; for (const fn of [...sourceListeners]) fn() },
    replaceOfficial: () => { entries = []; for (const fn of [...flowListeners]) fn() },
  }
}

describe('additive performance installer', () => {
  it('registers only the composer effect seat, without copying or occupying official Flow declarations', () => {
    const f = fixture()
    expect(f.inject).toHaveBeenCalledOnce()
    expect(f.register).toHaveBeenCalledOnce()
    const [options, component] = f.register.mock.calls[0]!
    expect(options).toEqual({ name: DOCK, id: 'dso-phase-one-effects', order: 100 })
    expect(typeof component).toBe('function')
    expect(options).not.toHaveProperty('children')
    expect(options).not.toHaveProperty('inject')
    expect(options).not.toHaveProperty('store')
    expect(f.entries()).toEqual([f.official])
    expect(f.reports.at(-1)).toMatchObject({ registered: true, historyPreview: true, virtualChat: false, phase: 'loading-preview' })
    f.dispose()
  })

  it('disables and disposes only its effect seat while leaving the official entry intact', () => {
    const f = fixture()
    f.update(state('cfg:2', false))
    expect(f.remove).toHaveBeenCalledOnce()
    expect(f.injectionDisposed).toHaveBeenCalledOnce()
    expect(f.entries()[0]).toBe(f.official)
    expect(f.reports.at(-1)).toMatchObject({ registered: false, historyPreview: false, virtualChat: false, phase: 'official' })
    f.update(state('cfg:3'))
    expect(f.register).toHaveBeenCalledTimes(2)
    f.dispose(); f.dispose(); f.contextCleanups[0]!()
    expect(f.remove).toHaveBeenCalledTimes(2)
    expect(f.sourceListeners.size).toBe(0)
    expect(f.flowListeners.size).toBe(0)
    expect(f.entries()[0]).toBe(f.official)
  })

  it.each([
    { flow: { kind: 'single', scope: 'global' } },
    { flow: { kind: 'list', scope: 'session' } },
    { dock: { kind: 'list', scope: 'global' } },
    { dock: { kind: 'single', scope: 'session' } },
    { dock: { kind: 'list' } },
  ])('declines incompatible/unknown flow and dock scope %#', options => {
    const f = fixture(options)
    expect(f.inject).not.toHaveBeenCalled()
    expect(f.register).not.toHaveBeenCalled()
    expect(f.entries()[0]).toBe(f.official)
    expect(f.reports.at(-1)).toMatchObject({ registered: false, reason: 'unsupported-official-flow' })
    f.dispose()
  })

  it('does not loop registration failures at the same configuration revision and retries a new revision once', () => {
    const f = fixture({ failRegistration: true })
    for (let i = 0; i < 1000; i++) f.update(state())
    expect(f.register).toHaveBeenCalledOnce()
    expect(f.reports.at(-1)?.reason).toContain('registration-failed')
    f.update(state('cfg:2'))
    expect(f.register).toHaveBeenCalledTimes(2)
    f.dispose()
  })

  it('removes the preview seat when only initial-history remains enabled', () => {
    const f = fixture()
    const next = state('cfg:2')
    f.update({ ...next, state: { ...next.state!, desired: { enabled: true, historyWindow: false, virtualChat: true }, effective: { enabled: true, historyWindow: false, virtualChat: true } } })
    expect(f.remove).toHaveBeenCalledOnce()
    expect(f.register).toHaveBeenCalledOnce()
    expect(f.reports.at(-1)).toMatchObject({ registered: false, historyPreview: false, virtualChat: false })
    f.update(state('cfg:3'))
    expect(f.register).toHaveBeenCalledTimes(2)
    f.dispose()
  })

  it('removes the effect if the compatible official Flow disappears', () => {
    const f = fixture()
    f.replaceOfficial()
    expect(f.remove).toHaveBeenCalledOnce()
    expect(f.reports.at(-1)).toMatchObject({ registered: false, reason: 'official-flow-changed' })
    f.dispose()
  })
})

interface FakeElement { parentElement: FakeElement | null; querySelectorAll: ReturnType<typeof vi.fn> }
function element(parent: FakeElement | null, matches: Element[] = []): FakeElement {
  return { parentElement: parent, querySelectorAll: vi.fn((selector: string) => {
    expect(selector).toBe('[data-slot="conversation.chat.flow"]')
    return matches
  }) }
}
const asElement = (node: FakeElement): Element => node as unknown as Element

describe('bounded same-conversation flow lookup', () => {
  it('selects the nearest unique Flow rather than a farther session ancestor', () => {
    const localFlow = {} as Element, outerFlow = {} as Element
    const outer = element(null, [outerFlow]), local = element(outer, [localFlow]), marker = element(local)
    expect(findChatFlowHost(asElement(marker))).toBe(localFlow)
    expect(outer.querySelectorAll).not.toHaveBeenCalled()
  })

  it('declines ambiguity at the nearest matching ancestor instead of guessing another conversation', () => {
    const outer = element(null, [{} as Element]), ambiguous = element(outer, [{} as Element, {} as Element]), marker = element(ambiguous)
    expect(findChatFlowHost(asElement(marker))).toBeUndefined()
    expect(outer.querySelectorAll).not.toHaveBeenCalled()
  })

  it('visits at most sixteen ancestors and declines a Flow beyond that bound', () => {
    const far = element(null, [{} as Element])
    const ancestors = [far]
    let parent = far
    for (let i = 0; i < 16; i++) { parent = element(parent); ancestors.push(parent) }
    expect(findChatFlowHost(asElement(element(parent)))).toBeUndefined()
    expect(far.querySelectorAll).not.toHaveBeenCalled()
    expect(ancestors.reduce((sum, node) => sum + node.querySelectorAll.mock.calls.length, 0)).toBe(16)
  })

  it('accepts a unique match at the sixteenth ancestor and handles detached markers', () => {
    const target = {} as Element, last = element(null, [target])
    let parent = last
    for (let i = 0; i < 15; i++) parent = element(parent)
    expect(findChatFlowHost(asElement(element(parent)))).toBe(target)
    expect(findChatFlowHost(asElement(element(null)))).toBeUndefined()
  })
})
