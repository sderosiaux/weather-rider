// Low-poly buildings on each city's street grid (the same grid the ground shader paints), so a city reads
// as a city when the aircraft is low: towers downtown catching the low sun, mid-rises around them.
// One instanced box mesh per city, grown out of the ground as the camera approaches (no pop).
import * as THREE from 'three'
import type { Terrain, TerrainCity } from '../../core/types'
import { ATMOSPHERE_GLSL, type AtmosphereUniforms } from '../atmosphere'

/** Shared with shader.ts cityAlbedo(): street block size (m) and the downtown falloff. */
export const CITY_BLOCK = 120
export const downtownAt = (r: number): number => 1 - smoothstep(0.08, 0.45, r)
/** Lots per block side: big plots downtown, small ones elsewhere (decided at the block centre). */
export const lotsPerBlock = (downtown: number): readonly [number, number] => (downtown > 0.5 ? [2, 2] : [4, 3])
/** Buildings only where the city is dense enough to matter from the air. */
const MIN_DOWNTOWN = 0.12
/** Horizontal camera distance (m) over which buildings rise from the ground. */
const GROW_FAR = 32_000
const GROW_NEAR = 22_000
const STRIDE = 8

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/** Same integer hash as the ground shader (pcg), so parks and lots agree between ground and buildings. */
function pcg(v: number): number {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0
  return ((w >>> 22) ^ w) >>> 0
}
export function cellHash(x: number, y: number): number {
  const ux = (Math.floor(x) + (1 << 20)) >>> 0
  const uy = (Math.floor(y) + (1 << 20)) >>> 0
  return (pcg((ux ^ pcg(uy)) >>> 0) >>> 8) / 16777216
}

/**
 * Buildings of one city: x, ground y, z, grid angle, width, depth, height, shade per instance.
 * Pure in (terrain, city, angle).
 */
export function layoutBuildings(terrain: Terrain, city: TerrainCity, angle: number): Float32Array {
  const out: number[] = []
  const c = Math.cos(angle), s = Math.sin(angle)
  const reach = Math.ceil((city.radius * 0.5) / CITY_BLOCK)
  for (let by = -reach; by < reach; by++) {
    for (let bx = -reach; bx < reach; bx++) {
      const r = Math.hypot((bx + 0.5) * CITY_BLOCK, (by + 0.5) * CITY_BLOCK) / city.radius
      const downtown = downtownAt(r)
      if (downtown < MIN_DOWNTOWN) continue
      // Parks: same test as the shader's cityAlbedo (block hash offset by the city position).
      if (cellHash(bx + city.center.x * 0.01, by + city.center.z * 0.01) < 0.06 && downtown < 0.9) continue
      const [nx, ny] = lotsPerBlock(downtown)
      const lw = CITY_BLOCK / nx, ld = CITY_BLOCK / ny
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          // Lot centre in grid space → world (inverse of the shader's q = R(angle)·(p − centre)).
          const qx = bx * CITY_BLOCK + (i + 0.5) * lw
          const qz = by * CITY_BLOCK + (j + 0.5) * ld
          const x = city.center.x + c * qx + s * qz
          const z = city.center.z - s * qx + c * qz
          if (terrain.coverAt(x, z) !== 'city') continue
          const h1 = cellHash(bx * 7 + i + 17, by * 7 + j + 17)
          const h2 = cellHash(bx * 13 + i * 3 + 5, by * 11 + j * 5 + 9)
          const dt = downtownAt(Math.hypot(qx, qz) / city.radius)
          const height = dt > 0.5 ? 28 + 170 * dt * dt * h2 * h2 : 8 + 26 * dt * h2
          const fw = dt > 0.5 ? 0.55 + 0.2 * h1 : 0.5 + 0.15 * h1
          out.push(x, terrain.heightAt(x, z), z, angle, lw * fw, ld * (fw + 0.05), height, h1)
        }
      }
    }
  }
  return new Float32Array(out)
}

export interface Buildings {
  readonly group: THREE.Group
  setTerrain(terrain: Terrain, angleOf: (city: TerrainCity) => number): void
  update(camera: THREE.Camera): void
  dispose(): void
}

