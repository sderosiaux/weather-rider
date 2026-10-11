// Macro raster: everything with a wavelength above ~2 km, baked once on a 1 km grid out to the far horizon.
// The query path only interpolates it and adds hill / ridge noise on top, so heightAt cost does not depend on
// how many ranges, seas or lakes the journey has.
import { lerp, smoothstep } from '../core/math'
import type { TerrainParams } from '../core/types'
import type { Clearance } from './clearance'
import type { Noise2 } from './noise'
import { alongOf, BIOMES, lateralOf, type JourneyPlan, type Knot, type Polyline } from './plan'

export const CELL = 1000
/** Land and its fade to sea extend this far past the playable bounds. */
export const MARGIN = 150_000

/** Interleaved channels per raster node. */
export const STRIDE = 5
export const MACRO = 0
/** Amplitude (m) of the query-time hill noise. */
export const HILL = 1
/** Amplitude (m) of the query-time ridged noise (mountains). */
export const RIDGE = 2
export const FOREST = 3
export const FARM = 4

/** Upper bound of |hill noise| and of ridged noise, used to keep baked amplitudes under the clearance ceilings. */
const BAKE_MARGIN = 60
/** Reference height under which the relief is never squashed by the clearance ceilings (m). */
const PASS_FLOOR = 250
/** Extra, noise-shaped lowering around the corridor (m). */
const PASS_WIDEN = 900

export interface Raster {
  readonly ox: number
  readonly oz: number
  readonly nx: number
  readonly nz: number
  readonly ch: Float32Array
}

export interface Noises {
  readonly hill: Noise2
  readonly ridge: Noise2
  readonly macro: Noise2
  readonly cover: Noise2
}

const pd = { d: 0, t: 0 }
/** Distance to a polyline, and the fractional point index of the nearest point (into the module scratch `pd`). */
function polyDist(line: Polyline, x: number, z: number): void {
  let best = Infinity
  let bestT = 0
  const n = line.xs.length
  for (let i = 0; i < n - 1; i++) {
    const ax = line.xs[i]!
    const az = line.zs[i]!
    const dx = line.xs[i + 1]! - ax
    const dz = line.zs[i + 1]! - az
    const l2 = dx * dx + dz * dz
    let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const ex = x - ax - dx * t
    const ez = z - az - dz * t
    const d2 = ex * ex + ez * ez
    if (d2 < best) {
      best = d2
      bestT = i + t
    }
  }
  pd.d = Math.sqrt(best)
  pd.t = bestT
}

function segDist(ax: number, az: number, bx: number, bz: number, x: number, z: number): number {
  const dx = bx - ax
  const dz = bz - az
  const l2 = dx * dx + dz * dz
  let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(x - ax - dx * t, z - az - dz * t)
}

/** Biome parameters blended along the (warped) route coordinate: pure cores, transitions over half the spacing. */
const blend = { base: 0, relief: 0, hill: 0, forest: 0, farm: 0 }
function blendAt(knots: readonly Knot[], s: number): void {
  let i = 0
  while (i < knots.length - 2 && knots[i + 1]!.s < s) i++
  const a = knots[i]!
  const b = knots[i + 1] ?? a
  const span = b.s - a.s
  const t = span > 0 ? smoothstep(0.25, 0.75, (s - a.s) / span) : 0
  const pa = BIOMES[a.biome]
  const pb = BIOMES[b.biome]
  blend.base = lerp(pa.base, pb.base, t)
  blend.relief = lerp(pa.relief, pb.relief, t)
  blend.hill = lerp(pa.hill, pb.hill, t)
  blend.forest = lerp(pa.forest, pb.forest, t)
  blend.farm = lerp(pa.farm, pb.farm, t)
}

