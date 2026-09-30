import { describe, expect, it } from 'vitest'
import { safeStorage } from './safeStorage'

describe('safeStorage', () => {
  it('falls back to memory when accessing localStorage throws', () => {
    const { storage, persistent } = safeStorage(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    })
    expect(persistent).toBe(false)
    storage.setItem('k', 'v')
    expect(storage.getItem('k')).toBe('v')
    storage.removeItem('k')
    expect(storage.getItem('k')).toBeNull()
  })
})
