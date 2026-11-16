/** Process-local opt-in policy shared by independently loaded Host packages. */
export type PageTransferFormat = 'bytes' | 'lines'
export const MAX_PAGE_LINE_CODE_UNITS = 32 * 1024 * 1024
export const PAGE_TRANSFER_POLICY = Symbol.for('dsh.session-optimizer.page-transfer.v1')

interface PageTransferFace {
  readonly version: 1
  readonly enabled: () => boolean
}

/** String clones are bounded by UTF-16 code units, including line separators. */
export function pageLinesWithinBudget(lines: readonly string[]): boolean {
  let size = Math.max(0, lines.length - 1)
  for (const line of lines) {
    if (typeof line !== 'string') return false
    size += line.length
    if (size > MAX_PAGE_LINE_CODE_UNITS) return false
  }
  return size <= MAX_PAGE_LINE_CODE_UNITS
}

/**
 * Only the controller owner registers this face. Its callback reads current
 * effective settings; consumers never mutate preferences through the global.
 * Unload removes only this registration, so a stale disposer cannot remove a
 * newer registration. Duplicate owners fail instead of silently overriding it.
 */
export function registerPageTransferPolicy(enabled: () => boolean): () => void {
  if (typeof enabled !== 'function') throw new TypeError('page transfer policy requires a function')
  if (Object.hasOwn(globalThis, PAGE_TRANSFER_POLICY)) throw new Error('page transfer policy already registered')
  const face: PageTransferFace = Object.freeze({ version: 1, enabled })
  Object.defineProperty(globalThis, PAGE_TRANSFER_POLICY, { value: face, configurable: true, writable: false })
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    if (Reflect.get(globalThis, PAGE_TRANSFER_POLICY) === face) Reflect.deleteProperty(globalThis, PAGE_TRANSFER_POLICY)
  }
}

/** Query on each page. Missing, unloading or broken owners always use bytes. */
export function currentPageTransferFormat(): PageTransferFormat {
  try {
    const face: unknown = Reflect.get(globalThis, PAGE_TRANSFER_POLICY)
    if (typeof face !== 'object' || face === null) return 'bytes'
    const candidate = face as Partial<PageTransferFace>
    return candidate.version === 1 && typeof candidate.enabled === 'function' && candidate.enabled() === true ? 'lines' : 'bytes'
  } catch {
    return 'bytes'
  }
}
