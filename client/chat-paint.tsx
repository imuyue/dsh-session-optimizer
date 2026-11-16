import { useEffect, useRef, useState } from 'react'
import { buildChatPaintCss, CHAT_PAINT_LIMIT, createChatPaintSchedule } from './chat-window.ts'
import type { ChatPaintMeasurement } from './chat-window.ts'

let markerSerial = 0

/**
 * Phase one only: read our slot's own direct flow rows, then declare measured CSS.
 * No row/selection/scroll DOM is mutated, removed or moved. Initial render stays full.
 */
export function ChatPaintHints({ enabled, sessionId }: { enabled: boolean; sessionId: string }) {
  const markerRef = useRef<string | null>(null)
  if (markerRef.current === null) markerRef.current = `dso-cv-${++markerSerial}`
  const marker = markerRef.current
  const style = useRef<HTMLStyleElement | null>(null)
  const [css, setCss] = useState('')
  useEffect(() => {
    setCss('')
    const element = style.current
    const parent = element?.parentElement
    if (!enabled || !element || !parent || parent.getAttribute('data-slot') !== 'conversation.chat.flow'
      || typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined') return
    const view = parent.ownerDocument.defaultView
    if (!view) return
    let alive = true, previous = ''
    // SlotOutlet itself is display:contents and has no observable layout box.
    let widthElement: HTMLElement = parent
    for (let index = 0; index < 8 && widthElement.parentElement && widthElement.getBoundingClientRect().width === 0; index++) {
      widthElement = widthElement.parentElement
    }
    let width = widthElement.getBoundingClientRect().width
    let observed: Element[] = []
    const publish = (value: string) => {
      if (!alive || value === previous) return
      previous = value; setCss(value)
    }
    const selected = () => {
      const selection = parent.ownerDocument.getSelection()
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false
      try { return selection.getRangeAt(0).intersectsNode(parent) } catch { return true }
    }
    const rows = new ResizeObserver(() => schedule())
    const measure = () => {
      if (!alive) return
      try {
        if (selected() || parent.closest('[data-chat-motion]')) { publish(''); return }
        const hints: ChatPaintMeasurement[] = []
        const nextObserved: Element[] = []
        // Bounded scan and bounded observer set: neither follows all loaded history.
        const children = parent.children
        const start = Math.max(0, children.length - 13)
        const end = Math.max(0, start - 512)
        for (let index = start; index >= end && hints.length < CHAT_PAINT_LIMIT; index--) {
          const row = children.item(index)
          if (!(row instanceof view.HTMLElement) || row === element || row.hidden
            || row.hasAttribute('data-chat-motion') || row.hasAttribute('data-turn-process-member')
            || !['user', 'assistant', 'turn-trigger', 'assistant-step'].includes(row.getAttribute('data-chat-flow-kind') ?? '')
            || row.contains(parent.ownerDocument.activeElement)
            || row.querySelector('pre,table,img,video,canvas,iframe,dialog,[role="dialog"],[contenteditable="true"]')) continue
          const key = row.getAttribute('data-chat-flow-key')
          if (!key) continue
          const box = view.getComputedStyle(row)
          // Size containment is content-box; using border-box here would over-reserve.
          const padding = parseFloat(box.paddingTop) + parseFloat(box.paddingBottom)
            + parseFloat(box.borderTopWidth) + parseFloat(box.borderBottomWidth)
          const blockSize = row.getBoundingClientRect().height - padding
          if (!Number.isFinite(blockSize) || blockSize <= 0) continue
          hints.push({ key, blockSize }); nextObserved.push(row)
        }
        publish(buildChatPaintCss(marker, hints))
        if (nextObserved.length !== observed.length || nextObserved.some((row, index) => row !== observed[index])) {
          rows.disconnect(); observed = nextObserved
          for (const row of observed) rows.observe(row)
        }
      } catch {
        // Revert the optional CSS on an unexpected geometry/selection API failure.
        publish('')
      }
    }
    const deferred = createChatPaintSchedule(callback => view.requestAnimationFrame(callback), id => view.cancelAnimationFrame(id), measure)
    function schedule() { if (alive) deferred.schedule() }
    const invalidate = () => {
      publish(''); rows.disconnect(); observed = []; schedule()
    }
    const size = new ResizeObserver(() => {
      const next = widthElement.getBoundingClientRect().width
      if (Math.abs(next - width) > 0.5) { width = next; invalidate() }
    })
    size.observe(widthElement)
    const mutation = new MutationObserver(() => schedule())
    mutation.observe(parent, { childList: true })
    const selectionChanged = () => { if (selected()) publish(''); schedule() }
    parent.ownerDocument.addEventListener('selectionchange', selectionChanged)
    parent.ownerDocument.addEventListener('focusin', selectionChanged)
    parent.ownerDocument.addEventListener('focusout', selectionChanged)
    parent.ownerDocument.fonts?.addEventListener('loadingdone', invalidate)
    view.addEventListener('resize', invalidate)
    schedule()
    return () => {
      alive = false
      deferred.dispose()
      rows.disconnect(); size.disconnect(); mutation.disconnect(); observed = []
      parent.ownerDocument.removeEventListener('selectionchange', selectionChanged)
      parent.ownerDocument.removeEventListener('focusin', selectionChanged)
      parent.ownerDocument.removeEventListener('focusout', selectionChanged)
      parent.ownerDocument.fonts?.removeEventListener('loadingdone', invalidate)
      view.removeEventListener('resize', invalidate)
    }
  }, [enabled, sessionId, marker])
  return enabled ? <style ref={style} hidden data-dso-chat-performance={marker}>{css}</style> : null
}
