// Weather features → cloud puffs. Pure and deterministic (seeded by weather seed + feature id),
// so the same daily weather always paints the same sky.
import { createRng, hashString } from '../../core/rng'
import type { Vec3, WeatherFeature } from '../../core/types'

/** Atlas tiles baked by clouds/atlas.ts. */
export const TILE_BILLOW = 0
export const TILE_BILLOW_2 = 1
export const TILE_FLAT_BASE = 2
export const TILE_WISP = 3

export interface Puff {
  readonly x: number
  readonly y: number
  readonly z: number
  /** Half width (m). Axial puffs: half width across the axis. */
  readonly sx: number
  /** Half height (m). Axial puffs: half length along the axis. */
  readonly sy: number
  /** Unit axis for streaks (cirrus, virga, contrail wakes); zero = camera-facing, world-up aligned. */
  readonly ax: number
  readonly ay: number
  readonly az: number
  readonly tile: number
  readonly rot: number
  readonly opacity: number
  /** 0..1 extra darkening (rain shafts, storm bellies). */
  readonly dark: number
  /** Cloud body vertical extent, for base-to-top ambient gradient. */
  readonly base: number
  readonly top: number
  /** 0..1 sunlight reaching the puff through its own cloud (filled by shadeCluster). */
  readonly shade: number
}

type Rng = () => number

/** Vertical features (storm, updraft, downdraft, thermal) share this geometry. */
interface Column {
  readonly center: Vec3
  readonly radius: number
  readonly base: number
  readonly top: number
}

const range = (rng: Rng, lo: number, hi: number): number => lo + (hi - lo) * rng()
const pick = (rng: Rng, a: number, b: number): number => (rng() < 0.5 ? a : b)

const blob = (
  x: number, y: number, z: number, sx: number, sy: number, tile: number, rng: Rng,
  opacity: number, dark: number, base: number, top: number,
): Puff => ({ x, y, z, sx, sy, ax: 0, ay: 0, az: 0, tile, rot: tile === TILE_FLAT_BASE ? (rng() - 0.5) * 0.3 : rng() * Math.PI * 2, opacity, dark, base, top, shade: 1 })

const streak = (
  x: number, y: number, z: number, halfWidth: number, halfLength: number, axis: Vec3,
  opacity: number, dark: number, base: number, top: number, rng: Rng,
): Puff => ({
  x, y, z, sx: halfWidth, sy: halfLength, ax: axis.x, ay: axis.y, az: axis.z,
  tile: TILE_WISP, rot: rng() < 0.5 ? 0 : Math.PI, opacity, dark, base, top, shade: 1,
})

/**
 * Cumulus body: stacked rings of billows hugging a radius profile, flat dark base, cauliflower crown.
 * profile(h) gives the body radius at normalized height h (0 = base, 1 = top).
 */
