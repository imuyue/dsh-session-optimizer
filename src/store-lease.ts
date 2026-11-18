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
    } catch {
      // Deliberately ignored — see the note above.
    }
  }
}
