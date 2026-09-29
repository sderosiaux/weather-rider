// Semi-arcade 6DOF. Translational motion is real aerodynamics on the air-relative velocity,
// so updrafts, jets, downdrafts and shear act through angle of attack and airspeed, never by
// special case. Rotation is rate-commanded: the nose follows the flight path, and a restoring term
// pulls angle of attack toward a "hold" value: 1 g along the current path (bank-compensated), plus
// a speed-stability term toward the airspeed the current thrust sustains in level flight. Short term,
// neutral stick keeps going where you point; long term the aircraft settles level relative to the
// air mass — so rising air carries it up, and with no thrust it glides at best-glide speed.
// A weathervane term kills sideslip.
import { GRAVITY, SEVERE_TURBULENCE } from '../core/constants'
import {
  BODY_FORWARD,
  BODY_RIGHT,
  BODY_UP,
  add,
  clamp,
  cross,
  dot,
  length,
  lerp,
  normalize,
  qConjugate,
  qFromAxisAngle,
  qMul,
  qNormalize,
  qRotate,
  scale,
  smoothstep,
  sub,
  v3,
} from '../core/math'
import { hashInts } from '../core/rng'
import type { AircraftSpec, AircraftState, Controls, FlightModel, MutableWeatherSample, Route, Vec3, WeatherField } from '../core/types'
import {
  CL0,
  CL_ALPHA,
  aeroOf,
  airDensity,
  currentMass,
  dragCoeff,
  equilibriumAirspeed,
  liftCoeff,
  thrustLapse,
  trimLevel,
} from './aero'

/** Engine spool: fraction of full throttle per second. */
const THROTTLE_RATE = 0.5
const SIDE_FORCE_PER_RAD = 0.8
/** Bank compensation of the flight-path hold is capped at this extra load factor. */
const MAX_BANK_COMPENSATION = 0.75
/** Weak spiral stability (rad/s at 45° bank) so gusts don't random-walk the bank angle. */
const WINGS_LEVELING = 0.12
/** Speed stability: extra load factor per unit of relative airspeed error, and per g of tangential accel (damping). */
const SPEED_STABILITY = 2
const SPEED_DAMPING = 2
const MAX_SPEED_CORRECTION = 0.4
/**
 * Peak gust amplitudes at turbulence 1 and gustSensitivity 1. Pitch gusts are expressed as load
 * factor (then converted to an angle-of-attack kick for the current q), otherwise a fast, highly
 * loaded wing would feel the same rate kick as g-forces several times larger.
 */
const GUST_ACCEL = 5
const GUST_LOAD = 0.3
const GUST_ROLL = 0.35
const GUST_YAW = 0.06
/** Stress per second when |g| sits at the structural limit. Starts at 70% of it. */
const G_STRESS_RATE = 0.08
const G_STRESS_ONSET = 0.7
const TURBULENCE_STRESS_RATE = 0.0006
const INSTANT_FAILURE_FACTOR = 1.5
/** Diving beyond the fastest level-flight dynamic pressure loads the airframe too. */
const OVERSPEED_STRESS_RATE = 0.1
const OVERSPEED_MARGIN = 0.15
const MIN_AERO_SPEED = 1

const scratch: MutableWeatherSample = { wind: { x: 0, y: 0, z: 0 }, turbulence: 0, dominant: null, cloud: 0 }

const knot = (seed: number, axis: number, i: number): number => (hashInts(seed, axis, i) / 4294967296) * 2 - 1

/** Smooth deterministic noise in [-1, 1], knots every `period` ticks. */
function tickNoise(seed: number, axis: number, tick: number, period: number): number {
  const s = tick / period
  const i = Math.floor(s)
  const f = s - i
  return lerp(knot(seed, axis, i), knot(seed, axis, i + 1), f * f * (3 - 2 * f))
}

/** ~1.5 Hz body with a ~4.5 Hz chop. */
const gustNoise = (seed: number, axis: number, tick: number): number =>
  0.7 * tickNoise(seed, axis, tick, 40) + 0.3 * tickNoise(seed, axis + 16, tick, 13)

/** Bank angle, positive = right wing down. */
export function bankAngle(orientation: AircraftState['orientation']): number {
  const right = qRotate(orientation, BODY_RIGHT)
  const up = qRotate(orientation, BODY_UP)
  return Math.atan2(-right.y, up.y)
}

/** Heading in radians, 0 = east, positive = toward north (−z), matching positive yaw about +y. */
export function headingOf(orientation: AircraftState['orientation']): number {
  const f = qRotate(orientation, BODY_FORWARD)
  return Math.atan2(-f.z, f.x)
}

