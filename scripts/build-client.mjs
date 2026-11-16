/**
 * Build the browser half (`client/` → `lib/client.js`).
 *
 * The output must be exactly the shape the DSH Web GUI boot expects: one CJS
 * factory registered under the package name, whose `require` resolves against
 * the host module table (`react`, `react/jsx-runtime`, the primitives, …). That
 * is what `tsdown.client.ts` emits upstream; this script reproduces it with
 * rolldown, which is already present for the test lane.
 *
 * Run with `node scripts/build-client.mjs` (part of `npm run build`).
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { build } from 'rolldown'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** Read once so the bundle id and the manifest can never disagree. */
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

/**
 * Modules the host page puts on the module table. Anything not listed here is
 * bundled in, so the list must match `PLATFORM_MODULES` in
 * `packages/client/web/src/platform.ts` for the subset this plugin imports.
 */
const EXTERNAL = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@tanstack/react-virtual',
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  'zod',
  '@deepseek-ai/dsh-api-workspace-controller',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

await build({
  input: join(root, 'client', 'index.ts'),
  platform: 'browser',
  external: EXTERNAL,
  transform: { jsx: { runtime: 'automatic' } },
  resolve: { extensions: ['.ts', '.tsx', '.js', '.jsx'] },
  output: {
    format: 'cjs',
    file: join(root, 'lib', 'client.js'),
    sourcemap: true,
    banner: `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(manifest.name)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;`,
    intro: '',
    footer: '\t\treturn module.exports;\n\t}\n});',
  },
})

console.log('built lib/client.js')
