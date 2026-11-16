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
 * @module dsh-session-optimizer/client/SettingsTab
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Language, Text } from './i18n.ts'
import type { PluginAbout, Preferences, SettingsAnswer } from './types.ts'
import { PerformanceSettings } from './PerformanceSettings.tsx'

/** How long the update check spins; the design specifies a moment, not a wait. */
const CHECK_DELAY_MS = 500

export interface SettingsTabProps {
  readonly text: Text
  readonly answer: SettingsAnswer | undefined
  /** Write one patch; resolves to the preferences the Host now holds. */
  readonly onPatch: (patch: Partial<Preferences>) => Promise<void>
  /** Re-read the route, which also re-reads the installed manifest. */
  readonly onRefresh: () => Promise<void>
}

function formatOf(value: string | undefined): 'sqlite' | 'jsonl' | undefined {
  return value === 'sqlite' || value === 'jsonl' ? value : undefined
}

export function SettingsTab({ text, answer, onPatch, onRefresh }: SettingsTabProps) {
  const preferences = answer?.preferences
  const formats = answer?.formats ?? []
  const [saving, setSaving] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checked, setChecked] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // A ref, not the `saving` state: two clicks in the same tick both read the state
  // as it was before the first render, and both would go out. The ref is set
  // before the first await, so the second click sees it.
  const busy = useRef(false)

  useEffect(() => () => {
    if (timer.current !== undefined) clearTimeout(timer.current)
  }, [])

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

  // The check asks the Host what version is installed now. There is no update
  // feed to call, so the answer is "you are up to date" unless a newer build has
  // landed on disk since this page booted — in which case the version line itself
  // shows the new number, which is information rather than a sentence.
  //
  // A failed re-read says so instead: `checked` stays false, so the panel cannot
  // print "up to date" about a request that never arrived (and `.finally` would
  // leave the rejection unhandled).
  const check = useCallback((): void => {
    if (checking) return
    setChecking(true)
    setChecked(false)
    setFailure(undefined)
    timer.current = setTimeout(() => {
      onRefresh()
        .then(() => { setChecked(true) })
        .catch((error_: unknown) => {
          setFailure(error_ instanceof Error ? error_.message : String(error_))
        })
        .finally(() => { setChecking(false) })
    }, CHECK_DELAY_MS)
  }, [checking, onRefresh])

  const language: Language = preferences?.language ?? 'zh'
  const about: PluginAbout | undefined = answer?.about
  const active = formatOf(preferences?.format)
  const fixes = preferences?.stabilityFixes ?? true
  const note = failure

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
              {checked ? <span className="dshsql-update-status">{text.settings.upToDate}</span> : null}
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
                <span>{text.settings.license}</span>
              ) : (
                <a className="dshsql-link-button" href={about.links.license} target="_blank" rel="noreferrer">
                  {text.settings.license}
                </a>
              )}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  )
}