function cumulusBody(
  cx: number, cz: number, base: number, top: number, profile: (h: number) => number,
  puffScale: number, rng: Rng, out: Puff[], darkBase = 0,
): void {
  const height = top - base
  const r0 = profile(0)
  // Flat base: wide, squashed puffs that give cumulus their shelf.
  // Fill the whole base disk: gaps between dark belly puffs read as lit shards.
  const baseCount = Math.max(4, Math.round(((r0 / puffScale) ** 2) * 1.2))
  for (let i = 0; i < baseCount; i++) {
    const a = rng() * Math.PI * 2
    const rr = r0 * Math.sqrt(rng()) * 0.85
    const s = puffScale * range(rng, 0.9, 1.3)
    out.push(blob(cx + Math.cos(a) * rr, base + s * 0.28, cz + Math.sin(a) * rr, s * 1.25, s * 0.5, TILE_FLAT_BASE, rng, 0.9, darkBase, base, top))
  }
  // Body rings. Spacing follows puff size so the silhouette never shows gaps.
  const step = puffScale * 0.75
  for (let y = base + step * 0.8; y < top - step * 0.3; y += step * range(rng, 0.85, 1.1)) {
    const h = (y - base) / height
    const r = profile(h)
    const ring = Math.max(3, Math.round((Math.PI * 2 * r) / (puffScale * 1.1)))
    const phase = rng() * Math.PI * 2
    for (let i = 0; i < ring; i++) {
      const a = phase + (i / ring) * Math.PI * 2 + range(rng, -0.25, 0.25)
      const rr = r * range(rng, 0.55, 0.95)
      const s = puffScale * range(rng, 0.75, 1.2) * (1 - 0.25 * h)
      out.push(blob(cx + Math.cos(a) * rr, y + range(rng, -0.2, 0.2) * step, cz + Math.sin(a) * rr, s, s, pick(rng, TILE_BILLOW, TILE_BILLOW_2), rng, 0.85, darkBase * (1 - h), base, top))
    }
    // Core filler keeps the body opaque when seen through the ring gaps.
    if (r > puffScale * 0.9) {
      // Kept inside the ring: an oversized filler pokes out as a flat disc.
      const s = Math.min(r * 0.6, puffScale * 1.3)
      out.push(blob(cx + range(rng, -0.2, 0.2) * r, y, cz + range(rng, -0.2, 0.2) * r, s, s * 0.9, TILE_BILLOW, rng, 0.7, darkBase * (1 - h), base, top))
    }
  }
  // Cauliflower crown.
  const rt = Math.max(profile(1), puffScale * 0.6)
  const crown = Math.max(3, Math.round(rt / (puffScale * 0.5)))
  for (let i = 0; i < crown; i++) {
    const a = rng() * Math.PI * 2
    const rr = rt * Math.sqrt(rng()) * 0.7
    const s = puffScale * range(rng, 0.6, 0.95)
    out.push(blob(cx + Math.cos(a) * rr, top - s * range(rng, 0.3, 0.8), cz + Math.sin(a) * rr, s, s, pick(rng, TILE_BILLOW, TILE_BILLOW_2), rng, 0.9, 0, base, top))
  }
}

/**
 * Cumulonimbus: the one cloud that must read as danger from 80 km away. Drawn bigger than its core radius
 * (the feature radius is the violent core, the cloud mass around it is wider), a bruised belly, a vast
 * anvil sheared downwind, an overshooting dome and rain curtains to the sea.
 */
