// Render sandbox. URL params:
//   t=<s>          freeze the fixture flight at sim time t (screenshots)
//   weather=fixture | rich (default: rich = fixture + a storm-season feature set, visuals only)
//   class=<AircraftClass>   alt=<m> altitude offset (contrails show above ~6500 m)
//   clean=1        hide the panel
//   level=1        wings level (the fixture banks up to knife-edge; handy to inspect silhouettes)
//   stress=<n>     render n times per frame (GPU headroom: fps × n = frames the GPU could sustain)
import { qFromAxisAngle, v3 } from '../src/core/math'
import { createRng } from '../src/core/rng'
import {
  createFixtureGhost,
  createFixtureWeather,
  fixtureAircraft,
  fixtureFlightState,
  fixtureRoute,
} from '../src/core/fixtures'
import type { AircraftClass, AircraftSpec, AircraftState, Ghost, GhostSample, WeatherField, WeatherFeature } from '../src/core/types'
import { createWorldView } from '../src/render'

const params = new URLSearchParams(location.search)
const frozenT = params.has('t') ? Number(params.get('t')) : null
const altOffset = Number(params.get('alt') ?? 0)
const stress = Math.max(1, Number(params.get('stress') ?? 1))
if (params.get('clean') === '1') document.body.classList.add('clean')

const CLASSES: readonly { cls: AircraftClass; lengthM: number; cruise: number; livery: string }[] = [
  { cls: 'turboprop', lengthM: 27, cruise: 140, livery: '#c8553d' },
  { cls: 'regional', lengthM: 32, cruise: 210, livery: '#2d6a8f' },
  { cls: 'narrowbody', lengthM: 38, cruise: 230, livery: '#1f4e79' },
  { cls: 'widebody', lengthM: 64, cruise: 250, livery: '#8a2c3b' },
  { cls: 'cargo', lengthM: 68, cruise: 230, livery: '#5b6b3a' },
  { cls: 'supersonic', lengthM: 62, cruise: 580, livery: '#23324d' },
  { cls: 'experimental', lengthM: 30, cruise: 260, livery: '#e0a526' },
]

const specFor = (cls: AircraftClass): { spec: AircraftSpec; livery: string } => {
  const c = CLASSES.find((k) => k.cls === cls) ?? CLASSES[0]!
  return { spec: { ...fixtureAircraft, id: `sandbox-${cls}`, class: cls, lengthM: c.lengthM, cruiseSpeedMs: c.cruise }, livery: c.livery }
}

/** Fixture wind field + a denser, storm-season feature list so the clouds can be judged at game density. */
function richWeather(): WeatherField {
  const base = createFixtureWeather(1)
  const rng = createRng(184)
  const r = (lo: number, hi: number): number => lo + (hi - lo) * rng()
  const extra: WeatherFeature[] = []
  const stormSpots = [[18_000, -14_000], [42_000, 12_000], [70_000, -9_000], [95_000, 16_000], [120_000, -20_000], [60_000, 26_000], [140_000, 8_000], [30_000, -32_000]]
  stormSpots.forEach(([x, z], i) => extra.push({ kind: 'storm', id: `storm-${i}`, center: v3(x!, 0, z!), radius: r(3500, 6500), base: r(700, 1400), top: r(10_500, 13_500), strength: 25 }))
  for (let i = 0; i < 24; i++) extra.push({ kind: 'updraft', id: `up-x${i}`, center: v3(r(-5_000, 150_000), 0, r(-35_000, 35_000)), radius: r(1200, 2600), base: r(300, 900), top: r(4500, 8500), strength: r(8, 22) })
  for (let i = 0; i < 30; i++) extra.push({ kind: 'thermal', id: `th-${i}`, center: v3(r(-10_000, 150_000), 0, r(-35_000, 35_000)), radius: r(700, 1500), base: 0, top: r(1600, 3200), strength: r(3, 7) })
  extra.push({ kind: 'jetstream', id: 'jet-2', path: [v3(-10_000, 11_500, 20_000), v3(60_000, 11_000, 5_000), v3(150_000, 11_800, -10_000)], radius: 2000, thickness: 1200, speed: 70 })
  extra.push({ kind: 'wake', id: 'wake-1', path: [v3(10_000, 7_200, -25_000), v3(130_000, 7_000, 30_000)], radius: 300, strength: 5 })
  return { ...base, features: [...base.features, ...extra] }
}

function poseAt(ghost: Ghost, t: number): GhostSample {
  const s = ghost.samples
  const i = Math.max(0, Math.min(s.length - 2, Math.floor(t * 10)))
  const a = s[i]!, b = s[i + 1]!
  const k = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)))
  return {
    t,
    pos: v3(a.pos.x + (b.pos.x - a.pos.x) * k, a.pos.y + (b.pos.y - a.pos.y) * k, a.pos.z + (b.pos.z - a.pos.z) * k),
    orientation: k < 0.5 ? a.orientation : b.orientation,
  }
}

const canvas = document.getElementById('view') as HTMLCanvasElement
const view = createWorldView(canvas)
const weather = params.get('weather') === 'fixture' ? createFixtureWeather(1) : richWeather()
view.setWeather(weather)
view.setRoute(fixtureRoute)

const select = document.getElementById('class') as HTMLSelectElement
for (const c of CLASSES) select.add(new Option(c.cls, c.cls))
const applyClass = (cls: AircraftClass): void => {
  const { spec, livery } = specFor(cls)
  view.setAircraft(spec, livery)
}
select.value = (params.get('class') as AircraftClass | null) ?? 'turboprop'
applyClass(select.value as AircraftClass)
select.addEventListener('change', () => applyClass(select.value as AircraftClass))

const ghost = createFixtureGhost(3)
view.setGhosts([{ ghost, spec: fixtureAircraft, color: '#ffc46b', showTrail: true }])

const resize = (): void => view.resize(window.innerWidth, window.innerHeight)
window.addEventListener('resize', resize)
resize()

const level = params.get('level') === '1'
const stateAt = (t: number): AircraftState => {
  const s = fixtureFlightState(t)
  const orientation = level ? qFromAxisAngle(v3(0, 1, 0), Math.atan2(-s.vel.z, s.vel.x)) : s.orientation
  return { ...s, orientation, pos: v3(s.pos.x, s.pos.y + altOffset, s.pos.z) }
}

const fpsEl = document.getElementById('fps')!
const infoEl = document.getElementById('info')!
let simT = frozenT ?? 20
let last = performance.now()
let frames = 0
let fpsWindowStart = last
const stats = { fps: 0, frameMs: 0 }
;(window as unknown as { __render: typeof stats }).__render = stats

const loop = (now: number): void => {
  const dtReal = Math.min((now - last) / 1000, 0.1)
  last = now
  if (frozenT === null) simT += dtReal
  const state = stateAt(simT)
  const ghostPose = poseAt(ghost, simT)
  view.update({ state, ghostPoses: [altOffset ? { ...ghostPose, pos: v3(ghostPose.pos.x, ghostPose.pos.y + altOffset, ghostPose.pos.z) } : ghostPose], dtReal })
  const t0 = performance.now()
  for (let i = 0; i < stress; i++) view.render()
  frames++
  if (now - fpsWindowStart > 1000) {
    stats.fps = (frames * 1000) / (now - fpsWindowStart)
    stats.frameMs = performance.now() - t0
    fpsEl.textContent = `${stats.fps.toFixed(0)} fps`
    infoEl.textContent = `t=${simT.toFixed(0)}s  alt=${state.pos.y.toFixed(0)}m  ${canvas.width}×${canvas.height}`
    frames = 0
    fpsWindowStart = now
  }
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)
