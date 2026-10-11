// Seeded 2D gradient noise for the land. Lattice tables come from hashInts at creation; evaluation only reads
// typed arrays, so the hot path (heightAt / coverAt) never allocates.
import { hashInts } from '../core/rng'

const SIZE = 1024
const MASK = SIZE - 1
/** Perlin 2D with unit gradients peaks near ±√½: this brings it to ~±1. */
const NORM = Math.SQRT2
const MAX_OCTAVES = 8
/** Each octave is rotated (irrational-ish angle) and shifted so lattice axes never line up into visible grids. */
const OCTAVE_ANGLE = 0.618
const OCTAVE_SHIFT = 71.37

export interface Noise2 {
  /** Gradient noise at lattice coordinates, ~[-1, 1]. */
  at(x: number, z: number): number
  /** fBm from `wavelength` (m) down, persistence ½, normalised to ~[-1, 1]. */
  fbm(x: number, z: number, wavelength: number, octaves: number): number
  /** Ridged multifractal in [0, 1]: sharp crests, smooth valleys, rougher high up. */
  ridged(x: number, z: number, wavelength: number, octaves: number): number
}

export function createNoise2(seed: number): Noise2 {
  const perm = new Int32Array(SIZE * 2)
  const order = new Int32Array(SIZE)
  for (let i = 0; i < SIZE; i++) order[i] = i
  for (let i = SIZE - 1; i > 0; i--) {
    const j = hashInts(seed, 0x7e44, i) % (i + 1)
    const tmp = order[i]!
    order[i] = order[j]!
    order[j] = tmp
  }
  for (let i = 0; i < SIZE * 2; i++) perm[i] = order[i & MASK]!
  const gx = new Float64Array(SIZE)
  const gz = new Float64Array(SIZE)
  for (let i = 0; i < SIZE; i++) {
    const a = (hashInts(seed, 0x9ad, i) / 4294967296) * Math.PI * 2
    gx[i] = Math.cos(a)
    gz[i] = Math.sin(a)
  }
  // Per-octave rotation (c, s) and shift.
  const rc = new Float64Array(MAX_OCTAVES)
  const rs = new Float64Array(MAX_OCTAVES)
  const sh = new Float64Array(MAX_OCTAVES)
  for (let o = 0; o < MAX_OCTAVES; o++) {
    rc[o] = Math.cos(o * OCTAVE_ANGLE)
    rs[o] = Math.sin(o * OCTAVE_ANGLE)
    sh[o] = o * OCTAVE_SHIFT
  }

  const at = (x: number, z: number): number => {
    const fx = Math.floor(x)
    const fz = Math.floor(z)
    const tx = x - fx
    const tz = z - fz
    const ix = fx & MASK
    const iz = fz & MASK
    const a = perm[ix]!
    const b = perm[ix + 1]!
    const h00 = perm[a + iz]!
    const h01 = perm[a + iz + 1]!
    const h10 = perm[b + iz]!
    const h11 = perm[b + iz + 1]!
    const n00 = gx[h00]! * tx + gz[h00]! * tz
    const n10 = gx[h10]! * (tx - 1) + gz[h10]! * tz
    const n01 = gx[h01]! * tx + gz[h01]! * (tz - 1)
    const n11 = gx[h11]! * (tx - 1) + gz[h11]! * (tz - 1)
    const ux = tx * tx * tx * (tx * (tx * 6 - 15) + 10)
    const uz = tz * tz * tz * (tz * (tz * 6 - 15) + 10)
    const n0 = n00 + (n10 - n00) * ux
    const n1 = n01 + (n11 - n01) * ux
    return (n0 + (n1 - n0) * uz) * NORM
  }

  return {
    at,
    fbm(x, z, wavelength, octaves) {
      let f = 1 / wavelength
      let amp = 1
      let sum = 0
      let norm = 0
      for (let o = 0; o < octaves; o++) {
        const px = x * f
        const pz = z * f
        sum += amp * at(px * rc[o]! - pz * rs[o]! + sh[o]!, px * rs[o]! + pz * rc[o]! - sh[o]!)
        norm += amp
        amp *= 0.5
        f *= 2
      }
      return sum / norm
    },
    ridged(x, z, wavelength, octaves) {
      let f = 1 / wavelength
      let amp = 1
      let weight = 1
      let sum = 0
      let norm = 0
      for (let o = 0; o < octaves; o++) {
        const px = x * f
        const pz = z * f
        // Gradient noise inlined (same as `at`): the costliest call of heightAt.
        const qx = px * rc[o]! - pz * rs[o]! + sh[o]!
        const qz = px * rs[o]! + pz * rc[o]! - sh[o]!
        const fx = Math.floor(qx)
        const fz = Math.floor(qz)
        const tx = qx - fx
        const tz = qz - fz
        const ix = fx & MASK
        const iz = fz & MASK
        const a = perm[ix]!
        const b = perm[ix + 1]!
        const h00 = perm[a + iz]!
        const h01 = perm[a + iz + 1]!
        const h10 = perm[b + iz]!
        const h11 = perm[b + iz + 1]!
        const n00 = gx[h00]! * tx + gz[h00]! * tz
        const n10 = gx[h10]! * (tx - 1) + gz[h10]! * tz
        const n01 = gx[h01]! * tx + gz[h01]! * (tz - 1)
        const n11 = gx[h11]! * (tx - 1) + gz[h11]! * (tz - 1)
        const ux = tx * tx * tx * (tx * (tx * 6 - 15) + 10)
        const uz = tz * tz * tz * (tz * (tz * 6 - 15) + 10)
        const n0 = n00 + (n10 - n00) * ux
        const n1 = n01 + (n11 - n01) * ux
        const n = (n0 + (n1 - n0) * uz) * NORM
        // Branch-free (the sign of n is a coin toss: branches here mispredict half the time).
        const c = 1 - Math.abs(n)
        const r = c * c
        // Musgrave weighting: detail only where the coarser octaves already made a crest.
        sum += amp * r * weight
        norm += amp
        weight = Math.min(r * 1.6, 1)
        amp *= 0.5
        f *= 2
      }
      return sum / norm
    },
  }
}
