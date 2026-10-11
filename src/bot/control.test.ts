import { describe, expect, it } from 'vitest'
import { SIM_DT } from '../core/constants'
import { createFixtureWeather, createFlatTerrain, fixtureRoute } from '../core/fixtures'
import { v3 } from '../core/math'
import type { AircraftState, WeatherField } from '../core/types'
import { AIRCRAFT, aircraftById, flightModel } from '../flight'
import { uniformWeather } from '../flight/testkit'
import { bankAngle, bankForTrack, HUMAN_HANDS, horizontalDistance, orbitBank, orbitTrack, trackOf, wrapAngle } from './control'
import { createInnerLoop, type Intent } from './pilot'

const terrain = createFlatTerrain()

const DEG = Math.PI / 180
const still = uniformWeather()
/** The fixture route with a gate out of reach, so long holds never "arrive". */
const route = { ...fixtureRoute, gate: v3(1e7, 3000, 0) }

/** Flies `seconds` with a fixed intent through the inner loops; calls onStep after each step. */
function hold(
  specId: string,
  weather: WeatherField,
  intentOf: (s: AircraftState) => Intent,
  seconds: number,
  start?: (s: AircraftState) => AircraftState,
  onStep?: (s: AircraftState) => void,
): AircraftState {
  const spec = aircraftById(specId)
  const inner = createInnerLoop(spec, weather, HUMAN_HANDS)
  const s0 = flightModel.initialState(spec, { route, weather, terrain })
  let s = start ? start(s0) : s0
  for (let i = 0; i < seconds / SIM_DT && s.status === 'flying'; i++) {
    s = flightModel.step(spec, s, inner(s, intentOf(s)), { route, weather, terrain }, SIM_DT)
    onStep?.(s)
  }
  return s
}

const cruise = (spec: string, over: Partial<Intent> = {}): Intent => ({
  track: 0,
  maxBank: 25 * DEG,
  vertical: { kind: 'altitude', target: 3000, maxClimb: 8, maxSink: 8, tau: 25 },
  speed: aircraftById(spec).cruiseSpeedMs,
  minThrottle: 0,
  maxThrottle: 1,
  gLimit: 0.1,
  ...over,
})

describe('angle helpers', () => {
  it('wraps into [-π, π)', () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(-Math.PI)
    expect(wrapAngle(-0.5)).toBeCloseTo(-0.5)
    expect(wrapAngle(2 * Math.PI + 0.25)).toBeCloseTo(0.25)
  })
  it('banks left (negative) toward a track on the left (north of east), right toward the right', () => {
    expect(bankForTrack(0, 30 * DEG, 25 * DEG)).toBeLessThan(0)
    expect(bankForTrack(0, -30 * DEG, 25 * DEG)).toBeGreaterThan(0)
    expect(Math.abs(bankForTrack(0, 170 * DEG, 25 * DEG))).toBeCloseTo(25 * DEG)
  })
  it('orbit guidance is tangent on the circle, points inward outside it, outward inside it', () => {
    const c = v3(0, 0, 0)
    // East of the centre, counter-clockwise seen from above (+x east, −z north): tangent is north (heading +90°).
    expect(orbitTrack(v3(1000, 0, 0), c, 1000, 1)).toBeCloseTo(90 * DEG)
    expect(orbitTrack(v3(3000, 0, 0), c, 1000, 1)).toBeGreaterThan(90 * DEG)
    expect(orbitTrack(v3(300, 0, 0), c, 1000, 1)).toBeLessThan(90 * DEG)
    expect(orbitBank(100, 1000, 1)).toBeLessThan(0)
  })
})

describe('heading hold (still air)', () => {
  it.each(AIRCRAFT.map((a) => [a.id]))('%s turns 90° left and holds the new track and altitude', (id) => {
    let maxAltDev = 0
    const end = hold(id, still, () => cruise(id, { track: 90 * DEG }), 200, undefined, (s) => {
      maxAltDev = Math.max(maxAltDev, Math.abs(s.pos.y - 3000))
    })
    expect(end.status).toBe('flying')
    expect(Math.abs(wrapAngle(trackOf(end.vel) - 90 * DEG))).toBeLessThan(2 * DEG)
    expect(Math.abs(bankAngle(end.orientation))).toBeLessThan(3 * DEG)
    expect(maxAltDev).toBeLessThan(120)
  })

  it('corrects for a crosswind: ground track, not heading, follows the target', () => {
    const windy = uniformWeather(v3(0, 0, 25))
    const end = hold('regional', windy, () => cruise('regional'), 90)
    expect(Math.abs(wrapAngle(trackOf(end.vel)))).toBeLessThan(1.5 * DEG)
  })
})

