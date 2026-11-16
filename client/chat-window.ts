/** No optimistic enable; missing qualification or a local close always wins. */
export function chatPerformanceGate(snapshot: {
  readonly status: string
  readonly localSuppressed?: boolean
  readonly state?: null | {
    readonly desired?: { readonly enabled?: boolean; readonly historyWindow?: boolean; readonly virtualChat?: boolean }
    readonly effective?: { readonly enabled?: boolean; readonly historyWindow?: boolean; readonly virtualChat?: boolean }
  }
}) {
  const s = snapshot.state
  const ready = snapshot.status === 'ready' && !snapshot.localSuppressed
    && s?.desired?.enabled === true && s.effective?.enabled === true
  return {
    historyPreview: !!(ready && s?.desired?.historyWindow === true && s.effective?.historyWindow === true),
    virtualChat: !!(ready && s?.desired?.virtualChat === true && s.effective?.virtualChat === true),
  }
}

/** Pure compatibility and lifecycle helpers for the phase-one chat adapter. */
export const CHAT_FLOW_SLOT = 'conversation.chat.flow'
export const CHAT_PERFORMANCE_REGISTRANT = 'dsh-session-optimizer:chat-performance'

export interface FlowEntry {
  readonly component: unknown
  readonly options: { readonly priority?: number; readonly [key: string]: unknown }
  readonly registrant?: string
  readonly locale?: string
  readonly store?: unknown
  readonly inject?: unknown
  readonly children?: Readonly<Record<string, { readonly kind?: string; readonly scope?: string; readonly [key: string]: unknown }>>
}

