/**
 * The connection release registry.
 *
 * Windows refuses to rename or delete a file this process still has open, and a
 * SQLite handle counts even when it was opened `readOnly: true`. Every executor
 * therefore registers a releaser, and the paths that replace, archive or delete a
 * store ask for the release first. Without that step the operation fails with
 * `EBUSY` and no amount of retrying helps, because the handle is ours.
 *
 * @module dsh-session-optimizer/tests/store-lease
 */

import { mkdtemp, rename, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import * as Plugin from '../src/index.ts'
import { databasePath } from '../src/format.ts'
import { releaseStore } from '../src/store-lease.ts'
import { writeSqliteSession } from '../src/transfer.ts'

const roots: string[] = []
const cleanup: Array<() => Promise<unknown> | void> = []
const settings = { journalMode: 'wal', synchronous: 'full', busyTimeoutMs: 1000 } as const

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-store-lease-'))
  roots.push(path)
  return path
}

function header(id: string, cwd: string): SessionHeader {
  return { version: 4, id: SessionId(id), createdAt: 1700000000000, cwd, isSeeded: false, delegationDepth: 0 }
}

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('store lease', () => {
  it('lets a cached connection go, so the file can be removed', async () => {
    const base = await root()
    const cwd = '/work/lease'
    const path = databasePath(base, cwd, 'session-released' as SessionId)
    await writeSqliteSession(path, { header: header('session-released', cwd), events: [], inheritedEventCount: 0 })

    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    await ctx.plugin(Plugin, { root: base, storageThread: 'inline', writeBatchMaxDelayMs: 60000 })
    // Reading is what caches the handle; nothing in the fixture keeps it besides
    // the executor itself.
    await ctx.sessionPersistence.open('session-released' as SessionId, 'read')
    expect(existsSync(path)).toBe(true)

    // The release is what the transfer paths call before they touch the file.
    await releaseStore(path)
    await expect(rm(path)).resolves.toBeUndefined()
    expect(existsSync(path)).toBe(false)
  })

  it('drops the cached header alongside the connection', async () => {
    const base = await root()
    const cwd = '/work/lease'
    const id = 'session-header-cache' as SessionId
    const path = databasePath(base, cwd, id)
    await writeSqliteSession(path, { header: header('session-header-cache', cwd), events: [], inheritedEventCount: 0 })

    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    await ctx.plugin(Plugin, { root: base, storageThread: 'inline', writeBatchMaxDelayMs: 60000 })
    await ctx.sessionPersistence.list()

    const parked = `${path}.parked`
    await releaseStore(path)
    await expect(rename(path, parked)).resolves.toBeUndefined()

    // The listing must not answer from a cache entry whose file has moved: the
    // same release that frees the handle clears what was remembered about it.
    const listed = await ctx.sessionPersistence.list()
    expect(listed.map((snapshot) => String(snapshot.header.id))).not.toContain(String(id))
  })

  it('is a no-op for a path nothing has open', async () => {
    const base = await root()
    await expect(releaseStore(join(base, 'never-opened', 'session.db'))).resolves.toBeUndefined()
  })

  it('ignores a releaser that throws, so one bad cache cannot block a transfer', async () => {
    const registry = await import('../src/store-lease.ts')
    const unregister = registry.registerStoreReleaser(() => { throw new Error('releaser exploded') })
    try {
      await expect(registry.releaseStore('anything.db')).resolves.toBeUndefined()
    } finally {
      unregister()
    }
  })
})
