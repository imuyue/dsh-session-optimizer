/**
 * The update check, driven the way the console route drives it.
 *
 * Two things are under test, and they fail differently. Version precedence is
 * pure arithmetic and either matches the semver specification or does not — a
 * mistake there tells an operator on a prerelease that the final release is older
 * than what they run. The fetch layer is all edge cases: no network, a proxy
 * answering 500, a registry that answers HTML, a name that was never published.
 * None of those may throw, because the route has nowhere to put an exception and
 * the panel would sit on its spinner.
 *
 * @module dsh-session-optimizer/tests/update.spec
 */

import { describe, expect, it } from 'vitest'
import { PACKAGE_NAME, checkForUpdate, compareVersions } from '../src/update.ts'
import type { UpdateFetch } from '../src/update.ts'

/** A fetch that answers with one status and one body, and records the URL. */
function answering(status: number, body: unknown): { fetchImpl: UpdateFetch; seen: string[] } {
  const seen: string[] = []
  const fetchImpl: UpdateFetch = async (url) => {
    seen.push(url)
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }
  return { fetchImpl, seen }
}

const packument = (latest: string): unknown => ({ name: PACKAGE_NAME, 'dist-tags': { latest } })

describe('compareVersions', () => {
  it('orders by each numeric field, not by string comparison', () => {
    expect(compareVersions('0.1.27', '0.1.9')).toBe(1)
    expect(compareVersions('0.1.9', '0.1.27')).toBe(-1)
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
    expect(compareVersions('0.1.27', '0.1.27')).toBe(0)
  })

  it('treats a missing field as zero and tolerates a v prefix and a build metadatum', () => {
    expect(compareVersions('0.1', '0.1.0')).toBe(0)
    expect(compareVersions('v0.1.27', '0.1.27')).toBe(0)
    expect(compareVersions('0.1.27+build.5', '0.1.27')).toBe(0)
  })

  it('sorts a prerelease below its release, and a numeric identifier below an alphanumeric one', () => {
    expect(compareVersions('0.2.0-rc.1', '0.2.0')).toBe(-1)
    expect(compareVersions('0.2.0', '0.2.0-rc.1')).toBe(1)
    expect(compareVersions('0.2.0-rc.2', '0.2.0-rc.10')).toBe(-1)
    expect(compareVersions('0.2.0-2', '0.2.0-alpha')).toBe(-1)
    expect(compareVersions('0.2.0-rc', '0.2.0-rc.1')).toBe(-1)
  })

  it('refuses to compare what is not a version', () => {
    expect(compareVersions('latest', '0.1.0')).toBeUndefined()
    expect(compareVersions('0.1.0', '')).toBeUndefined()
    expect(compareVersions('0.1.0.0', '0.1.0')).toBeUndefined()
  })
})

describe('checkForUpdate', () => {
  it('asks the registry for this package and reports a newer release with a page and a command', async () => {
    const { fetchImpl, seen } = answering(200, packument('0.2.0'))
    const answer = await checkForUpdate('0.1.27', { registry: 'https://registry.npmjs.org', fetchImpl })
    expect(seen).toEqual([`https://registry.npmjs.org/${PACKAGE_NAME}`])
    expect(answer).toEqual({
      state: 'outdated',
      current: '0.1.27',
      latest: '0.2.0',
      page: `https://www.npmjs.com/package/${PACKAGE_NAME}/v/0.2.0`,
      install: `dsh plugin add ${PACKAGE_NAME}@0.2.0`,
    })
  })

  it('reports the version it compared when the registry agrees, and when a local build is ahead', async () => {
    const same = await checkForUpdate('0.1.27', { fetchImpl: answering(200, packument('0.1.27')).fetchImpl })
    expect(same).toEqual({ state: 'up-to-date', current: '0.1.27', latest: '0.1.27' })
    // A build ahead of the registry is not an update: offering one would invite a
    // downgrade.
    const ahead = await checkForUpdate('0.3.0', { fetchImpl: answering(200, packument('0.2.0')).fetchImpl })
    expect(ahead).toEqual({ state: 'up-to-date', current: '0.3.0', latest: '0.2.0' })
  })

  it('calls a 404 unpublished rather than a failure', async () => {
    const answer = await checkForUpdate('0.1.27', { fetchImpl: answering(404, {}).fetchImpl })
    expect(answer).toEqual({ state: 'unpublished', current: '0.1.27' })
  })

  it('turns every other failure into a state instead of a throw', async () => {
    const cases: Array<[string, UpdateFetch, RegExp]> = [
      ['a 500', answering(500, {}).fetchImpl, /HTTP 500/],
      ['a body that is not JSON', async () => ({
        ok: true, status: 200,
        json: async () => { throw new SyntaxError('Unexpected token <') },
      }), /not JSON/],
      ['a packument with no dist-tags', answering(200, { name: PACKAGE_NAME }).fetchImpl, /no latest version/],
      ['an unparsable latest', answering(200, packument('nightly')).fetchImpl, /cannot compare/],
      ['a dead socket', async () => { throw new TypeError('fetch failed') }, /fetch failed/],
      ['a timeout', async () => {
        const error = new Error('The operation was aborted due to timeout')
        error.name = 'TimeoutError'
        throw error
      }, /did not answer within 8s/],
    ]
    for (const [label, fetchImpl, expected] of cases) {
      const answer = await checkForUpdate('0.1.27', { fetchImpl })
      expect(answer.state, label).toBe('unavailable')
      expect(answer.state === 'unavailable' ? answer.detail : '', label).toMatch(expected)
      expect(answer.current, label).toBe('0.1.27')
    }
  })

  it('follows the registry the profile configured, and refuses a scheme it cannot fetch', async () => {
    const mirror = answering(200, packument('0.1.27'))
    await checkForUpdate('0.1.27', { registry: 'https://mirror.example/npm/', fetchImpl: mirror.fetchImpl })
    expect(mirror.seen).toEqual([`https://mirror.example/npm/${PACKAGE_NAME}`])

    const fallback = answering(200, packument('0.1.27'))
    await checkForUpdate('0.1.27', { registry: 'ftp://mirror.example', fetchImpl: fallback.fetchImpl })
    expect(fallback.seen).toEqual([`https://registry.npmjs.org/${PACKAGE_NAME}`])
  })

  it('reads NPM_CONFIG_REGISTRY when the caller names none', async () => {
    const previous = process.env['NPM_CONFIG_REGISTRY']
    process.env['NPM_CONFIG_REGISTRY'] = 'https://corp.example/registry/'
    try {
      const fromEnvironment = answering(200, packument('0.1.27'))
      await checkForUpdate('0.1.27', { fetchImpl: fromEnvironment.fetchImpl })
      expect(fromEnvironment.seen).toEqual([`https://corp.example/registry/${PACKAGE_NAME}`])

      const explicit = answering(200, packument('0.1.27'))
      await checkForUpdate('0.1.27', { registry: 'https://other.example', fetchImpl: explicit.fetchImpl })
      expect(explicit.seen).toEqual([`https://other.example/${PACKAGE_NAME}`])
    } finally {
      if (previous === undefined) delete process.env['NPM_CONFIG_REGISTRY']
      else process.env['NPM_CONFIG_REGISTRY'] = previous
    }
  })
})
