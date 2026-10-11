// Where the water goes, on the macro raster: priority-flood fills every pit (filled pits deep enough become lakes),
// each land node drains to one neighbour, and nodes draining a big enough catchment carry a river. Rivers therefore
// flow downhill by construction and always end in the sea, a lake on their way, or a bigger river.
import { HILL, MACRO, RIDGE, STRIDE, type Raster } from './bake'
import type { Noise2 } from './noise'

/** Catchment (km² ≈ raster nodes, rain-weighted) above which a node carries a river. */
export const RIVER_CATCHMENT = 110
/** Fill depth (m) above which a node is lake rather than marsh; lakes need at least LAKE_MIN_NODES nodes. */
const LAKE_DEPTH = 2.5
const LAKE_MIN_DEPTH = 6
const LAKE_MIN_NODES = 2
/** Bigger filled basins are not lakes but plains: an old lake bed, silted up to its spill level. */
const LAKE_MAX_NODES = 22
/** Relief (m) left on those plains so rivers wander across them instead of running dead straight. */
const PLAIN_RELIEF = 1.5
/** Lake water may spread past its raster nodes over shore land lower than level + this, up to LAKE_BAND nodes. */
const LAKE_SHORE = 60
const LAKE_BAND = 4
/** No lake at this node. */
export const NO_LAKE = -1e9
/** Depth (m, negative) given to nodes away from any lake, so shorelines interpolate toward dry land. */
export const LAKE_DRY = 80
/** Minimum drop per step across filled flats, so every node has a strictly lower outlet. */
const EPS = 0.01

export interface Lake {
  readonly level: number
  readonly nodes: number
}

export interface RiverPath {
  /** Raster node indices, upstream first. The last one is a sea node, or a node of the parent river. */
  readonly nodes: readonly number[]
  readonly end: 'sea' | 'join' | 'edge'
  /** Index of the river this one flows into (end = 'join'), else -1. */
  readonly parent: number
}

export interface LakeFields {
  /** Lake surface per node (NO_LAKE away from lakes). */
  readonly level: Float32Array
  /** Water depth below that surface per node: > 0 is lake water, negative on the shore, -LAKE_DRY elsewhere. */
  readonly wet: Float32Array
}

export interface Hydro {
  /** Pit-filled surface (m): non-increasing along every drainage path. */
  readonly filled: Float32Array
  readonly receiver: Int32Array
  readonly acc: Float32Array
  readonly ocean: Uint8Array
  /** Lake index per node, -1 if not lake. */
  readonly lakeOf: Int32Array
  readonly lakes: readonly Lake[]
  readonly paths: readonly RiverPath[]
}

const DI = [1, -1, 0, 0, 1, 1, -1, -1]
const DJ = [0, 0, 1, -1, 1, -1, 1, -1]
const DL = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2]

interface Flood {
  readonly filled: Float32Array
  readonly receiver: Int32Array
  readonly ocean: Uint8Array
  /** Land nodes in flood order (non-decreasing filled level). */
  readonly order: Int32Array
}

function macroOf(r: Raster): Float32Array {
  const n = r.nx * r.nz
  const macro = new Float32Array(n)
  for (let c = 0; c < n; c++) macro[c] = r.ch[c * STRIDE + MACRO]!
  return macro
}

