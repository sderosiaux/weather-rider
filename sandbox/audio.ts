// Audio sandbox: drive every AudioFrame field by hand, fire cues, and measure the output.
// window.__audio exposes the analyser + measurePreset() so automated checks can read levels
// (nobody can "listen" in CI): RMS and three band energies, in dBFS, averaged over a window.
import type { AudioFrame } from '../src/core/presentation'
import type { AircraftClass, WeatherFeatureKind } from '../src/core/types'
import { createAudioWith, type AudioGraph } from '../src/audio'
import type { CueKind } from '../src/audio/cues'
import { buildGraph } from '../src/audio/graph'
import { computeMix, LAYERS, layersFor, type AudioScene, type Layer } from '../src/audio/mix'

type NumKey = 'airspeedMs' | 'throttle' | 'turbulence' | 'verticalWindMs' | 'cloud'
const SLIDERS: readonly { key: NumKey; min: number; max: number; step: number }[] = [
  { key: 'airspeedMs', min: 0, max: 560, step: 1 },
  { key: 'throttle', min: 0, max: 1, step: 0.01 },
  { key: 'turbulence', min: 0, max: 1, step: 0.01 },
  { key: 'verticalWindMs', min: -30, max: 30, step: 0.5 },
  { key: 'cloud', min: 0, max: 1, step: 0.01 },
]
const DOMINANTS: readonly (WeatherFeatureKind | null)[] = [null, 'storm', 'updraft', 'downdraft', 'thermal', 'jetstream', 'shear', 'wake']
const CLASSES: readonly AircraftClass[] = ['turboprop', 'regional', 'narrowbody', 'widebody', 'cargo', 'supersonic', 'experimental']
const CUE_KINDS: readonly CueKind[] = ['arrived', 'crashed', 'overstressed', 'unlock', 'record']

