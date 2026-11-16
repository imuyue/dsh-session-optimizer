import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
const io = vi.hoisted(() => ({ beforeWrite: undefined as undefined | (() => Promise<void>) }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
    await io.beforeWrite?.()
    return actual.writeFile(...args)
  } }
})
import { MetricsRegistry } from '../src/metrics.ts'
import { attachMetricsJournal, detachMetricsJournal, LATENCY_JOURNAL_FILENAME } from '../src/metrics-journal.ts'
const roots: string[] = []
async function root() { const p = await mkdtemp(join(tmpdir(), 'latency-retained-')); roots.push(p); return p }
afterEach(async () => { await detachMetricsJournal(); vi.restoreAllMocks(); for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }) })
it('keeps real records across overnight idle, save and restart', async () => {
  const dir = await root(), clock = vi.spyOn(Date, 'now'), at = Date.now()
  clock.mockReturnValue(at)
  const first = new MetricsRegistry(); first.observe('open', 321, false)
  await attachMetricsJournal(first, dir)
  clock.mockReturnValue(at + 24 * 60 * 60_000)
  expect(first.snapshot().count).toBe(0) // rolling API remains a rolling window
  await detachMetricsJournal()
  const second = new MetricsRegistry()
  expect(await attachMetricsJournal(second, dir)).toBe(1)
  expect(second.exportSamples()).toEqual([{ op: 'open', at, ms: 321, ok: false }])
  expect(second.lastObservedAt).toBeUndefined()
})
it('retains exactly the newest 8192 records rather than dropping three quarters', () => {
  const registry = new MetricsRegistry()
  for (let i = 0; i < 8193; i++) registry.observe('read', i, true)
  const records = registry.exportSamples()
  expect(records).toHaveLength(8192)
  expect(records.map(row => row.ms).sort((a,b) => a-b)).toEqual(Array.from({length:8192}, (_,i) => i+1))
})
it('keeps chronological eviction after a wrapped ring is saved and restored with equal timestamps', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1794440000000)
  const first = new MetricsRegistry()
  for(let i=0;i<8193;i++) first.observe('read',i,true)
  const second = new MetricsRegistry(); second.restoreSamples(first.exportSamples())
  second.observe('read',8193,true)
  expect(second.exportSamples().map(row=>row.ms)).toEqual(Array.from({length:8192},(_,i)=>i+2))
})
it('serializes concurrent mounts so the newest registry inherits earlier measurements', async () => {
  const dir = await root(), first = new MetricsRegistry(), second = new MetricsRegistry()
  first.observe('read', 11, true); second.observe('append', 22, true)
  await Promise.all([attachMetricsJournal(first, dir), attachMetricsJournal(second, dir)])
  await detachMetricsJournal()
  const doc = JSON.parse(await readFile(join(dir, LATENCY_JOURNAL_FILENAME), 'utf8'))
  expect(doc.samples.map((x: { ms: number }) => x.ms).sort()).toEqual([11,22])
})
it('preserves an existing unsupported or damaged journal byte for byte', async () => {
  for (const original of ['not json at all', JSON.stringify({version:99,samples:[{op:'open',at:Date.now(),ms:71,ok:true}]})]) {
    const dir = await root(), path = join(dir, LATENCY_JOURNAL_FILENAME)
    await writeFile(path, original)
    const registry = new MetricsRegistry(); registry.observe('read', 8, true)
    await attachMetricsJournal(registry, dir); await detachMetricsJournal()
    expect(await readFile(path,'utf8')).toBe(original)
  }
})
it('retired owner cleanup does not stop the current journal', async () => {
  const dir = await root(), old = new MetricsRegistry(), current = new MetricsRegistry()
  old.observe('read', 11, true)
  await attachMetricsJournal(old, dir)
  await attachMetricsJournal(current, dir)
  await detachMetricsJournal(old)
  current.observe('append', 33, true)
  await detachMetricsJournal(current)
  const doc = JSON.parse(await readFile(join(dir, LATENCY_JOURNAL_FILENAME), 'utf8'))
  expect(doc.samples.map((row: { ms: number }) => row.ms).sort()).toEqual([11,33])
})
it('merges restore with recent calls and repeated reloads without duplicating or evicting newer calls', () => {
  const registry = new MetricsRegistry(), now = Date.now()
  registry.observe('read', 99999, true)
  const records = Array.from({length:8192}, (_,i) => ({op:'read',at:now-100_000+i,ms:i,ok:true}))
  registry.restoreSamples(records)
  registry.restoreSamples(registry.exportSamples())
  const rows = registry.exportSamples()
  expect(rows).toHaveLength(8192)
  expect(rows.some(row => row.ms === 99999)).toBe(true)
  expect(rows.some(row => row.ms === 0)).toBe(false)
})
it('shows idle history with accurate bounded buckets and percentiles', () => {
  const registry = new MetricsRegistry(), at = Date.now()
  registry.restoreSamples([{op:'open',at:at-86400_000,ms:9,ok:false},{op:'open',at:at-600_000,ms:3,ok:true}])
  const result = registry.historySnapshot(at)
  expect(result.count).toBe(2); expect(result.errors).toBe(1)
  expect(result.windowMs).toBeGreaterThanOrEqual(86400_000)
  const open = result.ops.find(row => row.op === 'open')!
  expect(open.buckets.length).toBeLessThanOrEqual(60)
  expect(open.buckets.reduce((sum,b) => sum+b.count,0)).toBe(2)
  expect(open.p50).toBe(3); expect(open.p95).toBe(9)
  expect(result.bucketMs).toBeGreaterThan(5000)
})
it('serializes a slow periodic save with final flush and includes calls made during I/O', async () => {
  const dir = await root(), registry = new MetricsRegistry()
  vi.useFakeTimers({toFake:['setInterval','clearInterval']})
  let release!: () => void, started!: () => void, calls = 0
  const gate = new Promise<void>(r => { release = r })
  const entered = new Promise<void>(r => { started = r })
  try {
    registry.observe('read', 1, true)
    await attachMetricsJournal(registry, dir)
    io.beforeWrite = async () => { calls++; if(calls === 1) { started(); await gate } }
    vi.advanceTimersByTime(15000)
    await entered
    vi.advanceTimersByTime(30000)
    registry.observe('append', 2, true)
    const closing = detachMetricsJournal(registry)
    await Promise.resolve(); await Promise.resolve()
    expect(calls).toBe(1)
    release(); await closing
    expect(calls).toBe(2)
    const doc = JSON.parse(await readFile(join(dir,LATENCY_JOURNAL_FILENAME),'utf8'))
    expect(doc.samples.map((row: {ms:number}) => row.ms)).toEqual([1,2])
  } finally { release(); io.beforeWrite = undefined; vi.useRealTimers() }
})
