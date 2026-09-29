// Flight planning a skilled pilot does before takeoff: which cruise altitude pays, given the climb it
// costs, the wind it buys, and the descent it forces before the gate window. Uses only published
// aircraft numbers (trimLevel) and the wind the sky shows along the route (sample()).
import { GRAVITY } from '../core/constants'
import { clamp, v3 } from '../core/math'
import type { AircraftSpec, MutableWeatherSample, Route, Vec3, WeatherField } from '../core/types'
import { airDensity, trimLevel } from '../flight'
import { speedEnvelope } from './control'

const RHO0 = airDensity(0)
const thrustAvailable = (spec: AircraftSpec, h: number): number => spec.maxThrustN * Math.pow(airDensity(h) / RHO0, 0.9)

export interface Performance {
  /** Airspeed with the best climb rate at full throttle, and that rate (m/s). */
  climb(h: number): { speed: number; rate: number }
  /** Fastest airspeed ≤ cruise sustainable at `maxThrottle` in level flight. */
  cruiseSpeed(h: number, maxThrottle?: number): number
  /** Trim throttle for level flight. */
  trim(h: number, speed: number): number
  /** Airspeed minimising fuel per ground meter with a tailwind component `tail`. */
  rangeSpeed(h: number, tail: number): number
  /** Idle descent slope at cruise speed (drag / weight). */
  readonly idleSlope: number
  /** Minimum-drag (best glide) airspeed at altitude h. */
  glideSpeed(h: number): number
  /** Full-throttle thrust over weight at altitude h. */
  thrustToWeight(h: number): number
}

/** Cached performance tables derived from the spec only. */
export function performanceOf(spec: AircraftSpec): Performance {
  const cache = new Map<string, number>()
  const memo = (key: string, f: () => number): number => {
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    const v = f()
    cache.set(key, v)
    return v
  }
  const band = (h: number): number => Math.round(clamp(h, 0, 14_000) / 250) * 250
  const trim = (h: number, speed: number): number => trimLevel(spec, h, speed).throttle
  const speeds = (h: number): number[] => {
    const env = speedEnvelope(spec, h, 0)
    const out: number[] = []
    for (let v = env.minTas; v <= Math.min(env.maxTas, spec.cruiseSpeedMs * 1.15); v += 4) out.push(v)
    return out
  }
  const climbAt = (h: number): { speed: number; rate: number } => {
    const hb = band(h)
    const speed = memo(`cs${hb}`, () => {
      let best = spec.cruiseSpeedMs
      let bestRate = -Infinity
      for (const v of speeds(hb)) {
        const rate = ((1 - trim(hb, v)) * thrustAvailable(spec, hb) * v) / (spec.massKg * GRAVITY)
        if (rate > bestRate) {
          bestRate = rate
          best = v
        }
      }
      return best
    })
    const rate = memo(`cr${hb}`, () => ((1 - trim(hb, speed)) * thrustAvailable(spec, hb) * speed) / (spec.massKg * GRAVITY))
    return { speed, rate }
  }
  const cruiseSpeed = (h: number, maxThrottle = 0.9): number =>
    memo(`cv${band(h)}:${maxThrottle}`, () => {
      let v = spec.cruiseSpeedMs
      const floor = speedEnvelope(spec, band(h), 0).minTas * 1.1
      while (v > floor && trim(band(h), v) > maxThrottle) v -= 4
      return Math.max(v, floor)
    })
  const rangeSpeed = (h: number, tail: number): number =>
    memo(`rs${band(h)}:${Math.round(tail / 4)}`, () => {
      let best = spec.cruiseSpeedMs
      let bestCost = Infinity
      for (const v of speeds(band(h))) {
        const t = trim(band(h), v)
        if (t > 1) continue
        const cost = Math.max(t, 0.02) / Math.max(v + tail, 10)
        if (cost < bestCost) {
          bestCost = cost
          best = v
        }
      }
      return best
    })
  const glideSpeed = (h: number): number =>
    memo(`gs${band(h)}`, () => {
      let best = spec.cruiseSpeedMs
      let bestDrag = Infinity
      for (const v of speeds(band(h))) {
        const d = trim(band(h), v)
        if (d < bestDrag) {
          bestDrag = d
          best = v
        }
      }
      return best
    })
  const idleSlope = clamp((trim(5000, spec.cruiseSpeedMs) * thrustAvailable(spec, 5000)) / (spec.massKg * GRAVITY), 0.04, 0.2)
  return {
    climb: climbAt,
    cruiseSpeed,
    trim: (h, v) => trim(band(h), v),
    rangeSpeed,
    idleSlope,
    glideSpeed,
    thrustToWeight: (h) => thrustAvailable(spec, h) / (spec.massKg * GRAVITY),
  }
}

