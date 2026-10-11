import { describe, expect, it } from 'vitest'
import { SIM_DT } from '../core/constants'
import { createFixtureTerrain, createFixtureWeather, createFlatTerrain, fixtureRoute } from '../core/fixtures'
import { qFromAxisAngle, v3 } from '../core/math'
import { createRng } from '../core/rng'
import type { AircraftState, Controls, FlightEnv, MutableWeatherSample, Route, Terrain, Vec3, WeatherField, WeatherSample } from '../core/types'
import { aeroOf, equilibriumAirspeed, trimLevel } from './aero'
import { AIRCRAFT, aircraftById } from './aircraft'
import { bankAngle, flightModel, headingOf } from './model'
import { NEUTRAL, fly, speedPilot, uniformWeather, type Pilot } from './testkit'

const still = uniformWeather()
const flat = createFlatTerrain()
const env = (weather: WeatherField = still, route: Route = fixtureRoute, terrain: Terrain = flat): FlightEnv => ({ weather, route, terrain })
const stillEnv = env()
const turboprop = aircraftById('turboprop')

const at = (s: AircraftState, pos: Vec3): AircraftState => ({ ...s, pos })

/** Weather with an arbitrary wind function and no turbulence. */
function windField(wind: (p: Vec3) => Vec3): WeatherField {
  const sample = (p: Vec3, _t: number, out?: MutableWeatherSample): WeatherSample => {
    const o: MutableWeatherSample = out ?? { wind: { x: 0, y: 0, z: 0 }, turbulence: 0, dominant: null, cloud: 0 }
    const w = wind(p)
    o.wind.x = w.x
    o.wind.y = w.y
    o.wind.z = w.z
    o.turbulence = 0
    o.dominant = null
    o.cloud = 0
    return o
  }
  return { seed: 3, boundsMin: v3(-1e6, 0, -1e6), boundsMax: v3(1e6, 14_000, 1e6), sample, features: [] }
}

describe('trim & still air', () => {
  it.each(AIRCRAFT.map((a) => [a.id, a] as const))('%s holds altitude ±50 m for 60 s when trimmed', (_id, spec) => {
    const s0 = flightModel.initialState(spec, stillEnv)
    expect(s0.throttle).toBeGreaterThan(0)
    expect(s0.throttle).toBeLessThan(1)
    let dev = 0
    const end = fly(spec, s0, () => NEUTRAL(s0.throttle), stillEnv, 60, (s) => {
      dev = Math.max(dev, Math.abs(s.pos.y - fixtureRoute.start.y))
    })
    expect(end.status).toBe('flying')
    expect(dev).toBeLessThan(50)
    expect(Math.abs(end.airspeed - spec.cruiseSpeedMs)).toBeLessThan(3)
  })

  it.each(AIRCRAFT.map((a) => [a.id, a] as const))('%s starts trimmed in the fixture tailwind: ±50 m over 20 s', (_id, spec) => {
    const weather = createFixtureWeather(1)
    const s0 = flightModel.initialState(spec, env(weather))
    expect(s0.vel.x).toBeCloseTo(spec.cruiseSpeedMs + 8, 6)
    let dev = 0
    const end = fly(spec, s0, () => NEUTRAL(s0.throttle), env(weather), 20, (s) => {
      dev = Math.max(dev, Math.abs(s.pos.y - fixtureRoute.start.y))
    })
    expect(end.status).toBe('flying')
    expect(dev).toBeLessThan(50)
    expect(Math.abs(end.airspeed - spec.cruiseSpeedMs)).toBeLessThan(3)
  })

  it('initial state points along startHeading', () => {
    const route: Route = { ...fixtureRoute, startHeading: v3(0, 0, -1) }
    const s0 = flightModel.initialState(turboprop, env(still, route))
    expect(headingOf(s0.orientation)).toBeCloseTo(Math.PI / 2, 5)
    expect(s0.vel.z).toBeCloseTo(-turboprop.cruiseSpeedMs, 5)
  })
})