/** Priority-flood with ε drop (Barnes 2014), seeded from the sea and the raster edge. */
function flood(macro: Float32Array, nx: number, nz: number): Flood {
  const n = nx * nz
  const filled = new Float32Array(n)
  const receiver = new Int32Array(n).fill(-1)
  const ocean = new Uint8Array(n)
  const seen = new Uint8Array(n)
  const hk = new Float64Array(n)
  const hv = new Int32Array(n)
  let size = 0
  const push = (k: number, v: number): void => {
    let i = size++
    while (i > 0) {
      const p = (i - 1) >> 1
      if (hk[p]! <= k) break
      hk[i] = hk[p]!
      hv[i] = hv[p]!
      i = p
    }
    hk[i] = k
    hv[i] = v
  }
  const pop = (): number => {
    const top = hv[0]!
    const k = hk[--size]!
    const v = hv[size]!
    let i = 0
    for (;;) {
      let c = 2 * i + 1
      if (c >= size) break
      if (c + 1 < size && hk[c + 1]! < hk[c]!) c++
      if (hk[c]! >= k) break
      hk[i] = hk[c]!
      hv[i] = hv[c]!
      i = c
    }
    hk[i] = k
    hv[i] = v
    return top
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i
      if (macro[c]! <= 0) {
        ocean[c] = 1
        seen[c] = 1
        push(0, c)
      } else if (i === 0 || j === 0 || i === nx - 1 || j === nz - 1) {
        filled[c] = macro[c]!
        seen[c] = 1
        push(filled[c]!, c)
      }
    }
  }
  const order = new Int32Array(n)
  let count = 0
  while (size > 0) {
    const c = pop()
    if (!ocean[c]) order[count++] = c
    const ci = c % nx
    const cj = (c - ci) / nx
    const level = filled[c]!
    for (let k = 0; k < 8; k++) {
      const i = ci + DI[k]!
      const j = cj + DJ[k]!
      if (i < 0 || j < 0 || i >= nx || j >= nz) continue
      const nb = j * nx + i
      if (seen[nb]) continue
      seen[nb] = 1
      const f = Math.max(macro[nb]!, level + EPS * DL[k]!)
      filled[nb] = f
      receiver[nb] = c
      push(f, nb)
    }
  }
  return { filled, receiver, ocean, order: order.subarray(0, count) }
}

/** Connected filled pits (8-neighbour), each with its spill level and nodes. */
function pits(fl: Flood, macro: Float32Array, nx: number, nz: number): { level: number; deepest: number; nodes: number[] }[] {
  const { filled, ocean } = fl
  const out: { level: number; deepest: number; nodes: number[] }[] = []
  const mark = new Uint8Array(nx * nz)
  const stack: number[] = []
  for (let c = 0; c < nx * nz; c++) {
    if (mark[c] || ocean[c] || filled[c]! - macro[c]! < LAKE_DEPTH) continue
    const nodes: number[] = []
    stack.push(c)
    mark[c] = 1
    let level = 0
    let deepest = 0
    while (stack.length > 0) {
      const q = stack.pop()!
      nodes.push(q)
      if (filled[q]! > level) level = filled[q]!
      if (filled[q]! - macro[q]! > deepest) deepest = filled[q]! - macro[q]!
      const qi = q % nx
      const qj = (q - qi) / nx
      for (let k = 0; k < 8; k++) {
        const i = qi + DI[k]!
        const j = qj + DJ[k]!
        if (i < 0 || j < 0 || i >= nx || j >= nz) continue
        const nb = j * nx + i
        if (mark[nb] || ocean[nb] || filled[nb]! - macro[nb]! < LAKE_DEPTH) continue
        mark[nb] = 1
        stack.push(nb)
      }
    }
    out.push({ level, deepest, nodes })
  }
  return out
}

/**
 * Basins too big to be believable lakes become plains at their spill level (with a few metres of relief and
 * softer hills), so the user sees long green stretches, not an inland sea. Returns a new raster.
 */
export function levelBasins(r: Raster, noise: Noise2): Raster {
  const { nx, nz, ox, oz } = r
  const macro = macroOf(r)
  const fl = flood(macro, nx, nz)
  const ch = r.ch.slice()
  for (const p of pits(fl, macro, nx, nz)) {
    if (p.nodes.length <= LAKE_MAX_NODES) continue
    for (const c of p.nodes) {
      const ci = c % nx
      const cj = (c - ci) / nx
      const k = c * STRIDE
      ch[k + MACRO] = fl.filled[c]! - PLAIN_RELIEF + PLAIN_RELIEF * noise.fbm(ox + ci * 1000, oz + cj * 1000, 6000, 2)
      ch[k + HILL] = ch[k + HILL]! * 0.5
    }
  }
  return { ...r, ch }
}

