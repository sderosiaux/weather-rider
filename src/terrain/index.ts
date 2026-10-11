// Procedural land under a route: a journey of landscapes (coasts, farmland, forests and lakes, a mountain range
// crossed through a pass, a big river valley, towns), deterministic in TerrainParams.
//
// Pipeline (generation only, never per frame):
//   plan (journey, from the seed) → bake (1 km macro raster out to the horizon) → hydro (pit fill, drainage,
//   lakes, river network) → rivers (smooth valleys + meandering channels) → sampler (hot path) → cities.
import { v3 } from '../core/math'
import { createRng, hashInts } from '../core/rng'
import type { CreateTerrain, Terrain, TerrainCity, TerrainParams, TerrainRiver } from '../core/types'
import { bakeRaster, CELL, HILL, MACRO, RIDGE, STRIDE, type Raster } from './bake'
import { CORRIDOR_ALLOWANCE, CORRIDOR_CLEARANCE, createClearance, GATE_CLEARANCE, MAX_GROUND, START_CLEARANCE } from './clearance'
import { lakeFields, levelBasins, routeWater } from './hydro'
import { createNoise2 } from './noise'
import { placeCities } from './places'
import { planJourney } from './plan'
import { shapeRivers, type ChannelLine } from './rivers'
import { createSampler } from './sampler'

const SALT = 0x7e77a1

/** A river piece ends where the width has changed by this factor (the contract has one width per river). */
const WIDTH_STEP = 1.3
/** Peaks between the 100 m samples of highestGround can stand this much higher (ridged noise slopes). */
const PEAK_MARGIN = 40

/** Highest ground in the bounds: branch-and-bound over raster cells (upper bound from the baked amplitudes). */
function highestGround(r: Raster, p: TerrainParams, lakeLevel: Float32Array, cities: readonly { x: number; z: number; radius: number; level: number }[], heightAt: (x: number, z: number) => number): number {
  const { ox, oz, nx, ch } = r
  const i0 = Math.max(0, Math.floor((p.boundsMin.x - ox) / CELL))
  const i1 = Math.min(nx - 2, Math.ceil((p.boundsMax.x - ox) / CELL))
  const j0 = Math.max(0, Math.floor((p.boundsMin.z - oz) / CELL))
  const j1 = Math.min(r.nz - 2, Math.ceil((p.boundsMax.z - oz) / CELL))
  const cells: { i: number; j: number; ub: number }[] = []
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      let ub = -Infinity
      // The macro B-spline reads a 3×3 stencil: bound over the 4×4 nodes around the cell.
      for (let b = Math.max(0, j - 1); b <= Math.min(r.nz - 1, j + 2); b++) {
        for (let a = Math.max(0, i - 1); a <= Math.min(nx - 1, i + 2); a++) {
          const k = (b * nx + a) * STRIDE
          // Lake water stands at its level, above the drowned land under it.
          ub = Math.max(ub, ch[k + MACRO]! + Math.abs(ch[k + HILL]!) + ch[k + RIDGE]!, lakeLevel[b * nx + a]!)
        }
      }
      // Cities are flattened toward their level.
      const cx = ox + (i + 0.5) * CELL
      const cz = oz + (j + 0.5) * CELL
      for (const c of cities) if (Math.hypot(cx - c.x, cz - c.z) < 1.5 * c.radius + CELL) ub = Math.max(ub, c.level)
      cells.push({ i, j, ub })
    }
  }
  cells.sort((a, b) => b.ub - a.ub)
  const SUB = 10
  let best = -Infinity
  for (const c of cells) {
    if (c.ub <= best) break
    for (let b = 0; b <= SUB; b++) {
      for (let a = 0; a <= SUB; a++) {
        // Clamped into the bounds, so the strips along the edges are sampled too.
        const x = Math.min(p.boundsMax.x, Math.max(p.boundsMin.x, ox + (c.i + a / SUB) * CELL))
        const z = Math.min(p.boundsMax.z, Math.max(p.boundsMin.z, oz + (c.j + b / SUB) * CELL))
        best = Math.max(best, heightAt(x, z))
      }
    }
  }
  return Math.min(best + PEAK_MARGIN, MAX_GROUND)
}

