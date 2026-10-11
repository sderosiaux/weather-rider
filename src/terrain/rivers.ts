// Turns raster drainage paths into rivers that read from the air: smooth curves, meanders where the land is flat,
// a valley floor that drops monotonically from source to mouth, and tributaries that meet their parent exactly.
// Each river yields two polylines: a smooth valley axis (cheap to carve around) and the meandering water channel.
import { clamp, smoothstep } from '../core/math'
import { CELL, HILL, RIDGE, STRIDE, type Raster } from './bake'
import { NO_LAKE, RIVER_CATCHMENT, type Hydro, type LakeFields } from './hydro'

/** Attribute columns carried along a polyline. */
const X = 0
const Z = 1
const BED = 2
const W = 3
const RG = 4
const LK = 5
const HL = 6
/** Room (m) the course may move sideways before it gets near another river. */
const ROOM = 7

/** DP tolerances (m): the valley axis can be coarse, the channel must stay inside the floodplain margin. */
const VALLEY_TOL = 120
const CHANNEL_TOL = 15
/** Bed error (m) allowed by the simplifications. */
const VALLEY_BED_TOL = 2
/** How far (m) a river mouth runs on into the sea. */
const MOUTH_RUN = 900
/** Distance (m) over which a tributary cuts down to its parent's level. */
const GRADE_REACH = 2500
/** How far around (raster cells) a course looks for other rivers. */
const ROOM_CELLS = 3
/**
 * How far a river cuts below the macro surface, per metre of hill / ridge noise amplitude: enough that the hill
 * noise rarely dips below the water (the valley carve only lowers land).
 */
const INCISION_HILL = 0.65
const INCISION_RIDGE = 0.06
/** Peak sideways wander of a river course (m). */
const WANDER = 520

export interface ValleyLine {
  readonly xs: number[]
  readonly zs: number[]
  readonly bed: number[]
  /** Flat floodplain half-width (m). */
  readonly flat: number[]
  /** Valley half-width (m): beyond it the land is untouched. */
  readonly reach: number[]
}

export interface ChannelLine {
  readonly xs: number[]
  readonly zs: number[]
  readonly bed: number[]
  readonly width: number[]
}

export interface ShapedRivers {
  readonly valleys: readonly ValleyLine[]
  readonly channels: readonly ChannelLine[]
}

type Rows = number[][]

const widthOf = (acc: number): number => Math.min(500, 100 * Math.pow(acc / RIVER_CATCHMENT, 0.45))

function chaikin(rows: Rows): Rows {
  if (rows.length < 3) return rows
  const out: Rows = [rows[0]!]
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i]!
    const b = rows[i + 1]!
    out.push(a.map((v, k) => 0.75 * v + 0.25 * b[k]!))
    out.push(a.map((v, k) => 0.25 * v + 0.75 * b[k]!))
  }
  out.push(rows[rows.length - 1]!)
  return out
}

/**
 * Douglas–Peucker on (x, z), endpoints kept. A node also stays if dropping it would misstate the bed by more than
 * `bedTol` (a river drops fast below a lake or in a gorge: a long straight segment must not average that out).
 */
function simplify(rows: Rows, tol: number, bedTol = Infinity): Rows {
  if (rows.length < 3) return rows
  const keep = new Uint8Array(rows.length)
  keep[0] = 1
  keep[rows.length - 1] = 1
  const stack: [number, number][] = [[0, rows.length - 1]]
  while (stack.length > 0) {
    const [a, b] = stack.pop()!
    const ra = rows[a]!
    const rb = rows[b]!
    const dx = rb[X]! - ra[X]!
    const dz = rb[Z]! - ra[Z]!
    const l2 = dx * dx + dz * dz
    let worst = 0
    let wi = -1
    for (let i = a + 1; i < b; i++) {
      const r = rows[i]!
      let t = l2 > 0 ? ((r[X]! - ra[X]!) * dx + (r[Z]! - ra[Z]!) * dz) / l2 : 0
      t = clamp(t, 0, 1)
      const d = Math.hypot(r[X]! - ra[X]! - dx * t, r[Z]! - ra[Z]! - dz * t) / tol
      const f = (i - a) / (b - a)
      const e = Math.max(d, Math.abs(r[BED]! - (ra[BED]! + (rb[BED]! - ra[BED]!) * f)) / bedTol)
      if (e > worst) {
        worst = e
        wi = i
      }
    }
    if (worst > 1) {
      keep[wi] = 1
      stack.push([a, wi], [wi, b])
    }
  }
  return rows.filter((_, i) => keep[i])
}

