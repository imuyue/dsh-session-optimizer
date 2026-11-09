/**
 * Two questions the panel could not answer: what went wrong, and what an
 * uninstall would cost.
 *
 * Both are read on demand rather than polled. The diagnostic ring only changes
 * when something goes wrong, and the uninstall check walks both roots — doing
 * that on a timer would spend the operator's CPU to tell them nothing new.
 *
 * @module dsh-session-optimizer/client/DiagnosticsTab
 */

import { useCallback, useEffect, useState } from 'react'
import {
  clearDiagnostics,
  fetchDiagnostics,
  fetchUninstallCheck,
} from './api.ts'
import type { Text } from './i18n.ts'
import type { DiagnosticsAnswer, UninstallReport } from './types.ts'

interface Props {
  readonly text: Text
  readonly locale: string
}

function stamp(at: number | undefined, locale: string): string {
  if (at === undefined) return '—'
  return new Date(at).toLocaleString(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

export function DiagnosticsTab({ text, locale }: Props) {
  const copy = text.diagnostics
  const [answer, setAnswer] = useState<DiagnosticsAnswer | undefined>(undefined)
  const [report, setReport] = useState<UninstallReport | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      setAnswer(await fetchDiagnostics(signal))
    } catch (error) {
      if (!signal?.aborted) setFailure(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    const abort = new AbortController()
    void load(abort.signal)
    return () => { abort.abort() }
  }, [load])

  const clear = useCallback(async (): Promise<void> => {
    // One click, one request: a second in the same tick would clear an entry the
    // first one has not yet reported back.
    if (busy) return
    setBusy(true)
    try {
      await clearDiagnostics()
      setFailure(undefined)
      await load()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [busy, load])

  const check = useCallback(async (): Promise<void> => {
    if (checking) return
    setChecking(true)
    try {
      setReport(await fetchUninstallCheck())
      setFailure(undefined)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setChecking(false)
    }
  }, [checking])

  const entries = answer?.entries ?? []
  const orphaned = report?.orphaned ?? []
  const unreadable = report?.unreadable ?? []

  return (
    <div className="dshsql-diagnostics">
      {failure === undefined ? null : <p className="dshsql-error">{failure}</p>}

      <section className="dshsql-settings-section">
        <div className="dshsql-setting-row">
          <h2>{copy.uninstallTitle}</h2>
          <button type="button" className="dshsql-btn dshsql-btn-sm" onClick={() => { void check() }} disabled={checking}>
            {checking ? copy.checking : copy.check}
          </button>
        </div>
        <p className="dshsql-note">{copy.uninstallHint}</p>
        {report === undefined
          ? null
          : report.available === false
            ? <p className="dshsql-note">{copy.unavailable}</p>
            : (
              <div className="dshsql-uninstall">
                <p className={report.ok === true ? 'dshsql-note' : 'dshsql-note-warning'}>
                  {report.ok === true
                    ? copy.resultOk(String(report.sqlite ?? 0), String(report.jsonl ?? 0))
                    : (
                      <>
                        {(report.orphaned?.length ?? 0) === 0 ? null : <>{copy.resultOrphaned(String(orphaned.length))} </>}
                        {(report.unreadable?.length ?? 0) === 0 ? null : <>{copy.resultUnreadable(String(unreadable.length))}</>}
                      </>
                    )}
                </p>
                <p className="dshsql-small">{copy.checkedAt(stamp(report.checkedAt, locale))}</p>
                {orphaned.length === 0 ? null : (
                  <>
                    <h3 className="dshsql-setting-label">{copy.orphanedTitle}</h3>
                    <ul className="dshsql-plain-list">
                      {orphaned.map((id) => <li key={id}><code>{id}</code></li>)}
                    </ul>
                  </>
                )}
                {unreadable.length === 0 ? null : (
                  <>
                    <h3 className="dshsql-setting-label">{copy.unreadableTitle}</h3>
                    <ul className="dshsql-plain-list">
                      {unreadable.map((item) => <li key={item.id}><code>{item.id}</code> · {item.error}</li>)}
                    </ul>
                  </>
                )}
              </div>
            )}
      </section>

      <section className="dshsql-settings-section">
        <div className="dshsql-setting-row">
          <h2>{copy.logTitle}</h2>
          <button type="button" className="dshsql-btn dshsql-btn-sm" onClick={() => { void clear() }} disabled={busy || entries.length === 0}>
            {copy.clear}
          </button>
        </div>
        {entries.length === 0
          ? <p className="dshsql-empty">{copy.empty}</p>
          : (
            <div className="dshsql-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{copy.columns.at}</th>
                    <th>{copy.columns.level}</th>
                    <th>{copy.columns.scope}</th>
                    <th>{copy.columns.message}</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry, index) => (
                    <tr key={`${String(entry.at)}-${String(index)}`} data-tone={entry.level === 'error' ? 'danger' : undefined}>
                      <td>{stamp(entry.at, locale)}</td>
                      <td>{entry.level}</td>
                      <td>{entry.scope}</td>
                      <td>{entry.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </section>
    </div>
  )
}
