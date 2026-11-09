/**
 * Local stand-ins for the packages the DSH Web GUI host provides at runtime.
 *
 * The client bundle is bundled offline (no `@types/react` is available on the
 * build machine), so the declarations here are deliberately loose: they let
 * `tsc` check this plugin's own code (typos, unused names, wrong arity) without
 * pretending to reproduce React's or the primitives' real types. The runtime
 * types come from the host's module table, not from these files.
 *
 * @module dsh-session-optimizer/client/ambient
 */

declare module 'react' {
  export type ReactNode = any
  export type CSSProperties = Record<string, string | number | undefined>
  export type ChangeEvent<T> = { target: T; currentTarget: T }
  export type MouseEvent<T> = { currentTarget: T; preventDefault(): void; stopPropagation(): void }

  export function useState<S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void]
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useLayoutEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T
  export function useCallback<T>(callback: T, deps: readonly unknown[]): T
  export function useRef<T>(initial: T): { current: T }
  export function createElement(type: unknown, props?: unknown, ...children: unknown[]): ReactNode
  export const Fragment: (props: { children?: ReactNode }) => ReactNode
}

declare module 'react/jsx-runtime' {
  export namespace JSX {
    type Element = any
    interface ElementChildrenAttribute { children: object }
    /** `key` is a JSX attribute, not a prop of the component it labels. */
    interface IntrinsicAttributes { key?: string | number }
    interface IntrinsicElements { [name: string]: any }
  }
  export function jsx(type: unknown, props: unknown, key?: unknown): JSX.Element
  export function jsxs(type: unknown, props: unknown, key?: unknown): JSX.Element
  export function Fragment(props: { children?: unknown }): JSX.Element
}

declare module '@tanstack/react-virtual' {
  /** Visible slice of the virtual list; `count` is the full item count. */
  export interface Range { startIndex: number; endIndex: number; count: number; overscan: number }
  export interface VirtualItem { index: number; key: string | number; start: number; end: number; size: number; lane: number }
  /** Only the surface this plugin uses is declared; the host supplies the real module. */
  export function useVirtualizer<TScroll extends Element, TItem extends Element>(options: {
    count: number
    getScrollElement: () => TScroll | null
    estimateSize: (index: number) => number
    getItemKey?: (index: number) => string | number
    overscan?: number
    paddingStart?: number
    paddingEnd?: number
    initialRect?: { width: number; height: number }
    enabled?: boolean
    rangeExtractor?: (range: Range) => number[]
    measureElement?: (element: TItem | null) => number
  }): {
    getVirtualItems(): VirtualItem[]
    getTotalSize(): number
    scrollToIndex(index: number, options?: { align?: 'start' | 'center' | 'end' | 'auto' }): void
    scrollToOffset(offset: number, options?: { align?: 'start' | 'center' | 'end' | 'auto' }): void
    scrollToEnd(options?: { align?: 'start' | 'center' | 'end' | 'auto' }): void
    scrollRect: { width: number; height: number } | null
    scrollOffset: number | null
    measure(): void
  }
  export function defaultRangeExtractor(range: Range): number[]
}

declare module '@deepseek-ai/dsh-client-ui-primitives' {  export const Button: any
  export const SegmentedTabs: any
  export const Tag: any
  export const StateDot: any
  export const Input: any
  export const Switch: any
  export const IconDatabaseOutlineRegular: any
  export function fileSizeText(bytes: number): string
  export function relativeTime(at: number, now: number): { unit: string; n: number }
}
