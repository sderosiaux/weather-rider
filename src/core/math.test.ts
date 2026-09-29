import { describe, expect, it } from 'vitest'
import { BODY_FORWARD, BODY_RIGHT, cross, BODY_UP, qFromAxisAngle, qRotate, v3 } from './math'

describe('frame conventions', () => {
  it('right = forward × up', () => {
    expect(cross(BODY_FORWARD, BODY_UP)).toEqual(BODY_RIGHT)
  })
  it('positive yaw about +y turns the nose north (-z), i.e. left', () => {
    const f = qRotate(qFromAxisAngle(v3(0, 1, 0), Math.PI / 2), BODY_FORWARD)
    expect(f.x).toBeCloseTo(0)
    expect(f.z).toBeCloseTo(-1)
  })
  it('positive rotation about body +z pitches the nose up', () => {
    const f = qRotate(qFromAxisAngle(v3(0, 0, 1), 0.3), BODY_FORWARD)
    expect(f.y).toBeGreaterThan(0)
  })
  it('positive rotation about body +x drops the right wing (+z) down', () => {
    const r = qRotate(qFromAxisAngle(v3(1, 0, 0), 0.3), BODY_RIGHT)
    expect(r.y).toBeLessThan(0)
  })
})
