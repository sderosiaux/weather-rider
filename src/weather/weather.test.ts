import { describe, expect, it } from 'vitest'
import { v3 } from '../core/math'
import { createRng } from '../core/rng'
import type { MutableWeatherSample, Vec3, WeatherField, WeatherFeature, WeatherParams } from '../core/types'
import { SEVERE_TURBULENCE } from '../core/constants'
import { dailyWeatherFor, weatherParamsFor } from '../meta'
import type { Route } from '../core/types'
import { createSampler } from './field'
import { createWeather } from './index'
import { EDGE, generateLayout, jetY, jetZ, type JetSpec, type Layout } from './layout'

const params = (seed: number, severity: number, gateZ = 0): WeatherParams => ({
  seed,
  severity,
  boundsMin: v3(-10_000, 0, -30_000),
  boundsMax: v3(110_000, 14_000, 30_000),
  corridor: [v3(0, 3000, 0), v3(100_000, 3000, gateZ)],
})

const newOut = (): MutableWeatherSample => ({ wind: { x: 0, y: 0, z: 0 }, turbulence: 0, dominant: null, cloud: 0 })

const corridorZ = (p: WeatherParams, x: number) => {
  const [a, b] = p.corridor
  return a.z + ((b.z - a.z) * (x - a.x)) / (b.x - a.x)
}

/** Best updraft (m/s) reachable below 8 km within 15 km of the corridor, probing around lift features. */
function bestLift(w: WeatherField, p: WeatherParams): number {
  const out = newOut()
  let best = -Infinity
  for (const f of w.features) {
    if (f.kind !== 'updraft' && f.kind !== 'storm') continue
    if (Math.abs(f.center.z - corridorZ(p, f.center.x)) > 15_000) continue
    for (let r = 0; r <= 1.2; r += 0.1) {
      for (let a = 0; a < 16; a++) {
        const x = f.center.x + Math.cos((a / 16) * Math.PI * 2) * r * f.radius
        const z = f.center.z + Math.sin((a / 16) * Math.PI * 2) * r * f.radius
        for (let y = 1000; y <= 8000; y += 500) {
          best = Math.max(best, w.sample({ x, y, z }, 0, out).wind.y)
          if (best >= 10) return best
        }
      }
    }
  }
  return best
}

/** Share of corridor stations with ≥ 35 m/s tailwind reachable at 9–12 km within 20 km laterally. */
function tailwindCoverage(w: WeatherField, p: WeatherParams): number {
  const out = newOut()
  let ok = 0
  let n = 0
  for (let x = 5000; x <= 95_000; x += 5000) {
    n++
    const cz = corridorZ(p, x)
    search: for (let dz = -20_000; dz <= 20_000; dz += 1000) {
      for (let y = 9000; y <= 12_000; y += 500) {
        if (w.sample({ x, y, z: cz + dz }, 0, out).wind.x >= 35) {
          ok++
          break search
        }
      }
    }
  }
  return ok / n
}

