import * as THREE from 'three'
import type { CreateWorldView, GhostVisual, WorldFrame } from '../core/presentation'
import type { AircraftSpec, AircraftState, MutableWeatherSample, Route, WeatherField, WeatherFeature } from '../core/types'
import { createAircraftVisual } from './aircraft/visual'
import { createAtmosphereUniforms, createSky, PALETTE, SUN_DIR } from './atmosphere'
import { createChaseCamera, smoothing } from './camera'
import { easeInOut, SHOWCASE_ELEVATION, SHOWCASE_FOV, showcaseFraming, TURNTABLE_RATE } from './showcase'
import { layoutClouds, layoutHorizon } from './clouds/layout'
import { createCloudPass } from './clouds/composite'
import { createCloudLayer } from './clouds/mesh'
import { createGateLayer } from './gate'
import { createGhostLayer } from './ghosts'
import { createSea, MAX_SEA_SHADOWS } from './sea'
import { createGlowTexture, createNoiseTexture, createPuffAtlas } from './textures'

const NEAR = 0.5
const FAR = 450_000
/** The player aircraft draws in its own pass, over the (half-res, depthless) clouds. */
const AIRCRAFT_LAYER = 1
/** Seconds for the camera to glide between chase and showcase. */
const SHOWCASE_BLEND_S = 1.4
/** Seconds to fade an airframe out (and back in) when the showcased aircraft changes. */
const SWAP_FADE_S = 0.28

interface Airframe {
  readonly spec: AircraftSpec
  readonly livery: string
}
const sameAirframe = (a: Airframe | null, b: Airframe | null): boolean =>
  a === b || (!!a && !!b && a.spec.id === b.spec.id && a.spec.class === b.spec.class && a.spec.lengthM === b.spec.lengthM && a.livery === b.livery)

/** Horizontal direction the upper-level wind blows toward (anvils shear that way). */
function upperWindDir(weather: WeatherField): { x: number; y: number; z: number } {
  const c = {
    x: (weather.boundsMin.x + weather.boundsMax.x) / 2,
    y: 10_000,
    z: (weather.boundsMin.z + weather.boundsMax.z) / 2,
  }
  const w = weather.sample(c, 0).wind
  const l = Math.hypot(w.x, w.z)
  return l > 0.5 ? { x: w.x / l, y: 0, z: w.z / l } : { x: 1, y: 0, z: 0 }
}

/** Soft cloud shadows on the sea under the biggest vertical clouds. */
function seaShadows(features: readonly WeatherFeature[]): [number, number, number, number][] {
  const discs: [number, number, number, number][] = []
  for (const f of features) {
    if (f.kind === 'storm') discs.push([f.center.x, f.center.z, f.radius * 2.2, 0.75])
    else if (f.kind === 'updraft') discs.push([f.center.x, f.center.z, f.radius * 1.6, 0.45])
    else if (f.kind === 'thermal') discs.push([f.center.x, f.center.z, f.radius * 1.3, 0.25])
  }
  return discs.sort((a, b) => b[2] * b[3] - a[2] * a[3]).slice(0, MAX_SEA_SHADOWS)
}

