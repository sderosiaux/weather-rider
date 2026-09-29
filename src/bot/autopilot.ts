// Deterministic autopilots. Each strategy is a guidance policy (where to go, how high, how fast) on
// top of the same human-rate inner loops (pilot.ts), so score differences come from decisions, not
// from one bot having better hands.
import type { AircraftSpec, AircraftState, Controls, Route, WeatherField } from '../core/types'
import { createGateHold, gateAltitude } from './approach'
import { bearingTo, HUMAN_HANDS, type HandRates } from './control'
import { createInnerLoop, GUIDANCE_HZ, type Intent, type Vertical } from './pilot'
import { createSoaringGuidance, type SoaringProfile } from './soaring'

export type Strategy = 'direct' | 'surfer' | 'eco' | 'reckless'
export const STRATEGIES: readonly Strategy[] = ['direct', 'surfer', 'eco', 'reckless']

export type Autopilot = (state: AircraftState) => Controls

/** Guidance: called at GUIDANCE_HZ, returns the intent the inner loops hold until the next call. */
export type Guidance = (state: AircraftState) => Intent

const DEG = Math.PI / 180
/** Planned path changes (climbs, descents, level-offs) are flown at ±0.1 g: passengers barely notice. */
export const CRUISE_G = 0.1
const RECKLESS_HANDS: HandRates = { pitch: 3, roll: 5, throttle: 2, gLimit: 0.6 }

export interface AutopilotOptions {
  /** Soaring knobs for surfer/eco (lab variants). */
  readonly profile?: Partial<SoaringProfile>
  /** Receives guidance decisions (mode changes) for lab traces. */
  readonly trace?: (t: number, event: string) => void
}

export function createAutopilot(strategy: Strategy, spec: AircraftSpec, route: Route, weather: WeatherField, opts: AutopilotOptions = {}): Autopilot {
  const hands = strategy === 'reckless' ? RECKLESS_HANDS : HUMAN_HANDS
  const inner = createInnerLoop(spec, weather, hands)
  const guidance: Guidance =
    strategy === 'direct'
      ? straightGuidance(spec, route, { throttle: null, maxBank: 25 * DEG, tau: 25, gLimit: CRUISE_G })
      : strategy === 'reckless'
        ? straightGuidance(spec, route, { throttle: 1, maxBank: 40 * DEG, tau: 8, gLimit: 0.6 })
        : createSoaringGuidance(strategy, spec, route, weather, inner.air, opts.profile ?? {}, opts.trace)
  let intent: Intent | null = null
  let tick = 0
  return (state) => {
    if (intent === null || tick % (60 / GUIDANCE_HZ) === 0) intent = guidance(state)
    tick++
    return inner(state, intent)
  }
}

/** Direct and reckless: the straight line, one altitude (the middle of the gate window), no weather awareness. */
function straightGuidance(spec: AircraftSpec, route: Route, o: { throttle: number | null; maxBank: number; tau: number; gLimit: number }): Guidance {
  const gateAlt = gateAltitude(route, (route.gateMinAlt + route.gateMaxAlt) / 2)
  const gateHold = createGateHold(spec, route)
  return (state) => {
    const hold = gateHold(state, gateAlt)
    if (hold) return o.throttle === null ? hold : { ...hold, fixedThrottle: o.throttle }
    const vertical: Vertical = { kind: 'altitude', target: gateAlt, maxClimb: 8, maxSink: 8, tau: o.tau }
    return {
      track: bearingTo(state.pos, route.gate),
      maxBank: o.maxBank,
      vertical,
      speed: spec.cruiseSpeedMs,
      minThrottle: 0,
      maxThrottle: 1,
      gLimit: o.gLimit,
      ...(o.throttle === null ? {} : { fixedThrottle: o.throttle }),
    }
  }
}
