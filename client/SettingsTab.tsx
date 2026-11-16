/**
 * The settings view: which backend new conversations use, whether the plugin's
 * long-conversation fixes run, the language, and the version block.
 *
 * Every string comes from `i18n.ts`. The wording is fixed by the design, so this
 * module never invents a sentence — where a control is unavailable it is drawn
 * disabled instead of explaining itself in new words.
 *
 * Nothing here is optimistic-but-blind: a switch flips in the panel only after the
 * Host answered with the preferences it now holds, so what the operator sees is
 * what the backend will do on the very next append. The row is disabled while the
 * write is in flight, which is what keeps two clicks from racing.
 *
 * The update row is the one place that reports on something outside this machine,
 * so it prints all four answers the Host can give: current, outdated (with the
 * page and the command), not published, and the reason a check could not be made.
 *
 * @module dsh-session-optimizer/client/SettingsTab
 */

import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Language, Text } from './i18n.ts'
import type { PluginAbout, Preferences, SettingsAnswer, UpdateCheck } from './types.ts'
import { PerformanceSettings } from './PerformanceSettings.tsx'

export interface SettingsTabProps {
  readonly text: Text
  readonly answer: SettingsAnswer | undefined
  /** Write one patch; resolves to the preferences the Host now holds. */
  readonly onPatch: (patch: Partial<Preferences>) => Promise<void>
  /** Ask the Host to compare the installed version with the registry. */
  readonly onCheckUpdate: () => Promise<UpdateCheck>
}

function formatOf(value: string | undefined): 'sqlite' | 'jsonl' | undefined {
  return value === 'sqlite' || value === 'jsonl' ? value : undefined
}

