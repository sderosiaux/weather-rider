// The journey: what the land does along a route, drawn once from the seed. Everything here is in the route frame
// (s = along start→gate, n = lateral, + = right of the direction of travel) and converted to world xz at the end.
import type { TerrainParams } from '../core/types'

export type Biome = 'coastal' | 'farmland' | 'valley' | 'forest' | 'lakes' | 'hills' | 'plateau' | 'highland'

/** Macro character of a biome. base/relief/hill in metres; forest/farm/lakes are 0..1 tendencies. */
export interface BiomeParams {
  readonly base: number
  /** Amplitude of the 20 km undulation (drainage basins, low ridges). */
  readonly relief: number
  /** Amplitude of the query-time hill noise (8 km → 500 m). */
  readonly hill: number
  readonly forest: number
  readonly farm: number
  readonly lakes: number
}

export const BIOMES: Readonly<Record<Biome, BiomeParams>> = {
  coastal: { base: 30, relief: 25, hill: 22, forest: 0.15, farm: 0.85, lakes: 0 },
  farmland: { base: 110, relief: 60, hill: 38, forest: 0.2, farm: 0.92, lakes: 0.1 },
  valley: { base: 70, relief: 40, hill: 30, forest: 0.25, farm: 0.88, lakes: 0.05 },
  forest: { base: 260, relief: 110, hill: 95, forest: 0.85, farm: 0.25, lakes: 0.35 },
  lakes: { base: 220, relief: 80, hill: 60, forest: 0.7, farm: 0.3, lakes: 1 },
  hills: { base: 380, relief: 170, hill: 170, forest: 0.5, farm: 0.45, lakes: 0.15 },
  plateau: { base: 640, relief: 90, hill: 55, forest: 0.12, farm: 0.4, lakes: 0.1 },
  highland: { base: 420, relief: 150, hill: 140, forest: 0.62, farm: 0.25, lakes: 0.25 },
}

const FILLER: readonly Biome[] = ['farmland', 'forest', 'lakes', 'hills', 'plateau', 'farmland', 'forest', 'hills']

export interface Knot {
  readonly s: number
  readonly biome: Biome
}

/** World-space polyline. */
export interface Polyline {
  readonly xs: readonly number[]
  readonly zs: readonly number[]
}

/** A mountain range: massif uplift + ridged peaks, strongest on the spine. `mod` scales each spine point. */
export interface Range extends Polyline {
  readonly mod: readonly number[]
  readonly halfWidth: number
  readonly massif: number
  readonly ridge: number
}

/** A broad valley the big river will find: the land sinks toward a floor sloping from the first point to the last. */
export interface Trough extends Polyline {
  readonly halfWidth: number
  readonly floorStart: number
  readonly floorEnd: number
}

/** Sea body: a capsule (segment + radius), coast warped by noise at bake time. */
export interface SeaCapsule {
  readonly ax: number
  readonly az: number
  readonly bx: number
  readonly bz: number
  readonly halfWidth: number
}

/** Elliptic hollow; the flood fill turns it into a lake. */
export interface Bowl {
  readonly x: number
  readonly z: number
  readonly cos: number
  readonly sin: number
  readonly r1: number
  readonly r2: number
  readonly depth: number
}

export interface Frame {
  readonly sx: number
  readonly sz: number
  readonly dirX: number
  readonly dirZ: number
  readonly length: number
}

export type Archetype = 'lakes-mountains-river' | 'river-mountains-hills' | 'strait' | 'plateau-oblique-range'

export interface JourneyPlan {
  readonly frame: Frame
  readonly archetype: Archetype
  readonly knots: readonly Knot[]
  /** Bands are sheared by this (s += n · shear) so regions run obliquely, not as stripes across the route. */
  readonly shear: number
  readonly ranges: readonly Range[]
  readonly troughs: readonly Trough[]
  readonly seas: readonly SeaCapsule[]
  readonly bowls: readonly Bowl[]
  /** Land ends (fades to open sea) beyond this distance from the route segment, before noise. */
  readonly continentRadius: number
  readonly departure: { readonly x: number; readonly z: number; readonly radius: number }
  readonly arrival: { readonly x: number; readonly z: number; readonly radius: number }
}