describe('createWeather', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a = createWeather(params(42, 0.6))
    const b = createWeather(params(42, 0.6))
    const c = createWeather(params(43, 0.6))
    expect(JSON.stringify(a.features)).toBe(JSON.stringify(b.features))
    expect(JSON.stringify(a.features)).not.toBe(JSON.stringify(c.features))
    const rng = createRng(7)
    let differs = 0
    for (let i = 0; i < 2000; i++) {
      const pt = v3(rng() * 120_000 - 10_000, rng() * 14_000, rng() * 60_000 - 30_000)
      const t = rng() * 600
      const sa = a.sample(pt, t)
      const sb = b.sample(pt, t)
      expect(sb).toEqual(sa)
      const sc = c.sample(pt, t)
      if (Math.abs(sc.wind.x - sa.wind.x) + Math.abs(sc.wind.y - sa.wind.y) > 0.5) differs++
    }
    expect(differs).toBeGreaterThan(500)
  })

  it('always offers a skilled route: strong lift below 8 km and a jet tailwind near the corridor', () => {
    for (const severity of [0.2, 0.45, 0.7, 1]) {
      for (let seed = 1; seed <= 50; seed++) {
        const p = params(seed * 7919, severity, seed % 3 === 0 ? 12_000 : 0)
        const w = createWeather(p)
        const lift = bestLift(w, p)
        const coverage = tailwindCoverage(w, p)
        expect(lift, `seed ${seed} severity ${severity} lift`).toBeGreaterThanOrEqual(10)
        expect(coverage, `seed ${seed} severity ${severity} jet coverage`).toBeGreaterThanOrEqual(0.5)
      }
    }
  }, 30_000)

  it('is calm at severity 0', () => {
    const out = newOut()
    for (let seed = 1; seed <= 20; seed++) {
      const w = createWeather(params(seed, 0))
      const rng = createRng(seed)
      let rough = 0
      let maxUp = 0
      const n = 20_000
      for (let i = 0; i < n; i++) {
        const s = w.sample(v3(rng() * 120_000 - 10_000, rng() * 14_000, rng() * 60_000 - 30_000), rng() * 600, out)
        maxUp = Math.max(maxUp, Math.abs(s.wind.y))
        if (s.turbulence >= 0.3) rough++
      }
      // Thermal cores are the strongest vertical air on a calm day: probe them directly.
      for (const f of w.features) {
        if (f.kind !== 'thermal' && f.kind !== 'updraft' && f.kind !== 'downdraft') continue
        for (let y = 100; y < f.top; y += 200) maxUp = Math.max(maxUp, Math.abs(w.sample(v3(f.center.x, y, f.center.z), 0, out).wind.y))
      }
      expect(maxUp, `seed ${seed}`).toBeLessThan(6)
      expect(rough / n, `seed ${seed}`).toBeLessThan(0.01)
      expect(w.features.some((f) => f.kind === 'storm')).toBe(false)
    }
  })

  it('has severe storm cores at high severity', () => {
    const out = newOut()
    for (let seed = 1; seed <= 10; seed++) {
      const w = createWeather(params(seed, 1))
      const storms = w.features.filter((f) => f.kind === 'storm')
      expect(storms.length).toBeGreaterThanOrEqual(3)
      for (const f of storms) {
        const s = w.sample(v3(f.center.x, (f.base + f.top) / 2, f.center.z), 0, out)
        expect(s.turbulence).toBeGreaterThan(0.7)
        expect(s.cloud).toBeGreaterThan(0.5)
        expect(s.dominant).toBe('storm')
      }
      // Stacked features never exceed the amplified-but-flyable range.
      for (const f of w.features) {
        if (f.kind !== 'storm' && f.kind !== 'updraft' && f.kind !== 'downdraft') continue
        for (let r = 0; r <= 1.6; r += 0.2) {
          for (let a = 0; a < 12; a++) {
            for (let y = 1000; y <= 9000; y += 1000) {
              const x = f.center.x + Math.cos((a / 12) * Math.PI * 2) * r * f.radius
              const z = f.center.z + Math.sin((a / 12) * Math.PI * 2) * r * f.radius
              expect(Math.abs(w.sample(v3(x, y, z), 0, out).wind.y)).toBeLessThan(40)
            }
          }
        }
      }
    }
  }, 30_000)

  it('labels the dominant feature', () => {
    const out = newOut()
    const w = createWeather(params(5, 0.6))
    const up = w.features.find((f): f is Extract<WeatherFeature, { kind: 'updraft' | 'downdraft' | 'thermal' }> => f.kind === 'updraft')!
    expect(w.sample(v3(up.center.x, (up.base + up.top) / 2, up.center.z), 0, out).dominant).toBe('updraft')
    const jet = w.features.find((f): f is Extract<WeatherFeature, { kind: 'jetstream' }> => f.kind === 'jetstream')!
    const core = jet.path[Math.floor(jet.path.length / 2)]!
    expect(w.sample(core, 0, out).dominant).toBe('jetstream')
    expect(w.sample(v3(500_000, 5000, 0), 0, out).dominant).toBe(null)
  })

  // ~110k pairs: track the worst jumps and assert once (per-pair expect() dominated the runtime).
  it('is continuous: samples 10 m apart never jump', () => {
    const out = newOut()
    const out2 = newOut()
    const worst = { space: 0, turb: 0, time: 0, spaceAt: '', turbAt: '', timeAt: '' }
    const where = (pt: Vec3, t: number) => `${pt.x.toFixed(0)},${pt.y.toFixed(0)},${pt.z.toFixed(0)} t=${t.toFixed(2)}`
    const check = (w: WeatherField, pt: Vec3, t: number, dir: Vec3) => {
      const a = w.sample(pt, t, out)
      const b = w.sample(v3(pt.x + dir.x * 10, pt.y + dir.y * 10, pt.z + dir.z * 10), t, out2)
      const dw = Math.hypot(a.wind.x - b.wind.x, a.wind.y - b.wind.y, a.wind.z - b.wind.z)
      const dt = Math.abs(a.turbulence - b.turbulence)
      if (dw > worst.space) Object.assign(worst, { space: dw, spaceAt: where(pt, t) })
      if (dt > worst.turb) Object.assign(worst, { turb: dt, turbAt: where(pt, t) })
      const c = w.sample(pt, t + 1 / 60, out2)
      const dtime = Math.hypot(a.wind.x - c.wind.x, a.wind.y - c.wind.y, a.wind.z - c.wind.z)
      if (dtime > worst.time) Object.assign(worst, { time: dtime, timeAt: where(pt, t) })
    }
    for (let seed = 1; seed <= 3; seed++) {
      const w = createWeather(params(seed * 31, 1))
      const rng = createRng(seed)
      const randDir = () => {
        const u = rng() * 2 - 1
        const a = rng() * Math.PI * 2
        const s = Math.sqrt(1 - u * u)
        return v3(s * Math.cos(a), u, s * Math.sin(a))
      }
      for (let i = 0; i < 30_000; i++) {
        check(w, v3(rng() * 120_000 - 10_000, rng() * 14_000, rng() * 60_000 - 30_000), rng() * 600, randDir())
      }
      // Dense probes where gradients are steepest: storm flanks/cores, jet flanks, active wakes.
      for (const f of w.features) {
        if (f.kind === 'storm' || f.kind === 'updraft' || f.kind === 'downdraft') {
          for (let i = 0; i < 2000; i++) {
            const r = rng() * 2.5 * f.radius
            const a = rng() * Math.PI * 2
            check(w, v3(f.center.x + r * Math.cos(a), f.base - 1000 + rng() * (f.top - f.base + 2500), f.center.z + r * Math.sin(a)), rng() * 600, randDir())
          }
        } else if (f.kind === 'jetstream') {
          for (let i = 0; i < 3000; i++) {
            const q = f.path[Math.floor(rng() * f.path.length)]!
            check(w, v3(q.x, q.y + (rng() * 2 - 1) * 2500, q.z + (rng() * 2 - 1) * f.radius * 1.2), rng() * 600, randDir())
          }
        } else if (f.kind === 'wake') {
          const [a, b] = f.path as [Vec3, Vec3]
          let active = 0
          for (let i = 0; i < 40_000 && active < 1500; i++) {
            const s = rng()
            const lat = (rng() * 2 - 1) * 600
            const len = Math.hypot(b.x - a.x, b.z - a.z)
            const nx = -(b.z - a.z) / len
            const nz = (b.x - a.x) / len
            const pt = v3(a.x + (b.x - a.x) * s + nx * lat, a.y - rng() * 200 + 30, a.z + (b.z - a.z) * s + nz * lat)
            const t = rng() * 1200
            if (w.sample(pt, t, out).dominant !== 'wake') continue
            active++
            check(w, pt, t, randDir())
          }
          expect(active, `wake ${f.id} never active`).toBeGreaterThan(0)
        }
      }
    }
    expect(worst.space, `wind jump over 10 m at ${worst.spaceAt}`).toBeLessThan(4)
    expect(worst.turb, `turbulence jump over 10 m at ${worst.turbAt}`).toBeLessThan(0.1)
    expect(worst.time, `wind jump over 1/60 s at ${worst.timeAt}`).toBeLessThan(1.5)
  }, 30_000)
})

