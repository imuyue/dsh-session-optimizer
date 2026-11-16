/** Disposable read-only worker for optional text preview. No Session is prepared. */
import { parentPort, workerData } from 'node:worker_threads'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionDatabase, type LoadedSession, type SqliteSettings } from './database.ts'
import { findDatabasePath } from './storage.ts'
import type { PreviewAnswer, PreviewMessage } from './history-preview.ts'

// Deliberately fixed to the reviewed 0.2.2 event semantics. In particular,
// image/offload, feedback mutations, compaction and custom projection events
// must fall back instead of being interpreted as unchanged message text.
const PREVIEW_EVENT_TYPES: ReadonlySet<string> = new Set([
  'permission/preset', 'sandbox/mode', 'approval/policy', 'agent/inbox/spliced',
  'turn/start', 'step/start', 'system/message', 'user/message', 'request/header',
  'request/context', 'session/title', 'command/run', 'command/done',
  'assistant/message', 'step/end', 'turn/end', 'tool/call', 'tool/result',
  'goal/change', 'todo/write', 'job/registered', 'job/settled', 'workspace/changes',
  'session/end-seed', 'developer/message', 'assistant/attempt', 'llm/retry',
  'llm/retry-started', 'model/selection',
])

/** Only ordinary append-origin text, never reasoning, tool arguments or metadata. */
export function previewMessages(events: readonly SessionEvent[]): readonly PreviewMessage[] | undefined {
  if (events.some(e => !PREVIEW_EVENT_TYPES.has(e.type) ||
    (e.surfaceOp !== undefined && e.surfaceOp !== 'append') ||
    ((e.type === 'user/message' || e.type === 'assistant/message') && e.surfaceOp !== 'append') ||
    // Append tool/result provenance does not replace earlier surface nodes;
    // its own content is never included. Every other source-bearing event
    // remains outside this advisory text reader's proven subset.
    (e.sourceEventSeqs?.length && e.type !== 'tool/result'))) return undefined
  const messages: PreviewMessage[] = []
  for (let i = events.length - 1; i >= 0 && messages.length < 20; i--) {
    const event = events[i]
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    const data = event.data as unknown
    if (typeof data !== 'object' || data === null) continue
    const record = data as Record<string, unknown>
    const payload = event.type === 'assistant/message' ? record.message : record
    if (typeof payload !== 'object' || payload === null) continue
    const content = (payload as Record<string, unknown>).content
    if (!Array.isArray(content)) continue
    let text = ''
    for (const block of content) {
      if (typeof block !== 'object' || block === null || block.type !== 'text' || typeof block.text !== 'string') continue
      const room = 2000 - text.length
      if (room <= 0) break
      const separator = text ? '\n' : ''
      text += (separator + block.text).slice(0, room)
    }
    if (text.trim() === '') continue
    messages.push({ seq: event.seq, role: event.type === 'user/message' ? 'user' : 'assistant', text })
  }
  return messages.reverse()
}
function answerOf(loaded: LoadedSession, sessionId: string): PreviewAnswer {
  if (loaded.header.id !== sessionId || loaded.state !== 'ready' || loaded.inheritedEventCount !== 0 ||
    (loaded.header.parentSession !== undefined && !loaded.header.isSeeded) ||
    (loaded.header.delegationDepth ?? 0) !== 0 || loaded.header.origin === 'subagent' ||
    loaded.tornTruncateTo !== undefined || loaded.events.length === 0) {
    return { available: false, reason: 'unavailable' }
  }
  const messages = previewMessages(loaded.events)
  if (!messages?.length) return { available: false, reason: 'unavailable' }
  return {
    available: true,
    sessionId,
    from: loaded.events[0].seq,
    to: loaded.events[loaded.events.length - 1].seq + 1,
    total: loaded.eventCount,
    revision: loaded.revision,
    messages,
  }
}
async function run(): Promise<PreviewAnswer> {
  const data: unknown = workerData
  if (typeof data !== 'object' || data === null) return { available: false, reason: 'unavailable' }
  const { root, sessionId, settings } = data as { root: string; sessionId: string; settings: SqliteSettings }
  if (typeof root !== 'string' || typeof sessionId !== 'string') return { available: false, reason: 'unavailable' }
  let database: SessionDatabase | undefined
  try {
    const path = await findDatabasePath(root, SessionId(sessionId))
    if (!path) return { available: false, reason: 'unavailable' }
    database = SessionDatabase.open(path, { ...settings, readOnly: true, repair: false, busyTimeoutMs: 100 })
    const loaded = database.loadPreviewWindow()
    if (!loaded) return { available: false, reason: 'unavailable' }
    if (!database.previewStillCurrent(loaded)) return { available: false, reason: 'unavailable' }
    return answerOf(loaded, sessionId)
  } catch {
    return { available: false, reason: 'unavailable' }
  } finally {
    database?.close()
  }
}
if (parentPort) {
  const port = parentPort
  void run().then(answer => port.postMessage(answer), () => port.postMessage({ available: false, reason: 'unavailable' })).finally(() => port.close())
}
