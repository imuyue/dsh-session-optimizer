/**
 * Whether this build's host is new enough for the client adapters.
 *
 * The adapters touch a small, fully enumerated surface of the host — the fields
 * a recovered session exposes, the ten methods a workspace model must have, the
 * shape of a membership answer. Each call site already checks every one of those
 * members before it acts, and that check is the real gate: it asks the object in
 * front of it whether it can do the job.
 *
 * A version test on top of that can only ever produce false negatives, and it
 * did: pinning the gate to one exact build string turned session recovery,
 * workspace membership sync and workspace stream recovery off on every machine
 * that moved from `0.2.2-rc.1` to a later build of the same line, while the
 * shapes they depend on were unchanged. So the version is used only as a floor —
 * the line the adapters were written against — with no upper bound, and the
 * shape probes decide per object. A build below the floor is refused, and that
 * refusal is reported rather than guessed at.
 */
const FLOOR = [0, 2, 2] as const

/** Numeric release triple of a version string, or `undefined` when unreadable. */
function releaseOf(version: string): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (match === null) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function supportedHost(version: string | undefined): boolean {
  if (version === undefined) return false
  const release = releaseOf(version)
  if (release === undefined) return false
  for (const [index, floor] of FLOOR.entries()) {
    const seen = release[index] as number
    if (seen !== floor) return seen > floor
  }
  return true
}
