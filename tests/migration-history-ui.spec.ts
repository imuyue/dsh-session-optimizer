import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { textOf } from '../client/i18n.ts'
import * as pagination from '../client/transfer-pagination.ts'
type Node = { type: unknown; props: Record<string, unknown> }
const jsx = (type: unknown, props: Record<string, unknown>): Node => ({ type, props })
function nodes(value: unknown): Node[] { if (Array.isArray(value)) return value.flatMap(nodes); if (!value || typeof value !== 'object' || !('props' in value)) return []; const n = value as Node; return [n, ...nodes(n.props.children)] }
async function mount(status: string) {
  const jobs = [{ id: 'test-job', status, direction: 'jsonl_to_sqlite', mode: 'overwrite', startedAt: 1700000000000, notice: status === 'running' ? '对话正在运行，结束后自动继续转换。' : undefined }]
  let history = jobs, cursor = 0; const state: unknown[] = [], effects: (() => void)[] = []
  const clear = vi.fn(async () => { history = []; return { cleared: 1, retainedRunning: 0 } })
  const react = { useState(initial: unknown) { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], (v: unknown) => { state[i] = typeof v === 'function' ? (v as (old: unknown) => unknown)(state[i]) : v }] }, useRef(initial: unknown) { const i = cursor++; return state[i] ??= { current: initial } }, useMemo(f: () => unknown) { cursor++; return f() }, useCallback(f: unknown) { cursor++; return f }, useEffect(f: () => void | (() => void), deps: unknown[]) { const i = cursor++, old = state[i] as { deps: unknown[]; close?: () => void } | undefined; if (!old || deps.some((v, i) => !Object.is(v, old.deps[i]))) effects.push(() => { old?.close?.(); state[i] = { deps, close: f() } }) } }
  const module = { exports: {} as { TransferTab: (props: unknown) => Node } }
  const code = ts.transpileModule(readFileSync(new URL('../client/TransferTab.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2024, jsx: ts.JsxEmit.ReactJSX } }).outputText
  runInNewContext(code, { module, exports: module.exports, AbortController, setTimeout: () => 1, clearTimeout() {}, window: { setTimeout: () => 1 }, require(id: string) { if (id === 'react') return react; if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: Symbol.for('fragment') }; if (id === './api.ts') return { fetchRoots: async () => [], fetchMigrations: async () => ({ available: true, jobs: history }), clearMigrations: clear }; if (id === './TransferSessionRows.tsx') return { TransferSessionRows: () => null }; if (id === './library.ts') return { announceLibraryChanged() {} }; if (id === './transfer-pagination.ts') return pagination; throw Error(id) } })
  const render = () => { cursor = 0; const tree = module.exports.TransferTab({ text: textOf('zh'), locale: 'zh-CN' }); while (effects.length) effects.shift()!(); return tree }
  render(); await new Promise<void>(resolve => setImmediate(resolve))
  const card = (tree: Node) => { const child = nodes(tree).find(n => typeof n.type === 'function' && n.type.name === 'JobCard'); return child ? (child.type as (props: unknown) => Node)(child.props) : undefined }
  return { render, card, clear }
}
it('the actual recent-conversion button clears finished records through the shared API and removes the card', async () => {
  const f = await mount('completed'), tree = f.card(f.render())!
  const button = nodes(tree).find(n => n.type === 'button' && n.props.children === '清空记录')!
  expect(button.props.disabled).toBe(false)
  ;(button.props.onClick as () => void)(); await new Promise<void>(resolve => setImmediate(resolve))
  expect(f.clear).toHaveBeenCalledOnce(); expect(f.card(f.render())).toBeUndefined()
})
it('a running conversion keeps its wait notice and cannot be erased by clearing history', async () => {
  const f = await mount('running'), tree = f.card(f.render())!
  expect(nodes(tree).find(n => n.type === 'button')!.props.disabled).toBe(true)
  expect(nodes(tree).some(n => n.props.children === '对话正在运行，结束后自动继续转换。')).toBe(true)
  expect(f.clear).not.toHaveBeenCalled()
})
