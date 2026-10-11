// Runs the balance matrix: days × routes × aircraft × pilots, full headless flights on the real modules.
import { createAutopilot, runFlight, type AutopilotOptions, type FlightOutcome, type Strategy } from '../src/bot'
import type { Ghost, Route } from '../src/core/types'
import { AIRCRAFT } from '../src/flight'
import { dailyWeatherFor, terrainParamsFor, weatherParamsFor } from '../src/meta'
import { scoreReference } from '../src/scoring'
import { createTerrain } from '../src/terrain'
import { createWeather } from '../src/weather'

/** A pilot = a strategy plus optional soaring knobs. The first four are the brief's strategies. */
export interface PilotDef {
  readonly name: string
  readonly strategy: Strategy
  readonly opts?: AutopilotOptions
  /** Weather-aware (the "skill" side of the comparison) or naive. */
  readonly skilled: boolean
  readonly note: string
}

export const PILOTS: readonly PilotDef[] = [
  { name: 'direct', strategy: 'direct', skilled: false, note: 'straight line, gate-window altitude, trimmed cruise' },
  { name: 'reckless', strategy: 'reckless', skilled: false, note: 'straight line, full throttle, hard hands' },
  { name: 'surfer', strategy: 'surfer', skilled: true, note: 'altitude plan + lift riding/circling + storm/sink avoidance, cruise speed' },
  { name: 'eco', strategy: 'eco', skilled: true, note: 'best-range speed, circles lift to bank energy, idle glides' },
  {
    name: 'eco-naive',
    strategy: 'eco',
    skilled: false,
    opts: { profile: { cruise: 'start', circle: false, ride: false, avoid: false } },
    note: 'eco speed policy (best range, idle glide to the gate) on the straight line, blind to the weather',
  },
  {
    name: 'surfer-smooth',
    strategy: 'surfer',
    skilled: true,
    opts: { profile: { circle: false, ride: false } },
    note: 'surfer without circling or lift riding: plan + avoidance only',
  },
  {
    name: 'surfer-fast',
    strategy: 'surfer',
    skilled: true,
    opts: { profile: { speed: 'max', timeWeight: 1, fuelWeight: 0.1, circle: false, liftThrottle: 1 } },
    note: 'full throttle + altitude plan + avoidance (the weather-aware reckless)',
  },
  {
    name: 'surfer-jet',
    strategy: 'surfer',
    skilled: true,
    opts: { profile: { cruise: 'jet' } },
    note: 'surfer forced to climb to the jet core (or its ceiling) whatever the plan says',
  },
]

export const TIERS = ['calm', 'moderate', 'extreme'] as const

export interface FlightRow {
  readonly day: number
  readonly tier: (typeof TIERS)[number]
  readonly routeId: string
  readonly severity: number
  readonly lengthKm: number
  readonly aircraft: string
  readonly pilot: string
  readonly outcome: FlightOutcome
  readonly simTimeS: number
  readonly refTimeS: number
  readonly refFuelKg: number
  readonly fuelUsedKg: number
  readonly fuelRemainingPct: number
  readonly comfort: number
  readonly severeS: number
  readonly stress: number
  readonly weatherUtilization: number
  readonly smooth: number
  readonly speed: number
  readonly eco: number
  readonly maxG: number
  readonly minG: number
  readonly maxAltitude: number
  /** Seconds spent circling in lift, and number of circling sessions. */
  readonly orbitS: number
  readonly orbits: number
  /** Soaring pilots: planned cruise altitude and whether the plan rides the jet (null for straight-line pilots). */
  readonly plannedAlt: number | null
  readonly followJet: boolean | null
  readonly wallMs: number
}

export interface MatrixResult {
  readonly rows: FlightRow[]
  /** Ghost of the best-speed surfer flight per (day, tier), for in-game replay. */
  readonly ghosts: Map<string, { row: FlightRow; ghost: Ghost }>
  readonly wallS: number
}

/** Runs the (day, route tier) units selected by `unit(dayIndex, tierIndex)`; all of them by default. */
export function runMatrix(
  days: readonly number[],
  pilots: readonly PilotDef[],
  onProgress?: (msg: string) => void,
  unit: (dayIndex: number, tierIndex: number) => boolean = () => true,
): MatrixResult {
  const rows: FlightRow[] = []
  const ghosts = new Map<string, { row: FlightRow; ghost: Ghost }>()
  const t0 = performance.now()
  days.forEach((day, di) => {
    const daily = dailyWeatherFor(day)
    daily.routes.forEach((route: Route, i) => {
      if (!unit(di, i)) return
      const weather = createWeather(weatherParamsFor(daily, route))
      const terrain = createTerrain(terrainParamsFor(daily, route))
      for (const spec of AIRCRAFT) {
        const ref = scoreReference(spec, route)
        for (const p of pilots) {
          const w0 = performance.now()
          let orbitS = 0
          let orbits = 0
          let orbitStart = -1
          let plannedAlt: number | null = null
          let followJet: boolean | null = null
          const trace = (t: number, e: string): void => {
            const plan = /^plan cruise=(\d+) followJet=(true|false)/.exec(e)
            if (plan) {
              plannedAlt = Number(plan[1])
              followJet = plan[2] === 'true'
            } else if (e.startsWith('orbit')) {
              orbits++
              orbitStart = t
            } else if (e.startsWith('exit') && orbitStart >= 0) {
              orbitS += t - orbitStart
              orbitStart = -1
            }
          }
          const r = runFlight(spec, { route, weather, terrain }, createAutopilot(p.strategy, spec, route, weather, { ...p.opts, trace }), {
            dailyNumber: day,
            pilotName: `${p.name}-bot`,
          })
          const s = r.score
          const row: FlightRow = {
            day,
            tier: TIERS[i]!,
            routeId: route.id,
            severity: route.severity,
            lengthKm: Math.hypot(route.gate.x - route.start.x, route.gate.z - route.start.z) / 1000,
            aircraft: spec.id,
            pilot: p.name,
            outcome: r.outcome,
            simTimeS: s.simTimeS,
            refTimeS: ref.timeS,
            refFuelKg: ref.ecoFuelKg,
            fuelUsedKg: s.fuelUsedKg,
            fuelRemainingPct: s.fuelRemainingPct,
            comfort: s.comfort,
            severeS: s.severeTurbulenceS,
            stress: s.stress,
            weatherUtilization: s.weatherUtilization,
            smooth: s.smooth,
            speed: s.speed,
            eco: s.eco,
            maxG: r.maxG,
            minG: r.minG,
            maxAltitude: r.maxAltitude,
            orbitS: orbitStart >= 0 ? orbitS + r.score.simTimeS - orbitStart : orbitS,
            orbits,
            plannedAlt,
            followJet,
            wallMs: performance.now() - w0,
          }
          rows.push(row)
          if (p.name === 'surfer' && r.outcome === 'arrived') {
            const key = `${day}:${row.tier}`
            const prev = ghosts.get(key)
            if (!prev || row.speed > prev.row.speed) ghosts.set(key, { row, ghost: r.ghost })
          }
        }
      }
    })
    onProgress?.(`day ${day} done, ${rows.length} flights, ${((performance.now() - t0) / 1000).toFixed(0)} s`)
  })
  return { rows, ghosts, wallS: (performance.now() - t0) / 1000 }
}
