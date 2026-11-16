import { randomUUID } from 'node:crypto'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { MigrationBackend } from './migrate.ts'
import type { LogCopy } from './transfer.ts'

export interface CloneNode {
  sourceId: string; targetId: string; source: MigrationBackend
  header: LogCopy['header']; path: string; childIds: readonly string[]; expectedParent?: string
}
export interface CloneTree { nodes: readonly CloneNode[]; ids: ReadonlyMap<string, string> }
/** Only a parent's own durable local catalog entries establish descendant ownership. */
export function localChildIds(copy: LogCopy): string[] {
  const ids = new Set<string>()
  for (const event of copy.events) {
    if (String(event.type) !== 'subagent/catalog' || Number(event.seq) < copy.inheritedEventCount) continue
    const data = event.data as unknown as { childId?: unknown; mode?: unknown; version?: unknown; childCreatedAt?: unknown; label?: unknown }
    const mode = data?.mode
    const versionValid = mode === 'external' ? data?.version === 2 : mode === 'unknown' ? data?.version === 1 : data?.version === 0 || data?.version === 1
    if (!data || !versionValid || !['one-shot', 'continuable', 'unknown', 'external'].includes(String(mode)) || typeof data.childId !== 'string' || !data.childId || data.childId.length > 256
      || typeof data.childCreatedAt !== 'number' || !Number.isSafeInteger(data.childCreatedAt) || data.childCreatedAt < 0
      || (data.label !== undefined && typeof data.label !== 'string') || (mode === 'continuable' && typeof data.label !== 'string')) throw new Error('the parent contains an unsupported subagent catalog record')
    if (mode === 'external') continue
    ids.add(data.childId)
  }
  return [...ids]
}
export async function planCloneTree(
  roots: readonly string[], read: (id: string, explicit: boolean) => Promise<{ source: MigrationBackend; copy: LogCopy; path: string } | undefined>, newRootId?: string, preserveIds = false,
  canRebind?: (childId: string, actualParent: string, copiedParent: string) => Promise<boolean>,
): Promise<CloneTree> {
  const explicit = new Set(roots), ids = new Map<string, string>(), nodes = new Map<string, CloneNode>(), visiting = new Set<string>(), ordered: CloneNode[] = []
  const allocate = (id: string) => {
    if (!ids.has(id)) ids.set(id, preserveIds ? id : explicit.has(id) && newRootId !== undefined ? newRootId : `session-${randomUUID()}`)
    return ids.get(id)!
  }
  for (const id of explicit) allocate(id)
  async function visit(id: string, parent: string | undefined, depth: number): Promise<void> {
    if (depth > 128 || nodes.size >= 4096) throw new Error('the local subagent tree exceeds the supported depth or size')
    if (visiting.has(id)) throw new Error(`cyclic subagent ownership at "${id}"`)
    let node = nodes.get(id)
    if (!node) {
      // Discard the full event array before traversing descendants; planning holds metadata only.
      node = await (async () => {
        const found = await read(id, explicit.has(id))
        if (!found || found.copy.incomplete) throw new Error(`required subagent/session "${id}" is missing or incomplete`)
        if (String(found.copy.header.id) !== id) throw new Error(`session header identity disagrees with "${id}"`)
        return { sourceId: id, targetId: allocate(id), source: found.source, path: found.path, header: found.copy.header, childIds: localChildIds(found.copy), ...(parent === undefined ? {} : { expectedParent: parent }) }
      })()
      nodes.set(id, node)
    }
    if (parent !== undefined) {
      if (node.expectedParent !== undefined && node.expectedParent !== parent) throw new Error(`subagent "${id}" is shared by separately selected parents; clone those conversations separately`)
      const actualParent = String(node.header.parentSession)
      const matches = node.header.origin === 'subagent' && typeof node.header.parentSession === 'string' && (actualParent === parent || await canRebind?.(id, actualParent, parent) === true)
      if (!matches) throw new Error(`subagent "${id}" belongs to "${actualParent}", not "${parent}"; the source tree must be repaired or copied from its original parent`)
      node.expectedParent = parent
    }
    if (ordered.includes(node)) return
    visiting.add(id)
    for (const child of node.childIds) await visit(child, id, depth + 1)
    visiting.delete(id); ordered.push(node)
  }
  for (const id of explicit) await visit(id, undefined, 0)
  if (!preserveIds) for (const id of explicit) {
    const node = nodes.get(id)!
    if (node.header.origin === 'subagent' && node.expectedParent === undefined) throw new Error(`clone subagent "${id}" together with its main conversation so the new parent catalog owns the new child`)
  }
  if (new Set(ids.values()).size !== ids.size) throw new Error('clone target identities collide')
  return { nodes: ordered, ids }
}

