/** Exact React builtin used by the reversible performance adapter. */
declare module 'react' {
  export function useSyncExternalStore<T>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T,
  ): T
}

declare module 'react-dom' {
  export function createPortal(children: unknown, container: Element | DocumentFragment, key?: string | null): JSX.Element
}
