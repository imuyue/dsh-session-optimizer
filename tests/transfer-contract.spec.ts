import { expect, it } from 'vitest'
import { currentSourceListing, sourceBadge, targetBackend } from '../client/transfer-contract.ts'
import { textOf } from '../client/i18n.ts'
import type { SourceListing } from '../client/types.ts'
it('labels the physical source separately from a matching copy in the destination', () => {
  const text = textOf('zh').transfer
  expect(text.currentFormat(sourceBadge({ backend: 'jsonl' }))).toBe('当前格式：JSONL')
  expect(text.alreadyIn('SQLite')).toBe('SQLite 库已有对应对话或副本')
  expect(text.currentFormat(sourceBadge({ backend: 'sqlite' }))).toBe('当前格式：SQLite')
  expect(targetBackend('sqlite_to_jsonl')).toBe('jsonl')
  expect(targetBackend('jsonl_to_sqlite')).toBe('sqlite')
})
it('never exposes the previous page when backend or root changes', () => {
  const page = { backend: 'jsonl', root: '/jsonl', sessions: [{ id: 'original' }] } as SourceListing
  expect(currentSourceListing(page, 'jsonl', '/jsonl')).toBe(page)
  expect(currentSourceListing(page, 'sqlite', '/jsonl')).toBeUndefined()
  expect(currentSourceListing(page, 'jsonl', '/other-jsonl')).toBeUndefined()
  expect(currentSourceListing(undefined, 'sqlite', '/sqlite')).toBeUndefined()
})