function storm(f: Column, rng: Rng, windDir: Vec3, out: Puff[]): void {
  const R = f.radius * 1.3
  const base = Math.max(f.base, 600)
  const anvilBottom = base + (f.top - base) * 0.74
  const towerTop = base + (f.top - base) * 0.92
  // Many mid-sized billows, not a few giant ones: at storm scale single puffs read as discs.
  const puff = R * 0.26
  cumulusBody(f.center.x, f.center.z, base, towerTop, (h) => R * (1.0 - 0.35 * h + 0.12 * Math.sin(h * 5)), puff, rng, out, 0.85)

  // Anvil: a dense flat-topped shelf spreading downwind, thinning into fibres at its rim.
  const anvilR = R * range(rng, 2.0, 2.6)
  const shift = R * 1.0
  const acx = f.center.x + windDir.x * shift
  const acz = f.center.z + windDir.z * shift
  // The anvil keeps broad puffs: small flat ones stack up like plates.
  const anvilPuff = R * 0.42
  const anvilCount = Math.round(40 + (anvilR / anvilPuff) * 8)
  for (let i = 0; i < anvilCount; i++) {
    const a = rng() * Math.PI * 2
    const rn = Math.sqrt(rng())
    const rr = anvilR * rn
    // Stretched along the wind: anvils are fans, not discs.
    const along = Math.cos(a) * rr * 1.3
    const across = Math.sin(a) * rr * 0.75
    const x = acx + windDir.x * along - windDir.z * across
    const z = acz + windDir.z * along + windDir.x * across
    const s = anvilPuff * range(rng, 1.1, 1.7) * (1 - 0.3 * rn)
    // Flat top, thickest near the tower, underside in shadow.
    const thick = (f.top - anvilBottom) * (1 - 0.6 * rn)
    const y = f.top - s * 0.3 - thick * rng() * 0.8
    const under = y < f.top - thick * 0.5
    out.push(blob(x, y, z, s * 2.0, s * 0.8, pick(rng, TILE_BILLOW_2, TILE_FLAT_BASE), rng, 0.85 * (1 - 0.55 * rn * rn), under ? 0.45 : 0, anvilBottom - (f.top - anvilBottom), f.top))
  }
  // Fibrous rim: the anvil frays into cirrus downwind.
  for (let i = 0; i < 14; i++) {
    const a = (rng() - 0.5) * 1.6
    const dx = windDir.x * Math.cos(a) - windDir.z * Math.sin(a)
    const dz = windDir.z * Math.cos(a) + windDir.x * Math.sin(a)
    const d = anvilR * range(rng, 1.0, 1.4)
    out.push(streak(acx + dx * d, f.top - range(rng, 200, 900), acz + dz * d, anvilPuff * range(rng, 0.4, 0.7), anvilR * range(rng, 0.2, 0.35), { x: dx, y: 0, z: dz }, 0.3, 0, f.top - 2000, f.top, rng))
  }
  // Overshooting dome above the anvil.
  for (let i = 0; i < 6; i++) {
    const s = puff * range(rng, 0.7, 1.0)
    out.push(blob(f.center.x + range(rng, -0.3, 0.3) * R, f.top + s * 0.1, f.center.z + range(rng, -0.3, 0.3) * R, s, s * 0.75, TILE_BILLOW, rng, 0.9, 0, base, f.top + s))
  }
  // Rain shaft: dark curtains from the base down to the sea.
  const shafts = 14 + Math.floor(rng() * 6)
  for (let i = 0; i < shafts; i++) {
    const a = rng() * Math.PI * 2
    const rr = R * 0.7 * Math.sqrt(rng())
    const halfLen = base * 0.5
    // Curtains must stay taller than wide, or the streak texture collapses into a dark disc.
    const halfWidth = Math.min(R * range(rng, 0.15, 0.3), halfLen * 0.45)
    out.push(streak(f.center.x + Math.cos(a) * rr, halfLen, f.center.z + Math.sin(a) * rr, halfWidth, halfLen, UP, 0.35, 0.85, 0, base, rng))
  }
}

/** Updraft column → towering cumulus (congestus) sitting on the upper part of the column. */
function tower(f: Column, rng: Rng, out: Puff[]): void {
  const base = Math.max(f.base + (f.top - f.base) * 0.3, 1200)
  const top = f.top
  // Congestus are about as wide as a third of their height, whatever the column's core radius.
  const r = Math.max(f.radius, (top - base) * 0.32)
  const phase = rng() * 6
  cumulusBody(f.center.x, f.center.z, base, top, (h) => r * (0.85 - 0.25 * h + 0.1 * Math.sin(h * 7 + phase)), r * 0.45, rng, out, 0.2)
}

/** Thermal → small fair-weather cumulus capping the column. */
function thermalCap(f: Column, rng: Rng, out: Puff[]): void {
  const r = f.radius * 1.1
  const height = r * range(rng, 0.6, 0.9)
  const base = f.top - height * 0.25
  cumulusBody(f.center.x, f.center.z, base, base + height, (h) => r * (0.9 - 0.45 * h), r * 0.5, rng, out, 0)
}

/** Downdraft → decaying cloud cap above curtains of virga. */
function virga(f: Column, rng: Rng, out: Puff[]): void {
  const r = f.radius
  const capY = f.top * 0.85
  for (let i = 0; i < 8; i++) {
    const a = rng() * Math.PI * 2
    const rr = r * Math.sqrt(rng()) * 0.8
    const s = r * range(rng, 0.45, 0.7)
    out.push(blob(f.center.x + Math.cos(a) * rr, capY + range(rng, -0.1, 0.1) * s, f.center.z + Math.sin(a) * rr, s * 1.4, s * 0.45, TILE_FLAT_BASE, rng, 0.55, 0.35, capY - s, capY + s))
  }
  const veils = 7 + Math.floor(rng() * 4)
  for (let i = 0; i < veils; i++) {
    const a = rng() * Math.PI * 2
    const rr = r * 0.8 * Math.sqrt(rng())
    const bottom = Math.max(f.base, capY * range(rng, 0.15, 0.45))
    const halfLen = (capY - bottom) / 2
    out.push(streak(f.center.x + Math.cos(a) * rr, bottom + halfLen, f.center.z + Math.sin(a) * rr, r * range(rng, 0.18, 0.35), halfLen, UP, 0.22, 0.5, bottom, capY, rng))
  }
}

