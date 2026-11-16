// Match the official Connection/HMR carrier contract: Desktop supplies a Fetch
// implementation; a normal Web page uses the authenticated document origin.
export function nativePageFetch(): ((input: string, init?: RequestInit) => Promise<Response>) | undefined {
  const transport = (globalThis as unknown as { __DSH_TRANSPORT__?: { fetch?: unknown } }).__DSH_TRANSPORT__
  return typeof transport?.fetch === 'function'
    ? transport.fetch as (input: string, init?: RequestInit) => Promise<Response>
    : undefined
}
export function consoleFetch(path: string, init?: RequestInit): Promise<Response> {
  if (path.startsWith('/') || path.includes('..') || path.includes('#')) throw new Error('invalid console path')
  const relative = `api/session-optimizer/${path}`
  const native = nativePageFetch()
  // Dispatch exactly once: an unsuccessful write is never replayed on another carrier.
  return native === undefined
    ? fetch(new URL(relative, document.baseURI).href, init)
    : native(relative, init)
}
