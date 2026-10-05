// Scratch: one lab flight traced side by side under two flight models (not committed).
//   AC=turboprop ST=surfer DAY=284 TIER=0 EVERY=20 pnpm vitest run scratch/trace.test.ts --reporter=dot
import { it } from 'vitest'
import { SIM_DT } from '../src/core/constants'
import type { AircraftState, FlightModel, MutableWeatherSample } from '../src/core/types'
import { aircraftById } from '../src/flight'
import { flightModel as newModel } from '../src/flight/model'
import { createWeather } from '../src/weather'
import { dailyWeatherFor, weatherParamsFor } from '../src/meta'
import { createAutopilot, type Strategy } from '../src/bot'
import { PILOTS } from '../lab/matrix'
import { flightModel as oldModel } from './model.old'
import { flightModel as varModel } from './model.var'

const MODELS: Record<string, FlightModel> = { old: oldModel, new: newModel, var: varModel }

it('trace', () => {
  const daily = dailyWeatherFor(Number(process.env.DAY ?? 272))
  const route = daily.routes[Number(process.env.TIER ?? 0)]!
  const spec = aircraftById(process.env.AC ?? 'turboprop')
  const pdef = PILOTS.find((p) => p.name === (process.env.ST ?? 'surfer'))!
  const every = Math.round(Number(process.env.EVERY ?? 20) / SIM_DT)
  const w: MutableWeatherSample = { wind: { x: 0, y: 0, z: 0 }, turbulence: 0, dominant: null, cloud: 0 }
  const cols: string[][] = []
  for (const name of (process.env.MODELS ?? 'old,new').split(',')) {
    const m = MODELS[name]!
    const weather = createWeather(weatherParamsFor(daily, route))
    const events: string[] = []
    const pilot = createAutopilot(pdef.strategy as Strategy, spec, route, weather, { ...(pdef.opts ?? {}), trace: (t, e) => events.push(`[${t.toFixed(0)}] ${e}`) })
    let s: AircraftState = m.initialState(spec, route, weather)
    const lines: string[] = []
    let n = 0
    while (s.status === 'flying' && s.t < 1500) {
      const c = pilot(s)
      if (n++ % every === 0) {
        weather.sample(s.pos, s.t, w)
        lines.push(`t${s.t.toFixed(0).padStart(4)} x${(s.pos.x / 1000).toFixed(1).padStart(6)} h${s.pos.y.toFixed(0).padStart(6)} vs${s.vel.y.toFixed(1).padStart(6)} V${s.airspeed.toFixed(0).padStart(4)} thr${s.throttle.toFixed(2)} p${c.pitch.toFixed(2).padStart(6)} wy${w.wind.y.toFixed(1).padStart(5)} wx${w.wind.x.toFixed(0).padStart(4)} g${s.gLoad.toFixed(2)}`)
      }
      s = m.step(spec, s, c, weather, route, SIM_DT)
    }
    lines.push(`${name}: ${s.status} t=${s.t.toFixed(0)} fuel=${s.fuelKg.toFixed(0)}`)
    cols.push([...events.slice(0, 12), ...lines])
  }
  const rows = Math.max(...cols.map((c) => c.length))
  const out: string[] = []
  for (let i = 0; i < rows; i++) out.push(cols.map((c) => (c[i] ?? '').padEnd(100)).join(' | '))
  console.log(out.join('\n'))
})
