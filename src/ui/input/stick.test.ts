import { describe, expect, it } from 'vitest'
import { DISARMED, clampToRadius, stepStick, type StickEvent, type StickState } from './stick'

const run = (s: StickState, events: StickEvent[]): StickState => events.reduce(stepStick, s)
const move = (mx: number, my: number, radius = 200): StickEvent => ({ type: 'move', mx, my, radius })
const ticks = (n: number, dt = 1 / 60): StickEvent[] => Array.from({ length: n }, () => ({ type: 'tick', dt }))

describe('mouse stick arming', () => {
  it('ignores mouse movement until the controls are taken (flight start with cursor off-center)', () => {
    const s = run(DISARMED, [move(600, 300), move(50, 50), ...ticks(30)])
    expect(s).toEqual(DISARMED)
  })

  it('arms at neutral on pointer lock, whatever happened before', () => {
    const s = run({ armed: false, dx: 150, dy: -80 }, [{ type: 'lock' }])
    expect(s).toEqual({ armed: true, dx: 0, dy: 0 })
  })

  it('integrates relative movement once armed', () => {
    const s = run(DISARMED, [{ type: 'lock' }, move(30, -10), move(20, -10)])
    expect(s).toEqual({ armed: true, dx: 50, dy: -20 })
  })

  it('holds position while armed (no drift)', () => {
    const s = run(DISARMED, [{ type: 'lock' }, move(40, 0), ...ticks(120)])
    expect(s.dx).toBe(40)
  })

  it('clamps travel to the stick circle so reversing responds immediately', () => {
    const s = run(DISARMED, [{ type: 'lock' }, move(5000, 0), move(-100, 0)])
    expect(s.dx).toBe(100)
  })

  it('release disarms and glides back to exact neutral', () => {
    const released = run(DISARMED, [{ type: 'lock' }, move(150, 90), { type: 'unlock' }])
    expect(released.armed).toBe(false)
    expect(released.dx).toBe(150)
    const soon = run(released, ticks(6))
    expect(soon.dx).toBeGreaterThan(0)
    expect(soon.dx).toBeLessThan(150)
    expect(run(released, ticks(180))).toEqual(DISARMED)
  })

  it('ignores movement while gliding back', () => {
    const s = run(DISARMED, [{ type: 'lock' }, move(100, 0), { type: 'unlock' }, move(500, 500)])
    expect(s).toEqual({ armed: false, dx: 100, dy: 0 })
  })
})

describe('clampToRadius', () => {
  it('keeps direction and caps magnitude', () => {
    const c = clampToRadius(300, 400, 100)
    expect(c.dx).toBeCloseTo(60)
    expect(c.dy).toBeCloseTo(80)
    expect(clampToRadius(3, 4, 100)).toEqual({ dx: 3, dy: 4 })
  })
})
