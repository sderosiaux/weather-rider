// Touch controls sandbox: the real input + HUD over a fake sky, stacked like the game (view, touch layer, HUD).
// Live: touch it (tablet, or devtools touch emulation); the dev bar shows the Controls the game would get.
// Deterministic shots: ?hold=stick,throttle,yaw (synthetic touches held in place) &bg=bright|storm &shot=1
import { createHud, createInput } from '../src/ui'
import type { HudModel } from '../src/core/types'
import { MENU_EVENT } from '../src/ui/input/stick'

const params = new URLSearchParams(location.search)
const stage = document.getElementById('stage')!
const surface = document.getElementById('surface')!
const dev = document.getElementById('dev')!
const hud = createHud(document.getElementById('hud')!)
const input = createInput(surface)

const TRIM = 0.62
let invert = false
const fly = (): void => {
  input.resetForFlight(TRIM)
  hud.setVisible(true)
}

// Cruise with a ghost: every instrument on screen, so overlap with the controls shows.
const model = (throttle: number): HudModel => ({
  dailyNumber: 272,
  routeLabel: 'JFK → LIS',
  altitudeFt: 16_420,
  verticalSpeedFpm: 350,
  airspeedKt: 262,
  groundSpeedKmh: 512,
  headingDeg: 84,
  throttle,
  fuelPct: 58,
  comfort: 86,
  stress: 12,
  turbulence: 0.18,
  dominant: null,
  gLoad: 1.02,
  stalled: false,
  gateDistanceKm: 2_140,
  gateBearingDeg: 8,
  gateAltitudeOk: true,
  displayTimeS: 3 * 3600 + 12 * 60,
  ghostDeltaS: -3.1,
})

// ── Synthetic touches (shots) ──────────────────────────────────────────────

const finger = (type: 'pointerdown' | 'pointermove' | 'pointerup', id: number, x: number, y: number): void => {
  surface.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 1, clientX: x, clientY: y, bubbles: true, cancelable: true }))
}
const box = (selector: string): DOMRect => document.querySelector(selector)!.getBoundingClientRect()
const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))

const hold = async (parts: readonly string[]): Promise<void> => {
  await nextFrame()
  await nextFrame()
  const home = box('.wr-touch__home')
  const r = home.width / 2
  const cx = home.left + r
  const cy = home.top + home.height / 2
  // First touch engages the layer; pads only answer once it is drawn.
  finger('pointerdown', 1, cx, cy)
  await nextFrame()
  await nextFrame()
  if (parts.includes('stick')) finger('pointermove', 1, cx + r * 0.55, cy - r * 0.35)
  else finger('pointerup', 1, cx, cy)
  if (parts.includes('throttle')) {
    const track = box('.wr-touch__track')
    const x = track.left + track.width / 2
    const y = track.top + track.height * 0.6
    finger('pointerdown', 2, x, y)
    finger('pointermove', 2, x, y - track.height * 0.2)
  }
  if (parts.includes('yaw')) {
    const pad = box('.wr-touch__pad')
    finger('pointerdown', 3, pad.left + pad.width / 2, pad.top + pad.height / 2)
  }
}

// ── Dev bar ────────────────────────────────────────────────────────────────

const readout = document.createElement('output')
const btn = (label: string, fn: () => void): HTMLButtonElement => {
  const b = document.createElement('button')
  b.textContent = label
  b.addEventListener('click', (e) => {
    e.stopPropagation()
    fn()
  })
  return b
}
dev.append(
  btn('Sky', () => stage.classList.toggle('storm')),
  btn('Menu', () => {
    hud.setVisible(false)
    window.dispatchEvent(new Event(MENU_EVENT))
  }),
  btn('Fly', fly),
  btn('Invert pitch', () => {
    invert = !invert
    input.setInvertPitch(invert)
  }),
  readout,
)

stage.classList.toggle('storm', params.get('bg') === 'storm')
if (params.has('shot')) document.body.classList.add('shot')
fly()
const holdParts = params.get('hold')?.split(',') ?? []
if (holdParts.length > 0) void hold(holdParts)

const frame = (): void => {
  const c = input.read()
  hud.update(model(c.throttle))
  readout.textContent = `${document.documentElement.dataset.wrStick ?? '-'} · pitch ${c.pitch.toFixed(2)}  roll ${c.roll.toFixed(2)}  yaw ${c.yaw.toFixed(2)}  thr ${c.throttle.toFixed(2)}`
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