export function bakeRaster(p: TerrainParams, plan: JourneyPlan, noises: Noises, clearance: Clearance): Raster {
  const ox = p.boundsMin.x - MARGIN
  const oz = p.boundsMin.z - MARGIN
  const nx = Math.ceil((p.boundsMax.x - p.boundsMin.x + 2 * MARGIN) / CELL) + 1
  const nz = Math.ceil((p.boundsMax.z - p.boundsMin.z + 2 * MARGIN) / CELL) + 1
  const ch = new Float32Array(nx * nz * STRIDE)
  const f = plan.frame
  const nm = noises.macro
  const sx = f.sx
  const sz = f.sz
  const ex = f.sx + f.dirX * f.length
  const ez = f.sz + f.dirZ * f.length

  // Coarse bounding boxes so far-away features cost nothing.
  const rangeBoxes = plan.ranges.map((r) => {
    const pad = r.halfWidth * 4
    return [Math.min(...r.xs) - pad, Math.max(...r.xs) + pad, Math.min(...r.zs) - pad, Math.max(...r.zs) + pad] as const
  })

  for (let j = 0; j < nz; j++) {
    const z = oz + j * CELL
    for (let i = 0; i < nx; i++) {
      const x = ox + i * CELL
      // Sea: the continent edge far out, plus the journey's coasts and straits.
      const dSeg = segDist(sx, sz, ex, ez, x, z)
      const edge = dSeg + 24_000 * nm.fbm(x, z, 60_000, 3)
      const landEdgeT = smoothstep(plan.continentRadius - 12_000, plan.continentRadius + 12_000, edge)
      let seaT = landEdgeT
      let dOcean = plan.continentRadius - edge
      if (plan.seas.length > 0) {
        const warp = 5500 * nm.fbm(x + 9100, z - 3300, 22_000, 4)
        for (const c of plan.seas) {
          const d = segDist(c.ax, c.az, c.bx, c.bz, x, z) + warp - c.halfWidth
          const t = smoothstep(4500, -4500, d)
          if (t > seaT) seaT = t
          if (d < dOcean) dOcean = d
        }
      }
      if (dOcean < 0) dOcean = 0

      // Biomes along the sheared, warped route coordinate.
      const s = alongOf(f, x, z)
      const n = lateralOf(f, x, z)
      blendAt(plan.knots, s + n * plan.shear + 18_000 * nm.fbm(x - 5000, z + 7000, 38_000, 3) + 32_000 * nm.fbm(x + 40_000, z - 25_000, 110_000, 2))
      // Land rises inland, so water finds the coasts.
      const tilt = 0.0035 * Math.min(dOcean, 60_000)
      let macro = blend.base + blend.relief * nm.fbm(x + 3100, z + 1700, 20_000, 3) + tilt
      let hill = blend.hill * (0.75 + 0.35 * nm.fbm(x - 2700, z - 8800, 30_000, 2))
      const coverVar = nm.fbm(x + 13_000, z - 4100, 25_000, 2)
      let forest = blend.forest + 0.32 * coverVar
      let farm = blend.farm - 0.25 * coverVar
      let ridge = 0

      for (let r = 0; r < plan.ranges.length; r++) {
        const box = rangeBoxes[r]!
        if (x < box[0] || x > box[1] || z < box[2] || z > box[3]) continue
        const rg = plan.ranges[r]!
        polyDist(rg, x, z)
        const last = rg.xs.length - 1
        const k = Math.min(Math.floor(pd.t), last - 1)
        const mod = lerp(rg.mod[k]!, rg.mod[k + 1]!, pd.t - k)
        const taper = smoothstep(0, 2.5, pd.t) * smoothstep(last, last - 2.5, pd.t)
        const u = pd.d / rg.halfWidth
        const w = mod * taper
        macro += rg.massif * w * Math.exp(-1.4 * u * u)
        const rr = rg.ridge * w * Math.exp(-0.65 * u * u)
        if (rr > ridge) ridge = rr
        hill += 70 * w * Math.exp(-0.5 * u * u)
        forest += 0.25 * w * Math.exp(-0.5 * u * u)
        farm -= 0.4 * w * Math.exp(-0.5 * u * u)
      }

      for (const tr of plan.troughs) {
        polyDist(tr, x, z)
        const u = pd.d / tr.halfWidth
        if (u > 3) continue
        const floor = lerp(tr.floorStart, tr.floorEnd, pd.t / (tr.xs.length - 1))
        const m = Math.exp(-u * u)
        if (macro > floor) macro -= (macro - floor) * 0.92 * m
        hill *= 1 - 0.45 * m
        ridge *= 1 - 0.8 * m
        farm += 0.25 * m
      }

      for (const b of plan.bowls) {
        const dx = x - b.x
        const dz = z - b.z
        if (dx > 9000 || dx < -9000 || dz > 9000 || dz < -9000) continue
        const u = (dx * b.cos + dz * b.sin) / b.r1
        const v = (-dx * b.sin + dz * b.cos) / b.r2
        const q = u * u + v * v
        if (q < 9) {
          const m = Math.exp(-1.6 * q)
          macro -= b.depth * m
          hill *= 1 - 0.6 * m
        }
      }

      // Into the sea: shelf near the coast, deep far out. Mountains plunge (fjords), hills soften.
      const seaFloor = -45 - 220 * landEdgeT
      macro = lerp(macro, seaFloor, seaT)
      hill = lerp(hill, 22, seaT)
      ridge *= 1 - 0.75 * seaT

      // Keep the bake under the playability ceilings so the query-time clamp almost never has to bite.
      // The pass is widened irregularly into the flanks so it does not read as a straight band.
      const cap = clearance.capAt(x, z) - BAKE_MARGIN - PASS_WIDEN * Math.max(0, nm.fbm(x + 21_000, z - 17_000, 9000, 2)) * Math.exp(-((dSeg / 9000) ** 2))
      // Squash the relief above a low reference uniformly: a pass is a lower stretch of the same range (ridges
      // and valleys still read), not a smoothed-out band.
      const ub = macro + hill + ridge
      if (ub > cap) {
        const floor = Math.min(macro, PASS_FLOOR, cap)
        const k = Math.max(0, (cap - floor) / (ub - floor))
        macro = floor + (macro - floor) * k
        hill *= k
        ridge *= k
      }

      const k = (j * nx + i) * STRIDE
      ch[k + MACRO] = macro
      ch[k + HILL] = hill
      ch[k + RIDGE] = ridge
      ch[k + FOREST] = forest
      ch[k + FARM] = farm
    }
  }
  return { ox, oz, nx, nz, ch }
}
