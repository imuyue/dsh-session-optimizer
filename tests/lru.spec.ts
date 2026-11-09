import { describe, expect, it } from 'vitest'

import { ByteLru } from '../src/lru.ts'

describe('byte-budget LRU', () => {
  it('keeps what fits and drops the coldest first', () => {
    const cache = new ByteLru<string>(10)
    cache.set('a', 'A', 4)
    cache.set('b', 'B', 4)
    cache.set('c', 'C', 4)
    // 12 bytes in a 10-byte budget: 'a' is the oldest and goes.
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe('B')
    expect(cache.get('c')).toBe('C')
    expect(cache.bytes).toBe(8)
    expect(cache.size).toBe(2)
  })

  it('reading an entry makes it the newest', () => {
    const cache = new ByteLru<string>(8)
    cache.set('a', 'A', 4)
    cache.set('b', 'B', 4)
    expect(cache.get('a')).toBe('A')
    // 'b' is now the coldest, so adding 'c' evicts it rather than 'a'.
    cache.set('c', 'C', 4)
    expect(cache.get('a')).toBe('A')
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('c')).toBe('C')
  })

  it('never evicts the only entry, even when it alone exceeds the budget', () => {
    const cache = new ByteLru<string>(4)
    cache.set('huge', 'H', 64)
    expect(cache.get('huge')).toBe('H')
    expect(cache.bytes).toBe(64)
    // The next insert may drop it, but the entry just stored stays readable.
    cache.set('small', 'S', 1)
    expect(cache.get('small')).toBe('S')
  })

  it('replacing a key charges the new size, not both', () => {
    const cache = new ByteLru<string>(10)
    cache.set('a', 'A', 6)
    cache.set('a', 'A2', 2)
    expect(cache.bytes).toBe(2)
    expect(cache.get('a')).toBe('A2')
    // Room for one more six-byte entry now.
    cache.set('b', 'B', 6)
    expect(cache.get('a')).toBe('A2')
    expect(cache.get('b')).toBe('B')
    expect(cache.bytes).toBe(8)
  })

  it('clear empties both the entries and the byte count', () => {
    const cache = new ByteLru<string>(16)
    cache.set('a', 'A', 4)
    cache.set('b', 'B', 4)
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.bytes).toBe(0)
    expect(cache.get('a')).toBeUndefined()
    // Still usable after a clear.
    cache.set('c', 'C', 4)
    expect(cache.get('c')).toBe('C')
  })

  it('delete removes one entry and its charge', () => {
    const cache = new ByteLru<string>(16)
    cache.set('a', 'A', 5)
    cache.set('b', 'B', 5)
    cache.delete('a')
    expect(cache.bytes).toBe(5)
    expect(cache.size).toBe(1)
    expect(cache.get('a')).toBeUndefined()
  })

  it('deletes one store without touching another', () => {
    const cache = new ByteLru<string>(64)
    cache.set('/one\u00000:5', 'A', 4)
    cache.set('/one\u00005:5', 'B', 4)
    cache.set('/two\u00000:5', 'C', 4)
    cache.deletePrefix('/one\u0000')
    expect(cache.get('/one\u00000:5')).toBeUndefined()
    expect(cache.get('/one\u00005:5')).toBeUndefined()
    // The other conversation's frames are still valid: a write to one store must
    // not evict the pages of a store nobody wrote to.
    expect(cache.get('/two\u00000:5')).toBe('C')
    expect(cache.bytes).toBe(4)
  })

  it('shares one budget across stores instead of giving each its own', () => {
    const cache = new ByteLru<string>(10)
    cache.set('/one\u00000:5', 'A', 4)
    cache.set('/two\u00000:5', 'B', 4)
    cache.set('/three\u00000:5', 'C', 4)
    // Three stores, one budget: the oldest frame goes even though it belongs to a
    // session that was never written to.
    expect(cache.get('/one\u00000:5')).toBeUndefined()
    expect(cache.size).toBe(2)
    expect(cache.bytes).toBe(8)
  })
})
