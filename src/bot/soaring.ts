// Weather-aware guidance for the surfer and eco strategies. It reads the sky the way a player does:
// the feature list is what the particles and clouds show (columns, jets, storms), and sample() is the
// variometer / flow around the aircraft. It never runs the flight model ahead: decisions are
// heuristics a skilled human could apply by eye, plus a pre-flight altitude plan (planner.ts).
import { clamp, v3 } from '../core/math'
import type { AircraftSpec, AircraftState, MutableWeatherSample, Route, Vec3, WeatherFeature, WeatherField } from '../core/types'
import { scoreReference } from '../scoring'
import { approachAltitude, createGateHold, gateAltitude } from './approach'
import { CRUISE_G, type Guidance } from './autopilot'
import { bearingTo, horizontalDistance, orbitBank, orbitTrack, speedEnvelope, turnRadius, wrapAngle } from './control'
import type { AirReading, Intent, Vertical } from './pilot'
import { altitudeOptions, performanceOf, type AltitudeOption } from './planner'

const DEG = Math.PI / 180

export interface SoaringProfile {
  /** 'plan' = pick the cruise altitude with the planner; 'jet' = force the jet core (or the highest reachable); 'start' = stay at the takeoff altitude; a number = fixed. */
  readonly cruise: 'plan' | 'jet' | 'start' | number
  /** Planner objective weights: J = time/Tref · timeWeight + fuel/Fref · fuelWeight. */
  readonly timeWeight: number
  readonly fuelWeight: number
  /** Circle in lift columns to gain altitude. */
  readonly circle: boolean
  /** Only circle where the expected net climb rate beats this (m/s), and beats the engines' climb. */
  readonly minClimbRate: number
  /** Circle up to the top of the lift even above the cruise altitude (energy bank for a glide). */
  readonly bankEnergy: boolean
  /** Max extra distance (m) accepted to reach a lift column. */
  readonly maxDetour: number
  /** Arrive by this multiple of the reference time (the lab cuts at 1.5). */
  readonly timeBudget: number
  /** Cruise speed policy: trimmed cruise, best range (fuel per ground meter), or full throttle. */
  readonly speed: 'cruise' | 'range' | 'max'
  /** In cruise, let rising air carry the aircraft up (energy banked as altitude). */
  readonly ride: boolean
  /** Throttle while riding rising air, as a fraction of trim (0 = glide in lift). */
  readonly liftThrottle: number
  /** Above the planned profile: glide at idle down to it instead of holding altitude. */
  readonly glideDown: boolean
  /** Steer around storm cores / sink and toward lift lines using sampled air ahead. */
  readonly avoid: boolean
  readonly turbulenceCost: number
  readonly sinkCost: number
  readonly liftGain: number
}

export const SURFER: SoaringProfile = {
  cruise: 'plan',
  timeWeight: 1,
  fuelWeight: 1,
  circle: true,
  minClimbRate: 5,
  bankEnergy: false,
  maxDetour: 8_000,
  timeBudget: 1.3,
  speed: 'cruise',
  ride: true,
  liftThrottle: 0.3,
  glideDown: false,
  avoid: true,
  turbulenceCost: 60,
  sinkCost: 0.5,
  liftGain: 0,
}

export const ECO: SoaringProfile = {
  cruise: 'plan',
  timeWeight: 0.15,
  fuelWeight: 1,
  circle: true,
  minClimbRate: 2.5,
  bankEnergy: true,
  maxDetour: 15_000,
  timeBudget: 1.15,
  speed: 'range',
  ride: true,
  liftThrottle: 0,
  glideDown: true,
  avoid: true,
  turbulenceCost: 30,
  sinkCost: 1.2,
  liftGain: 1,
}

interface Lift {
  readonly id: string
  readonly center: Vec3
  /** Orbit radius around the center. */
  readonly radius: number
  readonly base: number
  readonly top: number
  readonly storm: boolean
}

type Jet = Extract<WeatherFeature, { kind: 'jetstream' }>

type Mode =
  | { kind: 'cruise' }
  | { kind: 'to-lift'; lift: Lift; exitAlt: number }
  | { kind: 'orbit'; lift: Lift; exitAlt: number; hLog: number[] }

/** Jet core (y, z) at abscissa x by linear interpolation along the published polyline. */
export function jetCoreAt(jet: { readonly path: readonly Vec3[] }, x: number): { y: number; z: number } | null {
  const p = jet.path
  for (let i = 0; i + 1 < p.length; i++) {
    const a = p[i]!
    const b = p[i + 1]!
    if (x >= a.x && x <= b.x) {
      const f = (x - a.x) / Math.max(b.x - a.x, 1e-6)
      return { y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f }
    }
  }
  return null
}

