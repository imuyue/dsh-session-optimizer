import { useEffect, useRef, useState } from 'react'
import { fileSizeText } from '@deepseek-ai/dsh-client-ui-primitives'
import { fetchOverview } from './api.ts'
import { hydrateUsageTitles } from './usage-titles.ts'
import type { Overview, UsageRow } from './types.ts'
import type { Text } from './i18n.ts'

type Props = { rows: readonly UsageRow[]; totalBytes: number; text: Text; locale: string; onMissing: () => void; level?: number }

/** Child rows are fetched only while expanded; each conversation keeps its own totals. */
export function UsageRows(props: Props) {
  return <>{props.rows.filter(row => row.removed !== true).map(row => <UsageItem key={row.id} row={row} {...props} />)}</>
}
function UsageItem({ row, totalBytes, text, locale, onMissing, level = 0 }: Props & { row: UsageRow }) {
  const [open, setOpen] = useState(false)
  const [offset, setOffset] = useState(0)
  const [version, setVersion] = useState(0)
  const [page, setPage] = useState<Overview | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const refreshParent = useRef(onMissing); refreshParent.current = onMissing
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setPage(undefined); setError(undefined)
    void fetchOverview(controller.signal, { parent: row.id, offset, limit: 50 }).then(value => {
      if (controller.signal.aborted) return
      setPage(value)
      return hydrateUsageTitles(value, controller.signal, updates => {
        if (controller.signal.aborted) return
        if (updates.some(item => item.removed === true)) {
          controller.abort(); setVersion(previous => previous + 1); refreshParent.current(); return
        }
        const titles = new Map(updates.map(item => [item.id, item]))
        setPage(current => current === undefined ? current : { ...current, usage: current.usage.map(item => titles.get(item.id) ?? item) })
      })
    }).catch(problem => { if (!controller.signal.aborted) setError(String(problem)) })
    return () => controller.abort()
  }, [open, offset, version, row.id])
  const percent = totalBytes <= 0 ? 0 : row.sizeBytes / totalBytes * 100
  const format = (value: number): string => Number.isFinite(value) ? value.toLocaleString(locale) : '—'
  const size = page?.usageLimit ?? 50, start = page?.usageOffset ?? 0, total = page?.usageTotal ?? 0
  return <>
    <tr data-session-id={row.id}>
      <td style={{ paddingLeft: `${12 + Math.min(level, 8) * 20}px` }}>
        <span className="dshsql-usage-title" title={row.title ?? row.id}>{row.titlePending === true ? text.overview.readingTitle : row.title === undefined || row.title === '' ? row.problem === undefined ? text.overview.untitled : row.id : row.title}</span>
        {row.problem === undefined ? null : <div className="dshsql-row-problem dshsql-wrap">{row.problem}</div>}
        {(row.childCount ?? 0) === 0 ? null : <button type="button" className="dshsql-btn dshsql-btn-sm" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? '▾ ' : '▸ '}{text.overview.childConversations(format(row.childCount!))}</button>}
      </td>
      <td className="dshsql-num">{row.detailsPending === true ? '—' : format(row.eventCount)}</td>
      <td className="dshsql-num">{fileSizeText(row.sizeBytes)}</td>
      <td><div className="dshsql-usage-track"><span style={{ width: `${percent >= 1 ? percent.toFixed(1) : percent.toFixed(2)}%` }} /></div></td>
    </tr>
    {!open ? null : error !== undefined ? <tr><td colSpan={4} role="alert" className="dshsql-error">{error}</td></tr> : page === undefined ? <tr><td colSpan={4} className="dshsql-muted">{text.overview.reading}</td></tr> : <>
      <UsageRows rows={page.usage} totalBytes={totalBytes} text={text} locale={locale} onMissing={onMissing} level={level + 1} />
      {total <= size ? null : <tr><td colSpan={4}><nav className="dshsql-section-head" aria-label={text.overview.childConversations(format(total))}>
        <button type="button" className="dshsql-btn dshsql-btn-sm" disabled={start === 0} onClick={() => setOffset(Math.max(0, start - size))}>{text.transfer.previousPage}</button>
        <span className="dshsql-muted">{text.transfer.pageOf(Math.floor(start / size) + 1, Math.max(1, Math.ceil(total / size)))}</span>
        <button type="button" className="dshsql-btn dshsql-btn-sm" disabled={start + page.usage.length >= total} onClick={() => setOffset(start + size)}>{text.transfer.nextPage}</button>
      </nav></td></tr>}
    </>}
  </>
}
