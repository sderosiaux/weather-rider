// Flow layer sandbox: fixture weather, painterly-ish sky, fly camera, preset viewpoints, CPU readout.
// ?preset=<name> jumps to a viewpoint; ?freeze=1 warms up deterministically then stops time (for screenshots); ?ui=0 hides the panel.
// Presets marked `rich` switch to flow.weather.ts (fixture + thermal/shear/wake/storm/fast jet + gusts).
import * as THREE from 'three'
import { createFixtureWeather, fixtureFlightState } from '../src/core/fixtures'
import { createFlowLayerWith, type FlowStats } from '../src/flow'
import { createRichWeather } from './flow.weather'

interface Preset {
  readonly pos: [number, number, number]
  readonly look: [number, number, number]
  readonly simT?: number
  /** Chase the fixture flight instead of a fixed camera. */
  readonly chase?: boolean
  readonly rich?: boolean
}

const PRESETS: Record<string, Preset> = {
  updraft: { pos: [28900, 3600, 1300], look: [30000, 4800, -200] },
  approach: { pos: [25200, 3800, 900], look: [30000, 4600, 0] },
  jet: { pos: [49400, 8600, 2800], look: [50600, 9250, -200] },
  downdraft: { pos: [52600, 4200, 6400], look: [55000, 3200, 4000] },
  calm: { pos: [12000, 3000, 600], look: [16000, 3100, 0] },
  far: { pos: [24500, 5200, 4200], look: [30500, 4300, -500] },
  chase: { pos: [0, 0, 0], look: [1, 0, 0], simT: 150, chase: true },
  thermal: { pos: [11500, 1400, -800], look: [15000, 1900, -3000], rich: true },
  shear: { pos: [66000, 5500, 3200], look: [68500, 6000, 0], rich: true },
  wake: { pos: [61500, 5150, -4600], look: [64500, 5000, -6000], rich: true },
  storm: { pos: [77000, 4200, -1500], look: [85000, 5200, -4000], rich: true },
  highjet: { pos: [38000, 10300, -4800], look: [41000, 11000, -8000], rich: true },
  rich: { pos: [0, 0, 0], look: [1, 0, 0], simT: 150, chase: true, rich: true },
}

const params = new URLSearchParams(location.search)
const canvas = document.getElementById('c') as HTMLCanvasElement
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight, false)

const scene = new THREE.Scene()
scene.fog = new THREE.Fog(0xcfe3f3, 4000, 11000)
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 5, 40000)

// Stand-in clouds: big soft white billboards, so readability over white is tested too.
const cloudTex = (() => {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64)
  grad.addColorStop(0, 'rgba(255,255,255,0.95)')
  grad.addColorStop(0.5, 'rgba(255,255,255,0.6)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 128, 128)
  return new THREE.CanvasTexture(c)
})()
const cloudMat = new THREE.SpriteMaterial({ map: cloudTex, depthWrite: false, fog: true })
const addCloud = (x: number, y: number, z: number, s: number): void => {
  const sp = new THREE.Sprite(cloudMat)
  sp.position.set(x, y, z)
  sp.scale.set(s, s * 0.6, 1)
  scene.add(sp)
}
for (let k = 0; k < 7; k++) addCloud(30000 + Math.sin(k * 2.1) * 900, 2500 + k * 900, Math.cos(k * 1.7) * 900, 2600)
addCloud(16000, 2600, -2500, 3000)
addCloud(45000, 7000, 3500, 4000)
addCloud(52000, 5200, -1500, 3000)

const fixtureWeather = createFixtureWeather(1)
const richWeather = createRichWeather(1)
let lastStats: FlowStats | null = null
let cpuEma = 0
const flow = createFlowLayerWith(scene, {
  onStats: (s) => {
    lastStats = s
    cpuEma = cpuEma === 0 ? s.cpuMs : cpuEma * 0.97 + s.cpuMs * 0.03
  },
})

// ─── Camera ─────────────────────────────────────────────────────────────────
let yaw = 0
let pitch = 0
let simT = 0
let chase = false
const keys = new Set<string>()

const applyPreset = (name: string): void => {
  const p = PRESETS[name]
  if (!p) return
  chase = p.chase ?? false
  flow.setWeather(p.rich ? richWeather : fixtureWeather)
  simT = p.simT ?? 0
  camera.position.set(...p.pos)
  const d = new THREE.Vector3(...p.look).sub(camera.position).normalize()
  yaw = Math.atan2(-d.z, d.x)
  pitch = Math.asin(d.y)
  document.querySelectorAll('#presets button').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.p === name))
}

