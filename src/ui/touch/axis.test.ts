import { describe, expect, it } from 'vitest'
import { knobOffset, stickReach, touchStickAxes, touchStickRadius, type Rect } from './axis'

const IPAD: Rect = { left: 0, top: 0, right: 1024, bottom: 768 }
const R = touchStickRadius(1024, 768)

describe('touch stick radius', () => {
  it('is a thumb-sized travel at the three iPad landscape sizes', () => {
    expect(touchStickRadius(1024, 768)).toBeCloseTo(69.1, 1)
    expect(touchStickRadius(1180, 820)).toBeCloseTo(73.8, 1)
    expect(touchStickRadius(1366, 1024)).toBe(88)
  })
  it('stays usable on small and huge screens', () => {
    expect(touchStickRadius(640, 360)).toBe(56)
    expect(touchStickRadius(2560, 1440)).toBe(88)
  })
})

describe('touch stick axes', () => {
  const origin = { x: 200, y: 560 }
  const reach = stickReach(origin, IPAD, R)

  it('the landing point is neutral and thumb wobble stays in the deadzone', () => {
    expect(touchStickAxes(origin, origin, reach, false)).toEqual({ pitch: 0, roll: 0 })
    expect(touchStickAxes(origin, { x: 205, y: 556 }, reach, false)).toEqual({ pitch: 0, roll: 0 })
  })

  it('thumb right rolls right, thumb up is nose up, full at the radius', () => {
    const right = touchStickAxes(origin, { x: 200 + R, y: 560 }, reach, false)
    expect(right.roll).toBeCloseTo(1)
    expect(right.pitch).toBeCloseTo(0)
    const up = touchStickAxes(origin, { x: 200, y: 560 - R }, reach, false)
    expect(up.pitch).toBeCloseTo(1)
    expect(up.roll).toBeCloseTo(0)
  })

  it('invertPitch flips pitch only', () => {
    const s = touchStickAxes(origin, { x: 200 + R / 2, y: 560 - R }, reach, true)
    expect(s.pitch).toBeLessThan(0)
    expect(s.roll).toBeGreaterThan(0)
  })

  it('saturates past the ring and softens the center like the mouse stick', () => {
    expect(touchStickAxes(origin, { x: 200 - 4 * R, y: 560 }, reach, false).roll).toBeCloseTo(-1)
    const half = touchStickAxes(origin, { x: 200 + R / 2, y: 560 }, reach, false).roll
    expect(half).toBeGreaterThan(0)
    expect(half).toBeLessThan(0.5)
  })
})

describe('stick started near an edge', () => {
  it('still reaches full deflection toward that edge', () => {
    const origin = { x: 50, y: 700 }
    const reach = stickReach(origin, IPAD, R)
    expect(reach.left).toBeLessThan(R)
    expect(reach.down).toBeLessThan(R)
    expect(reach.right).toBe(R)
    expect(touchStickAxes(origin, { x: 6, y: 700 }, reach, false).roll).toBeCloseTo(-1)
    // Down is nose down by default.
    expect(touchStickAxes(origin, { x: 50, y: 762 }, reach, false).pitch).toBeCloseTo(-1)
  })

  it('never turns hypersensitive when the thumb lands on the edge itself', () => {
    const reach = stickReach({ x: 2, y: 400 }, IPAD, R)
    expect(reach.left).toBeCloseTo(R * 0.45)
  })
})

describe('knob drawing', () => {
  const origin = { x: 300, y: 500 }
  const reach = stickReach(origin, IPAD, R)
  it('follows the thumb inside the ring and stops at the ring', () => {
    const near = knobOffset(origin, { x: 320, y: 490 }, reach, R)
    expect(near.x).toBeCloseTo(20)
    expect(near.y).toBeCloseTo(-10)
    const far = knobOffset(origin, { x: 300 + 3 * R, y: 500 + 3 * R }, reach, R)
    expect(Math.hypot(far.x, far.y)).toBeCloseTo(R)
    expect(far.x).toBeCloseTo(far.y)
  })
})
