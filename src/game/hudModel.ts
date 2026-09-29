import { BODY_FORWARD, cross, dot, qRotate, v3 } from '../core/math'
import type { AircraftSpec, AircraftState, FlightScore, HudModel, Route, WeatherSample } from '../core/types'

const M_TO_FT = 3.28084
const MS_TO_FPM = 196.850
const MS_TO_KT = 1.94384
const UP = v3(0, 1, 0)

/** Game meters → displayed real-world km for this route. */
export function realKmPerGameMeter(route: Route): number {
  const gameM = Math.hypot(route.gate.x - route.start.x, route.gate.z - route.start.z)
  return route.realDistanceKm / gameM
}

/** Compass heading of the horizontal ground track: 0 = north (−z), 90 = east (+x). */
export function headingDeg(state: AircraftState): number {
  const deg = (Math.atan2(state.vel.x, -state.vel.z) * 180) / Math.PI
  return (deg + 360) % 360
}

/** Signed horizontal angle from the nose to the gate, + = gate is to the right. */
export function gateBearingDeg(state: AircraftState, route: Route): number {
  const fwd = qRotate(state.orientation, BODY_FORWARD)
  const fwdH = v3(fwd.x, 0, fwd.z)
  const right = cross(fwdH, UP)
  const d = v3(route.gate.x - state.pos.x, 0, route.gate.z - state.pos.z)
  return (Math.atan2(dot(d, right), dot(d, fwdH)) * 180) / Math.PI
}

export function buildHudModel(input: {
  readonly dailyNumber: number
  readonly route: Route
  readonly spec: AircraftSpec
  readonly state: AircraftState
  readonly weather: WeatherSample
  readonly score: FlightScore
  readonly ghostDeltaS: number | null
}): HudModel {
  const { route, spec, state, weather, score } = input
  const gateM = Math.hypot(route.gate.x - state.pos.x, route.gate.z - state.pos.z)
  return {
    dailyNumber: input.dailyNumber,
    routeLabel: route.label,
    altitudeFt: state.pos.y * M_TO_FT,
    verticalSpeedFpm: state.vel.y * MS_TO_FPM,
    airspeedKt: state.airspeed * MS_TO_KT,
    groundSpeedKmh: Math.hypot(state.vel.x, state.vel.z) * 3.6,
    headingDeg: headingDeg(state),
    throttle: state.throttle,
    fuelPct: (state.fuelKg / spec.fuelCapacityKg) * 100,
    comfort: score.comfort,
    stress: state.stress * 100,
    turbulence: weather.turbulence,
    dominant: weather.dominant,
    gLoad: state.gLoad,
    stalled: state.stalled,
    gateDistanceKm: gateM * realKmPerGameMeter(route),
    gateBearingDeg: gateBearingDeg(state, route),
    gateAltitudeOk: state.pos.y >= route.gateMinAlt && state.pos.y <= route.gateMaxAlt,
    displayTimeS: state.t * route.timeScale,
    ghostDeltaS: input.ghostDeltaS,
  }
}