type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value)
function sender(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (!record(value) || typeof value.senderSessionId !== 'string' || !ids.has(value.senderSessionId)) return value
  return { ...value, senderSessionId: ids.get(value.senderSessionId) }
}
/** Rewrite typed subagent arguments only; message text and arbitrary UUID-looking strings stay unchanged. */
function argumentsFor(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  let parsed = value
  if (typeof value === 'string') { try { parsed = JSON.parse(value) } catch { return value } }
  function walk(item: unknown): unknown {
    if (Array.isArray(item)) { const next = item.map(walk); return next.some((v, i) => v !== item[i]) ? next : item }
    if (!record(item)) return item
    let changed = false
    const next = Object.fromEntries(Object.entries(item).map(([key, current]) => {
      const result = key === 'agent_id' && typeof current === 'string' ? ids.get(current) ?? current
        : key === 'agent_ids' && Array.isArray(current) ? (() => { const mapped = current.map(id => typeof id === 'string' ? ids.get(id) ?? id : id); return mapped.some((v, i) => v !== current[i]) ? mapped : current })() : walk(current)
      changed ||= result !== current; return [key, result]
    }))
    return changed ? next : item
  }
  const next = walk(parsed)
  return next === parsed ? value : typeof value === 'string' ? JSON.stringify(next) : next
}
function block(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (!record(value) || !Object.hasOwn(value, 'arguments')) return value
  const next = argumentsFor(value.arguments, ids)
  return next === value.arguments ? value : { ...value, arguments: next }
}
export function assertTreeSnapshot(copy: LogCopy, node: CloneNode): void {
  if (String(copy.header.id) !== node.sourceId || copy.header.origin !== node.header.origin || copy.header.parentSession !== node.header.parentSession
    || JSON.stringify(localChildIds(copy)) !== JSON.stringify(node.childIds)) throw new Error(`session "${node.sourceId}" changed its subagent ownership during migration; retry after it is idle`)
}
export function remapClone(copy: LogCopy, node: CloneNode, ids: ReadonlyMap<string, string>): LogCopy {
  assertTreeSnapshot(copy, node)
  const parent = copy.header.origin === 'subagent' && copy.header.parentSession !== undefined ? ids.get(node.expectedParent ?? String(copy.header.parentSession)) : undefined
  if (parent !== undefined && copy.header.parentSession !== node.expectedParent && node.expectedParent !== undefined) ids = new Map([...ids, [String(copy.header.parentSession), parent]])
  const header = { ...copy.header, id: node.targetId as SessionId, ...(parent === undefined ? {} : { parentSession: parent as SessionId }) }
  const events = copy.events.map(event => {
    if (Number(event.seq) < copy.inheritedEventCount || !record(event.data)) return event
    const original = event.data as RecordValue; let data = original
    if (String(event.type) === 'subagent/catalog' && data.mode !== 'external' && typeof data.childId === 'string' && ids.has(data.childId)) data = { ...data, childId: ids.get(data.childId) }
    else if (event.type === 'user/message') { const next = sender(data.source, ids); if (next !== data.source) data = { ...data, source: next } }
    else if (String(event.type) === 'agent/inbox/spliced' && Array.isArray(data.inserted)) data = { ...data, inserted: data.inserted.map(value => { if (!record(value)) return value; const next = sender(value.source, ids); return next === value.source ? value : { ...value, source: next } }) }
    else if (event.type === 'tool/call') { const next = argumentsFor(data.arguments, ids); if (next !== data.arguments) data = { ...data, arguments: next } }
    else if (event.type === 'assistant/message') {
      const message = record(data.message) && Array.isArray(data.message.content) ? { ...data.message, content: data.message.content.map(value => block(value, ids)) } : data.message
      const stream = Array.isArray(data.stream) ? data.stream.map(value => record(value) && record(value.chunk) && Object.hasOwn(value.chunk, 'block') ? { ...value, chunk: { ...value.chunk, block: block(value.chunk.block, ids) } } : value) : data.stream
      if (message !== data.message || stream !== data.stream) data = { ...data, ...(message === data.message ? {} : { message }), ...(stream === data.stream ? {} : { stream }) }
    }
    return data === original ? event : { ...event, data } as unknown as SessionEvent
  })
  return { ...copy, header, events }
}