describe('weather is terrain', () => {
  it('fixture updraft lifts a slow-crossing turboprop ≥ 500 m with throttle 0.3', () => {
    // Crossing slowly like a glider pilot does: altitude gained ≈ ∫w dt, so time in the lift matters.
    const start = at(flightModel.initialState(turboprop, stillEnv), v3(20_000, 3000, 0))
    const pilot = speedPilot(78, 0.3)
    const through = fly(turboprop, start, pilot, env(createFixtureWeather(1)), 200)
    const around = fly(turboprop, start, pilot, env(uniformWeather(v3(8, 0, 0), 0.05, 1)), 200)
    expect(through.status).toBe('flying')
    expect(through.pos.y - around.pos.y).toBeGreaterThanOrEqual(500)
  })

  it('fixture updraft lifts the experimental ≥ 500 m on neutral stick, throttle 0.3', () => {
    const exp = aircraftById('experimental')
    const start = at(flightModel.initialState(exp, stillEnv), v3(20_000, 3000, 0))
    const through = fly(exp, start, () => NEUTRAL(0.3), env(createFixtureWeather(1)), 200)
    const around = fly(exp, start, () => NEUTRAL(0.3), env(uniformWeather(v3(8, 0, 0), 0.05, 1)), 200)
    expect(through.pos.y - around.pos.y).toBeGreaterThanOrEqual(500)
  })

  it('rising air climbs and sinking air descends without touching throttle', () => {
    const s0 = flightModel.initialState(turboprop, stillEnv)
    const pilot = () => NEUTRAL(s0.throttle)
    const up = fly(turboprop, s0, pilot, env(uniformWeather(v3(0, 10, 0))), 60)
    const down = fly(turboprop, s0, pilot, env(uniformWeather(v3(0, -10, 0))), 60)
    expect(up.pos.y - s0.pos.y).toBeGreaterThan(400)
    expect(s0.pos.y - down.pos.y).toBeGreaterThan(400)
  })

  it('tailwind raises ground speed, not airspeed', () => {
    const s0 = flightModel.initialState(turboprop, stillEnv)
    const pilot = () => NEUTRAL(s0.throttle)
    const calm = fly(turboprop, s0, pilot, stillEnv, 60)
    const windy = uniformWeather(v3(30, 0, 0))
    const s0w = flightModel.initialState(turboprop, env(windy))
    expect(s0w.vel.x - s0.vel.x).toBeCloseTo(30, 9)
    const tail = fly(turboprop, s0w, pilot, env(windy), 60)
    expect(Math.abs(tail.airspeed - calm.airspeed)).toBeLessThan(0.5)
    expect(tail.vel.x - calm.vel.x).toBeCloseTo(30, 0)
    expect(tail.pos.x - calm.pos.x).toBeGreaterThan(1700)
  })

  it('shear changes airspeed abruptly', () => {
    const s0 = flightModel.initialState(turboprop, stillEnv)
    // Headwind jumps from 0 to 20 m/s across a 100 m gust front at x = 2000.
    const shear = windField((p) => v3(-20 * Math.min(1, Math.max(0, (p.x - 2000) / 100)), 0, 0))
    let before = 0
    let after = 0
    fly(turboprop, s0, () => NEUTRAL(s0.throttle), env(shear), 20, (s) => {
      if (s.pos.x < 2000) before = s.airspeed
      else if (after === 0 && s.pos.x > 2150) after = s.airspeed
    })
    expect(after - before).toBeGreaterThan(15)
  })
})

