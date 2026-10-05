// The day's light (SkyParams, drawn per WORLD WEATHER day) → every colour and direction the world is lit
// with. Art-directed key palettes blended by sun height and warmth, then hazed. Pure: setSky calls it
// once per day change; nothing here runs per frame.
import * as THREE from 'three'
import type { SkyParams } from '../core/types'

type RGB = readonly [number, number, number]

/** Linear HDR colours (same scale as the pre-wave-6 PALETTE; exposure 0.85, ACES). */
interface Palette {
  readonly zenith: RGB
  readonly midSky: RGB
  readonly horizonSun: RGB
  readonly horizonAway: RGB
  readonly belowHorizon: RGB
  readonly sun: RGB
  /** Tint of the halo around the sun, on top of the sun colour. */
  readonly glowTint: RGB
  /** Blue-violet light filling cloud shadows. */
  readonly cloudShadow: RGB
  /** Ambient on sunlit cloud tops (sky dome contribution). */
  readonly cloudAmbient: RGB
  readonly seaDeep: RGB
  readonly inCloud: RGB
  /** Shadow side of contrails. */
  readonly contrailShade: RGB
  /** Aircraft lights (three's built-in lighting). */
  readonly light: RGB
  readonly hemiSky: RGB
  readonly hemiGround: RGB
}

/** The look the game shipped with before days had their own light: warmth 0.7 at a low sun. Kept verbatim. */
const LOW_TODAY: Palette = {
  zenith: [0.05, 0.13, 0.36],
  midSky: [0.2, 0.36, 0.7],
  horizonSun: [1.3, 0.78, 0.45],
  horizonAway: [0.62, 0.66, 0.82],
  belowHorizon: [0.3, 0.36, 0.5],
  sun: [2.0, 1.25, 0.66],
  glowTint: [1.0, 0.85, 0.7],
  cloudShadow: [0.12, 0.14, 0.26],
  cloudAmbient: [0.5, 0.58, 0.8],
  seaDeep: [0.012, 0.045, 0.1],
  inCloud: [0.78, 0.78, 0.82],
  contrailShade: [0.6, 0.66, 0.8],
  light: [1.0, 0.8, 0.6],
  hemiSky: [0.55, 0.65, 0.85],
  hemiGround: [0.12, 0.16, 0.22],
}

/** Low sun, white light: a crisp, silvery morning. */
const LOW_NEUTRAL: Palette = {
  zenith: [0.052, 0.145, 0.42],
  midSky: [0.178, 0.35, 0.83],
  horizonSun: [1.45, 1.4, 1.3],
  horizonAway: [0.54, 0.73, 1.12],
  belowHorizon: [0.28, 0.35, 0.5],
  sun: [2.2, 2.0, 1.7],
  glowTint: [1.0, 0.94, 0.86],
  cloudShadow: [0.114, 0.144, 0.264],
  cloudAmbient: [0.43, 0.62, 1.06],
  seaDeep: [0.01, 0.045, 0.105],
  inCloud: [1.0, 1.16, 1.6],
  contrailShade: [0.44, 0.58, 1.0],
  light: [1.0, 0.93, 0.84],
  hemiSky: [0.52, 0.66, 0.9],
  hemiGround: [0.11, 0.16, 0.23],
}

/** Deep golden hour: amber horizon under the sun, dusty rose opposite, violet cloud shadows. */
const LOW_GOLDEN: Palette = {
  zenith: [0.054, 0.113, 0.31],
  midSky: [0.158, 0.244, 0.53],
  horizonSun: [1.85, 0.36, 0.05],
  horizonAway: [0.84, 0.45, 0.64],
  belowHorizon: [0.29, 0.236, 0.32],
  sun: [2.4, 0.9, 0.24],
  glowTint: [1.0, 0.62, 0.32],
  cloudShadow: [0.141, 0.119, 0.258],
  cloudAmbient: [0.52, 0.41, 0.79],
  seaDeep: [0.014, 0.04, 0.09],
  inCloud: [1.4, 1.0, 0.85],
  contrailShade: [0.52, 0.44, 0.79],
  light: [1.0, 0.62, 0.34],
  hemiSky: [0.58, 0.56, 0.8],
  hemiGround: [0.14, 0.14, 0.2],
}

/** Clean bright midday. */
const HIGH_NEUTRAL: Palette = {
  zenith: [0.048, 0.157, 0.55],
  midSky: [0.108, 0.356, 1.18],
  horizonSun: [0.99, 1.43, 2.43],
  horizonAway: [0.485, 0.92, 1.92],
  belowHorizon: [0.267, 0.393, 0.646],
  sun: [2.5, 2.4, 2.25],
  glowTint: [1.0, 0.97, 0.93],
  cloudShadow: [0.175, 0.226, 0.386],
  cloudAmbient: [0.57, 0.8, 1.48],
  seaDeep: [0.012, 0.06, 0.14],
  inCloud: [1.37, 1.7, 2.42],
  contrailShade: [0.52, 0.76, 1.37],
  light: [1.0, 0.97, 0.93],
  hemiSky: [0.6, 0.74, 1.0],
  hemiGround: [0.16, 0.22, 0.3],
}

