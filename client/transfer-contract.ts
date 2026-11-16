import type { SourceListing } from './types.ts'

export function sourceBadge(listing: Pick<SourceListing, 'backend'>): 'SQLite' | 'JSONL' {
  return listing.backend === 'sqlite' ? 'SQLite' : 'JSONL'
}
export function targetBackend(direction: 'jsonl_to_sqlite' | 'sqlite_to_jsonl'): 'sqlite' | 'jsonl' {
  return direction === 'jsonl_to_sqlite' ? 'sqlite' : 'jsonl'
}
/** Never show rows from the previous direction/root under the newly selected label. */
export function currentSourceListing(listing: SourceListing | undefined, backend: 'sqlite' | 'jsonl', root: string | undefined): SourceListing | undefined {
  return listing?.backend === backend && listing.root === root ? listing : undefined
}
