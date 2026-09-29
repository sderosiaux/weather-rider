import { describe, expect, it } from 'vitest'
import { v3 } from '../../core/math'
import type { WeatherFeature } from '../../core/types'
import { layoutClouds, layoutHorizon, shadeCluster, smoothShade, type Puff } from './layout'

const sun = v3(0.33, 0.14, -0.93)
const opts = { seed: 184, sun, windDir: v3(1, 0, 0) }
const storm: WeatherFeature = { kind: 'storm', id: 'cb', center: v3(50_000, 0, 0), radius: 5000, base: 1000, top: 12_000, strength: 25 }
const updraft: WeatherFeature = { kind: 'updraft', id: 'up', center: v3(10_000, 0, 5000), radius: 2000, base: 500, top: 8000, strength: 15 }
const thermal: WeatherFeature = { kind: 'thermal', id: 'th', center: v3(0, 0, 0), radius: 1000, base: 0, top: 2500, strength: 5 }
const jet: WeatherFeature = { kind: 'jetstream', id: 'jet', path: [v3(0, 10_000, 0), v3(100_000, 10_500, 0)], radius: 1500, thickness: 800, speed: 60 }

describe('layoutClouds', () => {
  it('is deterministic for a given seed and differs across seeds', () => {
    const a = layoutClouds([storm, updraft, jet], opts)
    expect(layoutClouds([storm, updraft, jet], opts)).toEqual(a)
    expect(layoutClouds([storm, updraft, jet], { ...opts, seed: 185 })).not.toEqual(a)
  })

  it('builds a cumulonimbus: tower above its base, anvil spread downwind at the top, rain below', () => {
    const puffs = layoutClouds([storm], opts)
    const billboards = puffs.filter((p) => p.ax === 0 && p.ay === 0 && p.az === 0)
    const shafts = puffs.filter((p) => p.ay === 1)
    expect(shafts.length).toBeGreaterThan(0)
    for (const p of billboards) expect(p.y).toBeGreaterThanOrEqual(1000)
    const anvil = billboards.filter((p) => p.y > 1000 + 11_000 * 0.78)
    const meanX = anvil.reduce((s, p) => s + p.x, 0) / anvil.length
    expect(meanX).toBeGreaterThan(storm.center.x) // sheared downwind (+x)
    const maxReach = Math.max(...anvil.map((p) => Math.abs(p.x - storm.center.x)))
    expect(maxReach).toBeGreaterThan(storm.radius * 1.5)
  })

  it('caps a thermal with a small cloud near the column top', () => {
    const puffs = layoutClouds([thermal], opts)
    expect(puffs.length).toBeGreaterThan(5)
    for (const p of puffs) {
      expect(p.y).toBeGreaterThan(2000)
      expect(Math.hypot(p.x, p.z)).toBeLessThan(thermal.radius * 2)
    }
  })

  it('lays jet cirrus as streaks along the path', () => {
    const puffs = layoutClouds([jet], opts)
    expect(puffs.length).toBeGreaterThan(10)
    for (const p of puffs) {
      expect(Math.abs(p.ax)).toBeGreaterThan(0.95)
      expect(p.sy).toBeGreaterThan(p.sx)
    }
  })

  it('stays within budget at game density (15 storms, 60 columns, 2 jets)', () => {
    const features: WeatherFeature[] = []
    for (let i = 0; i < 15; i++) features.push({ ...storm, id: `s${i}`, center: v3(i * 10_000, 0, 0), radius: 6500, top: 13_500 })
    for (let i = 0; i < 60; i++) features.push({ ...updraft, id: `u${i}`, kind: i % 2 ? 'updraft' : 'thermal' })
    features.push(jet, { ...jet, id: 'jet2' })
    const n = layoutClouds(features, opts).length
    expect(n).toBeLessThan(65_535) // sort keys pack the index in 16 bits
    expect(n).toBeLessThan(8000)
  })
})

describe('sun shading', () => {
  const puff = (x: number): Puff => ({ x, y: 0, z: 0, sx: 100, sy: 100, ax: 0, ay: 0, az: 0, tile: 0, rot: 0, opacity: 1, dark: 0, base: 0, top: 1, shade: 1 })
  it('darkens puffs that have cloud between them and the sun', () => {
    const [far, near] = shadeCluster([puff(0), puff(50)], v3(1, 0, 0))
    expect(near!.shade).toBe(1)
    expect(far!.shade).toBeLessThan(0.7)
  })
  it('smoothing keeps shade within the original range', () => {
    const shaded = shadeCluster([puff(0), puff(50), puff(100)], v3(1, 0, 0))
    const lo = Math.min(...shaded.map((p) => p.shade))
    for (const p of smoothShade(shaded)) {
      expect(p.shade).toBeGreaterThanOrEqual(lo - 1e-9)
      expect(p.shade).toBeLessThanOrEqual(1)
    }
  })
})

describe('layoutHorizon', () => {
  it('keeps decorative banks strictly outside the playable bounds', () => {
    const min = v3(-30_000, 0, -30_000)
    const max = v3(172_500, 14_000, 32_600)
    const puffs = layoutHorizon(min, max, opts)
    expect(puffs.length).toBeGreaterThan(100)
    for (const p of puffs.filter((q) => q.ay !== 1)) {
      const inside = p.x > min.x && p.x < max.x && p.z > min.z && p.z < max.z
      expect(inside).toBe(false)
    }
  })
})
