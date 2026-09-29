// Wind made visible: particles advected by the weather field, drawn as fading ribbons around the camera.
import * as THREE from 'three'
import type { CreateFlowLayer, FlowLayer } from '../core/presentation'
import type { WeatherField } from '../core/types'
import {
  CPU_BUDGET_MS,
  DEFAULT_PARTICLES,
  FAR_DISTANCE,
  MAX_SAMPLE_STRIDE,
  TELEPORT_DISTANCE,
  TRAIL_POINTS,
} from './params'
import { createParticleSim, createViewVolume, R_POS, R_SEED, R_STAMP, R_VEL, STRIDE } from './particles'
import { trailFragmentShader, trailVertexShader } from './shaders'

export { VISUAL_TIME_SCALE } from './params'

export interface FlowLayerOptions {
  readonly particles?: number
  /** Called after each update with its CPU cost (ms); for sandboxes / perf overlays. */
  readonly onStats?: (stats: FlowStats) => void
}

export interface FlowStats {
  readonly cpuMs: number
  readonly particles: number
  readonly sampleStride: number
}

export function createFlowLayerWith(scene: THREE.Scene, options: FlowLayerOptions = {}): FlowLayer {
  const count = options.particles ?? DEFAULT_PARTICLES
  const sim = createParticleSim(count, TRAIL_POINTS)
  const view = createViewVolume()
  const slotFloats = count * STRIDE

  const buffer = new THREE.InstancedInterleavedBuffer(sim.points, STRIDE, 1)
  buffer.setUsage(THREE.DynamicDrawUsage)
  const geometry = new THREE.InstancedBufferGeometry()
  // Quad corners: x = end (0 older, 1 newer), y = side.
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0], 3))
  geometry.setIndex([0, 2, 1, 1, 2, 3])
  const attach = (suffix: 'A' | 'B', base: number): void => {
    geometry.setAttribute(`aPos${suffix}`, new THREE.InterleavedBufferAttribute(buffer, 3, base + R_POS))
    geometry.setAttribute(`aVel${suffix}`, new THREE.InterleavedBufferAttribute(buffer, 3, base + R_VEL))
    geometry.setAttribute(`aInfo${suffix}`, new THREE.InterleavedBufferAttribute(buffer, 4, base + R_STAMP))
    geometry.setAttribute(`aExt${suffix}`, new THREE.InterleavedBufferAttribute(buffer, 2, base + R_SEED))
  }
  // Instance j = record j (slot s, particle i) → record j + count (slot s+1, same particle).
  attach('A', 0)
  attach('B', slotFloats)
  geometry.instanceCount = TRAIL_POINTS * count
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity)

  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uClock: { value: 0 },
      uTrail: { value: TRAIL_POINTS - 1 },
      uTime: { value: 0 },
      uViewport: { value: new THREE.Vector2(1, 1) },
      uMinPx: { value: 0.75 },
      uFar: { value: FAR_DISTANCE },
      uIntensity: { value: 1 },
      uKindShare: { value: sim.kindShare },
    },
  ])
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: trailVertexShader,
    fragmentShader: trailFragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    fog: true,
    toneMapped: false,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'flow-layer'
  mesh.frustumCulled = false
  // Agreed with render: clouds colour 10, optional cloud-core depth pre-pass 11, flow 12.
  mesh.renderOrder = 12
  const drawSize = new THREE.Vector2()
  mesh.onBeforeRender = (renderer) => {
    renderer.getDrawingBufferSize(drawSize)
    uniforms.uViewport!.value.copy(drawSize)
    uniforms.uMinPx!.value = 0.9 * renderer.getPixelRatio()
  }
  scene.add(mesh)

  let weather: WeatherField | null = null
  let needsReset = true
  let intensity = 1
  let time = 0
  let cpuEma = 0
  let lastX = Number.NaN
  let lastY = 0
  let lastZ = 0
  const camPos = new THREE.Vector3()
  const camDir = new THREE.Vector3()
  const camUp = new THREE.Vector3()
  const camRight = new THREE.Vector3()
  const stats = { cpuMs: 0, particles: count, sampleStride: sim.sampleStride }

  const readCamera = (camera: THREE.Camera): void => {
    camera.updateMatrixWorld()
    camPos.setFromMatrixPosition(camera.matrixWorld)
    camera.getWorldDirection(camDir)
    camUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize()
    camRight.crossVectors(camDir, camUp).normalize()
    view.ox = camPos.x
    view.oy = camPos.y
    view.oz = camPos.z
    view.fx = camDir.x
    view.fy = camDir.y
    view.fz = camDir.z
    view.rx = camRight.x
    view.ry = camRight.y
    view.rz = camRight.z
    view.ux = camUp.x
    view.uy = camUp.y
    view.uz = camUp.z
    const persp = camera as THREE.PerspectiveCamera
    const tanY = persp.isPerspectiveCamera ? Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2) / persp.zoom : 0.6
    view.tanY = tanY
    view.tanX = tanY * (persp.isPerspectiveCamera ? persp.aspect : 1.6)
  }

  const uploadAll = (): void => {
    buffer.clearUpdateRanges()
    buffer.needsUpdate = true
  }

  return {
    setWeather(w) {
      weather = w
      needsReset = true
    },

    update(camera, simT, dtReal) {
      if (!weather || intensity <= 0) return
      const t0 = performance.now()
      readCamera(camera)
      const first = Number.isNaN(lastX)
      const jumped = (view.ox - lastX) ** 2 + (view.oy - lastY) ** 2 + (view.oz - lastZ) ** 2 > TELEPORT_DISTANCE ** 2
      lastX = view.ox
      lastY = view.oy
      lastZ = view.oz
      const resetting = needsReset || jumped || first
      if (resetting) {
        sim.reset(weather, simT, view)
        needsReset = false
        uploadAll()
      } else {
        sim.step(weather, simT, dtReal, view)
        for (let k = 0; k < sim.dirtyCount; k++) buffer.addUpdateRange(sim.dirty[k]! * slotFloats, slotFloats)
        buffer.needsUpdate = true
      }
      time += dtReal
      uniforms.uClock!.value = sim.clock
      uniforms.uTime!.value = time

      const ms = performance.now() - t0
      // Reset frames (spawn + sample everything) are one-off spikes, not steady-state cost.
      if (!resetting) cpuEma = cpuEma === 0 ? ms : cpuEma * 0.95 + ms * 0.05
      // Unknown weather cost: trade sampling rate for frame time, never particle count.
      if (cpuEma > CPU_BUDGET_MS && sim.sampleStride < MAX_SAMPLE_STRIDE) {
        sim.sampleStride++
        cpuEma = CPU_BUDGET_MS * 0.8
      }
      if (options.onStats) {
        stats.cpuMs = ms
        stats.sampleStride = sim.sampleStride
        options.onStats(stats)
      }
    },

    setIntensity(v) {
      intensity = Math.min(Math.max(v, 0), 1)
      uniforms.uIntensity!.value = intensity
      mesh.visible = intensity > 0
      // Particles went stale while hidden; restart around the camera on next update.
      if (intensity <= 0) needsReset = true
    },

    dispose() {
      scene.remove(mesh)
      geometry.dispose()
      material.dispose()
    },
  }
}

export const createFlowLayer: CreateFlowLayer = (scene) => createFlowLayerWith(scene)
