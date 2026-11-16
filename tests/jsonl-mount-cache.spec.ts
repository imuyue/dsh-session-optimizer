import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { disposeJsonlMounts, mountJsonl, releaseJsonlMount } from '../src/transfer.ts'
const roots: string[] = []
afterEach(async () => { await disposeJsonlMounts(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function directory() { const root = await mkdtemp(join(tmpdir(), 'dso-jsonl-cache-')); roots.push(root); return root }
async function roundtrip(root: string) {
  const mounted = await mountJsonl(root, 'jsonl')
  const id = 'session-cache-fixture' as SessionId
  const header = { version: 4, id, cwd: root, createdAt: 1700000000000, isSeeded: false, delegationDepth: 0 } as SessionHeader
  const writer = await mounted.persistence.create(header)
  await writer.append([{ type: 'session/title', seq: 0, time: 1700000000001, data: { title: 'cache fixture', messageSeqs: [], source: { kind: 'user' } } }] as never)
  await writer.flush(); await writer.close()
  const reader = await mounted.persistence.open(id, 'read')
  try { expect((await reader.read(0)).events).toHaveLength(1) } finally { await reader.close() }
}
it('remounts a disposed JSONL context and releases the new writer on its next disposal', async () => {
  const root = await directory(), first = await mountJsonl(root, 'jsonl')
  await first.dispose()
  const second = await mountJsonl(root, 'jsonl')
  const id = 'session-cache-fixture' as SessionId
  let writer
  try {
    writer = await second.persistence.create({ version: 4, id, cwd: root, createdAt: 1700000000000, isSeeded: false, delegationDepth: 0 } as SessionHeader)
    await writer.append([{ type: 'session/title', seq: 0, time: 1700000000001, data: { title: 'cache fixture', messageSeqs: [], source: { kind: 'user' } } }] as never)
    await writer.flush()
    await second.dispose()
    await releaseJsonlMount(root)
    const third = await mountJsonl(root, 'jsonl')
    const reopened = await third.persistence.open(id, 'write')
    await reopened.close()
  } finally { await writer?.close() }
})
it('does not evict the replacement mount when an old owner is disposed again', async () => {
  const root = await directory(), old = await mountJsonl(root, 'jsonl')
  await releaseJsonlMount(root)
  const replacement = await mountJsonl(root, 'jsonl')
  await old.dispose()
  expect(await mountJsonl(root, 'jsonl')).toBe(replacement)
  await roundtrip(root)
})
