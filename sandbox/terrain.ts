// Debug viewer for src/terrain: top-down map (hillshade + cover, rivers, cities, route, clearance zones) and a side
// profile along the straight start → gate line.
import type { Route, Terrain, TerrainCover, TerrainParams } from '../src/core/types'
import { dailyWeatherFor } from '../src/meta'
import { createTerrain } from '../src/terrain'
import { CORRIDOR_ALLOWANCE, CORRIDOR_CLEARANCE, CORRIDOR_HALF_WIDTH, GATE_CLEARANCE, GATE_RADIUS, START_CLEARANCE, START_RADIUS } from '../src/terrain/clearance'
import { paramsFor } from '../src/terrain/testkit'

type Rgb = readonly [number, number, number]
const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]

const COVER: Record<TerrainCover, Rgb> = {
  sea: hex('#6fa3cc'),
  beach: hex('#eadcae'),
  grass: hex('#b8cf8c'),
  fields: hex('#d9d29a'),
  forest: hex('#5d8c4f'),
  rock: hex('#a39d92'),
  snow: hex('#fafafa'),
  lake: hex('#5f9fd6'),
  river: hex('#3f86cf'),
  city: hex('#b7a79c'),
}
const COVERS = Object.keys(COVER) as TerrainCover[]
/** Elevation tint when the cover layer is off. */
const ELEV: readonly (readonly [number, Rgb])[] = [[0, hex('#9cc28a')], [400, hex('#d9d6a0')], [1000, hex('#c9a77c')], [1800, hex('#a08f80')], [2500, hex('#f4f4f4')]]

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const ui = {
  day: $<HTMLInputElement>('day'),
  route: $<HTMLSelectElement>('route'),
  seed: $<HTMLInputElement>('seed'),
  routeView: $<HTMLButtonElement>('route-view'),
  horizonView: $<HTMLButtonElement>('horizon-view'),
  next: $<HTMLButtonElement>('next'),
  shade: $<HTMLInputElement>('shade'),
  cover: $<HTMLInputElement>('cover'),
  rivers: $<HTMLInputElement>('rivers'),
  labels: $<HTMLInputElement>('labels'),
  zones: $<HTMLInputElement>('zones'),
  contours: $<HTMLInputElement>('contours'),
  stats: $('stats'),
  readout: $('readout'),
  map: $<HTMLCanvasElement>('map'),
  mapFx: $<HTMLCanvasElement>('mapFx'),
  mapTitle: $('mapTitle'),
  legend: $('legend'),
  profile: $<HTMLCanvasElement>('profile'),
}

interface View {
  x0: number
  z0: number
  /** Metres per pixel. */
  mpp: number
  w: number
  h: number
}

let horizon = false
let terrain: Terrain | null = null
let params: TerrainParams | null = null
let route: Route | null = null
let view: View = { x0: 0, z0: 0, mpp: 100, w: 1, h: 1 }

ui.legend.innerHTML = COVERS.map((c) => `<span><i style="background: rgb(${COVER[c].join(',')})"></i>${c}</span>`).join('')

function fillRoutes(): void {
  const daily = dailyWeatherFor(Number(ui.day.value) || 1)
  const keep = ui.route.selectedIndex
  ui.route.innerHTML = daily.routes.map((r, i) => `<option value="${i}">${r.label} · ${(Math.hypot(r.gate.x - r.start.x, r.gate.z - r.start.z) / 1000).toFixed(0)} km · start ${r.start.y} m · gate ≥ ${r.gateMinAlt} m</option>`).join('')
  ui.route.selectedIndex = keep >= 0 ? keep : 0
}

