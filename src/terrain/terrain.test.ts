import { describe, expect, it } from 'vitest'
import { fixtureRoute } from '../core/fixtures'
import { v3 } from '../core/math'
import { createRng } from '../core/rng'
import type { Terrain, TerrainParams } from '../core/types'
import { createTerrain } from './index'
import { CORRIDOR_ALLOWANCE, CORRIDOR_CLEARANCE, CORRIDOR_HALF_WIDTH, GATE_CLEARANCE, GATE_RADIUS, START_CLEARANCE, START_RADIUS } from './clearance'
import { dailyParams } from './testkit'

// Real daily routes spread over a year: 3 routes a day, start 2–4 km, gate floor 1.5–2.5 km, 90–140 km long.
const CASES = Array.from({ length: 30 }, (_, i) => 3 + i * 12).flatMap((day) => dailyParams(day, 1))
/** Metres a drawn river path may climb between two points (see the river test). */
const RIVER_WOBBLE = 10
const BUILT = new Map<TerrainParams, Terrain>()
const build = (p: TerrainParams): Terrain => {
  let t = BUILT.get(p)
  if (!t) {
    t = createTerrain(p)
    BUILT.set(p, t)
  }
  return t
}

/** Highest ground over a disc, sampled every `step` metres. */
function discMax(t: Terrain, cx: number, cz: number, radius: number, step: number): number {
  let m = -Infinity
  for (let r = 0; r <= radius; r += step) {
    const n = Math.max(1, Math.ceil((2 * Math.PI * r) / step))
    for (let k = 0; k < n; k++) m = Math.max(m, t.heightAt(cx + r * Math.cos((2 * Math.PI * k) / n), cz + r * Math.sin((2 * Math.PI * k) / n)))
  }
  return m
}

/** Highest ground within ±halfWidth of the straight start → gate segment. */
function corridorMax(t: Terrain, p: TerrainParams, halfWidth: number, step: number): number {
  const len = Math.hypot(p.gate.x - p.start.x, p.gate.z - p.start.z)
  const dx = (p.gate.x - p.start.x) / len
  const dz = (p.gate.z - p.start.z) / len
  let m = -Infinity
  for (let a = 0; a <= len; a += step) {
    for (let n = -halfWidth; n <= halfWidth; n += step) m = Math.max(m, t.heightAt(p.start.x + dx * a - dz * n, p.start.z + dz * a + dx * n))
  }
  return m
}

function segDist(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax
  const dz = bz - az
  const l2 = dx * dx + dz * dz
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0
  return Math.hypot(x - ax - dx * t, z - az - dz * t)
}

describe('createTerrain — playability over real daily routes', () => {
  it('keeps the ground well below the start, the gate window and the straight line between them', { timeout: 120_000 }, () => {
    for (const { day, route, params: p } of CASES) {
      const t = build(p)
      const where = `day ${day} ${route.id}`
      expect(discMax(t, p.start.x, p.start.z, START_RADIUS, 250), `${where} start`).toBeLessThanOrEqual(p.startAlt - START_CLEARANCE)
      expect(discMax(t, p.gate.x, p.gate.z, GATE_RADIUS, 150), `${where} gate`).toBeLessThanOrEqual(p.gateMinAlt - GATE_CLEARANCE)
      const lineCap = Math.min(p.startAlt, p.gateMinAlt + CORRIDOR_ALLOWANCE) - CORRIDOR_CLEARANCE
      expect(corridorMax(t, p, CORRIDOR_HALF_WIDTH, 200), `${where} corridor`).toBeLessThanOrEqual(lineCap)
    }
  })

  it('has finite heights everywhere, maxHeight ≤ 2,800 m and no sampled ground above maxHeight', { timeout: 120_000 }, () => {
    for (const { params: p } of CASES) {
      const t = build(p)
      expect(t.maxHeight).toBeLessThanOrEqual(2800)
      expect(Number.isFinite(t.maxHeight)).toBe(true)
      for (let x = p.boundsMin.x; x <= p.boundsMax.x; x += 700) {
        for (let z = p.boundsMin.z; z <= p.boundsMax.z; z += 700) {
          const h = t.heightAt(x, z)
          expect(Number.isFinite(h)).toBe(true)
          expect(h).toBeLessThanOrEqual(t.maxHeight)
        }
      }
      // Far beyond the playable area (and absurdly far): still defined, open sea at the end of the world.
      for (const [x, z] of [[-140_000, 0], [p.boundsMax.x + 140_000, 40_000], [5e6, -5e6], [-1e9, 1e9]] as const) {
        expect(Number.isFinite(t.heightAt(x, z))).toBe(true)
      }
      expect(t.heightAt(1e7, 1e7)).toBeLessThanOrEqual(0)
      expect(t.coverAt(1e7, 1e7)).toBe('sea')
    }
  })
})

