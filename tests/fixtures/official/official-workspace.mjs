import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'

/** Installed-module oracle. Never loads a plugin into the operator's profile. */
export async function loadOfficialWorkspace(root) {
  const load = name => import(pathToFileURL(join(root, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href)
  const gateway = await import(pathToFileURL(join(root, 'node_modules/@deepseek-ai/dsh-api-gateway/lib/client.node.js')).href)
  const protocol = await load('dsh-typert-protocol')
  const cordis = await load('cordis')
  let client
  const source = await readFile(join(root, 'node_modules/@deepseek-ai/dsh-api-workspace-controller/lib/client.js'), 'utf8')
  runInNewContext(source, {
    window: { __ModuleLoader__: { load(spec) { client = spec.factory(id => {
      if (id === '@deepseek-ai/dsh-api-gateway/client') return gateway
      if (id === '@deepseek-ai/cordis') return cordis
      // Scheduling only: all Workspace model validation, mutation and stream code is official.
      if (id === '@deepseek-ai/dsh-client-store') return { notifySubscribers: listeners => { for (const listener of [...listeners]) listener() } }
      throw new Error('Unexpected official client import: ' + id)
    }) } } }, queueMicrotask, console, setTimeout, clearTimeout, AbortController,
  })
  return { client, gateway, protocol, cordis, load }
}

export function frameQueue() {
  const values = []; let wake
  return {
    push(frame) { values.push(frame); wake?.() },
    async *read(signal) {
      while (!signal.aborted) {
        if (values.length) { yield values.shift(); continue }
        await new Promise(resolve => {
          const done = () => { wake = undefined; signal.removeEventListener('abort', done); resolve() }
          wake = done; signal.addEventListener('abort', done, { once: true }); if (signal.aborted) done()
        })
      }
    },
  }
}