export function SettingsTab({ text, answer, onPatch, onCheckUpdate }: SettingsTabProps) {
  const preferences = answer?.preferences
  const formats = answer?.formats ?? []
  const [saving, setSaving] = useState(false)
  const [checking, setChecking] = useState(false)
  /** Absent before the first check: the row says nothing rather than guessing. */
  const [result, setResult] = useState<UpdateCheck | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  // A ref, not the `saving` state: two clicks in the same tick both read the state
  // as it was before the first render, and both would go out. The ref is set
  // before the first await, so the second click sees it.
  const busy = useRef(false)

  const patch = useCallback(
    async (next: Partial<Preferences>): Promise<void> => {
      if (busy.current) return
      busy.current = true
      setSaving(true)
      setFailure(undefined)
      try {
        await onPatch(next)
      } catch (error_: unknown) {
        setFailure(error_ instanceof Error ? error_.message : String(error_))
      } finally {
        busy.current = false
        setSaving(false)
      }
    },
    [onPatch],
  )

  // The check asks the Host, which is the only side that can reach the registry.
  // The previous answer is cleared first: leaving "up to date" on screen while a
  // new check is in flight would make the old answer look like the new one.
  //
  // A throw here means the console route itself refused — not that the registry
  // was unreachable, which the Host reports as a `state` instead. So the panel
  // can always say which of the two happened.
  const check = useCallback((): void => {
    if (checking) return
    setChecking(true)
    setResult(undefined)
    setFailure(undefined)
    void onCheckUpdate()
      .then((next) => { setResult(next) })
      .catch((error_: unknown) => {
        setFailure(error_ instanceof Error ? error_.message : String(error_))
      })
      .finally(() => { setChecking(false) })
  }, [checking, onCheckUpdate])

  const language: Language = preferences?.language ?? 'zh'
  const about: PluginAbout | undefined = answer?.about
  const active = formatOf(preferences?.format)
  const fixes = preferences?.stabilityFixes ?? true
  const note = failure

  // The licence name is printed only when the manifest names one: a hard-coded
  // "MIT" in a translation string would keep saying MIT after the licence changed.
  const licenseName = about?.licenseId === undefined
    ? text.settings.license
    : text.settings.licenseLink(about.licenseId)

  const updateStatus = (): ReactNode => {
    if (result === undefined) return null
    if (result.state === 'up-to-date') {
      return <span className="dshsql-update-status">{text.settings.upToDate(result.current)}</span>
    }
    if (result.state === 'unpublished') {
      return <span className="dshsql-update-status">{text.settings.updateUnpublished}</span>
    }
    if (result.state === 'unavailable') {
      return <span className="dshsql-update-status">{text.settings.updateUnavailable(result.detail)}</span>
    }
    // Outdated: the page for the release, and the command that takes it. Both are
    // answers, not an instruction — the panel does not install anything itself.
    return (
      <div className="dshsql-update-available">
        <span className="dshsql-update-status">{text.settings.updateAvailable(result.latest, result.current)}</span>
        <a className="dshsql-link-button" href={result.page} target="_blank" rel="noreferrer">
          {text.settings.updatePage}
        </a>
        <code className="dshsql-mono dshsql-update-command">{text.settings.updateInstall(result.install)}</code>
      </div>
    )
  }

  return (
    <div className="dshsql-settings">
      {note === undefined ? null : <p className="dshsql-note dshsql-note-warning">{note}</p>}

      {preferences === undefined ? null : (
        <>
          <section className="dshsql-settings-section">
            <h2>{text.settings.storage}</h2>
            <p className="dshsql-setting-label">{text.settings.newFormat}</p>
            <div className="dshsql-format-options" role="group" aria-label={text.settings.newFormat}>
              {(['sqlite', 'jsonl'] as const).map((format) => {
                const enabled = formats.includes(format)
                const selected = active === format
                return (
                  <button
                    key={format}
                    type="button"
                    className="dshsql-format-option"
                    data-active={selected}
                    aria-pressed={selected}
                    disabled={!enabled || saving}
                    onClick={() => { void patch({ format }) }}
                  >
                    <span className="dshsql-format-title">
                      {format === 'sqlite' ? text.settings.sqliteTitle : text.settings.jsonlTitle}
                      {format === 'sqlite' ? (
                        <span className="dshsql-default-badge">{text.settings.default}</span>
                      ) : null}
                    </span>
                    <p>{format === 'sqlite' ? text.settings.sqliteDescription : text.settings.jsonlDescription}</p>
                    <p className="suitable">{format === 'sqlite' ? text.settings.sqliteSuitable : text.settings.jsonlSuitable}</p>
                  </button>
                )
              })}
            </div>
          </section>
        </>
      )}

      <PerformanceSettings
        text={text.settings.performance}
        stabilityControl={preferences === undefined ? undefined : (
          <label className="dshsql-performance-option dshsql-performance-option-secondary">
            <input
              className="dshsql-check"
              type="checkbox"
              checked={fixes}
              disabled={saving}
              onChange={(event: { target: { checked: boolean } }) => { void patch({ stabilityFixes: event.target.checked }) }}
            />
            {text.settings.stability}
          </label>
        )}
      />

      <section className="dshsql-settings-section">
        <div className="dshsql-setting-row">
          <label className="dshsql-setting-label dshsql-setting-label-inline" htmlFor="dshsql-language">{text.settings.language}</label>
          <select
            id="dshsql-language"
            className="dshsql-input dshsql-language-select"
            value={language}
            disabled={saving || preferences === undefined}
            onChange={(event: { target: { value: string } }) => {
              const next = event.target.value
              if (next === 'zh' || next === 'en') void patch({ language: next })
            }}
          >
            <option value="zh">简体中文</option>
            <option value="en">English</option>
          </select>
        </div>
      </section>

      <section className="dshsql-settings-section">
        <h2 className="dshsql-about-title">DSH Session Optimizer</h2>
        <dl className="dshsql-kv dshsql-about-list">
          <div className="dshsql-kv-row">
            <dt>{text.settings.version}</dt>
            <dd>
              <span className="dshsql-mono">{about === undefined ? '—' : `v${about.pluginVersion}`}</span>
              <button
                type="button"
                className="dshsql-btn dshsql-btn-sm"
                disabled={checking || about === undefined}
                onClick={check}
              >
                {checking ? text.settings.checking : text.settings.checkUpdate}
              </button>
              {updateStatus()}
            </dd>
          </div>
          <div className="dshsql-kv-row">
            <dt>{text.settings.build}</dt>
            <dd className="dshsql-mono">{about?.dshVersion === undefined ? '—' : `DSH ${about.dshVersion}`}</dd>
          </div>
          <div className="dshsql-kv-row">
            <dt>{text.settings.repository}</dt>
            <dd>
              {/* The manifest is the only source of a URL; a build that declares
                  none shows the label as plain text rather than a dead link. */}
              {about?.links.repository === undefined ? (
                <span>{text.settings.openRepository}</span>
              ) : (
                <a className="dshsql-link-button" href={about.links.repository} target="_blank" rel="noreferrer">
                  {text.settings.openRepository}
                </a>
              )}
            </dd>
          </div>
          <div className="dshsql-kv-row">
            <dt>{text.settings.support}</dt>
            <dd className="dshsql-about-links">
              {about?.links.feedback === undefined ? (
                <span>{text.settings.feedback}</span>
              ) : (
                <a className="dshsql-link-button" href={about.links.feedback} target="_blank" rel="noreferrer">
                  {text.settings.feedback}
                </a>
              )}
              {about?.links.license === undefined ? (
                <span>{licenseName}</span>
              ) : (
                <a className="dshsql-link-button" href={about.links.license} target="_blank" rel="noreferrer">
                  {licenseName}
                </a>
              )}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  )
}
