/**
 * The one channel between "a migration settled" and "the conversation list must
 * be re-read".
 *
 * A migration changes which backend owns a conversation, or adds a second
 * conversation that did not exist before. Neither is a filesystem detail the
 * panel can see: the Shell's session list is client state, filled from
 * `session.list` through the `sessions` service. So the panel announces the
 * change, and two listeners react — the surface's own reload, and the Shell's
 * `sessions.refresh()`, which is what makes a cloned conversation appear in the
 * sidebar without a page reload.
 *
 * Kept in its own module rather than passed as a prop so that the announcement
 * does not have to thread through the panel hierarchy, and so a listener can be
 * registered before any panel is mounted.
 *
 * @module dsh-session-optimizer/client/library
 */

/** Something that reacts to a change in the stored conversations. */
type Listener = () => void

const listeners = new Set<Listener>()

/**
 * Subscribe to conversation-library changes.
 * @param listener - called after a migration settles.
 * @returns an unsubscribe function.
 */
export function onLibraryChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Announce that the stored conversations changed.
 *
 * Every listener runs; a throwing one does not keep the rest from running, since
 * one panel's failed redraw must not leave the Shell's list stale.
 */
export function announceLibraryChanged(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // A redraw is best effort: the migration already committed on disk.
    }
  }
}
