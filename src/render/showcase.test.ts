import { describe, expect, it } from 'vitest'
import { easeInOut, SAFE_BOX, showcaseFraming } from './showcase'

/** Projected screen box (fractions of the canvas) of a sphere at the look-at point, after the view offset. */
function projectedBox(radius: number, aspect: number, vfov: number) {
  const f = showcaseFraming(radius, aspect, vfov)
  const tanHalfV = Math.tan((vfov * Math.PI) / 360)
  const angularTan = Math.tan(Math.asin(radius / f.distance))
  const halfW = (angularTan / (tanHalfV * aspect)) * 0.5
  const halfH = (angularTan / tanHalfV) * 0.5
  const cx = 0.5 - f.offsetX
  const cy = 0.5 - f.offsetY
  return { x0: cx - halfW, x1: cx + halfW, y0: cy - halfH, y1: cy + halfH }
}

describe('showcaseFraming', () => {
  it('keeps the aircraft inside the safe box at every laptop/tablet aspect', () => {
    for (const aspect of [1440 / 900, 1280 / 800, 1920 / 1080, 980 / 700, 1.2]) {
      const b = projectedBox(30, aspect, 30)
      expect(b.x0).toBeGreaterThanOrEqual(SAFE_BOX.x0 - 1e-9)
      expect(b.x1).toBeLessThanOrEqual(SAFE_BOX.x1 + 1e-9)
      expect(b.y0).toBeGreaterThanOrEqual(SAFE_BOX.y0 - 1e-9)
      expect(b.y1).toBeLessThanOrEqual(SAFE_BOX.y1 + 1e-9)
    }
  })

  it('centres the aircraft in the box: 30% across, ~46% down', () => {
    const f = showcaseFraming(30, 1.6, 30)
    expect(0.5 - f.offsetX).toBeCloseTo(0.3, 9)
    expect(0.5 - f.offsetY).toBeCloseTo(0.465, 9)
  })

  it('scales with the airframe: twice the radius, twice the distance', () => {
    const a = showcaseFraming(20, 1.6, 30).distance
    const b = showcaseFraming(40, 1.6, 30).distance
    expect(b / a).toBeCloseTo(2, 6)
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
