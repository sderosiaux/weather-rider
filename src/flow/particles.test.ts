import { describe, expect, it } from 'vitest'
import { createFixtureWeather } from '../core/fixtures'
import type { MutableWeatherSample, Vec3, WeatherField, WeatherFeatureKind, WeatherSample } from '../core/types'
import { FAR_DISTANCE, KIND_CODE, NEAR_RADIUS, PUSH_DT, VISUAL_TIME_SCALE } from './params'
import {
  createParticleSim,
  createViewVolume,
  isOutsideVolume,
  isSegmentValid,
  R_BIRTH,
  R_KIND,
  R_POS,
  R_STAMP,
  STRIDE,
  type ParticleSim,
  type ViewVolume,
} from './particles'

const DT = 1 / 60

/** Uniform wind everywhere, optional dominant label by predicate. Counts sample() calls. */
function fieldOf(wind: Vec3, dominant: (p: Vec3) => WeatherFeatureKind | null = () => null): WeatherField & { calls: number } {
  const f = {
    calls: 0,
    seed: 1,
    boundsMin: { x: -1e6, y: 0, z: -1e6 },
    boundsMax: { x: 1e6, y: 14_000, z: 1e6 },
    features: [],
    sample(p: Vec3, _t: number, out?: MutableWeatherSample): WeatherSample {
      f.calls++
      const o = out ?? { wind: { x: 0, y: 0, z: 0 }, turbulence: 0, dominant: null, cloud: 0 }
      o.wind.x = wind.x
      o.wind.y = wind.y
      o.wind.z = wind.z
      o.turbulence = 0
      o.dominant = dominant(p)
      o.cloud = 0
      return o
    },
  }
  return f
}

const viewAt = (x: number, y: number, z: number): ViewVolume => {
  const v = createViewVolume()
  v.ox = x
  v.oy = y
  v.oz = z
  return v
}

const record = (sim: ParticleSim, slot: number, i: number): number => (slot * sim.count + i) * STRIDE

const segmentValid = (sim: ParticleSim, slot: number, i: number): boolean => {
  const a = record(sim, slot, i)
  const b = record(sim, slot + 1, i)
  const pts = sim.points
  return isSegmentValid(pts[a + R_STAMP]!, pts[a + R_BIRTH]!, pts[b + R_STAMP]!, pts[b + R_BIRTH]!)
}

const run = (sim: ParticleSim, w: WeatherField, view: ViewVolume, frames: number): void => {
  for (let k = 0; k < frames; k++) sim.step(w, k * DT, DT, view)
}

describe('isSegmentValid', () => {
  it('accepts consecutive records of one life only', () => {
    expect(isSegmentValid(10, 3, 11, 3)).toBe(true)
    expect(isSegmentValid(10, 3, 12, 3)).toBe(false) // gap
    expect(isSegmentValid(11, 3, 10, 3)).toBe(false) // reversed: the ring wrap (newest → oldest)
    expect(isSegmentValid(10, 3, 11, 11)).toBe(false) // respawn between the two records
  })
})

describe('isOutsideVolume', () => {
  const v = viewAt(0, 3000, 0) // looking +x
  it('keeps everything in the near sphere, even behind the camera', () => {
    expect(isOutsideVolume(v, -NEAR_RADIUS * 0.9, 3000, 0)).toBe(false)
  })
  it('recycles behind the camera beyond the near sphere, and beyond FAR', () => {
    expect(isOutsideVolume(v, -NEAR_RADIUS * 1.5, 3000, 0)).toBe(true)
    expect(isOutsideVolume(v, FAR_DISTANCE * 1.2, 3000, 0)).toBe(true)
  })
  it('keeps the frustum, recycles far off to the side', () => {
    expect(isOutsideVolume(v, 4000, 3000, 500)).toBe(false)
    expect(isOutsideVolume(v, 2000, 3000, 6000)).toBe(true)
  })
})

