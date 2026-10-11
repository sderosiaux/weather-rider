// The land under the route: CDLOD patches displaced from a camera-centred texture clipmap.
// setTerrain() is cheap; the first update() bakes the coarsest level in one go (the horizon is never
// empty), finer levels fill in over the next frames inside a per-frame CPU budget, nearest blocks first.
import * as THREE from 'three'
import type { Terrain, TerrainCity } from '../../core/types'
import { PALETTE, type AtmosphereUniforms } from '../atmosphere'
import { createBuildings } from './buildings'
import { bakeBlock, BLOCK, createLevel, missingBlocks, resetLevel, validRect, type BlockTask, type ClipLevel, type LevelSpec, type Rect } from './clipmap'
import { PATCH_GRID, PATCH_STRIDE, selectPatches, type LodConfig } from './quadtree'
import { MAX_CITIES, MAX_GROUND_SHADOWS, terrainDistanceFragmentShader, terrainFragmentShader, terrainVertexShader } from './shader'

/**
 * Fine to coarse. Half-extents ≈ 12, 37, 147 and 295 km around the camera: from cruise altitude most of
 * the visible ground (5–40 km away) is in the two fine levels, whose cover is supersampled.
 */
export const LEVELS: readonly LevelSpec[] = [
  { texel: 24, size: 1024, coverSamples: 2 },
  { texel: 72, size: 1024, coverSamples: 2 },
  { texel: 288, size: 1024, coverSamples: 1 },
  { texel: 1152, size: 512, coverSamples: 1 },
]
/** Vertex spacing near the camera matches the finest texel; the top level spans ~400 km. */
const LOD: LodConfig = { leafSize: LEVELS[0]!.texel * PATCH_GRID, levels: 10 }
const MAX_PATCHES = 3000
/** CPU time per frame for baking new blocks once the coarsest level exists. */
const BAKE_BUDGET_MS = 3
/** Share of the window used to cross-fade a level into the next coarser one. */
const FADE_FRACTION = 0.08
/** Displayed rect edges glide to newly baked extents instead of popping (per-frame lerp). */
const RECT_GROWTH = 0.08

export interface TerrainLayer {
  /** Ground in the main scene. */
  readonly mesh: THREE.Mesh
  /** The same ground writing camera distance (km): the cloud pass's soft occluder. */
  readonly distanceMesh: THREE.Mesh
  /** City buildings, main scene. */
  readonly buildings: THREE.Group
  setTerrain(terrain: Terrain): void
  /** Soft cloud shadow discs (x, z, radius, strength). */
  setShadows(discs: readonly (readonly [number, number, number, number])[]): void
  /** Bake within budget, select LOD patches for this camera, refresh uniforms. Call once per frame. */
  update(camera: THREE.PerspectiveCamera): void
  readonly hasTerrain: boolean
  dispose(): void
}

/** Same terrain (it is a pure function of its params): no need to throw away what is baked. */
function terrainKey(t: Terrain): string {
  const c = t.cities.map((k) => `${k.id}:${k.center.x}:${k.center.z}:${k.radius}`).join('|')
  return `${t.seed}/${t.boundsMin.x},${t.boundsMin.z},${t.boundsMax.x},${t.boundsMax.z}/${t.maxHeight}/${c}`
}

/** Deterministic street-grid orientation of a city (shared by the ground shader and the buildings). */
export function cityGridAngle(city: TerrainCity): number {
  let h = 2166136261
  for (let i = 0; i < city.id.length; i++) h = Math.imul(h ^ city.id.charCodeAt(i), 16777619)
  return ((h >>> 0) / 4294967296) * (Math.PI / 2)
}

function createPatchGeometry(): THREE.InstancedBufferGeometry {
  const n = PATCH_GRID
  const positions = new Float32Array((n + 1) * (n + 1) * 3)
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) positions.set([i, 0, j], (j * (n + 1) + i) * 3)
  const index: number[] = []
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1
      // Alternate the diagonal so morphing stays symmetric.
      if ((i + j) % 2 === 0) index.push(a, c, b, b, c, d)
      else index.push(a, c, d, a, d, b)
    }
  }
  const geometry = new THREE.InstancedBufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(index)
  return geometry
}

function createLevelTexture(data: Uint16Array | Uint8Array, size: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, data instanceof Uint16Array ? THREE.HalfFloatType : THREE.UnsignedByteType)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearFilter
  tex.generateMipmaps = false
  tex.colorSpace = THREE.NoColorSpace
  tex.needsUpdate = true
  return tex
}

