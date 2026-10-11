// The hot path. heightAt / coverAt read flat typed arrays only: no allocation, cost independent of how many
// rivers, lakes or ranges the journey has (spatial grids bound the work per call).
import type { TerrainCover } from '../core/types'
import { CELL, FARM, FOREST, HILL, MACRO, RIDGE, STRIDE, type Noises, type Raster } from './bake'
import { GLOBAL_KNEE, KNEE, MAX_GROUND, type Clearance } from './clearance'
import { NO_LAKE } from './hydro'
import type { ChannelLine, ValleyLine } from './rivers'

/** Query-time noise: hills 8 km → 500 m, ridges 11 km → 700 m, cover edges 2.6 km → 1.3 km. */
const HILL_WAVELENGTH = 8000
const HILL_OCTAVES = 5
const RIDGE_WAVELENGTH = 11_000
const RIDGE_OCTAVES = 5
const COVER_WAVELENGTH = 2600

const VALLEY_CELL = 2000
/** Banks (m) over which a river channel blends back into its valley floor. */
const BANK = 150
/** Drop (m) of the channel's lower bound across the bank: large, so it never pulls land up past the banks. */
const LEVEE_DROP = 400
const CHANNEL_CELL = 500

/** Cover thresholds (m), jittered by ±140 m of cover noise. */
const SNOW_LINE = 2250
const ROCK_LINE = 1850
const TREE_LINE = 1650
const FIELDS_MAX = 1100
/** Open-land patches (m): woodlot and field noise wavelengths, and the domain warp that bends their edges. */
const WOOD_WAVELENGTH = 1900
const FIELD_WAVELENGTH = 2200
const WARP = 700

/** Shoreline wiggle: depth noise amplitude (m) and wavelength (m). */
const SHORE_NOISE = 12
const SHORE_WAVELENGTH = 1600
const MAX_CITIES = 64

// Scratch slots written by evalPoint, read by coverAt.
const S_MACRO = 0
const S_RIDGE_AMP = 1
const S_RIDGED = 2
const S_HN = 3
const S_LAKE = 4
const S_CITY = 5
const S_CITY_D = 6
const S_FOREST = 7
const S_FARM = 8
/** 1 inside a river channel. */
const S_RIVER = 9

export interface CityDisc {
  readonly x: number
  readonly z: number
  readonly radius: number
  /** Ground level the city is flattened toward. */
  readonly level: number
}

export interface Sampler {
  heightAt(x: number, z: number): number
  coverAt(x: number, z: number): TerrainCover
  /** Bilinear macro height (no hills, ridges, rivers): coarse land shape, for placement decisions. */
  macroAt(x: number, z: number): number
  ridgeAmpAt(x: number, z: number): number
  /** True if (x, z) is lake water. */
  inLake(x: number, z: number): boolean
  setCities(cities: readonly CityDisc[]): void
}

interface Grid {
  readonly ox: number
  readonly oz: number
  readonly nx: number
  readonly nz: number
  readonly inv: number
  readonly off: Int32Array
  readonly items: Int32Array
}

/** Whether the capsule (segment a→b, radius `rad`) can reach the square cell centred on (cx, cz). */
function touches(ax: number, az: number, bx: number, bz: number, rad: number, cx: number, cz: number, half: number): boolean {
  const dx = bx - ax
  const dz = bz - az
  const l2 = dx * dx + dz * dz
  let t = l2 > 0 ? ((cx - ax) * dx + (cz - az) * dz) / l2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(cx - ax - dx * t, cz - az - dz * t) <= rad + half * Math.SQRT2
}

