import { GRAVITY, SEA_LEVEL_AIR_DENSITY, SEVERE_TURBULENCE } from '../core/constants'
import { airDensity, trimLevel } from '../flight'
import type { AircraftSpec, AircraftState, CreateScoreTracker, FlightScore, Route, TelemetryFrame } from '../core/types'

// ─── Comfort ────────────────────────────────────────────────────────────────
// discomfort = aRms / ACCEL_REF + jRms / JERK_REF,  comfort = 100 · e^(−discomfort)
// aRms: RMS of cabin vertical accel minus its STEADY_TAU moving average: a steady push (the
// 1.2 g of a level orbit, a gentle climb in rising air) is felt as weight, not as discomfort.
// jRms: RMS of d/dt of that accel after a PERCEPTION_TAU low-pass (a raw 60 Hz finite difference
// would turn sim noise into huge jerk). Jerk dominates: bumps are what spill the coffee.
const ACCEL_REF = 2 // m/s²
const JERK_REF = 5 // m/s³
const PERCEPTION_TAU = 0.1 // s
const STEADY_TAU = 5 // s

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
const lapse = (h: number): number => Math.pow(airDensity(h) / SEA_LEVEL_AIR_DENSITY, THRUST_LAPSE)

// ─── Boards (0 unless status = 'arrived') ───────────────────────────────────
// Every board is normalised per aircraft against the best flight that aircraft can make on this route
// WITHOUT reading the sky (SPEC §10): 1000 = "flies this aircraft well blind", > 1000 only comes from the
// weather. The references are analytic (trimLevel at the gate-window middle, still air, straight line),
// so scoring stays cheap and deterministic, and an 80 km and a 160 km route give comparable numbers.
//   speed  = 1000 · (T_full / simTime)^lev           T_full = L / V_full (level full-throttle airspeed)
//   eco    = 1000 · (1 + lev_eco · ln(F_range / fuel)) · timetable(simTime / T_range)
//            F_range, T_range = fuel and time of the straight line at best-range airspeed V_range
//   smooth = 1000 · e^(SMOOTH_GAIN · (1 − discomfort / D_ref)) · (1 − stress/100) · e^(−SEVERE_K · severeS / T_cruise)
//            D_ref = discomfort of a trimmed straight flight through this route's background air
// The blind flight scores exactly 1000 on every aircraft. What the weather adds is then put on a footing
// shared by all aircraft (one board per route, SPEC §6 never pay_more = win): the same 90 m/s jet shortens a
// 130 m/s glider's flight by 40 % and a 480 m/s airliner's by 16 %, so a raw ratio hands the speed board to
// the slowest airframe. lev = (V_full / V_REF)^SPEED_LEVERAGE turns ln(time ratio) ≈ gained m/s / V into
// gained m/s / V_REF^p·V^(1−p); eco does the same with V_range; smooth compares discomfort in proportion
// to the airframe's own ride.
// Eco is log-scaled: a glider riding lift can burn a tenth of its reference, and a ratio of 10 would
// dwarf the other boards; ln keeps small gains linear (ratio 1.2 → 1182) and big ones on the same
// scale as speed and smooth (ratio 3 → 2099). The timetable keeps "circle forever at idle" from winning:
// full score up to ECO_SLACK × T_range, then it halves every ECO_HALF × T_range.
const SEVERE_K = 20
const ECO_SLACK = 1.2
const ECO_HALF = 0.25
/** Background discomfort of a trimmed straight flight: (RIDE_BASE + RIDE_SEVERITY · severity) · (gust · cabin)^RIDE_EXP (fitted on the lab's direct flights). */
const RIDE_BASE = 0
const RIDE_SEVERITY = 0.82
const RIDE_EXP = 0.8
/** Reference speed (m/s): the game cruise that maps routes to real block times (meta/daily REF_GAME_CRUISE_MS). */
const V_REF = 80_000 / 360
const SPEED_LEVERAGE = 0.62
const ECO_LEVERAGE = 0.55
const SMOOTH_GAIN = 1

export interface ScoreReference {
  /** Straight line at trimmed cruise speed (s): deadlines, severe-turbulence normalisation. */
  readonly timeS: number
  /** Straight line at full throttle (s): the speed board's 1000. */
  readonly speedTimeS: number
  /** Exponent on the speed ratio, and the factor on ln(fuel ratio): see "Boards". */
  readonly speedLeverage: number
  readonly ecoLeverage: number
  /** Straight line at best-range airspeed: the eco board's 1000. */
  readonly ecoFuelKg: number
  readonly ecoTimeS: number
  /** Discomfort of a trimmed straight flight on this route (smooth board's 1000). */
  readonly discomfort: number
}

/** Altitude the blind references fly: the middle of the gate window. */
const refAltitude = (route: Route): number => (route.gateMinAlt + route.gateMaxAlt) / 2

