// Test doubles so every module can be developed and tested without its siblings.
// NOT game content: production code must never import from core/fixtures.
import { clamp, qFromAxisAngle, qMul, smoothstep, v3 } from '../math'
import type {
  AircraftSpec,
  AircraftState,
  Ghost,
  MutableWeatherSample,
  Route,
  Terrain,
  TerrainCover,
  WeatherField,
  WeatherFeature,
  WeatherSample,
} from '../types'

export const fixtureRoute: Route = {
  id: 'fixture-route',
  from: 'JFK',
  to: 'LIS',
  start: v3(0, 3000, 0),
  startHeading: v3(1, 0, 0),
  gate: v3(100_000, 3000, 0),
  gateRadius: 3000,
  gateMinAlt: 1500,
  gateMaxAlt: 6000,
  realDistanceKm: 5420,
  timeScale: 30,
  severity: 0.5,
  label: 'JFK → LIS',
}

export const fixtureAircraft: AircraftSpec = {
  id: 'fixture-turboprop',
  name: 'Fixture Turboprop',
  class: 'turboprop',
  massKg: 18_000,
  wingAreaM2: 61,
  maxThrustN: 45_000,
  fuelCapacityKg: 5_000,
  fuelBurnFullKgS: 0.35,
  stallSpeedMs: 50,
  cruiseSpeedMs: 140,
  maxSpeedMs: 170,
  serviceCeilingM: 7_600,
  rollRate: 1.4,
  pitchRate: 0.5,
  yawRate: 0.25,
  controlLag: 0.25,
  gustSensitivity: 1.4,
  cabinDamping: 1.0,
  limitGPos: 2.5,
  limitGNeg: -1.0,
  lengthM: 27,
}

const features: readonly WeatherFeature[] = [
  { kind: 'updraft', id: 'up-1', center: v3(30_000, 0, 0), radius: 2500, base: 500, top: 9000, strength: 18 },
  { kind: 'downdraft', id: 'down-1', center: v3(55_000, 0, 4000), radius: 3000, base: 0, top: 8000, strength: -12 },
  { kind: 'jetstream', id: 'jet-1', path: [v3(0, 9000, -5000), v3(100_000, 9500, 5000)], radius: 1500, thickness: 800, speed: 60 },
]

/**
 * Analytic weather: 8 m/s westerly background + one updraft + one downdraft + one straight jet.
 * Deterministic and cheap; shapes are crude on purpose.
 */
