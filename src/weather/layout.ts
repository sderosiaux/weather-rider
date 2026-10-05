// Deterministic generation of the weather layout from WeatherParams.
// Produces both the public feature list and the compact specs the sampler evaluates.
import { clamp, lerp, smoothstep, v3 } from '../core/math'
import { createRng, hashInts } from '../core/rng'
import type { Vec3, WeatherFeature, WeatherParams } from '../core/types'

export const STORM = 0
export const UPDRAFT = 1
export const DOWNDRAFT = 2
export const THERMAL = 3
export type ColumnKind = typeof STORM | typeof UPDRAFT | typeof DOWNDRAFT | typeof THERMAL

/** Vertical column (storm, updraft, downdraft, thermal) in sampler-ready form. */
export interface ColumnSpec {
  readonly kind: ColumnKind
  readonly cx: number
  readonly cz: number
  readonly radius: number
  readonly base: number
  readonly top: number
  /** Peak vertical wind (m/s), negative for sinks. */
  readonly strength: number
  /** 0..1 scale on the turbulence this column produces. */
  readonly intensity: number
  /** Storm: unit xz direction of the strongest updraft flank. */
  readonly flankX: number
  readonly flankZ: number
  /** Storm: unit xz direction of the upper-level wind (anvil + rear downdraft side). */
  readonly anvilX: number
  readonly anvilZ: number
  /** Updraft / thermal: 1 if it carries a cumulus cap. */
  readonly cumulus: number
  /** Horizontal distance beyond which the column contributes nothing. */
  readonly reach: number
  readonly yMin: number
  readonly yMax: number
}

/**
 * Jet core centerline as a smooth function of x (jets are westerly), so the tangent
 * and lateral offset stay continuous everywhere — polyline corners would make wind jumps.
 */
export interface JetSpec {
  readonly z0: number
  readonly a1: number
  readonly k1: number
  readonly p1: number
  readonly a2: number
  readonly k2: number
  readonly p2: number
  readonly y0: number
  readonly ay: number
  readonly ky: number
  readonly py: number
  /** Horizontal half-width (m) — also the public feature radius. */
  readonly rh: number
  /** Vertical half-thickness (m). */
  readonly rv: number
  readonly speed: number
  /** Peak turbulence in the shear layers above/below the core. */
  readonly shearTurb: number
  /** Along-jet streak modulation. */
  readonly ks: number
  readonly ps: number
  /** The jet fades out between these abscissas (m); the low jet dies before the gate so arrivals stay flyable. */
  readonly fadeX0: number
  readonly fadeX1: number
}

/** Background traffic flying a straight line; its wake trails behind it for `life` seconds. */
export interface WakeSpec {
  readonly ax: number
  readonly az: number
  readonly dx: number
  readonly dz: number
  readonly length: number
  readonly alt: number
  /** Vortex core radius (m). */
  readonly rc: number
  /** Peak tangential velocity of each vortex (m/s). */
  readonly vmax: number
  readonly span: number
  readonly speed: number
  /** Peak turbulence at the vortex cores. */
  readonly turb: number
  readonly life: number
  readonly phase: number
}

export interface BackgroundSpec {
  readonly speedScale: number
  readonly p1: number
  readonly p2: number
  readonly p3: number
  /** Turbulence of undisturbed air at this severity. */
  readonly baseTurb: number
}

export interface Layout {
  readonly background: BackgroundSpec
  readonly columns: readonly ColumnSpec[]
  readonly jets: readonly JetSpec[]
  readonly wakes: readonly WakeSpec[]
  readonly features: readonly WeatherFeature[]
}

const TAU = Math.PI * 2
/** Features fade out over this distance inside the bounds so the field stays continuous at the border. */
export const EDGE = 3000
/** A wake fades in and out over this length at each end of its track. */
export const WAKE_TAPER = 3000
/**
 * A published jet path, shear layer or wake track covers where the feature is at ≥ this share of its nominal
 * strength. Its fade-outs (bounds, the low jet before the gate, wake tapers) are smooth and a published extent
 * can only stop: the half-strength point is the best step approximation of a smooth fade.
 */