/** Nearest point on a polyline: segment index and parameter. */
function nearestOn(xs: readonly number[], zs: readonly number[], x: number, z: number): { i: number; t: number } {
  let best = Infinity
  let bi = 0
  let bt = 0
  for (let i = 0; i < xs.length - 1; i++) {
    const dx = xs[i + 1]! - xs[i]!
    const dz = zs[i + 1]! - zs[i]!
    const l2 = dx * dx + dz * dz
    const t = l2 > 0 ? clamp(((x - xs[i]!) * dx + (z - zs[i]!) * dz) / l2, 0, 1) : 0
    const d = Math.hypot(x - xs[i]! - dx * t, z - zs[i]! - dz * t)
    if (d < best) {
      best = d
      bi = i
      bt = t
    }
  }
  return { i: bi, t: bt }
}

const at = (v: readonly number[], i: number, t: number): number => v[i]! + ((v[i + 1] ?? v[i]!) - v[i]!) * t

/** After lowering/raising the last point: push the change upstream so the profile stays non-increasing. */
function monotoneBack(bed: number[]): void {
  for (let i = bed.length - 2; i >= 0; i--) if (bed[i]! < bed[i + 1]!) bed[i] = bed[i + 1]!
}

/**
 * Raster drainage runs in 8 directions; real rivers wander. Offsets the course sideways by a smooth random curve
 * (kilometres-long bends), less in mountain valleys, none at the ends so junctions and mouths stay put.
 */
function wander(rows: Rows, rng: () => number): void {
  const m = rows.length
  if (m < 4) return
  const arc = new Float64Array(m)
  for (let i = 1; i < m; i++) arc[i] = arc[i - 1]! + Math.hypot(rows[i]![X]! - rows[i - 1]![X]!, rows[i]![Z]! - rows[i - 1]![Z]!)
  const total = arc[m - 1]!
  const p1 = rng() * Math.PI * 2
  const p2 = rng() * Math.PI * 2
  const k1 = (Math.PI * 2) / (6500 + rng() * 4000)
  const k2 = (Math.PI * 2) / (2600 + rng() * 1500)
  const offs = rows.map((row, i) => {
    const ends = smoothstep(0, 2500, arc[i]!) * smoothstep(total, total - 2500, arc[i]!)
    const amp = Math.min(WANDER * ends * (1 - 0.6 * clamp(row[RG]! / 600, 0, 1)) * (1 - row[LK]!), 0.5 * row[ROOM]!)
    return amp * (0.75 * Math.sin(arc[i]! * k1 + p1) + 0.35 * Math.sin(arc[i]! * k2 + p2))
  })
  const xs = rows.map((r) => r[X]!)
  const zs = rows.map((r) => r[Z]!)
  for (let i = 0; i < m; i++) {
    const a = Math.max(0, i - 2)
    const b = Math.min(m - 1, i + 2)
    const tx = xs[b]! - xs[a]!
    const tz = zs[b]! - zs[a]!
    const tl = Math.hypot(tx, tz) || 1
    rows[i]![X] = xs[i]! - (tz / tl) * offs[i]!
    rows[i]![Z] = zs[i]! + (tx / tl) * offs[i]!
  }
}

/**
 * A tributary cuts down to its parent's level over its last kilometres instead of dropping into it at the junction
 * (the parent valley is carved deeper than the tributary's own bed).
 */
function grade(xs: readonly number[], zs: readonly number[], bed: number[]): void {
  const n = bed.length
  if (n < 2) return
  const end = bed[n - 1]!
  const dist = new Float64Array(n)
  let k = n - 1
  for (let i = n - 2; i >= 0; i--) {
    dist[i] = dist[i + 1]! + Math.hypot(xs[i + 1]! - xs[i]!, zs[i + 1]! - zs[i]!)
    if (dist[i]! <= GRADE_REACH) k = i
  }
  // Concave profile from the junction up to the bed GRADE_REACH upstream (flat where it meets the parent, so its
  // banks never stand above the parent's water); only ever lowers.
  const top = k > 0 ? bed[k - 1]! : bed[0]!
  const span = k > 0 ? dist[k - 1]! : Math.max(dist[0]!, 1)
  for (let i = n - 2; i >= k; i--) bed[i] = Math.min(bed[i]!, end + (top - end) * (dist[i]! / span) ** 3)
}

