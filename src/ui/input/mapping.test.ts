import { describe, expect, it } from 'vitest'
import {
  deadzone,
  digitalAxis,
  expo,
  integrateThrottle,
  mixAxis,
  shapeAxis,
  smoothToward,
  stickFromOffset,
  wheelToThrottleDelta,
} from './mapping'

describe('deadzone', () => {
  it('kills small noise and still reaches full deflection', () => {
    expect(deadzone(0.05, 0.1)).toBe(0)
    expect(deadzone(-0.1, 0.1)).toBe(0)
    expect(deadzone(1, 0.1)).toBe(1)
    expect(deadzone(-1, 0.1)).toBe(-1)
  })
  it('is continuous at the edge of the zone', () => {
    expect(deadzone(0.1001, 0.1)).toBeCloseTo(0, 3)
    expect(deadzone(0.55, 0.1)).toBeCloseTo(0.5, 6)
  })
})

describe('expo', () => {
  it('keeps endpoints and sign, softens center', () => {
    expect(expo(1, 0.6)).toBeCloseTo(1)
    expect(expo(-1, 0.6)).toBeCloseTo(-1)
    expect(expo(0.3, 0.6)).toBeLessThan(0.3)
    expect(expo(-0.3, 0.6)).toBeGreaterThan(-0.3)
  })
  it('is monotonic', () => {
    let prev = -Infinity
    for (let v = -1; v <= 1; v += 0.05) {
      const y = expo(v, 0.8)
      expect(y).toBeGreaterThan(prev)
      prev = y
    }
  })
  it('shapeAxis clamps out-of-range raw values', () => {
    expect(shapeAxis(3, 0.1, 0.5)).toBeCloseTo(1)
  })
})

describe('stickFromOffset', () => {
  const shape = { deadzone: 0.08, expo: 0.5 }
  it('center and deadzone produce no command', () => {
    expect(stickFromOffset(0, 0, 200, shape, false)).toEqual({ pitch: 0, roll: 0 })
    expect(stickFromOffset(10, -5, 200, shape, false)).toEqual({ pitch: 0, roll: 0 })
  })
  it('screen-up is nose-up, right is roll right', () => {
    const up = stickFromOffset(0, -200, 200, shape, false)
    expect(up.pitch).toBeCloseTo(1)
    expect(up.roll).toBeCloseTo(0)
    const right = stickFromOffset(200, 0, 200, shape, false)
    expect(right.roll).toBeCloseTo(1)
  })
  it('invertPitch flips pitch only', () => {
    const s = stickFromOffset(100, -200, 200, shape, true)
    expect(s.pitch).toBeLessThan(0)
    expect(s.roll).toBeGreaterThan(0)
  })
  it('saturates beyond the radius', () => {
    const far = stickFromOffset(0, 5000, 200, shape, false)
    expect(far.pitch).toBeCloseTo(-1)
  })
})

describe('digitalAxis', () => {
  it('opposite keys cancel', () => {
    expect(digitalAxis(true, true)).toBe(0)
    expect(digitalAxis(true, false)).toBe(-1)
    expect(digitalAxis(false, true)).toBe(1)
  })
})

describe('smoothToward', () => {
  it('converges without overshoot and is frame-rate independent', () => {
    let a = 0
    for (let i = 0; i < 60; i++) a = smoothToward(a, 1, 1 / 60, 0.1)
    let b = 0
    for (let i = 0; i < 30; i++) b = smoothToward(b, 1, 1 / 30, 0.1)
    expect(a).toBeLessThanOrEqual(1)
    expect(a).toBeGreaterThan(0.99)
    expect(a).toBeCloseTo(b, 6)
  })
  it('tau 0 snaps', () => {
    expect(smoothToward(0, 0.7, 0.016, 0)).toBe(0.7)
  })
})

describe('throttle', () => {
  it('integrates rate and stays in [0,1]', () => {
    expect(integrateThrottle(0.5, 0.5, 0.5)).toBeCloseTo(0.75)
    expect(integrateThrottle(0.9, 1, 1)).toBe(1)
    expect(integrateThrottle(0.1, -1, 1)).toBe(0)
  })
  it('wheel up adds power', () => {
    expect(wheelToThrottleDelta(-100, 0.001)).toBeCloseTo(0.1)
    expect(wheelToThrottleDelta(100, 0.001)).toBeCloseTo(-0.1)
  })
})

describe('mixAxis', () => {
  it('first active source wins', () => {
    expect(mixAxis([0, -1, 0.4])).toBe(-1)
    expect(mixAxis([0.3, -1, 0.4])).toBe(0.3)
    expect(mixAxis([0, 0, 0.4])).toBe(0.4)
    expect(mixAxis([0, 0, 0])).toBe(0)
  })
})
