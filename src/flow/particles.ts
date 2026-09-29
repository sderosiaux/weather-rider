// CPU side of the flow layer: particle state, advection, recycling and the trail ring buffer.
// No three.js here: the renderer only uploads `points`. Allocation-free after construction.
import { createRng } from '../core/rng'
import type { MutableWeatherSample, WeatherField, WeatherFeatureKind } from '../core/types'
import {
  DEFAULT_SAMPLE_STRIDE,
  DEPTH_BIAS,
  FAR_DISTANCE,
  FRUSTUM_MARGIN,
  FRUSTUM_SHARE,
  INTERESTING_W,
  CALM_ACCEPT,
  SPAWN_TRIES,
  KIND_CODE,
  LIFE_MAX,
  LIFE_MIN,
  NEAR_RADIUS,
  PUSH_DT,
  VISUAL_TIME_SCALE,
} from './params'

/**
 * GPU record, one per (slot, particle), slot-major: record (s, i) starts at (s * count + i) * STRIDE.
 * Slot-major keeps a whole ring slot contiguous, so a frame uploads one or two slot blocks, not the ring.
 * Slot `trailPoints` mirrors slot 0 so segment (s → s+1) never needs wrap-around addressing.
 */
export const STRIDE = 12
export const R_POS = 0
export const R_VEL = 3
/** Push counter at which the record was written. Consecutive points of one trail differ by exactly 1. */
export const R_STAMP = 6
/** Push counter at which the particle (this life) was spawned. */
export const R_BIRTH = 7
export const R_TURB = 8
export const R_KIND = 9
export const R_SEED = 10
export const R_CLOUD = 11

/** Camera frame the spawn volume is built from. Mutated in place by the caller each frame. */
export interface ViewVolume {
  ox: number
  oy: number
  oz: number
  /** Unit forward / right / up. */
  fx: number
  fy: number
  fz: number
  rx: number
  ry: number
  rz: number
  ux: number
  uy: number
  uz: number
  /** tan(half fov) horizontally and vertically. */
  tanX: number
  tanY: number
}

export const createViewVolume = (): ViewVolume => ({
  ox: 0, oy: 0, oz: 0, fx: 1, fy: 0, fz: 0, rx: 0, ry: 0, rz: 1, ux: 0, uy: 1, uz: 0, tanX: 0.9, tanY: 0.55,
})

/** Particles that left the useful volume are wasted draw calls: recycle them into the view. */
export function isOutsideVolume(v: ViewVolume, x: number, y: number, z: number): boolean {
  const dx = x - v.ox
  const dy = y - v.oy
  const dz = z - v.oz
  const d2 = dx * dx + dy * dy + dz * dz
  if (d2 <= NEAR_RADIUS * NEAR_RADIUS) return false
  if (d2 > FAR_DISTANCE * FAR_DISTANCE * 1.1) return true
  const depth = dx * v.fx + dy * v.fy + dz * v.fz
  if (depth <= 0) return true
  const sx = (dx * v.rx + dy * v.ry + dz * v.rz) / (depth * v.tanX)
  const sy = (dx * v.ux + dy * v.uy + dz * v.uz) / (depth * v.tanY)
  const edge = FRUSTUM_MARGIN + 0.25
  return sx < -edge || sx > edge || sy < -edge || sy > edge
}

/** A segment between two ring records is drawable only if both belong to the same life, one push apart. Mirrored in the vertex shader. */
export function isSegmentValid(stampOlder: number, birthOlder: number, stampNewer: number, birthNewer: number): boolean {
  return stampNewer - stampOlder === 1 && birthOlder === birthNewer
}

export const kindCode = (k: WeatherFeatureKind | null): number => (k === null ? KIND_CODE.none : KIND_CODE[k])

