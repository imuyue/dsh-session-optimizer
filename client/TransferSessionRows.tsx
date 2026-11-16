import { useEffect, useState } from 'react'
import { fileSizeText } from '@deepseek-ai/dsh-client-ui-primitives'
import { fetchSource } from './api.ts'
import { sourceBadge } from './transfer-contract.ts'
import { hydrateSessionTitles } from './session-titles.ts'
import type { SourceListing, SourceSession } from './types.ts'
import type { Text } from './i18n.ts'

type Props = {
  rows: readonly SourceSession[]; backend: 'sqlite' | 'jsonl'; root: string
  targetLabel: string; picked: readonly string[]; onToggle: (id: string) => void
  text: Text; locale: string; level?: number
}
export function TransferSessionRows(props: Props) {
  const [resolved, setResolved] = useState<{ source: readonly SourceSession[]; rows: readonly SourceSession[] }>({ source: props.rows, rows: props.rows })
  useEffect(() => {
    const controller = new AbortController(), source = props.rows
    setResolved({ source, rows: source })
    if (props.backend === 'jsonl') void hydrateSessionTitles(source, controller.signal, updates => {
      if (controller.signal.aborted) return
      const byId = new Map(updates.map(row => [row.id, row]))
      setResolved(previous => previous.source !== source ? previous : { source, rows: previous.rows.map(row => byId.get(row.id) ?? row).filter(row => row.removed !== true) })
    }, props.root).catch(() => { /* Cancellation belongs to this page generation. */ })
    return () => controller.abort()
  }, [props.rows, props.backend, props.root])
  const rows = resolved.source === props.rows ? resolved.rows : props.rows
  return <>{rows.filter(row => row.removed !== true).map(row => <TransferItem key={row.id} row={row} {...props} />)}</>
}
function TransferItem({ row, ...props }: Props & { row: SourceSession }) {
  const { backend, root, picked, onToggle, text, locale, targetLabel, level = 0 } = props
  const [open, setOpen] = useState(false), [offset, setOffset] = useState(0)
  const [page, setPage] = useState<SourceListing | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setPage(undefined); setError(undefined)
    void fetchSource({ backend, root, parent: row.id, offset, limit: 50 }, controller.signal).then(value => {
      if (!controller.signal.aborted) setPage(value)
    }).catch(problem => { if (!controller.signal.aborted) setError(String(problem)) })
    return () => controller.abort()
  }, [open, offset, row.id, backend, root])
  const checked = picked.includes(row.id), start = page?.offset ?? offset, size = page?.limit ?? 50, total = page?.total ?? 0
  const created = row.createdAt === undefined || !Number.isFinite(row.createdAt) || row.createdAt <= 0 ? '—' : new Date(row.createdAt).toLocaleString(locale, { hour12: false })
  return <>
    <tr data-session-id={row.id} data-clickable="true" data-selected={checked} onClick={() => onToggle(row.id)}>
      <td style={{ width: '40px' }}><input className="dshsql-check" type="checkbox" checked={checked} onChange={() => onToggle(row.id)} onClick={(event: { stopPropagation: () => void }) => event.stopPropagation()} aria-label={text.transfer.selectOne(row.id)} /></td>
      <td style={{ paddingLeft: `${12 + Math.min(level, 8) * 20}px` }}>
        <div className="dshsql-transfer-title">{row.title === undefined || row.title === '' ? row.problem === undefined ? text.overview.untitled : row.id : row.title}
          <span className="dshsql-badge" data-source-backend={backend}>{text.transfer.currentFormat(sourceBadge({ backend }))}</span>
          {row.inTarget === true ? <span className="dshsql-badge">{text.transfer.alreadyIn(targetLabel)}</span> : null}
        </div>
        <div className="dshsql-mono dshsql-muted dshsql-small dshsql-wrap">{row.id}</div>
        {row.problem === undefined ? null : <div className="dshsql-row-problem dshsql-wrap">{row.problem}</div>}
        {(row.childCount ?? 0) === 0 ? null : <button type="button" className="dshsql-btn dshsql-btn-sm" aria-expanded={open} onClick={(event: { stopPropagation: () => void }) => { event.stopPropagation(); setOpen(value => !value) }}>{open ? '▾ ' : '▸ '}{text.overview.childConversations(row.childCount!.toLocaleString(locale))}</button>}
      </td>
      <td className="dshsql-num">{row.detailsPending === true ? '—' : row.eventCount.toLocaleString(locale)}</td>
      <td className="dshsql-num">{fileSizeText(row.sizeBytes)}</td>
      <td className="dshsql-mono dshsql-muted">{created}</td>
    </tr>
    {!open ? null : error !== undefined ? <tr><td colSpan={5} role="alert" className="dshsql-error">{error}</td></tr> : page === undefined ? <tr><td colSpan={5} className="dshsql-muted">{text.overview.reading}</td></tr> : <>
      <TransferSessionRows {...props} rows={page.sessions} level={level + 1} />
      {total <= size ? null : <tr><td colSpan={5}><nav className="dshsql-section-head" aria-label={text.overview.childConversations(total.toLocaleString(locale))}>
        <button type="button" className="dshsql-btn dshsql-btn-sm" disabled={start === 0} onClick={() => setOffset(Math.max(0, start - size))}>{text.transfer.previousPage}</button>
        <span className="dshsql-muted">{text.transfer.pageOf(Math.floor(start / size) + 1, Math.max(1, Math.ceil(total / size)))}</span>
        <button type="button" className="dshsql-btn dshsql-btn-sm" disabled={start + page.sessions.length >= total} onClick={() => setOffset(start + size)}>{text.transfer.nextPage}</button>
      </nav></td></tr>}
    </>}
  </>
}