export function routeWater(r: Raster): Hydro {
  const { nx, nz, ch } = r
  const n = nx * nz
  const macro = macroOf(r)
  const fl = flood(macro, nx, nz)
  const { filled, receiver, ocean, order } = fl

  // Catchment, upstream to downstream (reverse flood order). Mountains catch more rain.
  const acc = new Float32Array(n)
  for (let c = 0; c < n; c++) acc[c] = ocean[c] ? 0 : 1 + ch[c * STRIDE + RIDGE]! / 1000
  for (let k = order.length - 1; k >= 0; k--) {
    const c = order[k]!
    const rc = receiver[c]!
    if (rc >= 0 && !ocean[rc]) acc[rc] = acc[rc]! + acc[c]!
  }

  const lakeOf = new Int32Array(n).fill(-1)
  const lakes: Lake[] = []
  for (const p of pits(fl, macro, nx, nz)) {
    if (p.nodes.length < LAKE_MIN_NODES || p.deepest < LAKE_MIN_DEPTH) continue
    for (const q of p.nodes) lakeOf[q] = lakes.length
    lakes.push({ level: p.level, nodes: p.nodes.length })
  }

  // River network: each river node continues into its receiver; where several rivers meet, the biggest
  // catchment keeps going and the others end there as tributaries.
  const isRiver = (c: number): boolean => !ocean[c] && acc[c]! >= RIVER_CATCHMENT
  const mainDonor = new Int32Array(n).fill(-1)
  const hasDonor = new Uint8Array(n)
  for (let c = 0; c < n; c++) {
    if (!isRiver(c)) continue
    const rc = receiver[c]!
    if (rc < 0 || !isRiver(rc)) continue
    hasDonor[rc] = 1
    const md = mainDonor[rc]!
    if (md < 0 || acc[c]! > acc[md]!) mainDonor[rc] = c
  }
  const pathOf = new Int32Array(n).fill(-1)
  const raw: { nodes: number[]; end: RiverPath['end'] }[] = []
  for (let c = 0; c < n; c++) {
    if (!isRiver(c) || hasDonor[c]) continue
    const nodes = [c]
    let cur = c
    let end: RiverPath['end'] = 'edge'
    for (;;) {
      pathOf[cur] = raw.length
      const rc = receiver[cur]!
      if (rc < 0) break
      nodes.push(rc)
      if (ocean[rc]) {
        end = 'sea'
        break
      }
      if (mainDonor[rc] !== cur) {
        end = 'join'
        break
      }
      cur = rc
    }
    raw.push({ nodes, end })
  }
  const paths: RiverPath[] = raw.map((p) => ({ ...p, parent: p.end === 'join' ? pathOf[p.nodes[p.nodes.length - 1]!]! : -1 }))
  return { filled, receiver, acc, ocean, lakeOf, lakes, paths }
}

/**
 * Lake surface per raster node: the lake itself plus a shore band where the water line may wander; and the depth
 * of water below that surface (negative on the shore). Nodes past the outlet (lower than the lake, draining
 * away from it) carry the level but count as dry, so the shoreline closes smoothly there too.
 */
export function lakeFields(r: Raster, h: Hydro): LakeFields {
  const { nx, nz, ch } = r
  const level = new Float32Array(nx * nz).fill(NO_LAKE)
  const wet = new Float32Array(nx * nz).fill(-LAKE_DRY)
  let frontier: number[] = []
  for (let c = 0; c < nx * nz; c++) {
    const id = h.lakeOf[c]!
    if (id >= 0) {
      level[c] = h.lakes[id]!.level
      wet[c] = level[c]! - ch[c * STRIDE + MACRO]!
      frontier.push(c)
    }
  }
  for (let step = 0; step < LAKE_BAND; step++) {
    const next: number[] = []
    for (const c of frontier) {
      const ci = c % nx
      const cj = (c - ci) / nx
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const i = ci + di
          const j = cj + dj
          if (i < 0 || j < 0 || i >= nx || j >= nz) continue
          const nb = j * nx + i
          const m = ch[nb * STRIDE + MACRO]!
          if (level[nb]! > NO_LAKE || h.ocean[nb] || m > level[c]! + LAKE_SHORE) continue
          level[nb] = level[c]!
          // Below the level yet outside the lake: either the shallow rim (drains into it: water) or past the
          // outlet (drains away: dry).
          if (m < level[c]! && h.filled[nb]! < level[c]! - 0.5) continue
          wet[nb] = level[c]! - m
          next.push(nb)
        }
      }
    }
    frontier = next
  }
  return { level, wet }
}
