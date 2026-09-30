import { describe, expect, it } from 'vitest'
import { touchStickAxes, touchStickRadius } from './axis'
import { NO_TOUCH, PAD_SLOP, landingAt, stepTouch, type FingerEvent, type LandingContext, type TouchState } from './gesture'

// iPad 1024×768 landscape, pads and track where the layer draws them.
const surface = { left: 0, top: 0, right: 1024, bottom: 768 }
const pads = {
  left: { left: 821, top: 597, right: 873, bottom: 649 },
  right: { left: 881, top: 597, right: 933, bottom: 649 },
}
const TRACK = 175
const R = touchStickRadius(1024, 768)
const ctx = (throttle = 0.6, shown = true): LandingContext => ({ surface, pads: shown ? pads : null, trackPx: TRACK, throttle })

const down = (id: number, x: number, y: number, c = ctx()): FingerEvent => ({ type: 'down', id, at: { x, y }, landing: landingAt({ x, y }, c) })
const move = (id: number, x: number, y: number): FingerEvent => ({ type: 'move', id, at: { x, y } })
const up = (id: number): FingerEvent => ({ type: 'up', id })
const run = (events: FingerEvent[], s: TouchState = NO_TOUCH): TouchState => events.reduce(stepTouch, s)

describe('where a finger lands decides its role', () => {
  it('left half is the stick, anchored where the thumb lands', () => {
    const s = run([down(1, 150, 560)])
    expect(s.stick).toMatchObject({ id: 1, origin: { x: 150, y: 560 }, at: { x: 150, y: 560 }, radius: R })
    expect(s.throttle).toBeNull()
  })

  it('right half is the throttle lever, the pads are yaw', () => {
    expect(landingAt({ x: 960, y: 520 }, ctx()).role).toBe('throttle')
    expect(landingAt({ x: 600, y: 120 }, ctx()).role).toBe('throttle')
    expect(landingAt({ x: 845, y: 620 }, ctx())).toMatchObject({ role: 'yaw', dir: -1 })
    expect(landingAt({ x: 905, y: 620 }, ctx())).toMatchObject({ role: 'yaw', dir: 1 })
  })

  it('a fat finger just outside a pad still presses it', () => {
    expect(landingAt({ x: 821 - PAD_SLOP + 1, y: 600 }, ctx()).role).toBe('yaw')
    expect(landingAt({ x: 821 - PAD_SLOP - 2, y: 600 }, ctx()).role).toBe('throttle')
  })

  it('pads are dead while the layer is hidden: a first touch there is the throttle', () => {
    expect(landingAt({ x: 845, y: 620 }, ctx(0.6, false)).role).toBe('throttle')
  })
})

describe('two thumbs', () => {
  it('steer and set power at the same time', () => {
    const s = run([down(1, 150, 560), down(2, 960, 560, ctx(0.5)), move(1, 150 + R, 560), move(2, 960, 560 - TRACK / 4), move(1, 150 + R, 560)])
    expect(s.stick?.at).toEqual({ x: 150 + R, y: 560 })
    expect(s.throttle?.throttle).toBeCloseTo(0.75)
    const axes = touchStickAxes(s.stick!.origin, s.stick!.at, s.stick!.reach, false)
    expect(axes.roll).toBeCloseTo(1)
  })

  it('lifting the stick thumb frees only the stick', () => {
    const s = run([down(1, 150, 560), down(2, 960, 560), up(1)])
    expect(s.stick).toBeNull()
    expect(s.throttle?.id).toBe(2)
  })

  it('a second finger on the left cannot steal the stick, and lifting it changes nothing', () => {
    const s = run([down(1, 150, 560), move(1, 190, 560), down(3, 320, 420), move(3, 400, 300), up(3)])
    expect(s.stick).toMatchObject({ id: 1, origin: { x: 150, y: 560 }, at: { x: 190, y: 560 } })
  })
})

describe('throttle lever', () => {
  it('grabbing never jumps the power, even far from the handle', () => {
    const s = run([down(2, 700, 120, ctx(0.3))])
    expect(s.throttle?.throttle).toBe(0.3)
  })

  it('follows the thumb one track for the full range, and keeps nothing past the top', () => {
    const s = run([down(2, 960, 600, ctx(0.3)), move(2, 960, 600 - TRACK * 0.2)])
    expect(s.throttle?.throttle).toBeCloseTo(0.5)
    const pastTop = run([move(2, 960, 0), move(2, 960, 35)], s)
    expect(pastTop.throttle?.throttle).toBeCloseTo(0.8)
  })
})

describe('yaw pads', () => {
  it('hold to yaw, slide across to switch side, lift to stop', () => {
    const held = run([down(4, 845, 620)])
    expect(held.yaw?.dir).toBe(-1)
    const switched = run([move(4, 910, 625)], held)
    expect(switched.yaw?.dir).toBe(1)
    expect(run([up(4)], switched).yaw).toBeNull()
  })
})

describe('letting go', () => {
  it('a menu or a new flight drops every finger; their later moves and lifts are ignored', () => {
    const s = run([down(1, 150, 560), down(2, 960, 560), down(4, 845, 620), { type: 'release' }, move(1, 300, 560), move(2, 960, 100), up(4)])
    expect(s).toEqual(NO_TOUCH)
  })

  it('fingers without a role are ignored', () => {
    const s = run([down(1, 150, 560)])
    expect(stepTouch(s, move(9, 10, 10))).toBe(s)
    expect(stepTouch(s, up(9))).toBe(s)
  })

  it('a garbage position never reaches the controls', () => {
    const s = run([down(1, 150, 560), down(2, 960, 560, ctx(0.5))])
    const after = run([move(1, Number.NaN, 560), move(2, 960, Number.POSITIVE_INFINITY), { type: 'down', id: 5, at: { x: Number.NaN, y: 0 }, landing: landingAt({ x: 0, y: 0 }, ctx()) }], s)
    expect(after).toBe(s)
  })

  it('a reused id whose lift was missed starts clean where it lands', () => {
    const s = run([down(1, 150, 560), move(1, 200, 560), down(1, 300, 300)])
    expect(s.stick).toMatchObject({ id: 1, origin: { x: 300, y: 300 }, at: { x: 300, y: 300 } })
  })
})