/** Fastest level airspeed at full throttle (bisection on trim throttle = 1). */
function fullThrottleSpeed(spec: AircraftSpec, h: number): number {
  let lo = spec.cruiseSpeedMs * 0.8
  let hi = spec.maxSpeedMs * 1.6
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2
    if (trimLevel(spec, h, mid).throttle > 1) hi = mid
    else lo = mid
  }
  return lo
}

/** Airspeed with the least fuel per metre (fuel flow ∝ throttle · lapse), and that fuel per metre. */
function bestRange(spec: AircraftSpec, h: number): { speed: number; kgPerM: number } {
  const minEas = spec.stallSpeedMs * 1.3
  const vMin = minEas / Math.sqrt(airDensity(h) / SEA_LEVEL_AIR_DENSITY)
  let best = { speed: spec.cruiseSpeedMs, kgPerM: Infinity }
  for (let v = vMin; v <= spec.maxSpeedMs * 1.3; v += 2) {
    const t = trimLevel(spec, h, v).throttle
    if (t <= 0 || t > 1) continue
    const kgPerM = (spec.fuelBurnFullKgS * t * lapse(h)) / v
    if (kgPerM < best.kgPerM) best = { speed: v, kgPerM }
  }
  return best
}

const cache = new WeakMap<AircraftSpec, Map<string, ScoreReference>>()

export function scoreReference(spec: AircraftSpec, route: Route): ScoreReference {
  const key = `${route.id}:${route.start.x},${route.start.z},${route.gate.x},${route.gate.z},${route.gateMinAlt},${route.gateMaxAlt},${route.severity}`
  const perSpec = cache.get(spec) ?? new Map<string, ScoreReference>()
  cache.set(spec, perSpec)
  const hit = perSpec.get(key)
  if (hit) return hit
  const L = Math.hypot(route.gate.x - route.start.x, route.gate.z - route.start.z)
  const h = refAltitude(route)
  // A blind eco pilot who knows the aircraft still picks its most economical altitude (≤ 8 km, climb not charged).
  let range = bestRange(spec, h)
  for (let alt = h + 1000; alt <= Math.min(8000, spec.serviceCeilingM * 0.8); alt += 1000) {
    const r = bestRange(spec, alt)
    if (r.kgPerM < range.kgPerM) range = r
  }
  const vFull = fullThrottleSpeed(spec, h)
  const ref: ScoreReference = {
    timeS: L / spec.cruiseSpeedMs,
    speedTimeS: L / vFull,
    speedLeverage: Math.pow(vFull / V_REF, SPEED_LEVERAGE),
    ecoLeverage: Math.pow(range.speed / V_REF, ECO_LEVERAGE),
    ecoFuelKg: L * range.kgPerM,
    ecoTimeS: L / range.speed,
    discomfort: (RIDE_BASE + RIDE_SEVERITY * route.severity) * Math.pow(spec.gustSensitivity * spec.cabinDamping, RIDE_EXP),
  }
  perSpec.set(key, ref)
  return ref
}

/** Eco timetable: 1 up to ECO_SLACK × T_range, then halves every ECO_HALF × T_range. */
const timetable = (timeRatio: number): number => Math.pow(0.5, Math.max(0, timeRatio - ECO_SLACK) / ECO_HALF)

const isTerminal = (s: AircraftState['status']): boolean => s !== 'flying'

export const createScoreTracker: CreateScoreTracker = (spec, route) => {
  const ref = scoreReference(spec, route)
  const dragRef = Math.max(0, trimLevel(spec, DRAG_REF_ALT_M, spec.cruiseSpeedMs).throttle) * spec.maxThrustN * lapse(DRAG_REF_ALT_M)

  let last: AircraftState | null = null
  let simTime = 0
  let severeS = 0
  let accelSq = 0
  let jerkSq = 0
  let filtered = 0
  let steady = 0
  let atmJ = 0
  let engJ = 0

  const push = (frame: TelemetryFrame): void => {
    if (last && isTerminal(last.status)) return
    const { state, controls, weather, dt } = frame
    const a = state.cabinAccel

    if (last === null) {
      filtered = a
      steady = a
    }
    const prevFiltered = filtered
    filtered += (a - filtered) * (dt / (PERCEPTION_TAU + dt))
    steady += (a - steady) * (dt / (STEADY_TAU + dt))
    const jerk = (filtered - prevFiltered) / dt
    accelSq += (a - steady) * (a - steady) * dt
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
      smooth: arrived ? Math.round(1000 * Math.exp(SMOOTH_GAIN * (1 - discomfort / ref.discomfort)) * (1 - stress / 100) * Math.exp((-SEVERE_K * severeS) / ref.timeS)) : 0,
      speed: arrived ? Math.round(1000 * Math.pow(ref.speedTimeS / simTime, ref.speedLeverage)) : 0,
      eco: arrived
        ? Math.round(Math.max(0, 1000 * (1 + ref.ecoLeverage * Math.log(ref.ecoFuelKg / Math.max(fuelUsedKg, 1e-6)))) * timetable(simTime / ref.ecoTimeS))
        : 0,
    }
  }

  return { push, current, finish: current }
}
