// Flight lab: fly any aircraft by keyboard through the fixture weather, watch the physics.
import { SIM_DT } from '../src/core/constants'
import { createFixtureWeather, fixtureRoute } from '../src/core/fixtures'
import { v3 } from '../src/core/math'
import type { AircraftSpec, AircraftState, Controls, MutableWeatherSample, Route } from '../src/core/types'
import { AIRCRAFT, aircraftById, bankAngle, flightModel, headingOf } from '../src/flight'

const weather = createFixtureWeather(1)
const route: Route = fixtureRoute
const X0 = -10_000
const X1 = 110_000
const Y1 = 14_000
const Z0 = -30_000
const Z1 = 30_000

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const aircraftSel = $<HTMLSelectElement>('aircraft')
const scenarioSel = $<HTMLSelectElement>('scenario')
const speedSel = $<HTMLSelectElement>('speed')
const statusEl = $<HTMLDivElement>('status')
const readout = $<HTMLTableElement>('readout')
const side = $<HTMLCanvasElement>('side')
const top = $<HTMLCanvasElement>('top')
const plots = $<HTMLCanvasElement>('plots')

const css = getComputedStyle(document.documentElement)
const color = (name: string): string => css.getPropertyValue(`--${name}`).trim()
const hexRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

for (const a of AIRCRAFT) aircraftSel.add(new Option(`${a.name} (${a.class})`, a.id))

// ── Input ──
const keys = new Set<string>()
addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') reset()
  else if (e.key === 'p' || e.key === 'P') togglePause()
  keys.add(e.code)
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault()
})
addEventListener('keyup', (e) => keys.delete(e.code))
addEventListener('blur', () => keys.clear())
const axis = (neg: string[], pos: string[]): number => (pos.some((k) => keys.has(k)) ? 1 : 0) - (neg.some((k) => keys.has(k)) ? 1 : 0)
const approach = (from: number, to: number, rate: number): number => from + Math.max(-rate, Math.min(rate, to - from))

// ── Sim state ──
let spec: AircraftSpec = aircraftById(aircraftSel.value)
let state: AircraftState
let controls: Controls
let paused = false
let trace: { x: number; y: number; z: number }[] = []
interface Sample { t: number; alt: number; air: number; ground: number; g: number; cabin: number; stress: number }
let history: Sample[] = []
let nextTrace = 0
let nextHistory = 0

function reset(): void {
  spec = aircraftById(aircraftSel.value)
  const starts: Record<string, { x: number; y: number; z: number }> = {
    route: route.start,
    updraft: v3(20_000, 3000, 0),
    jet: v3(40_000, 8500, 0),
    downdraft: v3(45_000, 3000, 4000),
  }
  const pos = starts[scenarioSel.value] ?? route.start
  state = flightModel.initialState(spec, { ...route, start: pos }, weather)
  controls = { pitch: 0, roll: 0, yaw: 0, throttle: state.throttle }
  trace = []
  history = []
  nextTrace = 0
  nextHistory = 0
  bgKey = ''
}

function togglePause(): void {
  paused = !paused
  $<HTMLButtonElement>('pause').textContent = paused ? 'Resume (P)' : 'Pause (P)'
}

aircraftSel.addEventListener('change', () => { reset(); aircraftSel.blur() })
scenarioSel.addEventListener('change', () => { reset(); scenarioSel.blur() })
speedSel.addEventListener('change', () => speedSel.blur())
$('reset').addEventListener('click', reset)
$('pause').addEventListener('click', togglePause)

function readControls(dt: number): Controls {
  const pitch = axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown'])
  const roll = axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight'])
  const yaw = axis(['KeyQ'], ['KeyE'])
  const thr = axis(['ControlLeft', 'ControlRight'], ['ShiftLeft', 'ShiftRight'])
  return {
    pitch: approach(controls.pitch, pitch, 4 * dt),
    roll: approach(controls.roll, roll, 4 * dt),
    yaw: approach(controls.yaw, yaw, 4 * dt),
    throttle: Math.max(0, Math.min(1, controls.throttle + thr * 0.4 * dt)),
  }
}

// ── Canvas helpers ──
function fit(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const r = c.getBoundingClientRect()
  const dpr = devicePixelRatio || 1
  const w = Math.max(1, Math.round(r.width * dpr))
  const h = Math.max(1, Math.round(r.height * dpr))
  if (c.width !== w || c.height !== h) {
    c.width = w
    c.height = h
    bgKey = ''
  }
  const ctx = c.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return ctx
}

