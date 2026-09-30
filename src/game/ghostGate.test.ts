import { describe, expect, it } from 'vitest'
import { createFixtureGhost, fixtureRoute } from '../core/fixtures'
import { v3 } from '../core/math'
import type { DailyWeather } from '../core/types'
import { admitGhost, SHARE_WINDOW_DAYS, type GhostGateDeps } from './ghostGate'

const daily = (n: number): DailyWeather => ({
  number: n,
  seed: n,
  routes: [fixtureRoute, { ...fixtureRoute, id: 'b' }, { ...fixtureRoute, id: 'c' }],
  boundsMin: v3(0, 0, 0),
  boundsMax: v3(1, 1, 1),
  sky: { sunElevationDeg: 8, sunAzimuthDeg: 70, haze: 0.4, warmth: 0.8 },
})
const deps: GhostGateDeps = { today: 100, aircraftIds: ['fixture-turboprop', 'regional'], dailyFor: daily }
const race = (patch: Partial<ReturnType<typeof createFixtureGhost>>) => ({ ghost: { ...createFixtureGhost(), dailyNumber: 100, ...patch }, code: 'c' })

describe('admitGhost', () => {
  it('admits a ghost of a recent day, known aircraft and real route, returning its day and route', () => {
    const v = admitGhost(race({}), deps)
    expect(v.ok).toBe(true)
    if (v.ok) expect([v.daily.number, v.route.id, v.race.code]).toEqual([100, fixtureRoute.id, 'c'])
  })
  it.each([
    ['no samples', { samples: [] }],
    ['a future day (would prune the local boards)', { dailyNumber: 101 }],
    ['a day outside the boards window', { dailyNumber: 100 - SHARE_WINDOW_DAYS }],
    ['a non-integer day', { dailyNumber: 1e300 }],
    ['day 0', { dailyNumber: 0 }],
    ['an unknown aircraft', { aircraftId: 'zeppelin' }],
    ['a route not flown that day', { routeId: 'nowhere' }],
  ])('rejects %s', (_label, patch) => {
    expect(admitGhost(race(patch), deps).ok).toBe(false)
  })
})