/** Storm-core encounters on the straight start→gate line flown at the start altitude. */
function straightLine(w: WeatherField, route: Route) {
  const { start, gate } = route
  const len = Math.hypot(gate.x - start.x, gate.z - start.z)
  const ux = (gate.x - start.x) / len
  const uz = (gate.z - start.z) / len
  let nearestCoreGap = Infinity
  for (const f of w.features) {
    if (f.kind !== 'storm') continue
    const along = Math.min(len, Math.max(0, (f.center.x - start.x) * ux + (f.center.z - start.z) * uz))
    const d = Math.hypot(f.center.x - (start.x + ux * along), f.center.z - (start.z + uz * along))
    nearestCoreGap = Math.min(nearestCoreGap, d - 0.6 * f.radius)
  }
  const out = newOut()
  let severeStorm = false
  for (let s = 0; s <= len && !severeStorm; s += 200) {
    for (let lat = -2000; lat <= 2000; lat += 1000) {
      const smp = w.sample(v3(start.x + ux * s - uz * lat, start.y, start.z + uz * s + ux * lat), 0, out)
      if (smp.dominant === 'storm' && smp.turbulence >= SEVERE_TURBULENCE) severeStorm = true
    }
  }
  return { nearestCoreGap, severeStorm }
}

describe('routing decisions on real daily routes', () => {
  it('rough days put a storm core on the straight line, calm days keep it clear', () => {
    let rough = 0
    let calm = 0
    for (let n = 1; n <= 60; n++) {
      const daily = dailyWeatherFor(n)
      for (const route of daily.routes) {
        const w = createWeather(weatherParamsFor(daily, route))
        const line = straightLine(w, route)
        if (route.severity >= 0.7) {
          rough++
          expect(line.nearestCoreGap, `#${n} ${route.id} sev ${route.severity}`).toBeLessThanOrEqual(2000)
          expect(line.severeStorm, `#${n} ${route.id} severe turbulence on the line`).toBe(true)
        } else if (route.severity <= 0.3) {
          calm++
          expect(line.nearestCoreGap, `#${n} ${route.id} sev ${route.severity}`).toBeGreaterThan(2000)
          expect(line.severeStorm, `#${n} ${route.id}`).toBe(false)
        }
      }
    }
    expect(rough).toBeGreaterThanOrEqual(50)
    expect(calm).toBeGreaterThanOrEqual(50)
  }, 30_000)

  it('draws towering storms on the extreme route', () => {
    const tops: number[] = []
    for (let n = 1; n <= 60; n++) {
      const daily = dailyWeatherFor(n)
      const w = createWeather(weatherParamsFor(daily, daily.routes[2]))
      for (const f of w.features) if (f.kind === 'storm') tops.push(f.top)
    }
    tops.sort((a, b) => a - b)
    expect(tops[Math.floor(tops.length * 0.1)]!).toBeGreaterThanOrEqual(11_000)
    expect(tops[tops.length - 1]!).toBeLessThanOrEqual(13_500)
  })
})

