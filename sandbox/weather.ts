// Debug viewer for src/weather: plan slice at an altitude + vertical section along the corridor.
import { v3 } from '../src/core/math'
import type { MutableWeatherSample, Vec3, WeatherField, WeatherFeature, WeatherParams } from '../src/core/types'
import { createWeather } from '../src/weather'

const BOUNDS_MIN = v3(-10_000, 0, -30_000)
const BOUNDS_MAX = v3(110_000, 14_000, 30_000)
const START = v3(0, 3000, 0)
const GATE_X = 100_000
/** Section spans a bit beyond the corridor ends. */
const SECTION_S0 = -0.08
const SECTION_S1 = 1.08
const HEAT_STEP = 4
const PARTICLES = 2600
/** Simulated seconds per animation frame. */
const SIM_DT = 6

type Layer = 'vertical' | 'turbulence' | 'speed' | 'tailwind' | 'cloud'
type Rgb = readonly [number, number, number]
type Ramp = readonly (readonly [number, Rgb])[]

// Data colormaps (light, white = neutral).
const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
const RAMPS: Record<Layer, { ramp: Ramp; name: string }> = {
  vertical: { name: 'vertical wind m/s (blue sink · red lift)', ramp: [[-20, hex('#1e3a8a')], [-8, hex('#60a5fa')], [-1.5, hex('#eef4ff')], [0, hex('#fbfbfc')], [1.5, hex('#fff1ec')], [8, hex('#f87171')], [20, hex('#b91c1c')], [30, hex('#4c0519')]] },
  turbulence: { name: 'turbulence 0..1 (≥0.7 severe)', ramp: [[0, hex('#fbfbfc')], [0.15, hex('#f1f5f9')], [0.3, hex('#fde68a')], [0.5, hex('#f59e0b')], [0.7, hex('#dc2626')], [1, hex('#581c87')]] },
  speed: { name: 'horizontal wind m/s', ramp: [[0, hex('#fbfbfc')], [15, hex('#e0f2fe')], [30, hex('#7dd3fc')], [55, hex('#0284c7')], [85, hex('#1e3a8a')], [120, hex('#0f172a')]] },
  tailwind: { name: 'wind +x m/s (≥35 = jet tailwind)', ramp: [[-10, hex('#fb923c')], [0, hex('#fbfbfc')], [20, hex('#d1fae5')], [35, hex('#34d399')], [60, hex('#047857')], [110, hex('#022c22')]] },
  cloud: { name: 'cloud density 0..1', ramp: [[0, hex('#fbfbfc')], [0.3, hex('#cbd5e1')], [1, hex('#334155')]] },
}

const rampColor = (ramp: Ramp, v: number, out: number[]): void => {
  const first = ramp[0]!
  const last = ramp[ramp.length - 1]!
  if (v <= first[0]) return void out.splice(0, 3, ...first[1])
  if (v >= last[0]) return void out.splice(0, 3, ...last[1])
  for (let i = 1; i < ramp.length; i++) {
    const [b, cb] = ramp[i]!
    if (v <= b) {
      const [a, ca] = ramp[i - 1]!
      const t = (v - a) / (b - a)
      out[0] = ca[0] + (cb[0] - ca[0]) * t
      out[1] = ca[1] + (cb[1] - ca[1]) * t
      out[2] = ca[2] + (cb[2] - ca[2]) * t
      return
    }
  }
}

const layerValue = (layer: Layer, s: MutableWeatherSample): number => {
  switch (layer) {
    case 'vertical':
      return s.wind.y
    case 'turbulence':
      return s.turbulence
    case 'speed':
      return Math.hypot(s.wind.x, s.wind.z)
    case 'tailwind':
      return s.wind.x
    case 'cloud':
      return s.cloud
  }
}

