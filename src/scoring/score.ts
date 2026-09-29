import { GRAVITY, SEVERE_TURBULENCE } from '../core/constants'
import type { AircraftSpec, AircraftState, CreateScoreTracker, FlightScore, Route, TelemetryFrame } from '../core/types'

// ─── Comfort ────────────────────────────────────────────────────────────────
// discomfort = aRms / ACCEL_REF + jRms / JERK_REF,  comfort = 100 · e^(−discomfort)
// aRms: RMS of cabin vertical accel. jRms: RMS of d/dt of that accel after a
// PERCEPTION_TAU low-pass (a raw 60 Hz finite difference would turn sim noise into
// huge jerk). References are chosen so jerk dominates: a steady 1 m/s² push costs
// ~40 points, the same RMS as a 2 Hz bump costs ~75.
const ACCEL_REF = 2 // m/s²
const JERK_REF = 5 // m/s³
const PERCEPTION_TAU = 0.1 // s

// ─── Weather utilization ────────────────────────────────────────────────────
// Energy integrated over the flight, in joules:
//   E_atm = Σ (m·g·wind.y + D_ref·(wind · track)) · dt      signed, then clamped ≥ 0
//   E_eng = Σ throttle · maxThrust · airspeed · dt
//   utilization = 100 · E_atm / (E_atm + E_eng)
// m·g·wind.y is the potential energy an air mass lifts into the airframe per second.
// D_ref·(wind · track) is the engine power a tailwind saves: to gain that ground speed
// in still air you'd push drag D_ref ≈ m·g / L_D_REF for (wind · track) m/s more.
// track = horizontal unit vector toward the gate. Both terms are signed so gust noise
// averages out and flying through downdrafts / headwinds is paid back.
const L_D_REF = 15

// ─── Boards (0 unless status = 'arrived'; ~1000 = reference flight) ─────────
// T_ref = |gate − start| / cruiseSpeed, F_ref = T_ref · fuelBurnFull · REF_THROTTLE
// speed  = 1000 · T_ref / simTime
// eco    = 1000 · F_ref / max(fuelUsed, F_ref / 10)                      (capped at 10 000)
// smooth = 1000 · comfort/100 · (1 − stress/100) · e^(−SEVERE_K · severeS / T_ref)
// All three are ratios to a reference derived from the route length and aircraft,
// so a 80 km and a 160 km route produce comparable numbers.
const REF_THROTTLE = 0.6
const SEVERE_K = 20

export interface ScoreReference {
  readonly timeS: number
  readonly fuelKg: number
}

export function scoreReference(spec: AircraftSpec, route: Route): ScoreReference {
  const dx = route.gate.x - route.start.x
  const dy = route.gate.y - route.start.y
  const dz = route.gate.z - route.start.z
  const timeS = Math.sqrt(dx * dx + dy * dy + dz * dz) / spec.cruiseSpeedMs
  return { timeS, fuelKg: timeS * spec.fuelBurnFullKgS * REF_THROTTLE }
}

const isTerminal = (s: AircraftState['status']): boolean => s !== 'flying'

export const createScoreTracker: CreateScoreTracker = (spec, route) => {
  const ref = scoreReference(spec, route)
  const dragRef = (spec.massKg * GRAVITY) / L_D_REF

  let last: AircraftState | null = null
  let simTime = 0
  let severeS = 0
  let accelSq = 0
  let jerkSq = 0
  let filtered = 0
  let atmJ = 0
  let engJ = 0

  const push = (frame: TelemetryFrame): void => {
    if (last && isTerminal(last.status)) return
    const { state, controls, weather, dt } = frame
    const a = state.cabinAccel

    if (last === null) filtered = a
    const prevFiltered = filtered
    filtered += (a - filtered) * (dt / (PERCEPTION_TAU + dt))
    const jerk = (filtered - prevFiltered) / dt
    accelSq += a * a * dt
    jerkSq += jerk * jerk * dt

    if (weather.turbulence > SEVERE_TURBULENCE) severeS += dt

    let tx = route.gate.x - state.pos.x
    let tz = route.gate.z - state.pos.z
    const tl = Math.sqrt(tx * tx + tz * tz)
    if (tl > 1) {
      tx /= tl
      tz /= tl
    } else {
      const hl = Math.hypot(route.startHeading.x, route.startHeading.z) || 1
      tx = route.startHeading.x / hl
      tz = route.startHeading.z / hl
    }
    const w = weather.wind
    atmJ += (spec.massKg * GRAVITY * w.y + dragRef * (w.x * tx + w.z * tz)) * dt
    engJ += controls.throttle * spec.maxThrustN * state.airspeed * dt

    simTime += dt
    last = state
  }

  const current = (): FlightScore => {
    const status = last?.status ?? 'flying'
    const fuelKg = last?.fuelKg ?? spec.fuelCapacityKg
    const fuelUsedKg = Math.max(0, spec.fuelCapacityKg - fuelKg)
    const aRms = simTime > 0 ? Math.sqrt(accelSq / simTime) : 0
    const jRms = simTime > 0 ? Math.sqrt(jerkSq / simTime) : 0
    const comfort = 100 * Math.exp(-(aRms / ACCEL_REF + jRms / JERK_REF))
    const stress = 100 * Math.min(1, Math.max(0, last?.stress ?? 0))
    const atm = Math.max(0, atmJ)
    const weatherUtilization = atm + engJ > 0 ? (100 * atm) / (atm + engJ) : 0
    const arrived = status === 'arrived' && simTime > 0

    return {
      status,
      simTimeS: simTime,
      displayTimeS: simTime * route.timeScale,
      fuelUsedKg,
      fuelRemainingPct: (100 * fuelKg) / spec.fuelCapacityKg,
      comfort,
      severeTurbulenceS: severeS,
      stress,
      weatherUtilization,
      smooth: arrived ? Math.round(1000 * (comfort / 100) * (1 - stress / 100) * Math.exp((-SEVERE_K * severeS) / ref.timeS)) : 0,
      speed: arrived ? Math.round((1000 * ref.timeS) / simTime) : 0,
      eco: arrived ? Math.round((1000 * ref.fuelKg) / Math.max(fuelUsedKg, ref.fuelKg / 10)) : 0,
    }
  }

  return { push, current, finish: current }
}