describe('handling', () => {
  it('turboprop turns faster than widebody', () => {
    const timeTo90 = (id: string): number => {
      const spec = aircraftById(id)
      const s0 = flightModel.initialState(spec, stillEnv)
      const bankTo45: Pilot = (s) => ({ pitch: 0, roll: Math.max(-1, Math.min(1, (Math.PI / 4 - bankAngle(s.orientation)) * 3)), yaw: 0, throttle: s0.throttle })
      let t90 = Infinity
      fly(spec, s0, bankTo45, stillEnv, 120, (s) => {
        if (t90 === Infinity && headingOf(s.orientation) < -Math.PI / 2) t90 = s.t
      })
      return t90
    }
    const tp = timeTo90('turboprop')
    const wb = timeTo90('widebody')
    expect(tp).toBeLessThan(wb * 0.75)
  })

  it('a banked turn turns right, and neutral stick keeps altitude within reason', () => {
    const s0 = flightModel.initialState(turboprop, stillEnv)
    let minY = Infinity
    const end = fly(turboprop, s0, (s) => ({ ...NEUTRAL(s0.throttle), roll: bankAngle(s.orientation) < 0.5 ? 1 : 0 }), stillEnv, 20, (s) => {
      minY = Math.min(minY, s.pos.y)
    })
    expect(headingOf(end.orientation)).toBeLessThan(-0.3) // right turn = heading toward south
    expect(end.pos.z).toBeGreaterThan(0)
    expect(s0.pos.y - minY).toBeLessThan(100)
  })

  it('turboprop cabin shakes more than widebody in the same turbulence', () => {
    const variance = (id: string): number => {
      const spec = aircraftById(id)
      const s0 = flightModel.initialState(spec, stillEnv)
      const xs: number[] = []
      fly(spec, s0, () => NEUTRAL(s0.throttle), env(uniformWeather(v3(0, 0, 0), 0.6)), 60, (s) => xs.push(s.cabinAccel))
      const m = xs.reduce((a, b) => a + b, 0) / xs.length
      return xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length
    }
    expect(variance('turboprop')).toBeGreaterThan(2 * variance('widebody'))
  })

  it('stalls below stall speed', () => {
    const s0 = flightModel.initialState(turboprop, stillEnv)
    const slow = { ...s0, vel: v3(50, 0, 0), airspeed: 50, throttle: 0 }
    let stalled = false
    const end = fly(turboprop, slow, () => ({ pitch: 1, roll: 0, yaw: 0, throttle: 0 }), stillEnv, 10, (s) => {
      stalled ||= s.stalled
    })
    expect(stalled).toBe(true)
    expect(end.pos.y).toBeLessThan(s0.pos.y - 50)
    // Trimmed cruise is nowhere near the stall.
    const cruise = fly(turboprop, s0, () => NEUTRAL(s0.throttle), stillEnv, 5)
    expect(cruise.stalled).toBe(false)
  })
})