const PUBLISHED_SHARE = 0.5
/** Step (m) of the scan that locates where a feature's strength crosses PUBLISHED_SHARE. */
const SCAN_STEP = 100
const JET_VERTEX_STEP = 4000
/** Horizontal reach of a column's influence, in radii. Must match the sampler's kernels. */
export const COLUMN_REACH = 1.6
/** Storm reach: the anvil is centred 1.3 R downwind with a 3.0 R semi-axis (4.3 R), plus margin. */
export const STORM_REACH = 4.35
/** Storm core radius, in radii (violent turbulence inside). */
export const STORM_CORE = 0.6
/** From this severity a storm core sits on the straight start→gate line. */
const BLOCK_LINE_SEVERITY = 0.6
/** From this severity (up to BLOCK_LINE_SEVERITY) a storm sits beside the line, its core edge over it. */
const NEAR_LINE_SEVERITY = 0.35
/** Below this severity every storm core stays clear of the straight line. */
const CLEAR_LINE_SEVERITY = 0.35
/** Clearance between the straight line and a storm core edge on calm days (m). */
const LINE_MARGIN = 3500
/** Low jet core altitude range (m) and speed multiplier. Tuned by the balance lab (lab/reports/balance-loop.md). */
const LOW_JET_MIN = 4000
const LOW_JET_SPAN = 1500
/** Low jet: lateral offset of its axis from the straight line (m), meander amplitude, horizontal half-width. */
const LOW_JET_OFFSET = 8000
const LOW_JET_OFFSET_SPAN = 4000
const LOW_JET_MEANDER = 2500
const LOW_JET_HALF_WIDTH = 4500
/** Low jet cap (m/s): faster than a turboprop's slow flight makes the way back upwind impossible. */
const LOW_JET_MAX = 150
/** The low jet fades out between these distances (m) before the gate abscissa. */
const LOW_JET_FADE = [16_000, 6_000] as const
const NO_FADE = 1e12
const LOW_JET_BOOST = 2.2
/** Background westerly (m/s) at the surface and aloft: negative = easterly headwind for eastbound routes down low. */
const BG_SURFACE = -4
const BG_ALOFT = 33
const BG_K1 = TAU / 140_000
const BG_K2 = TAU / 90_000
const BG_K3 = TAU / 60_000

/** Direction (rad, 0 = +x, positive toward +z) of the large-scale westerly flow. */
export function backgroundAngle(bg: BackgroundSpec, x: number, z: number, t: number): number {
  return 0.3 * Math.sin(x * BG_K1 + bg.p1 + t * 0.0006) * Math.cos(z * BG_K2 + bg.p2) + 0.12 * Math.sin((x - z) * BG_K3 + bg.p3)
}

/** Westerly speed profile: a light easterly (BG_SURFACE) near the ground, ≈29 m/s at 10 km. */
export function backgroundSpeed(y: number): number {
  const s = y / 7000
  return BG_SURFACE + (BG_ALOFT - BG_SURFACE) * (1 - Math.exp(-s * s))
}

/** Lift scale: calm (≤ 3 m/s) at severity 0, ≥ 13 m/s from severity 0.2, 26 m/s at 1. */
function liftScale(sev: number): number {
  return sev < 0.2 ? lerp(2.4, 13, sev / 0.2) : lerp(13, 26, (sev - 0.2) / 0.8)
}

interface Frame {
  readonly ax: number
  readonly az: number
  readonly ux: number
  readonly uz: number
  readonly len: number
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
}