describe('particle sim', () => {
  const N = 200
  const K = 12

  it('draws nothing right after reset: history is invalidated', () => {
    const sim = createParticleSim(N, K)
    sim.reset(createFixtureWeather(), 0, viewAt(0, 3000, 0))
    for (let i = 0; i < N; i++) for (let s = 0; s < K; s++) expect(segmentValid(sim, s, i)).toBe(false)
  })

  it('advects by wind × VISUAL_TIME_SCALE', () => {
    const w = fieldOf({ x: 8, y: 2, z: -1 })
    const sim = createParticleSim(N, K)
    const view = viewAt(0, 3000, 0)
    sim.reset(w, 0, view)
    const before = { x: 0, y: 0, z: 0 }
    const after = { x: 0, y: 0, z: 0 }
    sim.positionOf(7, before)
    sim.step(w, 0, DT, view) // no push yet (DT < PUSH_DT), so no respawn
    sim.positionOf(7, after)
    expect(after.x - before.x).toBeCloseTo(8 * VISUAL_TIME_SCALE * DT, 6)
    expect(after.y - before.y).toBeCloseTo(2 * VISUAL_TIME_SCALE * DT, 6)
    expect(after.z - before.z).toBeCloseTo(-1 * VISUAL_TIME_SCALE * DT, 6)
  })

  it('ring: at most K-1 valid segments per particle, and the head → oldest wrap is never drawn', () => {
    const w = createFixtureWeather()
    const sim = createParticleSim(N, K)
    const view = viewAt(29_000, 4000, 0)
    sim.reset(w, 0, view)
    let longest = 0
    for (let f = 0; f < 600; f++) {
      sim.step(w, f * DT, DT, view)
      if (f % 7 !== 0) continue
      for (let i = 0; i < N; i++) {
        let valid = 0
        for (let s = 0; s < K; s++) if (segmentValid(sim, s, i)) valid++
        expect(valid).toBeLessThanOrEqual(K - 1)
        longest = Math.max(longest, valid)
        expect(segmentValid(sim, sim.head, i)).toBe(false)
      }
    }
    expect(longest).toBe(K - 1) // trails do fill the ring
  })

  it('mirror slot K always equals slot 0', () => {
    const w = createFixtureWeather()
    const sim = createParticleSim(N, K)
    const view = viewAt(0, 3000, 0)
    sim.reset(w, 0, view)
    for (let f = 0; f < 200; f++) {
      sim.step(w, f * DT, DT, view)
      const a = sim.points.subarray(0, N * STRIDE)
      const b = sim.points.subarray(K * N * STRIDE, (K + 1) * N * STRIDE)
      expect(b).toEqual(a)
    }
  })

  it('dirty slots cover exactly what changed, including the mirror', () => {
    const w = createFixtureWeather()
    const sim = createParticleSim(N, K)
    const view = viewAt(0, 3000, 0)
    sim.reset(w, 0, view)
    let prev = sim.points.slice()
    for (let f = 0; f < 120; f++) {
      sim.step(w, f * DT, DT, view)
      const dirty = new Set(Array.from(sim.dirty.subarray(0, sim.dirtyCount)))
      for (let s = 0; s <= K; s++) {
        const lo = s * N * STRIDE
        const changed = sim.points.subarray(lo, lo + N * STRIDE).some((v, k) => v !== prev[lo + k])
        if (changed) expect(dirty.has(s)).toBe(true)
      }
      prev = sim.points.slice()
    }
  })

  it('recycles particles that left the volume into it at the next push', () => {
    const w = fieldOf({ x: 5, y: 0, z: 0 })
    const sim = createParticleSim(N, K)
    sim.reset(w, 0, viewAt(0, 3000, 0))
    const moved = viewAt(50_000, 3000, 0)
    run(sim, w, moved, Math.ceil(PUSH_DT / DT) + 1)
    const p = { x: 0, y: 0, z: 0 }
    for (let i = 0; i < N; i++) {
      sim.positionOf(i, p)
      expect(isOutsideVolume(moved, p.x, p.y, p.z)).toBe(false)
    }
  })

  it('never spawns below 20 m', () => {
    const w = fieldOf({ x: 0, y: 0, z: 0 })
    const sim = createParticleSim(N, K)
    sim.reset(w, 0, viewAt(0, 30, 0))
    const p = { x: 0, y: 0, z: 0 }
    for (let i = 0; i < N; i++) {
      sim.positionOf(i, p)
      expect(p.y).toBeGreaterThanOrEqual(20)
    }
  })

  it('importance spawning over-represents interesting air', () => {
    // Updraft label on the z > 0 half of space: ~half the spawn volume.
    const w = fieldOf({ x: 8, y: 0, z: 0 }, (p) => (p.z > 0 ? 'updraft' : null))
    const sim = createParticleSim(2000, K)
    sim.reset(w, 0, viewAt(0, 3000, 0))
    let inside = 0
    for (let i = 0; i < 2000; i++) if (sim.points[record(sim, sim.head, i) + R_KIND] === KIND_CODE.updraft) inside++
    expect(inside / 2000).toBeGreaterThan(0.7)
  })

  it('samples roughly count / stride particles per frame', () => {
    const w = fieldOf({ x: 1, y: 0, z: 0 })
    const sim = createParticleSim(1200, K)
    const view = viewAt(0, 3000, 0)
    sim.reset(w, 0, view)
    sim.sampleStride = 3
    w.calls = 0
    sim.step(w, 0, DT, view) // no push on this frame → no spawns
    expect(w.calls).toBe(400)
  })

  it('is deterministic for a given seed', () => {
    const w = createFixtureWeather()
    const a = createParticleSim(N, K, 42)
    const b = createParticleSim(N, K, 42)
    const view = viewAt(29_000, 4000, 0)
    a.reset(w, 0, view)
    b.reset(w, 0, view)
    run(a, w, view, 90)
    run(b, w, view, 90)
    expect(a.points).toEqual(b.points)
    expect(a.points[record(a, a.head, 0) + R_POS]).toBe(b.points[record(b, b.head, 0) + R_POS])
  })
})
