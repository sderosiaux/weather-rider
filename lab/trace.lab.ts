// Debug trace of one flight, off unless AC is set:
//   AC=regional ST=surfer DAY=272 R=1 EVERY=20 [PROFILE='{"cruise":"jet"}'] [GX=0.2] pnpm lab lab/trace.lab.ts --silent=false
import { it } from 'vitest'
import { aircraftById } from '../src/flight'
import { createTerrain } from '../src/terrain'
import { createWeather } from '../src/weather'
import { dailyWeatherFor, terrainParamsFor, weatherParamsFor } from '../src/meta'
import { createAutopilot, runFlight, type Strategy } from '../src/bot'

it.skipIf(!process.env.AC)('trace', () => {
  const daily = dailyWeatherFor(Number(process.env.DAY ?? 272))
  const route = daily.routes[Number(process.env.R ?? 0)]!
  const spec = aircraftById(process.env.AC ?? 'regional')
  const weather = createWeather(weatherParamsFor(daily, route))
      const terrain = createTerrain(terrainParamsFor(daily, route))
  const st = (process.env.ST ?? 'surfer') as Strategy
  const pilot = createAutopilot(st, spec, route, weather, { profile: JSON.parse(process.env.PROFILE ?? '{}'), trace: (t, e) => console.log(`  [${t.toFixed(0)}] ${e}`) })
  let n = 0
  const every = Number(process.env.EVERY ?? 20) * 60
  const w = { wind: { x: 0, y: 0, z: 0 }, turbulence: 0, dominant: null, cloud: 0 }
  const r = runFlight(spec, { route, weather, terrain }, (s) => {
    const c = pilot(s)
    if (n++ % every === 0 || (process.env.GX && Math.abs(s.gLoad - 1) > Number(process.env.GX) && n % 30 === 0)) {
      weather.sample(s.pos, s.t, w)
      console.log(`t=${s.t.toFixed(0)} x=${(s.pos.x/1000).toFixed(1)} z=${(s.pos.z/1000).toFixed(1)} h=${s.pos.y.toFixed(0)} vs=${s.vel.y.toFixed(1)} V=${s.airspeed.toFixed(0)} gs=${Math.hypot(s.vel.x,s.vel.z).toFixed(0)} thr=${s.throttle.toFixed(2)} p=${c.pitch.toFixed(2)} r=${c.roll.toFixed(2)} w=(${w.wind.x.toFixed(0)},${w.wind.y.toFixed(1)},${w.wind.z.toFixed(0)}) turb=${w.turbulence.toFixed(2)} ${w.dominant ?? ''} g=${s.gLoad.toFixed(2)} fuel=${s.fuelKg.toFixed(0)}`)
    }
    return c
  })
  console.log(route.id, `gate x=${route.gate.x} z=${route.gate.z} [${route.gateMinAlt},${route.gateMaxAlt}]`, r.outcome, JSON.stringify(r.score))
  for (const f of weather.features) if (f.kind === 'jetstream') console.log(f.id, f.speed.toFixed(0), f.radius.toFixed(0), f.thickness.toFixed(0), f.path.filter((_, i) => i % 5 === 0).map((p) => `${(p.x/1000).toFixed(0)}:${p.y.toFixed(0)}/${(p.z/1000).toFixed(1)}`).join(' '))
})