export function shapeRivers(h: Hydro, lakes: LakeFields, r: Raster, rng: () => number): ShapedRivers {
  const { nx, ox, oz, ch } = r
  const n = h.paths.length
  const valleys: (ValleyLine | null)[] = new Array(n).fill(null)
  const channels: (ChannelLine | null)[] = new Array(n).fill(null)

  // Parents before tributaries, so a tributary snaps onto final geometry.
  const children: number[][] = Array.from({ length: n }, () => [])
  const roots: number[] = []
  h.paths.forEach((p, k) => (p.parent >= 0 ? children[p.parent]!.push(k) : roots.push(k)))
  const queue = [...roots]
  for (let q = 0; q < queue.length; q++) queue.push(...children[queue[q]!]!)

  // Which river owns each raster node, so bends never push one river into its neighbour.
  const owner = new Int32Array(nx * r.nz).fill(-1)
  h.paths.forEach((p, k) => p.nodes.forEach((c, idx) => idx < p.nodes.length - 1 && (owner[c] = k)))
  const roomAt = (k: number, x: number, z: number, w: number): number => {
    const gi = Math.round((x - ox) / CELL)
    const gj = Math.round((z - oz) / CELL)
    let best = Infinity
    for (let j = Math.max(0, gj - ROOM_CELLS); j <= Math.min(r.nz - 1, gj + ROOM_CELLS); j++) {
      for (let i = Math.max(0, gi - ROOM_CELLS); i <= Math.min(nx - 1, gi + ROOM_CELLS); i++) {
        const o = owner[j * nx + i]!
        if (o < 0 || o === k) continue
        best = Math.min(best, Math.hypot(ox + i * CELL - x, oz + j * CELL - z))
      }
    }
    return best === Infinity ? Infinity : Math.max(0, 0.45 * best - w / 2 - 80)
  }

  for (const k of queue) {
    const path = h.paths[k]!
    const last = path.nodes.length - 1
    // A stub (source right next to its parent) has no course of its own: it would only bump the parent.
    if (path.nodes.length <= 2) continue
    let rows: Rows = path.nodes.map((c, idx) => {
      const ci = c % nx
      const cj = (c - ci) / nx
      // Lake water includes its shallow rim: the river is at the lake level there, not incised under it.
      const lake = lakes.wet[c]! > 0
      const sea = path.end === 'sea' && idx === last
      return [
        ox + ci * CELL,
        oz + cj * CELL,
        sea ? -3 : lake ? lakes.level[c]! : h.filled[c]!,
        // The last node belongs to the sea or to the parent river: keep this river's own width there.
        widthOf(h.acc[idx === last ? path.nodes[last - 1]! : c]!),
        ch[c * STRIDE + RIDGE]!,
        lake ? 1 : 0,
        ch[c * STRIDE + HILL]!,
      ]
    })
    // Rivers incise below the surrounding land, except on a lake's shore band (they would cut under its level
    // right beside it) and where they enter, cross or leave a lake.
    rows.forEach((row, idx) => {
      if (idx === last || lakes.level[path.nodes[idx]!]! > NO_LAKE) return
      const nearLake = row[LK]! > 0 || (rows[idx - 1]?.[LK] ?? 0) > 0 || (rows[idx + 1]?.[LK] ?? 0) > 0
      if (nearLake) return
      row[BED] = Math.max(0.5, row[BED]! - Math.min(70, INCISION_HILL * row[HL]! + INCISION_RIDGE * row[RG]!))
    })
    // Non-increasing downstream without digging below what comes next (a lake level, the sea): incision is
    // given back wherever the river would otherwise have to climb.
    const bed0 = rows.map((row) => row[BED]!)
    monotoneBack(bed0)
    rows.forEach((row, idx) => (row[BED] = bed0[idx]!))
    // Estuary: carry the mouth on past the first sea node, so the river surely ends in open water.
    if (path.end === 'sea' && rows.length >= 2) {
      const a = rows[rows.length - 2]!
      const b = rows[rows.length - 1]!
      const l = Math.hypot(b[X]! - a[X]!, b[Z]! - a[Z]!) || 1
      const e = [...b]
      e[X] = b[X]! + ((b[X]! - a[X]!) / l) * MOUTH_RUN
      e[Z] = b[Z]! + ((b[Z]! - a[Z]!) / l) * MOUTH_RUN
      e[BED] = -8
      rows.push(e)
    }

    rows = chaikin(chaikin(rows))
    const m = rows.length
    for (const row of rows) row[ROOM] = roomAt(k, row[X]!, row[Z]!, row[W]!)
    wander(rows, rng)
    // Arc length, slope, meander amplitude.
    const arc = new Float64Array(m)
    for (let i = 1; i < m; i++) arc[i] = arc[i - 1]! + Math.hypot(rows[i]![X]! - rows[i - 1]![X]!, rows[i]![Z]! - rows[i - 1]![Z]!)
    const total = arc[m - 1]!
    const amp = new Float64Array(m)
    for (let i = 0; i < m; i++) {
      const a = Math.max(0, i - 3)
      const b = Math.min(m - 1, i + 3)
      const run = arc[b]! - arc[a]!
      const slope = run > 0 ? (rows[a]![BED]! - rows[b]![BED]!) / run : 0
      const flat = clamp(1 - slope / 0.0025, 0, 1) * (1 - clamp(rows[i]![RG]! / 400, 0, 1)) * (1 - rows[i]![LK]!)
      const ends = smoothstep(0, 1800, arc[i]!) * smoothstep(total, total - 1800, arc[i]!)
      amp[i] = Math.min(flat * ends * Math.min(2.4 * rows[i]![W]!, 650), 0.5 * rows[i]![ROOM]!)
    }
    // Meandering channel: offset along the local normal, wavelength ∝ width.
    let phase = rng() * Math.PI * 2
    const wob = rng() * Math.PI * 2
    let chan: Rows = rows.map((row, i) => {
      if (i > 0) phase += ((arc[i]! - arc[i - 1]!) * Math.PI * 2) / clamp(14 * row[W]!, 1600, 5500)
      const p = rows[Math.max(0, i - 1)]!
      const q = rows[Math.min(m - 1, i + 1)]!
      const tx = q[X]! - p[X]!
      const tz = q[Z]! - p[Z]!
      const tl = Math.hypot(tx, tz) || 1
      const off = amp[i]! * Math.sin(phase) * (0.7 + 0.3 * Math.sin(phase * 0.37 + wob))
      return [row[X]! - (tz / tl) * off, row[Z]! + (tx / tl) * off, row[BED]!, row[W]!, row[RG]!, row[LK]!, row[HL]!]
    })
    chan = simplify(chaikin(chan), CHANNEL_TOL, VALLEY_BED_TOL)
    const vrows = simplify(rows, VALLEY_TOL, VALLEY_BED_TOL)
    // Floodplain half-width per kept valley node must cover the meanders on both adjacent valley segments
    // (the segment interpolates between kept nodes, which DP may have placed far apart).
    const kept = vrows.map((row) => rows.indexOf(row))
    const ampAround = kept.map((_, k) => {
      let a = 0
      for (let j = kept[Math.max(0, k - 1)]!; j <= kept[Math.min(kept.length - 1, k + 1)]!; j++) a = Math.max(a, amp[j]!)
      return a
    })
    const valley: ValleyLine = { xs: [], zs: [], bed: [], flat: [], reach: [] }
    vrows.forEach((row, k) => {
      const w = row[W]!
      const flat = w / 2 + ampAround[k]! + VALLEY_TOL + 140
      valley.xs.push(row[X]!)
      valley.zs.push(row[Z]!)
      valley.bed.push(row[BED]!)
      valley.flat.push(flat)
      valley.reach.push(flat + 900 + 2.5 * w + 0.9 * row[HL]! + 1.1 * row[RG]!)
    })
    const channel: ChannelLine = { xs: chan.map((c) => c[X]!), zs: chan.map((c) => c[Z]!), bed: chan.map((c) => c[BED]!), width: chan.map((c) => c[W]!) }

    // Tributary: meet the parent's channel and valley exactly, at the parent's level there.
    if (path.parent >= 0) {
      const pc = channels[path.parent]!
      const pv = valleys[path.parent]!
      const ce = channel.xs.length - 1
      const nc = nearestOn(pc.xs, pc.zs, channel.xs[ce]!, channel.zs[ce]!)
      channel.xs[ce] = at(pc.xs, nc.i, nc.t)
      channel.zs[ce] = at(pc.zs, nc.i, nc.t)
      channel.bed[ce] = at(pc.bed, nc.i, nc.t)
      const ve = valley.xs.length - 1
      const nv = nearestOn(pv.xs, pv.zs, valley.xs[ve]!, valley.zs[ve]!)
      valley.xs[ve] = at(pv.xs, nv.i, nv.t)
      valley.zs[ve] = at(pv.zs, nv.i, nv.t)
      valley.bed[ve] = at(pv.bed, nv.i, nv.t)
      monotoneBack(channel.bed)
      monotoneBack(valley.bed)
      grade(channel.xs, channel.zs, channel.bed)
      grade(valley.xs, valley.zs, valley.bed)
    }
    valleys[k] = valley
    channels[k] = channel
  }
  return { valleys: valleys.filter((v) => v !== null), channels: channels.filter((c) => c !== null) }
}