export interface SoaringPlan {
  readonly cruiseAltitude: number
  readonly followJet: boolean
  readonly options: readonly AltitudeOption[]
}

export function createSoaringGuidance(
  strategy: 'surfer' | 'eco',
  spec: AircraftSpec,
  route: Route,
  weather: WeatherField,
  air: AirReading,
  overrides: Partial<SoaringProfile>,
  trace?: (t: number, event: string) => void,
  onPlan?: (plan: SoaringPlan) => void,
): Guidance {
  const P: SoaringProfile = { ...(strategy === 'surfer' ? SURFER : ECO), ...overrides }
  const perf = performanceOf(spec)
  const ref = scoreReference(spec, route)
  // Eco flies against its own timetable (best-range time), the others against cruise time.
  const deadline = (strategy === 'eco' ? ref.ecoTimeS : ref.timeS) * P.timeBudget
  const sample: MutableWeatherSample = { wind: { x: 0, y: 0, z: 0 }, turbulence: 0, dominant: null, cloud: 0 }
  const hMax = Math.min(spec.serviceCeilingM * 0.92, 12_500)
  const lineZ = (x: number): number => route.start.z + ((route.gate.z - route.start.z) * (x - route.start.x)) / Math.max(route.gate.x - route.start.x, 1)
  const descentSlope = perf.idleSlope * 0.7

  // ── Jets: every jet whose core passes within reach of the line is a candidate ──
  const midX = (route.start.x + route.gate.x) / 2
  const routeLen = Math.hypot(route.gate.x - route.start.x, route.gate.z - route.start.z)
  const jets = weather.features
    .filter((f): f is Jet => f.kind === 'jetstream')
    .filter((j) => {
      const core = jetCoreAt(j, midX)
      return core !== null && Math.abs(core.z - lineZ(midX)) < j.radius + 15_000
    })
  /** Lateral line to fly at altitude h along jet j: its core when inside its thickness and ≤ 20 km off the route. */
  const lateralOf = (j: Jet | null) => (x: number, h: number): number => {
    if (!j) return NaN
    const core = jetCoreAt(j, x)
    return core && Math.abs(core.y - h) < j.thickness && Math.abs(core.z - lineZ(x)) < 20_000 ? core.z : NaN
  }

  // ── Pre-flight altitude plan ──
  // Eco arrives at the bottom of the window (every metre of descent is free distance); the others
  // keep their cruise altitude when it already sits in the window (no last-minute pushover).
  const lowGate = gateAltitude(route, route.gateMinAlt)
  const floor = lowGate
  const candidates = new Set<number>([Math.max(Math.round(route.start.y / 100) * 100, floor), floor])
  for (let h = 2000; h <= hMax; h += 1000) if (h >= floor) candidates.add(h)
  const plain = altitudeOptions(spec, route, weather, perf, lowGate, [...candidates].sort((a, b) => a - b))
  // One option per jet, flown along its core; the sideways detour (out and back) is charged in time and fuel.
  const jetOptions = jets.flatMap((j) => {
    const core = jetCoreAt(j, midX)!
    if (core.y > hMax) return []
    const [o] = altitudeOptions(spec, route, weather, perf, lowGate, [Math.round(core.y / 100) * 100], lateralOf(j))
    if (!o) return []
    const off = Math.abs(core.z - lineZ(midX))
    const detour = 2 * (Math.hypot(routeLen / 2, off) - routeLen / 2)
    const extra = detour / Math.max(spec.cruiseSpeedMs + o.tailwind, 50)
    return [{ jet: j, option: { ...o, timeS: o.timeS + extra, fuelKg: o.fuelKg * (1 + extra / Math.max(o.timeS, 1)) } }]
  })
  const options = [...plain, ...jetOptions.map((c) => c.option)]
  const cost = (o: AltitudeOption): number =>
    !o.feasible || o.timeS > deadline * 0.95
      ? Infinity
      : (P.timeWeight * o.timeS) / ref.timeS + (P.fuelWeight * o.fuelKg) / ref.ecoFuelKg + 3 * Math.max(0, o.turbulence - 0.2)
  const highestJet = jetOptions.map((c) => c.jet).sort((a, b) => (jetCoreAt(b, midX)?.y ?? 0) - (jetCoreAt(a, midX)?.y ?? 0))[0] ?? null
  let jet: Jet | null = null
  let cruiseAltitude: number
  if (typeof P.cruise === 'number') cruiseAltitude = Math.min(P.cruise, hMax)
  else if (P.cruise === 'start') cruiseAltitude = Math.max(route.start.y, floor)
  else if (P.cruise === 'jet') {
    jet = highestJet
    const core = jet ? jetCoreAt(jet, midX) : null
    cruiseAltitude = core ? Math.min(core.y, hMax) : hMax
  } else {
    let best: AltitudeOption | null = null
    for (const o of plain) if (cost(o) < (best ? cost(best) : Infinity)) best = o
    for (const c of jetOptions) {
      if (cost(c.option) < (best ? cost(best) : Infinity)) {
        best = c.option
        jet = c.jet
      }
    }
    cruiseAltitude = best ? best.altitude : route.start.y
  }
  const jetCore = jet ? jetCoreAt(jet, midX) : null
  const jetLateral = lateralOf(jet)
  const gateAlt = P.glideDown ? lowGate : gateAltitude(route, cruiseAltitude)
  const followJet = !!jetCore && Math.abs(jetCore.y - cruiseAltitude) < (jet?.thickness ?? 0) * 0.6
  onPlan?.({ cruiseAltitude, followJet, options })
  trace?.(
    0,
    `plan cruise=${cruiseAltitude.toFixed(0)} followJet=${followJet} ` +
      options.map((o) => `${o.altitude}:${o.feasible ? `${o.timeS.toFixed(0)}s/${o.fuelKg.toFixed(0)}kg/tw${o.tailwind.toFixed(0)}` : 'x'}`).join(' '),
  )

  const cruiseAltAt = (x: number): number => {
    if (followJet && jet) {
      const core = jetCoreAt(jet, x)
      if (core) return Math.min(core.y, hMax)
    }
    return cruiseAltitude
  }

  // ── Lift columns ──
  const orbitSpeed = (h: number): number => speedEnvelope(spec, h, 35 * DEG).minTas * 1.08
  const lifts: Lift[] = []
  for (const f of weather.features) {
    if (f.kind === 'updraft' || f.kind === 'thermal') lifts.push({ id: f.id, center: f.center, radius: f.radius * 0.45, base: f.base, top: f.top, storm: false })
    else if (f.kind === 'storm') lifts.push({ id: f.id, center: f.center, radius: f.radius * 0.9, base: f.base, top: f.top, storm: true })
  }

  /** Mean vertical wind and worst turbulence around an orbit at altitude h (the vario after one turn). */
  const orbitLift = (center: Vec3, radius: number, h: number, t: number): { w: number; turb: number } => {
    let w = 0
    let turb = 0
    const n = 8
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const s = weather.sample(v3(center.x + radius * Math.cos(a), h, center.z + radius * Math.sin(a)), t, sample)
      w += s.wind.y / n
      turb = Math.max(turb, s.turbulence)
    }
    return { w, turb }
  }

  /** Still-air sink circling at 35° bank at orbit speed with the lift throttle: (drag − thrust)·V / W. */
  const circlingSink = (h: number): number => {
    const v = orbitSpeed(h)
    const trim = Math.max(perf.trim(h, v), 0)
    return trim * 1.2 * (1 - P.liftThrottle) * perf.thrustToWeight(h) * v
  }

  const pickLift = (state: AircraftState, goal: number): { lift: Lift; exitAlt: number } | null => {
    const pos = state.pos
    const toGate = horizontalDistance(pos, route.gate)
    let best: { lift: Lift; exitAlt: number; value: number } | null = null
    for (const lift of lifts) {
      const dGate = horizontalDistance(lift.center, route.gate)
      if (dGate > toGate - 3000 || dGate < 12_000) continue
      const dHere = horizontalDistance(pos, lift.center)
      const detour = dHere + dGate - toGate
      if (detour > P.maxDetour || dHere > 35_000) continue
      if (pos.y < lift.base || pos.y > lift.top - 800) continue
      const h = pos.y
      const v = orbitSpeed(h)
      const r = lift.storm ? lift.radius : Math.max(lift.radius, turnRadius(v + 12, 32 * DEG))
      const here = orbitLift(lift.center, r, h, state.t)
      if (here.turb > (lift.storm ? 0.8 : 0.65)) continue
      const climb = here.w - circlingSink(h)
      const engine = perf.climb(h).rate
      if (climb < P.minClimbRate || (!P.bankEnergy && climb < engine)) continue
      let top = h
      for (let y = h + 500; y <= Math.min(lift.top, goal); y += 500) {
        const up = orbitLift(lift.center, r, y, state.t)
        if (up.w - circlingSink(y) < P.minClimbRate * 0.6 || up.turb > 0.8) break
        top = y
      }
      // Climb only as long as the schedule allows.
      const spare = deadline - state.t - (dHere + dGate) / Math.max(state.airspeed, 60) - (2 * Math.PI * r) / v
      const exitAlt = Math.min(goal, top, h + spare * climb * 0.8)
      const gain = exitAlt - h
      if (gain < 800) continue
      const value = gain / (gain / climb + detour / v) - here.turb * 5
      if (!best || value > best.value) best = { lift: { ...lift, radius: r }, exitAlt, value }
    }
    return best
  }

  /** Cost of flying `track` for the next ~10 km, from sampled air along it. */
  const trackCost = (pos: Vec3, h: number, track: number, t: number): number => {
    let c = 0
    const cx = Math.cos(track)
    const cz = -Math.sin(track)
    const n = 6
    for (let i = 1; i <= n; i++) {
      const d = i * 1800
      const s = weather.sample(v3(pos.x + cx * d, h, pos.z + cz * d), t, sample)
      const turb = Math.max(0, s.turbulence - 0.3)
      c += P.turbulenceCost * turb * turb + P.sinkCost * Math.max(0, -s.wind.y) - P.liftGain * Math.max(0, s.wind.y)
    }
    return c / n
  }

  const gateHold = createGateHold(spec, route)
  let mode: Mode = { kind: 'cruise' }
  let lastAvoidT = -Infinity
  let offset = 0
  let lastLiftCheck = -Infinity

  const cruiseIntent = (state: AircraftState): Intent => {
    const pos = state.pos
    const h = pos.y
    const d = horizontalDistance(pos, route.gate)
    // Line up for the gate early enough to take out a few km of dodging with gentle S-turns (fast aircraft need longer).
    const finalLeg = Math.max(8000, 2.5 * Math.sqrt(3000 * turnRadius(state.airspeed, 25 * DEG)))
    // Aim 10 km ahead on the preferred lateral line (the jet core when riding it), the gate on final.
    const aheadX = Math.min(pos.x + 10_000, route.gate.x)
    // Leave a jet beside the line early enough to come back across: ~3 km of run per km of offset.
    const offLine = Math.abs(pos.z - lineZ(pos.x))
    const lineUp = Math.max(20_000, 1.5 * finalLeg, 3 * offLine + 8000)
    const jz = followJet && d > lineUp ? jetLateral(aheadX, jetCoreAt(jet!, aheadX)?.y ?? h) : NaN
    const aim = d > lineUp ? v3(aheadX, 0, Number.isNaN(jz) ? lineZ(aheadX) : jz) : route.gate
    const baseTrack = bearingTo(pos, aim)
    if (P.avoid && state.t - lastAvoidT >= 1 && d > finalLeg) {
      lastAvoidT = state.t
      let best = offset
      let bestCost = Infinity
      for (let k = -5; k <= 5; k++) {
        const off = k * 10 * DEG
        const c = trackCost(pos, h, baseTrack + off, state.t) + 12 * off * off + 2 * Math.abs(off - offset)
        if (c < bestCost) {
          bestCost = c
          best = off
        }
      }
      offset = best
    }
    if (d <= finalLeg) offset = 0
    const track = wrapAngle(baseTrack + offset)

    const planned = cruiseAltAt(pos.x)
    const target = approachAltitude(route, pos, planned, gateAlt, descentSlope, state.airspeed)
    const windX = state.vel.x - state.airspeed * Math.cos(track)
    const windZ = state.vel.z + state.airspeed * Math.sin(track)
    const tailwind = windX * Math.cos(track) - windZ * Math.sin(track)
    const full = P.speed === 'max'
    let speed = P.speed === 'range' ? perf.rangeSpeed(h, clamp(tailwind, -40, 80)) : full ? perf.cruiseSpeed(h, 1.2) * 1.3 : perf.cruiseSpeed(h)
    // Behind schedule: speed up to make the deadline.
    const remaining = deadline - state.t
    const ground = Math.max(Math.hypot(state.vel.x, state.vel.z), 30)
    const needed = remaining > 1 ? d / remaining : Infinity
    const late = needed > ground * 0.97
    if (late) speed = Math.min(spec.cruiseSpeedMs * 1.1, speed + (needed - ground) * 1.5)

    const base = { track, maxBank: 25 * DEG, speed, minThrottle: full ? 1 : 0, maxThrottle: 1, gLimit: CRUISE_G }
    const descending = target < h - 250
    if (P.ride && air.windY > 2 && !descending && h < Math.min((P.bankEnergy ? hMax : planned) + 1500, hMax)) {
      // Rising air: stay level relative to the air mass and let it carry us up; the altitude is banked for later.
      return { ...base, vertical: { kind: 'air-path', gamma: 0 } }
    }
    if (h < target - 150) {
      // Climb at cruise speed with the power the engines have left: a steady, gentle climb.
      const rate = clamp(perf.climb(h).rate * 0.7, 2, 8)
      return { ...base, vertical: { kind: 'altitude', target, maxClimb: rate, maxSink: 8, tau: 25 } }
    }
    if (P.glideDown && descending && !late) {
      return { ...base, speed: perf.glideSpeed(h), vertical: { kind: 'speed' }, minThrottle: 0, maxThrottle: 0 }
    }
    if (descending) return { ...base, minThrottle: 0, vertical: { kind: 'altitude', target, maxClimb: 8, maxSink: Math.max(8, descentSlope * speed * 1.2), tau: 25 } }
    const vertical: Vertical = { kind: 'altitude', target, maxClimb: 8, maxSink: Math.max(8, descentSlope * speed * 1.2), tau: 25 }
    return { ...base, vertical }
  }

  return (state) => {
    const hold = gateHold(state, gateAlt)
    if (hold) return hold
    const pos = state.pos
    const goal = P.bankEnergy ? hMax : cruiseAltAt(pos.x)

    if (mode.kind === 'cruise' && P.circle && state.t - lastLiftCheck >= 4) {
      lastLiftCheck = state.t
      const target = approachAltitude(route, pos, goal, gateAlt, descentSlope, state.airspeed)
      if (target - pos.y > 800) {
        const pick = pickLift(state, target)
        if (pick) {
          mode = { kind: 'to-lift', ...pick }
          trace?.(state.t, `to-lift ${pick.lift.id} r=${pick.lift.radius.toFixed(0)} h=${pos.y.toFixed(0)} exit=${pick.exitAlt.toFixed(0)}`)
        }
      }
    }

    if (mode.kind === 'to-lift') {
      const m = mode
      const d = horizontalDistance(pos, m.lift.center)
      if (d < m.lift.radius * 1.25) {
        mode = { kind: 'orbit', lift: m.lift, exitAlt: m.exitAlt, hLog: [] }
        trace?.(state.t, `orbit ${m.lift.id} h=${pos.y.toFixed(0)}`)
      } else {
        const eta = state.t + (d + horizontalDistance(m.lift.center, route.gate)) / Math.max(state.airspeed, 60)
        if (eta > deadline) {
          mode = { kind: 'cruise' }
        } else {
          return {
            track: bearingTo(pos, m.lift.center),
            maxBank: 25 * DEG,
            vertical: { kind: 'altitude', target: pos.y, maxClimb: 5, maxSink: 5, tau: 30 },
            speed: Math.max(orbitSpeed(pos.y) * 1.2, perf.cruiseSpeed(pos.y) * 0.85),
            minThrottle: 0,
            maxThrottle: 1,
          }
        }
      }
    }

    if (mode.kind === 'orbit') {
      const m = mode
      m.hLog.push(pos.y)
      if (m.hLog.length > 200) m.hLog.shift()
      const climb = m.hLog.length >= 150 ? ((pos.y - m.hLog[0]!) * 10) / m.hLog.length : Infinity
      const eta = state.t + horizontalDistance(pos, route.gate) / Math.max(perf.cruiseSpeed(pos.y), 60)
      if (pos.y >= m.exitAlt || climb < P.minClimbRate * 0.4 || eta > deadline) {
        trace?.(state.t, `exit ${m.lift.id} h=${pos.y.toFixed(0)} climb=${climb.toFixed(1)} eta=${eta.toFixed(0)}/${deadline.toFixed(0)}`)
        mode = { kind: 'cruise' }
        lastLiftCheck = state.t + 20
      } else {
        const v = orbitSpeed(pos.y)
        const ground = Math.hypot(state.vel.x, state.vel.z)
        const dCenter = horizontalDistance(pos, m.lift.center)
        const thr = P.liftThrottle * Math.max(perf.trim(pos.y, v), 0) * 1.2
        return {
          track: orbitTrack(pos, m.lift.center, m.lift.radius, 1),
          maxBank: 38 * DEG,
          bankFeedForward: dCenter < m.lift.radius * 1.4 ? clamp(orbitBank(ground, m.lift.radius, 1), -38 * DEG, 38 * DEG) : 0,
          vertical: { kind: 'speed' },
          speed: v,
          minThrottle: thr,
          maxThrottle: thr,
        }
      }
    }
    return cruiseIntent(state)
  }
}
