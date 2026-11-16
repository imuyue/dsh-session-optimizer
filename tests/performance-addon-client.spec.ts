import { expect, it } from 'vitest'
import { apply, inject } from '../client/performance-addon.tsx'
import type { ClientContext } from '../client/context.ts'
import { textOf } from '../client/i18n.ts'

it('keeps the performance add-on Client inert alongside the optimizer Client', () => {
  // Any registration, service access or effect would create a second owner.
  const ctx = new Proxy({}, {
    get(_target, property) { throw new Error(`unexpected add-on Client access: ${String(property)}`) },
  }) as ClientContext
  expect(inject).toEqual([])
  expect(() => apply(ctx)).not.toThrow()
})

it('names the unified console in both languages while preserving storage-format labels', () => {
  expect(textOf('zh').title).toBe('会话优化')
  expect(textOf('zh').navLabel).toBe('会话优化视图')
  expect(textOf('en').title).toBe('Session Optimization')
  expect(textOf('en').navLabel).toBe('Session optimization views')
  // The console title changes; storage format controls retain their meaning.
  expect(textOf('zh').settings.storage).toBe('存储')
  expect(textOf('en').settings.storage).toBe('Storage')
})