type Jet = Extract<WeatherFeature, { kind: 'jetstream' }>
type Shear = Extract<WeatherFeature, { kind: 'shear' }>

/** Every severity on the test bounds, real daily routes, and narrow bounds whose sides cut jets into pieces. */
function geometryCases(): WeatherParams[] {
  const cases: WeatherParams[] = []
  for (const severity of [0, 0.2, 0.45, 0.7, 0.85, 1]) {
    for (let seed = 1; seed <= 8; seed++) cases.push(params(seed * 7919, severity, seed % 3 === 0 ? 12_000 : 0))
  }
  for (let n = 1; n <= 25; n++) {
    const daily = dailyWeatherFor(n)
    for (const route of daily.routes) cases.push(weatherParamsFor(daily, route))
  }
  for (let seed = 1; seed <= 12; seed++) cases.push({ ...params(seed, 0.6), boundsMin: v3(-10_000, 0, -10_000), boundsMax: v3(110_000, 14_000, 10_000) })
  return cases
}

/** Published paths lying on jet j's core (their vertices are exact core points). */
const pathsOf = (layout: Layout, j: JetSpec): Jet[] =>
  layout.features.filter((f): f is Jet => f.kind === 'jetstream' && f.path.every((q) => Math.abs(q.y - jetY(j, q.x)) < 1e-6 && Math.abs(q.z - jetZ(j, q.x)) < 1e-6))

