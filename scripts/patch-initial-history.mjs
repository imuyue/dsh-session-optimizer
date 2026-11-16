#!/usr/bin/env node
/** Prepared exact-version patch. No file changes unless the caller explicitly selects apply/revert. */
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ORIGINAL_SHA256 = '13a1b441f7fe7fa7698a3352b1904e5645fd844e6f63a7c1c5fcef415cfcae4c'
export const ORIGINAL_LINE = 'const events = new SessionEventStream(this.remote, this.sessionAddress(), {'
export const PATCHED_LINE = 'const events = new SessionEventStream((() => { /* dsh-initial-history-v1 */ try { const factory = globalThis[Symbol.for("dsh.session-optimizer.initial-history")]; return typeof factory === "function" ? factory(this.remote) : this.remote; } catch { return this.remote; } })(), this.sessionAddress(), {'
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
function count(source, text) { return source.split(text).length - 1 }
export function patchedBytes(original) {
  if (sha256(original) !== ORIGINAL_SHA256) throw new Error('unsupported original controller SHA-256')
  const text = original.toString('utf8')
  if (count(text, ORIGINAL_LINE) !== 1 || text.includes('dsh-initial-history-v1')) throw new Error('controller call-site is not unique/original')
  return Buffer.from(text.replace(ORIGINAL_LINE, PATCHED_LINE), 'utf8')
}
function originalOf(current) {
  if (sha256(current) === ORIGINAL_SHA256) return current
  const text = current.toString('utf8')
  if (count(text, PATCHED_LINE) !== 1) throw new Error('unsupported current controller bytes')
  const candidate = Buffer.from(text.replace(PATCHED_LINE, ORIGINAL_LINE), 'utf8')
  if (sha256(candidate) !== ORIGINAL_SHA256) throw new Error('modified controller does not match the exact supported original')
  return candidate
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
  const original = originalOf(current)
  const patched = patchedBytes(original)
  const currentHash = sha256(current)
  const state = currentHash === ORIGINAL_SHA256 ? 'original' : currentHash === sha256(patched) ? 'patched' : 'unsupported'
  if (state === 'unsupported') throw new Error('unsupported current controller bytes')
  const backup = `${target}.initial-history-${ORIGINAL_SHA256}.original`
  if (action === 'apply') {
    if (existsSync(backup)) {
      if (sha256(readFileSync(backup)) !== ORIGINAL_SHA256) throw new Error('existing backup does not match supported original')
    } else writeFileSync(backup, original, { flag: 'wx', mode: st.mode })
    if (state === 'original') atomicReplace(target, patched, st.mode)
  } else if (action === 'revert' && state === 'patched') {
    if (!existsSync(backup) || sha256(readFileSync(backup)) !== ORIGINAL_SHA256) throw new Error('verified original backup is required for revert')
    atomicReplace(target, readFileSync(backup), st.mode)
  }
  return { action, target, stateBefore: state, stateAfter: action === 'apply' ? 'patched' : action === 'revert' ? 'original' : state,
    originalSha256: ORIGINAL_SHA256, patchedSha256: sha256(patched), actualSha256: sha256(readFileSync(target)), backup,
    note: 'Prepared controller Client hook only; plugin factory absent/disabled leaves official Remote. Existing loaded browser modules need a deliberate refresh.' }
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('usage: node patch-initial-history.mjs inspect|apply|revert /absolute/controller/lib/client.js')
    console.log(JSON.stringify(patchController(process.argv[2], process.argv[3]), null, 2))
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
