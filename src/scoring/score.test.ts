import { describe, expect, it } from 'vitest'
import { SIM_DT } from '../core/constants'
import { createFixtureWeather, fixtureAircraft, fixtureFlightState, fixtureRoute } from '../core/fixtures'
import { v3 } from '../core/math'
import { createRng } from '../core/rng'
import type { AircraftState, Controls, Route, TelemetryFrame, WeatherSample } from '../core/types'
import { createScoreTracker, scoreReference } from './index'

const weather = createFixtureWeather(7)
const cruise: Controls = { pitch: 0, roll: 0, yaw: 0, throttle: 0.7 }

type Tweak = (t: number, state: AircraftState, sample: WeatherSample) => { state?: Partial<AircraftState>; weather?: Partial<WeatherSample>; controls?: Partial<Controls> }

/** Fixture flight at SIM_DT, optionally reshaped per frame. Stops after the first terminal status. */
function fly(tweak: Tweak = () => ({}), route: Route = fixtureRoute, maxT = 900) {
  const tracker = createScoreTracker(fixtureAircraft, route)
  for (let i = 1; i * SIM_DT <= maxT; i++) {
    const t = i * SIM_DT
    const base = fixtureFlightState(t)
    const s = weather.sample(base.pos, t)
    const sample: WeatherSample = { wind: { ...s.wind }, turbulence: s.turbulence, dominant: s.dominant, cloud: s.cloud }
    const d = tweak(t, base, sample)
    const state = { ...base, ...d.state }
    const frame: TelemetryFrame = { state, controls: { ...cruise, ...d.controls }, weather: { ...sample, ...d.weather }, dt: SIM_DT }
    tracker.push(frame)
    if (state.status !== 'flying') break
  }
  return tracker
}

describe('score tracker — fixture flight to the gate', () => {
  const score = fly().finish()

  it('arrives with time, display time and fuel accounted', () => {
    const arrivalT = fixtureRoute.gate.x / 150
    expect(score.status).toBe('arrived')
    expect(score.simTimeS).toBeCloseTo(arrivalT, 1)
    expect(score.displayTimeS).toBeCloseTo(score.simTimeS * fixtureRoute.timeScale, 6)
    expect(score.fuelUsedKg).toBeCloseTo(arrivalT * 0.25, 0)
    expect(score.fuelRemainingPct).toBeCloseTo(100 * (1 - (arrivalT * 0.25) / fixtureAircraft.fuelCapacityKg), 1)
  })

  it('reports stress as the final airframe stress in %', () => {
    expect(score.stress).toBeCloseTo(100 * fixtureFlightState(score.simTimeS).stress, 0)
  })

  it('produces non-zero boards and keeps every metric in range', () => {
    expect(score.smooth).toBeGreaterThan(0)
    expect(score.speed).toBeGreaterThan(0)
    expect(score.eco).toBeGreaterThan(0)
    for (const v of [score.comfort, score.stress, score.weatherUtilization]) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(100)
    }
  })
})

describe('comfort', () => {
  it('smooth pilot beats rough pilot on comfort, severe turbulence and the smooth board', () => {
    const smooth = fly((t) => ({ state: { cabinAccel: 0.2 * Math.sin(0.3 * t) }, weather: { turbulence: 0.1 } })).finish()
    const rng = createRng(42)
    const rough = fly((t) => ({
      state: { cabinAccel: 2.5 * (rng() - 0.5) + 1.2 * Math.sin(3 * t), stress: Math.min(1, t / 1500) },
      weather: { turbulence: t > 200 && t < 260 ? 0.85 : 0.3 },
    })).finish()

    expect(smooth.severeTurbulenceS).toBe(0)
    expect(rough.severeTurbulenceS).toBeCloseTo(60, 0)
    expect(smooth.comfort).toBeGreaterThan(85)
    expect(rough.comfort).toBeLessThan(40)
    expect(smooth.smooth).toBeGreaterThan(2 * rough.smooth)
  })

  it('passengers hate jerk more than a steady push of the same RMS', () => {
    const steady = fly(() => ({ state: { cabinAccel: 1 } }), fixtureRoute, 120).current()
    const bumpy = fly((t) => ({ state: { cabinAccel: Math.SQRT2 * Math.sin(2 * Math.PI * 2 * t) } }), fixtureRoute, 120).current()
    expect(bumpy.comfort).toBeLessThan(steady.comfort - 20)
  })

  it('still air, no cabin accel → 100', () => {
    expect(fly(() => ({ state: { cabinAccel: 0 } }), fixtureRoute, 60).current().comfort).toBe(100)
  })
})

describe('crash', () => {
  it('zeroes every board and freezes after the terminal frame', () => {
    const tracker = fly((t, s) => ({ state: { status: t >= 300 ? 'crashed' : 'flying', fuelKg: s.fuelKg } }))
    const score = tracker.finish()
    expect(score.status).toBe('crashed')
    expect(score.simTimeS).toBeCloseTo(300, 1)
    expect([score.smooth, score.speed, score.eco]).toEqual([0, 0, 0])
    expect(score.fuelUsedKg).toBeGreaterThan(0)

    tracker.push({ state: fixtureFlightState(400), controls: cruise, weather: weather.sample(v3(0, 3000, 0), 400), dt: SIM_DT })
    expect(tracker.finish()).toEqual(score)
  })
})