/** High sun in golden light: a warm summer afternoon. */
const HIGH_WARM: Palette = {
  zenith: [0.061, 0.162, 0.47],
  midSky: [0.184, 0.359, 0.83],
  horizonSun: [2.44, 1.11, 0.46],
  horizonAway: [0.98, 0.83, 1.05],
  belowHorizon: [0.327, 0.35, 0.454],
  sun: [2.5, 1.85, 1.15],
  glowTint: [1.0, 0.87, 0.7],
  cloudShadow: [0.185, 0.191, 0.335],
  cloudAmbient: [0.7, 0.67, 1.06],
  seaDeep: [0.014, 0.055, 0.12],
  inCloud: [2.07, 1.54, 1.19],
  contrailShade: [0.76, 0.7, 1.06],
  light: [1.0, 0.85, 0.66],
  hemiSky: [0.64, 0.7, 0.92],
  hemiGround: [0.17, 0.2, 0.27],
}

/** Warmth of LOW_TODAY on the warmth axis. */
const TODAY_WARMTH = 0.7
/** Haze of the shipped look: the fog below reproduces it exactly. */
const TODAY_HAZE = 0.4
/** Sun heights where the palette is fully "low" (golden-hour light) / fully "high" (day light). */
const LOW_DEG = 8
const HIGH_DEG = 26

/** The shipped look: what render shows before the first setSky call. */
export const DEFAULT_SKY: SkyParams = { sunElevationDeg: 8, sunAzimuthDeg: 20, haze: TODAY_HAZE, warmth: TODAY_WARMTH }

export interface SkyLook {
  /** Unit vector toward the sun (world frame). */
  readonly sunDir: THREE.Vector3
  readonly sun: THREE.Color
  /** Halo colour around the sun. */
  readonly sunGlow: THREE.Color
  /** Halo lobe weights: broad, medium, tight. Haze widens the halo. */
  readonly halo: THREE.Vector3
  readonly zenith: THREE.Color
  readonly midSky: THREE.Color
  readonly horizonSun: THREE.Color
  readonly horizonAway: THREE.Color
  readonly belowHorizon: THREE.Color
  /** Exponent of the horizon band: lower = a thicker, milkier band. */
  readonly horizonPow: number
  /** Height fog: density at sea level (1/m), scale height (m), altitude-independent floor (1/m). */
  readonly fog: THREE.Vector3
  readonly cloudShadow: THREE.Color
  readonly cloudAmbient: THREE.Color
  readonly seaDeep: THREE.Color
  readonly inCloud: THREE.Color
  readonly contrailShade: THREE.Color
  readonly light: THREE.Color
  readonly lightIntensity: number
  readonly hemiSky: THREE.Color
  readonly hemiGround: THREE.Color
  readonly hemiIntensity: number
  /** Built-in FogExp2 for third-party layers (flow particles): an approximate match of the haze. */
  readonly sceneFog: THREE.Color
  readonly sceneFogDensity: number
}

const deg = Math.PI / 180
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))
const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

/** Compass bearing (0 = north = −z, 90 = east = +x) and elevation → unit vector toward the sun. */
export function sunDirection(elevationDeg: number, azimuthDeg: number): THREE.Vector3 {
  const el = elevationDeg * deg
  const az = azimuthDeg * deg
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el))
}

/**
 * Geometric blend: light mixes multiplicatively. A linear blend of a blue-white noon horizon and an amber
 * one goes through magenta-grey; the geometric one goes through warm white.
 */
const mixRGB = (a: RGB, b: RGB, t: number): RGB => {
  const g = (x: number, y: number): number => Math.max(x, 1e-4) ** (1 - t) * Math.max(y, 1e-4) ** t
  return [g(a[0], b[0]), g(a[1], b[1]), g(a[2], b[2])]
}

function mixPalette(a: Palette, b: Palette, t: number): Palette {
  const out: Record<string, RGB> = {}
  for (const k of Object.keys(a) as (keyof Palette)[]) out[k] = mixRGB(a[k], b[k], t)
  return out as unknown as Palette
}

