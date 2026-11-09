/**
 * The preferences file behind the settings view.
 *
 * Two properties matter and both are about what a broken input does:
 *
 * - reading never throws, so a hand-edited or half-written file cannot stop the
 *   backend from mounting — a typo in one switch must not reset the other two;
 * - writing is validated first and replaced atomically, so a rejected patch
 *   leaves the file exactly as it was and a crash mid-write cannot leave half a
 *   JSON document behind.
 *
 * The third property is that an unusable value is refused rather than stored: a
 * profile that mounts only SQLite must not record "new conversations go to
 * JSONL", because nothing would honour it and the panel would be lying.
 *
 * @module dsh-session-optimizer/tests/preferences
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_FILENAME,
  PreferencesUsageError,
  createPreferencesHost,
  patchOf,
  preferencesPath,
  readPreferences,
  writePreferences,
  type Preferences,
} from '../src/preferences.ts'

const directories: string[] = []

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dshsql-prefs-'))
  directories.push(directory)
  return directory
}

/** A path inside a directory that does not exist yet, to prove mkdir runs. */
async function nestedPath(): Promise<string> {
  const directory = await makeDirectory()
  return preferencesPath(join(directory, 'state'))
}

afterEach(async () => {
  const failures: unknown[] = []
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
  }
  if (failures.length > 0) throw new AggregateError(failures, 'preferences test cleanup failed')
})

describe('reading the preferences file', () => {
  it('answers the defaults when the file is not there', async () => {
    expect(readPreferences(await nestedPath())).toStrictEqual(DEFAULT_PREFERENCES)
  })

  it('falls back field by field, not wholesale', async () => {
    const path = await nestedPath()
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify({ format: 'jsonl', stabilityFixes: 'yes', language: 'klingon' }))
    expect(readPreferences(path)).toStrictEqual({
      format: 'jsonl',
      stabilityFixes: DEFAULT_PREFERENCES.stabilityFixes,
      language: DEFAULT_PREFERENCES.language,
    })
  })

  it('survives a file that is not even JSON', async () => {
    const path = await nestedPath()
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '{ this is not json')
    expect(readPreferences(path)).toStrictEqual(DEFAULT_PREFERENCES)
  })

  it('survives a JSON document that is not an object', async () => {
    const path = await nestedPath()
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '["sqlite"]')
    expect(readPreferences(path)).toStrictEqual(DEFAULT_PREFERENCES)
  })
})