export function generateLayout(params: WeatherParams): Layout {
  const sev = clamp(params.severity, 0, 1)
  const { boundsMin: bmin, boundsMax: bmax } = params
  // Independent streams per category: tweaking one population never reshuffles the others.
  const rngFor = (tag: number) => createRng(hashInts(params.seed, tag))

  const [c0, c1] = params.corridor
  let ux = c1.x - c0.x
  let uz = c1.z - c0.z
  let len = Math.hypot(ux, uz)
  if (len < 1) {
    ux = 1
    uz = 0
    len = bmax.x - bmin.x
  } else {
    ux /= len
    uz /= len
  }
  const margin = 2000
  const fr: Frame = {
    ax: c0.x,
    az: c0.z,
    ux,
    uz,
    len,
    minX: bmin.x + margin,
    maxX: bmax.x - margin,
    minZ: bmin.z + margin,
    maxZ: bmax.z - margin,
  }
  /** Point at fraction `along` of the corridor, offset `lateral` meters to its right. */
  const onCorridor = (along: number, lateral: number): [number, number] => [
    clamp(fr.ax + fr.ux * fr.len * along - fr.uz * lateral, fr.minX, fr.maxX),
    clamp(fr.az + fr.uz * fr.len * along + fr.ux * lateral, fr.minZ, fr.maxZ),
  ]
  const anywhere = (r: () => number): [number, number] => [lerp(fr.minX, fr.maxX, r()), lerp(fr.minZ, fr.maxZ, r())]
  const ceiling = bmax.y - 500

  const rb = rngFor(0xb6)
  const background: BackgroundSpec = {
    speedScale: 0.85 + 0.3 * sev,
    p1: rb() * TAU,
    p2: rb() * TAU,
    p3: rb() * TAU,
    baseTurb: 0.03 + 0.09 * sev,
  }
  const upperWind = (x: number, z: number): [number, number] => {
    const a = backgroundAngle(background, x, z, 0)
    return [Math.cos(a), Math.sin(a)]
  }

  const columns: ColumnSpec[] = []
  const features: WeatherFeature[] = []
  const lift = liftScale(sev)

  // Footprints of placed columns: overlapping columns would stack their vertical wind
  // (50 m/s towers at severity 1, a 6 m/s "calm" day at severity 0).
  const placed: [number, number, number][] = []
  const clearance = (c: readonly [number, number], footprint: number) => {
    let clear = Infinity
    for (const [px, pz, pr] of placed) clear = Math.min(clear, Math.hypot(c[0] - px, c[1] - pz) - pr - footprint)
    return clear
  }
  /** Best of a few candidates from `pick`, maximizing clearance to already placed columns. */
  const place = (pick: () => [number, number], footprint: number): [number, number] => {
    let best: [number, number] = pick()
    let bestClear = -Infinity
    for (let attempt = 0; attempt < 16; attempt++) {
      const c = attempt === 0 ? best : pick()
      const clear = clearance(c, footprint)
      if (clear > bestClear) {
        best = c
        bestClear = clear
      }
      if (clear >= 0) break
    }
    placed.push([best[0], best[1], footprint])
    return best
  }
  /** Like `place`, but gives up (null) rather than overlap anything. */
  const placeStrict = (pick: () => [number, number], footprint: number): [number, number] | null => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const c = pick()
      if (clearance(c, footprint) >= 0) {
        placed.push([c[0], c[1], footprint])
        return c
      }
    }
    return null
  }
  /** Horizontal distance from (x, z) to the straight start→gate segment. */
  const distToLine = (x: number, z: number) => {
    const along = clamp((x - fr.ax) * fr.ux + (z - fr.az) * fr.uz, 0, fr.len)
    return Math.hypot(x - (fr.ax + fr.ux * along), z - (fr.az + fr.uz * along))
  }

  const pushColumn = (spec: Omit<ColumnSpec, 'reach' | 'yMin' | 'yMax'>, id: string) => {
    const isStorm = spec.kind === STORM
    const col: ColumnSpec = {
      ...spec,
      reach: spec.radius * (isStorm ? STORM_REACH : COLUMN_REACH),
      // Storm rear downdraft and inflow reach the ground (and stay continuous below it).
      yMin: isStorm ? -Infinity : spec.base - 500 - (spec.kind === THERMAL ? 400 : 0),
      yMax: spec.top + (isStorm ? 1500 : 800),
    }
    columns.push(col)
    const center = v3(col.cx, (col.base + col.top) / 2, col.cz)
    const common = { id, center, radius: col.radius, base: col.base, top: col.top, strength: col.strength }
    const kind = spec.kind === STORM ? 'storm' : spec.kind === UPDRAFT ? 'updraft' : spec.kind === DOWNDRAFT ? 'downdraft' : 'thermal'
    features.push({ kind, ...common })
  }

  // ── Storms: biased along the corridor, count and strength scale with severity.
  // The straight line is a routing decision: rough days put a storm core on it (flying straight
  // has a real cost), calm-ish days keep every core clear of it.
  const rs = rngFor(0x5707)
  const nearStorms = sev < 0.1 ? 0 : Math.round(sev * 4 + rs() * 1.5)
  const farStorms = Math.floor(sev * 3 * rs())
  const blockLine = sev >= BLOCK_LINE_SEVERITY
  const nearLine = !blockLine && sev >= NEAR_LINE_SEVERITY
  const avoidLine = sev < CLEAR_LINE_SEVERITY
  for (let i = 0; i < nearStorms + farStorms; i++) {
    const near = i < nearStorms
    const radius = 3500 + 4000 * rs() * (0.5 + 0.5 * sev)
    // Keep the core (0.6 R) plus a margin off the straight line.
    const lineClear = STORM_CORE * radius + LINE_MARGIN
    const side = () => (rs() < 0.5 ? -1 : 1)
    const pick = (): [number, number] => {
      if (blockLine && i === 0) return onCorridor(0.25 + 0.5 * rs(), (rs() * 2 - 1) * 0.15 * radius)
      if (nearLine && i === 0) return onCorridor(0.25 + 0.5 * rs(), side() * (0.2 + 0.25 * rs()) * radius)
      if (avoidLine) return onCorridor(near ? 0.12 + (0.76 * (i + rs())) / nearStorms : rs(), side() * (lineClear + rs() * (near ? 9000 : 18_000)))
      return near ? onCorridor(0.12 + (0.76 * (i + rs())) / nearStorms, (rs() * 2 - 1) * 14_000) : anywhere(rs)
    }
    let [cx, cz] = place(pick, radius * 1.3)
    // Bounds clamping can pull an avoiding storm back toward the line: push it out along the normal.
    if (avoidLine && distToLine(cx, cz) < lineClear) {
      const lat = (cz - fr.az) * fr.ux - (cx - fr.ax) * fr.uz
      const along = ((cx - fr.ax) * fr.ux + (cz - fr.az) * fr.uz) / fr.len
      ;[cx, cz] = onCorridor(along, (lat < 0 ? -1 : 1) * lineClear)
    }
    const flank = rs() * TAU
    const [wx, wz] = upperWind(cx, cz)
    pushColumn(
      {
        kind: STORM,
        cx,
        cz,
        radius,
        base: 600 + 800 * rs(),
        // Cumulonimbus tops: ≈10 km on mild days, 11–13.5 km (anvil at the ceiling) when extreme.
        top: Math.min(ceiling, lerp(9500, 11_000, sev) + 2600 * sev * rs()),
        strength: (12 + 16 * sev) * (0.85 + 0.3 * rs()),
        intensity: 0.65 + 0.35 * sev,
        flankX: Math.cos(flank),
        flankZ: Math.sin(flank),
        anvilX: wx,
        anvilZ: wz,
        cumulus: 1,
      },
      `storm-${i + 1}`,
    )
  }

  // ── Updrafts: a guaranteed set of lift columns along the corridor, plus scattered extras.
  const ru = rngFor(0x0bd)
  const nLift = 2 + Math.round(sev * 3)
  const nExtra = Math.round(sev * 4 * ru())
  for (let i = 0; i < nLift + nExtra; i++) {
    const guaranteed = i < nLift
    const radius = 1800 + 1700 * ru()
    const [cx, cz] = place(() => (guaranteed ? onCorridor(0.1 + (0.8 * (i + ru())) / nLift, (ru() * 2 - 1) * 9000) : anywhere(ru)), radius * COLUMN_REACH)
    pushColumn(
      {
        kind: UPDRAFT,
        cx,
        cz,
        radius,
        base: 200 + 600 * ru(),
        top: Math.min(ceiling, 6800 + 3700 * ru()),
        strength: lift * (guaranteed ? 1 + 0.25 * ru() : 0.6 + 0.5 * ru()),
        intensity: 0.4 + 0.4 * sev,
        flankX: 0,
        flankZ: 0,
        anvilX: 0,
        anvilZ: 0,
        cumulus: 1,
      },
      `updraft-${i + 1}`,
    )
  }

  // ── Downdrafts: the price of a careless line.
  const rd = rngFor(0xd0d)
  const nSink = 1 + Math.round(sev * 4)
  for (let i = 0; i < nSink; i++) {
    const radius = 2000 + 2000 * rd()
    const [cx, cz] = place(() => onCorridor(0.1 + 0.85 * rd(), (rd() * 2 - 1) * 20_000), radius * COLUMN_REACH)
    pushColumn(
      {
        kind: DOWNDRAFT,
        cx,
        cz,
        radius,
        base: 0,
        top: Math.min(ceiling, 4000 + 5000 * rd()),
        strength: -lift * (0.55 + 0.35 * rd()),
        intensity: 0.35 + 0.4 * sev,
        flankX: 0,
        flankZ: 0,
        anvilX: 0,
        anvilZ: 0,
        cumulus: 0,
      },
      `downdraft-${i + 1}`,
    )
  }

  // ── Thermals: gentle, many, low.
  const rt = rngFor(0x7e4)
  const areaKm2 = ((fr.maxX - fr.minX) * (fr.maxZ - fr.minZ)) / 1e6
  const nThermals = Math.round(clamp(areaKm2 / 110, 20, 140))
  for (let i = 0; i < nThermals; i++) {
    const radius = 500 + 800 * rt()
    // Thermals never overlap anything: a thermal under an updraft would stack past "gentle".
    const at = placeStrict(() => anywhere(rt), radius * COLUMN_REACH)
    if (!at) continue
    const [cx, cz] = at
    pushColumn(
      {
        kind: THERMAL,
        cx,
        cz,
        radius,
        base: 0,
        top: 1300 + 1600 * rt(),
        strength: (1.2 + 1.2 * rt()) * (1 + 1.1 * sev),
        intensity: 0.3,
        flankX: 0,
        flankZ: 0,
        anvilX: 0,
        anvilZ: 0,
        cumulus: rt() < 0.55 ? 1 : 0,
      },
      `thermal-${i + 1}`,
    )
  }

  // ── Jet streams: westerly, meandering across the corridor. The first is a low jet within climbing reach of
  // the routes (the one worth hunting); the second is the classic high jet at 9–12 km.
  const rj = rngFor(0x1e7)
  const nJets = 2
  const jets: JetSpec[] = []
  const midZ = fr.az + fr.uz * fr.len * 0.5
  for (let i = 0; i < nJets; i++) {
    const low = i === 0
    const k1 = TAU / (70_000 + 90_000 * rj())
    const k2 = TAU / (25_000 + 25_000 * rj())
    // Slopes capped so the jet keeps a strong eastward component everywhere. The low jet barely meanders:
    // it runs beside the straight line, so finding it is a decision, not luck.
    const a1 = low ? LOW_JET_MEANDER * rj() : Math.min(4000 + 14_000 * rj(), 0.45 / k1)
    const a2 = low ? Math.min(600 * rj(), 0.12 / k2) : Math.min(1500 + 3000 * rj(), 0.12 / k2)
    const side = rj() < 0.5 ? -1 : 1
    const z0 = low ? midZ + side * (LOW_JET_OFFSET + LOW_JET_OFFSET_SPAN * rj()) : midZ + (rj() * 2 - 1) * 6000
    const jet: JetSpec = {
      z0,
      a1,
      k1,
      p1: rj() * TAU,
      a2,
      k2,
      p2: rj() * TAU,
      y0: low ? LOW_JET_MIN + LOW_JET_SPAN * rj() : Math.min(ceiling - 1500, 9900 + 1300 * rj()),
      ay: low ? 150 + 250 * rj() : 250 + 450 * rj(),
      ky: TAU / (80_000 + 120_000 * rj()),
      py: rj() * TAU,
      rh: low ? LOW_JET_HALF_WIDTH + 2000 * rj() : 7000 + 5000 * rj(),
      rv: 1400 + 500 * rj(),
      speed: low ? Math.min(LOW_JET_MAX, (40 + 50 * (0.2 + 0.8 * sev) * (0.6 + 0.4 * rj())) * LOW_JET_BOOST) : 40 + 50 * (0.2 + 0.8 * sev) * (0.6 + 0.4 * rj()),
      shearTurb: 0.2 + 0.45 * sev,
      ks: TAU / (40_000 + 40_000 * rj()),
      fadeX0: low ? fr.ax + fr.ux * fr.len - LOW_JET_FADE[0] : NO_FADE,
      fadeX1: low ? fr.ax + fr.ux * fr.len - LOW_JET_FADE[1] : NO_FADE + 1,
      ps: rj() * TAU,
    }
    jets.push(jet)
    // Published where they are at ≥ half strength: the low jet stops before the gate, and a core that leaves the
    // bounds sideways splits the jet into several features. The shear layers fade with the jet but have no streaks.
    const fadeAt = (x: number) => jetFade(jet, x) * edgeFade(bmin, bmax, x, jetZ(jet, x))
    const tagOf = (count: number, r: number) => (count === 1 ? `${i + 1}` : `${i + 1}-${r + 1}`)
    const core = (x: number) => v3(x, jetY(jet, x), jetZ(jet, x))
    const jetRuns = halfRuns((x) => jetStreak(jet, x) * fadeAt(x), bmin.x, bmax.x)
    jetRuns.forEach(([x0, x1], r) => {
      const path = [core(x0)]
      // Vertices on a grid anchored at the bounds' west side (consumers interpolate between them: keep them put),
      // none within 1 km of an end (no sliver segments).
      for (let x = bmin.x + Math.ceil((x0 - bmin.x) / JET_VERTEX_STEP) * JET_VERTEX_STEP; x < x1; x += JET_VERTEX_STEP) {
        if (x - x0 >= 1000 && x1 - x >= 1000) path.push(core(x))
      }
      path.push(core(x1))
      features.push({ kind: 'jetstream', id: `jet-${tagOf(jetRuns.length, r)}`, path, radius: jet.rh, thickness: jet.rv, speed: jet.speed })
    })
    const shearRuns = halfRuns(fadeAt, bmin.x, bmax.x)
    shearRuns.forEach(([x0, x1], r) => {
      let zLo = Infinity
      let zHi = -Infinity
      for (let x = x0; ; x = Math.min(x + SCAN_STEP, x1)) {
        const z = jetZ(jet, x)
        zLo = Math.min(zLo, z - jet.rh)
        zHi = Math.max(zHi, z + jet.rh)
        if (x === x1) break
      }
      for (const side of [-1, 1] as const) {
        features.push({
          kind: 'shear',
          id: `shear-${tagOf(shearRuns.length, r)}-${side < 0 ? 'low' : 'high'}`,
          altitude: jet.y0 + side * jet.rv * 0.55,
          thickness: jet.rv * 0.6,
          deltaWind: v3(-side * jet.speed, 0, 0),
          extentMin: v3(x0, jet.y0 - jet.ay - jet.rv, zLo),
          extentMax: v3(x1, jet.y0 + jet.ay + jet.rv, zHi),
        })
      }
    })
  }

  // ── Wake turbulence from background traffic crossing the corridor region.
  const rw = rngFor(0x3a4e)
  const nWakes = 2 + (rw() < 0.5 ? 1 : 0)
  const wakes: WakeSpec[] = []
  for (let i = 0; i < nWakes; i++) {
    const [px, pz] = onCorridor(0.2 + 0.6 * rw(), (rw() * 2 - 1) * 10_000)
    const heading = rw() * TAU
    const dx = Math.cos(heading)
    const dz = Math.sin(heading)
    const [sMin, sMax] = clipLine(px, pz, dx, dz, bmin.x, bmax.x, bmin.z, bmax.z)
    const speed = 230
    const life = 75 + 45 * rw()
    const length = sMax - sMin
    const rc = 70 + 40 * rw()
    const wake: WakeSpec = {
      ax: px + dx * sMin,
      az: pz + dz * sMin,
      dx,
      dz,
      length,
      alt: 6000 + 5500 * rw(),
      rc,
      // Peak downwash between the vortices is ≈1.93·vmax: gentle on calm days, vicious at severity 1.
      vmax: (lerp(3.4, 18, sev) * (0.85 + 0.25 * rw())) / 1.93,
      span: rc * 2.6,
      speed,
      turb: 0.3 + 0.55 * sev,
      life,
      phase: rw() * (length + speed * life),
    }
    wakes.push(wake)
    // The track runs bound to bound; its ends taper (and meet the bounds fade), so it is published like a jet.
    const at = (s: number) => v3(wake.ax + dx * s, wake.alt, wake.az + dz * s)
    const taper = (s: number) => smoothstep(0, WAKE_TAPER, s) * (1 - smoothstep(length - WAKE_TAPER, length, s))
    const runs = halfRuns((s) => taper(s) * edgeFade(bmin, bmax, wake.ax + dx * s, wake.az + dz * s), 0, length)
    runs.forEach(([s0, s1], r) => {
      const id = runs.length === 1 ? `wake-${i + 1}` : `wake-${i + 1}-${r + 1}`
      features.push({ kind: 'wake', id, path: [at(s0), at(s1)], radius: rc, strength: wake.vmax })
    })
  }

  return { background, columns, jets, wakes, features }
}

