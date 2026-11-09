/**
 * The console page itself: four views over the read-only Host routes.
 *
 * The views are the storage overview, the conversation converter, the latency
 * panel and the settings panel — nothing else. A session list, a raw event reader
 * and a diagnostics page all existed once and were removed: each of them either
 * duplicated what the session list already shows or answered a question nobody
 * asked on this panel. The routes behind them went with them, because an endpoint
 * nobody reads is still code to maintain.
 *
 * Health is not its own view either: the overview states it in one line and one
 * card, which is the whole of what a reader wants from it when nothing is wrong.
 *
 * The language is a backend preference, not a page state: the settings view writes
 * it, every view reads it, and a reload of the page keeps it. That is why the
 * panel loads `/settings` alongside `/overview` before it can be sure which
 * language to draw — the first paint is Chinese, which is the default the
 * preference file starts from.
 *
 * Rendered inside the main panel, so it owns its own scrolling and never assumes
 * a surrounding card. All data arrives through `api.ts`; nothing here talks to
 * SQLite, the filesystem, or the persistence service directly.
 *
 * @module dsh-session-optimizer/client/ConsolePage
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { fileSizeText } from '@deepseek-ai/dsh-client-ui-primitives'
import { fetchOverview, fetchSettings, saveSettings } from './api.ts'
import type { Overview, Preferences, SettingsAnswer, UsageRow } from './types.ts'
import { type Text, localeOf, textOf } from './i18n.ts'
import { onLibraryChanged } from './library.ts'
import { DiagnosticsTab } from './DiagnosticsTab.tsx'
import { MetricsTab } from './MetricsTab.tsx'
import { SettingsTab } from './SettingsTab.tsx'
import { ensureStyles } from './styles.ts'
import { TransferTab } from './TransferTab.tsx'

type View = 'overview' | 'transfer' | 'metrics' | 'diagnostics' | 'settings'

/** Render an epoch-millisecond stamp in the console's own locale. */
function stamp(ms: number, locale: string): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  return new Date(ms).toLocaleString(locale, { hour12: false })
}

/** Group digits, so a five-figure event count stays readable. */
function count(value: number, locale: string): string {
  return Number.isFinite(value) ? value.toLocaleString(locale) : '—'
}

/**
 * How much of the root one conversation takes, as the bar's width.
 *
 * Two decimals below one percent: the interesting small conversation is usually
 * thousands of times smaller than the largest, and rounding it to `0.0%` would
 * make an occupied row look empty.
 */
function share(row: UsageRow, total: number): string {
  if (total <= 0) return '0%'
  const percent = (row.sizeBytes / total) * 100
  return `${percent >= 1 ? percent.toFixed(1) : percent.toFixed(2)}%`
}

function OneCard({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="dshsql-card">
      <div className="dshsql-card-label">{label}</div>
      <div className="dshsql-card-value">{value}</div>
      <div className="dshsql-card-note">{note}</div>
    </div>
  )
}

function KeyRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="dshsql-kv-row">
      <dt>{label}</dt>
      <dd className={mono === true ? 'dshsql-mono' : undefined}>{value}</dd>
    </div>
  )
}

/** What the panel says about the root when nothing is wrong. */
function healthLine(overview: Overview, text: Text, locale: string): { line: string; tone: 'ok' | 'warning' | 'danger' } {
  if (overview.damaged > 0) {
    return { line: text.overview.damaged(count(overview.damaged, locale)), tone: 'danger' }
  }
  if (overview.importing > 0) {
    return {
      line: text.overview.importing(count(overview.sessions, locale), count(overview.importing, locale)),
      tone: 'warning',
    }
  }
  return { line: text.overview.healthy(count(overview.sessions, locale)), tone: 'ok' }
}

/**
 * Space usage and the pragmas in force.
 *
 * The rows are sorted by size on the Host, so the table answers "what is taking
 * the room" without a control; the share bar makes the answer visible at a
 * glance, which a column of byte counts does not.
 */
