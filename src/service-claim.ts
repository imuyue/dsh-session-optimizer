import type { Context } from '@deepseek-ai/cordis'

import { sleep } from './store-lease.ts'

/** The key this plugin takes over, and the one the official backend provides. */
const KEY = 'sessionPersistence'

/**
 * How long a claim waits for a holder that is not active to finish unwinding.
 *
 * It only has to cover a teardown already in flight — cordis removes the key
 * when the providing fiber's disposer runs, and the disposer waits for that
 * fiber's dependents to let go. Milliseconds, not seconds; anything longer is
 * a holder that will never release it and the claim should stand down so the
 * profile still starts.
 */
export const CLAIM_BUDGET_MS = 3_000

/** Poll interval while waiting; the wait is a teardown, not a disk operation. */
const CLAIM_POLL_MS = 20

/**
 * How long a claim waits on a holder that is still *active* before standing down.
 *
 * An active holder is normally another backend that is here to stay, and waiting
 * on it would only delay a profile that has to start anyway. But a replaced
 * fiber is disposed while the replacement is already mounting, so for a tick the
 * holder is both active and on its way out. The grace covers that tick; it is
 * short because the alternative — a profile that reports the truth by refusing
 * to start — is the bug this module exists to remove.
 */
const CLAIM_GRACE_MS = 250

/** What a claim needs from the caller. */
export interface ClaimOptions {
  /** Plugin name, used in the messages. */
  readonly name: string
  /**
   * Constructs the service.
   *
   * Registration is a side effect of the `Service` base constructor, so this
   * throws when the key is taken — which is exactly the answer the claim needs.
   */
  readonly create: () => void
  /** Where a stand-down message goes; the message is written once per claim. */
  readonly warn: (message: string) => void
  /** Override the wait, for tests. */
  readonly budgetMs?: number
}

/** Whether the key ended up ours, and who had it when it did not. */
export interface ClaimOutcome {
  readonly claimed: boolean
  /** The fiber name from the conflict, when there was one to read. */
  readonly holder?: string
}

/**
 * Take the `sessionPersistence` service, or stand down without throwing.
 *
 * cordis gives a service key to one provider per context chain, and `provide()`
 * throws when the key is taken. The key is normally free because
 * `cordis.patch.yml` disables the official JSONL backend — but that patch is a
 * *static* statement applied when the profile is composed, and it is not
 * re-decided when a running profile is recomposed around an updated plugin, nor
 * in a composition where the bundle's patch layer did not land. Either way the
 * official backend provides the key first, and this plugin used to die with
 * `service "sessionPersistence" has been registered at
 * <session-persistence-jsonl-service>` — a failed profile, an error that names
 * no fix, and the operator's conversations apparently gone.
 *
 * Three outcomes, in the order they are tried:
 *
 * 1. The key is free — construct the service and own it.
 * 2. The key is held by a provider that is *not* active: a teardown in flight,
 *    which is what a live replacement looks like from here. Wait for it, within
 *    `CLAIM_BUDGET_MS`, then claim.
 * 3. The key is held by a live provider. Waiting cannot free it: only a fresh
 *    composition applies the patch, which means a full restart of the app. Stand
 *    down, leaving that backend serving, and say so — a profile that keeps
 *    running is worth more than one that reports the truth by refusing to start.
 */
export async function claimSessionPersistence(
  ctx: Context,
  options: ClaimOptions,
): Promise<ClaimOutcome> {
  const budget = options.budgetMs ?? CLAIM_BUDGET_MS
  const started = Date.now()
  const deadline = started + budget
  let holder: string | undefined
  let graceUntil: number | undefined

  for (;;) {
    // Any provider at all, active or not: this is the question `provide()` asks.
    if (read(ctx, false) === undefined) {
      try {
        options.create()
        return { claimed: true }
      } catch (error) {
        // Lost a race between the check and the construction. Read the holder
        // out of the message and let the loop decide whether to wait.
        if (!isConflict(error)) throw error
        holder = holderOf(error) ?? holder
      }
    }

    const now = Date.now()
    // A holder that is still active is usually a decision — but "usually" is not
    // "always": the fiber being replaced is disposed around the same moment this
    // plugin starts, and for a tick it is still registered and still active. The
    // grace is what tells those two apart without failing the one that matters.
    const until = read(ctx, true) === undefined
      ? deadline
      : (graceUntil ??= Math.min(now + CLAIM_GRACE_MS, deadline))
    if (now >= until) return standDown(options, holder)

    await sleep(CLAIM_POLL_MS)
  }
}

/** The registered value, when `strict` also requires its fiber to be active. */
function read(ctx: Context, strict: boolean): unknown {
  // The key is a string on purpose: `sessionPersistence` is typed by whichever
  // package declares it, and this module only needs the registry answer.
  return (ctx.get as (name: string, strict: boolean) => unknown).call(ctx, KEY, strict)
}

/** Whether a construction failed because someone else holds the key. */
function isConflict(error: unknown): boolean {
  return error instanceof Error && /has been registered at/.test(error.message)
}

/** The `<fiber name>` a conflict message carries. */
function holderOf(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : ''
  return /has been registered at <([^>]+)>/.exec(message)?.[1]
}

/**
 * Report a claim that lost the key, and leave the other backend serving.
 *
 * The message an operator needs is not "service already registered" — it is why
 * their sessions are not on SQLite and what makes them come back.
 */
function standDown(options: ClaimOptions, holder: string | undefined): ClaimOutcome {
  // The registry answers "is the key taken" but not "by whom" — the fiber name
  // only reaches us through a conflict message. Naming the likely owner is worth
  // more than a pronoun, and it is the one this plugin's patch layer disables.
  const owner = holder ?? 'another plugin (most likely @deepseek-ai/dsh-session-persistence-jsonl)'
  options.warn(
    `${options.name}: "sessionPersistence" is already provided by ${owner}, so this profile is serving conversations from that backend instead of SQLite. ` +
      `The patch layer this plugin ships with — the one that disables that backend and mounts this one — is not in force in the composition that just started, which is what an in-place update looks like before the app is restarted. ` +
      `Quit DeepSeekRuntime completely and start it again; the next start composes the profile with the SQLite backend and this message goes away.`,
  )
  return { claimed: false, holder: owner }
}