describe('weather utilization', () => {
  it('is high for a pilot riding updrafts and a tailwind at low throttle', () => {
    const rider = fly(() => ({ controls: { throttle: 0.1 }, weather: { wind: v3(40, 12, 0) } })).finish()
    expect(rider.weatherUtilization).toBeGreaterThan(70)
  })

  it('is ~0 for a pilot burning fuel in still air', () => {
    const burner = fly(() => ({ controls: { throttle: 0.9 }, weather: { wind: v3(0, 0, 0) } })).finish()
    expect(burner.weatherUtilization).toBeLessThan(1)
  })

  it('gust noise alone is not counted as help, and downdrafts / headwinds are paid back', () => {
    const rng = createRng(3)
    const gusty = fly(() => ({ weather: { wind: v3(0, 8 * (rng() - 0.5), 0) } })).finish()
    const punished = fly(() => ({ weather: { wind: v3(-30, -5, 0) } })).finish()
    expect(gusty.weatherUtilization).toBeLessThan(3)
    expect(punished.weatherUtilization).toBe(0)
  })
})

describe('board normalization across routes', () => {
  /**
   * The blind reference flights the boards are normalised on: straight line in still air at the full-throttle
   * airspeed (speed board) or at the best-range airspeed with its fuel flow (eco board), no cabin motion.
   */
  function referenceFlight(lengthM: number, board: 'speed' | 'eco') {
    const route: Route = { ...fixtureRoute, id: `r${lengthM}`, gate: v3(lengthM, 3000, 0) }
    const ref = scoreReference(fixtureAircraft, route)
    const timeS = board === 'speed' ? ref.speedTimeS : ref.ecoTimeS
    const burnPerS = ref.ecoFuelKg / ref.ecoTimeS
    const v = lengthM / timeS
    return fly(
      (t) => ({
        state: {
          t, pos: v3(v * t, 3000, 0), vel: v3(v, 0, 0), airspeed: v, cabinAccel: 0, stress: 0,
          fuelKg: fixtureAircraft.fuelCapacityKg - burnPerS * t,
          status: v * t >= lengthM ? 'arrived' : 'flying',
        },
        weather: { wind: v3(0, 0, 0), turbulence: 0.1 },
      }),
      route,
      3600,
    ).finish()
  }

  it('gives the same boards (~1000 = the blind reference) on an 80 km and a 160 km route', () => {
    const short = { speed: referenceFlight(80_000, 'speed'), eco: referenceFlight(80_000, 'eco') }
    const long = { speed: referenceFlight(160_000, 'speed'), eco: referenceFlight(160_000, 'eco') }
    for (const s of [short, long]) {
      expect(s.speed.status).toBe('arrived')
      expect(s.speed.speed).toBeGreaterThanOrEqual(997)
      expect(s.speed.speed).toBeLessThanOrEqual(1000)
      expect(s.eco.eco).toBeGreaterThanOrEqual(997)
      expect(s.eco.eco).toBeLessThanOrEqual(1001)
      // No cabin motion at all beats the trimmed reference, which rides the route's background air.
      expect(s.speed.smooth).toBeGreaterThan(1000)
    }
    expect(Math.abs(short.speed.speed - long.speed.speed)).toBeLessThanOrEqual(2)
    expect(short.speed.smooth).toBe(long.speed.smooth)
  })

  it('only the weather lifts a board above 1000: a tailwind speeds up the same straight line', () => {
    const route: Route = { ...fixtureRoute, id: 'tail', gate: v3(100_000, 3000, 0) }
    const ref = scoreReference(fixtureAircraft, route)
    const v = 100_000 / ref.speedTimeS + 40
    const s = fly(
      (t) => ({ state: { t, pos: v3(v * t, 3000, 0), vel: v3(v, 0, 0), cabinAccel: 0, stress: 0, status: v * t >= 100_000 ? 'arrived' : 'flying' } }),
      route,
      3600,
    ).finish()
    expect(s.speed).toBeGreaterThan(1100)
  })
})

describe('live score', () => {
  it('current() tracks the flight while boards stay 0 until arrival', () => {
    const tracker = createScoreTracker(fixtureAircraft, fixtureRoute)
    expect(tracker.current()).toMatchObject({ status: 'flying', simTimeS: 0, fuelUsedKg: 0, fuelRemainingPct: 100, comfort: 100, smooth: 0 })
    for (let i = 1; i <= 600; i++) {
      const s = fixtureFlightState(i * SIM_DT)
      tracker.push({ state: s, controls: cruise, weather: weather.sample(s.pos, s.t), dt: SIM_DT })
    }
    const live = tracker.current()
    expect(live.simTimeS).toBeCloseTo(10, 6)
    expect(live.fuelUsedKg).toBeCloseTo(2.5, 6)
    expect([live.smooth, live.speed, live.eco]).toEqual([0, 0, 0])
  })
})