export interface ParticleSim {
  readonly count: number
  readonly trailPoints: number
  /** (trailPoints + 1) * count * STRIDE floats, see STRIDE. */
  readonly points: Float32Array
  /** Current ring slot being written (the moving head of every trail). */
  readonly head: number
  /** Push counter + fraction toward the next push; the shader derives point age from it. */
  readonly clock: number
  /** Ring slots written by the last step() (first `dirtyCount` entries; includes the slot-0 mirror). */
  readonly dirty: Int32Array
  readonly dirtyCount: number
  sampleStride: number
  /** Respawn every particle and invalidate all trails. */
  reset(weather: WeatherField, simT: number, view: ViewVolume): void
  step(weather: WeatherField, simT: number, dtReal: number, view: ViewVolume): void
  /** Test/debug access. */
  positionOf(i: number, out: { x: number; y: number; z: number }): void
}

export function createParticleSim(count: number, trailPoints: number, seed = 0x5eed): ParticleSim {
  const rng = createRng(seed)
  const pos = new Float64Array(count * 3)
  const vel = new Float32Array(count * 3)
  const turb = new Float32Array(count)
  const kind = new Float32Array(count)
  const cloud = new Float32Array(count)
  const life = new Float32Array(count)
  const birth = new Float64Array(count)
  const seeds = new Float32Array(count)
  const points = new Float32Array((trailPoints + 1) * count * STRIDE)
  const dirty = new Int32Array(4)
  const sample: MutableWeatherSample = { wind: { x: 0, y: 0, z: 0 }, turbulence: 0, dominant: null, cloud: 0 }
  const probe = { x: 0, y: 0, z: 0 }

  let head = 0
  let pushes = 0
  let sincePush = 0
  let frame = 0
  let dirtyCount = 0

  const sampleAt = (weather: WeatherField, i: number, simT: number): void => {
    probe.x = pos[i * 3]!
    probe.y = pos[i * 3 + 1]!
    probe.z = pos[i * 3 + 2]!
    weather.sample(probe, simT, sample)
    vel[i * 3] = sample.wind.x
    vel[i * 3 + 1] = sample.wind.y
    vel[i * 3 + 2] = sample.wind.z
    turb[i] = sample.turbulence
    kind[i] = kindCode(sample.dominant)
    cloud[i] = sample.cloud
  }

  const place = (i: number, v: ViewVolume): void => {
    let x: number, y: number, z: number
    if (rng() < FRUSTUM_SHARE) {
      // Ray through a random screen point (slightly past the edges), range along the ray.
      const range = NEAR_RADIUS * 0.1 + (FAR_DISTANCE - NEAR_RADIUS * 0.1) * Math.pow(rng(), DEPTH_BIAS)
      const sx = (rng() * 2 - 1) * FRUSTUM_MARGIN * v.tanX
      const sy = (rng() * 2 - 1) * FRUSTUM_MARGIN * v.tanY
      const k = range / Math.sqrt(1 + sx * sx + sy * sy)
      x = v.ox + (v.fx + v.rx * sx + v.ux * sy) * k
      y = v.oy + (v.fy + v.ry * sx + v.uy * sy) * k
      z = v.oz + (v.fz + v.rz * sx + v.uz * sy) * k
    } else {
      // Uniform direction, radius ∝ u: denser toward the camera.
      const cz = rng() * 2 - 1
      const a = rng() * Math.PI * 2
      const s = Math.sqrt(1 - cz * cz)
      const r = NEAR_RADIUS * (0.05 + 0.95 * rng())
      x = v.ox + Math.cos(a) * s * r
      y = v.oy + cz * r
      z = v.oz + Math.sin(a) * s * r
    }
    pos[i * 3] = x
    pos[i * 3 + 1] = Math.max(y, 20)
    pos[i * 3 + 2] = z
  }

  const spawn = (weather: WeatherField, i: number, simT: number, v: ViewVolume): void => {
    for (let k = 0; k < SPAWN_TRIES; k++) {
      place(i, v)
      sampleAt(weather, i, simT)
      if (kind[i] !== KIND_CODE.none || Math.abs(vel[i * 3 + 1]!) > INTERESTING_W || rng() < CALM_ACCEPT) break
    }
    life[i] = LIFE_MIN + (LIFE_MAX - LIFE_MIN) * rng()
    birth[i] = pushes
    seeds[i] = rng()
  }

  const writeRecord = (slot: number, i: number): void => {
    let o = (slot * count + i) * STRIDE
    for (let pass = 0; pass < (slot === 0 ? 2 : 1); pass++) {
      points[o + R_POS] = pos[i * 3]!
      points[o + R_POS + 1] = pos[i * 3 + 1]!
      points[o + R_POS + 2] = pos[i * 3 + 2]!
      points[o + R_VEL] = vel[i * 3]!
      points[o + R_VEL + 1] = vel[i * 3 + 1]!
      points[o + R_VEL + 2] = vel[i * 3 + 2]!
      points[o + R_STAMP] = pushes
      points[o + R_BIRTH] = birth[i]!
      points[o + R_TURB] = turb[i]!
      points[o + R_KIND] = kind[i]!
      points[o + R_SEED] = seeds[i]!
      points[o + R_CLOUD] = cloud[i]!
      o = (trailPoints * count + i) * STRIDE
    }
  }

  const markDirty = (slot: number): void => {
    dirty[dirtyCount++] = slot
    if (slot === 0) dirty[dirtyCount++] = trailPoints
  }

  const sim: ParticleSim = {
    count,
    trailPoints,
    points,
    dirty,
    sampleStride: DEFAULT_SAMPLE_STRIDE,
    get head() {
      return head
    },
    get clock() {
      return pushes + sincePush / PUSH_DT
    },
    get dirtyCount() {
      return dirtyCount
    },

    reset(weather, simT, view) {
      // Stamps 0 everywhere and births -1: no pair of records is one push apart, so nothing draws.
      points.fill(0)
      for (let r = 0; r < points.length; r += STRIDE) points[r + R_BIRTH] = -1
      pushes += trailPoints + 2
      sincePush = 0
      head = 0
      for (let i = 0; i < count; i++) {
        spawn(weather, i, simT, view)
        // Stagger initial lives so recycling is spread over time instead of pulsing.
        life[i] = LIFE_MIN * 0.2 + (LIFE_MAX - LIFE_MIN * 0.2) * rng()
        writeRecord(head, i)
      }
      dirtyCount = 0
    },

    step(weather, simT, dtReal, view) {
      const dt = Math.min(Math.max(dtReal, 0), 0.1)
      const move = dt * VISUAL_TIME_SCALE
      const stride = Math.max(1, sim.sampleStride | 0)
      const phase = frame % stride
      frame++
      dirtyCount = 0

      for (let i = 0; i < count; i++) {
        if (i % stride === phase) sampleAt(weather, i, simT)
        pos[i * 3] = pos[i * 3]! + vel[i * 3]! * move
        pos[i * 3 + 1] = pos[i * 3 + 1]! + vel[i * 3 + 1]! * move
        pos[i * 3 + 2] = pos[i * 3 + 2]! + vel[i * 3 + 2]! * move
        life[i] = life[i]! - dt
        writeRecord(head, i)
      }
      markDirty(head)

      sincePush += dt
      if (sincePush < PUSH_DT) return
      // One push per step at most: a long frame just stretches a segment instead of freezing the trail.
      sincePush = Math.min(sincePush - PUSH_DT, PUSH_DT * 0.99)
      pushes++
      head = (head + 1) % trailPoints
      for (let i = 0; i < count; i++) {
        // Respawn only at push boundaries: the dying trail keeps its full history and fades by age.
        if (life[i]! <= 0 || isOutsideVolume(view, pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!)) spawn(weather, i, simT, view)
        writeRecord(head, i)
      }
      markDirty(head)
    },

    positionOf(i, out) {
      out.x = pos[i * 3]!
      out.y = pos[i * 3 + 1]!
      out.z = pos[i * 3 + 2]!
    },
  }
  return sim
}
