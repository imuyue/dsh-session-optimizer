import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionBackendCatalog } from '../src/catalog.ts'
import { runMigration } from '../src/migrate.ts'
import { mountJsonl, readJsonlSession, scanSqliteSessions } from '../src/transfer.ts'
for (const mode of ['clone', 'overwrite'] as const) for (const fault of ['missing', 'foreign'] as const) it(`${mode} rejects ${fault} child ownership before publishing any target`, async () => {
  const base = await mkdtemp(join(tmpdir(), 'dso-tree-preflight-')), sourceRoot = join(base, 'jsonl'), targetRoot = join(base, 'sqlite'), cwd = join(base, 'project')
  await mkdir(cwd)
  const jsonl = await mountJsonl(sourceRoot, 'jsonl')
  try {
    const parent = { version: 4, id: 'main' as SessionId, cwd, createdAt: 1, isSeeded: false, delegationDepth: 0 } as SessionHeader
    const writer = await jsonl.persistence.create(parent)
    await writer.append([{ type: 'subagent/catalog', seq: 0, time: 1, data: { version: 0, childId: 'child', childCreatedAt: 1, mode: 'continuable', label: 'Child' } }] as never)
    await writer.flush(); await writer.close()
    if (fault === 'foreign') {
      const child = await jsonl.persistence.create({ ...parent, id: 'child' as SessionId, parentSession: 'other-parent' as SessionId, origin: 'subagent', delegationDepth: 1 })
      await child.append([{ type: 'session/title', seq: 0, time: 1, data: { title: 'Foreign child', messageSeqs: [], source: { kind: 'user' } } }] as never)
      await child.flush(); await child.close()
    }
    const before = await readJsonlSession(sourceRoot, 'main'), catalog = await SessionBackendCatalog.open(join(base, 'state'))
    const report = await runMigration(catalog, { id: 'jsonl', root: sourceRoot, persistence: jsonl.persistence }, { id: 'sqlite', root: targetRoot }, { mode, verify: true, sessions: ['main'], ...(mode === 'clone' ? { newSessionId: 'main-copy' } : {}) })
    expect(report.status).toBe('failed')
    expect(report.error).toMatch(fault === 'missing' ? /missing or incomplete/ : /belongs to/)
    expect(await scanSqliteSessions(targetRoot)).toEqual([])
    expect(await readJsonlSession(sourceRoot, 'main')).toEqual(before)
    expect(catalog.list()).toHaveLength(0)
  } finally { await jsonl.dispose(); await rm(base, { recursive: true, force: true }) }
})
