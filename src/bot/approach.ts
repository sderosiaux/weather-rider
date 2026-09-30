// Arrival: planning the descent into the gate's altitude window, and circling into it when late.
import { GRAVITY } from '../core/constants'
import { clamp } from '../core/math'
import type { AircraftSpec, AircraftState, Route } from '../core/types'
import { bearingTo, horizontalDistance, orbitBank, orbitTrack, speedEnvelope, trackOf, turnRadius, wrapAngle } from './control'
import type { Intent } from './pilot'

const DEG = Math.PI / 180

/** Altitude to be at when crossing into the gate cylinder: our preferred altitude clamped into the window with a margin. */
export function gateAltitude(route: Route, preferred: number): number {
  const margin = Math.min(600, (route.gateMaxAlt - route.gateMinAlt) / 4)
  return clamp(preferred, route.gateMinAlt + margin, route.gateMaxAlt - margin)
}

/**
 * Altitude target on the way to the gate: `cruise` far out, bounded by a descent/climb slope that
 * ends at `gateAlt` on the gate cylinder. Planning the descent is what makes the arrival window.
 * Plans on 75 % of the slope the airframe can fly, and starts early by the distance a gentle (0.1 g)
 * pushover into that slope takes at `speed`: fast aircraft need kilometres to tip over.
 */
export function approachAltitude(
  route: Route,
  pos: { x: number; z: number },
  cruise: number,
  gateAlt: number,
  descentSlope: number,
  speed: number,
  climbSlope = 0.08,
): number {
  const pushover = (speed * speed * descentSlope) / (0.1 * GRAVITY)
  const d = Math.max(0, Math.hypot(route.gate.x - pos.x, route.gate.z - pos.z) - route.gateRadius * 0.5 - pushover)
  return clamp(cruise, gateAlt - d * climbSlope, gateAlt + d * descentSlope * 0.75)
}

/**
 * Missed approach logic: when the gate is about to be missed (outside the altitude window near it, or
 * passing it too fast to turn in), slow down and circle around the gate while climbing or sinking into
 * the window, then turn in. The circle is 2.2 turn radii wide so the final turn can reach the centre.
 * Sticky: once engaged it never hands back to the en-route guidance. Returns null when not engaged.
 */
export function createGateHold(
  spec: AircraftSpec,
  route: Route,
  trace?: (t: number, event: string) => void,
): (state: AircraftState, gateAlt: number) => Intent | null {
  let phase: 'free' | 'hold' | 'final' = 'free'
  return (state, gateAlt) => {
    const before = phase
    const d = horizontalDistance(state.pos, route.gate)
    const h = state.pos.y
    const inWindow = h > route.gateMinAlt + 30 && h < route.gateMaxAlt - 30
    const settled = h > route.gateMinAlt + 150 && h < route.gateMaxAlt - 150
    const slow = speedEnvelope(spec, h, 35 * DEG).minTas * 1.1
    const radius = Math.max(route.gateRadius * 0.6, 2.2 * turnRadius(slow + 10, 30 * DEG))
    const offBearing = Math.abs(wrapAngle(bearingTo(state.pos, route.gate) - trackOf(state.vel)))
    const missing = d < 1.2 * turnRadius(state.airspeed, 25 * DEG) + route.gateRadius && offBearing > 70 * DEG
    // Out of the window near the gate: only hold if a normal 8 % descent/climb can't fix it before the cylinder.
    const need = Math.max(h - (route.gateMaxAlt - 200), route.gateMinAlt + 200 - h, 0)
    const fixable = need <= Math.max(0, d - route.gateRadius) * 0.08
    if (phase === 'free' && ((!inWindow && !fixable && d < radius + route.gateRadius * 1.5) || missing)) phase = 'hold'
    else if (phase === 'hold' && settled) phase = 'final'
    else if (phase === 'final' && !inWindow) phase = 'hold'
    if (phase !== before) trace?.(state.t, `gate ${phase} d=${d.toFixed(0)} h=${h.toFixed(0)}`)
    if (phase === 'free') return null
    const vertical = { kind: 'altitude', target: gateAlt, maxClimb: 15, maxSink: 25, tau: 10 } as const
    if (phase === 'final') {
      // The gate inside our turning circle can't be reached by turning toward it: fly straight on until it
      // leaves the circle, then turn in (a teardrop, flown by geometry rather than by angle).
      const toGate = bearingTo(state.pos, route.gate)
      const track = trackOf(state.vel)
      const turn = turnRadius(Math.max(Math.hypot(state.vel.x, state.vel.z), slow), 35 * DEG)
      const side = wrapAngle(toGate - track) > 0 ? 1 : -1
      // Centre of the turning circle on the gate's side (heading angles: +90° = left of track).
      const ca = track + (side * Math.PI) / 2
      const cx = state.pos.x + turn * Math.cos(ca)
      const cz = state.pos.z - turn * Math.sin(ca)
      const outbound = Math.hypot(route.gate.x - cx, route.gate.z - cz) < turn * 0.95
      return { track: outbound ? track : toGate, maxBank: 35 * DEG, vertical, speed: slow, minThrottle: 0, maxThrottle: 1 }
    }
    const groundSpeed = Math.hypot(state.vel.x, state.vel.z)
    return {
      track: orbitTrack(state.pos, route.gate, radius, 1),
      maxBank: 35 * DEG,
      bankFeedForward: d < radius * 1.4 ? orbitBank(groundSpeed, radius, 1) : 0,
      vertical,
      speed: slow,
      minThrottle: 0,
      maxThrottle: 1,
    }
  }
}
