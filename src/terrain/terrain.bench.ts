// Wall-clock budgets, kept out of the unit suite (load-dependent; a CI runner is ~2× slower than a laptop).
// Targets: heightAt / coverAt ≈ 0.5 µs per call (the flight model calls heightAt every step, render bakes
// textures with millions of calls); generating a route's terrain well under a second.
import { test } from 'vitest'
import { createRng } from '../core/rng'
import { createTerrain } from './index'
import { dailyParams } from './testkit'

const N = 100_000

test('terrain queries — 100k random points in the playable bounds', async ({ bench }) => {
  const p = dailyParams(87, 1)[0]!.params
  const t = createTerrain(p)
  const rng = createRng(7)
  const xs = new Float64Array(N)
  const zs = new Float64Array(N)
  for (let i = 0; i < N; i++) {
    xs[i] = p.boundsMin.x + rng() * (p.boundsMax.x - p.boundsMin.x)
    zs[i] = p.boundsMin.z + rng() * (p.boundsMax.z - p.boundsMin.z)
  }
  let sink = 0
  await bench.compare(
    bench('heightAt', () => {
      for (let i = 0; i < N; i++) sink += t.heightAt(xs[i]!, zs[i]!)
    }),
    bench('coverAt', () => {
      for (let i = 0; i < N; i++) sink += t.coverAt(xs[i]!, zs[i]!).length
    }),
  )
  if (!Number.isFinite(sink)) throw new Error('non-finite terrain height')
})

test('terrain generation — one route', async ({ bench }) => {
  const p = dailyParams(130, 1)[0]!.params
  await bench('createTerrain', () => void createTerrain(p)).run()
})