describe('terminal states', () => {
  it('crashes at y ≤ 0 and stays crashed', () => {
    const s0 = at(flightModel.initialState(turboprop, stillEnv), v3(0, 400, 0))
    const end = fly(turboprop, s0, () => ({ pitch: -1, roll: 0, yaw: 0, throttle: 0.5 }), stillEnv, 120)
    expect(end.status).toBe('crashed')
    expect(flightModel.step(turboprop, end, NEUTRAL(1), stillEnv, SIM_DT)).toBe(end)
  })

  it('arrives inside the gate cylinder and altitude window, sticky', () => {
    const s0 = at(flightModel.initialState(turboprop, stillEnv), v3(fixtureRoute.gate.x - fixtureRoute.gateRadius - 1000, 3000, 0))
    const end = fly(turboprop, s0, () => NEUTRAL(s0.throttle), stillEnv, 60)
    expect(end.status).toBe('arrived')
    expect(flightModel.step(turboprop, end, NEUTRAL(1), stillEnv, SIM_DT)).toBe(end)
  })

  it('does not arrive when passing above the altitude window', () => {
    const s0 = at(flightModel.initialState(turboprop, stillEnv), v3(fixtureRoute.gate.x - 5000, fixtureRoute.gateMaxAlt + 500, 0))
    let arrived = false
    fly(turboprop, s0, () => NEUTRAL(s0.throttle), stillEnv, 70, (s) => (arrived ||= s.status === 'arrived'))
    expect(arrived).toBe(false)
  })

  it('instant overstress when g exceeds 1.5× the limit', () => {
    const s0 = flightModel.initialState(turboprop, stillEnv)
    // Max speed with the nose 20° above the flight path: far beyond the airframe limit.
    const yanked = { ...s0, vel: v3(turboprop.maxSpeedMs, 0, 0), orientation: qFromAxisAngle(v3(0, 0, 1), 0.35) }
    const next = flightModel.step(turboprop, yanked, NEUTRAL(0.5), stillEnv, SIM_DT)
    expect(next.gLoad).toBeGreaterThan(1.5 * turboprop.limitGPos)
    expect(next.status).toBe('overstressed')
    expect(flightModel.step(turboprop, next, NEUTRAL(0.5), stillEnv, SIM_DT)).toBe(next)
  })

  it('sustained high g accumulates stress', () => {
    const s0 = flightModel.initialState(turboprop, stillEnv)
    const end = fly(turboprop, s0, () => ({ pitch: 1, roll: 0, yaw: 0, throttle: 1 }), stillEnv, 4)
    expect(end.stress).toBeGreaterThan(0)
  })

  it('diving past max speed loads the airframe', () => {
    const s0 = flightModel.initialState(turboprop, stillEnv)
    // Trimmed for 1 g at that speed, so only the overspeed can load the structure.
    const v = turboprop.maxSpeedMs * 1.5
    const dive = { ...s0, vel: v3(v, 0, 0), orientation: qFromAxisAngle(v3(0, 0, 1), trimLevel(turboprop, 3000, v).alpha) }
    let maxG = 0
    const end = fly(turboprop, dive, () => NEUTRAL(1), stillEnv, 2, (s) => (maxG = Math.max(maxG, s.gLoad)))
    expect(maxG).toBeLessThan(0.7 * turboprop.limitGPos)
    expect(end.stress).toBeGreaterThan(0.05)
    expect(fly(turboprop, s0, () => NEUTRAL(s0.throttle), stillEnv, 2).stress).toBe(0)
  })

  it('severe turbulence slowly fatigues the airframe to failure', () => {
    const s0 = flightModel.initialState(turboprop, stillEnv)
    const severe = uniformWeather(v3(0, 0, 0), 1)
    let at60 = 0
    const end = fly(turboprop, s0, () => NEUTRAL(s0.throttle), env(severe), 900, (s) => {
      if (Math.abs(s.t - 60) < SIM_DT / 2) at60 = s.stress
    })
    expect(at60).toBeGreaterThan(0)
    expect(at60).toBeLessThan(0.6)
    expect(end.status).toBe('overstressed')
  })
})

