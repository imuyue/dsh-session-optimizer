import { getEnvironmentData } from 'node:worker_threads'

/** Resolve Worker peers on the parent thread; cancellation must not interrupt a native loader. */
export function workerRuntimeExecArgv(
  args: readonly string[],
  resolve: (specifier: string) => string = import.meta.resolve,
): string[] {
  if (getEnvironmentData('@deepseek-ai/dsh-app-boot/profile-resolution') === undefined) return [...args]
  // These are the runtime package imports of worker-entry and preview-worker, including their local graph.
  const peers = ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-persistence']
  const entries = peers.map(name => [name, resolve(name)])
  const source = `import { registerHooks } from 'node:module';
const peers = new Map(${JSON.stringify(entries)});
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(peers.get(specifier) ?? specifier, context);
} });`
  return ['--import', `data:text/javascript,${encodeURIComponent(source)}`, ...args]
}
