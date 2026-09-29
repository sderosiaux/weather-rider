import { describe, expect, it } from 'vitest'
import { qFromAxisAngle, qMul, v3 } from '../core/math'
import { bankOf, BASE_FOV, chaseDistance, fovForSpeed, smoothing } from './camera'

describe('bankOf', () => {
  it('is positive when the right wing is down, whatever the heading and pitch', () => {
    for (const heading of [0, 1.2, -2.5]) {
      for (const pitch of [0, 0.2, -0.15]) {
        const q = qMul(qMul(qFromAxisAngle(v3(0, 1, 0), heading), qFromAxisAngle(v3(0, 0, 1), pitch)), qFromAxisAngle(v3(1, 0, 0), 0.4))
        expect(bankOf(q)).toBeCloseTo(0.4, 1)
        expect(bankOf(q)).toBeGreaterThan(0)
      }
    }
    expect(bankOf(qFromAxisAngle(v3(1, 0, 0), -0.3))).toBeCloseTo(-0.3, 6)
    expect(bankOf({ x: 0, y: 0, z: 0, w: 1 })).toBe(0)
  })
})

describe('smoothing', () => {
  it('is frame-rate independent: two half steps equal one full step', () => {
    const one = smoothing(3, 1 / 30)
    const half = smoothing(3, 1 / 60)
    expect(1 - (1 - half) * (1 - half)).toBeCloseTo(one, 10)
  })
  it('stays in [0, 1) and ignores negative dt', () => {
    expect(smoothing(5, -1)).toBe(0)
    expect(smoothing(5, 10)).toBeLessThanOrEqual(1)
  })
})

describe('fovForSpeed', () => {
  it('starts at the base FOV and widens monotonically with ground speed', () => {
    expect(fovForSpeed(100, 140)).toBe(BASE_FOV)
    let prev = 0
    for (let gs = 0; gs <= 600; gs += 20) {
      const f = fovForSpeed(gs, 140)
      expect(f).toBeGreaterThanOrEqual(prev)
      prev = f
    }
    expect(prev).toBeLessThanOrEqual(BASE_FOV + 10)
  })
})

describe('chaseDistance', () => {
  it('keeps the airframe a small figure: several lengths away', () => {
    for (const l of [27, 64]) expect(chaseDistance(l) / l).toBeGreaterThan(5)
  })
})
