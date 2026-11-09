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
 * Samples kept per op.
 *
 * The snapshot summarises a five-minute window, so this is also the rate the
 * chart can honestly show: 8192 samples over 300 s is 27 calls per second, and a
 * busier store loses its oldest samples before they leave the window, which makes
 * the chart under-report rather than lie about the shape. Doubling the capacity
 * rather than the window is deliberate — an operator reads the last few minutes.
 */
const MAX_SAMPLES = 8192

/** Drop this share of the ring at once when it is full, instead of one per push. */
const TRIM_SHIFT = 2

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
    ring.push({ at, ms, ok })
    // `splice(0, 1)` on every push would memmove the whole ring on the hot path;
    // dropping a quarter of it amortises the cost over the next few thousand
    // samples. The window filter in `snapshot` does not depend on the ring being
    // exactly full.
    if (ring.length > MAX_SAMPLES) ring.splice(0, ring.length - (MAX_SAMPLES >> TRIM_SHIFT))
    this.totalCount += 1
    this.lastAt = at
    if (!ok) this.totalErrors += 1
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

  /**
   * Samples inside the trailing window, for the on-disk journal.
   *
   * Only the window is exported: the file's purpose is to survive a restart, and
   * a sample the snapshot would not count is dead weight in it.
   */
  exportSamples(now = Date.now()): LatencySampleRecord[] {
    const from = now - WINDOW_MS
    const records: LatencySampleRecord[] = []
    for (const op of METRIC_OPS) {
      for (const sample of this.rings.get(op) ?? []) {
        if (sample.at < from) continue
        records.push({ op, at: sample.at, ms: sample.ms, ok: sample.ok })
      }
    }
    records.sort((left, right) => left.at - right.at)
    return records
  }

  /**
   * Put back samples read from the journal, keeping the ones that still matter.
   *
   * Anything unknown, malformed, or already outside the window is dropped instead
   * of being reported as a call this process made: the panel's claim is "these are
   * real calls", and a restored row is only honest while the window still shows it.
   * Returns how many were kept.
   */
  restoreSamples(records: readonly LatencySampleRecord[], now = Date.now()): number {
    const from = now - WINDOW_MS
    let kept = 0
    for (const record of records) {
      if (!(METRIC_OPS as readonly string[]).includes(record.op)) continue
      if (!Number.isFinite(record.at) || !Number.isFinite(record.ms)) continue
      if (record.at < from || record.at > now + BUCKET_MS || record.ms < 0) continue
      const op = record.op as MetricOp
      let ring = this.rings.get(op)
      if (ring === undefined) {
        ring = []
        this.rings.set(op, ring)
      }
      ring.push({ at: record.at, ms: record.ms, ok: record.ok !== false })
      if (ring.length > MAX_SAMPLES) ring.splice(0, ring.length - (MAX_SAMPLES >> TRIM_SHIFT))
      this.totalCount += 1
      if (record.ok === false) this.totalErrors += 1
      // `lastAt` stays untouched on purpose: the warm-up reads it as "is the
      // application busy right now", and a call made by the previous process says
      // nothing about this one.
      kept += 1
    }
    return kept
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

  /** Summaries and time series for every op, over the trailing window. */
  snapshot(now = Date.now()): MetricsSnapshot {
    const from = now - WINDOW_MS
    const buckets = Math.ceil(WINDOW_MS / BUCKET_MS)
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
        if (sample.at < from) continue
        const index = Math.min(buckets - 1, Math.floor((sample.at - from) / BUCKET_MS))
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
          t: from + index * BUCKET_MS,
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
      windowMs: WINDOW_MS,
      bucketMs: BUCKET_MS,
      retention: MAX_SAMPLES,
      count: windowCount,
      errors: windowErrors,
      ops,
    }
  }
}