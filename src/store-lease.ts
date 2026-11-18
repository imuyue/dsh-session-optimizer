/**
 * Who to ask before a store's files are renamed or unlinked.
 *
 * On Windows a handle held by *this* process is enough to make `rename` and
 * `unlink` fail with `EBUSY` on the store's main file and on its `-wal`/`-shm`
 * sidecars, and no amount of retrying helps: the lock lasts exactly as long as
 * the handle does. Since a cached connection lives for `preparedSessionCacheSize`
 * sessions by design, a conversion or a delete of a conversation the operator
 * just read would fail every time — the failure the console used to report as an
 * opaque `EBUSY` from deep inside a rename.
 *
 * So the executors register here, and every path that moves or removes a store
 * asks first. The executors drop the connection for that path rather than every
 * connection, and the next read reopens it from the file the name now leads to —
 * which is the behaviour the identity check in `DatabaseCache` already promises
 * for a store swapped out from under a reader.
 *
 * The registry is consulted only by the publish and delete paths, all of which
 * hold the session's write lease while they run; that lease is what keeps this
 * from pulling the connection out from under a live writer.
 */
type StoreReleaser = (path: string) => Promise<void>

const releasers = new Set<StoreReleaser>()

/** Advertise an executor's ability to close its cached connection for a path. */
export function registerStoreReleaser(releaser: StoreReleaser): () => void {
  releasers.add(releaser)
  return () => { releasers.delete(releaser) }
}

/**
 * Refusal raised when a read would re-open a store that is being moved away.
 *
 * Closing the connection is not enough on its own: a background warm-up or a
 * read already in flight re-opens the file the moment the release returns, and
 * the `rename`/`unlink` that follows meets `EBUSY` again. The hold below closes
 * that window by refusing the reopen for as long as the operation runs.
 */
export class StoreBusyError extends Error {
  readonly path: string

  constructor(path: string) {
    super(`"${path}" is being moved or replaced, so it cannot be opened right now`)
    this.name = 'StoreBusyError'
    this.path = path
  }
}

/** Paths held by an operation that needs their files closed. */
const holds = new Map<string, number>()

/** Whether `path` is held: a read must not open it while this is true. */
export function storeIsHeld(path: string): boolean {
  return holds.has(path)
}

/**
 * Close every cached connection for `path` and keep it closed until the
 * returned function runs.
 *
 * The hold is taken *before* the release, so a read that arrives while the
 * releasers are still running already sees it and refuses; the caller can then
 * rename or unlink without racing a reopen. Releasing is idempotent so a `throw`
 * path cannot leak a hold that would keep the store unreadable forever.
 */
export async function holdStore(path: string): Promise<() => void> {
  holds.set(path, (holds.get(path) ?? 0) + 1)
  let done = false
  const release = (): void => {
    if (done) return
    done = true
    const remaining = (holds.get(path) ?? 1) - 1
    if (remaining <= 0) holds.delete(path)
    else holds.set(path, remaining)
  }
  try {
    await releaseStore(path)
  } catch (error) {
    release()
    throw error
  }
  return release
}

/** Run `operation` with `path` released and held shut. */
export async function withStoreHeld<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const release = await holdStore(path)
  try {
    return await operation()
  } finally {
    release()
  }
}

/** How long a read waits for a held store before giving up on it. */
export const STORE_BUSY_BUDGET_MS = 5_000

/** Sleep between two attempts at opening a held store. */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Run `open` once `path` is no longer held, or throw `StoreBusyError`.
 *
 * A hold lasts for one rename or one unlink — microseconds of file work — so the
 * wait is measured in milliseconds and a caller that arrives during one gets its
 * answer instead of a spurious failure. The budget is there so a stuck operation
 * cannot park a read for ever: past it the caller is told the store is busy, and
 * a warm-up treats that as "leave it cold" like any other unreadable store.
 */
export async function retryWhileHeld<T>(
  path: string,
  open: () => T | Promise<T>,
  budgetMs = STORE_BUSY_BUDGET_MS,
  stepMs = 5,
): Promise<T> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (!holds.has(path)) return await open()
    if (Date.now() >= deadline) throw new StoreBusyError(path)
    await sleep(stepMs)
  }
}

/**
 * Make every registered executor let go of `path`.
 *
 * Failures are swallowed: a releaser that cannot close a connection (a worker
 * that is already gone, say) has no connection left to hold the file, and the
 * caller's next step is the operation that wanted the file free in the first
 * place. Raising here would turn a recoverable state into a failed conversion.
 */
export async function releaseStore(path: string): Promise<void> {
  for (const releaser of [...releasers]) {
    // A releaser is third-party code from this module's point of view: it may
    // reject or throw outright, and either way the caller still has to reach the
    // operation it wanted the file free for.
    try {
      await releaser(path)
    } catch (error) {
      // Deliberately ignored — see the note above. `EBUSY`-shaped failures are
      // hard to attribute after the fact, so an operator who sets the variable
      // gets the releaser and the error in the log instead of silence.
      if (process.env.DSH_SESSION_OPTIMIZER_TRACE_LEASE !== undefined) {
        console.error('[store-lease] releaser failed for', path, error)
      }
    }
  }
}