const KM = 1000
const FAR = 170 * KM

export const routeFrame = (p: TerrainParams): Frame => {
  const dx = p.gate.x - p.start.x
  const dz = p.gate.z - p.start.z
  const length = Math.hypot(dx, dz)
  // Degenerate routes still get a frame (heading east).
  return length > 1
    ? { sx: p.start.x, sz: p.start.z, dirX: dx / length, dirZ: dz / length, length }
    : { sx: p.start.x, sz: p.start.z, dirX: 1, dirZ: 0, length: 1 }
}

export const worldX = (f: Frame, s: number, n: number): number => f.sx + f.dirX * s - f.dirZ * n
export const worldZ = (f: Frame, s: number, n: number): number => f.sz + f.dirZ * s + f.dirX * n
export const alongOf = (f: Frame, x: number, z: number): number => (x - f.sx) * f.dirX + (z - f.sz) * f.dirZ
export const lateralOf = (f: Frame, x: number, z: number): number => -(x - f.sx) * f.dirZ + (z - f.sz) * f.dirX

type Rng = () => number

const uni = (rng: Rng, a: number, b: number): number => a + (b - a) * rng()
const sign = (rng: Rng): number => (rng() < 0.5 ? -1 : 1)

/** Polyline through the route-frame point (s0, n0) along the axis at angle `angle` from the lateral axis. */
function spine(f: Frame, rng: Rng, s0: number, n0: number, angle: number, halfA: number, halfB: number, bend: number, points: number): Polyline {
  const xs: number[] = []
  const zs: number[] = []
  // Axis unit vector in (s, n), and its normal.
  const as = Math.sin(angle)
  const an = Math.cos(angle)
  const wobblePhase = rng() * Math.PI * 2
  const wobble = uni(rng, 0.02, 0.06)
  for (let i = 0; i < points; i++) {
    const t = -halfA + ((halfA + halfB) * i) / (points - 1)
    const u = t / Math.max(halfA, halfB)
    const off = bend * u * u + wobble * Math.max(halfA, halfB) * Math.sin(u * 4 + wobblePhase) * 0.3
    const s = s0 + as * t + an * off
    const n = n0 + an * t - as * off
    xs.push(worldX(f, s, n))
    zs.push(worldZ(f, s, n))
  }
  return { xs, zs }
}

function rangeMods(rng: Rng, points: number): number[] {
  const raw = Array.from({ length: points }, () => uni(rng, 0.7, 1.12))
  return raw.map((v, i) => (v * 2 + (raw[i - 1] ?? v) + (raw[i + 1] ?? v)) / 4)
}