export function jetZ(j: JetSpec, x: number): number {
  return j.z0 + j.a1 * Math.sin(j.k1 * x + j.p1) + j.a2 * Math.sin(j.k2 * x + j.p2)
}

export function jetY(j: JetSpec, x: number): number {
  return j.y0 + j.ay * Math.sin(j.ky * x + j.py)
}

// Same formulas as the sampler's `jetstreams`, which writes them out on its hot path.
/** Along-jet streaks: the core blows at 70–100 % of `speed`. */
function jetStreak(j: JetSpec, x: number): number {
  return 0.85 + 0.15 * Math.sin(j.ks * x + j.ps)
}

/** 1 → 0 across the jet's fade (the low jet's, before the gate): its wind, shear layers and cirrus fade together. */
function jetFade(j: JetSpec, x: number): number {
  return 1 - smoothstep(j.fadeX0, j.fadeX1, x)
}

/** Factor the sampler applies to every feature at (x, z): 0 outside the bounds, rising over EDGE inside. */
function edgeFade(bmin: Vec3, bmax: Vec3, x: number, z: number): number {
  if (!(x > bmin.x && x < bmax.x && z > bmin.z && z < bmax.z)) return 0
  return smoothstep(0, EDGE, Math.min(x - bmin.x, bmax.x - x)) * smoothstep(0, EDGE, Math.min(z - bmin.z, bmax.z - z))
}

