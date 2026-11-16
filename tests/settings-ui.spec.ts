import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { beforeEach, expect, it, vi } from 'vitest'
import { textOf } from '../client/i18n.ts'

// Exercise the real JSX-returning components without shipping a second React
// installation. Effects are inactive; this checks controls, order and callbacks,
// not browser layout or React scheduling.
type Node = { type: string | symbol | ((props: Record<string, unknown>) => unknown); props: Record<string, unknown> }
const jsx = (type: Node['type'], props: Node['props']): Node => ({ type, props })
const react = {
  useCallback: (fn: unknown) => fn, useEffect: () => undefined,
  useMemo: (fn: () => unknown) => fn(), useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, () => undefined],
}
const actions = { disable: vi.fn(async () => undefined), update: vi.fn(async () => undefined) }
let snapshot: Record<string, unknown>
function load(name: string, dependencies: Record<string, unknown>): (...args: unknown[]) => unknown {
  const code = ts.transpileModule(readFileSync(new URL(`../client/${name}.tsx`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2024, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const module = { exports: {} as Record<string, (...args: unknown[]) => unknown> }
  runInNewContext(code, {
    module, exports: module.exports, setTimeout, clearTimeout,
    require(id: string) {
      if (id === 'react') return react
      if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: Symbol.for('fragment') }
      if (!(id in dependencies)) throw new Error(`unexpected component dependency: ${id}`)
      return dependencies[id]
    },
  })
  return module.exports[name]!
}
const PerformanceSettings = load('PerformanceSettings', {
  './i18n.ts': { textOf },
  './performance-client.ts': { usePerformance: () => snapshot, disablePerformance: actions.disable, updatePerformance: actions.update },
})
const SettingsTab = load('SettingsTab', { './PerformanceSettings.tsx': { PerformanceSettings } })
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes)
  if (!value || typeof value !== 'object' || !('type' in value)) return []
  const node = value as Node
  if (typeof node.type === 'function') return nodes(node.type(node.props))
  return [node, ...nodes(node.props.children)]
}
function words(value: unknown): string {
  if (Array.isArray(value)) return value.map(words).join(' ')
  if (value === null || value === undefined || typeof value === 'boolean') return ''
  if (typeof value !== 'object') return String(value)
  const node = value as Node
  return typeof node.type === 'function' ? words(node.type(node.props)) : words(node.props.children)
}
beforeEach(() => {
  vi.clearAllMocks()
  snapshot = {
    status: 'ready', saving: false, localSuppressed: false, error: undefined,
    state: { desired: { enabled: false, historyWindow: true, virtualChat: true }, capabilities: { historyWindow: { supported: true, reason: 'COMPATIBILITY_REASON' }, virtualChat: { supported: true, reason: 'COMPATIBILITY_REASON' } } },
    applied: { historyWindow: false, virtualChat: false, reason: 'INTERNAL_REASON' },
  }
})

it('keeps only concise performance controls and leaves emergency restore clickable while saving', async () => {
  snapshot.saving = true
  snapshot.error = '保存失败'
  const tree = PerformanceSettings()
  const all = nodes(tree)
  const checkboxes = all.filter(n => n.type === 'input')
  expect(checkboxes).toHaveLength(3)
  expect(checkboxes.every(n => n.props.disabled === true)).toBe(true)
  const restore = all.find(n => n.type === 'button')!
  expect(restore.props.disabled).not.toBe(true)
  await (restore.props.onClick as () => void)()
  expect(actions.disable).toHaveBeenCalledOnce()
  expect(words(tree)).toContain('可选性能优化')
  expect(words(tree)).toContain('保存失败')
  expect(words(tree)).not.toMatch(/COMPATIBILITY_REASON|INTERNAL_REASON|content-visibility|默认关闭/)
})

it('gates sub-options by the master switch and sends the selected patch', () => {
  let inputs = nodes(PerformanceSettings()).filter(n => n.type === 'input')
  expect(inputs.map(n => n.props.disabled)).toEqual([false, true, true])
  ;(snapshot.state as { desired: { enabled: boolean } }).desired.enabled = true
  inputs = nodes(PerformanceSettings()).filter(n => n.type === 'input')
  expect(inputs.map(n => n.props.disabled)).toEqual([false, false, false])
  ;(inputs[1]!.props.onChange as (event: unknown) => void)({ target: { checked: false } })
  expect(actions.update).toHaveBeenCalledWith({ historyWindow: false })
})

it('places stability inside optional optimizations, restores format descriptions, and validates language changes', async () => {
  const onPatch = vi.fn(async () => undefined)
  const text = textOf('zh')
  const unavailable = SettingsTab({ text, answer: undefined, onPatch, onCheckUpdate: async () => ({ state: 'up-to-date' as const, current: '0.1.27', latest: '0.1.27' }) })
  const unloaded = nodes(unavailable)
  expect(unloaded.some(n => n.type === 'button' && words(n) === text.settings.performance.restore)).toBe(true)
  expect(unloaded.find(n => n.type === 'select')!.props.disabled).toBe(true)
  const tree = SettingsTab({ text, answer: { preferences: { language: 'zh', stabilityFixes: true, format: 'sqlite' }, formats: ['sqlite', 'jsonl'] }, onPatch, onCheckUpdate: async () => ({ state: 'up-to-date' as const, current: '0.1.27', latest: '0.1.27' }) })
  const all = nodes(tree)
  expect(all.filter(n => n.type === 'h2').map(words).slice(0, 2)).toEqual([text.settings.storage, text.settings.performance.title])
  const optional = all.find(n => n.type === 'section' && n.props['aria-label'] === text.settings.performance.title)!
  const optionLabels = nodes(optional).filter(n => n.type === 'label')
  expect(optionLabels.map(n => words(n).trim())).toEqual([
    text.settings.performance.enabled,
    text.settings.performance.historyWindow,
    text.settings.performance.virtualChat,
    text.settings.stability,
  ])
  expect(optionLabels.slice(1).every(n => String(n.props.className).includes('dshsql-performance-option-secondary'))).toBe(true)
  const stability = optionLabels[3]!
  const stabilityInput = nodes(stability).find(n => n.type === 'input')!
  expect(stabilityInput.props.checked).toBe(true)
  expect(stabilityInput.props.disabled).toBe(false)
  ;(stabilityInput.props.onChange as (event: unknown) => void)({ target: { checked: false } })
  expect(onPatch).toHaveBeenCalledWith({ stabilityFixes: false })
  await new Promise(resolve => setTimeout(resolve, 0))
  const visible = words(tree)
  for (const description of [text.settings.sqliteDescription, text.settings.sqliteSuitable, text.settings.jsonlDescription, text.settings.jsonlSuitable]) {
    expect(visible).toContain(description)
  }
  expect(visible).not.toContain(text.settings.stabilityDescription)
  expect(visible).toContain(text.settings.sqliteTitle)
  expect(visible).toContain(text.settings.jsonlTitle)
  expect(all.some(n => n.props.className === 'dshsql-default-badge' && words(n) === text.settings.default)).toBe(true)
  const select = all.find(n => n.type === 'select')!
  expect(select.props.disabled).toBe(false)
  ;(select.props.onChange as (event: unknown) => void)({ target: { value: 'en' } })
  expect(onPatch).toHaveBeenCalledWith({ language: 'en' })
  expect(Object.keys(text.nav)).toEqual(['overview', 'transfer', 'metrics', 'settings'])
})
