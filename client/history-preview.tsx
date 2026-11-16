import { useEffect, useState } from 'react'
import { performanceFetch } from './performance-transport.ts'
import { acceptHistoryPreview } from './chat-window.ts'
import type { HistoryPreviewAnswer } from './chat-window.ts'

export interface HistoryPreviewProps {
  readonly enabled: boolean
  readonly sessionId: string
  readonly openState: string
  readonly revision: string
  readonly generation: number
}

/** Independent text-only view. It never feeds the controller, projection or agent. */
export function HistoryPreview({ enabled, sessionId, openState, revision, generation }: HistoryPreviewProps) {
  const [preview, setPreview] = useState<HistoryPreviewAnswer | undefined>(undefined)
  const [requestKey, setRequestKey] = useState('')
  const key = `${sessionId}:${revision}:${generation}`
  useEffect(() => {
    setPreview(undefined)
    setRequestKey(key)
    if (!enabled || openState !== 'loading' || !sessionId) return
    const abort = new AbortController()
    let active = true
    // Bound network wait independently of the official open request.
    const timeout = setTimeout(() => abort.abort(), 5000)
    const kickoff = setTimeout(() => {
      if (!active || abort.signal.aborted) return
      void performanceFetch(`history-preview?id=${encodeURIComponent(sessionId)}&revision=${encodeURIComponent(revision)}`, {
      signal: abort.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    }).then(async response => {
      if (!response.ok) return undefined
      // Host is bounded too; do not materialize an unbounded response on the client.
      const declaredLength = Number(response.headers.get('content-length'))
      if (Number.isFinite(declaredLength) && declaredLength > 2 * 1024 * 1024) return undefined
      const reader = response.body?.getReader()
      if (!reader) return undefined
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const item = await reader.read()
          if (item.done) break
          size += item.value.byteLength
          if (size > 2 * 1024 * 1024) { await reader.cancel(); return undefined }
          chunks.push(item.value)
        }
      } finally { reader.releaseLock() }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      return acceptHistoryPreview(JSON.parse(new TextDecoder().decode(bytes)), sessionId, revision, generation)
    }).then(value => {
      if (active && !abort.signal.aborted) setPreview(value)
    }).catch(() => {
      // A missing/expired/unsupported preview leaves the official open unchanged.
    }).finally(() => clearTimeout(timeout))
    }, 120)
    return () => { active = false; abort.abort(); clearTimeout(kickoff); clearTimeout(timeout) }
  }, [enabled, sessionId, openState, revision, generation])

  // The generation/open state gate applies during render, before effect cleanup runs.
  if (!enabled || openState !== 'loading' || requestKey !== key || !preview?.messages.length) return null
  return <section
    aria-label="只读历史预览"
    data-dso-history-preview=""
    style={{ border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: 12, marginBottom: 12 }}
  >
    <p role="status" style={{ margin: '0 0 8px', color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }}>
      最近消息预览 · 完整对话加载中
    </p>
    {preview.messages.map(message => <article key={message.seq} style={{ marginTop: 8 }}>
      <small style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{message.role === 'user' ? '用户' : '助手'}</small>
      <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 360, overflow: 'auto' }}>{message.text}</div>
    </article>)}
  </section>
}