export const createWorldView: CreateWorldView = (canvas) => {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
    // 150 km of sky with a 27 m aircraft in front of the lens: reversed-Z keeps depth precise at both ends.
    reversedDepthBuffer: true,
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  // ACES over AgX: AgX greys out the golden-hour palette this scene is built on.
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.85
  renderer.outputColorSpace = THREE.SRGBColorSpace

  const scene = new THREE.Scene()
  // For third-party layers using built-in materials (flow particles): an approximate match of our haze.
  scene.fog = new THREE.FogExp2(PALETTE.horizonAway.clone().lerp(PALETTE.horizonSun, 0.3).multiplyScalar(0.8), 1.4e-5)
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, NEAR, FAR)
  camera.position.set(0, 3000, 0)

  const atmosphere = createAtmosphereUniforms()
  const noise = createNoiseTexture()
  const atlas = createPuffAtlas()
  const glow = createGlowTexture()

  const sky = createSky(atmosphere, noise)
  const sea = createSea(atmosphere, noise)
  const clouds = createCloudLayer(atmosphere, atlas)
  const aircraft = createAircraftVisual(atmosphere, glow)
  const ghosts = createGhostLayer(atmosphere, glow)
  const gate = createGateLayer(atmosphere, glow)
  const chase = createChaseCamera()

  const cloudPass = createCloudPass()
  const cloudScene = new THREE.Scene()
  cloudScene.add(clouds.mesh)

  const sun = new THREE.DirectionalLight(new THREE.Color(1.0, 0.8, 0.6), 3.2)
  sun.position.copy(SUN_DIR)
  const hemi = new THREE.HemisphereLight(new THREE.Color(0.55, 0.65, 0.85), new THREE.Color(0.12, 0.16, 0.22), 1.3)
  for (const light of [sun, hemi]) light.layers.enable(AIRCRAFT_LAYER)
  // Showcase rim: a cool back light that only touches the aircraft pass.
  const rim = new THREE.DirectionalLight(new THREE.Color(0.65, 0.8, 1.0), 0)
  rim.layers.set(AIRCRAFT_LAYER)
  scene.add(rim, rim.target)
  scene.add(sky, sea.mesh, cloudPass.composite, clouds.depthMesh, aircraft.worldObjects, ghosts.group, gate.group, sun, hemi, aircraft.group)
  const drawingSize = new THREE.Vector2()

  let weather: WeatherField | null = null
  let spec: AircraftSpec | null = null
  let time = 0
  let simT = 0
  let inCloud = 0
  const probe: MutableWeatherSample = { wind: { x: 0, y: 0, z: 0 }, turbulence: 0, dominant: null, cloud: 0 }
  let cssHeight = canvas.clientHeight || 1
  let cssWidth = canvas.clientWidth || 1

  // ─── Hangar showcase state ───
  let flightAirframe: Airframe | null = null
  let displayed: Airframe | null = null
  let showcase: Airframe | null = null
  let showBlend = 0
  let fade = 1
  let turntable = 0
  let framingRadius = 20
  let lastState: AircraftState | null = null
  const chaseCam = new THREE.PerspectiveCamera(50, 16 / 9, NEAR, FAR)
  const stage = new THREE.Vector3()
  const showPos = new THREE.Vector3()
  const showQ = new THREE.Quaternion()
  const flightPos = new THREE.Vector3()
  const flightQ = new THREE.Quaternion()
  const camShowPos = new THREE.Vector3()
  const camShowQ = new THREE.Quaternion()
  const lookM = new THREE.Matrix4()
  const upY = new THREE.Vector3(0, 1, 0)
  const tmpV = new THREE.Vector3()
  const tmpQ = new THREE.Quaternion()

  const buildAirframe = (a: Airframe): void => {
    aircraft.set(a.spec, a.livery)
    aircraft.group.traverse((o) => o.layers.set(AIRCRAFT_LAYER))
    displayed = a
    const r = aircraft.model?.geometry.boundingSphere?.radius
    if (r) framingRadius = r
  }

  /** Swap airframes through a short fade instead of popping. */
  const stepAirframe = (dt: number): void => {
    const desired = showcase ?? flightAirframe
    if (!desired) return
    if (!sameAirframe(desired, displayed)) {
      fade -= dt / SWAP_FADE_S
      if (fade <= 0 || !displayed) {
        fade = displayed ? 0 : 1
        buildAirframe(desired)
      }
    } else if (fade < 1) {
      fade = Math.min(1, fade + dt / SWAP_FADE_S)
    }
    aircraft.setOpacity(fade)
  }

  const updateShowcase = (state: AircraftState | null, dt: number): void => {
    showBlend = Math.min(1, Math.max(0, showBlend + (showcase ? dt : -dt) / SHOWCASE_BLEND_S))
    const e = easeInOut(showBlend)
    if (state) {
      flightPos.set(state.pos.x, state.pos.y, state.pos.z)
      flightQ.set(state.orientation.x, state.orientation.y, state.orientation.z, state.orientation.w)
    }
    // The trophy flies in formation with the (demo) flight: no cut when entering or leaving the hangar.
    stage.copy(flightPos)
    turntable += TURNTABLE_RATE * dt
    tmpQ.setFromAxisAngle(upY, turntable)
    showQ.setFromAxisAngle(tmpV.set(1, 0, 0), Math.sin(time * 0.35) * 0.04).premultiply(tmpQ)
    showPos.copy(stage)
    showPos.y += Math.sin(time * 0.5) * framingRadius * 0.03

    // Camera: three-quarter, slightly high, the sun behind the camera so the livery is lit.
    const aspect = cssWidth / cssHeight
    const { distance } = showcaseFraming(framingRadius, aspect, SHOWCASE_FOV)
    const sunYaw = Math.atan2(-SUN_DIR.z, SUN_DIR.x) + 0.6
    camShowPos.set(Math.cos(sunYaw) * Math.cos(SHOWCASE_ELEVATION), Math.sin(SHOWCASE_ELEVATION), -Math.sin(sunYaw) * Math.cos(SHOWCASE_ELEVATION))
    rim.position.copy(stage).addScaledVector(camShowPos, -1).addScaledVector(upY, 0.6)
    rim.target.position.copy(stage)
    rim.intensity = 2.2 * e
    sun.intensity = 3.2 + 1.3 * e
    camShowPos.multiplyScalar(distance).add(stage)
    lookM.lookAt(camShowPos, stage, upY)
    camShowQ.setFromRotationMatrix(lookM)

    if (e > 0) {
      aircraft.pose(tmpV.copy(flightPos).lerp(showPos, e), tmpQ.copy(flightQ).slerp(showQ, e), time, dt)
    }
    ghosts.group.visible = e < 0.01
    gate.group.visible = e < 0.01
  }

  const applyCamera = (): void => {
    const e = easeInOut(showBlend)
    camera.position.copy(chaseCam.position).lerp(camShowPos, e)
    camera.quaternion.copy(chaseCam.quaternion).slerp(camShowQ, e)
    camera.fov = chaseCam.fov + (SHOWCASE_FOV - chaseCam.fov) * e
    if (e > 0) {
      // Framed from the canvas size alone: the contract's safe box, no knowledge of the hangar DOM.
      const f = showcaseFraming(framingRadius, cssWidth / cssHeight, SHOWCASE_FOV)
      camera.setViewOffset(cssWidth, cssHeight, f.offsetX * e * cssWidth, f.offsetY * e * cssHeight, cssWidth, cssHeight)
    } else if (camera.view) {
      camera.clearViewOffset()
    }
    camera.updateProjectionMatrix()
  }

  return {
    scene,
    camera,
    renderer,
    setWeather(w) {
      weather = w
      const opts = { seed: w.seed, sun: SUN_DIR, windDir: upperWindDir(w) }
      clouds.setPuffs([...layoutClouds(w.features, opts), ...layoutHorizon(w.boundsMin, w.boundsMax, opts)])
      sea.setShadows(seaShadows(w.features))
    },
    setRoute(route: Route) {
      gate.set(route)
    },
    setAircraft(s, liveryColor) {
      spec = s
      flightAirframe = { spec: s, livery: liveryColor }
      // In flight the airframe changes instantly; in the hangar the fade handles it.
      if (!showcase && showBlend === 0) {
        buildAirframe(flightAirframe)
        fade = 1
        aircraft.setOpacity(1)
      }
      chase.reset()
    },
    setShowcase(next) {
      showcase = next ? { spec: next.spec, livery: next.liveryColor } : null
    },
    setGhosts(list: readonly GhostVisual[]) {
      ghosts.set(list)
    },
    update(frame: WorldFrame) {
      const dt = Math.min(Math.max(frame.dtReal, 0), 0.25)
      time += dt
      simT = frame.state.t
      lastState = frame.state
      stepAirframe(dt)
      if (showBlend === 0 && !showcase) aircraft.update(frame.state, time, dt)
      ghosts.update(frame.ghostPoses)
      chase.update(chaseCam, frame.state, spec, time, dt)
      updateShowcase(lastState, dt)
      applyCamera()
      if (weather) {
        const c = weather.sample(camera.position, simT, probe).cloud
        // A trophy wrapped in white-out is no trophy: the showcase keeps its view clear.
        const target = Math.min(1, c * 1.2) * (1 - 0.85 * easeInOut(showBlend))
        inCloud += (target - inCloud) * smoothing(3, dt)
      }
    },
    render() {
      camera.updateMatrixWorld()
      atmosphere.uCamPos.value.copy(camera.position)
      atmosphere.uTime.value = time
      atmosphere.uInCloud.value = inCloud * 0.85
      sea.follow(camera)
      clouds.sort(camera)
      const pixelAngle = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / cssHeight
      aircraft.setPixelAngle(pixelAngle)
      ghosts.setPixelAngle(pixelAngle)
      cloudPass.render(renderer, cloudScene, camera)
      // Pass 1: world (sky, sea, composited clouds, trails, gate, ghosts, third-party layers).
      camera.layers.set(0)
      renderer.render(scene, camera)
      // Pass 2: the player aircraft on top. Nothing in the world legitimately sits between it and
      // a chase camera 150 m behind, and in-cloud the player must still see their aircraft.
      const autoClear = renderer.autoClear
      renderer.autoClear = false
      renderer.clearDepth()
      camera.layers.set(AIRCRAFT_LAYER)
      renderer.render(scene, camera)
      camera.layers.set(0)
      renderer.autoClear = autoClear
    },
    resize(width, height) {
      cssHeight = Math.max(1, height)
      cssWidth = Math.max(1, width)
      chaseCam.aspect = cssWidth / cssHeight
      chaseCam.updateProjectionMatrix()
      renderer.setSize(width, height, false)
      renderer.getDrawingBufferSize(drawingSize)
      cloudPass.setSize(drawingSize.x, drawingSize.y)
      camera.aspect = width / Math.max(1, height)
      camera.updateProjectionMatrix()
    },
    dispose() {
      sky.geometry.dispose()
      ;(sky.material as THREE.Material).dispose()
      sea.dispose()
      clouds.dispose()
      cloudPass.dispose()
      aircraft.dispose()
      ghosts.dispose()
      gate.dispose()
      noise.dispose()
      atlas.dispose()
      glow.dispose()
      scene.clear()
      renderer.dispose()
    },
  }
}
