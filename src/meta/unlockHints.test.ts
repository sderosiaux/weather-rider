import { describe, expect, it } from 'vitest'
import { newProgress, unlockHints } from './progression'

describe('unlockHints', () => {
  it('fresh pilot: regional needs 2 flights, later aircraft wait in order', () => {
    const h = unlockHints(newProgress('ada'))
    expect(h.turboprop).toBeUndefined()
    expect(h.regional).toBe('2 more flights')
    expect(h.narrowbody).toBe('Unlock regional first')
  })
  it('names the missing board score', () => {
    const p = { ...newProgress('ada'), flights: 5, unlockedAircraft: ['turboprop', 'regional'] }
    expect(unlockHints(p).narrowbody).toBe('Smooth 250')
  })
})