/**
 * Contract rivers: the channels cut into pieces of roughly constant width, and interrupted where they cross a lake
 * (a piece then ends on the inflow shore and the next one starts at the outflow).
 */
function riverPieces(channels: readonly ChannelLine[], heightAt: (x: number, z: number) => number, inLake: (x: number, z: number) => boolean): TerrainRiver[] {
  const out: TerrainRiver[] = []
  channels.forEach((c, k) => {
    let piece = 0
    let cur: number[] = []
    const flush = (): void => {
      if (cur.length >= 2) {
        const width = cur.reduce((sum, q) => sum + c.width[q]!, 0) / cur.length
        out.push({ id: `river-${k}-${piece++}`, path: cur.map((q) => v3(c.xs[q]!, heightAt(c.xs[q]!, c.zs[q]!), c.zs[q]!)), width: Math.round(width) })
      }
      cur = []
    }
    for (let i = 1; i < c.xs.length; i++) {
      // A segment is lake water only if both ends and its middle are.
      const wet = inLake(c.xs[i - 1]!, c.zs[i - 1]!) && inLake(c.xs[i]!, c.zs[i]!) && inLake((c.xs[i - 1]! + c.xs[i]!) / 2, (c.zs[i - 1]! + c.zs[i]!) / 2)
      if (wet) {
        flush()
        continue
      }
      if (cur.length === 0) cur.push(i - 1)
      else if (c.width[i - 1]! >= c.width[cur[0]!]! * WIDTH_STEP) {
        flush()
        cur.push(i - 1)
      }
      cur.push(i)
    }
    flush()
  })
  return out
}

export const createTerrain: CreateTerrain = (params: TerrainParams): Terrain => {
  const seed = hashInts(params.seed, SALT)
  const rng = createRng(seed)
  const noises = {
    hill: createNoise2(hashInts(seed, 1)),
    ridge: createNoise2(hashInts(seed, 2)),
    macro: createNoise2(hashInts(seed, 3)),
    cover: createNoise2(hashInts(seed, 4)),
  }
  const plan = planJourney(params, rng)
  const clearance = createClearance(params)
  const raster = levelBasins(bakeRaster(params, plan, noises, clearance), noises.macro)
  const hydro = routeWater(raster)
  const lakes = lakeFields(raster, hydro)
  const shaped = shapeRivers(hydro, lakes, raster, rng)
  const minCap = Math.min(
    params.startAlt - START_CLEARANCE,
    params.gateMinAlt - GATE_CLEARANCE,
    Math.min(params.startAlt, params.gateMinAlt + CORRIDOR_ALLOWANCE) - CORRIDOR_CLEARANCE,
  ) - 200
  const sampler = createSampler({
    raster,
    lakeLevel: lakes.level,
    lakeWet: lakes.wet,
    valleys: shaped.valleys,
    channels: shaped.channels,
    clearance,
    minCap,
    noises,
  })

  const placed = placeCities({
    plan,
    raster,
    channels: shaped.channels,
    departureName: params.departureName,
    arrivalName: params.arrivalName,
    macroAt: sampler.macroAt,
    heightAt: sampler.heightAt,
    ridgeAmpAt: sampler.ridgeAmpAt,
    inLake: sampler.inLake,
    rng,
  })
  // City ground level = the land there before flattening (valley floor for river towns).
  const discs = placed.map((c) => ({ x: c.x, z: c.z, radius: c.radius, level: Math.max(4, sampler.heightAt(c.x, c.z)) }))
  sampler.setCities(discs)
  const cities: TerrainCity[] = placed.map((c, i) => ({
    id: `city-${i}`,
    name: c.name,
    center: v3(c.x, sampler.heightAt(c.x, c.z), c.z),
    radius: c.radius,
    role: c.role,
  }))

  return {
    seed: params.seed,
    boundsMin: params.boundsMin,
    boundsMax: params.boundsMax,
    heightAt: sampler.heightAt,
    coverAt: sampler.coverAt,
    cities,
    rivers: riverPieces(shaped.channels, sampler.heightAt, sampler.inLake),
    maxHeight: highestGround(raster, params, lakes.level, discs, sampler.heightAt),
  }
}
