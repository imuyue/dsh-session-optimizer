/**
 * The three preferences the settings view writes, and the file they live in.
 *
 * They are stored on the Host, not in the browser: "new conversations go to
 * SQLite" is a property of this profile's storage backend, and a preference that
 * only exists in one browser's localStorage would silently disagree with what
 * the backend actually does the next time a different browser opens the panel.
 *
 * The file is small, read once at mount and rewritten whole on every change. It
 * is written atomically (temp file, then rename) and created `0600` inside a
 * `0700` directory, because it names where new conversations will be written —
 * not a secret, but also not something another user on the box needs to edit.
 *
 * A hand-edited file is tolerated field by field: a bad `language` falls back to
 * the default and leaves the other two alone, because a typo in one switch must
 * not reset the two the operator did not touch. The route still validates
 * strictly, so the panel cannot write a value the reader would then ignore.
 *
 * @module dsh-session-optimizer/preferences
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Which backend new conversations are created on. */
export type SessionFormat = 'sqlite' | 'jsonl'

/** Console language. */
export type Language = 'zh' | 'en'

/** Everything the settings view can change. */
export interface Preferences {
  readonly format: SessionFormat
  readonly stabilityFixes: boolean
  readonly language: Language
}

export const DEFAULT_PREFERENCES: Preferences = {
  format: 'sqlite',
  stabilityFixes: true,
  language: 'zh',
}

/** Name of the file inside the profile's state directory. */
export const PREFERENCES_FILENAME = 'console-settings.json'

/** The keys a settings POST may name. */
const SETTINGS_KEYS: ReadonlySet<string> = new Set(['format', 'stabilityFixes', 'language'])

/** Where the preferences for `directory` live. */
export function preferencesPath(directory: string): string {
  return join(directory, PREFERENCES_FILENAME)
}

/**
 * A request the console must answer with a 4xx instead of a 500.
 *
 * Separate from a plain `Error` so the route can tell "the operator asked for
 * something impossible" from "this process is broken".
 */
export class PreferencesUsageError extends Error {
  override readonly name = 'PreferencesUsageError'
}

function asFormat(value: unknown): SessionFormat | undefined {
  return value === 'sqlite' || value === 'jsonl' ? value : undefined
}

function asLanguage(value: unknown): Language | undefined {
  return value === 'zh' || value === 'en' ? value : undefined
}

/**
 * Read the file, keeping whatever is valid in it.
 *
 * Never throws: a missing, unreadable or malformed file reads as `fallback`, so
 * a corrupt preferences file cannot stop the backend from mounting.
 *
 * `fallback` is per field, and defaults to {@link DEFAULT_PREFERENCES}. It exists
 * because "the file says nothing about `format`" and "the file says sqlite" are
 * different facts: a hand-edited file that only carries `{"language":"en"}` must
 * not erase a profile configured for JSONL, and a truncated file must not either.
 */
export function readPreferences(
  path: string,
  fallback: Preferences = DEFAULT_PREFERENCES,
): Preferences {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fallback
  const record = parsed as Record<string, unknown>
  const stability = record.stabilityFixes
  return {
    format: asFormat(record.format) ?? fallback.format,
    stabilityFixes: typeof stability === 'boolean' ? stability : fallback.stabilityFixes,
    language: asLanguage(record.language) ?? fallback.language,
  }
}

/**
 * Replace the file with `preferences`.
 *
 * The rename is what makes a crash mid-write harmless: a reader either sees the
 * old file or the new one, never half of a JSON document. The mode is set on the
 * temp file as well as afterwards, so the content is never briefly world-readable.
 */
export function writePreferences(path: string, preferences: Preferences): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temp = `${path}.${String(process.pid)}.tmp`
  writeFileSync(temp, `${JSON.stringify(preferences, undefined, 2)}\n`, { mode: 0o600 })
  try {
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
  try {
    chmodSync(path, 0o600)
  } catch {
    // A filesystem without modes (a mounted share) still keeps the content.
  }
}