export function planJourney(p: TerrainParams, rng: Rng): JourneyPlan {
  const f = routeFrame(p)
  const L = f.length
  const roll = rng()
  const archetype: Archetype =
    roll < 0.38 ? 'lakes-mountains-river' : roll < 0.62 ? 'river-mountains-hills' : roll < 0.78 ? 'strait' : 'plateau-oblique-range'

  const depCoastal = rng() < (archetype === 'strait' ? 0.9 : 0.45)
  const arrCoastal = rng() < 0.3
  const required: Knot[] = [
    { s: 0, biome: depCoastal ? 'coastal' : rng() < 0.6 ? 'farmland' : 'valley' },
    { s: L, biome: arrCoastal ? 'coastal' : rng() < 0.6 ? 'farmland' : 'valley' },
  ]
  const ranges: Range[] = []
  const troughs: Trough[] = []
  const seas: SeaCapsule[] = []

  const addRange = (s0: number, n0: number, angle: number, halfA: number, halfB: number, halfWidth: number, massif: number, ridge: number): void => {
    const points = 15
    const line = spine(f, rng, s0, n0, angle, halfA, halfB, uni(rng, -12, 12) * KM, points)
    ranges.push({ ...line, mod: rangeMods(rng, points), halfWidth, massif, ridge })
  }
  const crossingRange = (s0: number, oblique: boolean): void => {
    const angle = oblique ? sign(rng) * uni(rng, 0.6, 0.95) : uni(rng, -0.6, 0.6)
    addRange(s0, uni(rng, -4, 4) * KM, angle, uni(rng, 50, 110) * KM, uni(rng, 50, 110) * KM, uni(rng, 8, 13) * KM, uni(rng, 450, 750), uni(rng, 1000, 1350))
    required.push({ s: s0, biome: 'highland' })
  }
  const valley = (s0: number): void => {
    const angle = uni(rng, -0.5, 0.5)
    const line = spine(f, rng, s0, 0, angle, FAR, FAR, uni(rng, -20, 20) * KM, 13)
    const flip = rng() < 0.5
    troughs.push({
      xs: flip ? [...line.xs].reverse() : line.xs,
      zs: flip ? [...line.zs].reverse() : line.zs,
      halfWidth: uni(rng, 7, 11) * KM,
      floorStart: uni(rng, 280, 420),
      floorEnd: -20,
    })
    required.push({ s: s0, biome: 'valley' })
  }

  switch (archetype) {
    case 'lakes-mountains-river':
      required.push({ s: uni(rng, 0.18, 0.3) * L, biome: 'lakes' })
      crossingRange(uni(rng, 0.45, 0.62) * L, false)
      valley(uni(rng, 0.74, 0.86) * L)
      break
    case 'river-mountains-hills':
      valley(uni(rng, 0.2, 0.34) * L)
      crossingRange(uni(rng, 0.56, 0.7) * L, false)
      required.push({ s: uni(rng, 0.82, 0.9) * L, biome: rng() < 0.5 ? 'hills' : 'forest' })
      break
    case 'strait': {
      const sc = uni(rng, 0.32, 0.5) * L
      const side = sign(rng)
      seas.push({
        ax: worldX(f, sc + uni(rng, -25, 25) * KM, side * 160 * KM),
        az: worldZ(f, sc + uni(rng, -25, 25) * KM, side * 160 * KM),
        bx: worldX(f, sc, -side * uni(rng, 14, 26) * KM),
        bz: worldZ(f, sc, -side * uni(rng, 14, 26) * KM),
        halfWidth: uni(rng, 4.5, 7) * KM,
      })
      required.push({ s: sc + 16 * KM, biome: rng() < 0.5 ? 'hills' : 'forest' })
      if (rng() < 0.6) valley(uni(rng, 0.68, 0.82) * L)
      break
    }
    case 'plateau-oblique-range':
      required.push({ s: uni(rng, 0.18, 0.28) * L, biome: 'plateau' })
      crossingRange(uni(rng, 0.45, 0.6) * L, true)
      required.push({ s: uni(rng, 0.78, 0.88) * L, biome: 'lakes' })
      break
  }

  // Side ranges: the dramatic peaks seen off the wing.
  const sideCount = archetype === 'strait' ? 1 + (rng() < 0.5 ? 1 : 0) : rng() < 0.6 ? 1 + (rng() < 0.3 ? 1 : 0) : 0
  let lastSide = sign(rng)
  for (let i = 0; i < sideCount; i++) {
    lastSide = i === 0 ? lastSide : -lastSide
    const s0 = uni(rng, 0.15, 0.95) * L
    addRange(s0, lastSide * uni(rng, 21, 36) * KM, Math.PI / 2 + uni(rng, -0.35, 0.35), uni(rng, 25, 55) * KM, uni(rng, 25, 55) * KM, uni(rng, 6, 10) * KM, uni(rng, 300, 600), uni(rng, 850, 1250))
  }

  // Coasts: behind the departure, beyond the arrival, along one side.
  const coastCapsule = (sCoast: number, outward: number, tilt: number): SeaCapsule => {
    const hw = 60 * KM
    // Coast normal (outward, toward the sea) in (s, n), tilted.
    const ns = outward * Math.cos(tilt)
    const nn = Math.sin(tilt)
    const cs = sCoast + ns * hw
    const cn = nn * hw
    return {
      ax: worldX(f, cs - nn * FAR * 1.4, cn + ns * FAR * 1.4),
      az: worldZ(f, cs - nn * FAR * 1.4, cn + ns * FAR * 1.4),
      bx: worldX(f, cs + nn * FAR * 1.4, cn - ns * FAR * 1.4),
      bz: worldZ(f, cs + nn * FAR * 1.4, cn - ns * FAR * 1.4),
      halfWidth: hw,
    }
  }
  if (depCoastal) seas.push(coastCapsule(-uni(rng, 7, 11) * KM, -1, uni(rng, -0.6, 0.6)))
  if (arrCoastal) seas.push(coastCapsule(L + uni(rng, 7, 11) * KM, 1, uni(rng, -0.6, 0.6)))
  if (rng() < 0.3) {
    const side = sign(rng)
    const hw = 40 * KM
    const n0 = side * (uni(rng, 30, 45) * KM + hw)
    const fromStart = rng() < 0.5
    const sA = fromStart ? -FAR : uni(rng, 0.25, 0.6) * L
    const sB = fromStart ? uni(rng, 0.4, 0.75) * L : L + FAR
    seas.push({ ax: worldX(f, sA, n0), az: worldZ(f, sA, n0), bx: worldX(f, sB, n0), bz: worldZ(f, sB, n0), halfWidth: hw })
  }

  // Knots: the required ones, then filler every ~20 km out to the far horizon.
  const knots: Knot[] = [...required]
  for (let s = -FAR; s <= L + FAR; s += uni(rng, 18, 26) * KM) {
    if (knots.every((k) => Math.abs(k.s - s) >= 12 * KM)) knots.push({ s, biome: FILLER[Math.floor(rng() * FILLER.length)]! })
  }
  knots.sort((a, b) => a.s - b.s)
  // No two identical neighbours among the filler: the view should keep changing.
  const varied = knots.map((k, i) => {
    const prev = knots[i - 1]
    if (!prev || prev.biome !== k.biome || required.includes(k)) return k
    return { s: k.s, biome: FILLER[(FILLER.indexOf(k.biome) + 1 + Math.floor(rng() * 3)) % FILLER.length]! }
  })

  const depS = -uni(rng, 1.5, 3.5) * KM
  const depN = uni(rng, -1.5, 1.5) * KM
  const departure = { x: worldX(f, depS, depN), z: worldZ(f, depS, depN), radius: uni(rng, 2.6, 3.8) * KM }
  const arrival = { x: p.gate.x + uni(rng, -600, 600), z: p.gate.z + uni(rng, -600, 600), radius: uni(rng, 2.4, 3.6) * KM }

  const bowls: Bowl[] = []
  for (let i = 0; i < 140; i++) {
    const s = uni(rng, -120, L / KM + 120) * KM
    const n = uni(rng, -110, 110) * KM
    const x = worldX(f, s, n)
    const z = worldZ(f, s, n)
    const lakes = BIOMES[biomeAt(varied, s)].lakes
    const keep = rng() < lakes * 0.75 + 0.03
    const angle = rng() * Math.PI
    const r1 = uni(rng, 1.3, 3.2) * KM
    const aspect = uni(rng, 1, 2.6)
    const depth = uni(rng, 35, 80)
    const nearCity = Math.hypot(x - departure.x, z - departure.z) < 9 * KM || Math.hypot(x - arrival.x, z - arrival.z) < 9 * KM
    if (keep && !nearCity) bowls.push({ x, z, cos: Math.cos(angle), sin: Math.sin(angle), r1, r2: r1 / aspect, depth })
  }

  return {
    frame: f,
    archetype,
    knots: varied,
    shear: uni(rng, -0.45, 0.45),
    ranges,
    troughs,
    seas,
    bowls,
    continentRadius: uni(rng, 112, 140) * KM,
    departure,
    arrival,
  }
}

/** Dominant biome at along-route position s (no blending), for placement decisions. */
export function biomeAt(knots: readonly Knot[], s: number): Biome {
  let best = knots[0]!
  for (const k of knots) if (Math.abs(k.s - s) < Math.abs(best.s - s)) best = k
  return best.biome
}