const color = (c: RGB): THREE.Color => new THREE.Color(c[0], c[1], c[2])
const luma = (c: THREE.Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
/** Scale chroma around the luma (s > 1 = richer, s < 1 = greyer). */
const saturate = (c: THREE.Color, s: number): THREE.Color => {
  const y = luma(c)
  return c.set(Math.max(0, y + (c.r - y) * s), Math.max(0, y + (c.g - y) * s), Math.max(0, y + (c.b - y) * s))
}

export function skyLook(sky: SkyParams): SkyLook {
  const elevation = Math.min(40, Math.max(6, sky.sunElevationDeg))
  const warmth = clamp01(sky.warmth)
  const haze = clamp01(sky.haze)
  const high = smoothstep(LOW_DEG, HIGH_DEG, elevation)
  const low = warmth <= TODAY_WARMTH
    ? mixPalette(LOW_NEUTRAL, LOW_TODAY, warmth / TODAY_WARMTH)
    : mixPalette(LOW_TODAY, LOW_GOLDEN, (warmth - TODAY_WARMTH) / (1 - TODAY_WARMTH))
  const p = mixPalette(low, mixPalette(HIGH_NEUTRAL, HIGH_WARM, warmth), high)

  const zenith = color(p.zenith)
  const midSky = color(p.midSky)
  const horizonSun = color(p.horizonSun)
  const horizonAway = color(p.horizonAway)
  const belowHorizon = color(p.belowHorizon)
  const sun = color(p.sun)
  const sunGlow = color(p.sun).multiply(color(p.glowTint))
  const cloudShadow = color(p.cloudShadow)
  const cloudAmbient = color(p.cloudAmbient)
  // A low sun shines through a long, bright aureole; a high one keeps a tight halo.
  const halo = new THREE.Vector3(0.1 * (1 - 0.6 * high), 0.45 * (1 - 0.5 * high), 1.2)
  // A high sun lets the blue come down: the pale horizon band thins.
  let horizonPow = 6 + 1.5 * high

  // Haze, relative to the shipped look. Milky: the dome pales from the horizon up, the halo spreads,
  // shadows soften. Clear: richer blues, a thin horizon band, a tight sun.
  const milk = Math.max(0, haze - TODAY_HAZE) / (1 - TODAY_HAZE)
  const clear = Math.max(0, TODAY_HAZE - haze) / TODAY_HAZE
  if (milk > 0) {
    const pale = horizonAway.clone()
    zenith.lerp(midSky, 0.45 * milk)
    midSky.lerp(pale, 0.45 * milk)
    saturate(horizonAway, 1 - 0.2 * milk).multiplyScalar(1 + 0.08 * milk)
    saturate(horizonSun, 1 - 0.15 * milk)
    belowHorizon.lerp(pale.multiplyScalar(0.75), 0.4 * milk)
    halo.multiply(new THREE.Vector3(1 + 2.5 * milk, 1 + 0.8 * milk, 1 - 0.35 * milk))
    horizonPow -= 2.5 * milk
    sun.multiplyScalar(1 - 0.2 * milk)
    sunGlow.multiplyScalar(1 + 0.25 * milk)
    // Milky air is full of diffuse light: shadows open up instead of greying out.
    cloudShadow.lerp(cloudAmbient.clone().multiplyScalar(0.9), 0.7 * milk)
    cloudAmbient.multiplyScalar(1 + 0.3 * milk)
  }
  if (clear > 0) {
    saturate(zenith, 1 + 0.15 * clear).multiplyScalar(1 - 0.1 * clear)
    saturate(midSky, 1 + 0.15 * clear)
    saturate(horizonAway, 1 + 0.1 * clear)
    halo.multiply(new THREE.Vector3(1 - 0.5 * clear, 1 - 0.3 * clear, 1))
    horizonPow += 2 * clear
  }

  // Height fog, exponential in haze so each step of haze reads as a similar change of visibility.
  // At 5 km: ~260 km visibility crystal clear, ~90 km shipped, ~20 km milky.
  const dh = haze - TODAY_HAZE
  const fog = new THREE.Vector3(1.6e-4 * Math.exp(1.459 * dh), 1300 + 600 * dh, 0.75e-5 * Math.exp(2.31 * dh))

  const sceneFog = horizonAway.clone().lerp(horizonSun, 0.3).multiplyScalar(0.8)
  return {
    sunDir: sunDirection(elevation, sky.sunAzimuthDeg),
    sun,
    sunGlow,
    halo,
    zenith,
    midSky,
    horizonSun,
    horizonAway,
    belowHorizon,
    horizonPow,
    fog,
    cloudShadow,
    cloudAmbient,
    seaDeep: color(p.seaDeep),
    inCloud: color(p.inCloud),
    contrailShade: color(p.contrailShade),
    light: color(p.light),
    lightIntensity: 3.2 + 0.5 * high,
    hemiSky: color(p.hemiSky),
    hemiGround: color(p.hemiGround),
    hemiIntensity: 1.3 + 0.15 * high,
    sceneFog,
    sceneFogDensity: 1.4e-5 * (fog.z / 0.75e-5),
  }
}

/** Value equality on the contract fields: same day's light twice is a no-op for setSky. */
export const sameSky = (a: SkyParams, b: SkyParams): boolean =>
  a.sunElevationDeg === b.sunElevationDeg && a.sunAzimuthDeg === b.sunAzimuthDeg && a.haze === b.haze && a.warmth === b.warmth
