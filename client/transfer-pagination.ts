import type { SourceListing } from './types.ts'

/** A listing and the request generation that owns it. */
export interface TransferPageState {
  generation: number
  listing: SourceListing | undefined
}

/** Start a fresh root, direction, search, or refresh. */
export function resetTransferPages(previous: TransferPageState): TransferPageState {
  return { generation: previous.generation + 1, listing: undefined }
}

/** The server's cursor advances even when overlapping ids were deduplicated. */
export function nextTransferOffset(state: TransferPageState): number | undefined {
  const page = state.listing
  if (page === undefined) return 0
  const next = page.offset + page.limit
  return page.limit > 0 && next < page.total ? next : undefined
}

export function replaceTransferPage(state: TransferPageState, generation: number, page: SourceListing): TransferPageState {
  if (generation !== state.generation) return state
  if (state.listing !== undefined && (page.backend !== state.listing.backend || page.root !== state.listing.root)) return state
  if (!Number.isSafeInteger(page.offset) || page.offset < 0 || !Number.isSafeInteger(page.limit) || page.limit < 1 || page.sessions.length > page.limit) return state
  return { generation, listing: page }
}

/** Accept only the current generation and the next page of the same root. */
export function appendTransferPage(
  state: TransferPageState,
  generation: number,
  page: SourceListing,
): TransferPageState {
  if (generation !== state.generation) return state
  const previous = state.listing
  if (previous !== undefined && (page.backend !== previous.backend || page.root !== previous.root)) return state
  if (page.offset !== 0 && page.offset !== nextTransferOffset(state)) return state
  const seen = new Set<string>()
  const sessions = [...(page.offset === 0 ? [] : previous?.sessions ?? []), ...page.sessions]
    .filter((session) => {
      if (seen.has(session.id)) return false
      seen.add(session.id)
      return true
    })
  return { generation, listing: { ...page, sessions } }
}