describe('createTerrain — any params', () => {
  it('builds land for the fixture route (no daily layout) and a degenerate one', () => {
    const p: TerrainParams = {
      seed: 1,
      boundsMin: v3(-10_000, 0, -30_000),
      boundsMax: v3(110_000, 14_000, 30_000),
      start: fixtureRoute.start,
      gate: fixtureRoute.gate,
      departureName: fixtureRoute.from,
      arrivalName: fixtureRoute.to,
      startAlt: fixtureRoute.start.y,
      gateMinAlt: fixtureRoute.gateMinAlt,
    }
    const t = createTerrain(p)
    expect(discMax(t, p.start.x, p.start.z, START_RADIUS, 400)).toBeLessThanOrEqual(p.startAlt - START_CLEARANCE)
    expect(t.cities.map((c) => c.role)).toContain('arrival')
    const same = createTerrain({ ...p, gate: p.start })
    expect(Number.isFinite(same.heightAt(0, 0))).toBe(true)
    expect(same.maxHeight).toBeLessThanOrEqual(2800)
  })
})

describe('createTerrain — determinism', () => {
  it('same params → identical land; different seeds → different journeys', () => {
    const p = CASES[4]!.params
    const a = createTerrain(p)
    const b = createTerrain(p)
    const c = createTerrain({ ...p, seed: p.seed + 1 })
    const rng = createRng(99)
    let differ = 0
    for (let i = 0; i < 3000; i++) {
      const x = p.boundsMin.x + rng() * (p.boundsMax.x - p.boundsMin.x)
      const z = p.boundsMin.z + rng() * (p.boundsMax.z - p.boundsMin.z)
      expect(b.heightAt(x, z)).toBe(a.heightAt(x, z))
      expect(b.coverAt(x, z)).toBe(a.coverAt(x, z))
      if (Math.abs(c.heightAt(x, z) - a.heightAt(x, z)) > 50) differ++
    }
    expect(JSON.stringify(b.cities)).toBe(JSON.stringify(a.cities))
    expect(JSON.stringify(b.rivers)).toBe(JSON.stringify(a.rivers))
    expect(b.maxHeight).toBe(a.maxHeight)
    expect(differ).toBeGreaterThan(1500)
  })
})

