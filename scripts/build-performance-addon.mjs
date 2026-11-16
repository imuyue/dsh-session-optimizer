import { build } from 'rolldown'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'distribution', 'performance-addon')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
// The parent Host build must have finished first. Never ship a source-only or
// partially built module graph; worker URLs must resolve within this package.
for (const name of ['performance-addon.js', 'preview-worker.js', 'console.js']) {
  if (!(await stat(join(root, 'lib', name))).isFile()) throw new Error(`Run the Host TypeScript build first: missing lib/${name}`)
}
if (out !== join(root, 'distribution', 'performance-addon')) throw new Error('unexpected output directory')
if (!process.argv.includes('--in-place')) await rm(out, { recursive: true, force: true })
await mkdir(join(out, 'locale'), { recursive: true })
await cp(join(root, 'lib'), join(out, 'lib'), { recursive: true })
const external = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@tanstack/react-virtual', '@deepseek-ai/cordis', '@deepseek-ai/schemastery', 'zod', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives']
await build({
  input: join(root, 'client', 'performance-addon.tsx'), platform: 'browser', external,
  transform: { jsx: { runtime: 'automatic' } }, resolve: { extensions: ['.ts', '.tsx', '.js', '.jsx'] },
  output: {
    format: 'cjs', file: join(out, 'lib', 'client.js'), sourcemap: true,
    banner: 'window.__ModuleLoader__.load({\n id: "dsh-session-performance",\n factory: (require) => {\n var module = { exports: {} };\n var exports = module.exports;',
    footer: '\n return module.exports;\n }\n});',
  },
})
await writeFile(join(out, 'package.json'), JSON.stringify({
  name: 'dsh-session-performance', version: manifest.version, private: true, license: 'MIT', type: 'module',
  description: 'Optional bounded session loading preview and offscreen chat layout with independent controls. Leaves session storage and query providers unchanged.',
  main: './lib/performance-addon.js', types: './lib/performance-addon.d.ts',
  exports: { '.': { types: './lib/performance-addon.d.ts', default: './lib/performance-addon.js' }, './client': './lib/client.js', './locale/*.json': './locale/*.json', './icon': './icon.svg', './package.json': './package.json' },
  files: ['lib', 'cordis.patch.yml', 'locale/*.json', 'icon.svg', 'README.md'],
  dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', immediately: true, inject: ['@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-primitives'] } },
  engines: manifest.engines, dependencies: manifest.dependencies, peerDependencies: manifest.peerDependencies, peerDependenciesMeta: manifest.peerDependenciesMeta,
}, null, 2) + '\n')
await writeFile(join(out, 'cordis.patch.yml'), `# Independent opt-in performance add-on: preserves every official provider.\n- insert:\n    - id: session-performance-addon\n      name: dsh-session-performance\n      config:\n        root: !!js dshHomePath('sessions-sqlite')\n        preferencesPath: !!js dshHomePath('session-performance/preferences.json')\n`)
await writeFile(join(out, 'locale', 'en.json'), JSON.stringify({ meta: { title: 'Session performance', description: 'Optional loading preview and offscreen chat layout. Both optimizations default off, with independent controls and one-click restore.' } }, null, 2) + '\n')
await writeFile(join(out, 'locale', 'zh.json'), JSON.stringify({ meta: { title: '会话性能', description: '可选的会话加载预览与屏外正文布局优化。默认关闭、独立开关、一键恢复官方路径，保留现有存储与查询提供方。' } }, null, 2) + '\n')
// Original artwork: conversation outline, two text strokes and a speed needle.
await writeFile(join(out, 'icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><rect x="5" y="7" width="54" height="43" rx="12" fill="#2166b0"/><path d="M17 48v10l13-10" fill="#2166b0"/><path d="M17 21h22M17 29h15" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/><path d="M36 42a11 11 0 0 1 22 0M47 41l7-10" fill="none" stroke="#8de1cc" stroke-width="4" stroke-linecap="round"/></svg>\n`)
await writeFile(join(out, 'README.md'), `# Session performance\n\nIndependent optional performance add-on for DSH ${manifest.engines.dsh}.\n\nThis package does not register sessionPersistence or sessionQuery and its patch only inserts its own row. It does not migrate, switch or warm session stores. The history preview is read-only and only applies to existing compatible SQLite stores; other sessions continue using official loading. Offscreen layout retains official nodes.\n\nOpen **会话优化 → 设置** in the dsh-session-optimizer panel. The optimizer Client owns the performance controls, transport and chat effects; this add-on Client is inert and registers no sidebar panel or flow override. Deploy the updated optimizer Client alongside this Host add-on. Master, history preview, and offscreen layout switches all default to false. **关闭全部优化并恢复官方** saves all three as false and removes the current page's optional paths. Other pages restore after syncing; paused/offline pages need reconnect or refresh. The session_performance tool uses the same revision-checked Host state.\n\nKeep the existing storage/query Host configuration unchanged. Run only one Host implementation of the performance routes and tool: a full updated optimizer Host already contains them, whereas an older optimizer Host can use this add-on. The shared optimizer Client supplies the unified settings page in either case.\n\nBuild from the source repository with node node_modules/typescript/bin/tsc -p tsconfig.json, then node scripts/build-performance-addon.mjs. No installation scripts are shipped.\n`)
const patch = await readFile(join(out, 'cordis.patch.yml'), 'utf8')
if (/disabled:|override:|session-persistence-jsonl/.test(patch)) throw new Error('performance patch must only insert its own entry')
const pkg = JSON.parse(await readFile(join(out, 'package.json'), 'utf8'))
if (pkg.scripts !== undefined) throw new Error('add-on must not ship install scripts')
console.log(`built ${out}`)