/**
 * Validate a settings POST body into the fields it actually names.
 *
 * Strict on purpose: `format: "postgres"` is a mistake the panel must hear about,
 * not a value to ignore. Absent keys stay absent, so a request can change one
 * switch without restating the other two. A key that is not a setting is refused
 * for the same reason — silently dropping it lets a client believe it saved
 * something it did not.
 */
export function patchOf(body: Record<string, unknown>): Partial<Preferences> {
  const unknown = Object.keys(body).find((key) => !SETTINGS_KEYS.has(key))
  if (unknown !== undefined) {
    throw new PreferencesUsageError(`unknown setting "${unknown.slice(0, 32)}"`)
  }
  const patch: { format?: SessionFormat; stabilityFixes?: boolean; language?: Language } = {}
  if ('format' in body) {
    const format = asFormat(body.format)
    if (format === undefined) throw new PreferencesUsageError('format must be "sqlite" or "jsonl"')
    patch.format = format
  }
  if ('stabilityFixes' in body) {
    if (typeof body.stabilityFixes !== 'boolean') throw new PreferencesUsageError('stabilityFixes must be a boolean')
    patch.stabilityFixes = body.stabilityFixes
  }
  if ('language' in body) {
    const language = asLanguage(body.language)
    if (language === undefined) throw new PreferencesUsageError('language must be "zh" or "en"')
    patch.language = language
  }
  if (Object.keys(patch).length === 0) {
    throw new PreferencesUsageError('name at least one of format, stabilityFixes or language')
  }
  return patch
}

/**
 * What the console needs from the store.
 *
 * `apply` is called with the effective preferences at mount and after every
 * change, so the settings view changes behaviour rather than only recording an
 * intention.
 */
export interface PreferencesHost {
  read(): Preferences
  /** Persist and apply a partial change; throws {@link PreferencesUsageError}. */
  update(body: Record<string, unknown>): Preferences
}

/**
 * Build the store the console talks to.
 *
 * `format` is checked against `formats` before anything is written: a profile
 * that mounts only SQLite cannot route a new conversation to JSONL, and a 400
 * saying so is better than storing a preference nothing honours.
 *
 * `seed` is what the switches read as before the operator has ever saved one —
 * a profile configured with `newSessionBackend: "jsonl"` must not be quietly
 * reported as SQLite just because this panel has not written its file yet. It
 * is only a starting value: nothing is written until the operator changes
 * something.
 *
 * The file and the value in force are kept apart on purpose. A profile that
 * lost a backend serves `formats[0]` while the file still names the operator's
 * choice, so re-enabling that backend restores it; a later change to an
 * unrelated switch must therefore start from the file, not from what is served.
 */
export function createPreferencesHost(
  path: string,
  formats: readonly SessionFormat[],
  apply: (preferences: Preferences) => void,
  seed?: Partial<Preferences>,
): PreferencesHost {
  const servable = (preferences: Preferences): Preferences =>
    formats.includes(preferences.format)
      ? preferences
      : { ...preferences, format: formats[0] ?? DEFAULT_PREFERENCES.format }

  // The seed is the profile's configured backend, which is not necessarily one
  // this mount can serve (a SQLite-only mount seeded with "jsonl"). It is coerced
  // here rather than at first write, so an unrelated patch can never copy an
  // unservable format into the file.
  const seeded: Preferences = servable({ ...DEFAULT_PREFERENCES, ...seed })
  // Per field, and for every failure mode: a file that exists but says only
  // `{"language":"en"}`, an empty or truncated file, `null`, `[]`, or a directory
  // where the file should be all keep the seed instead of falling back to SQLite.
  let stored: Preferences = readPreferences(path, seeded)
  let current = servable(stored)
  apply(current)
  return {
    read: () => current,
    update: (body: Record<string, unknown>) => {
      const patch = patchOf(body)
      // Only a format the caller names is judged: a file that still says
      // "jsonl" on a SQLite-only profile must not block a language change.
      const named = patch.format
      if (named !== undefined && !formats.includes(named)) {
        throw new PreferencesUsageError(`the "${named}" backend is not mounted in this profile`)
      }
      const next: Preferences = { ...stored, ...patch }
      const served = servable(next)
      writePreferences(path, next)
      apply(served)
      stored = next
      current = served
      return served
    },
  }
}
