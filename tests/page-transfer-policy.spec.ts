import { afterEach, describe, expect, it } from 'vitest'
import { currentPageTransferFormat, MAX_PAGE_LINE_CODE_UNITS, PAGE_TRANSFER_POLICY, pageLinesWithinBudget, registerPageTransferPolicy } from '../src/page-transfer.ts'

const dispose: Array<() => void> = []
afterEach(() => { for (const f of dispose.splice(0)) f(); Reflect.deleteProperty(globalThis, PAGE_TRANSFER_POLICY) })

describe('Host-owned page transport policy', () => {
  it('uses bytes by default and consults the current setting rather than a saved boolean', () => {
    expect(currentPageTransferFormat()).toBe('bytes')
    let enabled = false
    dispose.push(registerPageTransferPolicy(() => enabled))
    expect(currentPageTransferFormat()).toBe('bytes')
    enabled = true
    expect(currentPageTransferFormat()).toBe('lines')
    enabled = false
    expect(currentPageTransferFormat()).toBe('bytes')
  })
  it('publishes a frozen, nonwritable read-only face and refuses a second owner', () => {
    dispose.push(registerPageTransferPolicy(() => true))
    expect(Object.getOwnPropertyDescriptor(globalThis, PAGE_TRANSFER_POLICY)?.writable).toBe(false)
    expect(Object.isFrozen(Reflect.get(globalThis, PAGE_TRANSFER_POLICY))).toBe(true)
    expect(() => registerPageTransferPolicy(() => false)).toThrow('already registered')
  })
  it('unloads idempotently and an old disposer does not remove the next owner', () => {
    const old = registerPageTransferPolicy(() => true)
    old(); old()
    expect(currentPageTransferFormat()).toBe('bytes')
    const next = registerPageTransferPolicy(() => true)
    dispose.push(next)
    old()
    expect(currentPageTransferFormat()).toBe('lines')
  })
  it('falls back to bytes when the owner throws or returns an invalid value', () => {
    const broken = registerPageTransferPolicy(() => { throw new Error('unloaded controller') })
    expect(currentPageTransferFormat()).toBe('bytes')
    broken()
    dispose.push(registerPageTransferPolicy(() => 1 as unknown as boolean))
    expect(currentPageTransferFormat()).toBe('bytes')
  })
  it('does not treat an unrecognized ABI as enabled', () => {
    Object.defineProperty(globalThis, PAGE_TRANSFER_POLICY, { configurable: true, value: { version: 2, enabled: () => true } })
    expect(currentPageTransferFormat()).toBe('bytes')
  })
  it('bounds UTF-16 units including separators and rejects non-string values', () => {
    expect(pageLinesWithinBudget(['x'.repeat(MAX_PAGE_LINE_CODE_UNITS)])).toBe(true)
    expect(pageLinesWithinBudget(['x'.repeat(MAX_PAGE_LINE_CODE_UNITS), ''])).toBe(false)
    expect(pageLinesWithinBudget(['😀'.repeat(MAX_PAGE_LINE_CODE_UNITS / 2 + 1)])).toBe(false)
    expect(pageLinesWithinBudget([1 as unknown as string])).toBe(false)
    expect(pageLinesWithinBudget([])).toBe(true)
  })
})
