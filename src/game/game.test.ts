import { describe, expect, it } from 'vitest'
import { createFixtureGhost, createFixtureWeather, fixtureAircraft, fixtureFlightState, fixtureRoute } from '../core/fixtures'
import { v3 } from '../core/math'
import type { FlightScore, Ghost } from '../core/types'
import { createGhostPace } from './ghostDelta'
import { buildHudModel, gateBearingDeg, headingDeg, realKmPerGameMeter } from './hudModel'

const straightGhost = (speed: number): Ghost => ({
  ...createFixtureGhost(),
  samples: Array.from({ length: 101 }, (_, i) => ({ t: i, pos: v3(i * speed, 3000, 0), orientation: { x: 0, y: 0, z: 0, w: 1 } })),
})

describe('ghost pace', () => {
  const pace = createGhostPace(straightGhost(100), fixtureRoute)
  it('is 0 when level with the ghost', () => {
    expect(pace.deltaS(50, v3(5000, 3000, 0))).toBeCloseTo(0)
  })
  it('is positive when the player got further in the same time', () => {
    expect(pace.deltaS(50, v3(6000, 3000, 900))).toBeCloseTo(10)
  })
  it('is negative when behind', () => {
    expect(pace.deltaS(50, v3(4000, 3000, 0))).toBeCloseTo(-10)
  })
  it('lateral offset does not count as progress', () => {
    expect(pace.deltaS(50, v3(5000, 9000, 20_000))).toBeCloseTo(0)
  })
})

describe('hud model', () => {
  const state = fixtureFlightState(10)
  const score = { comfort: 90 } as FlightScore
  const weather = createFixtureWeather().sample(state.pos, state.t)
  const hud = buildHudModel({ dailyNumber: 7, route: fixtureRoute, spec: fixtureAircraft, state, weather, score, ghostDeltaS: null })

  it('heading east is 90°', () => {
    expect(headingDeg({ ...state, vel: v3(100, 0, 0) })).toBeCloseTo(90)
    expect(headingDeg({ ...state, vel: v3(0, 0, -100) })).toBeCloseTo(0)
  })
  it('gate straight ahead has ~0 bearing, gate to the south is to the right when heading east', () => {
    const east = { ...state, pos: v3(0, 3000, 0), orientation: { x: 0, y: 0, z: 0, w: 1 } }
    expect(gateBearingDeg(east, fixtureRoute)).toBeCloseTo(0)
    expect(gateBearingDeg(east, { ...fixtureRoute, gate: v3(0, 3000, 5000) })).toBeCloseTo(90)
  })
  it('scales distance to real-world km', () => {
    expect(realKmPerGameMeter(fixtureRoute) * 100_000).toBeCloseTo(fixtureRoute.realDistanceKm)
    expect(hud.gateDistanceKm).toBeGreaterThan(0)
    expect(hud.gateDistanceKm).toBeLessThan(fixtureRoute.realDistanceKm)
  })
  it('converts units', () => {
    expect(hud.altitudeFt).toBeCloseTo(state.pos.y * 3.28084)
    expect(hud.displayTimeS).toBeCloseTo(10 * fixtureRoute.timeScale)
  })
})