/** CSR grid of segment ids whose capsule (radius per segment) touches each cell. */
function buildGrid(r: Raster, cell: number, segs: Float64Array, stride: number, count: number, radiusOf: (base: number) => number): Grid {
  const ox = r.ox
  const oz = r.oz
  const nx = Math.ceil(((r.nx - 1) * CELL) / cell) + 1
  const nz = Math.ceil(((r.nz - 1) * CELL) / cell) + 1
  const inv = 1 / cell
  const ranges = new Int32Array(count * 4)
  const counts = new Int32Array(nx * nz + 1)
  for (let s = 0; s < count; s++) {
    const b = s * stride
    const ax = segs[b]!
    const az = segs[b + 1]!
    const bx = ax + segs[b + 2]!
    const bz = az + segs[b + 3]!
    const rad = radiusOf(b)
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - rad - ox) * inv))
    const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx) + rad - ox) * inv))
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - rad - oz) * inv))
    const j1 = Math.min(nz - 1, Math.floor((Math.max(az, bz) + rad - oz) * inv))
    ranges[s * 4] = i0
    ranges[s * 4 + 1] = i1
    ranges[s * 4 + 2] = j0
    ranges[s * 4 + 3] = j1
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (touches(ax, az, bx, bz, rad, ox + (i + 0.5) * cell, oz + (j + 0.5) * cell, cell / 2)) counts[j * nx + i + 1]!++
  }
  const off = new Int32Array(nx * nz + 1)
  for (let c = 0; c < nx * nz; c++) off[c + 1] = off[c]! + counts[c + 1]!
  const fill = off.slice(0, nx * nz)
  const items = new Int32Array(off[nx * nz]!)
  for (let s = 0; s < count; s++) {
    const b = s * stride
    const ax = segs[b]!
    const az = segs[b + 1]!
    const rad = radiusOf(b)
    for (let j = ranges[s * 4 + 2]!; j <= ranges[s * 4 + 3]!; j++) {
      for (let i = ranges[s * 4]!; i <= ranges[s * 4 + 1]!; i++) {
        if (touches(ax, az, ax + segs[b + 2]!, az + segs[b + 3]!, rad, ox + (i + 0.5) * cell, oz + (j + 0.5) * cell, cell / 2)) items[fill[j * nx + i]!++] = s
      }
    }
  }
  return { ox, oz, nx, nz, inv, off, items }
}

// Valley segment layout.
const VS = 11
// Channel segment layout.
const CS = 9

export interface SamplerInput {
  readonly raster: Raster
  /** Lake surface per raster node (NO_LAKE elsewhere), already dilated over the shore band. */
  readonly lakeLevel: Float32Array
  /** Water depth below that level per node (negative on the shore, -LAKE_DRY elsewhere). */
  readonly lakeWet: Float32Array
  readonly valleys: readonly ValleyLine[]
  readonly channels: readonly ChannelLine[]
  readonly clearance: Clearance
  readonly minCap: number
  readonly noises: Noises
}


