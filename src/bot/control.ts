// Pure control laws shared by every strategy. They command the flight model the way a pilot's hands
// would: stick deflections bounded to [-1, 1], moved at bounded rates, closing loops on what the
// instruments show (ground track, bank, flight-path angle relative to the air, airspeed).
// Angles follow flight/model.ts: heading 0 = east, positive toward north (−z); bank positive = right wing down.
import { GRAVITY } from '../core/constants'
import { clamp } from '../core/math'
import type { AircraftSpec, AircraftState, Controls, Vec3 } from '../core/types'
import { airDensity, bankAngle, trimLevel } from '../flight'

const TAU = Math.PI * 2
const RHO0 = airDensity(0)

export const wrapAngle = (a: number): number => {
  const r = (a + Math.PI) % TAU
  return (r < 0 ? r + TAU : r) - Math.PI
}

/** Heading-convention angle of the horizontal vector (dx, dz). */
export const headingOfXZ = (dx: number, dz: number): number => Math.atan2(-dz, dx)

/** Ground track angle (heading convention). */
export const trackOf = (vel: Vec3): number => headingOfXZ(vel.x, vel.z)

export const bearingTo = (from: Vec3, to: Vec3): number => headingOfXZ(to.x - from.x, to.z - from.z)

export const horizontalDistance = (a: Vec3, b: Vec3): number => Math.hypot(b.x - a.x, b.z - a.z)

/** Mass right now: tanks burn off. Same law as flight/aero.ts currentMass. */
export const massOf = (spec: AircraftSpec, fuelKg: number): number => spec.massKg - (spec.fuelCapacityKg - fuelKg)

/** Equivalent airspeed: what the wing (and stall/overspeed limits) actually feels. */
export const eas = (tas: number, altitude: number): number => tas * Math.sqrt(airDensity(altitude) / RHO0)
export const tasFromEas = (easMs: number, altitude: number): number => easMs / Math.sqrt(airDensity(altitude) / RHO0)

/** Load factor limits we fly inside: stall EAS grows with √n, overspeed starts at maxSpeedMs taken at 3 km (flight/aero.ts). */
export function speedEnvelope(spec: AircraftSpec, altitude: number, bank: number): { minTas: number; maxTas: number } {
  const n = 1 / Math.max(Math.cos(bank), 0.5)
  const minEas = spec.stallSpeedMs * 1.3 * Math.sqrt(n)
  const maxEas = eas(spec.maxSpeedMs, 3000) * 0.97
  return { minTas: tasFromEas(minEas, altitude), maxTas: tasFromEas(maxEas, altitude) }
}

// ─── Lateral ────────────────────────────────────────────────────────────────

/**
 * Bank to fly toward `desiredTrack`. Proportional on the track error, saturated at maxBank,
 * plus an optional feed-forward bank (orbits).
 */
export function bankForTrack(track: number, desiredTrack: number, maxBank: number, gain = 1.6, feedForward = 0): number {
  // Heading positive = left; right bank (positive) turns right ⇒ negative sign.
  return clamp(feedForward - gain * wrapAngle(desiredTrack - track), -maxBank, maxBank)
}

/** Roll stick for a bank target: rate proportional to bank error, cancelling the model's wings-leveling tendency. */
export function rollForBank(spec: AircraftSpec, bank: number, targetBank: number, gain = 1.2): number {
  const rate = gain * (targetBank - bank) + 0.24 * Math.sin(bank) * Math.max(Math.cos(bank), 0)
  return clamp(rate / spec.rollRate, -1, 1)
}

/**
 * Circle guidance around a fixed ground point: returns the desired track for an orbit of radius r.
 * dir = +1 counter-clockwise seen from above (left turns), −1 clockwise (right turns).
 */
export function orbitTrack(pos: Vec3, center: Vec3, radius: number, dir: 1 | -1): number {
  const dx = pos.x - center.x
  const dz = pos.z - center.z
  const d = Math.hypot(dx, dz)
  const theta = headingOfXZ(dx, dz)
  const correction = clamp(Math.atan((1.5 * (d - radius)) / Math.max(radius, 1)), -1.2, 1.2)
  return wrapAngle(theta + dir * (Math.PI / 2 + correction))
}

