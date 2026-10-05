// Sandbox-only bench for ghost decision trails (?scene=decisions): an analytic sky with one feature of
// each kind the trails speak about, and two scripted ghosts that make opposite choices through it.
// Crude shapes on purpose; this is a visual test bench, not weather.
import { clamp, qFromAxisAngle, qMul, smoothstep, v3 } from '../src/core/math'
import { fixtureAircraft, fixtureFlightState } from '../src/core/fixtures'
import type { AircraftState, Ghost, GhostSample, MutableWeatherSample, Vec3, WeatherFeature, WeatherField, WeatherFeatureKind } from '../src/core/types'

const CRUISE = 150
export const PLAYER_ALT = 2400

type Column = Extract<WeatherFeature, { kind: 'updraft' | 'downdraft' | 'thermal' }>
type Storm = Extract<WeatherFeature, { kind: 'storm' }>
type Jet = Extract<WeatherFeature, { kind: 'jetstream' }>

const lift: Column = { kind: 'updraft', id: 'lift', center: v3(11_000, 0, -2_500), radius: 2_000, base: 1_200, top: 10_000, strength: 16 }
const sink: Column = { kind: 'downdraft', id: 'sink', center: v3(17_000, 0, 1_800), radius: 2_200, base: 0, top: 7_000, strength: -10 }
const jet: Jet = { kind: 'jetstream', id: 'jet', path: [v3(18_000, 4_500, -7_000), v3(42_000, 4_700, -4_500), v3(75_000, 4_800, -1_000)], radius: 2_600, thickness: 600, speed: 38 }
const storm: Storm = { kind: 'storm', id: 'storm', center: v3(34_000, 0, 7_500), radius: 4_000, base: 900, top: 12_000, strength: 25 }
const thermals: Column[] = [
  { kind: 'thermal', id: 'th-a', center: v3(6_000, 0, 6_500), radius: 900, base: 0, top: 2_300, strength: 4 },
  { kind: 'thermal', id: 'th-b', center: v3(24_000, 0, -9_500), radius: 1_000, base: 0, top: 2_600, strength: 5 },
  { kind: 'thermal', id: 'th-c', center: v3(28_000, 0, 1_500), radius: 800, base: 0, top: 2_100, strength: 4 },
]
const features: readonly WeatherFeature[] = [lift, sink, jet, storm, ...thermals]

/** Distance from p to a polyline, split horizontal / vertical, and the local path direction. */
function nearestOnPath(path: readonly Vec3[], p: Vec3): { dh: number; dv: number; dir: Vec3 } {
  let best = { dh: Infinity, dv: Infinity, dir: v3(1, 0, 0) }
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i]!, b = path[i + 1]!
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z
    const len2 = abx * abx + aby * aby + abz * abz
    const s = clamp(((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / len2, 0, 1)
    const dh = Math.hypot(a.x + abx * s - p.x, a.z + abz * s - p.z)
    if (dh < best.dh) {
      const l = Math.sqrt(len2)
      best = { dh, dv: Math.abs(a.y + aby * s - p.y), dir: v3(abx / l, aby / l, abz / l) }
    }
  }
  return best
}

export function createDecisionWeather(seed = 7): WeatherField {
  const sample = (p: Vec3, t: number, out?: MutableWeatherSample) => {
    const o: MutableWeatherSample = out ?? { wind: { x: 0, y: 0, z: 0 }, turbulence: 0, dominant: null, cloud: 0 }
    let wx = 8, wy = 0, wz = 0
    let turb = 0.06
    let best = 2.5
    let dominant: WeatherFeatureKind | null = null
    let cloud = 0
    const consider = (kind: WeatherFeatureKind, score: number): void => {
      if (score > best) {
        best = score
        dominant = kind
      }
    }
    for (const f of [lift, sink, ...thermals]) {
      const r = Math.hypot(p.x - f.center.x, p.z - f.center.z) / f.radius
      if (r > 1.6) continue
      const radial = Math.exp(-r * r * 1.6)
      const vertical = smoothstep(f.base - 300, f.base + 600, p.y) * (1 - smoothstep(f.top - 1500, f.top, p.y))
      const w = f.strength * radial * vertical
      wy += w
      turb = Math.max(turb, 0.35 * (1 - Math.abs(radial - 0.5) * 2) * vertical)
      consider(f.kind, Math.abs(w))
      if (f.kind === 'updraft') cloud = Math.max(cloud, smoothstep(f.base + 0.3 * (f.top - f.base), f.base + 0.3 * (f.top - f.base) + 300, p.y) * smoothstep(0.35, 0.75, radial))
    }
    {
      const n = nearestOnPath(jet.path, p)
      const k = Math.exp(-((n.dh / jet.radius) ** 2) * 2 - ((n.dv / jet.thickness) ** 2) * 2)
      wx += n.dir.x * jet.speed * k
      wy += n.dir.y * jet.speed * k
      wz += n.dir.z * jet.speed * k
      consider('jetstream', jet.speed * k * 0.5)
    }
    {
      const r = Math.hypot(p.x - storm.center.x, p.z - storm.center.z) / storm.radius
      const env = smoothstep(storm.base - 600, storm.base + 1200, p.y) * (1 - smoothstep(storm.top - 2500, storm.top + 500, p.y))
      const core = r < 0.75 ? (1 - (r / 0.75) ** 2) ** 2 : 0
      const ring = Math.abs(r - 1) < 0.4 ? (1 - ((r - 1) / 0.4) ** 2) ** 2 : 0
      wy += (0.3 * core + ring) * storm.strength * env
      turb = Math.max(turb, 0.95 * core * env, 0.4 * ring * env)
      consider('storm', core * env * 60)
      consider('updraft', ring * storm.strength * env)
      if (r < 1.1) cloud = Math.max(cloud, env * smoothstep(1.1, 0.8, r))
    }
    turb = clamp(turb + 0.04 * Math.sin(p.x * 0.001 + t * 0.7) * Math.sin(p.z * 0.0013 + seed), 0, 1)
    o.wind.x = wx
    o.wind.y = wy
    o.wind.z = wz
    o.turbulence = turb
    o.dominant = dominant
    o.cloud = cloud
    return o
  }
  return { seed, boundsMin: v3(-20_000, 0, -30_000), boundsMax: v3(120_000, 14_000, 30_000), sample, features }
}

