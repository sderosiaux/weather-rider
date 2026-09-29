import { describe, expect, it } from 'vitest'
import { WORLD_CEILING_M } from '../core/constants'
import { dailyNumber, dailyWeather, dailyWeatherFor, realBlockTimeS, routeBounds, weatherParamsFor } from './daily'
import { ROUTE_CATALOG } from './routes'

describe('dailyNumber', () => {
  it('2026-01-01 UTC is #1', () => {
    expect(dailyNumber(new Date('2026-01-01T00:00:00Z'))).toBe(1)
    expect(dailyNumber(new Date('2026-01-01T23:59:59.999Z'))).toBe(1)
    expect(dailyNumber(new Date('2026-01-02T00:00:00Z'))).toBe(2)
  })
  it('2026-09-29 is #272', () => {
    expect(dailyNumber(new Date('2026-09-29T12:00:00Z'))).toBe(272)
  })
  it('follows UTC midnight, not the local one', () => {
    // Same instant written in three offsets.
    const instants = ['2026-09-29T23:30:00Z', '2026-09-30T09:30:00+10:00', '2026-09-29T13:30:00-10:00']
    expect(instants.map((s) => dailyNumber(new Date(s)))).toEqual([272, 272, 272])
    // Just after midnight in Tokyo is still the previous UTC day.
    expect(dailyNumber(new Date('2026-09-30T00:30:00+09:00'))).toBe(272)
    expect(dailyNumber(new Date('2026-09-30T00:00:00Z'))).toBe(273)
  })
})

describe('route catalog', () => {
  it('has ≥ 20 distinct pairs with plausible great-circle distances', () => {
    expect(ROUTE_CATALOG.length).toBeGreaterThanOrEqual(20)
    expect(new Set(ROUTE_CATALOG.map((r) => `${r.from}-${r.to}`)).size).toBe(ROUTE_CATALOG.length)
    const km = (from: string, to: string) => ROUTE_CATALOG.find((r) => r.from === from && r.to === to)!.realDistanceKm
    // Published great-circle distances, ±1 %.
    expect(km('JFK', 'LIS')).toBeGreaterThan(5360 * 0.99)
    expect(km('JFK', 'LIS')).toBeLessThan(5360 * 1.01)
    expect(Math.abs(km('LHR', 'JFK') - 5555) / 5555).toBeLessThan(0.01)
    expect(Math.abs(km('SYD', 'AKL') - 2158) / 2158).toBeLessThan(0.01)
  })
})