export interface FlowSlots {
  spec(key: string): { kind?: string; scope?: string } | undefined
  entries(key: string): readonly FlowEntry[]
  entriesOfSlot(key: string): readonly FlowEntry[]
  subscribe(key: string, fn: () => void): () => void
  inject(key: string, fn: () => unknown): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

export type ChatAdapterStatus = {
  readonly effective: boolean
  readonly phase: 'official' | 'content-visibility'
  readonly reason: string
}

function isComponent(value: unknown): boolean {
  if (typeof value === 'function') return true
  if (!value || typeof value !== 'object') return false
  const tag = (value as { $$typeof?: unknown }).$$typeof
  return tag === Symbol.for('react.memo') || tag === Symbol.for('react.forward_ref')
}

/** Fail closed on other versions/providers rather than capture an arbitrary competitor. */
export function compatibleOfficialFlow(entries: readonly FlowEntry[]): FlowEntry | undefined {
  if (entries.length !== 1) return undefined
  const entry = entries[0]!
  const node = entry.children?.['conversation.chat.node']
  if (entry.registrant !== 'tk' || (entry.options.priority ?? 0) !== 0
    || entry.locale !== 'chat' || !entry.store || typeof entry.inject !== 'function'
    || !isComponent(entry.component) || node?.kind !== 'keyed' || node.scope !== 'session') return undefined
  return entry
}

/** Preserve official injection, store, locale and child declarations, not just component. */
export function flowOverrideOptions(entry: FlowEntry): Record<string, unknown> {
  return {
    name: CHAT_FLOW_SLOT,
    ...entry.options,
    priority: -1,
    registrant: CHAT_PERFORMANCE_REGISTRANT,
    locale: entry.locale,
    store: entry.store,
    inject: entry.inject,
    // The official entry remains registered and owns its child Slot declarations.
    // Redeclaring them from an additional occupant is rejected by SlotCore.
  }
}

/**
 * An owned registration. Disabling releases our inject+registration, never the official one.
 * The public entries snapshot catches a competing provider/replaced official registration.
 */
export function createFlowOverride(
  slots: FlowSlots,
  makeComponent: (entry: FlowEntry) => unknown,
  report: (status: ChatAdapterStatus) => void,
): { enable(): void; disable(): void; dispose(): void } {
  let injection: (() => void) | undefined
  let activeCleanup: (() => void) | undefined
  let disposed = false
  let enabled = false
  const status = (effective: boolean, reason: string) => report({ effective, phase: effective ? 'content-visibility' : 'official', reason })
  const clearActive = () => { const cleanup = activeCleanup; activeCleanup = undefined; cleanup?.() }
  const disable = () => {
    enabled = false
    clearActive()
    const cleanup = injection; injection = undefined; cleanup?.()
    status(false, 'disabled')
  }
  return {
    enable() {
      if (disposed || enabled) return
      enabled = true
      try {
        injection = slots.inject(CHAT_FLOW_SLOT, () => {
          if (!enabled || disposed) return
          const spec = slots.spec(CHAT_FLOW_SLOT)
          const official = compatibleOfficialFlow(slots.entries(CHAT_FLOW_SLOT))
          if (spec?.kind !== 'single' || spec.scope !== 'session' || !official
            || slots.entriesOfSlot(CHAT_FLOW_SLOT)[0] !== official) {
            status(false, 'unsupported-official-flow'); return
          }
          let remove: (() => void) | undefined
          let unsubscribe: (() => void) | undefined
          let closed = false
          const cleanup = () => {
            if (closed) return
            closed = true
            unsubscribe?.(); unsubscribe = undefined
            remove?.(); remove = undefined
          }
          try {
            const component = makeComponent(official)
            remove = slots.register(flowOverrideOptions(official), component)
            if (typeof remove !== 'function') throw new Error('Slot registration has no disposer')
            unsubscribe = slots.subscribe(CHAT_FLOW_SLOT, () => {
              if (closed) return
              const entries = slots.entries(CHAT_FLOW_SLOT)
              const ours = entries.filter(e => e.component === component)
              if (!entries.includes(official) || ours.length !== 1
                || entries.some(e => e !== official && e.component !== component)
                || slots.entriesOfSlot(CHAT_FLOW_SLOT)[0]?.component !== component) {
                const reason = !entries.includes(official) ? 'official-flow-identity-changed'
                  : ours.length !== 1 ? 'override-entry-missing'
                    : entries.some(e => e !== official && e.component !== component) ? 'competing-flow-provider'
                      : 'override-not-selected'
                cleanup(); status(false, reason)
              }
            })
            activeCleanup = cleanup
            status(true, 'registered-phase-one')
            return cleanup
          } catch (error) {
            cleanup(); status(false, `registration-failed: ${String(error).slice(0, 240)}`); return
          }
        })
        if (typeof injection !== 'function') throw new Error('Slot injection has no disposer')
      } catch {
        clearActive(); injection = undefined; enabled = false
        status(false, 'unsupported-slot-lifecycle')
      }
    },
    disable,
    dispose() { if (disposed) return; disable(); disposed = true },
  }
}

export const CHAT_PAINT_LIMIT = 128
export interface ChatPaintMeasurement { readonly key: string; readonly blockSize: number }

/** Wait for committed layout and coalesce observer bursts; disposal fences late work. */
export function createChatPaintSchedule(
  request: (callback: () => void) => number,
  cancel: (id: number) => void,
  measure: () => void,
): { schedule(): void; dispose(): void } {
  let first: number | undefined, second: number | undefined, disposed = false
  return {
    schedule() {
      if (disposed || first !== undefined || second !== undefined) return
      first = request(() => {
        first = undefined
        if (disposed) return
        second = request(() => { second = undefined; if (!disposed) measure() })
      })
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (first !== undefined) cancel(first)
      if (second !== undefined) cancel(second)
      first = undefined; second = undefined
    },
  }
}

function cssString(value: string): string {
  return value.replace(/[\\"\x00-\x1f\x7f]/g, char => {
    if (char === '\\' || char === '"') return `\\${char}`
    return `\\${char.codePointAt(0)!.toString(16)} `
  })
}

/** Only known measured content-box heights; no zero/guessed size for unvisited rows. */
export function buildChatPaintCss(marker: string, measurements: readonly ChatPaintMeasurement[]): string {
  if (!/^dso-cv-\d+$/.test(marker)) return ''
  const prefix = `[data-slot="conversation.chat.flow"]:has(>style[data-dso-chat-performance="${marker}"])`
  const rules: string[] = []
  const keys = new Set<string>()
  for (const measurement of measurements.slice(0, CHAT_PAINT_LIMIT)) {
    if (!measurement.key || measurement.key.length > 2048 || keys.has(measurement.key)
      || !Number.isFinite(measurement.blockSize) || measurement.blockSize <= 0 || measurement.blockSize > 1_000_000) continue
    keys.add(measurement.key)
    rules.push(`${prefix}>[data-chat-flow-key="${cssString(measurement.key)}"]:not(:nth-last-child(-n+12)):not([data-chat-motion]):not(:focus-within):not(:hover){content-visibility:auto;contain-intrinsic-block-size:auto ${measurement.blockSize.toFixed(3)}px;}`)
  }
  return rules.join('\n')
}

/** Requests are UI-only, with a strict response bound before rendering untrusted text. */
export interface PreviewMessage { readonly seq: number; readonly role: 'user' | 'assistant'; readonly text: string }
export interface HistoryPreviewAnswer {
  readonly available: true
  readonly sessionId: string
  readonly from: number
  readonly to: number
  readonly total: number
  readonly revision: number
  readonly configurationRevision: string
  readonly generation: number
  readonly messages: readonly PreviewMessage[]
}

export function acceptHistoryPreview(value: unknown, sessionId: string, configurationRevision: string, generation: number): HistoryPreviewAnswer | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Partial<HistoryPreviewAnswer>
  if (v.available !== true || v.sessionId !== sessionId || v.configurationRevision !== configurationRevision || v.generation !== generation
    || !Number.isSafeInteger(v.revision) || v.revision! < 0
    || !Number.isSafeInteger(v.from) || !Number.isSafeInteger(v.to) || !Number.isSafeInteger(v.total)
    || v.from! < 0 || v.to! < v.from! || v.total! < v.to! || !Array.isArray(v.messages)
    || v.messages.length > 20) return undefined
  let bytes = 0, prior = -1
  for (const m of v.messages) {
    if (!m || !Number.isSafeInteger(m.seq) || m.seq < v.from! || m.seq >= v.to!
      || m.seq <= prior || (m.role !== 'user' && m.role !== 'assistant') || typeof m.text !== 'string' || m.text.length > 2000) return undefined
    bytes += m.text.length
    if (bytes > 40_000) return undefined
    prior = m.seq
  }
  return v as HistoryPreviewAnswer
}