/** Coordinated-turn bank for a ground circle of radius r at ground speed v, signed for dir (left = negative bank). */
export const orbitBank = (groundSpeed: number, radius: number, dir: 1 | -1): number =>
  -dir * Math.atan((groundSpeed * groundSpeed) / (GRAVITY * Math.max(radius, 1)))

/** Smallest ground circle we can hold at this airspeed and bank. */
export const turnRadius = (speed: number, bank: number): number => (speed * speed) / (GRAVITY * Math.tan(bank))

// ─── Vertical ───────────────────────────────────────────────────────────────

/** Flight-path angle relative to the air mass. */
export function airPathAngle(state: AircraftState, windY: number): number {
  const v = Math.max(state.airspeed, 1)
  return Math.asin(clamp((state.vel.y - windY) / v, -1, 1))
}

/**
 * Air-relative path angle that yields `vsTarget` (ground vertical speed) in local vertical wind `windY`.
 */
export function pathAngleForVerticalSpeed(airspeed: number, vsTarget: number, windY: number): number {
  return Math.asin(clamp((vsTarget - windY) / Math.max(airspeed, 1), -0.5, 0.5))
}

/**
 * Pitch stick for a path-angle target. The model's neutral stick holds the current path, so the stick
 * commands path curvature: full stick ≈ +1.1 g. We ask for a first-order convergence of time constant tau.
 */
export function pitchForPathAngle(gamma: number, gammaTarget: number, speed: number, tau = 3, gLimit = 0.5): number {
  const extraG = clamp((speed * (gammaTarget - gamma)) / (tau * GRAVITY), -gLimit, gLimit)
  return extraG / 1.1
}

/** Ground vertical speed to converge on an altitude: proportional, rate-limited. */
export const verticalSpeedForAltitude = (h: number, target: number, maxClimb: number, maxSink: number, tau = 25): number =>
  clamp((target - h) / tau, -maxSink, maxClimb)

// ─── Speed ──────────────────────────────────────────────────────────────────

/**
 * Throttle for an airspeed target on a path angle: trim thrust + climb thrust (W·sinγ) + proportional speed error.
 * Clamped to [minThrottle, maxThrottle].
 */
export function throttleFor(
  spec: AircraftSpec,
  state: AircraftState,
  targetSpeed: number,
  gammaTarget: number,
  minThrottle = 0,
  maxThrottle = 1,
): number {
  const h = state.pos.y
  const mass = massOf(spec, state.fuelKg)
  const trim = trimLevel(spec, h, targetSpeed, mass).throttle
  const available = spec.maxThrustN * Math.pow(airDensity(h) / RHO0, 0.9)
  const climb = (mass * GRAVITY * Math.sin(gammaTarget)) / available
  const err = (targetSpeed - state.airspeed) / targetSpeed
  return clamp(trim + climb + 4 * err, minThrottle, maxThrottle)
}

// ─── Hands ──────────────────────────────────────────────────────────────────

/** Rates (per second) at which the pilot's hands move each control, and how hard they pull. */
export interface HandRates {
  readonly pitch: number
  readonly roll: number
  readonly throttle: number
  /** Largest load-factor change (g) the pilot asks for when correcting the flight path. */
  readonly gLimit: number
}

/** A careful airline-style pilot: ±0.2 g corrections, full stick deflection in ~0.7 s. */
export const HUMAN_HANDS: HandRates = { pitch: 1.5, roll: 3, throttle: 0.6, gLimit: 0.2 }

const toward = (from: number, to: number, maxStep: number): number => (to > from ? Math.min(to, from + maxStep) : Math.max(to, from - maxStep))

/** Slew-rate limited controls: nobody slams the stick from stop to stop in one frame. */
export function slew(prev: Controls, cmd: Controls, rates: HandRates, dt: number): Controls {
  return {
    pitch: toward(prev.pitch, clamp(cmd.pitch, -1, 1), rates.pitch * dt),
    roll: toward(prev.roll, clamp(cmd.roll, -1, 1), rates.roll * dt),
    yaw: 0,
    throttle: toward(prev.throttle, clamp(cmd.throttle, 0, 1), rates.throttle * dt),
  }
}

export { bankAngle }
