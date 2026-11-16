import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { readArtifactZstd } from './artifact-zstd.ts'
import { decodeSegment } from './format.ts'
import { listJsonlSessionDirs, readJsonlTitle, readJsonlParent } from './transfer.ts'
import { groupedSessions } from './session-groups.ts'
import type { SourceSession } from './migrate.ts'

interface FileEntry { id: string; path: string; size: number; modified: number; stamp: string }
interface Inventory { at: number; files: readonly FileEntry[]; byId: ReadonlyMap<string, FileEntry> }
const inventories = new Map<string, Inventory>()
const scans = new Map<string, Promise<Inventory>>()
const summaries = new Map<string, SourceSession>()
type Parent = { origin?: 'subagent'; parentSession?: string; problem?: string }
const parents = new Map<string, Parent>()
let parentBytes = 0
const parentCost = (key: string, value: Parent): number => 2 * (key.length + (value.parentSession?.length ?? 0) + (value.problem?.length ?? 0)) + 96
let generation = 0
const latestTitles = new Map<string, string | undefined>()
let titleBytes = 0
const titleCost = (key: string, title: string | undefined): number => 2 * (key.length + (title?.length ?? 0)) + 64
function fileStamp(info: Awaited<ReturnType<typeof stat>>): string { return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}` }
export interface PickerTitle { title: string | undefined; problem?: string | undefined; titlePending?: boolean | undefined }
interface PendingTitle { promise: Promise<string | undefined>; abort: AbortController; users: number }
const pendingTitles = new Map<string, PendingTitle>()
function rememberTitle(key: string, title: string | undefined): void {
  const cost = titleCost(key, title)
  if (cost > 8 * 1024 * 1024) return
  titleBytes += cost - (latestTitles.has(key) ? titleCost(key, latestTitles.get(key)) : 0)
  latestTitles.set(key, title)
  while (titleBytes > 8 * 1024 * 1024 || latestTitles.size > 512) {
    const oldest = latestTitles.keys().next().value!
    titleBytes -= titleCost(oldest, latestTitles.get(oldest)); latestTitles.delete(oldest)
  }
}
function fileIndex(files: readonly FileEntry[]): ReadonlyMap<string, FileEntry> {
  const result = new Map<string, FileEntry>()
  for (const file of files) if (!result.has(file.id)) result.set(file.id, file)
  return result
}
/** The listing already discovered paths. A title batch revalidates only its identities. */
async function selectedFiles(root: string, ids: ReadonlySet<string>, signal?: AbortSignal): Promise<readonly FileEntry[]> {
  signal?.throwIfAborted()
  if (ids.size === 0) return []
  const key = resolve(root)
  let inventory = inventories.get(key)
  if (inventory === undefined || Date.now() - inventory.at >= TTL) {
    const files = await pickerFiles(root)
    inventory = inventories.get(key) ?? { at: Date.now(), files, byId: fileIndex(files) }
  }
  const files: FileEntry[] = []
  for (const id of ids) {
    signal?.throwIfAborted()
    const file = inventory.byId.get(id)
    if (file === undefined) continue
    try {
      const info = await stat(file.path)
      if (info.isFile()) files.push({ ...file, size: info.size, modified: info.mtimeMs, stamp: fileStamp(info) })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') files.push(file)
    }
  }
  signal?.throwIfAborted()
  return files
}
async function sharedTitle(file: FileEntry, key: string, signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted()
  let job = pendingTitles.get(key)
  if (job === undefined || job.abort.signal.aborted) {
    const abort = new AbortController(), captured = generation
    const created: PendingTitle = { abort, users: 0, promise: Promise.resolve(undefined) }
    created.promise = (async () => {
      const title = await readJsonlTitle(file.path, file.id, abort.signal)
      abort.signal.throwIfAborted()
      if (file.stamp !== fileStamp(await stat(file.path))) throw new Error('session changed while reading its title; refresh to retry')
      if (generation === captured) rememberTitle(key, title)
      return title
    })().finally(() => { if (pendingTitles.get(key) === created) pendingTitles.delete(key) })
    pendingTitles.set(key, created); job = created
  }
  const shared = job; shared.users++
  try {
    return await new Promise<string | undefined>((resolve, reject) => {
      const cancel = (): void => { reject(signal?.reason ?? new Error('title read cancelled')) }
      signal?.addEventListener('abort', cancel, { once: true })
      shared.promise.then(value => { signal?.removeEventListener('abort', cancel); resolve(value) }, error => { signal?.removeEventListener('abort', cancel); reject(error) })
      if (signal?.aborted) cancel()
    })
  } finally {
    if (--shared.users === 0) shared.abort.abort()
  }
}
export async function pickerTitles(root: string, ids: ReadonlySet<string>, signal?: AbortSignal): Promise<ReadonlyMap<string, PickerTitle>> {
  const result = new Map<string, PickerTitle>()
  for (const file of await selectedFiles(root, ids, signal)) {
    signal?.throwIfAborted()
    try {
      const key = file.path + '\0' + file.stamp
      const title = latestTitles.has(key) ? latestTitles.get(key) : await sharedTitle(file, key, signal)
      signal?.throwIfAborted()
      result.set(file.id, { title })
    } catch (error) {
      signal?.throwIfAborted()
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') continue
      result.set(file.id, { title: undefined, problem: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}
export async function pickerPreviewTitles(root: string, ids: ReadonlySet<string>, signal?: AbortSignal): Promise<ReadonlyMap<string, PickerTitle>> {
  const result = new Map<string, PickerTitle>()
  for (const file of await selectedFiles(root, ids, signal)) {
    try { const row = await summary(file, signal); result.set(file.id, { title: row.title, titlePending: row.titlePending, problem: row.problem }) }
    catch (error) { signal?.throwIfAborted(); const code = (error as NodeJS.ErrnoException).code; if (code !== 'ENOENT' && code !== 'ENOTDIR') result.set(file.id, { title: undefined, problem: String(error) }) }
  }
  return result
}

const TTL = 60_000
/** Display cache only. Every conversion continues to fully read and validate its source. */
export function forgetPickerInventory(): void { generation++; for (const job of pendingTitles.values()) job.abort.abort(); pendingTitles.clear(); inventories.clear(); scans.clear(); summaries.clear(); latestTitles.clear(); titleBytes = 0; parents.clear(); parentBytes = 0 }
export async function pickerFiles(root: string, refresh = false): Promise<readonly FileEntry[]> {
  const key = resolve(root)
  if (refresh) forgetPickerInventory()
  const active = scans.get(key)
  if (active !== undefined) return (await active).files
  const old = inventories.get(key)
  if (old !== undefined && Date.now() - old.at < TTL) {
    const files: FileEntry[] = []
    for (const file of old.files) {
      try {
        const info = await stat(file.path)
        if (info.isFile()) files.push({ ...file, size: info.size, modified: info.mtimeMs, stamp: fileStamp(info) })
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'ENOTDIR') files.push(file)
      }
    }
    files.sort((a,b) => b.modified - a.modified || a.id.localeCompare(b.id) || a.path.localeCompare(b.path))
    inventories.set(key, { at: old.at, files, byId: fileIndex(files) })
    return files
  }
  const captured = generation
  const scan = (async (): Promise<Inventory> => {
    const files: FileEntry[] = []
    for (const entry of await listJsonlSessionDirs(key)) {
      let path = entry.path
      let info = await stat(path).catch(() => undefined)
      if (info?.isDirectory()) {
        const names = await readdir(path).catch(() => [])
        const name = names.find(n => n.endsWith('.jsonl.zstd')) ?? names.find(n => n.endsWith('.jsonl'))
        if (name === undefined) continue
        path = join(path, name)
        info = await stat(path).catch(() => undefined)
      }
      if (!info?.isFile()) continue
      files.push({ id: decodeSegment(entry.directory) ?? entry.directory, path, size: info.size, modified: info.mtimeMs, stamp: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}` })
    }
    files.sort((a,b) => b.modified - a.modified || a.id.localeCompare(b.id) || a.path.localeCompare(b.path))
    const value = { at: Date.now(), files, byId: fileIndex(files) }
    if (captured === generation) {
      inventories.set(key, value)
      while (inventories.size > 8) inventories.delete(inventories.keys().next().value!)
    }
    return value
  })()
  scans.set(key, scan)
  try { return (await scan).files } finally { if (scans.get(key) === scan) scans.delete(key) }
}
/** Read at most 256 KiB of decoded metadata / 32 lines, never the full message log. */
async function summary(file: FileEntry, signal?: AbortSignal): Promise<SourceSession> {
  signal?.throwIfAborted()
  const key = `${file.path}\0${file.stamp}`
  const old = summaries.get(key)
  if (old !== undefined) return latestTitles.has(key) ? { ...old, title: latestTitles.get(key), titlePending: false } : old
  let title: string | undefined, cwd: string | undefined, createdAt: number | undefined, problem: string | undefined
  const raw = file.path.endsWith('.zstd') ? readArtifactZstd(file.path) : createReadStream(file.path)
  const decoder = new StringDecoder('utf8')
  let pending = '', bytes = 0, lines = 0, header = false, limited = false
  function consume(line: string): void {
    if (line === '') return
    const value: unknown = JSON.parse(line)
    if (typeof value !== 'object' || value === null) return
    const record = value as Record<string, unknown>
    if (record.type === 'session') {
      header = true
      if (record.id !== file.id) problem = 'session header identity disagrees with directory'
      if (typeof record.cwd === 'string') cwd = record.cwd
      if (typeof record.createdAt === 'number') createdAt = record.createdAt
    }
    if (record.type === 'session/title' && typeof record.data === 'object' && record.data !== null) {
      const candidate = (record.data as { title?: unknown }).title
      if (typeof candidate === 'string' && candidate !== '') title = candidate
    }
  }
  try {
    scan: for await (const chunk of raw) {
      signal?.throwIfAborted()
      const buffer = chunk as Buffer
      bytes += buffer.byteLength
      if (bytes > 256 * 1024) { limited = true; break }
      pending += decoder.write(buffer)
      for (;;) {
        const newline = pending.indexOf('\n')
        if (newline < 0) break
        consume(pending.slice(0, newline)); pending = pending.slice(newline + 1)
        if (++lines >= 32) { limited = true; break scan }
      }
    }
    if (bytes <= 256 * 1024 && lines < 32 && pending !== '') consume(pending + decoder.end())
    if (!header) problem ??= 'no readable session header in metadata window'
  } catch (error) {
    signal?.throwIfAborted()
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') throw error
    problem = error instanceof Error ? error.message : String(error)
  } finally { if ('destroy' in raw) raw.destroy() }
  signal?.throwIfAborted()
  if (file.stamp !== fileStamp(await stat(file.path))) throw new Error('session changed while reading its title; refresh to retry')
  if (!limited && problem === undefined) rememberTitle(key, title)
  const confirmed = latestTitles.has(key)
  const value: SourceSession = { id:file.id, title: confirmed ? latestTitles.get(key) : title, titlePending: !confirmed && problem === undefined, eventCount:0, sizeBytes:file.size, createdAt, path:file.path, cwd, problem, detailsPending:true }
  summaries.set(key, value)
  while (summaries.size > 512) summaries.delete(summaries.keys().next().value!)
  return value
}
export async function pickerInventory(root: string, refresh = false, signal?: AbortSignal): Promise<readonly SourceSession[]> {
  const files = await pickerFiles(root, refresh), rows: SourceSession[] = new Array(files.length)
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < files.length) {
      signal?.throwIfAborted()
      const index = cursor++, file = files[index]!, key = `${file.path}\0${file.stamp}`
      let parent = parents.get(key)
      if (parent === undefined) {
        try { parent = await readJsonlParent(file.path, file.id, signal) }
        catch (error) {
          signal?.throwIfAborted()
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ENOENT' || code === 'ENOTDIR') continue
          parent = { problem: String(error).slice(0,512) }
        }
        const cost = parentCost(key, parent)
        if (cost <= 8 * 1024 * 1024) {
          const old = parents.get(key)
          parentBytes += cost - (old === undefined ? 0 : parentCost(key, old)); parents.set(key, parent)
          while (parentBytes > 8 * 1024 * 1024 || parents.size > 4096) {
            const oldest = parents.keys().next().value!
            parentBytes -= parentCost(oldest, parents.get(oldest)!); parents.delete(oldest)
          }
        }
      }
      rows[index] = { id:file.id, title:undefined,eventCount:0,sizeBytes:file.size,createdAt:undefined,path:file.path,cwd:undefined,problem:undefined,detailsPending:true, ...parent }
    }
  }
  await Promise.all([worker(), worker()]); signal?.throwIfAborted()
  return rows.filter(row => row !== undefined)
}
export async function pickerPage(root: string, options: { offset: number; limit: number; query?: string | undefined; refresh?: boolean | undefined; signal?: AbortSignal | undefined; grouped?: boolean | undefined; parent?: string | undefined }): Promise<{ total: number; encoding: 'zstd' | 'none'; sessions: readonly SourceSession[] }> {
  const files = await pickerFiles(root, options.refresh)
  options.signal?.throwIfAborted()
  const query = options.query?.trim().toLowerCase() ?? ''
  if (options.grouped === true) {
    let metadata = [...await pickerInventory(root, false, options.signal)]
    if (query !== '' && options.parent === undefined) {
      const byPath = new Map(files.map(file => [file.path, file]))
      for (let i = 0; i < metadata.length; i++) {
        options.signal?.throwIfAborted()
        const row = metadata[i]!, file = byPath.get(row.path)
        if (!row.id.toLowerCase().includes(query) && file !== undefined) metadata[i] = { ...row, ...await summary(file, options.signal) }
      }
    }
    const matched = groupedSessions(metadata, query, options.parent)
    const byPath = new Map(files.map(file => [file.path, file])), sessions: SourceSession[] = []
    for (const row of matched.slice(options.offset, options.offset + options.limit)) {
      options.signal?.throwIfAborted()
      const file = byPath.get(row.path)
      if (file !== undefined) sessions.push({ ...row, ...await summary(file, options.signal) })
    }
    return { total: matched.length, encoding: files.some(file => file.path.endsWith('.zstd')) ? 'zstd' : 'none', sessions }
  }
  const matched: Array<FileEntry | SourceSession> = []
  if (query !== '') {
    for (const file of files) {
      options.signal?.throwIfAborted()
      if (file.id.toLowerCase().includes(query)) matched.push(file)
      else { const row = await summary(file, options.signal); if ((row.title ?? '').toLowerCase().includes(query)) matched.push(row) }
    }
  } else matched.push(...files)
  const sessions: SourceSession[] = []
  for (const item of matched.slice(options.offset, options.offset + options.limit)) {
    options.signal?.throwIfAborted()
    sessions.push('stamp' in item ? await summary(item, options.signal) : item)
  }
  return { total:matched.length, encoding:files.some(file => file.path.endsWith('.zstd')) ? 'zstd' : 'none', sessions }
}
