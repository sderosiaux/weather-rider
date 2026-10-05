// Scratch parameter sweep (not committed).
import { it } from 'vitest'
import { SIM_DT } from '../src/core/constants'
import { createFixtureWeather, fixtureRoute } from '../src/core/fixtures'
import { BODY_FORWARD, qRotate, v3 } from '../src/core/math'
import type { AircraftSpec, AircraftState, Controls, WeatherField } from '../src/core/types'
import { AIRCRAFT, aircraftById } from '../src/flight/aircraft'
import { NEUTRAL, uniformWeather } from '../src/flight/testkit'
import { flightModel as srcModel } from '../src/flight/model'
import { P, flightModel as varModel } from './model.var'
const m = process.env.SRC ? srcModel : varModel

const still = uniformWeather()

function run(spec: AircraftSpec, s0: AircraftState, pilot: (s: AircraftState) => Controls, w: WeatherField, seconds: number, on?: (s: AircraftState) => void): AircraftState {
  let s = s0
  const n = Math.round(seconds / SIM_DT)
  for (let i = 0; i < n && s.status === 'flying'; i++) {
    s = m.step(spec, s, pilot(s), w, fixtureRoute, SIM_DT)
    on?.(s)
  }
  return s
}
const theta = (s: AircraftState): number => (Math.asin(qRotate(s.orientation, BODY_FORWARD).y) * 180) / Math.PI
const f = (x: number, d = 1, w = 6): string => x.toFixed(d).padStart(w)

interface StepStats { gMin: number; gMax: number; maxRise: number; thetaRise: number; dV10: number; dV60: number; vs10: number; vs30: number; lateRange: number; lateMin: number; lateMax: number }

function stepResponse(spec: AircraftSpec, from: (trim: number) => number, to: (trim: number) => number): StepStats {
  const s0 = m.initialState(spec, fixtureRoute, still)
  const a = from(s0.throttle)
  const b = to(s0.throttle)
  const st: StepStats = { gMin: Infinity, gMax: -Infinity, maxRise: -Infinity, thetaRise: -Infinity, dV10: 0, dV60: 0, vs10: 0, vs30: 0, lateRange: 0, lateMin: Infinity, lateMax: -Infinity }
  let th5 = 0
  let v5 = 0
  let h5 = 0
  run(spec, { ...s0, throttle: a }, (s) => NEUTRAL(s.t < 5 ? a : b), still, 95, (s) => {
    const k = Math.round(s.t / SIM_DT)
    if (k === 300) (th5 = theta(s)), (v5 = s.airspeed), (h5 = s.pos.y)
    if (k > 300) {
      st.gMin = Math.min(st.gMin, s.gLoad)
      st.gMax = Math.max(st.gMax, s.gLoad)
      st.maxRise = Math.max(st.maxRise, s.pos.y - h5)
      st.thetaRise = Math.max(st.thetaRise, theta(s) - th5)
    }
    if (k === 900) (st.dV10 = s.airspeed - v5), (st.vs10 = s.vel.y)
    if (k === 2100) st.vs30 = s.vel.y
    if (k === 3900) st.dV60 = s.airspeed - v5
    if (k >= 2100) (st.lateMin = Math.min(st.lateMin, s.vel.y)), (st.lateMax = Math.max(st.lateMax, s.vel.y))
  })
  st.lateRange = st.lateMax - st.lateMin
  return st
}

function r2(): number {
  const exp = aircraftById('experimental')
  const start = { ...m.initialState(exp, fixtureRoute, still), pos: v3(20_000, 3000, 0) }
  const through = run(exp, start, () => NEUTRAL(0.3), createFixtureWeather(1), 200)
  const around = run(exp, start, () => NEUTRAL(0.3), uniformWeather(v3(8, 0, 0), 0.05, 1), 200)
  return through.pos.y - around.pos.y
}

const SETS: Partial<typeof P>[] = JSON.parse(process.env.SETS ?? '[{}]')

it('sweep', () => {
  const base = { ...P }
  const out: string[] = []
  const ids = (process.env.AC ?? AIRCRAFT.map((a) => a.id).join(',')).split(',')
  for (const set of SETS) {
    Object.assign(P, base, set)
    out.push(`== ${JSON.stringify(P)}  R2 exp updraft ${r2().toFixed(0)} m`)
    out.push('aircraft     | cut-0.14: gMin  dV10  vs10  vs30 rise | cut→0.3: gMin  dV10  dV60  vs10  vs30 rise θrise | idle gMin rise | up→1: gMax  dV60 vs30 lateRange')
    for (const id of ids) {
      const spec = aircraftById(id)
      const a = stepResponse(spec, (t) => t, (t) => t - 0.14)
      const b = stepResponse(spec, (t) => t, () => 0.3)
      const c = stepResponse(spec, (t) => t, () => 0)
      const d = stepResponse(spec, (t) => t - 0.2, () => 1)
      out.push(
        `${id.padEnd(12)} | ${f(a.gMin, 3)}${f(a.dV10)}${f(a.vs10)}${f(a.vs30)}${f(a.maxRise, 0, 5)} | ${f(b.gMin, 3)}${f(b.dV10)}${f(b.dV60)}${f(b.vs10)}${f(b.vs30)}${f(b.maxRise, 0, 5)}${f(b.thetaRise, 2)} | ${f(c.gMin, 3)}${f(c.maxRise, 0, 5)} | ${f(d.gMax, 3)}${f(d.dV60)}${f(d.vs30)}${f(d.lateRange, 2)}`,
      )
    }
  }
  console.log(out.join('\n'))
})