interface Preset {
  readonly scene: AudioScene
  readonly frame: Partial<AudioFrame>
}
const BASE: AudioFrame = {
  airspeedMs: 220, throttle: 0.6, turbulence: 0.05, dominant: null, verticalWindMs: 0, cloud: 0, stalled: false, aircraftClass: 'narrowbody',
}
const PRESETS: Record<string, Preset> = {
  'menu': { scene: 'menu', frame: {} },
  'calm cruise': { scene: 'flight', frame: {} },
  'entering updraft': { scene: 'flight', frame: { airspeedMs: 190, turbulence: 0.25, verticalWindMs: 12, cloud: 0.15, dominant: 'updraft' } },
  'sinking air': { scene: 'flight', frame: { airspeedMs: 210, turbulence: 0.2, verticalWindMs: -12, dominant: 'downdraft' } },
  'in jet stream': { scene: 'flight', frame: { airspeedMs: 245, throttle: 0.5, turbulence: 0.12, dominant: 'jetstream' } },
  'in cloud': { scene: 'flight', frame: { turbulence: 0.15, cloud: 1 } },
  'storm core': { scene: 'flight', frame: { airspeedMs: 200, throttle: 0.75, turbulence: 0.95, verticalWindMs: 6, cloud: 0.9, dominant: 'storm' } },
  'stall': { scene: 'flight', frame: { airspeedMs: 62, throttle: 1, turbulence: 0.2, stalled: true } },
  'turboprop cruise': { scene: 'flight', frame: { airspeedMs: 140, throttle: 0.7, aircraftClass: 'turboprop' } },
  'supersonic cruise': { scene: 'flight', frame: { airspeedMs: 420, throttle: 0.8, aircraftClass: 'supersonic' } },
  'experimental cruise': { scene: 'flight', frame: { airspeedMs: 115, throttle: 0.7, aircraftClass: 'experimental' } },
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
let frame: AudioFrame = BASE
let scene: AudioScene = 'menu'
let analyser: AnalyserNode | null = null
let ctxRef: AudioContext | null = null
let graphRef: AudioGraph | null = null
/** Chrome's AudioContext.renderCapacity (experimental); absent elsewhere. */
interface RenderCapacity extends EventTarget {
  start(options?: { updateInterval?: number }): void
}
let renderLoad: { average: number; peak: number } | null = null

const audio = createAudioWith({
  onGraph(ctx, output, graph) {
    ctxRef = ctx
    graphRef = graph
    const rc = (ctx as AudioContext & { renderCapacity?: RenderCapacity }).renderCapacity
    if (rc) {
      rc.addEventListener('update', (e) => {
        const ev = e as Event & { averageLoad: number; peakLoad: number }
        renderLoad = { average: ev.averageLoad, peak: ev.peakLoad }
      })
      rc.start({ updateInterval: 1 })
    }
    analyser = ctx.createAnalyser()
    analyser.fftSize = 4096
    analyser.smoothingTimeConstant = 0
    output.connect(analyser)
  },
})

// ─── controls ───────────────────────────────────────────────────────────────
const sliderEls = new Map<NumKey, { input: HTMLInputElement; out: HTMLOutputElement }>()
for (const s of SLIDERS) {
  const label = document.createElement('label')
  label.innerHTML = `${s.key}<input type="range" min="${s.min}" max="${s.max}" step="${s.step}" /><output></output>`
  const input = label.querySelector('input')!
  const out = label.querySelector('output')!
  input.addEventListener('input', () => setFrame({ [s.key]: Number(input.value) }))
  sliderEls.set(s.key, { input, out })
  $('sliders').append(label)
}
const dominantEl = $<HTMLSelectElement>('dominant')
dominantEl.innerHTML = DOMINANTS.map((d) => `<option value="${d ?? ''}">${d ?? 'none'}</option>`).join('')
dominantEl.addEventListener('change', () => setFrame({ dominant: (dominantEl.value || null) as WeatherFeatureKind | null }))
const classEl = $<HTMLSelectElement>('class')
classEl.innerHTML = CLASSES.map((c) => `<option>${c}</option>`).join('')
classEl.addEventListener('change', () => setFrame({ aircraftClass: classEl.value as AircraftClass }))
const stalledEl = $<HTMLInputElement>('stalled')
stalledEl.addEventListener('change', () => setFrame({ stalled: stalledEl.checked }))

const sceneButtons = (['menu', 'flight'] as const).map((sc) => {
  const b = document.createElement('button')
  b.textContent = sc
  b.addEventListener('click', () => setScene(sc))
  $('scenes').append(b)
  return b
})
for (const kind of CUE_KINDS) {
  const b = document.createElement('button')
  b.textContent = kind
  b.addEventListener('click', () => audio.cue(kind))
  $('cues').append(b)
}
const presetButtons = Object.keys(PRESETS).map((name) => {
  const b = document.createElement('button')
  b.textContent = name
  b.addEventListener('click', () => applyPreset(name))
  $('presets').append(b)
  return b
})
$('start').addEventListener('click', () => {
  audio.resume()
  $('start').textContent = 'Audio running'
})
// Worst case for cues: fired in the very gesture that creates the context (still 'suspended' then).
$('start-cue').addEventListener('click', () => {
  audio.resume()
  const state = ctxRef?.state
  audio.cue('arrived')
  $('start').textContent = `Audio running (ctx was ${state} at cue time)`
})
$('measure').addEventListener('click', () => void measureAll())

function setFrame(patch: Partial<AudioFrame>): void {
  frame = { ...frame, ...patch }
  syncControls()
}
function setScene(next: AudioScene): void {
  scene = next
  audio.setScene(next)
  syncControls()
}
function applyPreset(name: string): void {
  const p = PRESETS[name]
  if (!p) throw new Error(`unknown preset ${name}`)
  frame = { ...BASE, ...p.frame }
  setScene(p.scene)
  presetButtons.forEach((b) => b.classList.toggle('on', b.textContent === name))
}
function syncControls(): void {
  for (const s of SLIDERS) {
    const el = sliderEls.get(s.key)!
    el.input.value = String(frame[s.key])
    el.out.value = frame[s.key].toFixed(s.step < 1 ? 2 : 0)
  }
  dominantEl.value = frame.dominant ?? ''
  classEl.value = frame.aircraftClass
  stalledEl.checked = frame.stalled
  sceneButtons.forEach((b) => b.classList.toggle('on', b.textContent === scene))
}

// ─── measurement ────────────────────────────────────────────────────────────
export interface Levels {
  readonly rms: number
  readonly low: number
  readonly mid: number
  readonly high: number
}
const db = (power: number): number => (power > 0 ? 10 * Math.log10(power) : -Infinity)

/** Instantaneous powers (linear) of the whole signal and three bands. */
function powers(): { rms: number; low: number; mid: number; high: number } | null {
  if (!analyser || !ctxRef) return null
  const td = new Float32Array(analyser.fftSize)
  analyser.getFloatTimeDomainData(td)
  let sum = 0
  for (const x of td) sum += x * x
  const fd = new Float32Array(analyser.frequencyBinCount)
  analyser.getFloatFrequencyData(fd)
  const binHz = ctxRef.sampleRate / analyser.fftSize
  let low = 0, mid = 0, high = 0
  fd.forEach((d, i) => {
    const p = 10 ** (d / 10)
    const hz = i * binHz
    if (hz < 250) low += p
    else if (hz < 2000) mid += p
    else high += p
  })
  return { rms: sum / td.length, low, mid, high }
}

/** Power-average over `windowMs`, reported in dB (rms in dBFS; bands in dB relative to analyser full scale). */
async function measure(windowMs = 1500): Promise<Levels> {
  const acc = { rms: 0, low: 0, mid: 0, high: 0 }
  let n = 0
  const end = performance.now() + windowMs
  while (performance.now() < end) {
    const p = powers()
    if (p) {
      acc.rms += p.rms; acc.low += p.low; acc.mid += p.mid; acc.high += p.high
      n++
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  if (!n) throw new Error('no analyser: click start first')
  return { rms: db(acc.rms / n), low: db(acc.low / n), mid: db(acc.mid / n), high: db(acc.high / n) }
}

async function measurePreset(name: string, settleMs = 6000): Promise<Levels> {
  applyPreset(name)
  await new Promise((r) => setTimeout(r, settleMs))
  return measure()
}

async function measureAll(settleMs = 6000): Promise<Record<string, Levels>> {
  const out: Record<string, Levels> = {}
  const table = $<HTMLTableElement>('table')
  table.innerHTML = '<tr><th>preset</th><th>RMS dBFS</th><th>low</th><th>mid</th><th>high</th></tr>'
  for (const name of Object.keys(PRESETS)) {
    const l = await measurePreset(name, settleMs)
    out[name] = l
    const row = table.insertRow()
    row.innerHTML = `<td>${name}</td>${[l.rms, l.low, l.mid, l.high].map((v) => `<td>${v.toFixed(1)}</td>`).join('')}`
  }
  return out
}

// ─── CPU benchmark ──────────────────────────────────────────────────────────
// Renders the same graph offline (as fast as the CPU allows) with and without layer gating.
// Wall-clock render time ∝ audio-thread cost; "ungated" = every layer connected (pre-gating behaviour).
export interface BenchRow {
  readonly config: string
  readonly renderMs: number
  readonly realtimeX: number
  readonly sourcesRendered: number
  readonly sourcesTotal: number
}
async function benchmark(seconds = 10): Promise<BenchRow[]> {
  const sr = 48_000
  const rows: BenchRow[] = []
  const configs: readonly { config: string; scene: AudioScene; open: ReadonlySet<Layer> }[] = [
    { config: 'menu, ungated (before)', scene: 'menu', open: new Set(LAYERS) },
    { config: 'menu, gated', scene: 'menu', open: layersFor('menu') },
    { config: 'flight, ungated (before)', scene: 'flight', open: new Set(LAYERS) },
    { config: 'flight, gated', scene: 'flight', open: layersFor('flight') },
  ]
  for (const c of configs) {
    const off = new OfflineAudioContext(2, sr * seconds, sr)
    const g = buildGraph(off)
    g.setVolume(0.8)
    g.apply(computeMix({ ...BASE, verticalWindMs: 8, turbulence: 0.5 }, c.scene), false)
    g.openLayers(c.open)
    g.closeLayersExcept(c.open)
    const t0 = performance.now()
    await off.startRendering()
    const renderMs = performance.now() - t0
    const src = g.sourceCount()
    rows.push({ config: c.config, renderMs, realtimeX: (seconds * 1000) / renderMs, sourcesRendered: src.rendered, sourcesTotal: src.total })
  }
  return rows
}

// ─── loop ───────────────────────────────────────────────────────────────────
let last = performance.now()
const meter = (id: string, dbValue: number) => {
  const pct = Math.max(0, Math.min(100, ((dbValue + 70) / 70) * 100))
  ;($(id).firstElementChild as HTMLElement).style.width = `${pct}%`
}
function tick(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  audio.update(frame, dt)
  const p = powers()
  if (p) {
    const l = { rms: db(p.rms), low: db(p.low), mid: db(p.mid), high: db(p.high) }
    meter('m-rms', l.rms); meter('m-low', l.low); meter('m-mid', l.mid); meter('m-high', l.high)
    const src = graphRef?.sourceCount()
    const load = renderLoad ? `   load ${(renderLoad.average * 100).toFixed(1)}% (peak ${(renderLoad.peak * 100).toFixed(1)}%)` : ''
    $('readout').textContent =
      `RMS ${l.rms.toFixed(1)} dBFS   low ${l.low.toFixed(1)}   mid ${l.mid.toFixed(1)}   high ${l.high.toFixed(1)}   ctx ${ctxRef?.state}\n` +
      `sources rendered ${src?.rendered ?? '—'} / ${src?.total ?? '—'}${load}`
  }
  requestAnimationFrame(tick)
}
requestAnimationFrame(tick)
syncControls()

declare global {
  interface Window {
    __audio: {
      readonly engine: typeof audio
      readonly analyser: () => AnalyserNode | null
      readonly context: () => AudioContext | null
      readonly presets: readonly string[]
      applyPreset(name: string): void
      measure(windowMs?: number): Promise<Levels>
      measurePreset(name: string, settleMs?: number): Promise<Levels>
      measureAll(settleMs?: number): Promise<Record<string, Levels>>
      benchmark(seconds?: number): Promise<BenchRow[]>
      sources(): { readonly total: number; readonly rendered: number } | null
      renderLoad(): { average: number; peak: number } | null
    }
  }
}
window.__audio = {
  engine: audio,
  analyser: () => analyser,
  context: () => ctxRef,
  presets: Object.keys(PRESETS),
  applyPreset,
  measure,
  measurePreset,
  measureAll,
  benchmark,
  sources: () => graphRef?.sourceCount() ?? null,
  renderLoad: () => renderLoad,
}
