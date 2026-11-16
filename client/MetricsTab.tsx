/**
 * Latency view: the six operations the backend actually times.
 *
 * Every number here comes from `MetricsRegistry` inside the Host process — the
 * view never invents a sample. When nothing has been timed yet the route answers
 * `available: false` and this view says so instead of drawing a flat line: an
 * all-zero curve looks like a measurement that happened and found nothing, which
 * is the one thing it is not.
 *
 * The chart is hand-drawn SVG rather than a charting dependency, because the
 * whole page ships as one client bundle and the drawing is four paths, five grid
 * lines and a hover rule. Its width is measured from the panel rather than
 * scaled with a `viewBox`, so the axis labels keep their 11px size at any width.
 *
 * Operation names come from `text.metrics.ops`, not from the series label the
 * Host sends: that label is one fixed string baked into the Host module, and a
 * panel that switched to English while its rows stayed Chinese would be worse
 * than one that never offered the switch.
 *
 * @module dsh-session-optimizer/client/MetricsTab
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { fetchMetrics } from './api.ts'
import type { Text } from './i18n.ts'
import type { MetricBucket, MetricSeries, MetricsAnswer } from './types.ts'

/** Chart geometry, in CSS pixels. */
const CHART_HEIGHT = 260
const PAD_LEFT = 50
const PAD_RIGHT = 16
// Deep enough for a unit badge above the top grid line: with the badge on the
// same row as the topmost label, "ms" ran into "20.5" and printed "ms20.5".
const PAD_TOP = 22
const PAD_BOTTOM = 32
const GRID_LINES = 4
const TIME_TICKS = 6
const TOOLTIP_WIDTH = 190

function micros(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 1) return `${(value * 1000).toFixed(0)}µs`
  if (value < 1000) return `${value.toFixed(value < 10 ? 2 : 1)}ms`
  return `${(value / 1000).toFixed(2)}s`
}

