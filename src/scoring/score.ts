import { GRAVITY, SEVERE_TURBULENCE } from '../core/constants'
import { trimLevel } from '../flight'
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
//   E_eng = Σ throttle · maxThrust · lapse(h) · airspeed · dt   (thrust actually delivered)
//   utilization = 100 · E_atm / (E_atm + E_eng)
// m·g·wind.y is the potential energy an air mass lifts into the airframe per second.
// D_ref·(wind · track) is the engine power a tailwind saves: to gain that ground speed
// in still air you'd push this airframe's cruise drag D_ref (trimmed at 3 km) for (wind · track) m/s more.
// track = horizontal unit vector toward the gate. Both terms are signed so gust noise
// averages out and flying through downdrafts / headwinds is paid back.
const DRAG_REF_ALT_M = 3000
/** Thrust ∝ (ρ/ρ0)^THRUST_LAPSE, the same law as flight/aero.ts. */
const THRUST_LAPSE = 0.9
const SCALE_HEIGHT_M = 8500
const lapse = (h: number): number => Math.pow(Math.exp(-Math.max(h, 0) / SCALE_HEIGHT_M), THRUST_LAPSE)

// ─── Boards (0 unless status = 'arrived'; ~1000 = reference flight) ─────────
// T_ref = |gate − start| / cruiseSpeed, F_ref = T_ref · fuelBurnFull · REF_THROTTLE
// speed  = 1000 · (T_ref / simTime)^lev
// eco    = 1000 · (F_ref / max(fuelUsed, F_ref / 10))^lev_eco · schedule(simTime / T_ref)
// smooth = 1000 · e^(−discomfort / ride) · (1 − stress/100) · e^(−SEVERE_K · severeS / T_ref)
// All three are ratios to a reference derived from the route length and aircraft,
// so a 80 km and a 160 km route produce comparable numbers.
//
// Cross-aircraft fairness (one board is shared by every aircraft on a route; SPEC §6 never pay_more = win):
// - lev = (cruiseSpeed / V_REF)^SPEED_LEVERAGE. A 60 m/s jet shortens a 115 m/s glider's flight far more, in
//   ratio, than a 420 m/s airliner's. Raising the ratio to lev scores the ground speed gained in units of a
//   common speed instead, so neither the slowest airframe (wind leverage) nor the fastest (raw thrust) owns it.
// - lev_eco = (cruiseSpeed / V_REF)^ECO_LEVERAGE, same idea for fuel: the atmosphere can carry a light glider,
//   not an airliner, so fuel ratios are compared on a common footing.
// - ride = (gustSensitivity · cabinDamping / RIDE_REF)^RIDE_NORM: a widebody's cabin is smooth by design, so the smooth
//   board rates how well you flew *that* airframe, not which one you picked. FlightScore.comfort stays raw.
// - schedule: the eco board still has a timetable. Flying slow is the obvious way to save fuel; past
//   ECO_SLACK × T_ref the score halves every ECO_HALF × T_ref, so "fly slow" alone can't win it and the
//   fuel has to come from the weather.
const REF_THROTTLE = 0.6
const SEVERE_K = 20
/** Reference speed (m/s): the game cruise that maps routes to real block times (meta/daily REF_GAME_CRUISE_MS). */
const V_REF = 80_000 / 360
const SPEED_LEVERAGE = 0.7
const ECO_LEVERAGE = 1.2
const RIDE_NORM = 0.8
/** gustSensitivity · cabinDamping of the airframe whose smooth board is left as is (between narrow body and wide body). */
const RIDE_REF = 0.6
const ECO_SLACK = 1.25
const ECO_HALF = 0.25

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

/** Eco timetable: 1 up to ECO_SLACK × T_ref, then halves every ECO_HALF × T_ref. */
const schedule = (timeRatio: number): number => Math.pow(0.5, Math.max(0, timeRatio - ECO_SLACK) / ECO_HALF)

const isTerminal = (s: AircraftState['status']): boolean => s !== 'flying'

export const createScoreTracker: CreateScoreTracker = (spec, route) => {
  const ref = scoreReference(spec, route)
  const dragRef = Math.max(0, trimLevel(spec, DRAG_REF_ALT_M, spec.cruiseSpeedMs).throttle) * spec.maxThrustN * lapse(DRAG_REF_ALT_M)
  const speedLev = Math.pow(spec.cruiseSpeedMs / V_REF, SPEED_LEVERAGE)
  const ecoLev = Math.pow(spec.cruiseSpeedMs / V_REF, ECO_LEVERAGE)
  const ride = Math.pow((spec.gustSensitivity * spec.cabinDamping) / RIDE_REF, RIDE_NORM)

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
    engJ += controls.throttle * spec.maxThrustN * lapse(state.pos.y) * state.airspeed * dt

    simTime += dt
    last = state
  }

  const current = (): FlightScore => {
    const status = last?.status ?? 'flying'
    const fuelKg = last?.fuelKg ?? spec.fuelCapacityKg
    const fuelUsedKg = Math.max(0, spec.fuelCapacityKg - fuelKg)
    const aRms = simTime > 0 ? Math.sqrt(accelSq / simTime) : 0
    const jRms = simTime > 0 ? Math.sqrt(jerkSq / simTime) : 0
    const discomfort = aRms / ACCEL_REF + jRms / JERK_REF
    const comfort = 100 * Math.exp(-discomfort)
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
      smooth: arrived ? Math.round(1000 * Math.exp(-discomfort / ride) * (1 - stress / 100) * Math.exp((-SEVERE_K * severeS) / ref.timeS)) : 0,
      speed: arrived ? Math.round(1000 * Math.pow(ref.timeS / simTime, speedLev)) : 0,
      eco: arrived
        ? Math.round(1000 * Math.pow(ref.fuelKg / Math.max(fuelUsedKg, ref.fuelKg / 10), ecoLev) * schedule(simTime / ref.timeS))
        : 0,
    }
  }

  return { push, current, finish: current }
}
