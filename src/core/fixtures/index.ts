// Test doubles so every module can be developed and tested without its siblings.
// NOT game content: production code must never import from core/fixtures.
import { clamp, qFromAxisAngle, qMul, smoothstep, v3 } from '../math'
import type {
  AircraftSpec,
  AircraftState,
  Ghost,
  MutableWeatherSample,
  Route,
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
