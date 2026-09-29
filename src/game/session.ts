// One flight: fixed-step deterministic sim decoupled from the render frame rate.
import { SIM_DT } from '../core/constants'
import type {
  AircraftSpec,
  AircraftState,
  Controls,
  DailyWeather,
  FlightScore,
  Ghost,
  GhostSample,
  HudModel,
  MutableWeatherSample,
  Route,
  Vec3,
  WeatherField,
} from '../core/types'
import { flightModel } from '../flight'
import { createGhostRecorder, createScoreTracker, ghostCodec } from '../scoring'
import { createGhostPace, type GhostPace } from './ghostDelta'
import { buildHudModel } from './hudModel'

/** Avoid the spiral of death after a tab switch: never simulate more than this per frame. */
const MAX_FRAME_S = 0.25

export interface FlightSetup {
  readonly daily: DailyWeather
  readonly route: Route
  readonly spec: AircraftSpec
  readonly weather: WeatherField
  readonly pilot: string
  /** First ghost is the race reference for the HUD delta. */
  readonly ghosts: readonly Ghost[]
}

export interface FlightOutcome {
  readonly score: FlightScore
  readonly ghost: Ghost
  readonly ghostCode: string
}

export interface FlightSession {
  readonly setup: FlightSetup
  state(): AircraftState
  /** Advance the sim by wall-clock dt. Returns the outcome once the flight ended. */
  advance(dtReal: number, controls: Controls): FlightOutcome | null
  hud(): HudModel
  ghostPoses(): readonly GhostSample[]
  /** Dev only: move the aircraft keeping its velocity/orientation (debug deep links). */
  teleport(pos: Vec3): void
}

export function createFlightSession(setup: FlightSetup): FlightSession {
  const { route, spec, weather } = setup
  const tracker = createScoreTracker(spec, route)
  const recorder = createGhostRecorder({ pilot: setup.pilot, dailyNumber: setup.daily.number, routeId: route.id, aircraftId: spec.id })
  const pace: GhostPace | null = setup.ghosts[0] ? createGhostPace(setup.ghosts[0], route) : null
  const sample: MutableWeatherSample = { wind: { x: 0, y: 0, z: 0 }, turbulence: 0, dominant: null, cloud: 0 }

  let state = flightModel.initialState(spec, route, weather)
  let acc = 0
  let outcome: FlightOutcome | null = null
  recorder.push(state)

  const stepOnce = (controls: Controls): void => {
    state = flightModel.step(spec, state, controls, weather, route, SIM_DT)
    const w = weather.sample(state.pos, state.t, sample)
    tracker.push({ state, controls, weather: { wind: { ...w.wind }, turbulence: w.turbulence, dominant: w.dominant, cloud: w.cloud }, dt: SIM_DT })
    recorder.push(state)
  }

  return {
    setup,
    state: () => state,
    advance(dtReal, controls) {
      if (outcome) return outcome
      acc += Math.min(dtReal, MAX_FRAME_S)
      while (acc >= SIM_DT && state.status === 'flying') {
        stepOnce(controls)
        acc -= SIM_DT
      }
      if (state.status !== 'flying') {
        const score = tracker.finish()
        const ghost = recorder.finish(score)
        outcome = { score, ghost, ghostCode: ghostCodec.encode(ghost) }
      }
      return outcome
    },
    hud() {
      weather.sample(state.pos, state.t, sample)
      return buildHudModel({
        dailyNumber: setup.daily.number,
        route,
        spec,
        state,
        weather: sample,
        score: tracker.current(),
        ghostDeltaS: pace ? pace.deltaS(state.t, state.pos) : null,
      })
    },
    ghostPoses: () => setup.ghosts.map((g) => ghostCodec.poseAt(g, state.t)),
    teleport(pos) {
      state = { ...state, pos }
    },
  }
}