/** Trimmed for cruise airspeed along startHeading; the ground velocity includes the wind at the start. */
export function initialState(spec: AircraftSpec, route: Route, weather: WeatherField): AircraftState {
  const w = weather.sample(route.start, 0, scratch).wind
  const wind = v3(w.x, w.y, w.z)
  const h = normalize(v3(route.startHeading.x, 0, route.startHeading.z))
  const dir = length(h) > 0 ? h : BODY_FORWARD
  const trim = trimLevel(spec, route.start.y, spec.cruiseSpeedMs)
  const yaw = qFromAxisAngle(BODY_UP, Math.atan2(-dir.z, dir.x))
  const orientation = qMul(yaw, qFromAxisAngle(BODY_RIGHT, trim.alpha))
  const throttle = clamp(trim.throttle, 0, 1)
  return {
    t: 0,
    pos: route.start,
    vel: add(scale(dir, spec.cruiseSpeedMs), wind),
    orientation,
    angVel: v3(0, 0, 0),
    airspeed: spec.cruiseSpeedMs,
    throttle,
    fuelKg: spec.fuelCapacityKg,
    gLoad: 1,
    cabinAccel: 0,
    stress: 0,
    stalled: false,
    status: 'flying',
  }
}

function inGate(pos: Vec3, route: Route): boolean {
  const dx = pos.x - route.gate.x
  const dz = pos.z - route.gate.z
  return dx * dx + dz * dz <= route.gateRadius * route.gateRadius && pos.y >= route.gateMinAlt && pos.y <= route.gateMaxAlt
}