function message(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

function clock(at: number, locale: string): string {
  return new Date(at).toLocaleTimeString(locale, { hour12: false })
}

/** The row name for an operation, falling back to whatever the Host labelled it. */
function opLabel(series: MetricSeries, text: Text): string {
  return text.metrics.ops[series.op] ?? series.label
}

/**
 * Axis unit for a peak, so the labels stay readable at both ends of the range.
 *
 * A one-second open on a cold start makes the peak six figures: printing that in
 * whole milliseconds gave grid labels like "127192.5", while the stat cards one
 * line above said "115.63s" for the same value. The axis therefore scales with
 * the peak and the corner badge names the unit it picked.
 */
function axisUnit(peak: number): { readonly divisor: number; readonly suffix: string } {
  return peak >= 1000 ? { divisor: 1000, suffix: 's' } : { divisor: 1, suffix: 'ms' }
}

/** A round ceiling above the peak, so the top grid line is a readable number. */
function niceCeiling(peak: number): number {
  if (peak <= 0) return 1
  return Math.ceil(peak * 1.1 * 2) / 2
}

/** Where the pointer landed on the series, and where to put its readout. */
interface Probe {
  readonly index: number
  readonly clientX: number
  readonly clientY: number
}

/** A bucket that has samples. A bucket with none is a gap, not a zero. */
function measured(series: MetricSeries): MetricBucket[] {
  return series.buckets.filter((bucket) => bucket.count > 0)
}

function Plot({
  points,
  width,
  probe,
  locale,
}: {
  points: readonly MetricBucket[]
  width: number
  probe: Probe | undefined
  locale: string
}) {
  const peak = useMemo(() => niceCeiling(Math.max(0, ...points.map((bucket) => bucket.max))), [points])
  const innerWidth = Math.max(1, width - PAD_LEFT - PAD_RIGHT)
  const innerHeight = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM
  const x = (index: number): number =>
    points.length <= 1 ? PAD_LEFT + innerWidth / 2 : PAD_LEFT + (index / (points.length - 1)) * innerWidth
  const y = (value: number): number => PAD_TOP + innerHeight - (Math.min(value, peak) / peak) * innerHeight
  const path = (pick: (bucket: MetricBucket) => number): string =>
    points.map((bucket, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)} ${y(pick(bucket)).toFixed(1)}`).join(' ')

  const unit = axisUnit(peak)
  const gridValues = Array.from({ length: GRID_LINES + 1 }, (_, step) => (peak / GRID_LINES) * step)
  const ticks = points.length <= TIME_TICKS
    ? points.map((_, index) => index)
    : Array.from({ length: TIME_TICKS }, (_, step) => Math.round((step / (TIME_TICKS - 1)) * (points.length - 1)))
  const shown = probe === undefined ? undefined : points[probe.index]

  return (
    <>
      {gridValues.map((value) => (
        <g key={value}>
          <line className="grid" x1={PAD_LEFT} x2={width - PAD_RIGHT} y1={y(value)} y2={y(value)} />
          <text x={PAD_LEFT - 8} y={y(value) + 4} textAnchor="end">
            {(value / unit.divisor).toFixed(unit.divisor === 1 && peak < 10 ? 2 : 1)}
          </text>
        </g>
      ))}
      {/* On its own row above the plot: the topmost tick label ends at
          PAD_LEFT - 8, so anything sharing that baseline collides with it. */}
      <text x={8} y={PAD_TOP - 10}>{unit.suffix}</text>
      <line className="axis" x1={PAD_LEFT} x2={width - PAD_RIGHT} y1={CHART_HEIGHT - PAD_BOTTOM} y2={CHART_HEIGHT - PAD_BOTTOM} />
      {ticks.map((index, step) => (
        <text
          key={index}
          x={x(index)}
          y={CHART_HEIGHT - 8}
          /* Midpoint anchors centre the label on the tick, which pushes the two
             outer ones past the panel edge and clips them. */
          textAnchor={step === 0 ? 'start' : step === ticks.length - 1 ? 'end' : 'middle'}
        >
          {clock(points[index]!.t, locale)}
        </text>
      ))}
      {/* Drawn widest first, so the p50 line sits on top of the others. */}
      <path className="max-line" d={path((bucket) => bucket.max)} />
      <path className="p95-line" d={path((bucket) => bucket.p95)} />
      <path className="p50-line" d={path((bucket) => bucket.p50)} />
      {probe === undefined || shown === undefined
        ? null
        : (
          <>
            <line
              className="hover-line"
              x1={x(probe.index)}
              x2={x(probe.index)}
              y1={PAD_TOP}
              y2={CHART_HEIGHT - PAD_BOTTOM}
            />
            <circle className="point" cx={x(probe.index)} cy={y(shown.p50)} r={4} />
          </>
        )}
    </>
  )
}

function Readout({ bucket, probe, text, locale }: {
  bucket: MetricBucket
  probe: Probe
  text: Text
  locale: string
}) {
  // Kept on screen: a readout that opens off the right edge is a readout nobody
  // reads, and the window is narrower than the panel on a laptop.
  const viewport = typeof window === 'undefined' ? 1280 : window.innerWidth
  const left = Math.min(Math.max(8, probe.clientX + 14), Math.max(8, viewport - TOOLTIP_WIDTH))
  return (
    <div className="dshsql-chart-tooltip" style={{ left: `${left}px`, top: `${Math.max(8, probe.clientY - 12)}px` }}>
      <div className="dshsql-mono">{clock(bucket.t, locale)}</div>
      <dl>
        <dt>p50</dt><dd>{micros(bucket.p50)}</dd>
        <dt>p95</dt><dd>{micros(bucket.p95)}</dd>
        <dt>max</dt><dd>{micros(bucket.max)}</dd>
        <dt>{text.metrics.columns.count}</dt><dd>{bucket.count}</dd>
      </dl>
    </div>
  )
}

/**
 * The latency view.
 * @param props.text - the strings in force.
 * @param props.locale - the locale clock times are formatted in.
 * @returns the tab element.
 */
export function MetricsTab({ text, locale }: { text: Text; locale: string }) {
  const [answer, setAnswer] = useState<MetricsAnswer | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [op, setOp] = useState<string | undefined>(undefined)
  const [width, setWidth] = useState(960)
  const [probe, setProbe] = useState<Probe | undefined>(undefined)
  const panel = useRef<HTMLDivElement | undefined>(undefined)

  useEffect(() => {
    const abort = new AbortController()
    fetchMetrics(abort.signal)
      .then((next) => { setAnswer(next); setError(undefined) })
      .catch((failure: unknown) => {
        if (abort.signal.aborted) return
        setError(message(failure))
      })
    return () => { abort.abort() }
  }, [])

  // The plot is drawn in CSS pixels, so it has to know how wide the panel is.
  useLayoutEffect(() => {
    const node = panel.current
    if (node === undefined) return
    const measure = (): void => { setWidth(Math.max(320, node.clientWidth)) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => { observer.disconnect() }
  }, [answer])

  const ops = useMemo(() => answer?.snapshot?.ops ?? [], [answer])
  const current = ops.find((series) => series.op === op) ?? ops[0]
  const points = useMemo(() => (current === undefined ? [] : measured(current)), [current])

  if (error !== undefined) return <div className="dshsql-error">{error}</div>
  if (answer === undefined) return <div className="dshsql-empty">{text.metrics.reading}</div>
  if (!answer.available || answer.snapshot === undefined) {
    return <div className="dshsql-empty">{answer.reason ?? text.metrics.noSamples}</div>
  }

  const snapshot = answer.snapshot
  const probeBucket = probe === undefined ? undefined : points[probe.index]
  const title = current === undefined ? '—' : opLabel(current, text)

  return (
    <>
      <div className="dshsql-metric-summary">
        <span>{text.metrics.window(Math.ceil(snapshot.windowMs / 60_000))}</span>
        <span className="dshsql-muted">{text.metrics.retention(snapshot.retention)}</span>
        <span><strong className="dshsql-num">{snapshot.count}</strong> {text.metrics.samples}</span>
        <span><strong className="dshsql-num">{snapshot.errors}</strong> {text.metrics.failures}</span>
        <span className="dshsql-muted">{text.metrics.bucket(Math.round(snapshot.bucketMs / 1000))}</span>
        <span className="dshsql-spacer" />
        <span className="dshsql-muted">{text.metrics.updatedAt(clock(snapshot.now, locale))}</span>
      </div>

      <section className="dshsql-chart-panel">
        <div className="dshsql-chart-head">
          <div className="dshsql-chart-title">
            <strong>{title}</strong>
            <span>{text.metrics.subtitle}</span>
          </div>
          <span className="dshsql-spacer" />
          <div className="dshsql-legend">
            <span><i />p50</span>
            <span className="p95"><i />p95</span>
            <span className="max"><i />max</span>
          </div>
        </div>

        {current === undefined
          ? <div className="dshsql-empty-note">{text.metrics.nothingTimed}</div>
          : (
            <>
              <div className="dshsql-chart-stats">
                <div className="dshsql-chart-stat"><span>p50</span><strong>{micros(current.p50)}</strong></div>
                <div className="dshsql-chart-stat"><span>p95</span><strong>{micros(current.p95)}</strong></div>
                <div className="dshsql-chart-stat"><span>p99</span><strong>{micros(current.p99)}</strong></div>
                <div className="dshsql-chart-stat">
                  <span>{text.metrics.max}</span><strong>{micros(current.max)}</strong>
                </div>
                <div className="dshsql-chart-stat">
                  <span>{text.metrics.calls}</span><strong>{current.count}</strong>
                </div>
              </div>
              <div
                ref={(node: HTMLDivElement | null) => { panel.current = node ?? undefined }}
                onMouseLeave={() => { setProbe(undefined) }}
                onMouseMove={(event: { clientX: number; clientY: number }) => {
                  const node = panel.current
                  if (node === undefined || points.length === 0) return
                  const box = node.getBoundingClientRect()
                  const innerWidth = Math.max(1, width - PAD_LEFT - PAD_RIGHT)
                  const ratio = Math.min(1, Math.max(0, (event.clientX - box.left - PAD_LEFT) / innerWidth))
                  setProbe({
                    index: Math.round(ratio * (points.length - 1)),
                    clientX: event.clientX,
                    clientY: event.clientY,
                  })
                }}
              >
                {points.length === 0
                  ? <div className="dshsql-empty-note">{text.metrics.noWindowSamples}</div>
                  : (
                    <svg
                      className="dshsql-chart"
                      role="img"
                      aria-label={text.metrics.chartLabel(title)}
                      width={width}
                      height={CHART_HEIGHT}
                      viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
                    >
                      <Plot points={points} width={width} probe={probe} locale={locale} />
                    </svg>
                  )}
              </div>
            </>
          )}
      </section>

      {probeBucket === undefined || probe === undefined
        ? null
        : <Readout bucket={probeBucket} probe={probe} text={text} locale={locale} />}

      <div className="dshsql-table-wrap dshsql-metrics-table">
        <table>
          <thead>
            <tr>
              <th>{text.metrics.columns.op}</th>
              <th>{text.metrics.columns.count}</th>
              <th>{text.metrics.columns.p50}</th>
              <th>{text.metrics.columns.p95}</th>
              <th>{text.metrics.columns.p99}</th>
              <th>{text.metrics.columns.max}</th>
              <th>{text.metrics.columns.mean}</th>
            </tr>
          </thead>
          <tbody>
            {ops.map((series) => (
              <tr
                key={series.op}
                data-clickable="true"
                data-selected={series.op === current?.op ? 'true' : 'false'}
                onClick={() => { setOp(series.op); setProbe(undefined) }}
              >
                <td>{opLabel(series, text)}</td>
                <td className="dshsql-num">
                  {series.count}
                  {series.errors === 0
                    ? ''
                    : <span className="dshsql-error"> · {text.metrics.failureSuffix(series.errors)}</span>}
                </td>
                <td className="dshsql-num">{micros(series.p50)}</td>
                <td className="dshsql-num">{micros(series.p95)}</td>
                <td className="dshsql-num">{micros(series.p99)}</td>
                <td className="dshsql-num">{micros(series.max)}</td>
                <td className="dshsql-num">{micros(series.mean)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
