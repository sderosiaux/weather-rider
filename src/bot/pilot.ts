// Inner loops: turns a guidance intent (where to go, how high, how fast) into stick and throttle,
// through human-rate hands. Every strategy shares this, so they differ only in their decisions.
import { SIM_DT } from '../core/constants'
import { clamp } from '../core/math'
import type { AircraftSpec, AircraftState, Controls, MutableWeatherSample, WeatherField } from '../core/types'
import {
  airPathAngle,
  bankAngle,
  bankForTrack,
  pathAngleForVerticalSpeed,
  pitchForPathAngle,
  rollForBank,
  slew,
  speedEnvelope,
  throttleFor,
  trackOf,
  verticalSpeedForAltitude,
  type HandRates,
} from './control'

export type Vertical =
  /** Converge on an altitude (ground frame), climbing/sinking no faster than the given rates. */
  | { readonly kind: 'altitude'; readonly target: number; readonly maxClimb: number; readonly maxSink: number; readonly tau?: number }
  /** Hold a flight-path angle relative to the air mass: rising air carries the aircraft up for free. */
  | { readonly kind: 'air-path'; readonly gamma: number }
  /** Hold the target airspeed with the stick (glider style): altitude is whatever the air and throttle give. */
  | { readonly kind: 'speed' }

export interface Intent {
  readonly track: number
  readonly maxBank: number
  readonly bankFeedForward?: number
  readonly vertical: Vertical
  readonly speed: number
  readonly minThrottle: number
  readonly maxThrottle: number
  /** Fixed throttle instead of speed hold (reckless). */
  readonly fixedThrottle?: number
  /** Gentler (or harder) path corrections than the hands' default, in g. */
  readonly gLimit?: number
}

/** Sees the local air like a pilot reading the vario and the particle flow. */
export interface AirReading {
  windY: number
  turbulence: number
}

export interface InnerLoop {
  (state: AircraftState, intent: Intent): Controls
  readonly air: AirReading
}

/** Guidance runs at this rate (Hz); inner loops at the sim rate. */
export const GUIDANCE_HZ = 10

export function createInnerLoop(spec: AircraftSpec, weather: WeatherField, hands: HandRates): InnerLoop {
  const sample: MutableWeatherSample = { wind: { x: 0, y: 0, z: 0 }, turbulence: 0, dominant: null, cloud: 0 }
  const air: AirReading = { windY: 0, turbulence: 0 }
  let prev: Controls | null = null
  let tick = 0
  /** Integral of the path-angle loop: trims out the model's speed-stability pull. */
  let pitchTrim = 0
  /** Felt load factor, low-passed: the pilot's seat-of-the-pants g-meter. */
  let gFelt = 1

  const loop = (state: AircraftState, intent: Intent): Controls => {
    if (tick++ % (60 / GUIDANCE_HZ) === 0) {
      const w = weather.sample(state.pos, state.t, sample)
      // Low-passed like a real variometer: the pilot reacts to the air mass, not each gust.
      air.windY += (w.wind.y - air.windY) * 0.5
      air.turbulence = w.turbulence
    }
    const bank = bankAngle(state.orientation)
    const V = state.airspeed
    const h = state.pos.y
    const env = speedEnvelope(spec, h, bank)

    const targetBank = bankForTrack(trackOf(state.vel), intent.track, intent.maxBank, 1.6, intent.bankFeedForward ?? 0)
    let roll = rollForBank(spec, bank, targetBank)

    const gamma = airPathAngle(state, air.windY)
    let gLimit = intent.gLimit ?? hands.gLimit
    let gammaTarget: number
    if (intent.vertical.kind === 'altitude') {
      const v = intent.vertical
      const vs = verticalSpeedForAltitude(h, v.target, v.maxClimb, v.maxSink, v.tau)
      gammaTarget = pathAngleForVerticalSpeed(V, vs, air.windY)
    } else if (intent.vertical.kind === 'air-path') {
      gammaTarget = intent.vertical.gamma
    } else {
      // Too fast → raise the nose; ≈ 8 s time constant on the speed error, at most ~2° of path change at a time.
      gammaTarget = gamma + clamp((V - intent.speed) / (8 * 9.81), -0.035, 0.035)
    }
    // Energy protection: trade altitude for speed near the stall, speed for altitude near overspeed.
    if (V < env.minTas || V > env.maxTas) gLimit = Math.max(gLimit, hands.gLimit)
    if (V < env.minTas) gammaTarget = Math.min(gammaTarget, gamma) - 0.012 * (env.minTas - V)
    if (V > env.maxTas) gammaTarget = Math.max(gammaTarget, gamma) + 0.012 * (V - env.maxTas)
    gammaTarget = clamp(gammaTarget, -0.35, 0.35)
    const p = pitchForPathAngle(gamma, gammaTarget, V, 3, gLimit)
    // g-limiter on what the pilot feels (minus the steady turn load): never pull or push past gLimit.
    gFelt += (state.gLoad - gFelt) * (SIM_DT / 0.4)
    const dg = gFelt - 1 / Math.max(Math.cos(bank), 0.5)
    const pushingOver = (p > 0 && dg > 0.8 * gLimit) || (p < 0 && dg < -0.8 * gLimit)
    // Slow integral: holding a path the model's speed stability disagrees with takes steady stick.
    // Frozen while at the g limit (no windup); leaks back to neutral.
    pitchTrim = clamp(pitchTrim * (1 - SIM_DT / 40) + (pushingOver ? 0 : (p * SIM_DT) / 3), -0.4, 0.4)
    let pitch = p + pitchTrim
    if (dg > gLimit) pitch -= 1.5 * (dg - gLimit)
    if (dg < -gLimit) pitch += 1.5 * (-gLimit - dg)
    pitch = clamp(pitch, -0.7, 0.7)

    let throttle =
      intent.fixedThrottle ?? throttleFor(spec, state, clamp(intent.speed, env.minTas, env.maxTas), gammaTarget, intent.minThrottle, intent.maxThrottle)
    if (V < env.minTas) throttle = Math.max(throttle, intent.maxThrottle)
    if (V > env.maxTas) throttle = Math.min(throttle, intent.minThrottle)

    if (state.stalled) {
      pitchTrim = 0
      pitch = -0.5
      roll = rollForBank(spec, bank, 0)
      throttle = 1
    }
    const cmd: Controls = { pitch, roll, yaw: 0, throttle }
    prev = slew(prev ?? { pitch: 0, roll: 0, yaw: 0, throttle: state.throttle }, cmd, hands, SIM_DT)
    return prev
  }
  return Object.assign(loop, { air })
}
