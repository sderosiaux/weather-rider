// Why jets and lift don't pay: the climb/descent budget against the wind or lift it buys, per aircraft
// and route length, on a synthetic sky (background westerly profile from weather/layout + one flat jet).
// Uses the same planner the surfer flies with, so the table explains the surfer's choices.
import { v3 } from '../src/core/math'
import type { MutableWeatherSample, Route, WeatherField } from '../src/core/types'
import { AIRCRAFT } from '../src/flight'
import { altitudeOptions, performanceOf } from '../src/bot/planner'
import { backgroundSpeed } from '../src/weather/layout'

const JET_ALT = 10_500
const JET_RV = 1_650
const JET_SPEED = 65

export function jetSky(jetSpeed = JET_SPEED, jetAlt = JET_ALT): WeatherField {
  const sample = (p: { y: number }, _t: number, out?: MutableWeatherSample) => {
    const o: MutableWeatherSample = out ?? { wind: { x: 0, y: 0, z: 0 }, turbulence: 0, dominant: null, cloud: 0 }
    const dv = (p.y - jetAlt) / JET_RV
    o.wind.x = backgroundSpeed(p.y) + (Math.abs(dv) < 1 ? jetSpeed * (1 - dv * dv) : 0)
    o.wind.y = 0
    o.wind.z = 0
    o.turbulence = 0.05
    o.dominant = null
    o.cloud = 0
    return o
  }
  return { seed: 1, boundsMin: v3(-1e6, 0, -1e6), boundsMax: v3(1e6, 14_000, 1e6), sample, features: [] }
}

const route = (lengthM: number): Route => ({
  id: 'budget', from: 'A', to: 'B', start: v3(0, 3000, 0), startHeading: v3(1, 0, 0), gate: v3(lengthM, 4000, 0),
  gateRadius: 3000, gateMinAlt: 2000, gateMaxAlt: 6000, realDistanceKm: 5000, timeScale: 30, severity: 0.5, label: 'A → B',
})

/** Markdown: for each aircraft and route length, the jet option vs the best option at ≤ 5 km. */
export function jetBudgetTable(): string {
  const lines = [
    `Synthetic sky: background westerly (weather/layout backgroundSpeed) + a ${JET_SPEED} m/s jet at ${JET_ALT / 1000} km. Start 3 km, gate window 2–6 km. Planner estimates (full-throttle climb at best-climb speed, cruise, idle descent at 70 % of drag/weight).`,
    '',
    '| aircraft | climb 3→10.5 km: min / km flown / fuel % of tank | idle descent 10.5→4.6 km: km | 80 km route: jet vs best ≤5 km (time % / fuel %) | 120 km | 160 km | break-even route length |',
    '|---|---|---|---|---|---|---|',
  ]
  const sky = jetSky()
  for (const spec of AIRCRAFT) {
    const perf = performanceOf(spec)
    let t = 0
    let x = 0
    let ok = true
    for (let h = 3000; h < JET_ALT; h += 250) {
      const c = perf.climb(h)
      if (c.rate < 0.5) {
        ok = false
        break
      }
      const dt = 250 / c.rate
      t += dt
      x += (c.speed + backgroundSpeed(h)) * dt
    }
    const climb = ok ? `${(t / 60).toFixed(1)} / ${(x / 1000).toFixed(0)} / ${((100 * t * spec.fuelBurnFullKgS) / spec.fuelCapacityKg).toFixed(0)}` : 'cannot reach'
    const descentKm = ((JET_ALT - 4600) / (perf.idleSlope * 0.7) / 1000).toFixed(0)
    const cells: string[] = []
    let breakEven = '> 400 km'
    for (const L of [80_000, 120_000, 160_000, 200_000, 250_000, 300_000, 400_000]) {
      const opts = altitudeOptions(spec, route(L), sky, perf, 4600, [3000, 4000, 5000, JET_ALT])
      const low = opts.filter((o) => o.altitude <= 5000 && o.feasible).sort((a, b) => a.timeS - b.timeS)[0]
      const jet = opts.find((o) => o.altitude === JET_ALT)
      const cell = !jet?.feasible || !low ? 'infeasible' : `${((100 * (jet.timeS - low.timeS)) / low.timeS).toFixed(1)} / ${((100 * (jet.fuelKg - low.fuelKg)) / low.fuelKg).toFixed(0)}`
      if (L <= 160_000) cells.push(cell)
      if (breakEven === '> 400 km' && jet?.feasible && low && jet.timeS < low.timeS) breakEven = `${L / 1000} km (time)`
    }
    lines.push(`| ${spec.id} | ${climb} | ${descentKm} | ${cells.join(' | ')} | ${breakEven} |`)
  }
  return lines.join('\n')
}