export interface AltitudeOption {
  readonly altitude: number
  /** Estimated flight time (s) and fuel (kg). */
  readonly timeS: number
  readonly fuelKg: number
  /** Mean tailwind along the cruise leg (m/s). */
  readonly tailwind: number
  /** Mean turbulence along the cruise leg. */
  readonly turbulence: number
  readonly feasible: boolean
}

/**
 * Estimate time and fuel for cruising at each candidate altitude: full-throttle climb at best-climb
 * speed, cruise with the route's wind at that altitude, idle descent into the gate window.
 */
export function altitudeOptions(
  spec: AircraftSpec,
  route: Route,
  weather: WeatherField,
  perf: Performance,
  gateAlt: number,
  candidates: readonly number[],
  lateral: (x: number, h: number) => number = () => NaN,
): AltitudeOption[] {
  const sample: MutableWeatherSample = { wind: { x: 0, y: 0, z: 0 }, turbulence: 0, dominant: null, cloud: 0 }
  const L = Math.hypot(route.gate.x - route.start.x, route.gate.z - route.start.z)
  const ux = (route.gate.x - route.start.x) / L
  const uz = (route.gate.z - route.start.z) / L
  const along = (s: number, h: number): Vec3 => {
    const x = route.start.x + ux * s
    const z = lateral(x, h)
    return v3(x, h, Number.isNaN(z) ? route.start.z + uz * s : z)
  }
  const h0 = route.start.y
  return candidates.map((H) => {
    let t = 0
    let fuel = 0
    let x = 0
    // Climb (or level-off descent from the start altitude) in 250 m slices.
    if (H > h0) {
      for (let h = h0; h < H; h += 250) {
        const c = perf.climb(h)
        if (c.rate < 0.5) return { altitude: H, timeS: Infinity, fuelKg: Infinity, tailwind: 0, turbulence: 0, feasible: false }
        const dt = Math.min(250, H - h) / c.rate
        const w = weather.sample(along(x, h), 0, sample).wind
        t += dt
        x += (c.speed + w.x * ux + w.z * uz) * dt
        fuel += spec.fuelBurnFullKgS * dt
      }
    } else if (H < h0) {
      const sd = (h0 - H) / (perf.idleSlope * 0.7)
      x += sd
      t += sd / spec.cruiseSpeedMs
      fuel += 0.05 * spec.fuelBurnFullKgS * t
    }
    const descent = Math.max(0, H - gateAlt) / (perf.idleSlope * 0.7)
    const cruiseLen = L - route.gateRadius - x - descent
    if (cruiseLen < 0) return { altitude: H, timeS: Infinity, fuelKg: Infinity, tailwind: 0, turbulence: 0, feasible: false }
    const v = perf.cruiseSpeed(H)
    let tail = 0
    let turb = 0
    const n = 16
    for (let i = 0; i < n; i++) {
      const s = x + ((i + 0.5) / n) * cruiseLen
      const w = weather.sample(along(s, H), 0, sample)
      tail += (w.wind.x * ux + w.wind.z * uz) / n
      turb += w.turbulence / n
    }
    const tc = cruiseLen / Math.max(v + tail, 30)
    t += tc
    fuel += perf.trim(H, v) * spec.fuelBurnFullKgS * tc
    // Descent at near-idle, cruise speed plus average tailwind.
    const td = descent / Math.max(spec.cruiseSpeedMs + tail * 0.6, 30)
    t += td
    fuel += 0.1 * spec.fuelBurnFullKgS * td
    return { altitude: H, timeS: t, fuelKg: fuel, tailwind: tail, turbulence: turb, feasible: true }
  })
}
