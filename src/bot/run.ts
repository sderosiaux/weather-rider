// Headless flight: the exact stepping and telemetry of game/session.ts (flight step → weather sample →
// score tracker → ghost recorder at SIM_DT), minus DOM, three and wall-clock time.
import { SIM_DT } from '../core/constants'
import type { AircraftSpec, AircraftState, Controls, FlightScore, Ghost, MutableWeatherSample, Route, WeatherField } from '../core/types'
import { flightModel } from '../flight'
import { createGhostRecorder, createScoreTracker, scoreReference } from '../scoring'

export type Pilot = (state: AircraftState) => Controls

/** Why a flight ended. 'fuel' = tank ran dry before the end; 'missed-gate' = timed out after crossing the gate plane. */
export type FlightOutcome = 'arrived' | 'crashed' | 'overstressed' | 'fuel' | 'timeout' | 'missed-gate'

export interface RunResult {
  readonly score: FlightScore
  readonly ghost: Ghost
  readonly outcome: FlightOutcome
  /** Primary failure cause is refined: a crash with an empty tank is 'fuel'. */
  readonly fuelEmptyAtS: number | null
  readonly maxAltitude: number
  readonly minAltitude: number
  readonly maxG: number
  readonly minG: number
  readonly steps: number
}

export interface RunOptions {
  readonly pilotName?: string
  readonly dailyNumber?: number
  /** Stop after this many sim seconds (default: 1.5 × the score reference time). */
  readonly maxTimeS?: number
}

export function runFlight(spec: AircraftSpec, route: Route, weather: WeatherField, pilot: Pilot, opts: RunOptions = {}): RunResult {
  const tracker = createScoreTracker(spec, route)
  const recorder = createGhostRecorder({ pilot: opts.pilotName ?? 'bot', dailyNumber: opts.dailyNumber ?? 0, routeId: route.id, aircraftId: spec.id })
  const sample: MutableWeatherSample = { wind: { x: 0, y: 0, z: 0 }, turbulence: 0, dominant: null, cloud: 0 }
  const maxTime = opts.maxTimeS ?? 1.5 * scoreReference(spec, route).timeS
  const maxSteps = Math.ceil(maxTime / SIM_DT)

  let state = flightModel.initialState(spec, route, weather)
  recorder.push(state)
  let fuelEmptyAtS: number | null = null
  let maxAltitude = state.pos.y
  let minAltitude = state.pos.y
  let maxG = 1
  let minG = 1
  let crossedGatePlane = false
  const ux = route.gate.x - route.start.x
  const uz = route.gate.z - route.start.z
  const along2 = ux * ux + uz * uz
  let steps = 0

  while (state.status === 'flying' && steps < maxSteps) {
    const controls = pilot(state)
    state = flightModel.step(spec, state, controls, weather, route, SIM_DT)
    const w = weather.sample(state.pos, state.t, sample)
    tracker.push({ state, controls, weather: { wind: { ...w.wind }, turbulence: w.turbulence, dominant: w.dominant, cloud: w.cloud }, dt: SIM_DT })
    recorder.push(state)
    steps++
    if (fuelEmptyAtS === null && state.fuelKg <= 0) fuelEmptyAtS = state.t
    if (state.pos.y > maxAltitude) maxAltitude = state.pos.y
    if (state.pos.y < minAltitude) minAltitude = state.pos.y
    if (state.gLoad > maxG) maxG = state.gLoad
    if (state.gLoad < minG) minG = state.gLoad
    if (((state.pos.x - route.start.x) * ux + (state.pos.z - route.start.z) * uz) / along2 > 1 + route.gateRadius / Math.sqrt(along2)) crossedGatePlane = true
  }

  const score = tracker.finish()
  const ghost = recorder.finish(score)
  const outcome: FlightOutcome =
    state.status === 'arrived'
      ? 'arrived'
      : fuelEmptyAtS !== null
        ? 'fuel'
        : state.status === 'crashed'
          ? 'crashed'
          : state.status === 'overstressed'
            ? 'overstressed'
            : crossedGatePlane
              ? 'missed-gate'
              : 'timeout'
  return { score, ghost, outcome, fuelEmptyAtS, maxAltitude, minAltitude, maxG, minG, steps }
}
