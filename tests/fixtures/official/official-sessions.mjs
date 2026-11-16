import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { loadOfficialWorkspace } from './official-workspace.mjs'

export async function loadOfficialSessions(root) {
  const official = await loadOfficialWorkspace(root)
  const source = await readFile(join(root, 'node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js'), 'utf8')
  // Export the unchanged private class for an isolated test. No runtime package is modified.
  if (source.split('return module.exports;').length !== 2) throw new Error('Unsupported official Client factory')
  const exposed = source.replace('return module.exports;', 'exports.ClientSessions = ClientSessions; return module.exports;')
  let client
  const store = {
    notifySubscribers(listeners) { for (const listener of [...listeners]) listener() },
    createSnapshotStore(initial) {
      let value = initial; const listeners = new Set()
      return { getSnapshot: () => value, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) }, set(next) { value = next; for (const listener of [...listeners]) listener() } }
    },
  }
  runInNewContext(exposed, {
    window: { __ModuleLoader__: { load(spec) { client = spec.factory(id => {
      if (id === '@deepseek-ai/cordis') return official.cordis
      if (id === '@deepseek-ai/dsh-api-gateway/client') return official.gateway
      if (id === '@deepseek-ai/dsh-client-store') return store
      throw new Error('Unexpected Client Session import: ' + id)
    }) } } }, console, queueMicrotask, setTimeout, clearTimeout, AbortController, AbortSignal,
  })
  return { ...official, sessionClient: client }
}
