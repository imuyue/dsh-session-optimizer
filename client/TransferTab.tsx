/**
 * The conversation converter.
 *
 * This view is a *conversation* converter, not a file tool. What it changes is
 * which backend a conversation lives on, and therefore what the session list
 * shows:
 *
 * - 「转换后覆盖原对话」keeps the session id, so the conversation stays one
 *   conversation and simply starts being read from the other backend;
 * - 「转换后创建新对话」mints a new id and preserves the original history,
 *   then appends the new conversation's copy title.
 *
 * The view asks the Host what the machine has (`/roots`), lists the source
 * root's conversations with their titles (`/source`), and posts only the ids the
 * operator ticked (`/migrate`). No path is typed by hand and no session id is
 * typed by hand: both come from discovery and the listing.
 *
 * Every string comes from `text.transfer`; the two direction labels are names of
 * formats, not words, so they read the same in both languages.
 *
 * @module dsh-session-optimizer/client/TransferTab
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clearMigrations, fetchMigrations, fetchRoots, fetchSource, startMigration } from './api.ts'
import type { Text } from './i18n.ts'
import { TransferSessionRows } from './TransferSessionRows.tsx'
import { announceLibraryChanged } from './library.ts'
import { replaceTransferPage, nextTransferOffset, resetTransferPages, type TransferPageState } from './transfer-pagination.ts'
import { currentSourceListing, targetBackend } from './transfer-contract.ts'
import type {
  MigrationItem,
  MigrationJob,
  RootCandidate,
} from './types.ts'

type Direction = 'jsonl_to_sqlite' | 'sqlite_to_jsonl'
type Mode = 'overwrite' | 'clone'

const DIRECTIONS: ReadonlyArray<{ value: Direction; label: string }> = [
  { value: 'jsonl_to_sqlite', label: 'JSONL → SQLite' },
  { value: 'sqlite_to_jsonl', label: 'SQLite → JSONL' },
]

const POLL_MS = 700
/** What the first pass asks for. A root with more rows grows by one page per click. */
const PAGE_SIZE = 50

function message(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

function titleOf(row: { title?: string | undefined }, text: Text): string {
  return row.title === undefined || row.title === '' ? text.overview.untitled : row.title
}

function stamp(ms: number | undefined, locale: string): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return '—'
  return new Date(ms).toLocaleString(locale, { hour12: false })
}

function tally(job: MigrationJob): { done: number; failed: number; total: number } {
  const items = job.report?.items ?? []
  let done = 0
  let failed = 0
  for (const item of items) {
    if (item.status === 'migrated' || (item.status === 'skipped' && item.error === undefined)) done += 1
    else if (item.status === 'failed') failed += 1
  }
  return { done, failed, total: items.length }
}

/**
 * Pick the root to open first.
 *
 * A configured root wins even when it is empty — otherwise the view would look
 * like the profile lost its storage. Only when it holds nothing at all does the
 * fullest candidate take over, which is what an operator pointing at a legacy
 * library expects.
 */
function pickRoot(candidates: readonly RootCandidate[], configured: string | undefined): string | undefined {
  const mine = candidates.filter((entry) => entry.backend === candidates[0]?.backend)
  const exact = mine.find((entry) => configured !== undefined && entry.path === configured)
  if (exact !== undefined && exact.sessions > 0) return exact.path
  const fullest = mine.reduce<RootCandidate | undefined>(
    (best, entry) => (best === undefined || entry.sessions > best.sessions ? entry : best),
    undefined,
  )
  if (exact !== undefined && (fullest === undefined || fullest.sessions === 0)) return exact.path
  return fullest?.path ?? exact?.path
}

/**
 * What one run did to the session list.
 *
 * The card names conversations, not files: a reader cares that 「排位赛」now opens
 * from SQLite, or that it exists twice, and not where the bytes sit.
 */