// Weather backgrounds, re-sampled when the aircraft moves to another slice.
const sampleOut: MutableWeatherSample = { wind: { x: 0, y: 0, z: 0 }, turbulence: 0, dominant: null, cloud: 0 }
let bgKey = ''
const sideBg = document.createElement('canvas')
const topBg = document.createElement('canvas')

function paintField(target: HTMLCanvasElement, cols: number, rows: number, at: (i: number, j: number) => { x: number; y: number; z: number }, vertical: boolean): void {
  target.width = cols
  target.height = rows
  const ctx = target.getContext('2d')!
  const img = ctx.createImageData(cols, rows)
  const lift = hexRgb(color('lift'))
  const sink = hexRgb(color('sink'))
  const jet = hexRgb(color('jet'))
  const sky = hexRgb(color('sky'))
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const s = weather.sample(at(i, j), state.t, sampleOut)
      const horiz = Math.hypot(s.wind.x, s.wind.z)
      let rgb = sky
      let a = 0
      if (vertical && Math.abs(s.wind.y) > 0.5) {
        rgb = s.wind.y > 0 ? lift : sink
        a = Math.min(1, Math.abs(s.wind.y) / 18)
      }
      if (horiz > 12) {
        const ja = Math.min(1, (horiz - 12) / 50)
        if (ja > a) { rgb = jet; a = ja }
      }
      if (!vertical && Math.abs(s.wind.y) > 0.5) {
        const va = Math.min(1, Math.abs(s.wind.y) / 18)
        if (va > a) { rgb = s.wind.y > 0 ? lift : sink; a = va }
      }
      const k = (j * cols + i) * 4
      img.data[k] = rgb[0]
      img.data[k + 1] = rgb[1]
      img.data[k + 2] = rgb[2]
      img.data[k + 3] = Math.round(40 + a * 150)
    }
  }
  ctx.putImageData(img, 0, 0)
}

function refreshBackgrounds(): void {
  const key = `${Math.round(state.pos.z / 500)}:${Math.round(state.pos.y / 250)}:${Math.floor(state.t / 2)}`
  if (key === bgKey) return
  bgKey = key
  const cols = 180
  paintField(sideBg, cols, 60, (i, j) => v3(X0 + ((i + 0.5) / cols) * (X1 - X0), Y1 * (1 - (j + 0.5) / 60), state.pos.z), true)
  paintField(topBg, cols, 90, (i, j) => v3(X0 + ((i + 0.5) / cols) * (X1 - X0), state.pos.y, Z0 + ((j + 0.5) / 90) * (Z1 - Z0)), false)
}

function drawSide(): void {
  const ctx = fit(side)
  const w = side.clientWidth
  const h = side.clientHeight
  const px = (x: number) => ((x - X0) / (X1 - X0)) * w
  const py = (y: number) => h - (y / Y1) * h
  ctx.clearRect(0, 0, w, h)
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(sideBg, 0, 0, w, h)
  grid(ctx, w, h, px, py, 2000)
  // Gate window
  ctx.fillStyle = color('gate') + '33'
  ctx.strokeStyle = color('gate')
  const gx0 = px(route.gate.x - route.gateRadius)
  const gx1 = px(route.gate.x + route.gateRadius)
  ctx.fillRect(gx0, py(route.gateMaxAlt), gx1 - gx0, py(route.gateMinAlt) - py(route.gateMaxAlt))
  ctx.strokeRect(gx0, py(route.gateMaxAlt), gx1 - gx0, py(route.gateMinAlt) - py(route.gateMaxAlt))
  // Trace
  line(ctx, trace.map((p) => [px(p.x), py(p.y)]), color('trace'), 1.5)
  // Aircraft: nose direction from ground velocity, exaggerated 5× vertically for readability
  marker(ctx, px(state.pos.x), py(state.pos.y), Math.atan2(-state.vel.y * 5, state.vel.x))
}

