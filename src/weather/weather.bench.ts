// Wall-clock budget, kept out of the unit suite (load-dependent). Budget: 100k samples ≤ 150 ms,
// i.e. ≤ 1.5 µs per sample — the particle system samples every particle every frame.
import { test } from 'vitest'
import { v3 } from '../core/math'
import { createRng } from '../core/rng'
import type { MutableWeatherSample, WeatherField } from '../core/types'
import { createWeather } from './index'

const N = 100_000

function corridorPoints(seed: number): Float64Array {
  const rng = createRng(seed)
  const pts = new Float64Array(N * 3)
  for (let i = 0; i < N; i++) {
    pts[i * 3] = rng() * 100_000
    pts[i * 3 + 1] = rng() * 13_000
    pts[i * 3 + 2] = (rng() * 2 - 1) * 20_000
  }
  return pts
}

/** One frame's worth of sampling: every point at the same sim time, like the particle system. */
function sampleAll(w: WeatherField, pts: Float64Array, t: number, out: MutableWeatherSample): number {
  const p = { x: 0, y: 0, z: 0 }
  let acc = 0
  for (let i = 0; i < N; i++) {
    p.x = pts[i * 3]!
    p.y = pts[i * 3 + 1]!
    p.z = pts[i * 3 + 2]!
    acc += w.sample(p, t, out).wind.x
  }
  return acc
}

test('weather.sample — 100k corridor points per frame (budget 150 ms)', async ({ bench }) => {
  const out: MutableWeatherSample = { wind: { x: 0, y: 0, z: 0 }, turbulence: 0, dominant: null, cloud: 0 }
  const pts = corridorPoints(3)
  const bounds = { boundsMin: v3(-10_000, 0, -30_000), boundsMax: v3(110_000, 14_000, 30_000), corridor: [v3(0, 3000, 0), v3(100_000, 3000, 0)] as const }
  const calm = createWeather({ seed: 99, severity: 0, ...bounds })
  const extreme = createWeather({ seed: 99, severity: 1, ...bounds })
  let frame = 0
  await bench.compare(
    bench('severity 0', () => {
      sampleAll(calm, pts, (frame++ % 600) / 60, out)
    }),
    bench('severity 1', () => {
      sampleAll(extreme, pts, (frame++ % 600) / 60, out)
    }),
  )
})
