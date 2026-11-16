import { fetchSessionTitles } from './api.ts'

export interface TitleRow { id: string; title?: string | undefined; titlePending?: boolean | undefined; problem?: string | undefined; removed?: boolean | undefined }
/** Current-page identities only. Two requests of five, shared by both views. */
export async function hydrateSessionTitles<T extends TitleRow>(rows: readonly T[], signal: AbortSignal, publish: (rows: readonly T[]) => void, root?: string): Promise<void> {
  const pending = rows.filter(row => row.titlePending === true)
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < pending.length) {
      signal.throwIfAborted()
      const expected = pending.slice(cursor, cursor += 5)
      try {
        const answer = await fetchSessionTitles(expected.map(row => row.id), signal, root)
        signal.throwIfAborted()
        const found = new Map(answer.titles.map(row => [row.id, row]))
        publish(expected.map(row => {
          const actual = found.get(row.id)
          return actual === undefined
            ? { ...row, titlePending: false, removed: true }
            : { ...row, title: actual.title, titlePending: false, problem: actual.problem, removed: actual.removed }
        }))
      } catch (error) {
        signal.throwIfAborted()
        publish(expected.map(row => ({ ...row, titlePending: false, problem: error instanceof Error ? error.message : String(error) })))
      }
    }
  }
  await Promise.all([worker(), worker()])
}
