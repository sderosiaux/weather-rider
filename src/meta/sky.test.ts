import { describe, expect, it } from 'vitest'
import type { SkyParams } from '../core/types'
import { dailyWeather, dailyWeatherFor, weatherParamsFor } from './daily'
import { skyContrast } from './sky'

const skyOf = (n: number): SkyParams => dailyWeatherFor(n).sky
const days = (from: number, count: number): number[] => Array.from({ length: count }, (_, i) => from + i)
const share = (skies: readonly SkyParams[], pick: (s: SkyParams) => boolean): number => skies.filter(pick).length / skies.length

describe('daily sky', () => {
  it('is a pure function of the day, whichever way the day is reached', () => {
    const today = dailyWeather(new Date('2026-09-30T12:00:00Z'))
    expect(today.number).toBe(273)
    expect(today.sky).toEqual(skyOf(273))
    expect(dailyWeather(new Date('2026-10-01T08:59:59+09:00')).sky).toEqual(today.sky)
    expect(skyOf(273)).toEqual(skyOf(273))
  })

  it('pins WORLD WEATHER #273 so every machine agrees', () => {
    expect(skyOf(273)).toMatchInlineSnapshot(`
      {
        "haze": 0.24,
        "sunAzimuthDeg": 76.8,
        "sunElevationDeg": 14.9,
        "warmth": 0.67,
      }
    `)
  })

  it('stays daylight and in range, before the epoch and years after it', () => {
    for (const n of days(-60, 4000)) {
      const s = skyOf(n)
      expect(s.sunElevationDeg).toBeGreaterThanOrEqual(6)
      expect(s.sunElevationDeg).toBeLessThanOrEqual(40)
      expect(s.sunAzimuthDeg).toBeGreaterThanOrEqual(0)
      expect(s.sunAzimuthDeg).toBeLessThan(360)
      expect(s.haze).toBeGreaterThanOrEqual(0.15)
      expect(s.haze).toBeLessThanOrEqual(0.7)
      expect(s.warmth).toBeGreaterThanOrEqual(0)
      expect(s.warmth).toBeLessThanOrEqual(1)
    }
  })

  describe('over a year (#1 – #365)', () => {
    const year = days(1, 365).map(skyOf)

    it('sits low: about half the days golden hour, at most a fifth of them high', () => {
      const golden = share(year, (s) => s.sunElevationDeg <= 14)
      const high = share(year, (s) => s.sunElevationDeg >= 30)
      expect(golden).toBeGreaterThanOrEqual(0.4)
      expect(golden).toBeLessThanOrEqual(0.6)
      expect(high).toBeGreaterThan(0.05)
      expect(high).toBeLessThanOrEqual(0.2)
    })

    it('puts the sun ahead of or beside the eastbound track most days, behind some days', () => {
      expect(share(year, (s) => s.sunAzimuthDeg >= 30 && s.sunAzimuthDeg <= 150)).toBeGreaterThanOrEqual(0.7)
      const behind = share(year, (s) => s.sunAzimuthDeg > 210 && s.sunAzimuthDeg < 330)
      expect(behind).toBeGreaterThan(0.03)
      expect(behind).toBeLessThan(0.2)
    })

    it('spreads the haze over its whole range', () => {
      expect(Math.min(...year.map((s) => s.haze))).toBeLessThan(0.2)
      expect(Math.max(...year.map((s) => s.haze))).toBeGreaterThan(0.65)
      expect(share(year, (s) => s.haze < 0.425)).toBeGreaterThan(0.35)
      expect(share(year, (s) => s.haze >= 0.425)).toBeGreaterThan(0.35)
    })

    it('warms with a low sun: golden hours are warm, high suns neutral', () => {
      for (const s of year) {
        if (s.sunElevationDeg <= 14) expect(s.warmth).toBeGreaterThanOrEqual(0.6)
        if (s.sunElevationDeg >= 30) expect(s.warmth).toBeLessThanOrEqual(0.1)
      }
      const e = year.map((s) => s.sunElevationDeg)
      const w = year.map((s) => s.warmth)
      const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length
      const [me, mw] = [mean(e), mean(w)]
      const cov = mean(e.map((x, i) => (x - me) * (w[i]! - mw)))
      const sd = (xs: number[], m: number): number => Math.sqrt(mean(xs.map((x) => (x - m) ** 2)))
      expect(cov / (sd(e, me) * sd(w, mw))).toBeLessThan(-0.9)
    })
  })

  it('never looks like yesterday', () => {
    for (const n of days(-60, 4000)) expect(skyContrast(skyOf(n), skyOf(n + 1))).toBeGreaterThanOrEqual(1)
  })

  it('contrast is zero for the same sky and counts the sun, the warmth and the haze', () => {
    const s: SkyParams = { sunElevationDeg: 10, sunAzimuthDeg: 90, haze: 0.3, warmth: 0.9 }
    expect(skyContrast(s, s)).toBe(0)
    expect(skyContrast(s, { ...s, sunAzimuthDeg: 125 })).toBeGreaterThan(1)
    expect(skyContrast(s, { ...s, sunAzimuthDeg: 110 })).toBeLessThan(1)
    expect(skyContrast(s, { ...s, warmth: 0.5 })).toBeGreaterThan(1)
    expect(skyContrast(s, { ...s, haze: 0.65 })).toBeGreaterThan(1)
    // Azimuth wraps: 350° and 10° are 20° apart, not 340°.
    expect(skyContrast({ ...s, sunAzimuthDeg: 350 }, { ...s, sunAzimuthDeg: 10 })).toBeLessThan(1)
    expect(skyContrast(s, { ...s, haze: 0.5 })).toBeCloseTo(skyContrast({ ...s, haze: 0.5 }, s), 12)
  })

  it('never feeds the weather: balance only sees the seed and the routes', () => {
    const d = dailyWeatherFor(273)
    const otherSky: SkyParams = { sunElevationDeg: 40, sunAzimuthDeg: 270, haze: 0.7, warmth: 0 }
    for (const r of d.routes) expect(weatherParamsFor({ ...d, sky: otherSky }, r)).toEqual(weatherParamsFor(d, r))
  })
})
