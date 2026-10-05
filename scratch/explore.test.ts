// Scratch exploration (not committed): compares flight-model candidates on the feel scenarios.
import { it } from 'vitest'
import { SIM_DT } from '../src/core/constants'
import { createFixtureWeather, fixtureRoute } from '../src/core/fixtures'
import { BODY_FORWARD, qRotate, v3 } from '../src/core/math'
import type { AircraftSpec, AircraftState, Controls, FlightModel, Vec3, WeatherField } from '../src/core/types'
import { AIRCRAFT, aircraftById } from '../src/flight/aircraft'
import { flightModel as newModel } from '../src/flight/model'
import { NEUTRAL, uniformWeather } from '../src/flight/testkit'
import { flightModel as oldModel } from './model.old'
import { flightModel as varModel } from './model.var'
import { flightModel as trimModel } from './model.trim'

const still = uniformWeather()
const MODELS: Record<string, FlightModel> = { old: oldModel, new: newModel, var: varModel, trim: trimModel }
const pick = (process.env.MODELS ?? 'old,new').split(',')

function run(m: FlightModel, spec: AircraftSpec, s0: AircraftState, pilot: (s: AircraftState) => Controls, w: WeatherField, seconds: number, on?: (s: AircraftState) => void): AircraftState {
  let s = s0
  const n = Math.round(seconds / SIM_DT)
  for (let i = 0; i < n && s.status === 'flying'; i++) {
    s = m.step(spec, s, pilot(s), w, fixtureRoute, SIM_DT)
    on?.(s)
  }
  return s
}
const theta = (s: AircraftState): number => (Math.asin(qRotate(s.orientation, BODY_FORWARD).y) * 180) / Math.PI
const f = (x: number, d = 1): string => x.toFixed(d).padStart(7)
const at = (s: AircraftState, pos: Vec3): AircraftState => ({ ...s, pos })

it('throttle steps', () => {
  const ids = (process.env.AC ?? AIRCRAFT.map((a) => a.id).join(',')).split(',')
  const steps = (process.env.STEPS ?? 'trim-0.14,0.3,0,up1').split(',')
  const marks = [0, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180]
  const out: string[] = []
  for (const id of ids) {
    const spec = aircraftById(id)
    for (const stp of steps) {
      for (const name of pick) {
        const m = MODELS[name]!
        const s0 = m.initialState(spec, fixtureRoute, still)
        const trim = s0.throttle
        const from = stp === 'up1' ? Math.max(0, trim - 0.2) : trim
        const to = stp === 'up1' ? 1 : stp.startsWith('trim') ? trim + Number(stp.slice(4)) : Number(stp)
        // Settle 5 s at `from`, then step.
        const start = { ...s0, throttle: from }
        const rows: string[] = []
        let maxRise = -Infinity
        let maxTheta = -Infinity
        let theta5 = 0
        let gMin = Infinity
        let gMax = -Infinity
        const T = 180
        run(m, spec, start, (s) => NEUTRAL(s.t < 5 ? from : to), still, T, (s) => {
          const k = Math.round(s.t / SIM_DT)
          if (s.t >= 5) {
            maxRise = Math.max(maxRise, s.pos.y - s0.pos.y)
            maxTheta = Math.max(maxTheta, theta(s) - theta5)
            gMin = Math.min(gMin, s.gLoad)
            gMax = Math.max(gMax, s.gLoad)
          } else theta5 = theta(s)
          for (const mk of marks) {
            if (k === Math.round((mk + 5) / SIM_DT)) rows.push(`${f(mk, 0)}s dh${f(s.pos.y - s0.pos.y, 0)} vs${f(s.vel.y)} V${f(s.airspeed)} θ${f(theta(s), 2)} g${f(s.gLoad, 3)}`)
          }
        })
        out.push(`${id} ${name} ${stp} (${from.toFixed(2)}→${to.toFixed(2)}, trim ${trim.toFixed(2)}): maxRise ${maxRise.toFixed(1)} m, max θ rise ${maxTheta.toFixed(2)}°, g ${gMin.toFixed(3)}..${gMax.toFixed(3)}`)
        out.push(...rows.map((r) => '    ' + r))
      }
    }
  }
  console.log(out.join('\n'))
})

