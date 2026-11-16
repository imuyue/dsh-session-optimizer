/**
 * Real latency sampling for the operations the console reports on.
 *
 * Every number the GUI shows comes from an actual call this process made: the
 * registry is fed by the persistence layer and the handles themselves, never by
 * synthetic data. Samples live in bounded per-operation rings, so memory is flat
 * no matter how long the process runs, and an idle period simply leaves gaps in
 * the time series rather than inventing points.
 *
 * Ops are exactly the ones the design mockup lists: `read`, `append`, `flush`,
 * `open`, `list`, `stat`.
 *
 * @module dsh-session-optimizer/metrics
 */

/** Operations with a latency series. */
export const METRIC_OPS = ['read', 'append', 'flush', 'open', 'list', 'stat', 'search'] as const

/** One operation with a latency series. */
export type MetricOp = (typeof METRIC_OPS)[number]

/** Human labels, kept next to the ops so the console and the docs agree. */
export const METRIC_LABELS: Record<MetricOp, string> = {
  read: '读取 read',
  append: '追加 append',
  flush: '刷新 flush',
  open: '打开 open',
  list: '列举 list',
  stat: '元数据 stat',
  search: '检索 search',
}

/** One measured call. */
interface Sample {
  readonly at: number
  readonly ms: number
  readonly ok: boolean
}

/**
 * One sample as it is written to the state directory.
 *
 * The op is a string here, not `MetricOp`: a file written by a newer build (or
 * edited by hand) must be read back defensively rather than trusted because of a
 * cast.
 */
export interface LatencySampleRecord {
  readonly op: string
  readonly at: number
  readonly ms: number
  readonly ok: boolean
}

/**
 * Samples kept per op, independent of elapsed time.
 *
 * Each operation retains its newest 8192 real calls. The rolling snapshot and
 * retained-history view share those measurements without expiring the journal.
 */
const MAX_SAMPLES = 8192

/** Window the snapshot summarises. */
const WINDOW_MS = 5 * 60_000

/** Width of one point in the returned time series. */
const BUCKET_MS = 5_000

/** One point of a latency series. */
export interface MetricsBucket {
  /** Bucket start, epoch milliseconds. */
  readonly t: number
  readonly count: number
  readonly errors: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly max: number
}

/** Summary plus time series for one operation. */
export interface MetricsSeries {
  readonly op: MetricOp
  readonly label: string
  readonly count: number
  readonly errors: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly max: number
  readonly mean: number
  readonly buckets: readonly MetricsBucket[]
}

/** Everything the console needs for the latency tab. */
export interface MetricsSnapshot {
  /** When the registry started collecting, epoch milliseconds. */
  readonly since: number
  readonly now: number
  readonly windowMs: number
  readonly bucketMs: number
  /** Retention limit per op, so the console can say how much it keeps. */
  readonly retention: number
  /** Samples inside the window, summed over the ops. */
  readonly count: number
  /** Failures inside the window, summed over the ops. */
  readonly errors: number
  readonly ops: readonly MetricsSeries[]
}

/** Nearest-rank percentile over an ascending array; `0` for an empty one. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0
  const rank = Math.ceil(fraction * sorted.length)
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1))
  return sorted[index] ?? 0
}

/** Round to three decimals: sub-microsecond noise is not worth reporting. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * Bounded, in-process latency registry.
 *
 * `observe` is cheap (one push, one length check) because it sits on the hot
 * append path; the percentile work happens only when a snapshot is requested.
 */
export class MetricsRegistry {
  private readonly rings = new Map<MetricOp, Sample[]>()
  private readonly cursors = new Map<MetricOp, number>()
  private readonly since = Date.now()
  private totalCount = 0
  private totalErrors = 0
  private lastAt: number | undefined

  /** Record one finished call. A failure still counts, with `ok === false`. */
  observe(op: MetricOp, ms: number, ok: boolean): void {
    if (!Number.isFinite(ms) || ms < 0) return
    let ring = this.rings.get(op)
    if (ring === undefined) {
      ring = []
      this.rings.set(op, ring)
    }
    const at = Date.now()
    this.push(op, ring, { at, ms, ok })
    this.totalCount += 1
    this.lastAt = at
    if (!ok) this.totalErrors += 1
  }

  /** Circular overwrite keeps exactly the declared bound without hot-path shifts. */
  private push(op: MetricOp, ring: Sample[], sample: Sample): void {
    if (ring.length < MAX_SAMPLES) { ring.push(sample); return }
    const cursor = this.cursors.get(op) ?? 0
    ring[cursor] = sample
    this.cursors.set(op, (cursor + 1) % MAX_SAMPLES)
  }

  /** Time `body`, recording success or failure under `op`. */
  async time<T>(op: MetricOp, body: () => Promise<T>): Promise<T> {
    const started = performance.now()
    try {
      const value = await body()
      this.observe(op, performance.now() - started, true)
      return value
    } catch (error) {
      this.observe(op, performance.now() - started, false)
      throw error
    }
  }

  /** All retained samples, independent of the display window. */
  exportSamples(_now = Date.now()): LatencySampleRecord[] {
    const records: LatencySampleRecord[] = []
    for (const op of METRIC_OPS) {
      const ring = this.rings.get(op) ?? []
      const start = this.cursors.get(op) ?? 0
      for (let index = 0; index < ring.length; index += 1) {
        const sample = ring[(start + index) % ring.length]!
        records.push({ op, at: sample.at, ms: sample.ms, ok: sample.ok })
      }
    }
    records.sort((left, right) => left.at - right.at)
    return records
  }

