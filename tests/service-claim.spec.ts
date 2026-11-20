/**
 * Taking the `sessionPersistence` key without taking the profile down with it.
 *
 * cordis allows one provider per service key per context chain, and `provide()`
 * throws on a second one. The plugin normally has the key to itself because
 * `cordis.patch.yml` disables the official JSONL backend — but that patch is a
 * static statement decided when the profile is composed, and a composition can
 * reach this plugin with the official backend still on the key: right after an
 * in-place update, or when the bundle's patch layer did not land.
 *
 * That used to surface as `service "sessionPersistence" has been registered at
 * <session-persistence-jsonl-service>` and a failed profile. A reported 0.1.30 →
 * 0.1.31 update hit exactly that. What the claim must do instead is: wait out a
 * holder that is on its way out, claim when the key is free, and otherwise stand
 * down with a message that says why conversations are not on SQLite and what
 * brings them back.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

import { claimSessionPersistence } from '../src/service-claim.ts'

const KEY = 'sessionPersistence'
const NAME = 'dsh-session-optimizer'

/** `ctx.provide` is typed against the host's service table; this test only needs the call. */
function provide(ctx: Context, value: unknown): void {
  (ctx as unknown as { provide: (name: string, provided: unknown) => void }).provide(KEY, value)
}

/** Mount the key's owner the way the official backend does: from a child fiber. */
function backend(ctx: Context, id: string) {
  return ctx.plugin({
    name: `${id}-service`,
    apply(serviceCtx: Context) {
      provide(serviceCtx, { owned: id })
    },
  })
}

describe('claiming the sessionPersistence service', () => {
  it('stands down instead of throwing when another backend owns the key', async () => {
    const ctx = new Context()
    await backend(ctx, 'session-persistence-jsonl').await()
    const warnings: string[] = []
    let created = 0
    const outcome = await claimSessionPersistence(ctx, {
      name: NAME,
      create: () => {
        created += 1
        provide(ctx, { owned: 'optimizer' })
      },
      warn: (message) => { warnings.push(message) },
    })
    expect(outcome.claimed).toBe(false)
    // Not even attempted: the key was visibly taken, so the failure this module
    // exists to prevent never happens — no throw, nothing to unwind.
    expect(created).toBe(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('already provided by')
    expect(warnings[0]).toContain('instead of SQLite')
    expect(warnings[0]).toContain('Quit DeepSeekRuntime completely and start it again')
    expect(ctx.get(KEY as never)).toEqual({ owned: 'session-persistence-jsonl' })
  })

  it('takes the key when it is free', async () => {
    const ctx = new Context()
    const warnings: string[] = []
    const outcome = await claimSessionPersistence(ctx, {
      name: NAME,
      create: () => { provide(ctx, { owned: 'optimizer' }) },
      warn: (message) => { warnings.push(message) },
    })
    expect(outcome.claimed).toBe(true)
    expect(warnings).toEqual([])
    expect(ctx.get(KEY as never)).toEqual({ owned: 'optimizer' })
  })

  it('waits out a holder that is being torn down instead of standing down', async () => {
    const ctx = new Context()
    const holder = backend(ctx, 'session-persistence-jsonl')
    await holder.await()
    const warnings: string[] = []
    const pending = claimSessionPersistence(ctx, {
      name: NAME,
      create: () => { provide(ctx, { owned: 'optimizer' }) },
      warn: (message) => { warnings.push(message) },
    })
    // Disposal is not awaited first: this is the window a live replacement runs
    // in, where the outgoing provider is still registered while the incoming one
    // already starts.
    await holder.dispose()
    const outcome = await pending
    expect(outcome.claimed).toBe(true)
    expect(warnings).toEqual([])
    expect(ctx.get(KEY as never)).toEqual({ owned: 'optimizer' })
  })
})
