// Hot-path sampler. Allocation-free when `out` is given: accumulators live in the closure,
// columns are looked up through a uniform xz grid so cost is bounded by local feature density.
import { hashInts } from '../core/rng'
import type { MutableWeatherSample, Vec3, WeatherFeatureKind, WeatherParams, WeatherSample } from '../core/types'
import { STORM, THERMAL, UPDRAFT, backgroundAngle, backgroundSpeed, jetY, jetZ, type ColumnSpec, type Layout } from './layout'
import { createNoisePair } from './noise'

const CELL = 4000
/** Features fade out over this distance inside the bounds so the field stays continuous at the border. */
const EDGE = 3000
/** Gust amplitude (m/s) at turbulence 1. */
const GUST_H = 9
const GUST_V = 5.5
/** Gust pattern drift (m/s along +x): frozen turbulence carried by the flow. */
const ADVECT = 12
const OCTAVE_1 = 900
const OCTAVE_2 = 260
/** Asymptote of the feature vertical wind (m/s). */
const MAX_VERTICAL = 36
/** Wake vortex sink rate (m/s). */
const WAKE_SINK = 1.5
/** Below this score (≈ m/s of feature wind), `dominant` stays null. */
const DOMINANT_MIN = 2.5
/** Max of 12·s³·(1−s²): normalizes the jet's vertical shear to 0..1. */
const SHEAR_NORM = 1 / 2.2308

// Accumulator slots.
const FWX = 0
const FWY = 1
const FWZ = 2
/** Product of (1 − turbulence) over features. */
const FCALM = 3
const CLOUD = 4
const CIRRUS = 5
const BEST = 6
/** Jet accumulators: summed vector, summed speed, strongest speed. */
const JX = 7
const JY = 8
const JZ = 9
const JSUM = 10
const JMAX = 11

const ss = (e0: number, e1: number, x: number): number => {
  if (x <= e0) return 0
  if (x >= e1) return 1
  const u = (x - e0) / (e1 - e0)
  return u * u * (3 - 2 * u)
}

export type Sampler = (p: Vec3, t: number, out?: MutableWeatherSample) => WeatherSample