describe('ground', () => {
  const terrain = createFixtureTerrain()
  const fixtureCrest = terrain.heightAt(60_000, 0)
  const hilly = (start: Vec3, startHeading = v3(1, 0, 0), weather: WeatherField = still): FlightEnv =>
    env(weather, { ...fixtureRoute, start, startHeading }, terrain)

  /** Flies until terminal, returning the last state and the one before it. */
  const flyToEnd = (e: FlightEnv, pilot: Pilot, seconds: number): { prev: AircraftState; end: AircraftState } => {
    let prev = flightModel.initialState(turboprop, e)
    const end = fly(turboprop, prev, pilot, e, seconds, (s) => {
      if (s.status === 'flying') prev = s
    })
    return { prev, end }
  }

  it('flying level into the ridge below its crest crashes on the slope, sticky', () => {
    const e = hilly(v3(45_000, 1800, 0))
    const s0 = flightModel.initialState(turboprop, e)
    const { prev, end } = flyToEnd(e, () => NEUTRAL(s0.throttle), 200)
    expect(fixtureCrest).toBeGreaterThan(2500)
    expect(end.status).toBe('crashed')
    expect(end.pos.x).toBeGreaterThan(55_000)
    expect(end.pos.x).toBeLessThan(60_000)
    expect(end.pos.y).toBeGreaterThan(1000)
    expect(end.pos.y).toBeLessThanOrEqual(terrain.heightAt(end.pos.x, end.pos.z))
    expect(prev.pos.y).toBeGreaterThan(terrain.heightAt(prev.pos.x, prev.pos.z))
    expect(flightModel.step(turboprop, end, NEUTRAL(1), e, SIM_DT)).toBe(end)
  })

  it('flying level above the crest clears the ridge', () => {
    const e = hilly(v3(45_000, 3500, 0))
    const s0 = flightModel.initialState(turboprop, e)
    let clearance = Infinity
    const end = fly(turboprop, s0, () => NEUTRAL(s0.throttle), e, 200, (s) => {
      clearance = Math.min(clearance, s.pos.y - terrain.heightAt(s.pos.x, s.pos.z))
    })
    expect(end.status).toBe('flying')
    expect(end.pos.x).toBeGreaterThan(70_000)
    expect(clearance).toBeGreaterThan(500)
  })

  it('descending into the sea crashes at the surface, not on the sea floor', () => {
    const e = hilly(v3(-20_000, 300, 0), v3(-1, 0, 0))
    const s0 = flightModel.initialState(turboprop, e)
    const { prev, end } = flyToEnd(e, () => ({ ...NEUTRAL(s0.throttle), pitch: -0.3 }), 120)
    expect(terrain.heightAt(end.pos.x, end.pos.z)).toBeLessThan(-300)
    expect(end.status).toBe('crashed')
    expect(prev.pos.y).toBeGreaterThan(0)
    expect(end.pos.y).toBeLessThanOrEqual(0)
    expect(flightModel.step(turboprop, end, NEUTRAL(1), e, SIM_DT)).toBe(end)
  })

  it('a lake surface above sea level is the ground too', () => {
    const lake: Terrain = { ...flat, heightAt: () => 800, coverAt: () => 'lake', maxHeight: 800 }
    const e = env(still, { ...fixtureRoute, start: v3(0, 1200, 0) }, lake)
    const s0 = flightModel.initialState(turboprop, e)
    const { prev, end } = flyToEnd(e, () => ({ ...NEUTRAL(s0.throttle), pitch: -0.3 }), 120)
    expect(end.status).toBe('crashed')
    expect(prev.pos.y).toBeGreaterThan(800)
    expect(end.pos.y).toBeLessThanOrEqual(800)
  })

  it('is deterministic over terrain in turbulent weather', () => {
    const e = hilly(v3(45_000, 1800, 0), v3(1, 0, 0), createFixtureWeather(3))
    const run = () => {
      const s0 = flightModel.initialState(turboprop, e)
      const trace: AircraftState[] = []
      fly(turboprop, s0, () => NEUTRAL(s0.throttle), e, 200, (s) => trace.push(s))
      return trace
    }
    const a = run()
    expect(a[a.length - 1]!.status).toBe('crashed')
    expect(run()).toEqual(a)
  })
})

