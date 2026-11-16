import { stat, realpath } from 'node:fs/promises'
import { basename, dirname, resolve, sep } from 'node:path'

/** Recognize existing aliases without assuming every Windows volume ignores case. */
export async function sameDirectory(left: string, right: string): Promise<boolean> {
  const a = resolve(left), b = resolve(right)
  if (a === b) return true
  const inspect = async (path: string) => {
    try { return await stat(path, { bigint: true }) } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
      throw error
    }
  }
  const [first, second] = await Promise.all([inspect(a), inspect(b)])
  if (first === undefined || second === undefined || !first.isDirectory() || !second.isDirectory()) return false
  if (first.ino !== 0n && second.ino !== 0n) return first.dev === second.dev && first.ino === second.ino
  const [canonicalA, canonicalB] = await Promise.all([realpath(a), realpath(b)])
  return canonicalA === canonicalB
}

async function physicalLocation(path: string): Promise<string | undefined> {
  let current = resolve(path)
  const suffix: string[] = []
  for (;;) {
    try { return resolve(await realpath(current), ...suffix) } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOTDIR') return undefined
      if (code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) return undefined
      suffix.unshift(basename(current))
      current = parent
    }
  }
}

/** Migration roots cannot share or contain storage that source archival moves. */
export async function overlappingDirectories(left: string, right: string): Promise<boolean> {
  const contains = (parent: string, child: string): boolean => {
    const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`
    return child === parent || child.startsWith(prefix)
  }
  const rawA = resolve(left), rawB = resolve(right)
  if (contains(rawA, rawB) || contains(rawB, rawA) || await sameDirectory(left, right)) return true
  const [a, b] = await Promise.all([physicalLocation(left), physicalLocation(right)])
  if (a === undefined || b === undefined) return false
  return contains(a, b) || contains(b, a)
}
