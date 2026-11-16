import { expect, it } from 'vitest'
import { planCloneTree, remapClone, localChildIds } from '../src/clone-tree.ts'
import type { LogCopy } from '../src/transfer.ts'
const source = { id: 'jsonl' as const, root: '/source' }
function copy(id: string, parent?: string, rows: Array<[string, unknown]> = [], inheritedEventCount = 0): LogCopy {
  return { header: { version: 4, id, cwd: '/project', createdAt: 1, isSeeded: inheritedEventCount > 0, delegationDepth: parent ? 1 : 0, ...(parent ? { origin: 'subagent', parentSession: parent } : {}) }, inheritedEventCount,
    events: rows.map(([type, data], seq) => ({ type, data, seq, time: seq + 1 })) } as unknown as LogCopy
}
const edge = (childId: string, mode = 'continuable') => ['subagent/catalog', { version: mode === 'external' ? 2 : mode === 'unknown' ? 1 : 0, childId, childCreatedAt: 1, mode, label: childId }] as [string, unknown]
it('plans leaf-first, ignores external executions, and allocates a new ID for every owned descendant', async () => {
  const logs = new Map([['parent', copy('parent', undefined, [edge('child'), edge('external', 'external')])], ['child', copy('child', 'parent', [edge('nested')])], ['nested', copy('nested', 'child')]])
  const reads: string[] = []
  const plan = await planCloneTree(['parent'], async id => { reads.push(id); const value = logs.get(id); return value ? { source, copy: value, path: '/source/' + id } : undefined }, 'parent-copy')
  expect(plan.nodes.map(node => node.sourceId)).toEqual(['nested', 'child', 'parent'])
  expect(reads).not.toContain('external'); expect(plan.ids.get('parent')).toBe('parent-copy')
  expect([...plan.ids.values()].every(id => !logs.has(id))).toBe(true)
  const child = remapClone(logs.get('child')!, plan.nodes[1]!, plan.ids)
  expect(child.header.parentSession).toBe('parent-copy')
  expect((child.events[0]!.data as unknown as { childId: string }).childId).toBe(plan.ids.get('nested'))
  expect(logs.get('child')!.header.parentSession).toBe('parent')
})
it('rejects unsupported own catalog versions instead of guessing a relationship', () => {
  const value = copy('parent', undefined, [['subagent/catalog', { version: 99, childId: 'child', childCreatedAt: 1, mode: 'continuable', label: 'Child' }]])
  expect(() => localChildIds(value)).toThrow(/unsupported/)
})

it('requires the owning main conversation for a standalone subagent clone', async () => {
  const child = copy('child', 'parent')
  const read = async () => ({ source, copy: child, path: 'child' })
  await expect(planCloneTree(['child'], read)).rejects.toThrow(/together with its main conversation/)
  const overwrite = await planCloneTree(['child'], read, undefined, true)
  expect(overwrite.ids.get('child')).toBe('child')
})

it('keeps inherited catalog facts out of the owned descendant plan', () => {
  const value = copy('fork', undefined, [edge('inherited-child'), edge('own-child')], 1)
  expect(localChildIds(value)).toEqual(['own-child'])
})
it('fails closed on absent, foreign or cyclic ownership', async () => {
  for (const child of [undefined, copy('child', 'foreign')]) {
    const logs = new Map<string, LogCopy>([['parent', copy('parent', undefined, [edge('child')])]])
    if (child) logs.set('child', child)
    await expect(planCloneTree(['parent'], async id => { const value = logs.get(id); return value ? { source, copy: value, path: id } : undefined })).rejects.toThrow(child ? /belongs to/ : /missing or incomplete/)
  }
  const logs = new Map([['parent', copy('parent', 'child', [edge('child')])], ['child', copy('child', 'parent', [edge('parent')])]])
  await expect(planCloneTree(['parent'], async id => ({ source, copy: logs.get(id)!, path: id }))).rejects.toThrow(/cyclic/)
})
it('rewrites only structured control references and preserves inherited events and message text', async () => {
  const original = copy('parent', undefined, [
    edge('old-inherited'), edge('child'),
    ['user/message', { source: { kind: 'subagent', senderSessionId: 'child' }, text: 'child' }],
    ['agent/inbox/spliced', { inserted: [{ source: { senderSessionId: 'child' }, content: 'child' }, 'opaque'] }],
    ['tool/call', { arguments: '{"agent_id":"child","message":"child"}' }],
    ['assistant/message', { message: { content: [{ type: 'tool_use', name: 'send_message', arguments: '{"agent_id":"child"}' }, { type: 'text', text: 'child' }] }, stream: [{ chunk: { type: 'text-delta', text: 'child' } }] }],
  ], 1)
  const logs = new Map([['parent', original], ['child', copy('child', 'parent')]])
  const plan = await planCloneTree(['parent'], async id => ({ source, copy: logs.get(id)!, path: id }), 'parent-copy')
  const result = remapClone(original, plan.nodes.at(-1)!, plan.ids), child = plan.ids.get('child')!
  expect(result.events[0]).toBe(original.events[0])
  expect((result.events[2]!.data as any).source.senderSessionId).toBe(child)
  expect((result.events[2]!.data as any).text).toBe('child')
  expect(JSON.parse((result.events[4]!.data as any).arguments)).toEqual({ agent_id: child, message: 'child' })
  expect(JSON.parse((result.events[5]!.data as any).message.content[0].arguments).agent_id).toBe(child)
  expect((result.events[5]!.data as any).message.content[1].text).toBe('child')
  expect(Object.hasOwn((result.events[5]!.data as any).stream[0].chunk, 'block')).toBe(false)
  expect(JSON.parse((original.events[4]!.data as any).arguments).agent_id).toBe('child')
})
it('rejects a newly added child after planning and preserves IDs for overwrite trees', async () => {
  const original = copy('parent', undefined, [edge('child')]), child = copy('child', 'parent')
  const plan = await planCloneTree(['parent'], async id => ({ source, copy: id === 'parent' ? original : child, path: id }), undefined, true)
  expect([...plan.ids]).toEqual([['parent', 'parent'], ['child', 'child']])
  expect(() => remapClone(copy('parent', undefined, [edge('child'), edge('new-child')]), plan.nodes.at(-1)!, plan.ids)).toThrow(/changed its subagent ownership/)
})