export function step(
  spec: AircraftSpec,
  state: AircraftState,
  controls: Controls,
  weather: WeatherField,
  route: Route,
  dt: number,
): AircraftState {
  if (state.status !== 'flying') return state
  const aero = aeroOf(spec)
  const tick = Math.round(state.t / dt)
  const w = weather.sample(state.pos, state.t, scratch)
  const wind = v3(w.wind.x, w.wind.y, w.wind.z)
  const turbulence = clamp(w.turbulence, 0, 1)
  const q = state.orientation
  const qInv = qConjugate(q)

  const throttleCmd = clamp(controls.throttle, 0, 1)
  const throttleStep = THROTTLE_RATE * dt
  const throttle = clamp(throttleCmd, state.throttle - throttleStep, state.throttle + throttleStep)
  const fuelKg = Math.max(0, state.fuelKg - spec.fuelBurnFullKgS * throttle * dt)
  const mass = currentMass(spec, state.fuelKg)
  const weight = mass * GRAVITY

  // ── Aerodynamics on air-relative velocity ──
  const airVel = sub(state.vel, wind)
  const V = length(airVel)
  const vb = qRotate(qInv, airVel)
  const alpha = V > MIN_AERO_SPEED ? Math.atan2(-vb.y, vb.x) : 0
  const beta = V > MIN_AERO_SPEED ? Math.asin(clamp(vb.z / V, -1, 1)) : 0
  const rho = airDensity(state.pos.y)
  const qDyn = 0.5 * rho * V * V
  const qs = qDyn * spec.wingAreaM2
  const cl = liftCoeff(aero, alpha)
  const cd = dragCoeff(aero, alpha, cl, beta)
  const thrust = state.fuelKg > 0 ? throttle * spec.maxThrustN * thrustLapse(state.pos.y) : 0

  const seed = weather.seed
  const gustAmp = turbulence * spec.gustSensitivity
  const gustAccel = GUST_ACCEL * gustAmp * gustNoise(seed, 0, tick)

  let fBody = v3(thrust, mass * gustAccel, 0)
  if (V > MIN_AERO_SPEED) {
    const vHat = scale(vb, 1 / V)
    const liftDir = normalize(cross(BODY_RIGHT, vHat))
    fBody = add(fBody, scale(liftDir, qs * cl))
    fBody = add(fBody, scale(vHat, -qs * cd))
    fBody = add(fBody, v3(0, 0, -qs * SIDE_FORCE_PER_RAD * beta))
  }
  const gLoad = fBody.y / weight
  const accel = add(scale(qRotate(q, fBody), 1 / mass), v3(0, -GRAVITY, 0))

  // ── Rotation: rate command + path following + stability, through a first-order lag ──
  const bank = bankAngle(q)
  const cosBank = Math.cos(bank)
  const sinBank = Math.sin(bank)
  const gamma = V > MIN_AERO_SPEED ? Math.asin(clamp(airVel.y / V, -1, 1)) : 0
  const compensation =
    cosBank > 0 ? Math.min((sinBank * sinBank) / cosBank, MAX_BANK_COMPENSATION) * smoothstep(0, 0.3, cosBank) : 0
  const pitchCmd = clamp(controls.pitch, -1, 1)
  const rollCmd = clamp(controls.roll, -1, 1)
  const yawCmd = clamp(controls.yaw, -1, 1)
  // Speed stability yields to the pilot: a held stick means "I want this path", not "fight me".
  const vRef = equilibriumAirspeed(spec, state.pos.y, thrust, mass)
  const tangentialG = V > MIN_AERO_SPEED ? dot(accel, airVel) / (V * GRAVITY) : 0
  const speedCorrection =
    clamp((SPEED_STABILITY * (V - vRef)) / vRef + SPEED_DAMPING * tangentialG, -MAX_SPEED_CORRECTION, MAX_SPEED_CORRECTION) *
    (1 - Math.abs(pitchCmd))
  const nHold = Math.cos(gamma) * (cosBank + compensation) + speedCorrection
  const alphaHold =
    qs > 1
      ? clamp(((nHold * weight - thrust * Math.sin(alpha)) / qs - CL0) / CL_ALPHA, 0.9 * aero.alphaStallNeg, 0.9 * aero.alphaStall)
      : alpha
  const pathRate = V > MIN_AERO_SPEED ? qRotate(qInv, scale(cross(airVel, accel), 1 / (V * V))) : v3(0, 0, 0)
  // Scaled so full stick asks for about the same load factor at any speed and weight.
  const pitchAuthority =
    qDyn > 1 ? Math.min(spec.pitchRate, (aero.pitchAuthority * aero.cruiseQ * mass) / (qDyn * spec.massKg)) : spec.pitchRate

  const gustAlpha = qs > 1 ? (GUST_LOAD * gustAmp * gustNoise(seed, 3, tick) * weight) / (CL_ALPHA * qs) : 0
  const target = v3(
    rollCmd * spec.rollRate - WINGS_LEVELING * sinBank * Math.max(cosBank, 0) * 2 + GUST_ROLL * gustAmp * gustNoise(seed, 1, tick),
    pathRate.y - yawCmd * spec.yawRate - aero.kBeta * beta + GUST_YAW * gustAmp * gustNoise(seed, 2, tick),
    pathRate.z + pitchCmd * pitchAuthority + aero.kAlpha * (alphaHold + gustAlpha - alpha),
  )
  const follow = Math.min(dt / spec.controlLag, 1)
  const angVel = add(state.angVel, scale(sub(target, state.angVel), follow))

  // ── Integrate (semi-implicit Euler) ──
  const vel = add(state.vel, scale(accel, dt))
  const pos = add(state.pos, scale(vel, dt))
  const rate = length(angVel)
  const orientation = rate > 1e-12 ? qNormalize(qMul(q, qFromAxisAngle(angVel, rate * dt))) : q

  // ── Structure ──
  const limit = gLoad >= 0 ? spec.limitGPos : spec.limitGNeg
  const overG = Math.max(0, (gLoad / limit - G_STRESS_ONSET) / (1 - G_STRESS_ONSET))
  const turbulenceStress =
    turbulence > SEVERE_TURBULENCE
      ? TURBULENCE_STRESS_RATE * spec.gustSensitivity * (1 + (2 * (turbulence - SEVERE_TURBULENCE)) / (1 - SEVERE_TURBULENCE))
      : 0
  const overspeed = Math.max(0, Math.sqrt(qDyn / aero.maxSpeedQ) - 1) / OVERSPEED_MARGIN
  const stress = Math.min(
    1,
    state.stress + (G_STRESS_RATE * overG * overG + turbulenceStress + OVERSPEED_STRESS_RATE * overspeed * overspeed) * dt,
  )
  const broken = stress >= 1 || gLoad / limit > INSTANT_FAILURE_FACTOR

  const status: AircraftState['status'] = pos.y <= 0 ? 'crashed' : broken ? 'overstressed' : inGate(pos, route) ? 'arrived' : 'flying'

  return {
    t: state.t + dt,
    pos,
    vel,
    orientation,
    angVel,
    airspeed: length(sub(vel, wind)),
    throttle,
    fuelKg,
    gLoad,
    cabinAccel: (gLoad - 1) * GRAVITY * spec.cabinDamping,
    stress,
    stalled: alpha > aero.alphaStall || alpha < aero.alphaStallNeg,
    status,
  }
}

export const flightModel: FlightModel = { initialState, step }