const FEATURE_COLORS: Record<WeatherFeature['kind'], string> = {
  storm: '#7c2d12',
  updraft: '#b91c1c',
  downdraft: '#1d4ed8',
  thermal: '#c2410c',
  jetstream: '#047857',
  shear: '#a16207',
  wake: '#6d28d9',
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const ui = {
  seed: $<HTMLInputElement>('seed'),
  severity: $<HTMLInputElement>('severity'),
  gate: $<HTMLInputElement>('gate'),
  alt: $<HTMLInputElement>('alt'),
  time: $<HTMLInputElement>('time'),
  layer: $<HTMLSelectElement>('layer'),
  arrows: $<HTMLInputElement>('arrows'),
  particles: $<HTMLInputElement>('particles'),
  clouds: $<HTMLInputElement>('clouds'),
  labels: $<HTMLInputElement>('labels'),
  play: $<HTMLButtonElement>('play'),
  reroll: $<HTMLButtonElement>('reroll'),
  stats: $<HTMLDivElement>('stats'),
  readout: $<HTMLDivElement>('readout'),
  plan: $<HTMLCanvasElement>('plan'),
  planFx: $<HTMLCanvasElement>('planFx'),
  section: $<HTMLCanvasElement>('section'),
  sectionFx: $<HTMLCanvasElement>('sectionFx'),
  legend: $<HTMLCanvasElement>('legend'),
}

let weather: WeatherField
let params: WeatherParams
let playing = false
const out: MutableWeatherSample = { wind: { x: 0, y: 0, z: 0 }, turbulence: 0, dominant: null, cloud: 0 }
const rgb = [0, 0, 0]

const num = (el: HTMLInputElement) => Number(el.value)
const gate = (): Vec3 => v3(GATE_X, 3000, num(ui.gate))

// ── Geometry.
let W = 1000
let planH = 500
const SECTION_H = 280
const planToPx = (x: number, z: number): [number, number] => [
  ((x - BOUNDS_MIN.x) / (BOUNDS_MAX.x - BOUNDS_MIN.x)) * W,
  ((z - BOUNDS_MIN.z) / (BOUNDS_MAX.z - BOUNDS_MIN.z)) * planH,
]
const pxToPlan = (px: number, py: number): [number, number] => [
  BOUNDS_MIN.x + (px / W) * (BOUNDS_MAX.x - BOUNDS_MIN.x),
  BOUNDS_MIN.z + (py / planH) * (BOUNDS_MAX.z - BOUNDS_MIN.z),
]
const sectionPoint = (px: number, py: number): Vec3 => {
  const s = SECTION_S0 + (px / W) * (SECTION_S1 - SECTION_S0)
  const g = gate()
  return v3(START.x + (g.x - START.x) * s, BOUNDS_MAX.y * (1 - py / SECTION_H), START.z + (g.z - START.z) * s)
}
const sectionX = (s: number) => ((s - SECTION_S0) / (SECTION_S1 - SECTION_S0)) * W
const sectionY = (y: number) => (1 - y / BOUNDS_MAX.y) * SECTION_H

function sizeCanvases() {
  W = Math.max(600, Math.floor(($('planStack').parentElement as HTMLElement).clientWidth - 24))
  planH = Math.round((W * (BOUNDS_MAX.z - BOUNDS_MIN.z)) / (BOUNDS_MAX.x - BOUNDS_MIN.x))
  for (const [c, h] of [[ui.plan, planH], [ui.planFx, planH], [ui.section, SECTION_H], [ui.sectionFx, SECTION_H]] as const) {
    c.width = W
    c.height = h
  }
}

function rebuild() {
  params = {
    seed: Math.floor(num(ui.seed)),
    severity: num(ui.severity),
    boundsMin: BOUNDS_MIN,
    boundsMax: BOUNDS_MAX,
    corridor: [START, gate()],
  }
  const t0 = performance.now()
  weather = createWeather(params)
  const buildMs = performance.now() - t0
  resetParticles()
  updateStats(buildMs)
  redraw()
}

// ── Heatmaps.
function heatmap(ctx: CanvasRenderingContext2D, w: number, h: number, at: (px: number, py: number) => Vec3, t: number) {
  const layer = ui.layer.value as Layer
  const { ramp } = RAMPS[layer]
  const img = ctx.createImageData(w, h)
  const showClouds = ui.clouds.checked && layer !== 'cloud'
  for (let py = 0; py < h; py += HEAT_STEP) {
    for (let px = 0; px < w; px += HEAT_STEP) {
      const s = weather.sample(at(px + HEAT_STEP / 2, py + HEAT_STEP / 2), t, out)
      rampColor(ramp, layerValue(layer, s), rgb)
      if (showClouds && s.cloud > 0) {
        // Clouds as a cool grey veil over the data layer.
        const a = Math.min(0.45, s.cloud * 0.5)
        rgb[0] = rgb[0]! * (1 - a) + 100 * a
        rgb[1] = rgb[1]! * (1 - a) + 116 * a
        rgb[2] = rgb[2]! * (1 - a) + 139 * a
      }
      for (let yy = py; yy < Math.min(h, py + HEAT_STEP); yy++) {
        for (let xx = px; xx < Math.min(w, px + HEAT_STEP); xx++) {
          const i = (yy * w + xx) * 4
          img.data[i] = rgb[0]!
          img.data[i + 1] = rgb[1]!
          img.data[i + 2] = rgb[2]!
          img.data[i + 3] = 255
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0)
}

function arrow(ctx: CanvasRenderingContext2D, x: number, y: number, dx: number, dy: number) {
  const len = Math.hypot(dx, dy)
  if (len < 0.5) return
  const ux = dx / len
  const uy = dy / len
  ctx.moveTo(x, y)
  ctx.lineTo(x + dx, y + dy)
  const hs = Math.min(5, len * 0.4)
  ctx.moveTo(x + dx, y + dy)
  ctx.lineTo(x + dx - ux * hs - uy * hs * 0.6, y + dy - uy * hs + ux * hs * 0.6)
  ctx.moveTo(x + dx, y + dy)
  ctx.lineTo(x + dx - ux * hs + uy * hs * 0.6, y + dy - uy * hs - ux * hs * 0.6)
}

function drawPlan(t: number) {
  const ctx = ui.plan.getContext('2d')!
  const alt = num(ui.alt)
  heatmap(ctx, W, planH, (px, py) => {
    const [x, z] = pxToPlan(px, py)
    return v3(x, alt, z)
  }, t)

  if (ui.arrows.checked) {
    ctx.beginPath()
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.55)'
    ctx.lineWidth = 1
    const step = 36
    for (let py = step / 2; py < planH; py += step) {
      for (let px = step / 2; px < W; px += step) {
        const [x, z] = pxToPlan(px, py)
        const s = weather.sample(v3(x, alt, z), t, out)
        arrow(ctx, px, py, s.wind.x * 0.3, s.wind.z * 0.3)
      }
    }
    ctx.stroke()
  }

  // Corridor.
  const [sx, sy] = planToPx(START.x, START.z)
  const g = gate()
  const [gx, gy] = planToPx(g.x, g.z)
  ctx.save()
  ctx.setLineDash([8, 6])
  ctx.strokeStyle = '#111827'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(sx, sy)
  ctx.lineTo(gx, gy)
  ctx.stroke()
  ctx.restore()
  ctx.fillStyle = '#111827'
  ctx.font = '600 11px ui-sans-serif, sans-serif'
  ctx.fillText('START', sx + 4, sy - 6)
  ctx.fillText('GATE', gx - 30, gy - 6)

  if (ui.labels.checked) drawFeatures(ctx, alt)
}

function drawFeatures(ctx: CanvasRenderingContext2D, alt: number) {
  ctx.save()
  ctx.font = '11px ui-sans-serif, sans-serif'
  for (const f of weather.features) {
    const color = FEATURE_COLORS[f.kind]
    if (f.kind === 'jetstream') {
      const line = new Path2D()
      f.path.forEach((p, i) => {
        const [px, py] = planToPx(p.x, p.z)
        if (i === 0) line.moveTo(px, py)
        else line.lineTo(px, py)
      })
      // End bars: the path stops where the core falls below half its speed.
      const bars = new Path2D()
      for (const [a, b] of [[f.path[1]!, f.path[0]!], [f.path.at(-2)!, f.path.at(-1)!]] as const) {
        const [ax, ay] = planToPx(a.x, a.z)
        const [bx, by] = planToPx(b.x, b.z)
        const k = 8 / (Math.hypot(bx - ax, by - ay) || 1)
        bars.moveTo(bx + (by - ay) * k, by - (bx - ax) * k)
        bars.lineTo(bx - (by - ay) * k, by + (bx - ax) * k)
      }
      // White halo underneath: the path stays readable over the dark core of the jet it describes.
      ctx.setLineDash([])
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'
      ctx.lineWidth = 4
      ctx.stroke(line)
      ctx.lineWidth = 6
      ctx.stroke(bars)
      ctx.strokeStyle = color
      ctx.lineWidth = 2.5
      ctx.stroke(bars)
      ctx.lineWidth = 1.5
      ctx.setLineDash([2, 4])
      ctx.stroke(line)
      const mid = f.path[Math.floor(f.path.length * 0.2)]!
      const [px, py] = planToPx(mid.x, mid.z)
      label(ctx, `${f.id} ${f.speed.toFixed(0)} m/s @${(mid.y / 1000).toFixed(1)} km`, px, py - 8, color)
    } else if (f.kind === 'wake') {
      const [a, b] = f.path as [Vec3, Vec3]
      const [ax, ay] = planToPx(a.x, a.z)
      const [bx, by] = planToPx(b.x, b.z)
      ctx.strokeStyle = color
      ctx.globalAlpha = 0.6
      ctx.lineWidth = 1
      ctx.setLineDash([1, 3])
      ctx.beginPath()
      ctx.moveTo(ax, ay)
      ctx.lineTo(bx, by)
      ctx.stroke()
      ctx.globalAlpha = 1
      label(ctx, `${f.id} ${(a.y / 1000).toFixed(1)} km`, (ax + bx) / 2, (ay + by) / 2 - 6, color)
    } else if (f.kind === 'storm' || f.kind === 'updraft' || f.kind === 'downdraft' || f.kind === 'thermal') {
      const [px, py] = planToPx(f.center.x, f.center.z)
      const r = (f.radius / (BOUNDS_MAX.x - BOUNDS_MIN.x)) * W
      const inside = alt >= f.base && alt <= f.top
      if (f.kind === 'thermal') {
        if (!inside) continue
        ctx.fillStyle = color
        ctx.globalAlpha = 0.5
        ctx.beginPath()
        ctx.arc(px, py, 1.5, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = 1
        continue
      }
      ctx.globalAlpha = inside ? 1 : 0.35
      ctx.strokeStyle = color
      ctx.lineWidth = f.kind === 'storm' ? 1.5 : 1
      ctx.setLineDash(f.kind === 'storm' ? [] : [4, 3])
      ctx.beginPath()
      ctx.arc(px, py, r, 0, Math.PI * 2)
      ctx.stroke()
      label(ctx, `${f.id} ${f.strength > 0 ? '+' : ''}${f.strength.toFixed(0)} · ${(f.base / 1000).toFixed(1)}–${(f.top / 1000).toFixed(1)} km`, px + r + 3, py, color)
      ctx.globalAlpha = 1
    }
  }
  ctx.restore()
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string) {
  const w = ctx.measureText(text).width
  ctx.fillStyle = 'rgba(255,255,255,0.8)'
  ctx.fillRect(x - 2, y - 10, w + 4, 13)
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
}

function drawSection(t: number) {
  const ctx = ui.section.getContext('2d')!
  heatmap(ctx, W, SECTION_H, sectionPoint, t)
  const g = gate()
  const corridorLen = Math.hypot(g.x - START.x, g.z - START.z)

  if (ui.arrows.checked) {
    ctx.beginPath()
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.55)'
    ctx.lineWidth = 1
    const ux = (g.x - START.x) / corridorLen
    const uz = (g.z - START.z) / corridorLen
    for (let py = 14; py < SECTION_H; py += 28) {
      for (let px = 18; px < W; px += 36) {
        const s = weather.sample(sectionPoint(px, py), t, out)
        arrow(ctx, px, py, (s.wind.x * ux + s.wind.z * uz) * 0.3, -s.wind.y * 0.6)
      }
    }
    ctx.stroke()
  }

  // Altitude grid + plan altitude.
  ctx.save()
  ctx.font = '10.5px ui-sans-serif, sans-serif'
  ctx.fillStyle = '#475569'
  ctx.strokeStyle = 'rgba(71, 85, 105, 0.2)'
  for (let y = 2000; y < BOUNDS_MAX.y; y += 2000) {
    const py = sectionY(y)
    ctx.beginPath()
    ctx.moveTo(0, py)
    ctx.lineTo(W, py)
    ctx.stroke()
    ctx.fillText(`${y / 1000} km`, 4, py - 3)
  }
  ctx.setLineDash([6, 4])
  ctx.strokeStyle = '#111827'
  const pa = sectionY(num(ui.alt))
  ctx.beginPath()
  ctx.moveTo(0, pa)
  ctx.lineTo(W, pa)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.fillStyle = '#111827'
  for (const [s, name] of [[0, 'START'], [1, 'GATE']] as const) {
    const px = sectionX(s)
    ctx.fillRect(px - 1, sectionY(3000) - 6, 2, 12)
    ctx.fillText(name, px + 4, sectionY(3000) - 8)
  }

  // Labels for columns near the section line.
  if (ui.labels.checked) {
    for (const f of weather.features) {
      if (f.kind !== 'storm' && f.kind !== 'updraft' && f.kind !== 'downdraft') continue
      const rx = f.center.x - START.x
      const rz = f.center.z - START.z
      const along = (rx * (g.x - START.x) + rz * (g.z - START.z)) / (corridorLen * corridorLen)
      const lateral = Math.abs(rx * (g.z - START.z) - rz * (g.x - START.x)) / corridorLen
      if (lateral > f.radius * 1.5) continue
      label(ctx, `${f.id} (${(lateral / 1000).toFixed(1)} km off)`, sectionX(along) - 30, sectionY(f.top) - 4, FEATURE_COLORS[f.kind])
    }
  }
  ctx.restore()
}

function drawLegend() {
  const layer = ui.layer.value as Layer
  const { ramp, name } = RAMPS[layer]
  const ctx = ui.legend.getContext('2d')!
  const lo = ramp[0]![0]
  const hi = ramp[ramp.length - 1]![0]
  for (let i = 0; i < ui.legend.width; i++) {
    rampColor(ramp, lo + ((hi - lo) * i) / (ui.legend.width - 1), rgb)
    ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`
    ctx.fillRect(i, 0, 1, ui.legend.height)
  }
  $('legendMin').textContent = String(lo)
  $('legendMax').textContent = String(hi)
  $('legendName').textContent = name
}

function redraw() {
  const t = num(ui.time)
  $('sevVal').textContent = num(ui.severity).toFixed(2)
  $('gateVal').textContent = `${(num(ui.gate) / 1000).toFixed(0)} km`
  $('altVal').textContent = `${num(ui.alt).toFixed(0)} m · FL${Math.round((num(ui.alt) * 3.281) / 100)}`
  $('timeVal').textContent = `${t.toFixed(0)} s`
  $('planTitle').textContent = `slice at ${(num(ui.alt) / 1000).toFixed(2)} km · t = ${t.toFixed(0)} s`
  drawPlan(t)
  drawSection(t)
  drawLegend()
}

// ── Stats: the gameplay guarantees, measured on this layout.
function updateStats(buildMs: number) {
  const counts = new Map<string, number>()
  for (const f of weather.features) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1)
  const g = gate()
  let bestLift = 0
  let bestTail = 0
  let severe = 0
  let n = 0
  for (let s = 0; s <= 1; s += 0.01) {
    for (let lat = -20_000; lat <= 20_000; lat += 1000) {
      const x = START.x + (g.x - START.x) * s
      const z = START.z + (g.z - START.z) * s + lat
      for (let y = 1000; y <= 8000; y += 500) {
        const w = weather.sample(v3(x, y, z), 0, out)
        if (Math.abs(lat) <= 15_000) bestLift = Math.max(bestLift, w.wind.y)
        if (w.turbulence >= 0.7) severe++
        n++
      }
      for (let y = 9000; y <= 12_000; y += 500) bestTail = Math.max(bestTail, weather.sample(v3(x, y, z), 0, out).wind.x)
    }
  }
  const p = v3(50_000, 5000, 0)
  const iters = 50_000
  const t0 = performance.now()
  for (let i = 0; i < iters; i++) weather.sample(p, i * 0.01, out)
  const perSample = ((performance.now() - t0) / iters) * 1e6
  ui.stats.textContent = [
    ...[...counts.entries()].map(([k, v]) => `${k.padEnd(10)} ${v}`),
    '',
    `best lift <8 km   ${bestLift.toFixed(1)} m/s`,
    `best tailwind jet ${bestTail.toFixed(1)} m/s`,
    `severe share      ${((100 * severe) / n).toFixed(1)} %`,
    `build ${buildMs.toFixed(1)} ms · ${perSample.toFixed(0)} ns/sample`,
  ].join('\n')
}

// ── Particles advected in the plan slice: filaments should read as coherent flow.
const px = new Float64Array(PARTICLES)
const pz = new Float64Array(PARTICLES)
const age = new Int32Array(PARTICLES)
let seedState = 1
const rand = () => {
  // Sandbox-only visual jitter; not part of the deterministic sim.
  seedState = (seedState * 16807) % 2147483647
  return seedState / 2147483647
}
function spawn(i: number) {
  px[i] = BOUNDS_MIN.x + rand() * (BOUNDS_MAX.x - BOUNDS_MIN.x)
  pz[i] = BOUNDS_MIN.z + rand() * (BOUNDS_MAX.z - BOUNDS_MIN.z)
  age[i] = Math.floor(rand() * 90)
}
function resetParticles() {
  for (let i = 0; i < PARTICLES; i++) spawn(i)
  ui.planFx.getContext('2d')!.clearRect(0, 0, W, planH)
}
const pos = { x: 0, y: 0, z: 0 }
function stepParticles(t: number) {
  const ctx = ui.planFx.getContext('2d')!
  ctx.globalCompositeOperation = 'destination-out'
  ctx.fillStyle = 'rgba(0,0,0,0.07)'
  ctx.fillRect(0, 0, W, planH)
  ctx.globalCompositeOperation = 'source-over'
  if (!ui.particles.checked) return
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.7)'
  ctx.lineWidth = 1
  ctx.beginPath()
  pos.y = num(ui.alt)
  for (let i = 0; i < PARTICLES; i++) {
    pos.x = px[i]!
    pos.z = pz[i]!
    const s = weather.sample(pos, t, out)
    const nx = pos.x + s.wind.x * SIM_DT
    const nz = pos.z + s.wind.z * SIM_DT
    const [ax, ay] = planToPx(pos.x, pos.z)
    const [bx, by] = planToPx(nx, nz)
    ctx.moveTo(ax, ay)
    ctx.lineTo(bx, by)
    px[i] = nx
    pz[i] = nz
    age[i] = age[i]! + 1
    if (age[i]! > 120 || nx > BOUNDS_MAX.x || nx < BOUNDS_MIN.x || nz > BOUNDS_MAX.z || nz < BOUNDS_MIN.z) spawn(i)
  }
  ctx.stroke()
}

let frame = 0
function loop() {
  frame++
  let t = num(ui.time)
  if (playing) {
    t = (t + SIM_DT) % Number(ui.time.max)
    ui.time.value = String(t)
    if (frame % 4 === 0) redraw()
  }
  stepParticles(t)
  requestAnimationFrame(loop)
}

function hover(e: MouseEvent, at: (px: number, py: number) => Vec3) {
  const r = (e.target as HTMLCanvasElement).getBoundingClientRect()
  const p = at(e.clientX - r.left, e.clientY - r.top)
  const s = weather.sample(p, num(ui.time), out)
  ui.readout.textContent = [
    `x ${(p.x / 1000).toFixed(1)} km  z ${(p.z / 1000).toFixed(1)} km`,
    `alt ${p.y.toFixed(0)} m`,
    `wind ${s.wind.x.toFixed(1)}, ${s.wind.y.toFixed(1)}, ${s.wind.z.toFixed(1)}`,
    `|h| ${Math.hypot(s.wind.x, s.wind.z).toFixed(1)} m/s  w ${s.wind.y.toFixed(1)}`,
    `turb ${s.turbulence.toFixed(2)}  cloud ${s.cloud.toFixed(2)}`,
    `dominant ${s.dominant ?? '—'}`,
  ].join('\n')
}

ui.planFx.addEventListener('mousemove', (e) => hover(e, (x, y) => {
  const [wx, wz] = pxToPlan(x, y)
  return v3(wx, num(ui.alt), wz)
}))
ui.sectionFx.addEventListener('mousemove', (e) => hover(e, sectionPoint))
ui.sectionFx.addEventListener('click', (e) => {
  const r = ui.sectionFx.getBoundingClientRect()
  ui.alt.value = String(Math.round(sectionPoint(0, e.clientY - r.top).y / 250) * 250)
  resetParticles()
  redraw()
})
for (const el of [ui.seed, ui.severity, ui.gate]) el.addEventListener('change', rebuild)
ui.severity.addEventListener('input', () => ($('sevVal').textContent = num(ui.severity).toFixed(2)))
for (const el of [ui.alt, ui.time, ui.layer, ui.arrows, ui.clouds, ui.labels]) el.addEventListener('input', redraw)
ui.alt.addEventListener('change', resetParticles)
ui.play.addEventListener('click', () => {
  playing = !playing
  ui.play.classList.toggle('on', playing)
  ui.play.textContent = playing ? 'Pause' : 'Play'
})
ui.reroll.addEventListener('click', () => {
  ui.seed.value = String(Math.floor(Math.random() * 100_000))
  rebuild()
})
window.addEventListener('resize', () => {
  sizeCanvases()
  resetParticles()
  redraw()
})

// URL params make screenshots reproducible: ?seed=&severity=&alt=&layer=&t=
const q = new URLSearchParams(location.search)
for (const [k, el] of [['seed', ui.seed], ['severity', ui.severity], ['alt', ui.alt], ['t', ui.time], ['gate', ui.gate]] as const) {
  const v = q.get(k)
  if (v !== null) el.value = v
}
const ql = q.get('layer')
if (ql && ql in RAMPS) ui.layer.value = ql

sizeCanvases()
rebuild()
requestAnimationFrame(loop)