/** Level eastbound player below the lift column's cloud base, watching the ghosts' lines ahead. */
export function decisionPlayer(t: number): AircraftState {
  const s = fixtureFlightState(t)
  return { ...s, pos: v3(CRUISE * t, PLAYER_ALT, 0), vel: v3(CRUISE, 0, 0), orientation: qFromAxisAngle(v3(0, 1, 0), 0), cabinAccel: 0 }
}

/** A path as a function of time → ghost samples at 10 Hz, attitude from the path (bank from turn rate). */
function scripted(path: (t: number) => Vec3, duration: number, pilot: string): Ghost {
  const samples: GhostSample[] = []
  const headingAt = (t: number): number => {
    const a = path(t - 0.1), b = path(t + 0.1)
    return Math.atan2(-(b.z - a.z), b.x - a.x)
  }
  for (let t = 0; t <= duration; t += 0.1) {
    const a = path(t - 0.1), b = path(t + 0.1)
    const vx = (b.x - a.x) / 0.2, vy = (b.y - a.y) / 0.2, vz = (b.z - a.z) / 0.2
    const heading = headingAt(t)
    let turn = headingAt(t + 0.5) - headingAt(t - 0.5)
    turn = Math.atan2(Math.sin(turn), Math.cos(turn))
    const bank = -Math.atan((turn * Math.hypot(vx, vz)) / 9.81)
    const pitch = Math.atan2(vy, Math.hypot(vx, vz))
    const q = qMul(qMul(qFromAxisAngle(v3(0, 1, 0), heading), qFromAxisAngle(v3(0, 0, 1), pitch)), qFromAxisAngle(v3(1, 0, 0), bank))
    samples.push({ t, pos: path(t), orientation: q })
  }
  const score = { status: 'arrived' as const, simTimeS: duration, displayTimeS: duration * 30, fuelUsedKg: 900, fuelRemainingPct: 60, comfort: 90, severeTurbulenceS: 0, stress: 10, weatherUtilization: 55, smooth: 900, speed: 900, eco: 900 }
  return { version: 1, pilot, dailyNumber: 1, routeId: 'fixture-route', aircraftId: fixtureAircraft.id, score, samples }
}

/** Piecewise path: legs of (duration, local-time → position), joined end to end. */
function legs(parts: readonly (readonly [number, (u: number) => Vec3])[]): { path: (t: number) => Vec3; duration: number } {
  const duration = parts.reduce((s, [d]) => s + d, 0)
  const path = (t: number): Vec3 => {
    let u = clamp(t, 0, duration)
    for (const [d, f] of parts) {
      if (u <= d) return f(u)
      u -= d
    }
    const [d, f] = parts[parts.length - 1]!
    return f(d)
  }
  return { path, duration }
}

const line = (a: Vec3, b: Vec3): readonly [number, (u: number) => Vec3] => {
  const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / CRUISE
  return [d, (u) => {
    const k = u / d
    return v3(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * smoothstep(0, 1, k), a.z + (b.z - a.z) * k)
  }]
}

/** Surfer: detours left into the lift column, circles up under its cloud base, then climbs into the jet. */
export function surferGhost(): Ghost {
  const r = 750
  const cx = lift.center.x, cz = lift.center.z
  const entry = v3(cx - r, PLAYER_ALT, cz)
  const turns = 2.25
  const climbTop = 3_750
  const orbitS = (turns * 2 * Math.PI * r) / CRUISE
  // Counter-clockwise seen from above (a left-hand orbit), starting on the west side heading north.
  const orbit = (u: number): Vec3 => {
    const a = Math.PI + (u / orbitS) * turns * 2 * Math.PI
    return v3(cx + Math.cos(a) * r, PLAYER_ALT + (climbTop - PLAYER_ALT) * (u / orbitS), cz - Math.sin(a) * r)
  }
  const exit = orbit(orbitS)
  const { path, duration } = legs([
    line(v3(-3_000, PLAYER_ALT, 400), entry),
    [orbitS, orbit],
    line(exit, v3(26_000, 4_550, -6_300)),
    line(v3(26_000, 4_550, -6_300), v3(75_000, 4_800, -1_300)),
  ])
  return scripted(path, duration, 'surfer')
}

/** Direct: the straight line at cruise altitude, sagging through the sink, then into the storm's core. */
export function directGhost(): Ghost {
  const { path, duration } = legs([
    line(v3(-1_500, PLAYER_ALT, 800), v3(17_000, PLAYER_ALT - 350, 1_900)),
    line(v3(17_000, PLAYER_ALT - 350, 1_900), v3(34_000, PLAYER_ALT, 6_600)),
    line(v3(34_000, PLAYER_ALT, 6_600), v3(75_000, PLAYER_ALT + 200, 5_000)),
  ])
  return scripted(path, duration, 'direct')
}
