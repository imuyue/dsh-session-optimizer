/**
 * Per-session write lease. One process at a time owns the right to append to a
 * session; the lease lives next to the database so every process resolving the
 * same session path contends on the same file.
 *
 * POSIX uses `flock` on an open file descriptor. The file is never deleted while
 * the store lives: a later holder compares the descriptor's inode with the path
 * to detect that it locked a replaced file.
 *
 * Windows has no advisory `flock` here, so it uses a marker created exclusively
 * and holding the owner pid; see `acquireWin32`.
 *
 * @module dsh-session-optimizer/lease
 */

import { chmod, mkdir, open, readFile, rename as renameFile, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'

/** File name of the lease, kept beside the database. */
export const LEASE_FILENAME = 'session.lock'

type HeldLock =
  | { readonly kind: 'posix'; readonly handle: FileHandle }
  | { readonly kind: 'win32'; readonly handle: FileHandle; readonly path: string }

function isLockContention(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EAGAIN' || code === 'EWOULDBLOCK'
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function acquirePosix(path: string, id: SessionId): Promise<FileHandle> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const handle = await open(path, 'w', 0o600)
    try {
      // `w` honours the mode only on creation; an existing marker keeps its old
      // bits, so narrow it before anything else observes the file.
      await chmod(path, 0o600).catch(() => undefined)
      await tryLockExclusive(handle.fd)
      const held = await handle.stat({ bigint: true })
      const current = await stat(path, { bigint: true }).catch(() => undefined)
      if (current !== undefined && current.ino === held.ino && current.dev === held.dev) {
        return handle
      }
    } catch (error) {
      await handle.close()
      if (isLockContention(error)) throw new SessionAlreadyOwnedError(id)
      throw error
    }
    await handle.close()
  }
  throw new SessionAlreadyOwnedError(id)
}

/**
 * Windows ownership marker.
 *
 * `flock` is not available here, so ownership is the creation of the marker file
 * itself: `open(path,'wx')` maps to `CreateFile(CREATE_NEW)`, which fails for
 * every contender but one. Only the winner writes the payload, and a loser learns
 * it lost from `EEXIST` — there is no window in which both believe they own the
 * session.
 *
 * Publishing under a temporary name and `rename`-ing it into place — the obvious
 * alternative — is *not* safe here: on Windows a rename replaces the destination,
 * so every contender "publishes" and they all believe they won.
 *
 * A marker left by a process that died has to be cleared, and clearing it is the
 * only operation on somebody else's file: the owner pid decides, and only a
 * marker whose owner is gone is moved aside to a name no other contender uses
 * (so exactly one reclaim can succeed) before it is deleted.
 */
async function acquireWin32(path: string, id: SessionId): Promise<FileHandle> {
  const payload = JSON.stringify({ pid: process.pid, startedAt: Date.now() })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle: FileHandle
    try {
      handle = await open(path, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (!(await reclaimStaleMarker(path, id))) throw new SessionAlreadyOwnedError(id)
      continue
    }
    try {
      await handle.writeFile(payload)
      // Owned from the `CREATE_NEW` above; a concurrent reclaim sees our live pid
      // and refuses to touch it, and one that raced between the create and this
      // write reads an unparsable marker, which it also refuses to steal.
      return handle
    } catch (error) {
      await handle.close().catch(() => undefined)
      await unlink(path).catch(() => undefined)
      throw error
    }
  }
  throw new SessionAlreadyOwnedError(id)
}

/**
 * Remove a marker whose owner is gone, and report whether that happened.
 *
 * Reclaiming is the only reason to touch somebody else's marker, so it happens
 * under a rename: whoever moves the file to the reclaim name is the only one who
 * may delete it, and a live owner's marker is left exactly where it is.
 *
 * A marker that cannot be parsed stops the reclaim instead of being treated as
 * ownerless: a writer holds the marker from the `CREATE_NEW` that made it until
 * the payload lands, so an unreadable payload can be a writer mid-create, and
 * stealing from a live writer is the one mistake that costs appends.
 */
async function reclaimStaleMarker(path: string, id: SessionId): Promise<boolean> {
  let ownerPid: number | undefined
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null) {
      const pid = (parsed as { pid?: unknown }).pid
      if (typeof pid === 'number') ownerPid = pid
    }
  } catch {
    throw new SessionAlreadyOwnedError(id)
  }
  if (ownerPid === undefined) throw new SessionAlreadyOwnedError(id)
  // A pid is reused by the OS, so liveness alone is weak evidence — a marker
  // whose pid now belongs to an unrelated process reads as owned. Nothing on this
  // platform turns another process's start time into a checkable identity
  // (`startedAt` is recorded for forensics only), and the conservative answer
  // costs an operator one `dsq` call, while the other answer costs appends.
  if (ownerPid !== process.pid && isProcessAlive(ownerPid)) {
    throw new SessionAlreadyOwnedError(id)
  }
  const reclaim = `${path}.${process.pid}.${Date.now().toString(36)}.reclaim`
  try {
    // On Windows a rename replaces the destination, which is exactly what is
    // wanted here: the reclaim name is unique per attempt, so no contender can be
    // moving anything onto it, and whoever moves the marker aside is the only one
    // that may delete it.
    await renameFile(path, reclaim)
  } catch {
    // Somebody else reclaimed it first, or the owner released it: either way the
    // caller now retries the exclusive create and finds out who won.
    return false
  }
  await unlink(reclaim).catch(() => undefined)
  return true
}

/**
 * The right to append to one session. Released by closing the descriptor; on
 * POSIX the lock file itself stays on disk.
 */
export class SessionWriteLease {
  private released = false

  private constructor(private readonly held: HeldLock) {}

  /** Take the lease for `dir`, creating the directory when missing. */
  static async acquire(dir: string, id: SessionId): Promise<SessionWriteLease> {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, LEASE_FILENAME)
    if (process.platform === 'win32') {
      const held = await acquireWin32(path, id)
      return new SessionWriteLease({ kind: 'win32', handle: held, path })
    }
    return new SessionWriteLease({ kind: 'posix', handle: await acquirePosix(path, id) })
  }

  /** Idempotent. Never throws for a second call. */
  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    const { held } = this
    await held.handle.close()
    if (held.kind === 'win32') {
      await unlink(held.path).catch(() => undefined)
    }
  }
}