describe('altitude hold (still air)', () => {
  it.each(AIRCRAFT.map((a) => [a.id]))('%s climbs 1000 m gently: settles ±40 m, overshoot < 150 m, |Δg| < 0.25', (id) => {
    let maxAlt = 0
    let maxDg = 0
    const end = hold(id, still, () => cruise(id, { vertical: { kind: 'altitude', target: 4000, maxClimb: 8, maxSink: 8, tau: 25 } }), 330, undefined, (s) => {
      maxAlt = Math.max(maxAlt, s.pos.y)
      maxDg = Math.max(maxDg, Math.abs(s.gLoad - 1))
    })
    expect(end.status).toBe('flying')
    expect(Math.abs(end.pos.y - 4000)).toBeLessThan(40)
    expect(maxAlt - 4000).toBeLessThan(150)
    expect(maxDg).toBeLessThan(0.25)
    expect(Math.abs(end.airspeed - aircraftById(id).cruiseSpeedMs)).toBeLessThan(8)
  })

  it('holds altitude through the fixture downdraft better than neutral stick', () => {
    const weather = createFixtureWeather(1)
    const at = (s: AircraftState): AircraftState => ({ ...s, pos: v3(45_000, 3000, 4000) })
    let worst = 0
    hold('narrowbody', weather, () => cruise('narrowbody'), 90, at, (s) => {
      worst = Math.max(worst, 3000 - s.pos.y)
    })
    const spec = aircraftById('narrowbody')
    let s = at(flightModel.initialState(spec, { route, weather, terrain }))
    let neutralWorst = 0
    for (let i = 0; i < 90 / SIM_DT; i++) {
      s = flightModel.step(spec, s, { pitch: 0, roll: 0, yaw: 0, throttle: s.throttle }, { route, weather, terrain }, SIM_DT)
      neutralWorst = Math.max(neutralWorst, 3000 - s.pos.y)
    }
    expect(neutralWorst).toBeGreaterThan(150)
    expect(worst).toBeLessThan(neutralWorst * 0.6)
  })
})

describe('spiral entry', () => {
  const orbitIntent = (id: string, center: AircraftState['pos'], radius: number) => (s: AircraftState): Intent => {
    const d = horizontalDistance(s.pos, center)
    return {
      track: orbitTrack(s.pos, center, radius, 1),
      maxBank: 38 * DEG,
      bankFeedForward: d < radius * 1.4 ? orbitBank(Math.hypot(s.vel.x, s.vel.z), radius, 1) : 0,
      vertical: { kind: 'air-path', gamma: 0 },
      speed: aircraftById(id).stallSpeedMs * 1.7,
      minThrottle: 0,
      maxThrottle: 1,
    }
  }

  it('captures and holds a 1.2 km circle in still air (±25 % over the last minute)', () => {
    const center = v3(6000, 0, -3000)
    let lo = Infinity
    let hi = 0
    hold('turboprop', still, orbitIntent('turboprop', center, 1200), 240, undefined, (s) => {
      if (s.t > 180) {
        const d = horizontalDistance(s.pos, center)
        lo = Math.min(lo, d)
        hi = Math.max(hi, d)
      }
    })
    expect(lo).toBeGreaterThan(1200 * 0.75)
    expect(hi).toBeLessThan(1200 * 1.25)
  })

  it('the glider circling in the fixture updraft climbs ≥ 900 m in 3 minutes; the same circle in still air does not', () => {
    const weather = createFixtureWeather(1)
    const center = v3(30_000, 0, 0)
    const at = (s: AircraftState): AircraftState => ({ ...s, pos: v3(28_000, 3000, 0) })
    const lift = hold('experimental', weather, orbitIntent('experimental', center, 1200), 180, at)
    const calm = hold('experimental', still, orbitIntent('experimental', center, 1200), 180, at)
    expect(lift.status).toBe('flying')
    expect(lift.pos.y - 3000).toBeGreaterThan(900)
    expect(Math.abs(calm.pos.y - 3000)).toBeLessThan(300)
  })
})