function drawTop(): void {
  const ctx = fit(top)
  const w = top.clientWidth
  const h = top.clientHeight
  const px = (x: number) => ((x - X0) / (X1 - X0)) * w
  const pz = (z: number) => ((z - Z0) / (Z1 - Z0)) * h
  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(topBg, 0, 0, w, h)
  grid(ctx, w, h, px, (z) => pz(z), 10_000, Z0, Z1)
  ctx.strokeStyle = color('gate')
  ctx.fillStyle = color('gate') + '33'
  ctx.beginPath()
  ctx.ellipse(px(route.gate.x), pz(route.gate.z), (route.gateRadius / (X1 - X0)) * w, (route.gateRadius / (Z1 - Z0)) * h, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
  line(ctx, trace.map((p) => [px(p.x), pz(p.z)]), color('trace'), 1.5)
  marker(ctx, px(state.pos.x), pz(state.pos.z), Math.atan2(state.vel.z * ((h / (Z1 - Z0)) / (w / (X1 - X0))), state.vel.x))
}

function grid(ctx: CanvasRenderingContext2D, w: number, h: number, px: (x: number) => number, py: (y: number) => number, yStep: number, y0 = 0, y1 = Y1): void {
  ctx.strokeStyle = color('grid')
  ctx.fillStyle = color('muted')
  ctx.lineWidth = 1
  ctx.font = `10px ${color('mono')}`
  for (let x = 0; x <= X1; x += 10_000) {
    ctx.beginPath()
    ctx.moveTo(px(x), 0)
    ctx.lineTo(px(x), h)
    ctx.stroke()
    ctx.fillText(`${x / 1000} km`, px(x) + 3, h - 4)
  }
  for (let y = Math.ceil(y0 / yStep) * yStep; y <= y1; y += yStep) {
    ctx.beginPath()
    ctx.moveTo(0, py(y))
    ctx.lineTo(w, py(y))
    ctx.stroke()
    ctx.fillText(`${y}`, 3, py(y) - 3)
  }
}

function line(ctx: CanvasRenderingContext2D, pts: [number, number][], stroke: string, width: number): void {
  if (pts.length < 2) return
  ctx.strokeStyle = stroke
  ctx.lineWidth = width
  ctx.beginPath()
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
  ctx.stroke()
}

function marker(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number): void {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)
  ctx.fillStyle = state.status === 'flying' ? color('aircraft') : color('danger')
  ctx.beginPath()
  ctx.moveTo(10, 0)
  ctx.lineTo(-7, -6)
  ctx.lineTo(-4, 0)
  ctx.lineTo(-7, 6)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

const PLOTS: { key: keyof Omit<Sample, 't'>; label: string; unit: string; min: number; max: number; also?: keyof Omit<Sample, 't'> }[] = [
  { key: 'alt', label: 'altitude', unit: 'm', min: 0, max: 0 },
  { key: 'air', label: 'airspeed / ground', unit: 'm/s', min: 0, max: 0, also: 'ground' },
  { key: 'g', label: 'g load', unit: 'g', min: -1, max: 3 },
  { key: 'cabin', label: 'cabin accel', unit: 'm/s²', min: -8, max: 8 },
  { key: 'stress', label: 'stress', unit: '', min: 0, max: 1 },
]

function drawPlots(): void {
  const ctx = fit(plots)
  const w = plots.clientWidth
  const h = plots.clientHeight
  ctx.clearRect(0, 0, w, h)
  const rowH = h / PLOTS.length
  const tNow = state.t
  const px = (t: number) => w - ((tNow - t) / 60) * (w - 120) - 8
  ctx.font = `11px ${color('font')}`
  PLOTS.forEach((p, r) => {
    const y0 = r * rowH
    let lo = p.min
    let hi = p.max
    if (lo === hi) {
      lo = Infinity
      hi = -Infinity
      for (const s of history) {
        lo = Math.min(lo, s[p.key], p.also ? s[p.also] : Infinity)
        hi = Math.max(hi, s[p.key], p.also ? s[p.also] : -Infinity)
      }
      const pad = Math.max(10, (hi - lo) * 0.15)
      lo -= pad
      hi += pad
    }
    const py = (v: number) => y0 + rowH - 4 - ((v - lo) / (hi - lo)) * (rowH - 8)
    ctx.strokeStyle = color('grid')
    ctx.beginPath()
    ctx.moveTo(0, y0 + rowH)
    ctx.lineTo(w, y0 + rowH)
    ctx.stroke()
    if (p.key === 'g' || p.key === 'cabin') {
      ctx.setLineDash([3, 3])
      const ref = p.key === 'g' ? 1 : 0
      ctx.beginPath()
      ctx.moveTo(112, py(ref))
      ctx.lineTo(w, py(ref))
      ctx.stroke()
      if (p.key === 'g') {
        ctx.strokeStyle = color('danger')
        for (const lim of [spec.limitGPos, spec.limitGNeg]) {
          if (lim < lo || lim > hi) continue
          ctx.beginPath()
          ctx.moveTo(112, py(lim))
          ctx.lineTo(w, py(lim))
          ctx.stroke()
        }
      }
      ctx.setLineDash([])
    }
    if (p.also) line(ctx, history.map((s) => [px(s.t), py(s[p.also!])]), color('muted'), 1)
    line(ctx, history.map((s) => [px(s.t), py(s[p.key])]), p.key === 'stress' ? color('danger') : color('trace'), 1.5)
    const last = history[history.length - 1]
    ctx.fillStyle = color('muted')
    ctx.fillText(p.label, 8, y0 + 16)
    ctx.fillStyle = color('text')
    if (last) ctx.fillText(`${last[p.key].toFixed(p.key === 'stress' || p.key === 'g' ? 2 : 1)} ${p.unit}`, 8, y0 + 32)
  })
}

function drawReadout(): void {
  const s = state
  const w = weather.sample(s.pos, s.t, sampleOut)
  const ground = Math.hypot(s.vel.x, s.vel.z)
  const rows: [string, string][] = [
    ['t', `${s.t.toFixed(1)} s`],
    ['pos x / z', `${(s.pos.x / 1000).toFixed(1)} / ${(s.pos.z / 1000).toFixed(1)} km`],
    ['altitude', `${s.pos.y.toFixed(0)} m`],
    ['vertical speed', `${s.vel.y.toFixed(1)} m/s`],
    ['airspeed', `${s.airspeed.toFixed(1)} m/s`],
    ['ground speed', `${ground.toFixed(1)} m/s (${(ground * 3.6).toFixed(0)} km/h)`],
    ['heading / bank', `${((headingOf(s.orientation) * 180) / Math.PI).toFixed(0)}° / ${((bankAngle(s.orientation) * 180) / Math.PI).toFixed(0)}°`],
    ['throttle cmd / eng', `${(controls.throttle * 100).toFixed(0)} / ${(s.throttle * 100).toFixed(0)} %`],
    ['fuel', `${s.fuelKg.toFixed(0)} kg (${((s.fuelKg / spec.fuelCapacityKg) * 100).toFixed(0)} %)`],
    ['g / cabin', `${s.gLoad.toFixed(2)} / ${s.cabinAccel.toFixed(2)}`],
    ['stress', `${(s.stress * 100).toFixed(1)} %`],
    ['wind', `${w.wind.x.toFixed(0)}, ${w.wind.y.toFixed(1)}, ${w.wind.z.toFixed(0)}`],
    ['turbulence', `${w.turbulence.toFixed(2)} ${w.dominant ?? ''}`],
  ]
  readout.innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')
  const label = s.status === 'flying' ? (s.stalled ? 'STALL' : paused ? 'paused' : 'flying') : s.status
  statusEl.textContent = label
  statusEl.className = `status ${s.status} ${s.stalled && s.status === 'flying' ? 'stall' : ''}`
}

// ── Loop ──
let acc = 0
let last = performance.now()

function frame(now: number): void {
  const real = Math.min(0.1, (now - last) / 1000)
  last = now
  if (!paused && state.status === 'flying') {
    acc += real * Number(speedSel.value)
    let steps = 0
    while (acc >= SIM_DT && steps < 64) {
      controls = readControls(SIM_DT)
      state = flightModel.step(spec, state, controls, weather, route, SIM_DT)
      acc -= SIM_DT
      steps++
      if (state.t >= nextTrace) {
        trace.push(state.pos)
        nextTrace = state.t + 0.5
      }
      if (state.t >= nextHistory) {
        history.push({ t: state.t, alt: state.pos.y, air: state.airspeed, ground: Math.hypot(state.vel.x, state.vel.z), g: state.gLoad, cabin: state.cabinAccel, stress: state.stress })
        nextHistory = state.t + 0.1
      }
    }
    while (history.length > 0 && history[0]!.t < state.t - 60) history.shift()
  }
  refreshBackgrounds()
  drawSide()
  drawTop()
  drawPlots()
  drawReadout()
  requestAnimationFrame(frame)
}

reset()
requestAnimationFrame(frame)