describe('fuel', () => {
  it('burns monotonically, faster at higher throttle', () => {
    const s0 = flightModel.initialState(turboprop, stillEnv)
    let prev = s0.fuelKg
    let monotonic = true
    const rng = createRng(11)
    const hi = fly(turboprop, s0, () => ({ ...NEUTRAL(1), pitch: (rng() - 0.5) * 0.2 }), stillEnv, 60, (s) => {
      monotonic &&= s.fuelKg <= prev
      prev = s.fuelKg
    })
    const lo = fly(turboprop, s0, () => NEUTRAL(0.2), stillEnv, 60)
    expect(monotonic).toBe(true)
    expect(s0.fuelKg - hi.fuelKg).toBeGreaterThan(s0.fuelKg - lo.fuelKg)
  })

  const glideRatio = (id: string): number => {
    const spec = aircraftById(id)
    const emptyMass = spec.massKg - spec.fuelCapacityKg
    const bestGlide = equilibriumAirspeed(spec, 2500, 0, emptyMass)
    // Start already at best-glide speed so no kinetic energy is cashed in during the measurement.
    const s0: AircraftState = {
      ...flightModel.initialState(spec, stillEnv),
      fuelKg: 0,
      vel: v3(bestGlide, 0, 0),
      orientation: qFromAxisAngle(v3(0, 0, 1), trimLevel(spec, 3000, bestGlide, emptyMass).alpha),
    }
    const pilot = speedPilot(bestGlide, 1)
    let s = s0
    while (s.pos.y > 2000 && s.status === 'flying' && s.t < 900) s = flightModel.step(spec, s, pilot(s), stillEnv, SIM_DT)
    expect(s.fuelKg).toBe(0)
    expect(s.status).toBe('flying')
    return (s.pos.x - s0.pos.x) / (s0.pos.y - s.pos.y)
  }

  it.each(AIRCRAFT.map((a) => [a.id] as const))('%s glides on an empty tank near its best L/D', (id) => {
    expect(glideRatio(id)).toBeGreaterThan(0.85 * aeroOf(aircraftById(id)).maxLiftToDrag)
  })

  it('the experimental is the best glider', () => {
    const exp = glideRatio('experimental')
    for (const a of AIRCRAFT) if (a.id !== 'experimental') expect(exp).toBeGreaterThan(glideRatio(a.id))
  })
})

describe('determinism & robustness', () => {
  const randomPilot = (seed: number): Pilot => {
    const rng = createRng(seed)
    let c: Controls = NEUTRAL(0.7)
    return (s) => {
      if (Math.round(s.t / SIM_DT) % 60 === 0) {
        c = { pitch: rng() * 2 - 1, roll: rng() * 2 - 1, yaw: rng() * 2 - 1, throttle: rng() }
      }
      return c
    }
  }

  it('two runs with the same inputs are identical', () => {
    const run = () => {
      const trace: AircraftState[] = []
      fly(turboprop, flightModel.initialState(turboprop, env(createFixtureWeather(9))), randomPilot(5), env(createFixtureWeather(9)), 60, (s) => trace.push(s))
      return trace
    }
    expect(run()).toEqual(run())
  })

  it.each(AIRCRAFT.map((a) => [a.id, a] as const))('%s: no NaN over 10 min of random inputs', (_id, spec) => {
    const finite = (s: AircraftState): boolean =>
      [s.t, s.pos.x, s.pos.y, s.pos.z, s.vel.x, s.vel.y, s.vel.z, s.orientation.x, s.orientation.y, s.orientation.z, s.orientation.w,
        s.angVel.x, s.angVel.y, s.angVel.z, s.airspeed, s.throttle, s.fuelKg, s.gLoad, s.cabinAccel, s.stress].every(Number.isFinite)
    // Soft inputs keep it airborne long enough to matter; hard inputs exercise stalls, spins and dives.
    for (const [seed, gain] of [[1, 0.3], [2, 1]] as const) {
      const pilot = randomPilot(seed * 100 + spec.id.length)
      let ok = true
      fly(spec, flightModel.initialState(spec, env(createFixtureWeather(seed), { ...fixtureRoute, start: v3(0, 6000, 0) })), (s) => {
        const c = pilot(s)
        return { ...c, pitch: c.pitch * gain, roll: c.roll * gain, yaw: c.yaw * gain }
      }, env(createFixtureWeather(seed)), 600, (s) => (ok &&= finite(s)))
      expect(ok).toBe(true)
    }
  })
})
