// Aerodynamic model derived from an AircraftSpec. Every coefficient comes from spec numbers,
// so hangar mods that tweak a spec (wing area, thrust, ceiling…) change the physics coherently.
import { GRAVITY, SEA_LEVEL_AIR_DENSITY } from '../core/constants'
import { lerp, smoothstep } from '../core/math'
import type { AircraftSpec } from '../core/types'

export const SCALE_HEIGHT_M = 8500
/** Thrust ∝ (ρ/ρ0)^LAPSE. The service ceiling is where this meets minimum drag. */
export const THRUST_LAPSE = 0.9
/** Altitude at which maxSpeedMs is the level-flight top speed. Above it you go faster (thin air), until the ceiling. */
export const MAX_SPEED_REF_ALT_M = 3000
export const CL0 = 0.2
export const CL_ALPHA = 5
/** Post-stall CL/CD fade into flat-plate values over this many radians. */
const STALL_BREAK = 0.12
/** Full stick at cruise pulls this fraction of limitGPos: yanking is allowed to hurt. */
const DESIGN_G_FRACTION = 0.85
/** Upper bound on stability gain × controlLag: keeps the lagged rotation loop from ringing. */
const MAX_GAIN_LAG = 1.2

export const airDensity = (h: number): number => SEA_LEVEL_AIR_DENSITY * Math.exp(-Math.max(h, 0) / SCALE_HEIGHT_M)
export const thrustLapse = (h: number): number => Math.pow(airDensity(h) / SEA_LEVEL_AIR_DENSITY, THRUST_LAPSE)

export interface Aero {
  readonly clMax: number
  readonly clMin: number
  readonly alphaStall: number
  readonly alphaStallNeg: number
  readonly cd0: number
  /** Induced drag factor: CD = cd0 + k·CL². */
  readonly k: number
  readonly maxLiftToDrag: number
  /** Pitch restoring gain toward the 1 g angle of attack (1/s). */
  readonly kAlpha: number
  /** Yaw restoring gain against sideslip (1/s). */
  readonly kBeta: number
  /** Pilot pitch authority (rad/s) at cruise dynamic pressure; scaled by q_cruise/q so full stick ≈ same g at any speed. */
  readonly pitchAuthority: number
  readonly cruiseQ: number
  /** Highest dynamic pressure reachable in level flight (full thrust at sea level): beyond it you're diving. */
  readonly maxSpeedQ: number
}

/** Mass at full tanks is spec.massKg; burning fuel makes the aircraft lighter. */
export const currentMass = (spec: AircraftSpec, fuelKg: number): number => spec.massKg - (spec.fuelCapacityKg - fuelKg)

const cache = new WeakMap<AircraftSpec, Aero>()

export function aeroOf(spec: AircraftSpec): Aero {
  const hit = cache.get(spec)
  if (hit) return hit
  const aero = deriveAero(spec)
  cache.set(spec, aero)
  return aero
}

function deriveAero(spec: AircraftSpec): Aero {
  const weight = spec.massKg * GRAVITY
  const clMax = (2 * weight) / (SEA_LEVEL_AIR_DENSITY * spec.wingAreaM2 * spec.stallSpeedMs ** 2)
  const clMin = -0.6 * clMax
  // Ceiling: max thrust there equals minimum drag = W / (L/D)max.
  const maxLiftToDrag = weight / (spec.maxThrustN * thrustLapse(spec.serviceCeilingM))
  // Top speed at the reference altitude: T = q·S·cd0 + k·W²/(q·S) with k = 1/(4·(L/D)²·cd0) → quadratic in cd0, high-speed root.
  const tRef = spec.maxThrustN * thrustLapse(MAX_SPEED_REF_ALT_M)
  const qsMax = 0.5 * airDensity(MAX_SPEED_REF_ALT_M) * spec.maxSpeedMs ** 2 * spec.wingAreaM2
  const dMin = weight / maxLiftToDrag
  const disc = Math.max(tRef * tRef - dMin * dMin, 0)
  const cd0 = (tRef + Math.sqrt(disc)) / (2 * qsMax)
  const k = 1 / (4 * maxLiftToDrag ** 2 * cd0)
  const qsLevelSeaLevel = (spec.maxThrustN + Math.sqrt(Math.max(spec.maxThrustN ** 2 - 4 * cd0 * k * weight * weight, 0))) / (2 * cd0)
  const cruiseQ = 0.5 * airDensity(MAX_SPEED_REF_ALT_M) * spec.cruiseSpeedMs ** 2
  const clCruise = weight / (cruiseQ * spec.wingAreaM2)
  const designAlpha = ((DESIGN_G_FRACTION * spec.limitGPos - 1) * clCruise) / CL_ALPHA
  const kAlpha = Math.min(spec.pitchRate / designAlpha, MAX_GAIN_LAG / spec.controlLag)
  return {
    clMax,
    clMin,
    alphaStall: (clMax - CL0) / CL_ALPHA,
    alphaStallNeg: (clMin - CL0) / CL_ALPHA,
    cd0,
    k,
    maxLiftToDrag,
    kAlpha,
    kBeta: Math.min(2, MAX_GAIN_LAG / spec.controlLag),
    pitchAuthority: Math.min(spec.pitchRate, kAlpha * designAlpha),
    cruiseQ,
    maxSpeedQ: Math.max(qsMax, qsLevelSeaLevel) / spec.wingAreaM2,
  }
}

