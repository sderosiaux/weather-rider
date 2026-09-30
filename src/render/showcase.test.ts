import { describe, expect, it } from 'vitest'
import { easeInOut, showcaseFraming, visibleFractionFromRects } from './showcase'

describe('showcaseFraming', () => {
  it('fits the sphere inside the visible band, horizontally and vertically', () => {
    for (const aspect of [1440 / 900, 1280 / 800, 16 / 9, 1.2]) {
      const { distance } = showcaseFraming(30, aspect, 30, 0.6)
      const angular = Math.asin(30 / distance)
      const tanHalfV = Math.tan((15 * Math.PI) / 180)
      expect(Math.tan(angular)).toBeLessThanOrEqual(tanHalfV * aspect * 0.6 + 1e-9)
      expect(Math.tan(angular)).toBeLessThanOrEqual(tanHalfV + 1e-9)
    }
  })

  it('scales with the airframe: twice the radius, twice the distance', () => {
    const a = showcaseFraming(20, 1.6, 30).distance
    const b = showcaseFraming(40, 1.6, 30).distance
    expect(b / a).toBeCloseTo(2, 6)
  })

  it('centres the aircraft on the visible band', () => {
    expect(showcaseFraming(30, 1.6, 30, 0.6).offsetFraction).toBeCloseTo(0.2, 9)
    expect(showcaseFraming(30, 1.6, 30, 1).offsetFraction).toBe(0)
  })
})

describe('easeInOut', () => {
  it('clamps and is monotonic', () => {
    expect(easeInOut(-1)).toBe(0)
    expect(easeInOut(2)).toBe(1)
    let prev = 0
    for (let t = 0; t <= 1; t += 0.05) {
      expect(easeInOut(t)).toBeGreaterThanOrEqual(prev)
      prev = easeInOut(t)
    }
  })
})

describe('visibleFractionFromRects', () => {
  it('matches the hangar panel at 1440 and 1280 wide (clamp(440px, 39vw, 580px) on the right)', () => {
    for (const w of [1440, 1280]) {
      const panelW = Math.min(580, Math.max(440, 0.39 * w))
      const f = visibleFractionFromRects({ left: 0, width: w }, { left: w - panelW - 24, width: panelW })!
      expect(f).toBeGreaterThan(0.55)
      expect(f).toBeLessThan(0.62)
    }
  })
  it('falls back to null without a laid-out panel, and centres when the panel covers the screen', () => {
    expect(visibleFractionFromRects({ left: 0, width: 1440 }, null)).toBeNull()
    expect(visibleFractionFromRects({ left: 0, width: 1440 }, { left: 0, width: 0 })).toBeNull()
    expect(visibleFractionFromRects({ left: 0, width: 600 }, { left: 20, width: 560 })).toBe(1)
  })
})
