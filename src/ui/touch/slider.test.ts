import { describe, expect, it } from 'vitest'
import { dragThrottle } from './slider'

describe('throttle lever', () => {
  it('a full track up is the full range, half a track is half of it', () => {
    expect(dragThrottle(0, 400, 200, 200)).toBe(1)
    expect(dragThrottle(0.2, 400, 300, 200)).toBeCloseTo(0.7)
  })

  it('down takes power off', () => {
    expect(dragThrottle(0.6, 300, 350, 200)).toBeCloseTo(0.35)
    expect(dragThrottle(0.1, 300, 900, 200)).toBe(0)
  })

  it('drops travel past an end: reversing answers at once', () => {
    let t = 0.9
    t = dragThrottle(t, 300, 200, 200)
    t = dragThrottle(t, 200, 60, 200)
    expect(t).toBe(1)
    t = dragThrottle(t, 60, 80, 200)
    expect(t).toBeCloseTo(0.9)
  })

  it('keeps the setting on a degenerate track or a garbage position', () => {
    expect(dragThrottle(0.4, 300, 100, 0)).toBe(0.4)
    expect(dragThrottle(0.4, 300, Number.NaN, 200)).toBe(0.4)
    expect(dragThrottle(0.4, Number.NaN, 100, 200)).toBe(0.4)
  })
})