describe('dailyWeather', () => {
  const fixedDates = ['2026-01-01T00:00:00Z', '2026-09-29T00:00:00Z', '2026-09-29T23:59:59.999Z', '2027-03-14T15:09:26Z']

  it('is identical for any instant of the same UTC day and snapshot-stable across machines', () => {
    const a = dailyWeather(new Date('2026-09-29T00:00:00Z'))
    const b = dailyWeather(new Date('2026-09-30T08:59:59+09:00'))
    expect(b).toEqual(a)
    expect(a.number).toBe(272)
    expect(a.routes.map((r) => r.label)).toMatchInlineSnapshot(`
      [
        "NRT → SFO",
        "HKG → YVR",
        "MEX → MAD",
      ]
    `)
    expect(a.seed).toMatchInlineSnapshot(`1297651786`)
  })

  it('differs between consecutive days', () => {
    const a = dailyWeatherFor(272)
    const b = dailyWeatherFor(273)
    expect(b.seed).not.toBe(a.seed)
  })

  it.each(fixedDates)('lays out three valid routes on %s', (iso) => {
    const d = dailyWeather(new Date(iso))
    const [calm, moderate, extreme] = d.routes
    expect(calm.severity).toBeGreaterThanOrEqual(0.15)
    expect(calm.severity).toBeLessThanOrEqual(0.25)
    expect(moderate.severity).toBeGreaterThanOrEqual(0.45)
    expect(moderate.severity).toBeLessThanOrEqual(0.55)
    expect(extreme.severity).toBeGreaterThanOrEqual(0.8)
    expect(extreme.severity).toBeLessThanOrEqual(0.9)
    expect(new Set(d.routes.map((r) => r.id)).size).toBe(3)
    for (const r of d.routes) {
      expect(r.start.x).toBe(0)
      expect(r.start.y).toBeGreaterThanOrEqual(2000)
      expect(r.start.y).toBeLessThanOrEqual(4000)
      expect(r.gate.x).toBeGreaterThanOrEqual(80_000)
      expect(r.gate.x).toBeLessThanOrEqual(160_000)
      expect(Math.abs(r.gate.z)).toBeLessThanOrEqual(8_000)
      expect(r.gateRadius).toBe(3000)
      expect(r.gateMinAlt).toBeGreaterThanOrEqual(1500)
      expect(r.gateMaxAlt - r.gateMinAlt).toBeGreaterThanOrEqual(3000)
      expect(r.gateMaxAlt).toBeLessThanOrEqual(7000)
      expect(r.gate.y).toBeGreaterThan(r.gateMinAlt)
      expect(r.gate.y).toBeLessThan(r.gateMaxAlt)
      expect(r.startHeading.x).toBeGreaterThan(0.99)
      expect(Math.hypot(r.startHeading.x, r.startHeading.y, r.startHeading.z)).toBeCloseTo(1, 9)
      expect(r.label).toBe(`${r.from} → ${r.to}`)
      // Bounds of the day enclose every route's own bounds.
      const b = routeBounds(r)
      expect(d.boundsMin.x).toBeLessThanOrEqual(b.boundsMin.x)
      expect(d.boundsMin.z).toBeLessThanOrEqual(b.boundsMin.z)
      expect(d.boundsMax.x).toBeGreaterThanOrEqual(b.boundsMax.x)
      expect(d.boundsMax.z).toBeGreaterThanOrEqual(b.boundsMax.z)
    }
    expect(d.boundsMax.y).toBe(WORLD_CEILING_M)
  })

  it('longer real routes get longer game routes', () => {
    const all = Array.from({ length: 200 }, (_, i) => dailyWeatherFor(i + 1).routes).flat()
    const short = all.find((r) => r.from === 'SYD' && r.to === 'AKL')!
    const long = all.find((r) => r.from === 'LAX' && r.to === 'SYD')!
    expect(long.gate.x).toBeGreaterThan(short.gate.x)
  })

  it('timeScale makes a straight flight at ~222 m/s show the real block time', () => {
    for (const r of dailyWeatherFor(272).routes) {
      const simS = Math.hypot(r.gate.x - r.start.x, r.gate.z - r.start.z) / (80_000 / 360)
      expect(simS * r.timeScale).toBeCloseTo(realBlockTimeS(r.realDistanceKm), -1)
      // SPEC §10: a 6–12 minute game flight.
      expect(simS).toBeGreaterThan(5 * 60)
      expect(simS).toBeLessThan(13 * 60)
    }
  })

  it('JFK → LIS shows ≈ 6h53 at reference cruise', () => {
    const jfkLis = ROUTE_CATALOG.find((r) => r.from === 'JFK')!
    const h = realBlockTimeS(jfkLis.realDistanceKm) / 3600
    expect(h).toBeGreaterThan(6.5)
    expect(h).toBeLessThan(7.2)
  })
})

describe('weatherParamsFor', () => {
  const d = dailyWeatherFor(272)

  it('derives a distinct seed per route, stable across calls', () => {
    const seeds = d.routes.map((r) => weatherParamsFor(d, r).seed)
    expect(new Set(seeds).size).toBe(3)
    expect(weatherParamsFor(d, d.routes[0]).seed).toBe(seeds[0])
  })

  it('encloses the route with a 30 km margin, ceiling and corridor', () => {
    for (const r of d.routes) {
      const p = weatherParamsFor(d, r)
      expect(p.severity).toBe(r.severity)
      expect(p.corridor).toEqual([r.start, r.gate])
      expect(p.boundsMin.y).toBe(0)
      expect(p.boundsMax.y).toBe(WORLD_CEILING_M)
      expect(p.boundsMin.x).toBe(-30_000)
      expect(p.boundsMax.x).toBe(r.gate.x + 30_000)
      expect(p.boundsMin.z).toBe(Math.min(0, r.gate.z) - 30_000)
      expect(p.boundsMax.z).toBe(Math.max(0, r.gate.z) + 30_000)
    }
  })
})