it('updraft tests', () => {
  const exp = aircraftById('experimental')
  const tp = aircraftById('turboprop')
  const out: string[] = []
  for (const name of pick) {
    const m = MODELS[name]!
    const start = at(m.initialState(exp, fixtureRoute, still), v3(20_000, 3000, 0))
    let vIn = 0
    let nIn = 0
    const through = run(m, exp, start, () => NEUTRAL(0.3), createFixtureWeather(1), 200, (s) => {
      if (Math.abs(s.pos.x - 30_000) < 2500) (vIn += s.airspeed), nIn++
    })
    const around = run(m, exp, start, () => NEUTRAL(0.3), uniformWeather(v3(8, 0, 0), 0.05, 1), 200)
    out.push(`${name} exp neutral 0.3: through-around ${(through.pos.y - around.pos.y).toFixed(0)} m, V in lift ${(vIn / Math.max(nIn, 1)).toFixed(1)}, around dh ${(around.pos.y - 3000).toFixed(0)} V ${around.airspeed.toFixed(1)}`)
    const s0 = m.initialState(tp, fixtureRoute, still)
    const tstart = at(s0, v3(20_000, 3000, 0))
    const sp = (target: number) => (s: AircraftState): Controls => ({ pitch: Math.max(-1, Math.min(1, (s.airspeed - target) * 0.2)), roll: 0, yaw: 0, throttle: 0.3 })
    const tThrough = run(m, tp, tstart, sp(78), createFixtureWeather(1), 200)
    const tAround = run(m, tp, tstart, sp(78), uniformWeather(v3(8, 0, 0), 0.05, 1), 200)
    out.push(`${name} turboprop speedPilot 78: through-around ${(tThrough.pos.y - tAround.pos.y).toFixed(0)} m`)
  }
  console.log(out.join('\n'))
})

it('maneuvers', () => {
  const out: string[] = []
  const ids = (process.env.AC ?? 'turboprop,narrowbody,cargo,experimental').split(',')
  for (const id of ids) {
    const spec = aircraftById(id)
    for (const [label, cmd, dur] of [['pull 1.0 x6s', 1, 6], ['pull 1.0 x12s', 1, 12], ['push 0.6 x8s', -0.6, 8], ['push 1.0 x8s', -1, 8]] as const) {
      for (const name of pick) {
        const m = MODELS[name]!
        const s0 = m.initialState(spec, fixtureRoute, still)
        let vMin = Infinity
        let vMax = -Infinity
        let stalled = 0
        let hMax = -Infinity
        let hMin = Infinity
        const rows: string[] = []
        const last: AircraftState | undefined = run(m, spec, s0, (s) => ({ pitch: s.t < dur ? cmd : 0, roll: 0, yaw: 0, throttle: s0.throttle }), still, 120, (s) => {
          if (s.t > dur) (vMin = Math.min(vMin, s.airspeed)), (vMax = Math.max(vMax, s.airspeed)), (hMax = Math.max(hMax, s.pos.y)), (hMin = Math.min(hMin, s.pos.y))
          if (s.stalled) stalled++
          const k = Math.round(s.t / SIM_DT)
          if ([dur, dur + 10, dur + 30, dur + 60, 120].some((mk) => k === Math.round(mk / SIM_DT))) rows.push(`t${f(s.t, 0)} dh${f(s.pos.y - s0.pos.y, 0)} vs${f(s.vel.y)} V${f(s.airspeed)} θ${f(theta(s), 1)} g${f(s.gLoad, 2)}`)
        })
        out.push(`${id} ${name} ${label}: END ${last?.status} stress ${last?.stress.toFixed(3)} after release V ${vMin.toFixed(0)}..${vMax.toFixed(0)} h ${(hMin - s0.pos.y).toFixed(0)}..${(hMax - s0.pos.y).toFixed(0)} stalledTicks ${stalled} | ${rows.join(' | ')}`)
      }
    }
  }
  console.log(out.join('\n'))
})