describe('writing the preferences file', () => {
  it('creates the directory 0700 and the file 0600, with no temp file left behind', async () => {
    const path = await nestedPath()
    const preferences: Preferences = { format: 'jsonl', stabilityFixes: false, language: 'en' }
    writePreferences(path, preferences)

    const directoryMode = statSync(join(path, '..')).mode & 0o777
    // The file says where new conversations will be written, so another user on
    // the box has no business editing it.
    if (process.platform !== 'win32') {
      expect(directoryMode).toBe(0o700)
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
    expect(readdirSync(join(path, '..'))).toStrictEqual([PREFERENCES_FILENAME])
    expect(readPreferences(path)).toStrictEqual(preferences)
    // Readable as JSON with a trailing newline: a file an operator can open.
    const raw = readFileSync(path, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(JSON.parse(raw)).toStrictEqual(preferences)
  })

  it('replaces the previous content instead of appending to it', async () => {
    const path = await nestedPath()
    writePreferences(path, { format: 'jsonl', stabilityFixes: false, language: 'en' })
    writePreferences(path, { format: 'sqlite', stabilityFixes: true, language: 'zh' })
    expect(readPreferences(path)).toStrictEqual(DEFAULT_PREFERENCES)
  })
})

describe('validating one patch', () => {
  it('takes only the fields the body names', () => {
    expect(patchOf({ language: 'en' })).toStrictEqual({ language: 'en' })
    expect(patchOf({ format: 'jsonl', stabilityFixes: false })).toStrictEqual({
      format: 'jsonl',
      stabilityFixes: false,
    })
  })

  it('refuses a value it cannot honour', () => {
    // A mistake the panel must hear about rather than a value to ignore.
    for (const body of [
      { format: 'postgres' },
      { format: 1 },
      { stabilityFixes: 'yes' },
      { stabilityFixes: 1 },
      { language: 'klingon' },
      { language: null },
    ]) {
      expect(() => patchOf(body)).toThrow(PreferencesUsageError)
    }
  })

  it('refuses a patch that names nothing', () => {
    // An empty patch would be a request that succeeds and changes nothing, which
    // reads as a broken button.
    expect(() => patchOf({})).toThrow(PreferencesUsageError)
  })

  it('refuses a field that is not a setting', () => {
    // Dropping it silently would let a client believe it saved something. The
    // message quotes the key so the caller can see which one was wrong.
    expect(() => patchOf({ format: 'sqlite', nonsense: 1 })).toThrow(/unknown setting "nonsense"/)
    expect(() => patchOf({ language: 'en', ['x'.repeat(80)]: 1 })).toThrow(/unknown setting "x{32}"/)
  })
})

/** Collect the preferences a host applied, in order. */
function applied(spy: Preferences[]): (preferences: Preferences) => void {
  return (preferences) => { spy.push(preferences) }
}

describe('the preference store', () => {
  it('applies what it read before the first request', async () => {
    const path = await nestedPath()
    writePreferences(path, { format: 'jsonl', stabilityFixes: false, language: 'en' })
    const seen: Preferences[] = []
    const host = createPreferencesHost(path, ['sqlite', 'jsonl'], applied(seen))
    // The running backend is already on the saved switches, not the defaults.
    expect(seen).toStrictEqual([{ format: 'jsonl', stabilityFixes: false, language: 'en' }])
    expect(host.read()).toStrictEqual({ format: 'jsonl', stabilityFixes: false, language: 'en' })
  })

  it('reads a format this build cannot serve as one it can, without rewriting the file', async () => {
    const path = await nestedPath()
    writePreferences(path, { format: 'jsonl', stabilityFixes: true, language: 'zh' })
    const seen: Preferences[] = []
    const host = createPreferencesHost(path, ['sqlite'], applied(seen))
    // The install lost a backend but keeps working; the file still says jsonl so
    // re-adding the backend restores the operator's choice.
    expect(host.read().format).toBe('sqlite')
    expect(readPreferences(path).format).toBe('jsonl')
    expect(seen).toStrictEqual([{ format: 'sqlite', stabilityFixes: true, language: 'zh' }])
  })

  it('persists, applies and answers one patch', async () => {
    const path = await nestedPath()
    const seen: Preferences[] = []
    const host = createPreferencesHost(path, ['sqlite', 'jsonl'], applied(seen))
    const next = host.update({ format: 'jsonl' })
    expect(next).toStrictEqual({ format: 'jsonl', stabilityFixes: true, language: 'zh' })
    expect(seen.at(-1)).toStrictEqual(next)
    expect(readPreferences(path)).toStrictEqual(next)
    expect(host.read()).toStrictEqual(next)
  })

  it('refuses a format it cannot serve and leaves the file untouched', async () => {
    const path = await nestedPath()
    const host = createPreferencesHost(path, ['sqlite'], applied([]))
    expect(() => host.update({ format: 'jsonl' })).toThrow(PreferencesUsageError)
    // Nothing was written: a failed patch is not a half-applied one.
    expect(readPreferences(path)).toStrictEqual(DEFAULT_PREFERENCES)
    expect(host.read()).toStrictEqual(DEFAULT_PREFERENCES)
  })

  it('keeps the switches it was not asked to change', async () => {
    const path = await nestedPath()
    const host = createPreferencesHost(path, ['sqlite', 'jsonl'], applied([]))
    host.update({ stabilityFixes: false })
    const after = host.update({ language: 'en' })
    expect(after).toStrictEqual({ format: 'sqlite', stabilityFixes: false, language: 'en' })
  })

  it('rewrites a file an operator made read-only and says nothing about it', async () => {
    // A `chmod 0400` on the preferences file is a mistake, not a mode: the panel
    // has to be able to change a switch, and `writePreferences` renames over the
    // path rather than opening it for writing, so the mode does not stop it.
    if (process.platform === 'win32') return
    const path = await nestedPath()
    writePreferences(path, DEFAULT_PREFERENCES)
    chmodSync(path, 0o400)
    const host = createPreferencesHost(path, ['sqlite', 'jsonl'], applied([]))
    expect(() => host.update({ language: 'en' })).not.toThrow()
    expect(readPreferences(path).language).toBe('en')
  })

  it('starts from the configured backend when no switch was ever saved', async () => {
    // A hybrid profile says `newSessionBackend: "jsonl"`. Reporting SQLite until
    // the panel writes its own file would not merely print the wrong word: the
    // mount applies what it reads, so it would route new conversations to SQLite.
    const path = await nestedPath()
    const seen: Preferences[] = []
    const host = createPreferencesHost(path, ['sqlite', 'jsonl'], applied(seen), { format: 'jsonl' })
    expect(host.read().format).toBe('jsonl')
    expect(seen).toStrictEqual([{ format: 'jsonl', stabilityFixes: true, language: 'zh' }])
    // A seed is a starting value, not a decision: nothing is written until the
    // operator changes something.
    expect(existsSync(path)).toBe(false)
  })

  it('lets a saved file win over the seed', async () => {
    const path = await nestedPath()
    writePreferences(path, { format: 'sqlite', stabilityFixes: true, language: 'zh' })
    const host = createPreferencesHost(path, ['sqlite', 'jsonl'], applied([]), { format: 'jsonl' })
    expect(host.read().format).toBe('sqlite')
  })

  it('keeps the seed for a file that exists but never named a format', async () => {
    // Hand-editing is supported, so a file can name one switch and not the others.
    // Reading "absent" as "sqlite" would answer a different backend than the
    // profile configured — and the mount applies the answer.
    const path = await nestedPath()
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, '{"language":"en"}', { mode: 0o600 })
    const host = createPreferencesHost(path, ['sqlite', 'jsonl'], applied([]), { format: 'jsonl' })
    expect(host.read()).toStrictEqual({ format: 'jsonl', stabilityFixes: true, language: 'en' })
  })

  it.each([
    ['empty', ''],
    ['truncated', '{"format":"jso'],
    ['null', 'null'],
    ['an array', '[]'],
  ])('keeps the seed when the file is %s', async (_label, content) => {
    const path = await nestedPath()
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, content, { mode: 0o600 })
    const host = createPreferencesHost(path, ['sqlite', 'jsonl'], applied([]), { format: 'jsonl' })
    expect(host.read().format).toBe('jsonl')
  })

  it('keeps the seed when the path is a directory', async () => {
    const path = await nestedPath()
    mkdirSync(path, { recursive: true, mode: 0o700 })
    const host = createPreferencesHost(path, ['sqlite', 'jsonl'], applied([]), { format: 'jsonl' })
    expect(host.read().format).toBe('jsonl')
  })

  it('refuses a seed this mount cannot serve instead of writing it later', async () => {
    // A seed is the profile's configured backend, which a narrower mount may not
    // serve. Coerced at mount so that a later, unrelated patch — which writes
    // `stored` — can never put an unservable format into the file.
    const path = await nestedPath()
    const host = createPreferencesHost(path, ['sqlite'], applied([]), { format: 'jsonl' })
    expect(host.read().format).toBe('sqlite')
    host.update({ language: 'en' })
    expect(readPreferences(path).format).toBe('sqlite')
  })

  it('keeps the stored format when the patch names another switch', async () => {
    // The served value is coerced on a profile that lost a backend; the file must
    // keep the operator's choice, so a language change cannot overwrite it with
    // the coerced value and destroy the routing decision.
    const path = await nestedPath()
    writePreferences(path, { format: 'jsonl', stabilityFixes: true, language: 'zh' })
    const host = createPreferencesHost(path, ['sqlite'], applied([]))
    const next = host.update({ language: 'en' })
    expect(next).toStrictEqual({ format: 'sqlite', stabilityFixes: true, language: 'en' })
    expect(readPreferences(path)).toStrictEqual({ format: 'jsonl', stabilityFixes: true, language: 'en' })
  })
})