function generate(): void {
  const daily = dailyWeatherFor(Number(ui.day.value) || 1)
  route = daily.routes[Number(ui.route.value) || 0]!
  const base = paramsFor(daily, route)
  const override = ui.seed.value.trim()
  params = override ? { ...base, seed: Number(override) } : base
  const t0 = performance.now()
  terrain = createTerrain(params)
  const genMs = performance.now() - t0
  // Per-call cost on this machine (browser JIT), random points in the bounds.
  const N = 200_000
  const xs = new Float64Array(N)
  const zs = new Float64Array(N)
  for (let i = 0; i < N; i++) {
    xs[i] = params.boundsMin.x + ((i * 7919) % 10007) / 10007 * (params.boundsMax.x - params.boundsMin.x)
    zs[i] = params.boundsMin.z + ((i * 104729) % 10009) / 10009 * (params.boundsMax.z - params.boundsMin.z)
  }
  let sink = 0
  const t1 = performance.now()
  for (let i = 0; i < N; i++) sink += terrain.heightAt(xs[i]!, zs[i]!)
  const t2 = performance.now()
  for (let i = 0; i < N; i++) sink += terrain.coverAt(xs[i]!, zs[i]!).length
  const t3 = performance.now()
  // Keeps the JIT from discarding the benchmark loops.
  if (!Number.isFinite(sink)) console.warn('non-finite terrain sample')
  const towns = terrain.cities.map((c) => `${c.role === 'town' ? '·' : '★'} ${c.name} (${(c.radius / 1000).toFixed(1)} km, ${c.center.y.toFixed(0)} m)`)
  ui.stats.textContent = [
    `seed ${params.seed}`,
    `generated in ${genMs.toFixed(0)} ms`,
    `heightAt ${(((t2 - t1) / N) * 1e6).toFixed(0)} ns · coverAt ${(((t3 - t2) / N) * 1e6).toFixed(0)} ns`,
    `max ground ${terrain.maxHeight.toFixed(0)} m`,
    `rivers ${terrain.rivers.length} pieces · cities ${terrain.cities.length}`,
    '',
    ...towns.slice(0, 12),
  ].join('\n')
  render()
}

function fitView(): void {
  if (!params) return
  const maxW = Number(new URLSearchParams(location.search).get('w')) || Math.min(1400, ui.map.parentElement!.parentElement!.clientWidth - 24)
  const x0 = horizon ? params.boundsMin.x - 150_000 : params.boundsMin.x
  const x1 = horizon ? params.boundsMax.x + 150_000 : params.boundsMax.x
  const z0 = horizon ? params.boundsMin.z - 150_000 : params.boundsMin.z
  const z1 = horizon ? params.boundsMax.z + 150_000 : params.boundsMax.z
  // ?focus=xKm,zKm,widthKm zooms on a detail (aspect 3:2).
  const focus = new URLSearchParams(location.search).get('focus')?.split(',').map(Number)
  if (focus && focus.length === 3) {
    const [fx, fz, fw] = focus as [number, number, number]
    const mppF = (fw * 1000) / maxW
    view = { x0: fx * 1000 - fw * 500, z0: fz * 1000 - fw * 333, mpp: mppF, w: maxW, h: Math.round(maxW / 1.5) }
    return
  }
  const mpp = (x1 - x0) / maxW
  view = { x0, z0, mpp, w: Math.round((x1 - x0) / mpp), h: Math.round((z1 - z0) / mpp) }
}

