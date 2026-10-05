// What the air was doing along a ghost's track, in the wind particles' colour language
// (src/flow/shaders.ts): rising air amber, sinking air indigo, jet stream teal → violet, storm magenta,
// calm air left to the ghost's own thread. Sampled once per setGhosts / setWeather, never per frame.
import type { MutableWeatherSample, WeatherField, WeatherFeatureKind } from '../core/types'

type RGB = readonly [number, number, number]
type Kind = WeatherFeatureKind | 'none'

/** sRGB, copied from flow's KIND_COLOR (trailAir.test.ts fails if the two drift apart). */
export const AIR_COLOR: Readonly<Record<Kind, RGB>> = {
  none: [0.97, 0.98, 1.0],
  updraft: [1.0, 0.42, 0.06],
  downdraft: [0.16, 0.26, 0.95],
  thermal: [1.0, 0.6, 0.3],
  jetstream: [0.1, 0.9, 0.78],
  shear: [0.05, 0.7, 0.8],
  wake: [0.62, 0.45, 1.0],
  storm: [0.78, 0.1, 0.55],
}
/** Flow's vertical-wind tint, applied to every kind but the vertical columns themselves. */
export const RISING: RGB = [1.0, 0.55, 0.18]
export const SINKING: RGB = [0.22, 0.3, 0.86]
/** Flow's jet aurora: hue drifts along the ribbon with world position. */
export const AURORA: readonly [RGB, RGB] = [[0.05, 0.78, 0.62], [0.5, 0.3, 0.95]]

/** How loud a feature label alone makes the trail (0..1); the measured vertical wind can only raise it. */
const VOICE: Readonly<Record<Kind, number>> = { none: 0, updraft: 0.45, downdraft: 0.45, thermal: 0.45, jetstream: 0.8, shear: 0.5, wake: 0.5, storm: 0.9 }
/** Gaussian smoothing along the track, in trail points: features are kilometres wide, gusts are not. */
const SIGMA = 1.5

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}
const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

/**
 * points: xyz per track point, stamps: its sim time (the weather is sampled where and when the ghost was).
 * Returns rgba per point: linear rgb of the air, a = strength 0 (calm) … 1 (the air did the flying).
 */
export function airTints(points: Float32Array, stamps: Float32Array, count: number, weather: WeatherField): Float32Array {
  // Strength-weighted colour, so a strong segment keeps its hue while its edges fade into calm.
  const raw = new Float32Array(count * 4)
  const sample: MutableWeatherSample = { wind: { x: 0, y: 0, z: 0 }, turbulence: 0, dominant: null, cloud: 0 }
  const p = { x: 0, y: 0, z: 0 }
  for (let i = 0; i < count; i++) {
    p.x = points[i * 3]!
    p.y = points[i * 3 + 1]!
    p.z = points[i * 3 + 2]!
    weather.sample(p, stamps[i]!, sample)
    const kind: Kind = sample.dominant ?? 'none'
    const up = smoothstep(1.5, 9, sample.wind.y)
    const down = smoothstep(1.5, 9, -sample.wind.y)
    let r: number, g: number, b: number
    if (kind === 'jetstream') {
      const w = 0.5 + 0.5 * Math.sin(p.x * 0.0002 + p.y * 0.0015 + p.z * 0.00025)
      r = AURORA[0][0] + (AURORA[1][0] - AURORA[0][0]) * w
      g = AURORA[0][1] + (AURORA[1][1] - AURORA[0][1]) * w
      b = AURORA[0][2] + (AURORA[1][2] - AURORA[0][2]) * w
    } else {
      ;[r, g, b] = AIR_COLOR[kind]
    }
    if (kind !== 'updraft' && kind !== 'downdraft') {
      const k = kind === 'storm' ? 0.3 : 0.7
      r += (RISING[0] - r) * up * k
      g += (RISING[1] - g) * up * k
      b += (RISING[2] - b) * up * k
      r += (SINKING[0] - r) * down * k
      g += (SINKING[1] - g) * down * k
      b += (SINKING[2] - b) * down * k
    }
    const s = Math.min(1, Math.max(VOICE[kind], up, down))
    raw[i * 4] = r * s
    raw[i * 4 + 1] = g * s
    raw[i * 4 + 2] = b * s
    raw[i * 4 + 3] = s
  }

  const out = new Float32Array(count * 4)
  const reach = Math.ceil(SIGMA * 3)
  for (let i = 0; i < count; i++) {
    let r = 0, g = 0, b = 0, s = 0, wsum = 0
    for (let j = Math.max(0, i - reach); j <= Math.min(count - 1, i + reach); j++) {
      const w = Math.exp(-((j - i) ** 2) / (2 * SIGMA * SIGMA))
      r += raw[j * 4]! * w
      g += raw[j * 4 + 1]! * w
      b += raw[j * 4 + 2]! * w
      s += raw[j * 4 + 3]! * w
      wsum += w
    }
    if (s > 1e-6) {
      out[i * 4] = toLinear(r / s)
      out[i * 4 + 1] = toLinear(g / s)
      out[i * 4 + 2] = toLinear(b / s)
    }
    out[i * 4 + 3] = s / wsum
  }
  return out
}
