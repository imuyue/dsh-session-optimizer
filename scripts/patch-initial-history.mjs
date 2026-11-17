#!/usr/bin/env node
/** Prepared exact-version patch. No file changes unless the caller explicitly selects apply/revert. */
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The controller call site this patch rewrites, per supported build.
 *
 * Each entry pins the whole file by SHA-256, so a build that is not listed here
 * is refused instead of being patched on a guess. `line` is the exact source
 * text of the call site in that build; the patched form is derived from it, so
 * a build that minifies its output only needs its own `line`.
 */
export const SUPPORTED = [
  {
    version: '0.2.2-rc.1',
    sha256: '13a1b441f7fe7fa7698a3352b1904e5645fd844e6f63a7c1c5fcef415cfcae4c',
    line: 'const events = new SessionEventStream(this.remote, this.sessionAddress(), {',
  },
  {
    version: '0.2.2-rc.3',
    sha256: 'e9af25a01168a8405730c107471cbd6befccfab3294e793b10e1467c57255852',
    line: 'const events=new SessionEventStream(this.remote,this.sessionAddress(),{',
  },
]

const CALL = 'new SessionEventStream(this.remote'
const HOOK = '(() => { /* dsh-initial-history-v1 */ try { const factory = globalThis[Symbol.for("dsh.session-optimizer.initial-history")]; return typeof factory === "function" ? factory(this.remote) : this.remote; } catch { return this.remote; } })()'
const PATCHED_CALL = `new SessionEventStream(${HOOK}`

const BUILDS = SUPPORTED.map(entry => ({ ...entry, patched: entry.line.replace(CALL, PATCHED_CALL) }))

/** The oldest supported build, kept as the default for callers that name one. */
export const ORIGINAL_SHA256 = SUPPORTED[0].sha256
export const ORIGINAL_LINE = SUPPORTED[0].line
export const PATCHED_LINE = BUILDS[0].patched
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
function count(source, text) { return source.split(text).length - 1 }
export function patchedBytes(original) {
  const hash = sha256(original)
  const entry = BUILDS.find(build => build.sha256 === hash)
  if (entry === undefined) throw new Error('unsupported original controller SHA-256')
  const text = original.toString('utf8')
  if (count(text, entry.line) !== 1 || text.includes('dsh-initial-history-v1')) throw new Error('controller call-site is not unique/original')
  return Buffer.from(text.replace(entry.line, entry.patched), 'utf8')
}
function originalOf(current) {
  const hash = sha256(current)
  const direct = BUILDS.find(build => build.sha256 === hash)
  if (direct !== undefined) return { original: current, entry: direct }
  const text = current.toString('utf8')
  if (count(text, PATCHED_CALL) !== 1) throw new Error('unsupported current controller bytes')
  const candidate = Buffer.from(text.replace(PATCHED_CALL, CALL), 'utf8')
  const entry = BUILDS.find(build => build.sha256 === sha256(candidate))
  if (entry === undefined) throw new Error('modified controller does not match the exact supported original')
  return { original: candidate, entry }
}
function atomicReplace(target, bytes, mode) {
  const temp = `${target}.initial-history-${process.pid}.tmp`
  let created = false
  try {
    const fd = openSync(temp, 'wx', mode)
    created = true
    try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
    chmodSync(temp, mode)
    renameSync(temp, target)
    created = false
  } finally {
    if (created && existsSync(temp)) unlinkSync(temp)
  }
}
/** apply/revert refuse any unrelated edits, including edits made after our patch. */
export function patchController(action, filename) {
  if (!['inspect', 'apply', 'revert'].includes(action)) throw new Error('action must be inspect, apply or revert')
  const target = resolve(filename)
  const st = statSync(target)
  if (!st.isFile()) throw new Error('controller target must be a regular file')
  const current = readFileSync(target)
  const { original, entry } = originalOf(current)
  const patched = patchedBytes(original)
  const currentHash = sha256(current)
  const state = currentHash === entry.sha256 ? 'original' : currentHash === sha256(patched) ? 'patched' : 'unsupported'
  if (state === 'unsupported') throw new Error('unsupported current controller bytes')
  const backup = `${target}.initial-history-${entry.sha256}.original`
  if (action === 'apply') {
    if (existsSync(backup)) {
      if (sha256(readFileSync(backup)) !== entry.sha256) throw new Error('existing backup does not match supported original')
    } else writeFileSync(backup, original, { flag: 'wx', mode: st.mode })
    if (state === 'original') atomicReplace(target, patched, st.mode)
  } else if (action === 'revert' && state === 'patched') {
    if (!existsSync(backup) || sha256(readFileSync(backup)) !== entry.sha256) throw new Error('verified original backup is required for revert')
    atomicReplace(target, readFileSync(backup), st.mode)
  }
  return { action, target, controllerVersion: entry.version, stateBefore: state, stateAfter: action === 'apply' ? 'patched' : action === 'revert' ? 'original' : state,
    originalSha256: entry.sha256, patchedSha256: sha256(patched), actualSha256: sha256(readFileSync(target)), backup,
    note: 'Prepared controller Client hook only; plugin factory absent/disabled leaves official Remote. Existing loaded browser modules need a deliberate refresh.' }
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('usage: node patch-initial-history.mjs inspect|apply|revert /absolute/controller/lib/client.js')
    console.log(JSON.stringify(patchController(process.argv[2], process.argv[3]), null, 2))
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
