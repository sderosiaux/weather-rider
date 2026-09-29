// Seeded 3D value noise with analytic gradient. Lattice values come from hashInts at
// creation; the hot path only does table lookups so it never allocates.
import { hashInts } from '../core/rng'

const SIZE = 1024
const MASK = SIZE - 1

/** Slots of `NoisePair.res`: first field ("potential", in [-1, 1]) with its x/z partials, second independent field. */
export const PSI = 0
export const D_PSI_DX = 1
export const D_PSI_DZ = 2
export const PHI = 3

/**
 * Input and output go through typed arrays: V8 boxes double arguments and object-field
 * doubles on non-inlined calls, and this runs per particle per frame.
 */
export interface NoisePair {
  /** Lattice-space point (x, y, z) to evaluate at. */
  readonly inp: Float64Array
  /** Results, indexed by PSI / D_PSI_DX / D_PSI_DZ / PHI. */
  readonly res: Float64Array
  /** Evaluates both fields at `inp` into `res`. */
  eval(): void
}

export function createNoisePair(seed: number): NoisePair {
  const perm = new Int32Array(SIZE * 2)
  const order = new Int32Array(SIZE)
  for (let i = 0; i < SIZE; i++) order[i] = i
  // Fisher-Yates driven by hashInts so the lattice is a pure function of the seed.
  for (let i = SIZE - 1; i > 0; i--) {
    const j = hashInts(seed, 0x9e37, i) % (i + 1)
    const tmp = order[i]!
    order[i] = order[j]!
    order[j] = tmp
  }
  for (let i = 0; i < SIZE * 2; i++) perm[i] = order[i & MASK]!
  const valA = new Float64Array(SIZE)
  const valB = new Float64Array(SIZE)
  for (let i = 0; i < SIZE; i++) {
    valA[i] = (hashInts(seed, 0xa11ce, i) / 4294967296) * 2 - 1
    valB[i] = (hashInts(seed, 0xb0b, i) / 4294967296) * 2 - 1
  }

  const inp = new Float64Array(3)
  const res = new Float64Array(4)
  return {
    inp,
    res,
    eval() {
      const x = inp[0]!
      const y = inp[1]!
      const z = inp[2]!
      const fx = Math.floor(x)
      const fy = Math.floor(y)
      const fz = Math.floor(z)
      const tx = x - fx
      const ty = y - fy
      const tz = z - fz
      const ix = fx & MASK
      const iy = fy & MASK
      const iz = fz & MASK
      const jx = (ix + 1) & MASK
      const jy = (iy + 1) & MASK
      const jz = (iz + 1) & MASK
      // Quintic fade and its derivative (C2 continuous field).
      const ux = tx * tx * tx * (tx * (tx * 6 - 15) + 10)
      const uy = ty * ty * ty * (ty * (ty * 6 - 15) + 10)
      const uz = tz * tz * tz * (tz * (tz * 6 - 15) + 10)
      const dux = 30 * tx * tx * (tx - 1) * (tx - 1)
      const duz = 30 * tz * tz * (tz - 1) * (tz - 1)

      const px0 = perm[ix]!
      const px1 = perm[jx]!
      const p00 = perm[px0 + iy]!
      const p01 = perm[px0 + jy]!
      const p10 = perm[px1 + iy]!
      const p11 = perm[px1 + jy]!
      const h000 = perm[p00 + iz]!
      const h001 = perm[p00 + jz]!
      const h010 = perm[p01 + iz]!
      const h011 = perm[p01 + jz]!
      const h100 = perm[p10 + iz]!
      const h101 = perm[p10 + jz]!
      const h110 = perm[p11 + iz]!
      const h111 = perm[p11 + jz]!

      // Field A with gradient (Quilez formulation).
      const a = valA[h000]!, b = valA[h100]!, c = valA[h010]!, d = valA[h110]!
      const e = valA[h001]!, f = valA[h101]!, g = valA[h011]!, h = valA[h111]!
      const k1 = b - a
      const k2 = c - a
      const k3 = e - a
      const k4 = a - b - c + d
      const k5 = a - c - e + g
      const k6 = a - b - e + f
      const k7 = -a + b + c - d + e - f - g + h
      res[PSI] = a + k1 * ux + k2 * uy + k3 * uz + k4 * ux * uy + k5 * uy * uz + k6 * uz * ux + k7 * ux * uy * uz
      res[D_PSI_DX] = dux * (k1 + k4 * uy + k6 * uz + k7 * uy * uz)
      res[D_PSI_DZ] = duz * (k3 + k5 * uy + k6 * ux + k7 * ux * uy)

      // Field B, value only.
      const a2 = valB[h000]!, b2 = valB[h100]!, c2 = valB[h010]!, d2 = valB[h110]!
      const e2 = valB[h001]!, f2 = valB[h101]!, g2 = valB[h011]!, h2 = valB[h111]!
      const x00 = a2 + (b2 - a2) * ux
      const x10 = c2 + (d2 - c2) * ux
      const x01 = e2 + (f2 - e2) * ux
      const x11 = g2 + (h2 - g2) * ux
      const y0 = x00 + (x10 - x00) * uy
      const y1 = x01 + (x11 - x01) * uy
      res[PHI] = y0 + (y1 - y0) * uz
    },
  }
}