export function createSampler(inp: SamplerInput): Sampler {
  const { raster, lakeLevel, clearance, noises } = inp
  const wet = inp.lakeWet
  const { ox, oz, nx, nz, ch } = raster
  const INV_CELL = 1 / CELL
  const maxGx = nx - 1.000001
  const maxGz = nz - 1.000001
  const maxBx = nx - 2.000001
  const maxBz = nz - 2.000001
  const rowStride = nx * STRIDE
  const hill = noises.hill
  const ridge = noises.ridge
  const coverNoise = noises.cover
  const capSkip = inp.minCap - KNEE

  // Valleys: [ax, az, dx, dz, invL2, bedA, dBed, flatA, dFlat, reachA, dReach]
  let vCount = 0
  for (const v of inp.valleys) vCount += Math.max(0, v.xs.length - 1)
  const V = new Float64Array(vCount * VS)
  let w = 0
  for (const v of inp.valleys) {
    for (let i = 0; i < v.xs.length - 1; i++) {
      const dx = v.xs[i + 1]! - v.xs[i]!
      const dz = v.zs[i + 1]! - v.zs[i]!
      const l2 = dx * dx + dz * dz
      V.set([v.xs[i]!, v.zs[i]!, dx, dz, l2 > 0 ? 1 / l2 : 0, v.bed[i]!, v.bed[i + 1]! - v.bed[i]!, v.flat[i]!, v.flat[i + 1]! - v.flat[i]!, v.reach[i]!, v.reach[i + 1]! - v.reach[i]!], w)
      w += VS
    }
  }
  const vg = buildGrid(raster, VALLEY_CELL, V, VS, vCount, (b) => Math.max(V[b + 9]!, V[b + 9]! + V[b + 10]!))

  // Channels: [ax, az, dx, dz, invL2, halfWidthA, dHalfWidth, bedA, dBed]
  let cCount = 0
  for (const c of inp.channels) cCount += Math.max(0, c.xs.length - 1)
  const C = new Float64Array(cCount * CS)
  w = 0
  for (const c of inp.channels) {
    for (let i = 0; i < c.xs.length - 1; i++) {
      const dx = c.xs[i + 1]! - c.xs[i]!
      const dz = c.zs[i + 1]! - c.zs[i]!
      const l2 = dx * dx + dz * dz
      C.set([c.xs[i]!, c.zs[i]!, dx, dz, l2 > 0 ? 1 / l2 : 0, c.width[i]! / 2, (c.width[i + 1]! - c.width[i]!) / 2, c.bed[i]!, c.bed[i + 1]! - c.bed[i]!], w)
      w += CS
    }
  }
  const cg = buildGrid(raster, CHANNEL_CELL, C, CS, cCount, (b) => Math.max(C[b + 5]!, C[b + 5]! + C[b + 6]!) + BANK + 1)

  const cityX = new Float64Array(MAX_CITIES)
  const cityZ = new Float64Array(MAX_CITIES)
  const cityR = new Float64Array(MAX_CITIES)
  const cityLevel = new Float64Array(MAX_CITIES)
  let cityCount = 0


  const S = new Float64Array(10)


  const evalPoint = (x: number, z: number): number => {
    let gx = (x - ox) * INV_CELL
    let gz = (z - oz) * INV_CELL
    gx = gx < 0 ? 0 : gx > maxGx ? maxGx : gx
    gz = gz < 0 ? 0 : gz > maxGz ? maxGz : gz
    const i = gx | 0
    const j = gz | 0
    const fx = gx - i
    const fz = gz - j
    const k00 = (j * nx + i) * STRIDE
    const k10 = k00 + STRIDE
    const k01 = k00 + rowStride
    const k11 = k01 + STRIDE
    const w11 = fx * fz
    const w10 = fx - w11
    const w01 = fz - w11
    const w00 = 1 - fx - fz + w11
    // Macro height: quadratic B-spline over 3×3 nodes. Bilinear would be C⁰ and its creases show up as
    // stripes in any shading of a long slope.
    const bx = gx < 1 ? 1 : gx > maxBx ? maxBx : gx
    const bz = gz < 1 ? 1 : gz > maxBz ? maxBz : gz
    const ci = (bx + 0.5) | 0
    const cj = (bz + 0.5) | 0
    const tx = bx - ci + 0.5
    const tz = bz - cj + 0.5
    const ax0 = 0.5 * (1 - tx) * (1 - tx)
    const ax2 = 0.5 * tx * tx
    const ax1 = 1 - ax0 - ax2
    const az0 = 0.5 * (1 - tz) * (1 - tz)
    const az2 = 0.5 * tz * tz
    const az1 = 1 - az0 - az2
    let q = ((cj - 1) * nx + ci - 1) * STRIDE
    let macro = az0 * (ax0 * ch[q]! + ax1 * ch[q + STRIDE]! + ax2 * ch[q + 2 * STRIDE]!)
    q += rowStride
    macro += az1 * (ax0 * ch[q]! + ax1 * ch[q + STRIDE]! + ax2 * ch[q + 2 * STRIDE]!)
    q += rowStride
    macro += az2 * (ax0 * ch[q]! + ax1 * ch[q + STRIDE]! + ax2 * ch[q + 2 * STRIDE]!)
    const hillA = ch[k00 + HILL]! * w00 + ch[k10 + HILL]! * w10 + ch[k01 + HILL]! * w01 + ch[k11 + HILL]! * w11
    const ridgeA = ch[k00 + RIDGE]! * w00 + ch[k10 + RIDGE]! * w10 + ch[k01 + RIDGE]! * w01 + ch[k11 + RIDGE]! * w11
    S[S_FOREST] = ch[k00 + FOREST]! * w00 + ch[k10 + FOREST]! * w10 + ch[k01 + FOREST]! * w01 + ch[k11 + FOREST]! * w11
    S[S_FARM] = ch[k00 + FARM]! * w00 + ch[k10 + FARM]! * w10 + ch[k01 + FARM]! * w01 + ch[k11 + FARM]! * w11
    S[S_MACRO] = macro
    S[S_RIDGE_AMP] = ridgeA

    const hn = hill.fbm(x, z, HILL_WAVELENGTH, HILL_OCTAVES)
    S[S_HN] = hn
    let h = macro + hillA * hn
    let rv = 0
    if (ridgeA > 0.5) {
      rv = ridge.ridged(x, z, RIDGE_WAVELENGTH, RIDGE_OCTAVES)
      h += ridgeA * rv
    }
    S[S_RIDGED] = rv

    // Cities sit on flattened ground (never over the sea).
    S[S_CITY] = -1
    S[S_CITY_D] = 9
    if (cityCount > 0 && macro > 0) {
      const land = macro >= 15 ? 1 : macro / 15
      for (let c = 0; c < cityCount; c++) {
        const dx = x - cityX[c]!
        const dz = z - cityZ[c]!
        const d2 = dx * dx + dz * dz
        const R = cityR[c]!
        if (d2 >= 2.25 * R * R) continue
        const q = Math.sqrt(d2) / R
        let t = (q - 0.6) / 0.9
        t = t < 0 ? 0 : t > 1 ? 1 : t
        const k = 0.85 * (1 - t * t * (3 - 2 * t)) * land
        h += (cityLevel[c]! - h) * k
        if (q < S[S_CITY_D]!) {
          S[S_CITY_D] = q
          S[S_CITY] = c
        }
      }
    }

    // River valleys: flat floodplain at the bed, smooth sides back to the land. Overlaps take the lowest.
    // (Rivers are incised enough that the land beside them is above the bed; see rivers.ts.)
    const vi = ((x - ox) * vg.inv) | 0
    const vj = ((z - oz) * vg.inv) | 0
    if (x >= ox && z >= oz && vi < vg.nx && vj < vg.nz) {
      const cell = vj * vg.nx + vi
      const end = vg.off[cell + 1]!
      let best = Infinity
      for (let k = vg.off[cell]!; k < end; k++) {
        const b = vg.items[k]! * VS
        const px = x - V[b]!
        const pz = z - V[b + 1]!
        const ddx = V[b + 2]!
        const ddz = V[b + 3]!
        let t = (px * ddx + pz * ddz) * V[b + 4]!
        t = t < 0 ? 0 : t > 1 ? 1 : t
        const ex = px - ddx * t
        const ez = pz - ddz * t
        const d2 = ex * ex + ez * ez
        const reach = V[b + 9]! + V[b + 10]! * t
        if (d2 >= reach * reach) continue
        const flat = V[b + 7]! + V[b + 8]! * t
        const bed = V[b + 5]! + V[b + 6]! * t
        let u = (Math.sqrt(d2) - flat) / (reach - flat)
        u = u < 0 ? 0 : u
        const dh = h - bed
        // Lowering only: a min over valleys stays continuous where valleys overlap or end.
        const c = dh > 0 ? bed + dh * u * u * (3 - 2 * u) : h
        if (c < best) best = c
      }
      if (best < Infinity) h = best
    }

    // River channels: the water surface is the channel's own bed, which never rises downstream. Where another,
    // deeper valley (or a hollow of the hill noise) took the land under it, the channel and its banks are
    // raised back to it. A max over channels with this steep fall-off stays continuous.
    S[S_RIVER] = 0
    const ri = ((x - ox) * cg.inv) | 0
    const rj = ((z - oz) * cg.inv) | 0
    if (x >= ox && z >= oz && ri < cg.nx && rj < cg.nz) {
      const cell = rj * cg.nx + ri
      const end = cg.off[cell + 1]!
      for (let k = cg.off[cell]!; k < end; k++) {
        const b = cg.items[k]! * CS
        const px = x - C[b]!
        const pz = z - C[b + 1]!
        const ddx = C[b + 2]!
        const ddz = C[b + 3]!
        let t = (px * ddx + pz * ddz) * C[b + 4]!
        t = t < 0 ? 0 : t > 1 ? 1 : t
        const ex = px - ddx * t
        const ez = pz - ddz * t
        const d2 = ex * ex + ez * ez
        const hw = C[b + 5]! + C[b + 6]! * t
        const outer = hw + BANK
        if (d2 >= outer * outer) continue
        const d = Math.sqrt(d2)
        if (d < hw) S[S_RIVER] = 1
        let u = (d - hw) / BANK
        u = u < 0 ? 0 : u
        const floor = C[b + 7]! + C[b + 8]! * t - LEVEE_DROP * u * u * (3 - 2 * u)
        if (floor > h) h = floor
      }
    }

    // Lakes: flat water where the land dips under the lake level (smooth shoreline from the interpolated
    // depth field).
    S[S_LAKE] = 0
    const nc = cj * nx + ci
    if (lakeLevel[nc]! > NO_LAKE) {
      // Same B-spline stencil as the macro height, so the shore follows the land; plus a small shore noise.
      // Two lakes can share a stencil (a chain down a valley): the level is the one of the wettest node.
      let lev = NO_LAKE
      let wettest = -Infinity
      let depth = 0
      let r = nc - nx - 1
      for (let jj = 0; jj < 3; jj++, r += nx) {
        const wz = jj === 0 ? az0 : jj === 1 ? az1 : az2
        for (let ii = 0; ii < 3; ii++) {
          const wv = wet[r + ii]!
          if (wv > wettest && lakeLevel[r + ii]! > NO_LAKE) {
            wettest = wv
            lev = lakeLevel[r + ii]!
          }
          depth += wz * (ii === 0 ? ax0 : ii === 1 ? ax1 : ax2) * wv
        }
      }
      const basin = depth
      depth += SHORE_NOISE * coverNoise.fbm(x, z, SHORE_WAVELENGTH, 3) - 0.5 * hillA * hn
      // Water only fills what is below its level (a bank or a ridge above it stays dry: islands), and only
      // down to its basin floor: a deeper valley carved by another river next to the lake is not lake.
      if (depth > 0 && h < lev && lev - h < basin + 20 + 0.5 * hillA) {
        h = lev
        S[S_LAKE] = 1
      }
    }

    if (h > capSkip) {
      const cap = clearance.capAt(x, z)
      const u = h - (cap - KNEE)
      if (u > 0) h = cap - KNEE * Math.exp(-u / KNEE)
    }
    const ug = h - (MAX_GROUND - GLOBAL_KNEE)
    if (ug > 0) h = MAX_GROUND - GLOBAL_KNEE * Math.exp(-ug / GLOBAL_KNEE)
    return h
  }

  const coverAt = (x: number, z: number): TerrainCover => {
    const h = evalPoint(x, z)
    if (h <= 0) return 'sea'
    if (S[S_LAKE]! > 0) return 'lake'
    if (S[S_RIVER]! > 0) return 'river'
    const cn = coverNoise.fbm(x, z, COVER_WAVELENGTH, 2)
    if (S[S_CITY]! >= 0 && S[S_CITY_D]! < 1 + 0.18 * cn) return 'city'
    if (h < 6 && S[S_MACRO]! < 25) return 'beach'
    const alt = h + 140 * cn
    if (alt > SNOW_LINE) return 'snow'
    if (alt > ROCK_LINE || (S[S_RIDGED]! > 0.55 && alt > 1450)) return 'rock'
    if (alt > TREE_LINE) return 'grass'
    const forest = S[S_FOREST]! + 0.5 * cn + (S[S_RIDGE_AMP]! > 150 ? 0.15 : 0)
    if (forest > 0.75) return 'forest'
    // Farmland and meadow, with woodlots: thresholded noise (multi-octave, so blobs of every size from a few
    // hundred metres to a few km with organic outlines). A cell grid reads as tiles from cruise altitude.
    const hn = S[S_HN]!
    const wx = x + WARP * hn
    const wz = z - WARP * hn
    if (coverNoise.fbm(wx - 37_000, wz + 11_000, WOOD_WAVELENGTH, 2) > 0.34 - 0.25 * S[S_FOREST]!) return 'forest'
    // fBm is roughly normal with σ ≈ 0.3: with farm 0.9 about 70 % of the open land is fields, 0.5 half of it.
    if (h < FIELDS_MAX && coverNoise.fbm(wx + 23_000, wz - 52_000, FIELD_WAVELENGTH, 3) < 0.4 * (S[S_FARM]! - 0.5)) return 'fields'
    return 'grass'
  }

  const bilinear = (x: number, z: number, chan: number): number => {
    let gx = (x - ox) * INV_CELL
    let gz = (z - oz) * INV_CELL
    gx = gx < 0 ? 0 : gx > maxGx ? maxGx : gx
    gz = gz < 0 ? 0 : gz > maxGz ? maxGz : gz
    const i = gx | 0
    const j = gz | 0
    const fx = gx - i
    const fz = gz - j
    const k = (j * nx + i) * STRIDE + chan
    return (ch[k]! * (1 - fx) + ch[k + STRIDE]! * fx) * (1 - fz) + (ch[k + rowStride]! * (1 - fx) + ch[k + rowStride + STRIDE]! * fx) * fz
  }

  return {
    heightAt: evalPoint,
    coverAt,
    macroAt: (x, z) => bilinear(x, z, MACRO),
    ridgeAmpAt: (x, z) => bilinear(x, z, RIDGE),
    inLake(x, z) {
      evalPoint(x, z)
      return S[S_LAKE]! > 0
    },
    setCities(cities) {
      cityCount = Math.min(cities.length, MAX_CITIES)
      for (let c = 0; c < cityCount; c++) {
        const city = cities[c]!
        cityX[c] = city.x
        cityZ[c] = city.z
        cityR[c] = city.radius
        cityLevel[c] = city.level
      }
    },
  }
}
