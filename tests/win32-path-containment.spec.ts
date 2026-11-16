import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { win32 } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Execute the production helper with Win32 path semantics and a directory-identity
// model. This verifies case/drive handling, not native Windows filesystem sharing.
function windowsPaths() {
  const paths = new Map([
    ['C:\\Store', 'C:\\Store'], ['C:\\store', 'C:\\store'],
    ['C:\\source', 'C:\\source'], ['C:\\SOURCE', 'C:\\source'],
    ['D:\\alias', 'C:\\source'], ['C:\\store-other', 'C:\\store-other'],
  ])
  const ids = [...new Set(paths.values())]
  const missing = () => Object.assign(new Error('fixture directory absent'), { code: 'ENOENT' })
  const canonical = (path: string) => {
    const found = paths.get(win32.resolve(path))
    if (found === undefined) throw missing()
    return found
  }
  const exports: Record<string, unknown> = {}
  const source = readFileSync(new URL('../src/path-identity.ts', import.meta.url), 'utf8')
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, module: { exports }, require(name: string) {
      if (name === 'node:path') return win32
      if (name === 'node:fs/promises') return {
        async realpath(path: string) { return canonical(path) },
        async stat(path: string) { return { dev: 1n, ino: BigInt(ids.indexOf(canonical(path)) + 1), isDirectory: () => true } },
      }
      throw new Error(`unexpected fixture dependency: ${name}`)
    },
  })
  return exports.overlappingDirectories as (left: string, right: string) => Promise<boolean>
}
it('keeps distinct case-sensitive Win32 sibling directories independent', async () => {
  const overlaps = windowsPaths()
  expect(await overlaps('C:\\Store', 'C:\\store\\new')).toBe(false)
  expect(await overlaps('C:\\store', 'C:\\store-other')).toBe(false)
})
it('recognizes canonical casing and another-drive aliases with missing descendants', async () => {
  const overlaps = windowsPaths()
  expect(await overlaps('C:\\source', 'C:\\SOURCE\\new')).toBe(true)
  expect(await overlaps('C:\\source', 'D:\\alias\\new')).toBe(true)
  expect(await overlaps('D:\\alias\\new', 'C:\\source')).toBe(true)
})