// Render draws jet cirrus along the published paths and the bot plans jet legs from them: they must not claim
// a jet where the air is calm, nor leave a real one out. A jet fades smoothly (bounds, and the low jet before
// the gate), so its path runs where the core blows at ≥ half its speed, and the fade finishes past the ends.
describe('published features match the sampled field', () => {
  it('jet paths run exactly where the core blows at ≥ half its speed', () => {
    const out = newOut()
    const out2 = newOut()
    let weakest = { share: Infinity, at: '' }
    const misplaced: string[] = []
    let splits = 0
    for (const p of geometryCases()) {
      const layout = generateLayout(p)
      const full = createSampler(p, layout)
      layout.jets.forEach((j, i) => {
        const without = createSampler(p, { ...layout, jets: layout.jets.filter((_, k) => k !== i) })
        const paths = pathsOf(layout, j)
        if (paths.length > 1) splits++
        // The jet's own wind on its core, as a share of its speed. No shear turbulence on the core: no gust difference.
        for (let x = p.boundsMin.x; x <= p.boundsMax.x; x += 250) {
          if (paths.some((f) => Math.abs(x - f.path[0]!.x) < 5 || Math.abs(x - f.path.at(-1)!.x) < 5)) continue
          const q = v3(x, jetY(j, x), jetZ(j, x))
          const a = full(q, 0, out).wind
          const b = without(q, 0, out2).wind
          const own = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) / j.speed
          const published = paths.some((f) => x >= f.path[0]!.x && x <= f.path.at(-1)!.x)
          if (published !== (own >= 0.5)) misplaced.push(`seed ${p.seed} jet ${i + 1} x=${x} own ${own.toFixed(3)} published ${published}`)
        }
        // What a consumer flying the published path meets: the sampled wind along the path's direction.
        for (const f of paths) {
          for (let s = 0; s + 1 < f.path.length; s++) {
            const a = f.path[s]!
            const b = f.path[s + 1]!
            const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
            const n = Math.ceil(len / 250)
            for (let k = 0; k <= n; k++) {
              const q = v3(a.x + ((b.x - a.x) * k) / n, a.y + ((b.y - a.y) * k) / n, a.z + ((b.z - a.z) * k) / n)
              for (const t of [0, 137, 411]) {
                const w = full(q, t, out).wind
                const share = (w.x * (b.x - a.x) + w.y * (b.y - a.y) + w.z * (b.z - a.z)) / len / f.speed
                if (share < weakest.share) weakest = { share, at: `seed ${p.seed} ${f.id} x=${q.x.toFixed(0)} t=${t}` }
              }
            }
          }
        }
      })
    }
    expect(misplaced.slice(0, 5)).toEqual([])
    expect(weakest.share, weakest.at).toBeGreaterThanOrEqual(0.5)
    // Narrow bounds must actually split jets, or the multi-piece case goes untested.
    expect(splits).toBeGreaterThan(0)
  }, 30_000)

  it('past the end of its fade a jet leaves nothing: no wind, shear turbulence or cirrus', () => {
    const out = newOut()
    const out2 = newOut()
    let wide = 0
    let faded = 0
    const leftovers: string[] = []
    for (const p of geometryCases()) {
      const { boundsMin: lo, boundsMax: hi } = p
      if (hi.z - lo.z >= 40_000) wide++
      const layout = generateLayout(p)
      const full = createSampler(p, layout)
      layout.jets.forEach((j, i) => {
        const without = createSampler(p, { ...layout, jets: layout.jets.filter((_, k) => k !== i) })
        for (const f of pathsOf(layout, j)) {
          for (const [end, dir] of [[f.path[0]!, -1], [f.path.at(-1)!, 1]] as const) {
            // Ends within reach of the bounds fade are the bounds' doing (the field stops at the bounds anyway).
            if (Math.min(end.x - lo.x, hi.x - end.x, end.z - lo.z, hi.z - end.z) <= EDGE) continue
            // Stopped by its own fade: ≤ 6.7 km later (half a 10 km fade, plus streaks) the jet is gone across its tube.
            faded++
            for (let x = end.x + dir * 7000; x > lo.x && x < hi.x; x += dir * 1000) {
              for (let v = -1; v <= 1; v += 0.5) {
                for (let l = -1; l <= 1; l += 0.5) {
                  const q = v3(x, jetY(j, x) + v * f.thickness, jetZ(j, x) + l * f.radius)
                  const a = full(q, 0, out)
                  const b = without(q, 0, out2)
                  const same = a.wind.x === b.wind.x && a.wind.y === b.wind.y && a.wind.z === b.wind.z && a.turbulence === b.turbulence && a.cloud === b.cloud && a.dominant === b.dominant
                  if (!same) leftovers.push(`seed ${p.seed} ${f.id} x=${x.toFixed(0)} (${((x - end.x) / 1000).toFixed(1)} km past its end)`)
                }
              }
            }
          }
        }
      })
    }
    // On wide bounds every low jet stops before its gate.
    expect(faded).toBeGreaterThanOrEqual(wide)
    expect(leftovers.slice(0, 5)).toEqual([])
  }, 30_000)

  it('shear layers span exactly where their jet shears at ≥ half strength, and cover its tube', () => {
    const out = newOut()
    const out2 = newOut()
    const misplaced: string[] = []
    const uncovered: string[] = []
    for (const p of geometryCases()) {
      const { boundsMin: lo, boundsMax: hi } = p
      const layout = generateLayout(p)
      const full = createSampler(p, layout)
      layout.jets.forEach((j, i) => {
        const without = createSampler(p, { ...layout, jets: layout.jets.filter((_, k) => k !== i) })
        const layers = (side: -1 | 1) => layout.features.filter((f): f is Shear => f.kind === 'shear' && Math.abs(f.altitude - (j.y0 + side * 0.55 * j.rv)) < 1e-6)
        const below = layers(-1)
        expect(layers(1).map((s) => [s.extentMin, s.extentMax])).toEqual(below.map((s) => [s.extentMin, s.extentMax]))
        for (const s of below) {
          const n = Math.ceil((s.extentMax.x - s.extentMin.x) / 250)
          for (let k = 0; k <= n; k++) {
            const x = s.extentMin.x + ((s.extentMax.x - s.extentMin.x) * k) / n
            const z = jetZ(j, x)
            if (z - j.rh < s.extentMin.z - 1 || z + j.rh > s.extentMax.z + 1) uncovered.push(`seed ${p.seed} ${s.id} x=${x.toFixed(0)}`)
          }
        }
        // The jet's own turbulence where the layer below its core peaks (|∂k/∂v| is maximal √0.6 rv down its axis).
        // Where the bounds fade is 1, 1 − turbulence = (1 − background) × Π(1 − each feature's), so it comes out exactly.
        for (let x = lo.x + EDGE; x <= hi.x - EDGE; x += 250) {
          const z = jetZ(j, x)
          if (z - lo.z < EDGE || hi.z - z < EDGE) continue
          if (below.some((s) => Math.abs(x - s.extentMin.x) < 5 || Math.abs(x - s.extentMax.x) < 5)) continue
          const q = v3(x, jetY(j, x) - Math.sqrt(0.6) * j.rv, z)
          const share = (1 - (1 - full(q, 0, out).turbulence) / (1 - without(q, 0, out2).turbulence)) / j.shearTurb
          const published = below.some((s) => x >= s.extentMin.x && x <= s.extentMax.x)
          if (published !== (share >= 0.5)) misplaced.push(`seed ${p.seed} jet ${i + 1} x=${x} share ${share.toFixed(3)} published ${published}`)
        }
      })
    }
    expect(uncovered.slice(0, 5)).toEqual([])
    expect(misplaced.slice(0, 5)).toEqual([])
  }, 30_000)

  it('wake tracks stop where the wake tapers below half strength', () => {
    const out = newOut()
    const out2 = newOut()
    const misplaced: string[] = []
    let tracks = 0
    for (const p of geometryCases().slice(0, 60)) {
      const base = generateLayout(p)
      // Turbulence-free wakes: the vortex wind is then the only difference a wake makes (same gusts either way).
      const layout: Layout = { ...base, wakes: base.wakes.map((wk) => ({ ...wk, turb: 0 })) }
      const full = createSampler(p, layout)
      layout.wakes.forEach((wk, i) => {
        const without = createSampler(p, { ...layout, wakes: layout.wakes.filter((_, k) => k !== i) })
        const published = layout.features
          .filter((f): f is Extract<WeatherFeature, { kind: 'wake' }> => f.kind === 'wake')
          .filter((f) => f.path.every((q) => q.y === wk.alt && Math.abs((q.z - wk.az) * wk.dx - (q.x - wk.ax) * wk.dz) < 1e-6))
          .map((f) => f.path.map((q) => (q.x - wk.ax) * wk.dx + (q.z - wk.az) * wk.dz) as [number, number])
        tracks += published.length
        const cycle = wk.length + wk.speed * wk.life
        // Cross-track wind above each vortex, 6 s after the traffic passed s. The two sides are mirror images,
        // so their difference sees the bounds fade of the track itself.
        const strength = (s: number): number => {
          const t = ((((s + wk.speed * 6 - wk.phase) % cycle) + cycle) % cycle) / wk.speed
          let v = 0
          for (const side of [-1, 1]) {
            const q = v3(wk.ax + wk.dx * s - wk.dz * side * wk.span * 0.5, wk.alt + wk.rc, wk.az + wk.dz * s + wk.dx * side * wk.span * 0.5)
            const a = full(q, t, out).wind
            const b = without(q, t, out2).wind
            v += side * (-(a.x - b.x) * wk.dz + (a.z - b.z) * wk.dx)
          }
          return Math.abs(v)
        }
        const along: [number, number][] = []
        for (let s = 0; s <= wk.length; s += 250) along.push([s, strength(s)])
        const peak = Math.max(...along.map(([, v]) => v))
        for (const [s, v] of along) {
          // 200 m either side of an end: the pair is sampled off the track, the bounds fade is not quite linear there.
          if (published.some(([s0, s1]) => s >= s0 + 200 && s <= s1 - 200) && v < 0.5 * peak) misplaced.push(`seed ${p.seed} wake ${i + 1} s=${s} weak inside`)
          if (published.every(([s0, s1]) => s < s0 - 200 || s > s1 + 200) && v >= 0.5 * peak) misplaced.push(`seed ${p.seed} wake ${i + 1} s=${s} strong outside`)
        }
      })
    }
    expect(tracks).toBeGreaterThan(100)
    expect(misplaced.slice(0, 5)).toEqual([])
  }, 30_000)
})