export function createFixtureWeather(seed = 1): WeatherField {
  const sample = (p: { x: number; y: number; z: number }, t: number, out?: MutableWeatherSample): WeatherSample => {
    const o: MutableWeatherSample = out ?? { wind: { x: 0, y: 0, z: 0 }, turbulence: 0, dominant: null, cloud: 0 }
    let wx = 8
    let wy = 0
    let wz = 0
    let turb = 0.05
    let dominant: MutableWeatherSample['dominant'] = null
    let cloud = 0
    for (const f of features) {
      if (f.kind === 'updraft' || f.kind === 'downdraft') {
        const dx = p.x - f.center.x
        const dz = p.z - f.center.z
        const r = Math.sqrt(dx * dx + dz * dz) / f.radius
        if (r < 1.5 && p.y > f.base && p.y < f.top) {
          const radial = Math.exp(-r * r * 2)
          const vertical = smoothstep(f.base, f.base + 800, p.y) * (1 - smoothstep(f.top - 1500, f.top, p.y))
          wy += f.strength * radial * vertical
          turb = Math.max(turb, 0.6 * (1 - Math.abs(radial - 0.5) * 2) * vertical)
          if (radial > 0.3) dominant = f.kind
          if (f.kind === 'updraft') cloud = Math.max(cloud, radial * vertical)
        }
      } else if (f.kind === 'jetstream') {
        const a = f.path[0]!
        const b = f.path[1]!
        const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z
        const len2 = abx * abx + aby * aby + abz * abz
        const s = clamp(((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / len2, 0, 1)
        const cx = a.x + abx * s - p.x, cy = a.y + aby * s - p.y, cz = a.z + abz * s - p.z
        const d = Math.sqrt(cx * cx + cy * cy + cz * cz) / f.radius
        const k = Math.exp(-d * d * 2)
        const inv = 1 / Math.sqrt(len2)
        wx += abx * inv * f.speed * k
        wy += aby * inv * f.speed * k
        wz += abz * inv * f.speed * k
        if (k > 0.3) dominant = 'jetstream'
        turb = Math.max(turb, 0.4 * Math.exp(-(d - 1) * (d - 1) * 4))
      }
    }
    turb = clamp(turb + 0.05 * Math.sin(p.x * 0.001 + t * 0.7) * Math.sin(p.z * 0.0013 + seed), 0, 1)
    o.wind.x = wx
    o.wind.y = wy
    o.wind.z = wz
    o.turbulence = turb
    o.dominant = dominant
    o.cloud = cloud
    return o
  }
  return { seed, boundsMin: v3(-10_000, 0, -30_000), boundsMax: v3(110_000, 14_000, 30_000), sample, features }
}

/**
 * Kinematic scripted flight along fixtureRoute: gentle S-turns and a climb through the fixture updraft.
 * Not a flight model — just plausible states for render/ui/scoring sandboxes.
 */
export function fixtureFlightState(t: number): AircraftState {
  const speed = 150
  const x = t * speed
  const z = 4000 * Math.sin(t / 25)
  const y = 3000 + 2500 * smoothstep(22_000, 38_000, x) + 300 * Math.sin(t / 7)
  const dzdt = (4000 / 25) * Math.cos(t / 25)
  const dydt = 300 / 7 * Math.cos(t / 7)
  const heading = Math.atan2(-dzdt, speed) // rotation about +y; +z is south
  const pitch = Math.atan2(dydt, speed)
  const bank = -Math.atan((dzdt * (1 / 25)) / 9.81) * 8
  const q = qMul(qMul(qFromAxisAngle(v3(0, 1, 0), heading), qFromAxisAngle(v3(0, 0, 1), pitch)), qFromAxisAngle(v3(1, 0, 0), bank))
  return {
    t,
    pos: v3(x, y, z),
    vel: v3(speed, dydt, dzdt),
    orientation: q,
    angVel: v3(0, 0, 0),
    airspeed: speed - 8,
    throttle: 0.7,
    fuelKg: fixtureAircraft.fuelCapacityKg - t * 0.25,
    gLoad: 1 + 0.2 * Math.sin(t / 3),
    cabinAccel: 0.8 * Math.sin(t * 1.3),
    stress: clamp(t / 2000, 0, 1),
    stalled: false,
    status: x >= fixtureRoute.gate.x ? 'arrived' : 'flying',
  }
}

export function createFixtureGhost(offsetS = 3): Ghost {
  const samples = []
  for (let t = 0; t <= 600; t += 0.1) {
    const s = fixtureFlightState(t + offsetS)
    samples.push({ t, pos: v3(s.pos.x, s.pos.y + 200, s.pos.z - 300), orientation: s.orientation })
  }
  return {
    version: 1,
    pilot: 'fixture-ghost',
    dailyNumber: 1,
    routeId: fixtureRoute.id,
    aircraftId: fixtureAircraft.id,
    score: {
      status: 'arrived', simTimeS: 600, displayTimeS: 18_000, fuelUsedKg: 1500, fuelRemainingPct: 70,
      comfort: 80, severeTurbulenceS: 0, stress: 20, weatherUtilization: 40, smooth: 800, speed: 700, eco: 600,
    },
    samples,
  }
}

/**
 * Analytic terrain for module sandboxes/tests: coast west of the start, rolling hills, one ridge crossing the
 * route around x = 60 km (peak 2.2 km), a river meandering along it, a city under the start and one under the gate.
 */
export function createFixtureTerrain(seed = 1): Terrain {
  const riverZ = (x: number): number => 6000 * Math.sin(x / 17_000 + seed)
  const ridge = (x: number, z: number): number => 2200 * Math.exp(-(((x - 60_000) / 3500) ** 2)) * (0.75 + 0.25 * Math.cos(z / 11_000))
  const coast = (x: number): number => smoothstep(-12_000, -4000, x)
  const heightAt = (x: number, z: number): number => {
    const hills = 250 + 180 * Math.sin(x / 7000) * Math.cos(z / 9000) + 90 * Math.sin((x + z) / 2300)
    const valley = 1 - 0.7 * Math.exp(-(((z - riverZ(x)) / 2500) ** 2))
    return -400 + (400 + hills * valley + ridge(x, z)) * coast(x)
  }
  const cities = [
    { id: 'dep', name: fixtureRoute.from, center: v3(0, heightAt(0, 0), 0), radius: 4000, role: 'departure' as const },
    { id: 'arr', name: fixtureRoute.to, center: v3(fixtureRoute.gate.x, heightAt(fixtureRoute.gate.x, 0), 0), radius: 4000, role: 'arrival' as const },
  ]
  const coverAt = (x: number, z: number): TerrainCover => {
    const h = heightAt(x, z)
    if (h <= 0) return 'sea'
    if (h < 25) return 'beach'
    for (const c of cities) if (Math.hypot(x - c.center.x, z - c.center.z) < c.radius) return 'city'
    if (x > 10_000 && Math.abs(z - riverZ(x)) < 120) return 'river'
    if (h > 1900) return 'snow'
    if (h > 1300) return 'rock'
    return Math.sin(x / 1700) * Math.sin(z / 1300) > 0.2 ? 'forest' : Math.sin(x / 900 + z / 1100) > 0 ? 'fields' : 'grass'
  }
  const river = { id: 'river-1', width: 240, path: Array.from({ length: 19 }, (_, i) => { const x = 10_000 + i * 5000; return v3(x, heightAt(x, riverZ(x)), riverZ(x)) }) }
  return {
    seed,
    boundsMin: v3(-10_000, 0, -30_000),
    boundsMax: v3(110_000, 14_000, 30_000),
    heightAt,
    coverAt,
    cities,
    rivers: [river],
    maxHeight: 400 + 520 + 2200,
  }
}

/** Open sea everywhere (ground below the surface): the pre-terrain world, for tests that must not hit hills. */
export function createFlatTerrain(): Terrain {
  return {
    seed: 0,
    boundsMin: v3(-1e6, 0, -1e6),
    boundsMax: v3(1e6, 14_000, 1e6),
    heightAt: () => -100,
    coverAt: () => 'sea',
    cities: [],
    rivers: [],
    maxHeight: 0,
  }
}