export function createTerrainLayer(atmosphere: AtmosphereUniforms, noise: THREE.Texture): TerrainLayer {
  const levels: ClipLevel[] = LEVELS.map(createLevel)
  const t0 = levels.map((l) => createLevelTexture(l.t0, l.size))
  const t1 = levels.map((l) => createLevelTexture(l.t1, l.size))
  const shown: Rect[] = levels.map(() => ({ minX: 0, minZ: 0, maxX: -1, maxZ: -1 }))
  const valid: Rect = { minX: 0, minZ: 0, maxX: -1, maxZ: -1 }

  const geometry = createPatchGeometry()
  const patches = new Float32Array(MAX_PATCHES * PATCH_STRIDE)
  const instances = new THREE.InstancedInterleavedBuffer(patches, PATCH_STRIDE)
  instances.setUsage(THREE.DynamicDrawUsage)
  geometry.setAttribute('iPatch', new THREE.InterleavedBufferAttribute(instances, 4, 0))
  geometry.setAttribute('iMorphEnd', new THREE.InterleavedBufferAttribute(instances, 1, 4))
  geometry.instanceCount = 0

  const shadows = Array.from({ length: MAX_GROUND_SHADOWS }, () => new THREE.Vector4())
  const cities = Array.from({ length: MAX_CITIES }, () => new THREE.Vector4())
  const levelUniforms: Record<string, THREE.IUniform> = {}
  levels.forEach((_, i) => {
    levelUniforms[`uT0_${i}`] = { value: t0[i] }
    levelUniforms[`uT1_${i}`] = { value: t1[i] }
  })
  const uLev = levels.map((l) => new THREE.Vector4(1 / (l.texel * l.size), l.texel, l.texel * l.size * FADE_FRACTION, 1 / l.size))
  const uRect = levels.map(() => new THREE.Vector4(0, 0, -1, -1))
  const shared = {
    ...levelUniforms,
    uLev: { value: uLev },
    uRect: { value: uRect },
    uDy: { value: 0 },
  }
  const vertexShader = terrainVertexShader(levels.length)
  const material = new THREE.ShaderMaterial({
    uniforms: {
      ...atmosphere,
      ...shared,
      uNoise: { value: noise },
      uDeep: { value: PALETTE.seaDeep.clone() },
      uShadows: { value: shadows },
      uShadowCount: { value: 0 },
      uCities: { value: cities },
      uCityCount: { value: 0 },
    },
    vertexShader,
    fragmentShader: terrainFragmentShader(levels.length),
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  // Opaque and big: drawn right after the sky so everything in front of it benefits from early depth.
  mesh.renderOrder = -900
  mesh.visible = false

  const distanceMaterial = new THREE.ShaderMaterial({
    uniforms: { uCamPos: atmosphere.uCamPos, ...shared },
    vertexShader,
    fragmentShader: terrainDistanceFragmentShader,
  })
  const distanceMesh = new THREE.Mesh(geometry, distanceMaterial)
  distanceMesh.frustumCulled = false
  distanceMesh.visible = false

  const buildings = createBuildings(atmosphere)
  let terrain: Terrain | null = null
  let key = ''
  let needsHorizon = false
  let groundTop = 0
  const tasks: BlockTask[] = []
  const frustum = new THREE.Frustum()
  const projView = new THREE.Matrix4()
  const box = new THREE.Box3()

  const upload = (i: number, sx: number, sz: number): void => {
    const size = levels[i]!.size
    for (let j = 0; j < BLOCK; j++) {
      const start = ((sz + j) * size + sx) * 4
      t0[i]!.addUpdateRange(start, BLOCK * 4)
      t1[i]!.addUpdateRange(start, BLOCK * 4)
    }
    t0[i]!.needsUpdate = true
    t1[i]!.needsUpdate = true
  }

  const bake = (task: BlockTask): void => {
    const r = bakeBlock(levels[task.level]!, terrain!, task.bx, task.bz)
    groundTop = Math.max(groundTop, r.maxHeight)
    upload(task.level, r.sx, r.sz)
  }

  const bakeWithinBudget = (camX: number, camZ: number): void => {
    const coarsest = levels.length - 1
    if (needsHorizon) {
      // The whole coarsest window now: the horizon must be land and coast from the first frame.
      tasks.length = 0
      missingBlocks(levels[coarsest]!, coarsest, camX, camZ, tasks)
      for (const t of tasks) bake(t)
      needsHorizon = false
    }
    tasks.length = 0
    levels.forEach((l, i) => missingBlocks(l, i, camX, camZ, tasks))
    if (tasks.length === 0) return
    // Nearest ring first, coarse before fine at equal ring: each level grows outward from the camera.
    tasks.sort((a, b) => a.ring - b.ring || b.level - a.level)
    const t0ms = performance.now()
    for (const t of tasks) {
      bake(t)
      if (performance.now() - t0ms > BAKE_BUDGET_MS) break
    }
  }

  const visible = (minX: number, minZ: number, size: number): boolean => {
    box.min.set(minX, -10, minZ)
    box.max.set(minX + size, groundTop + 50, minZ + size)
    return frustum.intersectsBox(box)
  }

  return {
    mesh,
    distanceMesh,
    buildings: buildings.group,
    get hasTerrain() {
      return terrain !== null
    },
    setTerrain(next) {
      const nextKey = terrainKey(next)
      terrain = next
      mesh.visible = distanceMesh.visible = true
      if (nextKey === key) return
      key = nextKey
      levels.forEach(resetLevel)
      for (const r of shown) {
        r.minX = r.minZ = 0
        r.maxX = r.maxZ = -1
      }
      groundTop = Math.max(0, next.maxHeight)
      needsHorizon = true
      const n = Math.min(next.cities.length, MAX_CITIES)
      for (let i = 0; i < n; i++) {
        const c = next.cities[i]!
        cities[i]!.set(c.center.x, c.center.z, c.radius, cityGridAngle(c))
      }
      material.uniforms.uCityCount!.value = n
      buildings.setTerrain(next, cityGridAngle)
    },
    setShadows(discs) {
      const n = Math.min(discs.length, MAX_GROUND_SHADOWS)
      for (let i = 0; i < n; i++) {
        const d = discs[i]!
        shadows[i]!.set(d[0], d[1], d[2], d[3])
      }
      material.uniforms.uShadowCount!.value = n
    },
    update(camera) {
      if (!terrain) return
      const cx = camera.position.x, cz = camera.position.z
      bakeWithinBudget(cx, cz)
      buildings.update(camera)

      levels.forEach((l, i) => {
        validRect(l, cx, cz, valid)
        const s = shown[i]!
        const empty = s.minX >= s.maxX
        if (valid.minX >= valid.maxX) {
          s.minX = s.minZ = 0
          s.maxX = s.maxZ = -1
        } else if (empty) {
          // First appearance: start from the camera block and grow.
          s.minX = Math.max(valid.minX, cx - l.texel * BLOCK)
          s.maxX = Math.min(valid.maxX, cx + l.texel * BLOCK)
          s.minZ = Math.max(valid.minZ, cz - l.texel * BLOCK)
          s.maxZ = Math.min(valid.maxZ, cz + l.texel * BLOCK)
        } else {
          // Shrink at once (that data is gone), grow smoothly (no pop at the level's edge).
          s.minX = valid.minX > s.minX ? valid.minX : s.minX + (valid.minX - s.minX) * RECT_GROWTH
          s.minZ = valid.minZ > s.minZ ? valid.minZ : s.minZ + (valid.minZ - s.minZ) * RECT_GROWTH
          s.maxX = valid.maxX < s.maxX ? valid.maxX : s.maxX + (valid.maxX - s.maxX) * RECT_GROWTH
          s.maxZ = valid.maxZ < s.maxZ ? valid.maxZ : s.maxZ + (valid.maxZ - s.maxZ) * RECT_GROWTH
        }
        uRect[i]!.set(s.minX, s.minZ, s.maxX, s.maxZ)
      })

      const dy = Math.max(0, camera.position.y - groundTop)
      shared.uDy.value = dy
      camera.updateMatrixWorld()
      projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      frustum.setFromProjectionMatrix(projView, camera.coordinateSystem, camera.reversedDepth)
      const count = selectPatches(LOD, cx, cz, dy, visible, patches)
      instances.clearUpdateRanges()
      instances.addUpdateRange(0, count * PATCH_STRIDE)
      instances.needsUpdate = true
      geometry.instanceCount = count
    },
    dispose() {
      geometry.dispose()
      material.dispose()
      distanceMaterial.dispose()
      buildings.dispose()
      for (const t of [...t0, ...t1]) t.dispose()
    },
  }
}