let sink: unknown = null

/** Garbage collections triggered while `fn` runs synchronously (nothing else can allocate meanwhile). */
async function collectionsDuring(fn: () => void): Promise<number> {
  let n = 0
  const obs = new PerformanceObserver((list) => (n += list.getEntries().length))
  obs.observe({ entryTypes: ['gc'] })
  // Flush entries from earlier tests, then measure.
  await new Promise((r) => setTimeout(r, 20))
  n = 0
  fn()
  await new Promise((r) => setTimeout(r, 50))
  obs.disconnect()
  return n
}

describe('sample allocation', () => {
  // Counts GCs rather than heap deltas: scavenges during the loop hide garbage from heapUsed.
  it('does not allocate per call when `out` is provided', async () => {
    const w = createWeather(params(3, 1))
    const out = newOut()
    const p = { x: 0, y: 0, z: 0 }
    const run = (n: number) => {
      for (let i = 0; i < n; i++) {
        p.x = (i * 7919) % 100_000
        p.y = (i * 131) % 14_000
        p.z = ((i * 613) % 40_000) - 20_000
        // Integer t: a double computed per iteration would be boxed by this caller at the call
        // boundary (the render passes one loop-invariant t per frame, which is not re-boxed).
        // The sink keeps the JIT from scalar-replacing a freshly allocated result.
        sink = w.sample(p, i % 900, out)
      }
    }
    run(400_000)
    // 3M calls: a single 16-byte object per call (48 MB) would force dozens of scavenges.
    const gcs = await collectionsDuring(() => run(3_000_000))
    expect(gcs).toBeLessThanOrEqual(2)
    expect(sink).toBe(out)
  }, 30_000)
})