const orient = (): void => {
  const dir = new THREE.Vector3(Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), -Math.cos(pitch) * Math.sin(yaw))
  camera.lookAt(camera.position.clone().add(dir))
}

const presetsEl = document.getElementById('presets')!
for (const name of Object.keys(PRESETS)) {
  const b = document.createElement('button')
  b.textContent = name
  b.dataset.p = name
  b.onclick = () => applyPreset(name)
  presetsEl.appendChild(b)
}

addEventListener('keydown', (e) => {
  keys.add(e.code)
  if (e.code === 'KeyH') document.getElementById('panel')!.classList.toggle('hidden')
  if (/^Digit\d$/.test(e.code)) {
    const n = Number(e.code.slice(5))
    flow.setIntensity(n === 0 ? 0 : n / 9)
  }
})
addEventListener('keyup', (e) => keys.delete(e.code))
let dragging = false
canvas.addEventListener('pointerdown', () => (dragging = true))
addEventListener('pointerup', () => (dragging = false))
addEventListener('pointermove', (e) => {
  if (!dragging) return
  yaw -= e.movementX * 0.003
  pitch = THREE.MathUtils.clamp(pitch - e.movementY * 0.003, -1.5, 1.5)
})
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight, false)
})

const tmp = new THREE.Vector3()
const moveCamera = (dt: number): void => {
  if (chase) {
    const s = fixtureFlightState(simT)
    const v = tmp.set(s.vel.x, s.vel.y, s.vel.z).normalize()
    camera.position.set(s.pos.x - v.x * 180, s.pos.y - v.y * 180 + 45, s.pos.z - v.z * 180)
    camera.lookAt(s.pos.x + v.x * 400, s.pos.y + v.y * 400, s.pos.z + v.z * 400)
    return
  }
  const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 1500 : 250) * dt
  const fwd = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw))
  const right = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw))
  if (keys.has('KeyW')) camera.position.addScaledVector(fwd, speed)
  if (keys.has('KeyS')) camera.position.addScaledVector(fwd, -speed)
  if (keys.has('KeyD')) camera.position.addScaledVector(right, speed)
  if (keys.has('KeyA')) camera.position.addScaledVector(right, -speed)
  if (keys.has('KeyR')) camera.position.y += speed
  if (keys.has('KeyF')) camera.position.y -= speed
  if (keys.has('ArrowLeft')) yaw += dt
  if (keys.has('ArrowRight')) yaw -= dt
  if (keys.has('ArrowUp')) pitch = Math.min(pitch + dt, 1.5)
  if (keys.has('ArrowDown')) pitch = Math.max(pitch - dt, -1.5)
  orient()
}

// ─── Loop ───────────────────────────────────────────────────────────────────
const statsEl = document.getElementById('stats')!
applyPreset(params.get('preset') ?? 'approach')
orient()

const step = (dt: number): void => {
  simT += dt
  moveCamera(dt)
  flow.update(camera, simT, dt)
}

const freeze = params.get('freeze') === '1'
if (params.get('ui') === '0') document.getElementById('panel')!.classList.add('hidden')
// Deterministic warm-up: fixed steps so screenshots are reproducible and trails are fully grown.
for (let k = 0; k < 150; k++) step(1 / 60)

let last = performance.now()
let frameEma = 16
const loop = (): void => {
  const now = performance.now()
  const dt = Math.min((now - last) / 1000, 0.1)
  frameEma = frameEma * 0.95 + (now - last) * 0.05
  last = now
  if (!freeze) step(dt)
  renderer.render(scene, camera)
  const p = camera.position
  statsEl.textContent =
    `flow CPU ${cpuEma.toFixed(2)} ms · frame ${frameEma.toFixed(1)} ms · ` +
    `${lastStats?.particles ?? 0} particles · stride ${lastStats?.sampleStride ?? 0}\n` +
    `cam ${(p.x / 1000).toFixed(1)} / ${(p.y / 1000).toFixed(2)} / ${(p.z / 1000).toFixed(1)} km`
  requestAnimationFrame(loop)
}
statsEl.style.whiteSpace = 'pre'
loop()
