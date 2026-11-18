/** Bounded, optional plain-text loading preview; never a restored session. */
import { Worker } from 'node:worker_threads'
import { workerRuntimeExecArgv } from './worker-runtime.ts'
import type { SqliteSettings } from './database.ts'

export interface PreviewMessage {
  readonly seq: number
  readonly role: 'user' | 'assistant'
  readonly text: string
}
export type PreviewAnswer = {
  readonly available: false
  readonly reason: 'busy' | 'timeout' | 'aborted' | 'disposed' | 'unavailable' | 'invalid-request'
} | {
  readonly available: true
  readonly sessionId: string
  readonly from: number
  readonly to: number
  readonly total: number
  readonly revision: number
  readonly messages: readonly PreviewMessage[]
}
interface PreviewJob {
  readonly worker: Worker
  settle(answer: PreviewAnswer): void
}
function workerSource(): { url: URL; execArgv: string[] } {
  // See `workerSource` in worker-client.ts: the entry graph is strip-only clean,
  // and Node 26 rejects the transform-types flag instead of ignoring it.
  return import.meta.url.endsWith('.ts')
    ? { url: new URL('./preview-worker.ts', import.meta.url), execArgv: [] }
    : { url: new URL('./preview-worker.js', import.meta.url), execArgv: [] }
}
function validAnswer(value: unknown, sessionId: string): value is PreviewAnswer {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.available === false) return record.reason === 'unavailable'
  if (record.available !== true || record.sessionId !== sessionId) return false
  if (![record.from, record.to, record.total, record.revision].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) return false
  if ((record.from as number) >= (record.to as number) || (record.to as number) > (record.total as number)) return false
  if (!Array.isArray(record.messages) || record.messages.length > 20) return false
  let last = -1
  return record.messages.every((message: unknown) => {
    if (typeof message !== 'object' || message === null) return false
    const m = message as Record<string, unknown>
    if (typeof m.seq !== 'number' || !Number.isSafeInteger(m.seq) || m.seq <= last || m.seq < (record.from as number) || m.seq >= (record.to as number)) return false
    last = m.seq
    return (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.length <= 2000
  })
}

/** One worker at a time. Busy/abort/failure simply decline this optional path. */
export class PreviewReader implements Disposable {
  private active: PreviewJob | undefined
  private disposed = false
  private terminating: Promise<unknown> | undefined
  private readonly root: string
  private readonly settings: SqliteSettings
  private readonly timeoutMs: number

  constructor(
    root: string,
    settings: SqliteSettings,
    timeoutMs = 1500,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1500) throw new RangeError('preview timeout must be between 1 and 1500ms')
    this.root = root
    this.settings = settings
    this.timeoutMs = timeoutMs
  }

  read(sessionId: string, signal?: AbortSignal): Promise<PreviewAnswer> {
    if (this.disposed) return Promise.resolve({ available: false, reason: 'disposed' })
    if (signal?.aborted) return Promise.resolve({ available: false, reason: 'aborted' })
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 512) return Promise.resolve({ available: false, reason: 'invalid-request' })
    if (this.active || this.terminating) return Promise.resolve({ available: false, reason: 'busy' })
    let worker: Worker
    try {
      const source = workerSource()
      worker = new Worker(source.url, {
        execArgv: workerRuntimeExecArgv(source.execArgv),
        workerData: { root: this.root, settings: this.settings, sessionId },
      })
    } catch {
      return Promise.resolve({ available: false, reason: 'unavailable' })
    }
    return new Promise<PreviewAnswer>(resolve => {
      let settled = false
      const timer = setTimeout(() => finish({ available: false, reason: 'timeout' }), this.timeoutMs)
      timer.unref()
      const abort = () => finish({ available: false, reason: 'aborted' })
      const message = (answer: unknown) => finish(validAnswer(answer, sessionId) ? answer : { available: false, reason: 'unavailable' })
      const failed = () => finish({ available: false, reason: 'unavailable' })
      const finish = (answer: PreviewAnswer) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        worker.removeListener('message', message)
        worker.removeListener('error', failed)
        worker.removeListener('exit', failed)
        // Keep an error sink until terminate settles, then remove all own listeners.
        const ignore = () => undefined
        worker.on('error', ignore)
        const termination = worker.terminate().catch(() => undefined).finally(() => {
          worker.removeListener('error', ignore)
          if (this.active?.worker === worker) this.active = undefined
          if (this.terminating === termination) this.terminating = undefined
        })
        this.terminating = termination
        resolve(answer)
      }
      this.active = { worker, settle: finish }
      worker.once('message', message)
      worker.once('error', failed)
      worker.once('exit', failed)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  }

  /** Idempotently settle the caller and terminate any remaining optional work. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.active?.settle({ available: false, reason: 'disposed' })
  }

  async close(): Promise<void> { this.dispose(); await this.terminating }
  [Symbol.dispose](): void { this.dispose() }
}