function JobCard({ job, text, locale, onClear, clearing, canClear }: { job: MigrationJob; text: Text; locale: string; onClear: () => void; clearing: boolean; canClear: boolean }) {
  const counts = tally(job)
  const items = job.report?.items ?? []
  const problems = items.filter(item => item.status === 'failed' || item.error !== undefined)
  const tone = job.status === 'completed' ? (problems.length === 0 ? 'success' : 'warning') : job.status === 'running' ? 'warning' : 'danger'
  const elapsed = job.finishedAt === undefined
    ? undefined
    : ((job.finishedAt - job.startedAt) / 1000).toFixed(1)
  const failed = items.filter((item) => item.status === 'failed')
  const statusText = job.status === 'completed'
    ? text.transfer.statusDone
    : job.status === 'running'
      ? text.transfer.statusRunning
      : text.transfer.statusFailed
  const outcome = job.error === undefined && job.status !== 'running'
    ? (problems.length === 0 ? text.transfer.verified : failed.length > 0 ? text.transfer.failedCount(failed.length) : undefined)
    : undefined
  return (
    <div className="dshsql-job">
      <div className="dshsql-section-head">
        <h2 className="dshsql-section-title">{text.transfer.recent}</h2>
        <button type="button" className="dshsql-button" onClick={onClear} disabled={clearing || !canClear}>{text.transfer.clearHistory}</button>
        <span className="dshsql-spacer" />
        <span className="dshsql-muted">{stamp(job.startedAt, locale)}</span>
        <span className="dshsql-status">
          <span className="dshsql-dot" data-tone={tone === 'success' ? undefined : tone} />
          {statusText}
        </span>
      </div>
      <div className="dshsql-card">
        <div className="dshsql-job-status">
          <strong>{job.direction === 'jsonl_to_sqlite' ? 'JSONL → SQLite' : 'SQLite → JSONL'}</strong>
          <span className="dshsql-muted">
            {text.transfer.conversations(String(counts.total))} ·{' '}
            {job.mode === 'clone' ? text.transfer.modeClone : text.transfer.modeOverwrite}
            {outcome === undefined ? '' : ` · ${outcome}`}
          </span>
          <span className="dshsql-muted">{elapsed === undefined ? '' : text.transfer.elapsed(elapsed)}</span>
          <span className="dshsql-spacer" />
          <span className="dshsql-mono">{counts.done} / {counts.total}</span>
        </div>
        <div className="dshsql-progress" data-tone={failed.length === 0 ? undefined : 'danger'}>
          <span style={{ width: `${counts.total === 0 ? 0 : (counts.done / counts.total) * 100}%` }} />
        </div>
        {job.notice === undefined ? null : <div className="dshsql-small">{job.notice}</div>}
        {job.error === undefined ? null : <div className="dshsql-error dshsql-small">{job.error}</div>}
        {problems.length === 0 ? null : (
          <ul className="dshsql-small dshsql-wrap">
            {problems.map((item: MigrationItem) => (
              <li key={item.sourceSession} className="dshsql-error">
                {titleOf(item, text)}：{item.error ?? text.transfer.failedFallback}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/**
 * The conversation converter view.
 * @param props.text - the strings in force.
 * @param props.locale - the locale numbers and stamps are formatted in.
 * @returns the tab element.
 */
export function TransferTab({ text, locale }: { text: Text; locale: string }) {
  const [direction, setDirection] = useState<Direction>('jsonl_to_sqlite')
  const [mode, setMode] = useState<Mode>('overwrite')
  const [verify, setVerify] = useState(true)

  const [roots, setRoots] = useState<RootCandidate[]>([])
  const [sourceRoot, setSourceRoot] = useState<string | undefined>(undefined)
  const [sqliteRoot, setSqliteRoot] = useState<string | undefined>(undefined)

  const [pages, setPages] = useState<TransferPageState>({ generation: 0, listing: undefined })
  const pagesRef = useRef(pages)
  const sourceAbort = useRef<AbortController | undefined>(undefined)
  const listing = currentSourceListing(pages.listing, direction === 'jsonl_to_sqlite' ? 'jsonl' : 'sqlite', sourceRoot)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  useEffect(() => { const timer = setTimeout(() => { setSearch(query) }, 250); return () => { clearTimeout(timer) } }, [query])
  const [listingBusy, setListingBusy] = useState(false)

  const [picked, setPicked] = useState<string[]>([])
  const [jobs, setJobs] = useState<MigrationJob[]>([])
  const [clearing, setClearing] = useState(false)
  const historyEpoch = useRef(0)
  const [available, setAvailable] = useState(true)
  const [settled, setSettled] = useState(0)

  const [error, setError] = useState<string | undefined>(undefined)
  const [starting, setStarting] = useState(false)
  const [tick, setTick] = useState(0)
  const [reload, setReload] = useState(0)

  const sourceBackend = direction === 'jsonl_to_sqlite' ? 'jsonl' : 'sqlite'
  const targetBackendId = targetBackend(direction)
  const targetLabel = targetBackendId === 'sqlite' ? 'SQLite' : 'JSONL'

  // The machine's roots: a filesystem walk per candidate, done once per mount and
  // again when the operator rescans or a run settles. It is deliberately not part
  // of the poll below — that walk runs on the host's only thread, and repeating it
  // every POLL_MS for the minutes a migration can take is work nobody asked for.
  useEffect(() => {
    const abort = new AbortController()
    fetchRoots(abort.signal)
      .then((nextRoots) => { setRoots(nextRoots) })
      .catch((failure: unknown) => {
        if (abort.signal.aborted) return
        setError(message(failure))
      })
    return () => { abort.abort() }
  }, [reload, settled])

  // Job history: a list read, cheap enough to repeat while something runs.
  useEffect(() => {
    const abort = new AbortController()
    const epoch = historyEpoch.current
    let timer: ReturnType<typeof setTimeout> | undefined
    fetchMigrations(abort.signal)
      .then((migrations) => {
        if (abort.signal.aborted || epoch !== historyEpoch.current) return
        setAvailable(migrations.available)
        setJobs(migrations.jobs)
        setSqliteRoot(migrations.sqliteRoot)
        if (migrations.jobs.some((job) => job.status === 'running')) {
          timer = window.setTimeout(() => { setTick((value) => value + 1) }, POLL_MS)
        }
      })
      .catch((failure: unknown) => {
        if (abort.signal.aborted || epoch !== historyEpoch.current) return
        setError(message(failure))
      })
    return () => { abort.abort(); if (timer !== undefined) clearTimeout(timer) }
  }, [tick, settled])

  const candidates = useMemo(
    () => roots.filter((entry) => entry.backend === sourceBackend),
    [roots, sourceBackend],
  )

  // Auto-select the source root whenever the direction (and so the candidate
  // set) changes: the operator never types a path.
  useEffect(() => {
    const configured = sourceBackend === 'sqlite'
      ? sqliteRoot
      : candidates.find((entry) => entry.source === 'configured')?.path
    setSourceRoot((current) => {
      if (current !== undefined && candidates.some((entry) => entry.path === current)) return current
      return pickRoot(candidates, configured)
    })
  }, [candidates, sourceBackend, sqliteRoot])

  const refresh = useCallback(() => { setReload((value) => value + 1) }, [])

  const loadSourcePage = useCallback((offset: number, generation: number): void => {
    if (sourceRoot === undefined) return
    sourceAbort.current?.abort()
    const abort = new AbortController()
    sourceAbort.current = abort
    setListingBusy(true)
    fetchSource(
      {
        backend: sourceBackend,
        root: sourceRoot,
        offset,
        limit: PAGE_SIZE,
        ...(search.trim() === '' ? {} : { query: search.trim() }),
        ...(offset === 0 && (reload !== 0 || settled !== 0) ? { refresh: true } : {}),
      },
      abort.signal,
    )
      .then((next) => {
        if (abort.signal.aborted || generation !== pagesRef.current.generation) return
        if (next.backend !== sourceBackend || next.root !== sourceRoot) return
        const updated = replaceTransferPage(pagesRef.current, generation, next)
        pagesRef.current = updated
        setPages(updated)
        setError(undefined)
      })
      .catch((failure: unknown) => {
        if (abort.signal.aborted || generation !== pagesRef.current.generation) return
        setError(message(failure))
      })
      .finally(() => {
        if (!abort.signal.aborted && generation === pagesRef.current.generation) setListingBusy(false)
      })
  }, [sourceRoot, sourceBackend, search, reload, settled])

  useEffect(() => {
    sourceAbort.current?.abort()
    const reset = resetTransferPages(pagesRef.current)
    pagesRef.current = reset
    setPages(reset)
    setPicked([])
    setListingBusy(false)
    loadSourcePage(0, reset.generation)
    return () => { sourceAbort.current?.abort() }
  }, [loadSourcePage])

  const current = jobs.at(-1)
  const clearHistory = (): void => {
    if (clearing) return
    historyEpoch.current++
    setClearing(true)
    void clearMigrations().then(() => { setJobs(previous => previous.filter(job => job.status === 'running')) })
      .catch((failure: unknown) => { setError(message(failure)) })
      .finally(() => { setClearing(false); setTick(value => value + 1) })
  }
  const rows = listing?.sessions ?? []
  const total = listing?.total ?? 0
  const allOnPage = rows.length > 0 && rows.every((session) => picked.includes(session.id))
  const unselected = picked.length === 0

  const toggle = (id: string): void => {
    setPicked((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id])
  }

  const togglePage = (): void => {
    const ids = rows.map((session) => session.id)
    setPicked((current) => allOnPage
      ? current.filter((id) => !ids.includes(id))
      : [...current, ...ids.filter((id) => !current.includes(id))])
  }

  const submit = (): void => {
    if (sourceRoot === undefined) {
      setError(text.transfer.noRoot)
      return
    }
    setStarting(true)
    setError(undefined)
    startMigration({
      direction,
      mode,
      // The Host decides the target root from the profile; the browser only says
      // which side it read.
      ...(sourceBackend === 'jsonl' ? { jsonlRoot: sourceRoot } : { sqliteRoot: sourceRoot }),
      ...(picked.length === 0 ? {} : { sessions: picked }),
      verify,
    })
      .then(() => {
        setPicked([])
        window.setTimeout(() => { setTick((value) => value + 1) }, POLL_MS)
      })
      .catch((failure: unknown) => { setError(message(failure)) })
      .finally(() => { setStarting(false) })
  }

  // A settled run is the moment the session list changed, so it is also the
  // moment to re-read both listings — otherwise the new conversation only
  // appears after a page reload, which reads as "the conversion did nothing".
  const changed = current?.status === 'completed' || current?.status === 'partial'
  useEffect(() => {
    if (!changed) return
    setSettled((value) => value + 1)
    refresh()
    announceLibraryChanged(current?.report)
  }, [changed, current?.id, refresh])

  // The button is only enabled with a selection (as in the design), so the hint
  // must not promise that an empty selection converts the whole directory: the
  // server accepts that request, but nothing in this view can send it.
  const hint = unselected ? text.transfer.hintNone : text.transfer.hintSome(picked.length)
  const offset = listing?.offset ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const pager = (
    <nav className="dshsql-section-head" aria-label={text.transfer.pageOf(Math.floor(offset / PAGE_SIZE) + 1, pageCount)}>
      <button type="button" className="dshsql-btn dshsql-btn-sm" disabled={listingBusy || offset === 0} onClick={() => { loadSourcePage(Math.max(0, offset - PAGE_SIZE), pagesRef.current.generation) }}>{text.transfer.previousPage}</button>
      <span className="dshsql-muted">{text.transfer.pageOf(Math.floor(offset / PAGE_SIZE) + 1, pageCount)}</span>
      <button type="button" className="dshsql-btn dshsql-btn-sm" disabled={listingBusy || listing === undefined || nextTransferOffset(pages) === undefined} onClick={() => { const next = nextTransferOffset(pagesRef.current); if (next !== undefined) loadSourcePage(next, pagesRef.current.generation) }}>{text.transfer.nextPage}</button>
    </nav>
  )

  return (
    <>
      <div className="dshsql-transfer-top">
        <div className="dshsql-direction" role="group" aria-label={text.transfer.directionLabel}>
          {DIRECTIONS.map((entry) => (
            <button
              key={entry.value}
              type="button"
              data-active={entry.value === direction ? 'true' : 'false'}
              onClick={() => { setDirection(entry.value); setPicked([]) }}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <span className="dshsql-spacer" />
        <button
          type="button"
          className="dshsql-btn dshsql-btn-sm"
          onClick={refresh}
          disabled={listingBusy || sourceRoot === undefined}
        >
          {listingBusy ? text.transfer.scanning : text.transfer.rescan}
        </button>
      </div>

      <div className="dshsql-section-head">
        <input
          className="dshsql-input dshsql-transfer-filter"
          type="search"
          value={query}
          placeholder={text.transfer.filter}
          onChange={(event: { target: { value: string } }) => { setQuery(event.target.value) }}
        />
        <span className="dshsql-muted">
          {listing === undefined
            ? text.transfer.scanningList
            : text.transfer.conversations(total.toLocaleString(locale))}
        </span>
        <span className="dshsql-spacer" />
        {pager}
      </div>

      {rows.length === 0
        ? (
          <div className="dshsql-empty">
            {listing === undefined
              ? (listingBusy ? text.transfer.emptyScanning : text.transfer.emptyNoRoot)
              : text.transfer.emptyNone}
          </div>
        )
        : (
          <div className="dshsql-table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: '40px' }}>
                    <input
                      className="dshsql-check"
                      type="checkbox"
                      checked={allOnPage}
                      onChange={togglePage}
                      aria-label={text.transfer.selectAll}
                    />
                  </th>
                  <th>{text.transfer.columns.conversation}</th>
                  <th>{text.transfer.columns.events}</th>
                  <th>{text.transfer.columns.size}</th>
                  <th>{text.transfer.columns.created}</th>
                </tr>
              </thead>
              <tbody>
                <TransferSessionRows key={pages.generation} rows={rows} backend={sourceBackend} root={listing?.root ?? sourceRoot ?? ''} targetLabel={targetLabel} picked={picked} onToggle={toggle} text={text} locale={locale} />
              </tbody>
            </table>
          </div>
        )}

      {pager}
      <div className="dshsql-muted dshsql-small">{text.transfer.linkedChildren}</div>
      <div className="dshsql-action-bar">
        <label className="dshsql-radio">
          <input
            type="radio"
            name="dshsql-transfer-mode"
            checked={mode === 'overwrite'}
            onChange={() => { setMode('overwrite') }}
          />
          {text.transfer.modeOverwrite}
        </label>
        <label className="dshsql-radio">
          <input
            type="radio"
            name="dshsql-transfer-mode"
            checked={mode === 'clone'}
            onChange={() => { setMode('clone') }}
          />
          {text.transfer.modeClone}
        </label>
        <label className="dshsql-radio">
          <input
            type="checkbox"
            className="dshsql-check"
            checked={verify}
            onChange={(event: { target: { checked: boolean } }) => { setVerify(event.target.checked) }}
          />
          {text.transfer.verify}
        </label>
        <span className="dshsql-spacer" />
        <span className="dshsql-action-hint">{hint}</span>
        <button
          type="button"
          className="dshsql-btn"
          data-primary="true"
          disabled={starting || !available || sourceRoot === undefined || listing === undefined || picked.length === 0}
          onClick={submit}
        >
          {starting
            ? text.transfer.submitted
            : unselected
              ? text.transfer.submit
              : text.transfer.submitMany(picked.length)}
        </button>
      </div>

      {available ? null : <div className="dshsql-empty-note">{text.transfer.singleBackend}</div>}
      {error === undefined ? null : <div className="dshsql-error">{error}</div>}

      {current === undefined
        ? <div className="dshsql-empty-note">{text.transfer.noRun}</div>
        : <JobCard job={current} text={text} locale={locale} onClear={clearHistory} clearing={clearing} canClear={jobs.some(job => job.status !== 'running')} />}
    </>
  )
}