function render(): void {
  if (!terrain || !params || !route) return
  fitView()
  const { w, h, mpp, x0, z0 } = view
  for (const c of [ui.map, ui.mapFx]) {
    c.width = w
    c.height = h
  }
  ui.mapTitle.textContent = `${(w * mpp / 1000).toFixed(0)} × ${(h * mpp / 1000).toFixed(0)} km · ${mpp.toFixed(0)} m/px · north up (−z)`
  const heights = new Float32Array((w + 1) * (h + 1))
  for (let j = 0; j <= h; j++) for (let i = 0; i <= w; i++) heights[j * (w + 1) + i] = terrain.heightAt(x0 + i * mpp, z0 + j * mpp)
  const ctx = ui.map.getContext('2d')!
  const img = ctx.createImageData(w, h)
  const showShade = ui.shade.checked
  const showCover = ui.cover.checked
  const contours = ui.contours.checked
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * (w + 1) + i
      const hh = heights[k]!
      const x = x0 + (i + 0.5) * mpp
      const z = z0 + (j + 0.5) * mpp
      const cover = terrain.coverAt(x, z)
      let rgb: readonly number[]
      if (showCover) {
        rgb = COVER[cover]
        if (cover === 'sea') {
          const d = Math.min(1, -hh / 220)
          rgb = [rgb[0]! * (1 - 0.35 * d), rgb[1]! * (1 - 0.3 * d), rgb[2]! * (1 - 0.15 * d)]
        }
      } else {
        rgb = cover === 'sea' || cover === 'lake' || cover === 'river' ? COVER[cover] : elevColor(hh)
      }
      let shade = 1
      const water = cover === 'sea' || cover === 'lake' || cover === 'river'
      if (showShade && !water) {
        const dx = (heights[k + 1]! - heights[k]!) / mpp
        const dz = (heights[k + w + 1]! - heights[k]!) / mpp
        // Light from the north-west, a little exaggerated so gentle relief still reads.
        shade = Math.max(0.35, Math.min(1.35, 1 + (-dx - dz) * 2.2))
      }
      if (contours && !water) {
        const band = Math.floor(hh / 250)
        if (band !== Math.floor(heights[k + 1]! / 250) || band !== Math.floor(heights[k + w + 1]! / 250)) shade *= 0.75
      }
      const o = (j * w + i) * 4
      img.data[o] = Math.min(255, rgb[0]! * shade)
      img.data[o + 1] = Math.min(255, rgb[1]! * shade)
      img.data[o + 2] = Math.min(255, rgb[2]! * shade)
      img.data[o + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  drawOverlay()
  drawProfile()
}

function elevColor(h: number): Rgb {
  for (let i = 1; i < ELEV.length; i++) {
    const [b, cb] = ELEV[i]!
    if (h <= b) {
      const [a, ca] = ELEV[i - 1]!
      const t = Math.max(0, (h - a) / (b - a))
      return [ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t]
    }
  }
  return ELEV[ELEV.length - 1]![1]
}

const px = (x: number): number => (x - view.x0) / view.mpp
const pz = (z: number): number => (z - view.z0) / view.mpp

function drawOverlay(): void {
  if (!terrain || !params || !route) return
  const ctx = ui.mapFx.getContext('2d')!
  ctx.clearRect(0, 0, view.w, view.h)
  if (horizon) {
    ctx.strokeStyle = 'rgba(27,35,48,0.5)'
    ctx.setLineDash([6, 4])
    ctx.strokeRect(px(params.boundsMin.x), pz(params.boundsMin.z), (params.boundsMax.x - params.boundsMin.x) / view.mpp, (params.boundsMax.z - params.boundsMin.z) / view.mpp)
    ctx.setLineDash([])
  }
  if (ui.rivers.checked) {
    ctx.strokeStyle = 'rgba(30,100,190,0.9)'
    ctx.lineCap = 'round'
    for (const r of terrain.rivers) {
      ctx.lineWidth = Math.max(1, r.width / view.mpp)
      ctx.beginPath()
      r.path.forEach((p, i) => (i === 0 ? ctx.moveTo(px(p.x), pz(p.z)) : ctx.lineTo(px(p.x), pz(p.z))))
      ctx.stroke()
    }
  }
  const s = route.start
  const g = route.gate
  if (ui.zones.checked) {
    ctx.strokeStyle = 'rgba(220,38,38,0.85)'
    ctx.fillStyle = 'rgba(220,38,38,0.06)'
    ctx.lineWidth = 1.2
    ctx.setLineDash([5, 4])
    for (const [c, r] of [[s, START_RADIUS], [g, GATE_RADIUS]] as const) {
      ctx.beginPath()
      ctx.arc(px(c.x), pz(c.z), r / view.mpp, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
    const len = Math.hypot(g.x - s.x, g.z - s.z)
    const nx = -(g.z - s.z) / len
    const nz = (g.x - s.x) / len
    const hw = CORRIDOR_HALF_WIDTH
    ctx.beginPath()
    ctx.moveTo(px(s.x + nx * hw), pz(s.z + nz * hw))
    ctx.lineTo(px(g.x + nx * hw), pz(g.z + nz * hw))
    ctx.lineTo(px(g.x - nx * hw), pz(g.z - nz * hw))
    ctx.lineTo(px(s.x - nx * hw), pz(s.z - nz * hw))
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    ctx.setLineDash([])
  }
  ctx.strokeStyle = '#1b2330'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(px(s.x), pz(s.z))
  ctx.lineTo(px(g.x), pz(g.z))
  ctx.stroke()
  marker(ctx, px(s.x), pz(s.z), '#2563eb', `START ${route.from} ${s.y} m`)
  marker(ctx, px(g.x), pz(g.z), '#16a34a', `GATE ${route.to} ≥ ${route.gateMinAlt} m`)
  if (ui.labels.checked) {
    ctx.font = '600 11px ui-sans-serif, -apple-system, sans-serif'
    for (const c of terrain.cities) {
      const r = Math.max(2, c.radius / view.mpp)
      ctx.strokeStyle = c.role === 'town' ? 'rgba(80,60,50,0.8)' : 'rgba(27,35,48,0.95)'
      ctx.lineWidth = c.role === 'town' ? 1 : 2
      ctx.beginPath()
      ctx.arc(px(c.center.x), pz(c.center.z), r, 0, Math.PI * 2)
      ctx.stroke()
      label(ctx, px(c.center.x) + r + 3, pz(c.center.z) + 4, c.name)
    }
  }
}

function label(ctx: CanvasRenderingContext2D, x: number, y: number, text: string): void {
  ctx.lineWidth = 3
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'
  ctx.strokeText(text, x, y)
  ctx.fillStyle = '#1b2330'
  ctx.fillText(text, x, y)
}

function marker(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, text: string): void {
  ctx.fillStyle = color
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(x, y, 5, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
  ctx.font = '700 11px ui-sans-serif, -apple-system, sans-serif'
  label(ctx, x + 8, y - 8, text)
}

function drawProfile(): void {
  if (!terrain || !route || !params) return
  const W = view.w
  const H = 230
  ui.profile.width = W
  ui.profile.height = H
  const ctx = ui.profile.getContext('2d')!
  ctx.clearRect(0, 0, W, H)
  const s = route.start
  const g = route.gate
  const len = Math.hypot(g.x - s.x, g.z - s.z)
  const dx = (g.x - s.x) / len
  const dz = (g.z - s.z) / len
  const a0 = -20_000
  const a1 = len + 20_000
  const top = Math.max(s.y, route.gateMaxAlt) + 600
  const X = (a: number): number => ((a - a0) / (a1 - a0)) * W
  const Y = (y: number): number => H - 18 - ((y + 200) / (top + 200)) * (H - 30)
  ctx.font = '11px ui-monospace, monospace'
  ctx.fillStyle = '#6b7482'
  for (let y = 0; y <= top; y += 1000) {
    ctx.strokeStyle = '#eef0f3'
    ctx.beginPath()
    ctx.moveTo(0, Y(y))
    ctx.lineTo(W, Y(y))
    ctx.stroke()
    ctx.fillText(`${y / 1000} km`, 4, Y(y) - 2)
  }
  // Highest ground within ±4 km of the line, then the ground on the line coloured by cover.
  ctx.strokeStyle = '#9aa1ab'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let i = 0; i <= W; i++) {
    const a = a0 + (i / W) * (a1 - a0)
    let m = -Infinity
    for (let n = -CORRIDOR_HALF_WIDTH; n <= CORRIDOR_HALF_WIDTH; n += 250) m = Math.max(m, terrain.heightAt(s.x + dx * a - dz * n, s.z + dz * a + dx * n))
    i === 0 ? ctx.moveTo(i, Y(m)) : ctx.lineTo(i, Y(m))
  }
  ctx.stroke()
  for (let i = 0; i < W; i++) {
    const a = a0 + ((i + 0.5) / W) * (a1 - a0)
    const x = s.x + dx * a
    const z = s.z + dz * a
    const hh = terrain.heightAt(x, z)
    const c = COVER[terrain.coverAt(x, z)]
    ctx.fillStyle = `rgb(${c.join(',')})`
    const y = Y(Math.max(hh, 0))
    ctx.fillRect(i, y, 1, Y(-200) - y)
  }
  // Ceilings.
  ctx.strokeStyle = 'rgba(220,38,38,0.9)'
  ctx.setLineDash([5, 4])
  const lineCap = Math.min(s.y, route.gateMinAlt + CORRIDOR_ALLOWANCE) - CORRIDOR_CLEARANCE
  const seg = (a: number, b: number, y: number): void => {
    ctx.beginPath()
    ctx.moveTo(X(a), Y(y))
    ctx.lineTo(X(b), Y(y))
    ctx.stroke()
  }
  seg(-START_RADIUS, START_RADIUS, s.y - START_CLEARANCE)
  seg(len - GATE_RADIUS, len + GATE_RADIUS, route.gateMinAlt - GATE_CLEARANCE)
  seg(0, len, lineCap)
  ctx.setLineDash([])
  ctx.fillStyle = '#2563eb'
  ctx.beginPath()
  ctx.arc(X(0), Y(s.y), 4, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = 'rgba(22,163,74,0.18)'
  ctx.fillRect(X(len) - 3, Y(route.gateMaxAlt), 6, Y(route.gateMinAlt) - Y(route.gateMaxAlt))
  ctx.fillStyle = '#6b7482'
  for (let km = 0; km <= len / 1000; km += 10) ctx.fillText(`${km}`, X(km * 1000) - 6, H - 4)
}

ui.mapFx.addEventListener('mousemove', (e) => {
  if (!terrain) return
  const rect = ui.mapFx.getBoundingClientRect()
  const x = view.x0 + (e.clientX - rect.left) * view.mpp
  const z = view.z0 + (e.clientY - rect.top) * view.mpp
  ui.readout.textContent = `x ${(x / 1000).toFixed(1)} km  z ${(z / 1000).toFixed(1)} km\nground ${terrain.heightAt(x, z).toFixed(0)} m  ${terrain.coverAt(x, z)}`
})
ui.day.addEventListener('change', () => {
  fillRoutes()
  generate()
})
ui.route.addEventListener('change', generate)
ui.seed.addEventListener('change', generate)
ui.next.addEventListener('click', () => {
  ui.day.value = String((Number(ui.day.value) || 1) + 1)
  fillRoutes()
  generate()
})
for (const [btn, h] of [[ui.routeView, false], [ui.horizonView, true]] as const) {
  btn.addEventListener('click', () => {
    horizon = h
    ui.routeView.classList.toggle('on', !h)
    ui.horizonView.classList.toggle('on', h)
    render()
  })
}
for (const el of [ui.shade, ui.cover, ui.contours]) el.addEventListener('change', render)
for (const el of [ui.rivers, ui.labels, ui.zones]) el.addEventListener('change', drawOverlay)

// URL: ?day=N&route=i&horizon=1 for screenshots.
const q = new URLSearchParams(location.search)
if (q.get('day')) ui.day.value = q.get('day')!
fillRoutes()
if (q.get('route')) ui.route.value = q.get('route')!
if (q.get('seed')) ui.seed.value = q.get('seed')!
if (q.get('horizon') === '1') {
  horizon = true
  ui.routeView.classList.remove('on')
  ui.horizonView.classList.add('on')
}
generate()