/** Maximal intervals of [a, b] where strength ≥ PUBLISHED_SHARE, ends located to 1 m on the inside. Slivers under a scan step are dropped. */
function halfRuns(strength: (s: number) => number, a: number, b: number): [number, number][] {
  const inside = (s: number) => strength(s) >= PUBLISHED_SHARE
  const cross = (inS: number, outS: number): number => {
    while (Math.abs(outS - inS) > 1) {
      const m = (inS + outS) / 2
      if (inside(m)) inS = m
      else outS = m
    }
    return inS
  }
  const runs: [number, number][] = []
  let start: number | null = inside(a) ? a : null
  const n = Math.ceil((b - a) / SCAN_STEP)
  for (let k = 1; k <= n; k++) {
    const prev = a + (k - 1) * SCAN_STEP
    const s = k === n ? b : a + k * SCAN_STEP
    if (inside(s)) start ??= cross(s, prev)
    else if (start !== null) {
      runs.push([start, cross(prev, s)])
      start = null
    }
  }
  if (start !== null) runs.push([start, b])
  return runs.filter(([s0, s1]) => s1 - s0 >= SCAN_STEP)
}

/** Parameter range [sMin, sMax] of the line p + s·d inside the xz rectangle. */
function clipLine(px: number, pz: number, dx: number, dz: number, x0: number, x1: number, z0: number, z1: number): [number, number] {
  let lo = -Infinity
  let hi = Infinity
  const slab = (p: number, d: number, a: number, b: number) => {
    if (Math.abs(d) < 1e-9) return
    const s0 = (a - p) / d
    const s1 = (b - p) / d
    lo = Math.max(lo, Math.min(s0, s1))
    hi = Math.min(hi, Math.max(s0, s1))
  }
  slab(px, dx, x0, x1)
  slab(pz, dz, z0, z1)
  return [lo, hi]
}
