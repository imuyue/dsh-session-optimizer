/**
 * The version block's links, and the git URLs they have to survive.
 *
 * This file exists because of a specific defect: the panel rendered "打开仓库 ↗"
 * over a `git+https://…git` value, which no browser opens — the row looked like a
 * link and was not one. The normalisation is therefore the test subject, not an
 * implementation detail behind the assertions.
 *
 * @module dsh-session-optimizer/tests/about.spec
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { pluginAbout, webUrlOf } from '../src/about.ts'

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string }

describe('webUrlOf', () => {
  it('turns every git form into the page a browser opens', () => {
    const expected = 'https://github.com/owner/repo'
    expect(webUrlOf('git+https://github.com/owner/repo.git')).toBe(expected)
    expect(webUrlOf('git+ssh://git@github.com/owner/repo.git')).toBe(expected)
    expect(webUrlOf('ssh://git@github.com/owner/repo.git')).toBe(expected)
    expect(webUrlOf('git@github.com:owner/repo.git')).toBe(expected)
    expect(webUrlOf('git://github.com/owner/repo.git')).toBe(expected)
    expect(webUrlOf('github:owner/repo')).toBe(expected)
    expect(webUrlOf({ url: 'git+https://github.com/owner/repo.git' })).toBe(expected)
    // `#readme` and a trailing slash name the same page as the bare URL.
    expect(webUrlOf('https://github.com/owner/repo#readme')).toBe(expected)
    expect(webUrlOf('https://github.com/owner/repo/')).toBe(expected)
  })

  it('declines what is not a web address, so the row stays plain text', () => {
    expect(webUrlOf(undefined)).toBeUndefined()
    expect(webUrlOf('')).toBeUndefined()
    expect(webUrlOf({})).toBeUndefined()
    expect(webUrlOf('mailto:someone@example.com')).toBeUndefined()
    expect(webUrlOf('ftp://example.com/repo')).toBeUndefined()
  })
})

describe('pluginAbout', () => {
  it('reports the version on disk and links only a browser can open', () => {
    const about = pluginAbout()
    expect(about.pluginVersion).toBe(manifest.version)
    // A dropdown of three links is only as good as the worst of them.
    for (const link of [about.links.repository, about.links.feedback, about.links.license]) {
      expect(link).toMatch(/^https:\/\//)
      expect(link).not.toContain('git+')
      expect(link).not.toContain('.git')
    }
    expect(about.links.repository).toBe('https://github.com/imuyue/dsh-session-optimizer')
    expect(about.links.feedback).toBe('https://github.com/imuyue/dsh-session-optimizer/issues')
  })

  it('names the licence as an identifier and points at the page defining it', () => {
    const about = pluginAbout()
    expect(about.licenseId).toBe('MIT')
    expect(about.links.license).toBe('https://spdx.org/licenses/MIT.html')
  })
})