const plate = (alpha: number): number => 1.1 * Math.sin(2 * alpha)

/** 0 in the attached-flow range, → 1 once fully stalled (either sign). */
export function stallBlend(aero: Aero, alpha: number): number {
  if (alpha > aero.alphaStall) return smoothstep(aero.alphaStall, aero.alphaStall + STALL_BREAK, alpha)
  if (alpha < aero.alphaStallNeg) return smoothstep(aero.alphaStallNeg, aero.alphaStallNeg - STALL_BREAK, alpha)
  return 0
}

export function liftCoeff(aero: Aero, alpha: number): number {
  if (alpha > aero.alphaStall) return lerp(aero.clMax, plate(alpha), stallBlend(aero, alpha))
  if (alpha < aero.alphaStallNeg) return lerp(aero.clMin, plate(alpha), stallBlend(aero, alpha))
  return CL0 + CL_ALPHA * alpha
}

export function dragCoeff(aero: Aero, alpha: number, cl: number, beta: number): number {
  const s = Math.sin(alpha)
  const b = Math.sin(beta)
  return aero.cd0 + aero.k * cl * cl + 1.2 * s * s * stallBlend(aero, alpha) + 0.5 * b * b
}

export interface Trim {
  readonly alpha: number
  readonly throttle: number
}

/** Level, unaccelerated flight: L + T·sinα = W, T·cosα = D. Throttle may exceed 1 (not sustainable). */
export function trimLevel(spec: AircraftSpec, altitude: number, airspeed: number, massKg = spec.massKg): Trim {
  const aero = aeroOf(spec)
  const qs = 0.5 * airDensity(altitude) * airspeed * airspeed * spec.wingAreaM2
  const weight = massKg * GRAVITY
  let alpha = 0
  let thrust = 0
  for (let i = 0; i < 30; i++) {
    const cl = (weight - thrust * Math.sin(alpha)) / qs
    alpha = (cl - CL0) / CL_ALPHA
    thrust = (qs * dragCoeff(aero, alpha, cl, 0)) / Math.cos(alpha)
  }
  return { alpha, throttle: thrust / (spec.maxThrustN * thrustLapse(altitude)) }
}

/**
 * Airspeed the aircraft settles at in level flight for this thrust: the high-speed root of T = D(V).
 * When thrust can't hold level flight (idle, empty tank, above ceiling) it is the minimum-drag speed,
 * i.e. best glide.
 */
export function equilibriumAirspeed(spec: AircraftSpec, altitude: number, thrustN: number, massKg: number): number {
  const aero = aeroOf(spec)
  const weight = massKg * GRAVITY
  const disc = thrustN * thrustN - 4 * aero.cd0 * aero.k * weight * weight
  const qsMinDrag = weight * Math.sqrt(aero.k / aero.cd0)
  const qs = disc > 0 ? Math.max((thrustN + Math.sqrt(disc)) / (2 * aero.cd0), qsMinDrag) : qsMinDrag
  return Math.sqrt((2 * qs) / (airDensity(altitude) * spec.wingAreaM2))
}