export function createSampler(params: WeatherParams, layout: Layout): Sampler {
  const { boundsMin: bmin, boundsMax: bmax } = params
  const { background: bg, columns, jets, wakes } = layout

  // ── Uniform xz grid of column ids (CSR layout).
  const nx = Math.max(1, Math.ceil((bmax.x - bmin.x) / CELL))
  const nz = Math.max(1, Math.ceil((bmax.z - bmin.z) / CELL))
  const buckets: number[][] = Array.from({ length: nx * nz }, () => [])
  columns.forEach((c, id) => {
    const i0 = Math.max(0, Math.floor((c.cx - c.reach - bmin.x) / CELL))
    const i1 = Math.min(nx - 1, Math.floor((c.cx + c.reach - bmin.x) / CELL))
    const k0 = Math.max(0, Math.floor((c.cz - c.reach - bmin.z) / CELL))
    const k1 = Math.min(nz - 1, Math.floor((c.cz + c.reach - bmin.z) / CELL))
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) buckets[k * nx + i]!.push(id)
  })
  const cellStart = new Int32Array(nx * nz + 1)
  buckets.forEach((b, c) => (cellStart[c + 1] = cellStart[c]! + b.length))
  const cellItems = new Int32Array(buckets.flat())

  let jetYMin = Infinity
  let jetYMax = -Infinity
  for (const j of jets) {
    jetYMin = Math.min(jetYMin, j.y0 - j.ay - j.rv)
    jetYMax = Math.max(jetYMax, j.y0 + j.ay + j.rv)
  }

  const gust1 = createNoisePair(hashInts(params.seed, 0x6057))
  const gust2 = createNoisePair(hashInts(params.seed, 0x6058))

  // Per-sample accumulators, reset on every call. A typed array rather than closure `let`s:
  // storing doubles into closure slots can box them (one heap number per write).
  const acc = new Float64Array(12)
  let bestKind: WeatherFeatureKind | null = null

  const consider = (score: number, kind: WeatherFeatureKind) => {
    if (score > acc[BEST]!) {
      acc[BEST] = score
      bestKind = kind
    }
  }

  const column = (c: ColumnSpec, dx: number, dz: number, d2: number, y: number) => {
    const R = c.radius * 1.6
    const q = d2 / (R * R)
    if (q >= 1) return
    const k1 = 1 - q
    const k = k1 * k1 * k1
    const thermal = c.kind === THERMAL
    const env = thermal
      ? ss(-400, 300, y) * (1 - ss(c.top - 600, c.top + 300, y))
      : ss(c.base - 400, c.base + 900, y) * (1 - ss(c.top - 1800, c.top + 400, y))
    const S = c.strength
    const w = S * k * env
    acc[FWY] = acc[FWY]! + w
    // Convergence at the base, divergence at the top (reversed for sinks).
    const radial = (0.22 * w * (2 * ss(c.base, c.top, y) - 1)) / R
    acc[FWX] = acc[FWX]! + radial * dx
    acc[FWZ] = acc[FWZ]! + radial * dz
    const aS = Math.abs(S)
    acc[FCALM] = acc[FCALM]! * (1 - c.intensity * (0.25 + 0.75 * Math.min(1, aS / 20)) * 4 * k * (1 - k) * env * 0.5)
    if (c.cumulus > 0) {
      if (thermal) {
        const v = ss(c.top - 500, c.top - 200, y) * (1 - ss(c.top + 100, c.top + 400, y))
        acc[CLOUD] = Math.max(acc[CLOUD]!, 0.8 * ss(0.4, 0.8, k) * v)
      } else {
        const cb = c.base + 0.3 * (c.top - c.base)
        const v = ss(cb, cb + 300, y) * (1 - ss(c.top - 300, c.top + 300, y))
        acc[CLOUD] = Math.max(acc[CLOUD]!, ss(0.35, 0.75, k) * v)
      }
    }
    consider(Math.abs(w), c.kind === UPDRAFT ? 'updraft' : thermal ? 'thermal' : 'downdraft')
  }

  const storm = (c: ColumnSpec, dx: number, dz: number, d2: number, y: number) => {
    const R = c.radius
    const S = c.strength
    const I = c.intensity
    const base = c.base
    const top = c.top
    const r2 = d2 / (R * R)
    const r = Math.sqrt(r2)
    const envS = ss(base - 600, base + 1200, y) * (1 - ss(top - 2500, top + 500, y))

    // Organized updraft ring on the flanks, strongest on one side.
    let ringK = 0
    const u = (r - 0.8) / 0.4
    if (u > -1 && u < 1) {
      const v = 1 - u * u
      ringK = v * v
    }
    const cosT = d2 > 1 ? (dx * c.flankX + dz * c.flankZ) / (r * R) : 0
    const flankW = S * ringK * (0.45 + 0.275 * (1 + cosT)) * envS
    // Chaotic core: moderate lift, violent turbulence.
    const qc = r2 / 0.36
    const coreK = qc < 1 ? (1 - qc) * (1 - qc) : 0
    const coreW = 0.3 * S * coreK * envS
    // Rear downdraft under the anvil, reaching the ground.
    const rx = dx - c.anvilX * 1.25 * R
    const rz = dz - c.anvilZ * 1.25 * R
    const qd = (rx * rx + rz * rz) / (0.5625 * R * R)
    const kd = qd < 1 ? (1 - qd) * (1 - qd) * (1 - qd) : 0
    const envD = 1 - ss(top * 0.45, top * 0.7, y)
    const downW = -0.6 * S * kd * envD
    acc[FWY] = acc[FWY]! + flankW + coreW + downW

    // Low-level inflow, outflow under the anvil.
    const radK = r2 < 4 ? (1 - r2 / 4) * (1 - r2 / 4) : 0
    const radial = (0.3 * S * radK * (ss(top - 3500, top - 500, y) * (1 - ss(top, top + 1500, y)) - 0.5 * (1 - ss(base, base + 2500, y)))) / R
    acc[FWX] = acc[FWX]! + radial * dx
    acc[FWZ] = acc[FWZ]! + radial * dz

    // Anvil: flat lens downwind of the top.
    const ax = dx - c.anvilX * 0.9 * R
    const az = dz - c.anvilZ * 0.9 * R
    const ay = (y - (top - 900)) / 1100
    const qa = (ax * ax + az * az) / (5.29 * R * R) + ay * ay
    const ka = qa < 1 ? (1 - qa) * (1 - qa) : 0

    const envT = ss(base - 800, base + 500, y) * (1 - ss(top, top + 1200, y))
    const qt = r2 / 0.5625
    const tCore = qt < 1 ? 0.98 * I * (1 - qt) * (1 - qt) * envT : 0
    const tFlank = 0.4 * I * ringK * envS
    const tDown = 0.35 * I * kd * envD
    const tAnvil = 0.25 * I * ka
    acc[FCALM] = acc[FCALM]! * ((1 - tCore) * (1 - tFlank) * (1 - tDown) * (1 - tAnvil))

    const qcl = r2 / 1.1025
    const colK = qcl < 1 ? Math.min(1, 1.8 * (1 - qcl)) : 0
    const envC = ss(base - 100, base + 300, y) * (1 - ss(top - 300, top + 300, y))
    acc[CLOUD] = Math.max(acc[CLOUD]!, colK * envC, 0.9 * ka)

    consider(tCore * 30 + Math.abs(coreW), 'storm')
    consider(flankW, 'updraft')
    consider(-downW, 'downdraft')
  }

  // Indexed loops (not for-of) on the hot path: no iterator objects.
  const jetstreams = (x: number, y: number, z: number) => {
    for (let i = 0; i < jets.length; i++) {
      const j = jets[i]!
      const dv = y - jetY(j, x)
      if (dv <= -j.rv || dv >= j.rv) continue
      const slope = j.a1 * j.k1 * Math.cos(j.k1 * x + j.p1) + j.a2 * j.k2 * Math.cos(j.k2 * x + j.p2)
      const cosA2 = 1 / (1 + slope * slope)
      const dl = z - jetZ(j, x)
      const ql = (dl * dl * cosA2) / (j.rh * j.rh)
      if (ql >= 1) continue
      const sv = dv / j.rv
      const q = ql + sv * sv
      if (q >= 1) continue
      // Flat-topped profile in distance d = √q: 1 − 3d⁴ + 2d⁶ (C1 at the edge).
      const k = 1 - q * q * (3 - 2 * q)
      const sy = j.ay * j.ky * Math.cos(j.ky * x + j.py)
      const inv = 1 / Math.sqrt(1 + slope * slope + sy * sy)
      const sp = j.speed * (0.85 + 0.15 * Math.sin(j.ks * x + j.ps)) * k
      acc[JX] = acc[JX]! + sp * inv
      acc[JY] = acc[JY]! + sp * sy * inv
      acc[JZ] = acc[JZ]! + sp * slope * inv
      acc[JSUM] = acc[JSUM]! + sp
      if (sp > acc[JMAX]!) acc[JMAX] = sp
      // Shear layers above and below the core: |∂k/∂v|·rv = 12·s·q·(1−q).
      const shear = 12 * Math.abs(sv) * q * (1 - q) * SHEAR_NORM
      const tShear = j.shearTurb * shear
      acc[FCALM] = acc[FCALM]! * (1 - tShear)
      // Thin cirrus deck just above the core.
      const cv = (sv - 0.7) / 0.25
      if (cv > -1 && cv < 1) acc[CIRRUS] = Math.max(acc[CIRRUS]!, 0.45 * (1 - cv * cv) * (1 - ql))
      consider(sp * 0.5, 'jetstream')
      consider(tShear * 40, 'shear')
    }
  }

  const wakeTurbulence = (x: number, y: number, z: number, t: number) => {
    for (let i = 0; i < wakes.length; i++) {
      const w = wakes[i]!
      const reach = 6 * w.rc + w.span * 0.5
      if (y > w.alt + reach || y < w.alt - WAKE_SINK * w.life - reach) continue
      const rx = x - w.ax
      const rz = z - w.az
      const s = rx * w.dx + rz * w.dz
      if (s <= 0 || s >= w.length) continue
      const lat = rz * w.dx - rx * w.dz
      if (lat <= -reach || lat >= reach) continue
      const cycle = w.length + w.speed * w.life
      const planeS = (((t * w.speed + w.phase) % cycle) + cycle) % cycle
      const age = (planeS - s) / w.speed
      if (age <= 0 || age >= w.life) continue
      const vz = y - (w.alt - WAKE_SINK * age)
      const rr2 = lat * lat + vz * vz
      const cut = 1 - ss((4 * w.rc + w.span * 0.5) ** 2, reach * reach, rr2)
      if (cut <= 0) continue
      const fade = ss(0, 4, age) * (1 - ss(w.life * 0.4, w.life, age)) * ss(0, 3000, s) * (1 - ss(w.length - 3000, w.length, s)) * cut
      if (fade <= 0) continue
      // Counter-rotating pair (smoothed Rankine vortices): downwash between, upwash outside.
      const C = 2 * w.rc * w.vmax
      const rc2 = w.rc * w.rc
      const lL = lat + w.span * 0.5
      const lR = lat - w.span * 0.5
      const r2L = lL * lL + vz * vz
      const r2R = lR * lR + vz * vz
      const fL = -C / (r2L + rc2)
      const fR = C / (r2R + rc2)
      const vLat = (-fL * vz - fR * vz) * fade
      const vUp = (fL * lL + fR * lR) * fade
      acc[FWX] = acc[FWX]! - vLat * w.dz
      acc[FWZ] = acc[FWZ]! + vLat * w.dx
      acc[FWY] = acc[FWY]! + vUp
      acc[FCALM] = acc[FCALM]! * (1 - (w.turb * fade) / (1 + Math.min(r2L, r2R) / (4 * rc2)))
      consider(Math.sqrt(vLat * vLat + vUp * vUp), 'wake')
    }
  }

  return (p, t, out) => {
    const o: MutableWeatherSample = out ?? { wind: { x: 0, y: 0, z: 0 }, turbulence: 0, dominant: null, cloud: 0 }
    const x = p.x
    const y = p.y
    const z = p.z

    const ang = backgroundAngle(bg, x, z, t)
    const spd = backgroundSpeed(y) * bg.speedScale
    let wx = spd * Math.cos(ang)
    let wy = 0
    let wz = spd * Math.sin(ang)
    const baseTurb = bg.baseTurb + 0.08 * (1 - ss(0, 1200, y))

    acc.fill(0)
    acc[FCALM] = 1
    bestKind = null

    const edge =
      x > bmin.x && x < bmax.x && z > bmin.z && z < bmax.z
        ? ss(bmin.x, bmin.x + EDGE, x) * (1 - ss(bmax.x - EDGE, bmax.x, x)) * ss(bmin.z, bmin.z + EDGE, z) * (1 - ss(bmax.z - EDGE, bmax.z, z))
        : 0

    if (edge > 0) {
      const gi = Math.floor((x - bmin.x) / CELL)
      const gk = Math.floor((z - bmin.z) / CELL)
      const cell = (gk < nz ? gk : nz - 1) * nx + (gi < nx ? gi : nx - 1)
      const end = cellStart[cell + 1]!
      for (let j = cellStart[cell]!; j < end; j++) {
        const c = columns[cellItems[j]!]!
        if (y < c.yMin || y > c.yMax) continue
        const dx = x - c.cx
        const dz = z - c.cz
        const d2 = dx * dx + dz * dz
        if (d2 >= c.reach * c.reach) continue
        if (c.kind === STORM) storm(c, dx, dz, d2, y)
        else column(c, dx, dz, d2, y)
      }
      if (y > jetYMin && y < jetYMax) {
        jetstreams(x, y, z)
        // Crossing jets blend instead of adding up: the result never exceeds the strongest one.
        if (acc[JSUM]! > 1e-9) {
          const f = acc[JMAX]! / acc[JSUM]!
          acc[FWX] = acc[FWX]! + acc[JX]! * f
          acc[FWY] = acc[FWY]! + acc[JY]! * f
          acc[FWZ] = acc[FWZ]! + acc[JZ]! * f
        }
      }
      wakeTurbulence(x, y, z, t)
      wx += acc[FWX]! * edge
      // Soft cap on stacked vertical features (storm flank + nearby column): stays ≈ linear below 25 m/s.
      const fy = acc[FWY]!
      wy += (fy > 0 ? MAX_VERTICAL * Math.tanh(fy / MAX_VERTICAL) : -MAX_VERTICAL * Math.tanh(-fy / MAX_VERTICAL)) * edge
      wz += acc[FWZ]! * edge
    }

    const turb = 1 - (1 - baseTurb) * (1 - edge * (1 - acc[FCALM]!))

    // Gusts: horizontal part is the 2D curl of a potential (divergence-free), so particles
    // trace coherent eddies; the second octave only kicks in once the air is agitated.
    const ax = x - ADVECT * t
    gust1.eval(ax / OCTAVE_1, y / OCTAVE_1 + t * 0.003, z / OCTAVE_1)
    let gx = gust1.dPsiDz
    let gz = -gust1.dPsiDx
    let gy = gust1.phi
    const w2 = ss(0.12, 0.3, turb)
    if (w2 > 0) {
      gust2.eval(ax / OCTAVE_2 + 17.3, y / OCTAVE_2 - t * 0.008, z / OCTAVE_2 + 5.1)
      gx = gx * (1 - 0.35 * w2) + gust2.dPsiDz * 0.35 * w2
      gz = gz * (1 - 0.35 * w2) - gust2.dPsiDx * 0.35 * w2
      gy = gy * (1 - 0.35 * w2) + gust2.phi * 0.35 * w2
    }
    wx += gx * GUST_H * 0.5 * turb
    wz += gz * GUST_H * 0.5 * turb
    wy += gy * GUST_V * turb

    let c = acc[CLOUD]!
    // Erode edges only: dense interiors stay dense.
    if (c > 0) c += 1.4 * c * (1 - c) * (0.7 * gust1.psi + 0.3 * gust1.phi)
    if (acc[CIRRUS]! > 0) c = Math.max(c, acc[CIRRUS]! * ss(-0.2, 0.5, gust1.psi))

    o.wind.x = wx
    o.wind.y = wy
    o.wind.z = wz
    o.turbulence = turb > 1 ? 1 : turb
    o.cloud = (c <= 0 ? 0 : c >= 1 ? 1 : c) * edge
    o.dominant = acc[BEST]! * edge >= DOMINANT_MIN ? bestKind : null
    return o
  }
}