/** Streaks laid along a polyline: jet cirrus (wide, high) and traffic wakes (old contrails). */
function alongPath(path: readonly Vec3[], spread: number, vSpread: number, spacing: number, width: [number, number], length: [number, number], opacity: number, rng: Rng, out: Puff[]): void {
  for (let s = 0; s + 1 < path.length; s++) {
    const a = path[s]!
    const b = path[s + 1]!
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
    const len = Math.hypot(dx, dy, dz)
    if (len < 1) continue
    const axis = { x: dx / len, y: dy / len, z: dz / len }
    const n = Math.max(1, Math.round(len / spacing))
    for (let i = 0; i < n; i++) {
      const t = (i + rng()) / n
      const off = spread * (rng() * 2 - 1)
      const x = a.x + dx * t - axis.z * off
      const z = a.z + dz * t + axis.x * off
      const y = a.y + dy * t + vSpread * (rng() * 2 - 1)
      // Cirrus bands drift a few degrees off the flow.
      const yaw = (rng() - 0.5) * 0.12
      const c = Math.cos(yaw), si = Math.sin(yaw)
      const ax = { x: axis.x * c - axis.z * si, y: axis.y, z: axis.x * si + axis.z * c }
      out.push(streak(x, y, z, range(rng, width[0], width[1]), range(rng, length[0], length[1]), ax, opacity * range(rng, 0.6, 1), 0, y - 500, y + 500, rng))
    }
  }
}

/** Shear layer → faint altostratus sheet. Sparse on purpose: flat sheets are the worst overdraw case. */
function shearSheet(f: Extract<WeatherFeature, { kind: 'shear' }>, rng: Rng, out: Puff[]): void {
  const w = f.extentMax.x - f.extentMin.x
  const d = f.extentMax.z - f.extentMin.z
  const spacing = Math.max(12_000, Math.sqrt((w * d) / 60))
  for (let x = f.extentMin.x + spacing / 2; x < f.extentMax.x; x += spacing) {
    for (let z = f.extentMin.z + spacing / 2; z < f.extentMax.z; z += spacing) {
      const s = spacing * range(rng, 0.6, 0.9)
      out.push(blob(x + range(rng, -0.4, 0.4) * spacing, f.altitude + range(rng, -0.3, 0.3) * f.thickness, z + range(rng, -0.4, 0.4) * spacing, s, s * 0.12, TILE_FLAT_BASE, rng, 0.05, 0, f.altitude - f.thickness, f.altitude + f.thickness))
    }
  }
}

const UP: Vec3 = { x: 0, y: 1, z: 0 }

/**
 * Sun self-shadowing inside one cloud: each puff is dimmed by the puffs lying between it and the sun.
 * O(n²) per cluster, done once per setWeather.
 */
export function shadeCluster(puffs: readonly Puff[], sun: Vec3, strength = 0.55): Puff[] {
  return puffs.map((p, i) => {
    let occ = 0
    for (let j = 0; j < puffs.length; j++) {
      if (j === i) continue
      const q = puffs[j]!
      const dx = q.x - p.x, dy = q.y - p.y, dz = q.z - p.z
      const t = dx * sun.x + dy * sun.y + dz * sun.z
      if (t <= 0) continue
      const px = dx - t * sun.x, py = dy - t * sun.y, pz = dz - t * sun.z
      const r = Math.max(q.sx, q.sy)
      const d2 = (px * px + py * py + pz * pz) / (r * r)
      if (d2 < 1) occ += (1 - d2) * q.opacity * (q.ax === 0 && q.ay === 0 && q.az === 0 ? 1 : 0.3)
    }
    return { ...p, shade: Math.exp(-strength * occ) }
  })
}

