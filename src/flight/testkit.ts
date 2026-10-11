// Test/sandbox helpers: uniform weather fields and a fixed-step runner.
import { SIM_DT } from '../core/constants'
import { v3 } from '../core/math'
import type { AircraftSpec, AircraftState, Controls, FlightEnv, MutableWeatherSample, Vec3, WeatherField, WeatherSample } from '../core/types'
import { flightModel } from './model'

/** Uniform air mass: constant wind and turbulence everywhere. */
export function uniformWeather(wind: Vec3 = v3(0, 0, 0), turbulence = 0, seed = 7): WeatherField {
  const sample = (_p: Vec3, _t: number, out?: MutableWeatherSample): WeatherSample => {
    const o: MutableWeatherSample = out ?? { wind: { x: 0, y: 0, z: 0 }, turbulence: 0, dominant: null, cloud: 0 }
    o.wind.x = wind.x
    o.wind.y = wind.y
    o.wind.z = wind.z
    o.turbulence = turbulence
    o.dominant = null
    o.cloud = 0
    return o
  }
  return { seed, boundsMin: v3(-1e6, 0, -1e6), boundsMax: v3(1e6, 14_000, 1e6), sample, features: [] }
}

export const NEUTRAL = (throttle: number): Controls => ({ pitch: 0, roll: 0, yaw: 0, throttle })

export type Pilot = (s: AircraftState) => Controls

/** Runs until `seconds` elapse or the state turns terminal. Calls `onStep` after each step. */
export function fly(
  spec: AircraftSpec,
  start: AircraftState,
  pilot: Pilot,
  env: FlightEnv,
  seconds: number,
  onStep?: (s: AircraftState) => void,
): AircraftState {
  let s = start
  const n = Math.round(seconds / SIM_DT)
  for (let i = 0; i < n && s.status === 'flying'; i++) {
    s = flightModel.step(spec, s, pilot(s), env, SIM_DT)
    onStep?.(s)
  }
  return s
}

/** Pitch for a target airspeed, like a glider pilot flying the speed ring. */
export const speedPilot =
  (targetAirspeed: number, throttle: number): Pilot =>
  (s) => ({ pitch: Math.max(-1, Math.min(1, (s.airspeed - targetAirspeed) * 0.2)), roll: 0, yaw: 0, throttle })
