import { DAILY_EPOCH_UTC_MS, WORLD_CEILING_M } from '../core/constants'
import { clamp, lerp, v3 } from '../core/math'
import { createRng, hashInts, hashString } from '../core/rng'
import type { DailyWeather, Route, Vec3, WeatherParams } from '../core/types'
import { ROUTE_CATALOG, type CatalogRoute } from './routes'

const DAY_MS = 86_400_000
const DAILY_SALT = 0x5eed_da17

/** Days since 2026-01-01 UTC, plus one. Uses the absolute instant only, so the local timezone never matters. */
export function dailyNumber(now: Date): number {
  return Math.floor((now.getTime() - DAILY_EPOCH_UTC_MS) / DAY_MS) + 1
}

/** Game length of a route: log-mapped from the real distance so short hops and ultra-longhauls both fit SPEC §10's 80–160 km. */
const GAME_LEN_MIN_M = 90_000
const GAME_LEN_MAX_M = 140_000
const REAL_KM_SHORT = 1_500
const REAL_KM_LONG = 15_000

/**
 * Display time. SPEC §10: 80–160 km of game ≈ 6–12 real minutes ⇒ a reference game cruise of 80 km / 360 s ≈ 222 m/s.
 * Real block time ≈ distance / 850 km/h + 30 min (climb, descent, approach).
 * timeScale = realBlockTimeS / (gameDistanceM / REF_GAME_CRUISE_MS): a pilot flying straight at the reference cruise
 * sees roughly the real-world flight time; faster aircraft or a jet stream beat it, a turboprop won't.
 */
const REF_GAME_CRUISE_MS = 80_000 / 360
const REAL_CRUISE_KMH = 850
const REAL_OVERHEAD_S = 1_800

const TIERS = [
  { severity: 0.2 },
  { severity: 0.5 },
  { severity: 0.85 },
] as const
const SEVERITY_JITTER = 0.05

const GATE_RADIUS_M = 3_000
const BOUNDS_MARGIN_M = 30_000

const roundTo = (x: number, step: number): number => Math.round(x / step) * step

export function realBlockTimeS(realDistanceKm: number): number {
  return (realDistanceKm / REAL_CRUISE_KMH) * 3600 + REAL_OVERHEAD_S
}

function gameLengthM(realDistanceKm: number): number {
  const t = clamp(Math.log(realDistanceKm / REAL_KM_SHORT) / Math.log(REAL_KM_LONG / REAL_KM_SHORT), 0, 1)
  return roundTo(lerp(GAME_LEN_MIN_M, GAME_LEN_MAX_M, t), 100)
}

function layoutRoute(c: CatalogRoute, severity: number, rng: () => number): Route {
  const len = gameLengthM(c.realDistanceKm)
  const zOffset = roundTo((rng() * 2 - 1) * 8_000, 100)
  const startAlt = roundTo(2_000 + rng() * 2_000, 100)
  // Rougher sky, tighter arrival window: the extreme route should ask for skill, not just survival.
  const gateMinAlt = roundTo(1_500 + rng() * 1_000, 100)
  const gateMaxAlt = Math.min(gateMinAlt + roundTo(lerp(4_500, 3_000, severity), 100), 7_000)
  const start = v3(0, startAlt, 0)
  const gate = v3(len, (gateMinAlt + gateMaxAlt) / 2, zOffset)
  const horizontal = Math.hypot(gate.x - start.x, gate.z - start.z)
  const timeScale = Math.round((realBlockTimeS(c.realDistanceKm) / (horizontal / REF_GAME_CRUISE_MS)) * 1000) / 1000
  return {
    id: `${c.from}-${c.to}`.toLowerCase(),
    from: c.from,
    to: c.to,
    start,
    startHeading: v3((gate.x - start.x) / horizontal, 0, (gate.z - start.z) / horizontal),
    gate,
    gateRadius: GATE_RADIUS_M,
    gateMinAlt,
    gateMaxAlt,
    realDistanceKm: c.realDistanceKm,
    timeScale,
    severity,
    label: `${c.from} → ${c.to}`,
  }
}

/** Horizontal box around start and gate with a 30 km margin, ground to world ceiling. */
export function routeBounds(route: Route): { boundsMin: Vec3; boundsMax: Vec3 } {
  return {
    boundsMin: v3(Math.min(route.start.x, route.gate.x) - BOUNDS_MARGIN_M, 0, Math.min(route.start.z, route.gate.z) - BOUNDS_MARGIN_M),
    boundsMax: v3(Math.max(route.start.x, route.gate.x) + BOUNDS_MARGIN_M, WORLD_CEILING_M, Math.max(route.start.z, route.gate.z) + BOUNDS_MARGIN_M),
  }
}

export function dailyWeatherFor(n: number): DailyWeather {
  const seed = hashInts(n, DAILY_SALT)
  const rng = createRng(seed)
  // Partial Fisher–Yates: three distinct city pairs.
  const pool = [...ROUTE_CATALOG]
  const picked: CatalogRoute[] = []
  for (let i = 0; i < TIERS.length; i++) {
    const j = i + Math.floor(rng() * (pool.length - i))
    const tmp = pool[i]!
    pool[i] = pool[j]!
    pool[j] = tmp
    picked.push(pool[i]!)
  }
  const routes = TIERS.map((tier, i) => {
    const severity = Math.round((tier.severity + (rng() * 2 - 1) * SEVERITY_JITTER) * 1000) / 1000
    return layoutRoute(picked[i]!, severity, rng)
  })
  const [calm, moderate, extreme] = routes as [Route, Route, Route]
  const boxes = routes.map(routeBounds)
  return {
    number: n,
    seed,
    routes: [calm, moderate, extreme],
    boundsMin: v3(Math.min(...boxes.map((b) => b.boundsMin.x)), 0, Math.min(...boxes.map((b) => b.boundsMin.z))),
    boundsMax: v3(Math.max(...boxes.map((b) => b.boundsMax.x)), WORLD_CEILING_M, Math.max(...boxes.map((b) => b.boundsMax.z))),
  }
}

export function dailyWeather(now: Date): DailyWeather {
  return dailyWeatherFor(dailyNumber(now))
}

export function weatherParamsFor(daily: DailyWeather, route: Route): WeatherParams {
  return {
    seed: hashInts(daily.seed, hashString(route.id)),
    ...routeBounds(route),
    severity: route.severity,
    corridor: [route.start, route.gate],
  }
}
