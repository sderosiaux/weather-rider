import { describe, expect, it } from 'vitest'
import { SIM_DT } from '../core/constants'
import { createFixtureWeather, fixtureRoute } from '../core/fixtures'
import { v3 } from '../core/math'
import type { DailyWeather } from '../core/types'
import { AIRCRAFT, aircraftById } from '../flight'
import { createFlightSession } from '../game/session'
import { createAutopilot, runFlight, STRATEGIES } from '.'

const weather = createFixtureWeather(1)

describe('autopilots on the fixture sky', () => {
  it.each(AIRCRAFT.flatMap((a) => STRATEGIES.map((s) => [a.id, s] as const)))('%s / %s arrives in the gate window', (id, strategy) => {
    const spec = aircraftById(id)
    const r = runFlight(spec, fixtureRoute, weather, createAutopilot(strategy, spec, fixtureRoute, weather))
    expect(r.outcome).toBe('arrived')
    expect(r.score.stress).toBeLessThan(50)
  })

  it('is deterministic: same inputs, same flight', () => {
    const spec = aircraftById('regional')
    const a = runFlight(spec, fixtureRoute, weather, createAutopilot('surfer', spec, fixtureRoute, weather))
    const b = runFlight(spec, fixtureRoute, weather, createAutopilot('surfer', spec, fixtureRoute, weather))
    expect(a.score).toEqual(b.score)
    expect(a.ghost.samples.length).toBe(b.ghost.samples.length)
  })

  it('eco burns less fuel than direct; reckless is faster than direct', () => {
    const spec = aircraftById('narrowbody')
    const fly = (s: (typeof STRATEGIES)[number]) => runFlight(spec, fixtureRoute, weather, createAutopilot(s, spec, fixtureRoute, weather)).score
    const direct = fly('direct')
    expect(fly('eco').fuelUsedKg).toBeLessThan(direct.fuelUsedKg * 0.9)
    expect(fly('reckless').simTimeS).toBeLessThan(direct.simTimeS * 0.97)
  })

  it('eco with time to spare circles the fixture updraft with the glider and banks the altitude', () => {
    const spec = aircraftById('experimental')
    const events: string[] = []
    const r = runFlight(spec, fixtureRoute, weather, createAutopilot('eco', spec, fixtureRoute, weather, { profile: { timeBudget: 1.4 }, trace: (_t, e) => events.push(e) }))
    expect(r.outcome).toBe('arrived')
    expect(events.some((e) => e.startsWith('orbit up-1'))).toBe(true)
    expect(r.maxAltitude).toBeGreaterThan(fixtureRoute.start.y + 1000)
  })

  it('surfer steps around turbulence that direct flies through', () => {
    // A violent, calm-free cylinder on the straight line: turbulence 1 inside 3 km of (50 km, 0).
    const base = createFixtureWeather(1)
    const storm = {
      ...base,
      sample: (p: { x: number; y: number; z: number }, t: number, out?: Parameters<typeof base.sample>[2]) => {
        const s = base.sample(p, t, out)
        if (Math.hypot(p.x - 50_000, p.z) < 3000) s.turbulence = 1
        return s
      },
    }
    const spec = aircraftById('widebody')
    const direct = runFlight(spec, fixtureRoute, storm, createAutopilot('direct', spec, fixtureRoute, storm)).score
    const surfer = runFlight(spec, fixtureRoute, storm, createAutopilot('surfer', spec, fixtureRoute, storm)).score
    expect(direct.severeTurbulenceS).toBeGreaterThan(15)
    expect(surfer.severeTurbulenceS).toBeLessThan(direct.severeTurbulenceS / 4)
  })
})

describe('headless runner', () => {
  it('reproduces game/session.ts stepping exactly', () => {
    const spec = aircraftById('turboprop')
    const daily: DailyWeather = { number: 1, seed: 1, routes: [fixtureRoute, fixtureRoute, fixtureRoute], boundsMin: v3(0, 0, 0), boundsMax: v3(1, 1, 1) }
    const session = createFlightSession({ daily, route: fixtureRoute, spec, weather, pilot: 'bot', ghosts: [] })
    const live = createAutopilot('surfer', spec, fixtureRoute, weather)
    let outcome = null
    for (let i = 0; i < 1e6 && !outcome; i++) outcome = session.advance(SIM_DT, live(session.state()))
    const headless = runFlight(spec, fixtureRoute, weather, createAutopilot('surfer', spec, fixtureRoute, weather), { maxTimeS: 1e6 })
    expect(outcome?.score).toEqual(headless.score)
  })
})
