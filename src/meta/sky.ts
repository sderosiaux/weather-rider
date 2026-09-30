// The day's light (SPEC §9: contemplative, always daylight). It hangs off the daily seed on its own stream,
// so it never moves a route or a weather feature: balance only ever sees DailyWeather.seed and the routes.
import { clamp, lerp, smoothstep } from '../core/math'
import { createRng, hashInts } from '../core/rng'
import type { SkyParams } from '../core/types'

const SKY_SALT = 0x5c1e_da75

const ELEVATION_MIN_DEG = 6
const GOLDEN_END_DEG = 14
const HIGH_SUN_DEG = 30
const ELEVATION_MAX_DEG = 40
/** Share of days per elevation band, uniform inside each: half golden hour, 15 % high sun (the art direction caps it near a fifth). */
const ELEVATION_BANDS = [
  { share: 0.5, from: ELEVATION_MIN_DEG, to: GOLDEN_END_DEG },
  { share: 0.35, from: GOLDEN_END_DEG, to: HIGH_SUN_DEG },
  { share: 0.15, from: HIGH_SUN_DEG, to: ELEVATION_MAX_DEG },
] as const
/** Sun ahead of or beside the eastbound track (backlit clouds, sea glitter) on 4 days out of 5; anywhere else, behind included, otherwise. */
const FRONT_SHARE = 0.8
const FRONT_MIN_DEG = 30
const FRONT_MAX_DEG = 150
const HAZE_MIN = 0.15
const HAZE_MAX = 0.7
/** Warmth is the elevation's colour: deep gold on the horizon, neutral under a high sun, plus a little noise. */
const WARMTH_NOISE = 0.08

/** Contrast 1 = one clearly visible change: the sun a third of the screen away (30°), the light 0.3 warmer or cooler, the air 0.3 clearer or milkier, or a mix. */
const SUN_SCALE_DEG = 30
const WARMTH_SCALE = 0.3
const HAZE_SCALE = 0.3
const MIN_CONTRAST = 1
const MAX_DRAWS = 16

/** Divide the rounded integer (never multiply by 0.1): the result is the double nearest the decimal, so it prints short. */
const decimals = (x: number, places: number): number => Math.round(x * 10 ** places) / 10 ** places

/** Inverse CDF of the bands: one uniform draw in, a continuous elevation out. */
function elevationAt(u: number): number {
  let below = 0
  for (const band of ELEVATION_BANDS) {
    if (u < below + band.share) return lerp(band.from, band.to, (u - below) / band.share)
    below += band.share
  }
  return ELEVATION_MAX_DEG
}

/** One draw of the day's distribution, knowing nothing about other days. Rounded so what is compared is what is shipped. */
function drawSky(daySeed: number, draw: number): SkyParams {
  const rng = createRng(hashInts(daySeed, SKY_SALT, draw))
  const elevation = elevationAt(rng())
  const azimuth = rng() < FRONT_SHARE
    ? lerp(FRONT_MIN_DEG, FRONT_MAX_DEG, rng())
    : FRONT_MAX_DEG + rng() * (360 - (FRONT_MAX_DEG - FRONT_MIN_DEG))
  const haze = lerp(HAZE_MIN, HAZE_MAX, rng())
  const warmth = clamp(1 - smoothstep(ELEVATION_MIN_DEG, HIGH_SUN_DEG, elevation) + (rng() * 2 - 1) * WARMTH_NOISE, 0, 1)
  return {
    sunElevationDeg: decimals(elevation, 1),
    sunAzimuthDeg: decimals(azimuth % 360, 1) % 360,
    haze: decimals(haze, 2),
    warmth: decimals(warmth, 2),
  }
}

const RAD = Math.PI / 180

/** Angle between the two suns on the sky dome. Haversine, like routes.ts: exact near zero, where acos of a dot product is not. */
function sunAngleDeg(a: SkyParams, b: SkyParams): number {
  const ea = a.sunElevationDeg * RAD
  const eb = b.sunElevationDeg * RAD
  const h = Math.sin((eb - ea) / 2) ** 2 + Math.cos(ea) * Math.cos(eb) * Math.sin(((b.sunAzimuthDeg - a.sunAzimuthDeg) * RAD) / 2) ** 2
  return (2 * Math.asin(Math.min(1, Math.sqrt(h)))) / RAD
}

/** How different two skies look; ≥ 1 reads as another day. */
export function skyContrast(a: SkyParams, b: SkyParams): number {
  return Math.hypot(sunAngleDeg(a, b) / SUN_SCALE_DEG, (a.warmth - b.warmth) / WARMTH_SCALE, (a.haze - b.haze) / HAZE_SCALE)
}

/**
 * Day n's sky. Independent draws make ~7 % of consecutive days look alike, so even days keep their first draw and
 * odd days redraw until they stand apart from both neighbours (which are never redrawn): every pair of consecutive
 * days is checked, and a day depends on its neighbours' first draws only, never on a chain back in time.
 * MAX_DRAWS is a safety net (then the most distinct draw wins); ~13 % of odd days need a second draw.
 */
export function daySky(n: number, seedOf: (day: number) => number): SkyParams {
  const first = drawSky(seedOf(n), 0)
  if ((n & 1) === 0) return first
  const neighbours = [drawSky(seedOf(n - 1), 0), drawSky(seedOf(n + 1), 0)]
  const apart = (s: SkyParams): number => Math.min(...neighbours.map((m) => skyContrast(s, m)))
  let best = first
  let bestApart = apart(first)
  for (let draw = 1; draw < MAX_DRAWS && bestApart < MIN_CONTRAST; draw++) {
    const candidate = drawSky(seedOf(n), draw)
    const d = apart(candidate)
    if (d > bestApart) {
      best = candidate
      bestApart = d
    }
  }
  return best
}