describe('createTerrain — what the passenger sees', () => {
  it('puts the departure city around the start, the arrival city under the gate, towns along the way', { timeout: 120_000 }, () => {
    for (const { route, params: p } of CASES) {
      const t = build(p)
      const dep = t.cities.filter((c) => c.role === 'departure')
      const arr = t.cities.filter((c) => c.role === 'arrival')
      expect(dep).toHaveLength(1)
      expect(arr).toHaveLength(1)
      expect(dep[0]!.name).toBe(route.from)
      expect(arr[0]!.name).toBe(route.to)
      expect(Math.hypot(dep[0]!.center.x - p.start.x, dep[0]!.center.z - p.start.z)).toBeLessThan(10_000)
      expect(Math.hypot(arr[0]!.center.x - p.gate.x, arr[0]!.center.z - p.gate.z)).toBeLessThan(10_000)
      for (const c of t.cities) {
        // Cities 2–8 km across, standing on dry land.
        expect(c.radius).toBeGreaterThanOrEqual(1000)
        expect(c.radius).toBeLessThanOrEqual(4000)
        expect(c.center.y).toBeGreaterThan(0)
        expect(c.center.y).toBeCloseTo(t.heightAt(c.center.x, c.center.z), 6)
      }
      const towns = t.cities.filter((c) => c.role === 'town' && segDist(c.center.x, c.center.z, p.start.x, p.start.z, p.gate.x, p.gate.z) < 20_000)
      expect(towns.length).toBeGreaterThanOrEqual(2)
      expect(new Set(t.cities.map((c) => c.name)).size).toBe(t.cities.length)
    }
  })

  it('has rivers 100–500 m wide that flow downhill and end in the sea, a lake or another river', { timeout: 120_000 }, () => {
    for (const { day, route, params: p } of CASES) {
      const t = build(p)
      expect(t.rivers.length).toBeGreaterThan(20)
      // Every river ends somewhere: sea, lake, or the path of another river (a tributary, or its own next piece).
      const segs: { r: number; ax: number; az: number; bx: number; bz: number }[] = []
      t.rivers.forEach((r, k) => r.path.forEach((q, i) => i > 0 && segs.push({ r: k, ax: r.path[i - 1]!.x, az: r.path[i - 1]!.z, bx: q.x, bz: q.z })))
      t.rivers.forEach((r, k) => {
        const where = `day ${day} ${route.id} ${r.id}`
        expect(r.width, where).toBeGreaterThanOrEqual(90)
        expect(r.width, where).toBeLessThanOrEqual(510)
        expect(r.path.length, where).toBeGreaterThanOrEqual(2)
        // The designed water surface never rises; the ground under the drawn path may wobble a few metres where
        // valley and channel polylines (simplified separately) or a junction meet.
        for (let i = 1; i < r.path.length; i++) expect(r.path[i]!.y, where).toBeLessThanOrEqual(r.path[i - 1]!.y + RIVER_WOBBLE)
        expect(r.path[r.path.length - 1]!.y, where).toBeLessThanOrEqual(r.path[0]!.y + RIVER_WOBBLE)
        const end = r.path[r.path.length - 1]!
        const cover = t.coverAt(end.x, end.z)
        const ends = end.y <= 0 || cover === 'sea' || cover === 'lake' || segs.some((s) => s.r !== k && segDist(end.x, end.z, s.ax, s.az, s.bx, s.bz) < 30)
        expect(ends, `${where} ends at ${cover} (${end.x.toFixed(0)}, ${end.z.toFixed(0)})`).toBe(true)
      })
    }
  })

  it('crosses varied, mostly dry land: rivers and, on most routes, real relief under the line', { timeout: 120_000 }, () => {
    let relief = 0
    let seaShare = 0
    const covers = new Set<string>()
    for (const { params: p } of CASES) {
      const t = build(p)
      const len = Math.hypot(p.gate.x - p.start.x, p.gate.z - p.start.z)
      const dx = (p.gate.x - p.start.x) / len
      const dz = (p.gate.z - p.start.z) / len
      let maxOnLine = -Infinity
      let riverCrossings = 0
      let prevRiver = false
      for (let a = 0; a <= len; a += 50) {
        const x = p.start.x + dx * a
        const z = p.start.z + dz * a
        maxOnLine = Math.max(maxOnLine, t.heightAt(x, z))
        const river = t.coverAt(x, z) === 'river'
        if (river && !prevRiver) riverCrossings++
        prevRiver = river
      }
      if (maxOnLine > 900) relief++
      expect(riverCrossings).toBeGreaterThanOrEqual(1)
      let sea = 0
      let n = 0
      for (let x = p.boundsMin.x; x <= p.boundsMax.x; x += 1000) {
        for (let z = p.boundsMin.z; z <= p.boundsMax.z; z += 1000) {
          const c = t.coverAt(x, z)
          covers.add(c)
          if (c === 'sea') sea++
          n++
        }
      }
      seaShare += sea / n / CASES.length
    }
    expect(relief / CASES.length).toBeGreaterThan(0.6)
    expect(seaShare).toBeLessThan(0.2)
    for (const c of ['sea', 'beach', 'grass', 'fields', 'forest', 'rock', 'snow', 'lake', 'river', 'city']) expect(covers.has(c), c).toBe(true)
  })

  it('cover agrees with height and features', { timeout: 120_000 }, () => {
    for (const { params: p } of CASES.slice(0, 12)) {
      const t = build(p)
      const segs = t.rivers.flatMap((r) => r.path.slice(1).map((q, i) => ({ w: r.width, ax: r.path[i]!.x, az: r.path[i]!.z, bx: q.x, bz: q.z })))
      for (let x = p.boundsMin.x; x <= p.boundsMax.x; x += 333) {
        for (let z = p.boundsMin.z; z <= p.boundsMax.z; z += 333) {
          const h = t.heightAt(x, z)
          const c = t.coverAt(x, z)
          expect(c === 'sea', `(${x}, ${z}) h=${h} ${c}`).toBe(h <= 0)
          if (c === 'snow') expect(h).toBeGreaterThan(1950)
          if (c === 'rock') expect(h).toBeGreaterThan(1250)
          if (c === 'beach') expect(h).toBeLessThan(8)
          if (c === 'city') expect(t.cities.some((k) => Math.hypot(k.center.x - x, k.center.z - z) < k.radius * 1.25)).toBe(true)
          if (c === 'river') expect(segs.some((s) => segDist(x, z, s.ax, s.az, s.bx, s.bz) < s.w * 0.65 + 40), `river at (${x}, ${z})`).toBe(true)
          if (c === 'lake') {
            // Lake water is flat.
            expect(h).toBeGreaterThan(0)
          }
        }
      }
    }
  })
})