export function createBuildings(atmosphere: AtmosphereUniforms): Buildings {
  const group = new THREE.Group()
  const box = new THREE.BoxGeometry(1, 1, 1)
  box.translate(0, 0.5, 0)
  const material = new THREE.ShaderMaterial({
    uniforms: { ...atmosphere, uGrow: { value: new THREE.Vector2(GROW_FAR, GROW_NEAR) } },
    vertexShader: /* glsl */ `
      uniform vec3 uCamPos;
      uniform vec2 uGrow;
      attribute vec4 iPos;   // x, ground y, z, angle
      attribute vec4 iSize;  // width, depth, height, shade
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vShade;
      varying float vUp;
      void main() {
        float grow = 1.0 - smoothstep(uGrow.y, uGrow.x, length(iPos.xz - uCamPos.xz));
        vec3 p = position * vec3(iSize.x, iSize.z * grow, iSize.y);
        float c = cos(iPos.w), s = sin(iPos.w);
        // Same rotation as the street grid: world = centre + R(−angle)·local.
        mat2 r = mat2(c, -s, s, c);
        vec2 xz = r * p.xz;
        // Sink a little so slopes never show the underside.
        vWorld = vec3(iPos.x + xz.x, iPos.y - 6.0 + p.y + 6.0 * step(0.01, position.y), iPos.z + xz.y);
        vec2 nxz = r * normal.xz;
        vNormal = vec3(nxz.x, normal.y, nxz.y);
        vShade = iSize.w;
        vUp = position.y * iSize.z;
        gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${ATMOSPHERE_GLSL}
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vShade;
      varying float vUp;
      void main() {
        vec3 n = normalize(vNormal);
        vec3 wall = mix(vec3(0.30, 0.28, 0.26), vec3(0.42, 0.38, 0.33), vShade);
        vec3 glass = vec3(0.08, 0.1, 0.13);
        vec3 albedo = n.y > 0.5 ? mix(vec3(0.24, 0.23, 0.22), vec3(0.34, 0.16, 0.1), step(0.7, vShade)) : mix(wall, glass, step(0.55, vShade) * 0.7);
        // Floors: faint bands while close enough to resolve them.
        float d = length(vWorld - uCamPos);
        albedo *= 1.0 - 0.18 * step(0.5, fract(vUp / 3.6)) * (1.0 - smoothstep(1500.0, 5000.0, d)) * (1.0 - step(0.5, n.y));
        // Darker at the foot: the street canyon.
        albedo *= 0.6 + 0.4 * smoothstep(0.0, 25.0, vUp);
        float sunLit = smoothstep(-0.2, 0.7, dot(n, uSunDir));
        vec3 ambient = mix(vec3(0.10, 0.12, 0.21), vec3(0.34, 0.41, 0.62), 0.5 + 0.5 * n.y);
        vec3 col = albedo * (ambient + uSunColor * sunLit * 0.8);
        // Glass facades facing the sun flare gold.
        vec3 v = normalize(vWorld - uCamPos);
        col += uSunColor * step(0.55, vShade) * (1.0 - step(0.5, n.y)) * pow(max(dot(reflect(v, n), uSunDir), 0.0), 24.0) * 1.2;
        vec3 tr = exp(-fogDepth(vWorld) * 0.7 * vec3(0.85, 1.0, 1.2));
        col = col * tr + skyColor(v) * (1.0 - tr);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  })

  interface CityMesh { readonly mesh: THREE.Mesh; readonly geometry: THREE.InstancedBufferGeometry; readonly x: number; readonly z: number }
  let meshes: CityMesh[] = []

  const clear = (): void => {
    for (const m of meshes) {
      group.remove(m.mesh)
      m.geometry.dispose()
    }
    meshes = []
  }

  return {
    group,
    setTerrain(terrain, angleOf) {
      clear()
      for (const city of terrain.cities) {
        const data = layoutBuildings(terrain, city, angleOf(city))
        const count = data.length / STRIDE
        if (count === 0) continue
        const geometry = new THREE.InstancedBufferGeometry()
        geometry.index = box.index
        geometry.setAttribute('position', box.getAttribute('position'))
        geometry.setAttribute('normal', box.getAttribute('normal'))
        const buf = new THREE.InstancedInterleavedBuffer(data, STRIDE)
        geometry.setAttribute('iPos', new THREE.InterleavedBufferAttribute(buf, 4, 0))
        geometry.setAttribute('iSize', new THREE.InterleavedBufferAttribute(buf, 4, 4))
        geometry.instanceCount = count
        const mesh = new THREE.Mesh(geometry, material)
        mesh.frustumCulled = false
        mesh.renderOrder = -890
        group.add(mesh)
        meshes.push({ mesh, geometry, x: city.center.x, z: city.center.z })
      }
    },
    update(camera) {
      for (const m of meshes) {
        m.mesh.visible = Math.hypot(camera.position.x - m.x, camera.position.z - m.z) < GROW_FAR + 6000
      }
    },
    dispose() {
      clear()
      box.dispose()
      material.dispose()
    },
  }
}
