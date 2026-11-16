import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { chatPerformanceGate, compatibleOfficialFlow } from './chat-window.ts'
import type { FlowSlots } from './chat-window.ts'
import { HistoryPreview } from './history-preview.tsx'

export interface ChatPerformanceState {
  readonly desired: { readonly enabled: boolean; readonly historyWindow: boolean; readonly virtualChat: boolean }
  readonly effective: { readonly enabled: boolean; readonly historyWindow: boolean; readonly virtualChat: boolean }
  readonly revision: string
  readonly generation: number
}
export interface ChatPerformanceSnapshot {
  readonly state: ChatPerformanceState | null
  readonly status: string
  readonly localSuppressed?: boolean
  readonly error?: unknown
}
export interface ChatPerformanceSource {
  getSnapshot(): ChatPerformanceSnapshot
  subscribe(callback: () => void): () => void
}
export interface ChatPerformanceContext {
  readonly slots: FlowSlots
  effect(callback: () => void | (() => void), label?: string): unknown
}
export interface ChatPerformanceApplied {
  readonly registered: boolean
  readonly historyPreview: boolean
  readonly virtualChat: boolean
  readonly phase: 'official' | 'loading-preview'
  readonly reason: string
}
export interface ChatPerformanceOptions { readonly onEffectiveChange?: (status: ChatPerformanceApplied) => void }
interface SessionSnapshot { readonly sessionId: string; readonly openState: string }
interface EffectsProps {
  readonly useSession: <T>(select: (snapshot: SessionSnapshot) => T) => T
}

/** Only attach to the unique flow in this composer's nearest conversation ancestor. */
export function findChatFlowHost(marker: Element): Element | undefined {
  let ancestor = marker.parentElement
  for (let depth = 0; ancestor && depth < 16; depth++, ancestor = ancestor.parentElement) {
    const flows = ancestor.querySelectorAll('[data-slot="conversation.chat.flow"]')
    if (flows.length > 1) return undefined
    if (flows.length === 1) return flows[0]
  }
  return undefined
}

/** Additive phase one. The official flow, its child authorization and DOM remain owned by DSH. */
export function installChatPerformance(ctx: ChatPerformanceContext, source: ChatPerformanceSource, options: ChatPerformanceOptions = {}): () => void {
  let disposed = false, registering = false, registered = false
  let release: (() => void) | undefined
  let failedRevision: string | undefined
  let reason = 'disabled'
  const report = () => {
    const gate = chatPerformanceGate(source.getSnapshot())
    try { options.onEffectiveChange?.({ registered, historyPreview: registered && gate.historyPreview,
      virtualChat: false,
      phase: registered && gate.historyPreview ? 'loading-preview' : 'official', reason }) } catch { /* diagnostic only */ }
  }
  function ChatEffects(props: EffectsProps) {
    const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
    const sessionId = props.useSession(s => s.sessionId)
    const openState = props.useSession(s => s.openState)
    const marker = useRef<HTMLSpanElement | null>(null)
    const [target, setTarget] = useState<Element | undefined>(undefined)
    const gate = chatPerformanceGate(snapshot)
    useEffect(() => {
      let alive = true, frame = 0, attempts = 0
      setTarget(undefined)
      const locate = () => {
        if (!alive) return
        const found = marker.current && findChatFlowHost(marker.current)
        if (found) { setTarget(found); return }
        if (++attempts < 60) frame = requestAnimationFrame(locate)
      }
      locate()
      return () => { alive = false; cancelAnimationFrame(frame) }
    }, [sessionId])
    return <>
      <span ref={marker} hidden data-dso-effects-seat="" />
      {target && snapshot.state && createPortal(<>
        <HistoryPreview enabled={gate.historyPreview} sessionId={sessionId} openState={openState}
          revision={snapshot.state.revision} generation={snapshot.state.generation} />
      </>, target)}
    </>
  }
  const clear = () => { const dispose = release; release = undefined; registered = false; dispose?.() }
  const reconcile = () => {
    if (disposed || registering) return
    const snapshot = source.getSnapshot(), gate = chatPerformanceGate(snapshot)
    if (!gate.historyPreview) { clear(); reason = 'disabled'; report(); return }
    if (failedRevision === snapshot.state?.revision) { report(); return }
    if (registered) { report(); return }
    const flow = ctx.slots.spec('conversation.chat.flow'), dock = ctx.slots.spec('conversation.composer.dock')
    if (flow?.kind !== 'single' || flow.scope !== 'session' || dock?.kind !== 'list' || dock.scope !== 'session'
      || !compatibleOfficialFlow(ctx.slots.entries('conversation.chat.flow'))) { reason = 'unsupported-official-flow'; report(); return }
    registering = true
    try {
      release = ctx.slots.inject('conversation.composer.dock', () => {
        const remove = ctx.slots.register({ name: 'conversation.composer.dock', id: 'dso-phase-one-effects', order: 100 }, ChatEffects)
        registered = true; reason = 'registered-additive-phase-one'; report()
        return () => { registered = false; remove() }
      })
    } catch (error) {
      clear(); failedRevision = snapshot.state?.revision; reason = `registration-failed: ${String(error).slice(0, 240)}`; report()
    } finally { registering = false }
  }
  const unsubscribe = source.subscribe(reconcile)
  const unwatch = ctx.slots.subscribe('conversation.chat.flow', () => {
    if (!compatibleOfficialFlow(ctx.slots.entries('conversation.chat.flow'))) { clear(); reason = 'official-flow-changed'; report() }
    else reconcile()
  })
  const dispose = () => { if (disposed) return; disposed = true; unsubscribe(); unwatch(); clear(); reason = 'disabled'; report() }
  ctx.effect(() => { reconcile(); return dispose }, 'dsh-session-optimizer: additive chat performance effects')
  return dispose
}
