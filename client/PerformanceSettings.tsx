import type { ReactNode } from 'react'
import type { Text } from './i18n.ts'
import { textOf } from './i18n.ts'
import { disablePerformance, updatePerformance, usePerformance, type PerformanceFlags } from './performance-client.ts'

/** Always outside the replaced chat slot: recovery remains reachable. */
export function PerformanceSettings({ text = textOf('zh').settings.performance, stabilityControl }: { text?: Text['settings']['performance']; stabilityControl?: ReactNode } = {}) {
  const view = usePerformance()
  const flags = view.state?.desired
  const busy = view.status !== 'ready' || view.saving
  const save = (patch: Partial<PerformanceFlags>) => { void updatePerformance(patch).catch(() => undefined) }
  const controls = [
    { key: 'historyWindow' as const, title: text.historyWindow },
    { key: 'virtualChat' as const, title: text.virtualChat },
  ]
  return <section className="dshsql-settings-section" aria-label={text.title}>
    <h2>{text.title}</h2>
    <div className="dshsql-performance-options">
      <label className="dshsql-performance-option">
        <input className="dshsql-check" type="checkbox" checked={flags?.enabled === true} disabled={busy} onChange={(event: { target: { checked: boolean } }) => save({ enabled: event.target.checked })} />
        {text.enabled}
      </label>
      {controls.map(({ key, title }) => <label className="dshsql-performance-option dshsql-performance-option-secondary" key={key}>
        <input className="dshsql-check" type="checkbox" checked={flags?.[key] === true} disabled={busy || flags?.enabled !== true || view.state?.capabilities[key].supported !== true} onChange={(event: { target: { checked: boolean } }) => save({ [key]: event.target.checked })} />
        {title}
      </label>)}
      {stabilityControl}
    </div>
    <div className="dshsql-performance-actions">
      <button type="button" className="dshsql-btn dshsql-btn-sm" onClick={() => { void disablePerformance().catch(() => undefined) }}>
        {text.restore}
      </button>
      {view.saving || view.status === 'loading' ? <span className="dshsql-performance-status" role="status">{view.saving ? text.saving : text.syncing}</span> : null}
    </div>
    {view.error ? <p className="dshsql-note dshsql-note-warning dshsql-performance-error" role="alert">{view.error}</p> : null}
  </section>
}