/**
 * Neighbour-average the shade so light varies across the cloud body, not puff by puff
 * (raw per-puff occlusion reads as a patchwork of bubbles).
 */
export function smoothShade(puffs: readonly Puff[], radiusScale = 0.9): Puff[] {
  return puffs.map((p) => {
    let sum = 0
    let wsum = 0
    const r = Math.max(p.sx, p.sy) * radiusScale
    for (const q of puffs) {
      const d2 = ((q.x - p.x) ** 2 + (q.y - p.y) ** 2 + (q.z - p.z) ** 2) / (r * r)
      if (d2 > 4) continue
      const w = Math.exp(-d2)
      sum += q.shade * w
      wsum += w
    }
    return { ...p, shade: wsum > 0 ? sum / wsum : p.shade }
  })
}

export interface LayoutOptions {
  readonly seed: number
  /** Unit sun direction (toward the sun). */
  readonly sun: Vec3
  /** Horizontal unit vector the upper winds blow toward (anvil shear). */
  readonly windDir: Vec3
}

export function layoutClouds(features: readonly WeatherFeature[], opts: LayoutOptions): Puff[] {
  const out: Puff[] = []
  for (const f of features) {
    const rng = createRng(hashString(f.id) ^ Math.imul(opts.seed | 0, 0x9e3779b1))
    const cluster: Puff[] = []
    switch (f.kind) {
      case 'storm': storm(f, rng, opts.windDir, cluster); break
      case 'updraft': tower(f, rng, cluster); break
      case 'thermal': thermalCap(f, rng, cluster); break
      case 'downdraft': virga(f, rng, cluster); break
      case 'jetstream': alongPath(f.path, f.radius * 0.7, f.thickness * 0.6, 3000, [Math.min(2500, f.radius * 0.12), Math.min(5000, f.radius * 0.3)], [6000, 14_000], 0.24, rng, cluster); break
      case 'wake': alongPath(f.path, f.radius * 0.5, f.radius * 0.1, 1800, [f.radius * 0.1, f.radius * 0.2], [1500, 3000], 0.3, rng, cluster); break
      case 'shear': shearSheet(f, rng, cluster); break
    }
    for (const p of smoothShade(shadeCluster(cluster, opts.sun))) out.push(p)
  }
  return out
}

/**
 * Decorative cloud banks beyond the playable bounds, so the horizon is never empty. Outside the bounds
 * they can't be mistaken for weather the player could use.
 */
export function layoutHorizon(boundsMin: Vec3, boundsMax: Vec3, opts: LayoutOptions): Puff[] {
  const rng = createRng(Math.imul(opts.seed | 0, 0x85ebca6b) ^ 0x5bd1e995)
  const cx = (boundsMin.x + boundsMax.x) / 2
  const cz = (boundsMin.z + boundsMax.z) / 2
  const hx = (boundsMax.x - boundsMin.x) / 2
  const hz = (boundsMax.z - boundsMin.z) / 2
  const out: Puff[] = []
  const banks = 34
  for (let i = 0; i < banks; i++) {
    const a = (i / banks) * Math.PI * 2 + rng() * 0.15
    // Ellipse hugging the bounds, pushed far enough out that even a bank's anvil (~25 km reach) stays outside.
    const d = range(rng, 35_000, 120_000)
    const x = cx + Math.cos(a) * (hx + d)
    const z = cz + Math.sin(a) * (hz + d)
    const cluster: Puff[] = []
    const r = range(rng, 3000, 7000)
    const tall = rng() < 0.3
    const base = range(rng, 900, 1600)
    const top = tall ? range(rng, 9000, 13_000) : base + r * range(rng, 0.8, 1.4)
    if (tall) storm({ center: { x, y: 0, z }, radius: r * 0.8, base, top }, rng, opts.windDir, cluster)
    else cumulusBody(x, z, base, top, (h) => r * (1 - 0.4 * h), r * 0.55, rng, cluster, 0.3)
    for (const p of smoothShade(shadeCluster(cluster, opts.sun))) out.push(p)
  }
  return out
}