function OverviewTab({ overview, text, locale }: { overview: Overview | undefined; text: Text; locale: string }) {
  if (overview === undefined) return <div className="dshsql-empty">{text.overview.reading}</div>
  const health = healthLine(overview, text, locale)
  const privateText = overview.rootPrivate === undefined
    ? text.overview.modePlain(overview.rootMode)
    : overview.rootPrivate
      ? text.overview.modePrivate(overview.rootMode)
      : text.overview.modeShared(overview.rootMode)
  return (
    <>
      <div className="dshsql-section-head">
        <span className="dshsql-status">
          <span className="dshsql-dot" data-tone={health.tone === 'ok' ? undefined : health.tone} />
          {health.line}
        </span>
        <span className="dshsql-spacer" />
        <span className="dshsql-muted">{text.overview.updatedAt(stamp(overview.checkedAt, locale))}</span>
      </div>

      <div className="dshsql-cards">
        <OneCard
          label={text.overview.cardSessions}
          value={count(overview.sessions, locale)}
          note={overview.importing === 0
            ? text.overview.allReady
            : text.overview.stillImporting(count(overview.importing, locale))}
        />
        <OneCard
          label={text.overview.cardEvents}
          value={count(overview.events, locale)}
          note={text.overview.acrossSessions(count(overview.sessions, locale))}
        />
        <OneCard
          label={text.overview.cardSpace}
          value={fileSizeText(overview.databaseBytes)}
          note={text.overview.databaseNote(fileSizeText(overview.databaseBytes), fileSizeText(overview.walBytes))}
        />
        <OneCard
          label={text.overview.cardDamaged}
          value={count(overview.damaged, locale)}
          note={overview.damaged === 0 ? text.overview.nothingDamaged : text.overview.seeTable}
        />
      </div>

      <div className="dshsql-overview-grid">
        <section className="dshsql-panel">
          <h2 className="dshsql-section-title">{text.overview.usageTitle}</h2>
          {overview.usage.length === 0
            ? <div className="dshsql-empty">{text.overview.noSessions}</div>
            : (
              <div className="dshsql-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{text.overview.columns.session}</th>
                      <th>{text.overview.columns.events}</th>
                      <th>{text.overview.columns.size}</th>
                      <th>{text.overview.columns.share}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.usage.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <span className="dshsql-usage-title" title={row.title ?? row.id}>
                            {row.title === undefined || row.title === '' ? text.overview.untitled : row.title}
                          </span>
                          {row.problem === undefined
                            ? null
                            : <div className="dshsql-row-problem dshsql-wrap">{row.problem}</div>}
                        </td>
                        <td className="dshsql-num">{count(row.eventCount, locale)}</td>
                        <td className="dshsql-num">{fileSizeText(row.sizeBytes)}</td>
                        <td>
                          <div className="dshsql-usage-track">
                            <span style={{ width: share(row, overview.databaseBytes) }} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </section>

        <section className="dshsql-panel">
          <h2 className="dshsql-section-title">{text.overview.configTitle}</h2>
          <dl className="dshsql-kv">
            <KeyRow label={text.overview.format} value={text.overview.layoutVersion(overview.schemaVersion)} />
            <KeyRow
              label={text.overview.journal}
              value={`${overview.journalMode.toUpperCase()} / ${overview.synchronous}`}
              mono
            />
            <KeyRow
              label={text.overview.thread}
              value={overview.storageThread === 'worker' ? text.overview.workerThread : text.overview.hostThread}
            />
            <KeyRow label={text.overview.busyTimeout} value={`${count(overview.busyTimeoutMs, locale)} ms`} />
            <KeyRow label={text.overview.mode} value={privateText} />
          </dl>
          {/* Collapsed by default: a reader who is not debugging never opens it,
              and the four numbers above already answer the question they came for. */}
          <details className="dshsql-tech">
            <summary>{text.overview.tech}</summary>
            <dl className="dshsql-kv">
              <KeyRow label={text.overview.root} value={overview.root} />
              <KeyRow label="application_id" value={`${overview.applicationId} (0x${overview.applicationId.toString(16)})`} mono />
              <KeyRow label="journal_mode" value={overview.journalMode} mono />
              <KeyRow label="synchronous" value={overview.synchronous} mono />
              <KeyRow label="busy_timeout" value={`${overview.busyTimeoutMs}ms`} mono />
            </dl>
          </details>
        </section>
      </div>
    </>
  )
}

/**
 * The console page mounted in the `main` slot.
 * @returns the page element.
 */
export function ConsolePage() {
  ensureStyles()
  const [view, setView] = useState<View>('overview')
  const [overview, setOverview] = useState<Overview | undefined>(undefined)
  const [settings, setSettings] = useState<SettingsAnswer | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  /**
   * Bumped by every refresh.
   *
   * The header button reads as "refresh this view", but the latency tab samples
   * on mount only, so without this it kept showing numbers from whenever the
   * tab was first opened while the rest of the page updated. Only the latency
   * tab is keyed by it: remounting the conversion tab would drop the operator's
   * selection mid-task.
   */
  const [epoch, setEpoch] = useState(0)

  const language = settings?.preferences?.language ?? 'zh'
  const text = useMemo(() => textOf(language), [language])
  const locale = localeOf(language)

  /**
   * Re-read both routes.
   *
   * One refresh for the page rather than one per view: the header button is the
   * only refresh a reader has, and it should not depend on which tab happens to
   * be in front. A failure in either is shown, because a page that silently
   * kept a half-stale pair would be worse than one that says so.
   */
  const reload = useCallback(() => {
    const abort = new AbortController()
    setBusy(true)
    setEpoch((value) => value + 1)
    const settled = Promise.allSettled([fetchOverview(abort.signal), fetchSettings(abort.signal)])
    void settled.then(([overviewResult, settingsResult]) => {
      if (abort.signal.aborted) return
      if (overviewResult.status === 'fulfilled') setOverview(overviewResult.value)
      if (settingsResult.status === 'fulfilled') setSettings(settingsResult.value)
      const failed = [overviewResult, settingsResult]
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => (result.reason instanceof Error ? result.reason.message : String(result.reason)))
      setError(failed.length === 0 ? undefined : failed.join(' · '))
    }).finally(() => { if (!abort.signal.aborted) setBusy(false) })
    return () => { abort.abort() }
  }, [])

  useEffect(() => reload(), [reload])

  // A conversion changes which backend owns a conversation, or adds one. Both
  // show up in the totals and the usage table only after they are re-read, so a
  // settled run announces itself and the overview refreshes.
  useEffect(() => onLibraryChanged(() => { reload() }), [reload])

  /**
   * Write one switch and adopt the answer.
   *
   * The Host's reply is what the panel draws, not the value that was sent: a
   * format this install cannot serve is refused at the edge, and a panel that
   * showed its own optimistic copy would claim a switch had taken effect when it
   * had not.
   */
  const applyPatch = useCallback(async (patch: Partial<Preferences>): Promise<void> => {
    const saved = await saveSettings(patch)
    setSettings((current) => current === undefined ? current : { ...current, preferences: saved })
  }, [])

  const tabs: ReadonlyArray<{ value: View; label: string }> = [
    { value: 'overview', label: text.nav.overview },
    { value: 'transfer', label: text.nav.transfer },
    { value: 'metrics', label: text.nav.metrics },
    { value: 'diagnostics', label: text.nav.diagnostics },
    { value: 'settings', label: text.nav.settings },
  ]

  const footer = useMemo(() => {
    if (overview === undefined) return undefined
    return {
      sessions: overview.sessions,
      bytes: overview.databaseBytes,
      wal: overview.walBytes,
    }
  }, [overview])

  return (
    <div className="dshsql-page" lang={locale}>
      <header className="dshsql-header">
        <h1>{text.title}</h1>
        <span className="dshsql-spacer" />
        {error === undefined ? null : <span className="dshsql-error">{error}</span>}
        <button
          type="button"
          className="dshsql-btn dshsql-btn-sm"
          onClick={() => { reload() }}
          disabled={busy}
        >
          {busy ? text.refreshing : text.refresh}
        </button>
      </header>
      <nav className="dshsql-tabs" role="tablist" aria-label={text.navLabel}>
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            className="dshsql-tab"
            id={`dshsql-tab-${tab.value}`}
            aria-selected={tab.value === view}
            aria-controls={`dshsql-panel-${tab.value}`}
            data-active={tab.value === view ? 'true' : 'false'}
            onClick={() => { setView(tab.value) }}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      <main className="dshsql-main">
        <div className="dshsql-container">
          <section
            role="tabpanel"
            id="dshsql-panel-overview"
            aria-labelledby="dshsql-tab-overview"
            hidden={view !== 'overview'}
          >
            {view === 'overview' ? <OverviewTab overview={overview} text={text} locale={locale} /> : null}
          </section>
          <section
            role="tabpanel"
            id="dshsql-panel-transfer"
            aria-labelledby="dshsql-tab-transfer"
            hidden={view !== 'transfer'}
          >
            {view === 'transfer' ? <TransferTab text={text} locale={locale} /> : null}
          </section>
          <section
            role="tabpanel"
            id="dshsql-panel-metrics"
            aria-labelledby="dshsql-tab-metrics"
            hidden={view !== 'metrics'}
          >
            {view === 'metrics' ? <MetricsTab key={`metrics-${epoch}`} text={text} locale={locale} /> : null}
          </section>
          <section
            role="tabpanel"
            id="dshsql-panel-diagnostics"
            aria-labelledby="dshsql-tab-diagnostics"
            hidden={view !== 'diagnostics'}
          >
            {view === 'diagnostics' ? <DiagnosticsTab text={text} locale={locale} /> : null}
          </section>
          <section
            role="tabpanel"
            id="dshsql-panel-settings"
            aria-labelledby="dshsql-tab-settings"
            hidden={view !== 'settings'}
          >
            {view === 'settings'
              ? (
                <SettingsTab
                  text={text}
                  answer={settings}
                  onPatch={applyPatch}
                  // A failed re-read rejects, so the panel can report it instead
                  // of printing "up to date" over a request that never landed.
                  onRefresh={async () => {
                    setSettings(await fetchSettings())
                  }}
                />
              )
              : null}
          </section>
        </div>
      </main>
      <footer className="dshsql-footer">
        <span>{footer === undefined ? '—' : text.footer.sessions(count(footer.sessions, locale))}</span>
        <span>{footer === undefined ? '—' : fileSizeText(footer.bytes)}</span>
        <span>{footer === undefined ? '—' : `WAL ${fileSizeText(footer.wal)}`}</span>
        <span className="dshsql-spacer" />
        <span>{text.footer.storage}</span>
      </footer>
    </div>
  )
}
