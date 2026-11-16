import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { expect, it } from 'vitest'
import { textOf } from '../client/i18n.ts'
type Node = { type: unknown; props: Record<string, unknown> }
function all(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(all)
  if (value && typeof value === 'object' && 'props' in value) return [value, ...all((value as Node).props.children)]
  return [value]
}
it('shows a project warning for an already-created copy instead of claiming complete verification', () => {
  const source = readFileSync(new URL('../client/TransferTab.tsx', import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2024, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const module = { exports: {} as { JobCard(props: unknown): Node } }
  runInNewContext(code + '\nexports.JobCard = JobCard;', { module, exports: module.exports, require(id: string) {
    if (id === 'react/jsx-runtime') return { jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: (type: unknown, props: unknown) => ({ type, props }) }
    if (['react', './api.ts', './TransferSessionRows.tsx', './library.ts', './transfer-pagination.ts', './transfer-contract.ts'].includes(id)) return {}
    throw new Error(id)
  } })
  const text = textOf('zh'), warning = 'The copy exists but its project account could not be preserved'
  const tree = module.exports.JobCard({ job: { status: 'completed', direction: 'jsonl_to_sqlite', mode: 'clone', startedAt: 1, finishedAt: 2, report: { items: [{ sourceSession: 'source', targetSession: 'copy', status: 'migrated', title: 'Copy', error: warning }] } }, text, locale: 'zh-CN', onClear() {}, clearing: false, canClear: true })
  const values = all(tree), words = values.filter(v => typeof v === 'string').join(' ')
  expect(words).toContain(warning)
  expect(words).not.toContain(text.transfer.verified)
  expect(values.some(v => !!v && typeof v === 'object' && 'props' in v && (v as Node).props['data-tone'] === 'warning')).toBe(true)
})
