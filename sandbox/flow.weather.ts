// Sandbox-only: the fixture plus the feature kinds it lacks (thermal, shear, wake, storm), a fast
// high jet and gust noise everywhere — closer to what the real generator will throw at the flow layer.
// Crude analytic shapes; this is a visual test bench, not weather.
import { createFixtureWeather } from '../src/core/fixtures'
import type { MutableWeatherSample, Vec3, WeatherField, WeatherSample } from '../src/core/types'

const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1)
  return t * t * (3 - 2 * t)
}

export const RICH_SPOTS = {
  thermal: { x: 15_000, y: 1800, z: -3000 },
  shear: { x: 68_000, y: 6000, z: 0 },
  wake: { x: 64_000, y: 5000, z: -6000 },
  storm: { x: 85_000, y: 5000, z: -4000 },
  highJet: { x: 40_000, y: 11_000, z: -8000 },
} as const

export function createRichWeather(seed = 1): WeatherField {
  const base = createFixtureWeather(seed)
  const sample = (p: Vec3, t: number, out?: MutableWeatherSample): WeatherSample => {
    const o = base.sample(p, t, out) as MutableWeatherSample
    let turb = o.turbulence
    let dominant = o.dominant

    // Gust noise everywhere: a few m/s, slowly varying.
    o.wind.x += 2.5 * Math.sin(p.x * 0.0011 + t * 0.4) * Math.cos(p.z * 0.0009)
    o.wind.y += 1.2 * Math.sin(p.z * 0.0013 + p.x * 0.0007 + t * 0.3)
    o.wind.z += 2.0 * Math.cos(p.y * 0.002 + p.x * 0.0005 + t * 0.2)
    turb = Math.max(turb, 0.12 + 0.08 * Math.sin(p.x * 0.0004 + p.y * 0.001))

    // Thermal: soft, wide, weak.
    {
      const c = RICH_SPOTS.thermal
      const r = Math.hypot(p.x - c.x, p.z - c.z) / 1400
      if (r < 1.5 && p.y > 200 && p.y < 3600) {
        const k = Math.exp(-r * r * 2) * smooth(200, 700, p.y) * (1 - smooth(3000, 3600, p.y))
        o.wind.y += 4 * k
        turb = Math.max(turb, 0.2 * k)
        if (k > 0.3) dominant = 'thermal'
      }
    }
    // Shear layer: wind turns to the south across 400 m.
    if (p.x > 58_000 && p.x < 78_000 && Math.abs(p.z) < 8000) {
      const s = smooth(5800, 6200, p.y)
      o.wind.z += 22 * s
      const inLayer = Math.exp(-(((p.y - 6000) / 250) ** 2))
      turb = Math.max(turb, 0.35 * inLayer)
      if (inLayer > 0.3) dominant = 'shear'
    }
    // Wake: two counter-rotating vortices along +x.
    if (p.x > 58_000 && p.x < 70_000) {
      const c = RICH_SPOTS.wake
      const rc = 60
      for (let side = -1; side <= 1; side += 2) {
        const dy = p.y - c.y
        const dz = p.z - (c.z + side * 150)
        const r2 = dy * dy + dz * dz
        const v = (side * 14 * 150) / (r2 / 150 + rc)
        o.wind.y += -dz * v / 150
        o.wind.z += dy * v / 150
        if (r2 < 400 * 400) {
          dominant = 'wake'
          turb = Math.max(turb, 0.45 * Math.exp(-r2 / (250 * 250)))
        }
      }
    }
    // Storm: updraft ring, downdraft core, violent turbulence.
    {
      const c = RICH_SPOTS.storm
      const r = Math.hypot(p.x - c.x, p.z - c.z) / 4000
      if (r < 1.3 && p.y > 1000 && p.y < 11_000) {
        const v = smooth(1000, 2000, p.y) * (1 - smooth(9500, 11_000, p.y))
        o.wind.y += v * (22 * Math.exp(-((r - 0.75) ** 2) * 20) - 14 * Math.exp(-r * r * 8))
        turb = Math.max(turb, 0.9 * v * Math.exp(-r * r))
        if (r < 1) dominant = 'storm'
        o.cloud = Math.max(o.cloud, v * (1 - r))
      }
    }
    // High fast jet: 85 m/s at 11 km.
    {
      const c = RICH_SPOTS.highJet
      const d = Math.hypot(p.y - c.y, p.z - c.z) / 1200
      const k = Math.exp(-d * d * 2)
      o.wind.x += 85 * k
      o.wind.z += 10 * k
      if (k > 0.3) dominant = 'jetstream'
      turb = Math.max(turb, 0.3 * Math.exp(-(d - 1) * (d - 1) * 4))
    }

    o.turbulence = Math.min(turb, 1)
    o.dominant = dominant
    return o
  }
  return { seed, boundsMin: base.boundsMin, boundsMax: base.boundsMax, features: base.features, sample }
}