  /** Merge validated journal records, retaining the newest bounded history. */
  restoreSamples(records: readonly LatencySampleRecord[], now = Date.now()): number {
    const existing = this.exportSamples()
    const key = (row: LatencySampleRecord): string => JSON.stringify([row.op, row.at, row.ms, row.ok])
    const counts = new Map<string, number>()
    for (const row of existing) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1)
    const added: LatencySampleRecord[] = []
    for (const record of records) {
      if (typeof record !== 'object' || record === null) continue
      if (!(METRIC_OPS as readonly string[]).includes(record.op)) continue
      if (!Number.isFinite(record.at) || !Number.isFinite(record.ms)) continue
      if (record.at < 0 || record.at > now + BUCKET_MS || record.ms < 0 || typeof record.ok !== 'boolean') continue
      const identity = key(record), copies = counts.get(identity) ?? 0
      if (copies > 0) { counts.set(identity, copies - 1); continue }
      added.push(record)
    }
    this.rings.clear()
    this.cursors.clear()
    for (const record of [...existing, ...added].sort((a, b) => a.at - b.at)) {
      const op = record.op as MetricOp
      let ring = this.rings.get(op)
      if (ring === undefined) { ring = []; this.rings.set(op, ring) }
      this.push(op, ring, { at: record.at, ms: record.ms, ok: record.ok })
    }
    this.totalCount += added.length
    this.totalErrors += added.filter(row => !row.ok).length
    // Restored activity must not mark the current process busy for warm-up.
    return added.length
  }

  /** True when nothing has been measured yet. */
  get empty(): boolean {
    return this.totalCount === 0
  }

  /**
   * When the last measured call finished, or `undefined` if none has.
   *
   * Read by the warm-up to decide whether the application is quiet. It is the
   * only always-on signal the backend has for "someone is waiting on me": warm-up
   * reads bypass `time()`, so this never reports the warm-up's own work as
   * activity and the loop cannot starve itself.
   */
  get lastObservedAt(): number | undefined {
    return this.lastAt
  }

  /** Display all retained measurements; idle time never erases the history. */
  historySnapshot(now = Date.now()): MetricsSnapshot {
    let from = now - WINDOW_MS
    for (const ring of this.rings.values()) {
      for (const sample of ring) from = Math.min(from, sample.at - 1)
    }
    return this.snapshot(now, now - from)
  }

  /** Summaries and time series for every op, over the trailing window. */
  snapshot(now = Date.now(), windowMs = WINDOW_MS): MetricsSnapshot {
    const from = now - windowMs
    const bucketMs = Math.max(BUCKET_MS, Math.ceil(windowMs / 60 / BUCKET_MS) * BUCKET_MS)
    const buckets = Math.ceil(windowMs / bucketMs)
    const ops: MetricsSeries[] = []
    // The header says "in the last N minutes", so it has to count the window,
    // not the process: after five idle minutes every row reads 0 while a
    // lifetime total would still claim samples that the chart cannot show.
    let windowCount = 0
    let windowErrors = 0
    for (const op of METRIC_OPS) {
      const ring = this.rings.get(op) ?? []
      // One pass over the ring, not one pass per bucket: the flat version walked
      // every sample sixty times per op, which is a million comparisons for a
      // chart nobody asked to be that precise about.
      const grouped: number[][] = []
      const bucketErrors: number[] = []
      for (let index = 0; index < buckets; index += 1) {
        grouped.push([])
        bucketErrors.push(0)
      }
      const durations: number[] = []
      let errors = 0
      for (const sample of ring) {
        if (sample.at < from || sample.at > now) continue
        const index = Math.min(buckets - 1, Math.floor((sample.at - from) / bucketMs))
        const into = grouped[index]
        if (into === undefined) continue
        into.push(sample.ms)
        durations.push(sample.ms)
        if (!sample.ok) {
          bucketErrors[index] = (bucketErrors[index] ?? 0) + 1
          errors += 1
        }
      }
      durations.sort((a, b) => a - b)
      const series: MetricsBucket[] = []
      for (let index = 0; index < buckets; index += 1) {
        const values = grouped[index] ?? []
        values.sort((a, b) => a - b)
        series.push({
          t: from + index * bucketMs,
          count: values.length,
          errors: bucketErrors[index] ?? 0,
          p50: round(percentile(values, 0.5)),
          p95: round(percentile(values, 0.95)),
          p99: round(percentile(values, 0.99)),
          max: round(values.at(-1) ?? 0),
        })
      }
      const sum = durations.reduce((total, value) => total + value, 0)
      windowCount += durations.length
      windowErrors += errors
      ops.push({
        op,
        label: METRIC_LABELS[op],
        count: durations.length,
        errors,
        p50: round(percentile(durations, 0.5)),
        p95: round(percentile(durations, 0.95)),
        p99: round(percentile(durations, 0.99)),
        max: round(durations.at(-1) ?? 0),
        mean: durations.length === 0 ? 0 : round(sum / durations.length),
        buckets: series,
      })
    }
    return {
      since: this.since,
      now,
      windowMs,
      bucketMs,
      retention: MAX_SAMPLES,
      count: windowCount,
      errors: windowErrors,
      ops,
    }
  }
}