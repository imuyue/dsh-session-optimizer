import { expect, it, vi } from 'vitest'
import { refreshMigratedTitles } from '../client/migration-titles.ts'
import type { MigrationReport } from '../client/types.ts'
const report = (ids: string[]) => ({ status: 'completed', items: ids.map(id => ({ status: 'migrated', targetSession: id })) }) as MigrationReport
it('loads official title projections only for unique successfully converted targets', async () => {
  const refreshProjections = vi.fn(async () => {})
  const value = report(['copy', 'child-copy', 'copy'])
  value.items.push({ status: 'failed', sourceSession: 'source', targetSession: 'failed', expected: 0, transferred: 0 })
  value.items.push({ status: 'skipped', sourceSession: 'already', targetSession: 'already', expected: 0, transferred: 0 }, { status: 'skipped', sourceSession: 'bad', targetSession: 'bad', expected: 0, transferred: 0, error: 'unreadable' })
  await refreshMigratedTitles({ refreshProjections }, value, new AbortController().signal)
  expect(refreshProjections.mock.calls.map(call => call[0])).toEqual(['copy', 'child-copy', 'already'])
})
it('bounds cold projection reads to two and suppresses remaining work after unload', async () => {
  let running = 0, maximum = 0
  const refreshProjections = vi.fn(async () => { maximum = Math.max(maximum, ++running); await Promise.resolve(); running-- })
  await refreshMigratedTitles({ refreshProjections }, report(Array.from({ length: 12 }, (_, i) => String(i))), new AbortController().signal)
  expect(maximum).toBe(2); expect(refreshProjections).toHaveBeenCalledTimes(12)
  const abort = new AbortController()
  const stopped = vi.fn(async () => { abort.abort() })
  await refreshMigratedTitles({ refreshProjections: stopped }, report(['a', 'b', 'c']), abort.signal)
  expect(stopped).toHaveBeenCalledTimes(1)
})
it('does not read projections for unfinished conversions or a missing optional service', async () => {
  const refreshProjections = vi.fn(async () => {})
  await refreshMigratedTitles({ refreshProjections }, { ...report(['copy']), status: 'running' }, new AbortController().signal)
  await refreshMigratedTitles({}, report(['copy']), new AbortController().signal)
  expect(refreshProjections).not.toHaveBeenCalled()
})
