import { describe, expect, it } from 'vitest'
import { v3 } from '../core/math'
import { createRng } from '../core/rng'
import type { MutableWeatherSample, Vec3, WeatherField, WeatherFeature, WeatherParams } from '../core/types'
import { SEVERE_TURBULENCE } from '../core/constants'
import { dailyWeatherFor, weatherParamsFor } from '../meta'
import type { Route } from '../core/types'
import { createWeather } from './index'

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
  })

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
  })

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

  it('is continuous: samples 10 m apart never jump', () => {
    const out = newOut()
    const out2 = newOut()
    const check = (w: WeatherField, pt: Vec3, t: number, dir: Vec3) => {
      const a = w.sample(pt, t, out)
      const b = w.sample(v3(pt.x + dir.x * 10, pt.y + dir.y * 10, pt.z + dir.z * 10), t, out2)
      const dw = Math.hypot(a.wind.x - b.wind.x, a.wind.y - b.wind.y, a.wind.z - b.wind.z)
      expect(dw, `at ${pt.x.toFixed(0)},${pt.y.toFixed(0)},${pt.z.toFixed(0)} t=${t}`).toBeLessThan(4)
      expect(Math.abs(a.turbulence - b.turbulence)).toBeLessThan(0.1)
      const c = w.sample(pt, t + 1 / 60, out2)
      expect(Math.hypot(a.wind.x - c.wind.x, a.wind.y - c.wind.y, a.wind.z - c.wind.z)).toBeLessThan(1.5)
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
  })

  it('samples 100k corridor points fast, without reallocating the output', () => {
    const w = createWeather(params(99, 1))
    const rng = createRng(3)
    const n = 100_000
    const pts = new Float64Array(n * 4)
    for (let i = 0; i < n; i++) {
      pts[i * 4] = rng() * 100_000
      pts[i * 4 + 1] = rng() * 13_000
      pts[i * 4 + 2] = (rng() * 2 - 1) * 20_000
      pts[i * 4 + 3] = rng() * 600
    }
    const out = newOut()
    const p = { x: 0, y: 0, z: 0 }
    const run = () => {
      let acc = 0
      for (let i = 0; i < n; i++) {
        p.x = pts[i * 4]!
        p.y = pts[i * 4 + 1]!
        p.z = pts[i * 4 + 2]!
        const s = w.sample(p, pts[i * 4 + 3]!, out)
        acc += s.wind.x
      }
      return acc
    }
    run()
    run()
    const t0 = performance.now()
    const acc = run()
    const ms = performance.now() - t0
    console.log(`weather.sample: 100k samples in ${ms.toFixed(1)} ms`)
    expect(Number.isFinite(acc)).toBe(true)
    expect(ms).toBeLessThan(150)
    expect(w.sample(p, 0, out)).toBe(out)
  })
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
  })

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
  })
})
