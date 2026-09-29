// Ghosts: translucent glowing airframes + optional full-route trail line.
import * as THREE from 'three'
import type { GhostVisual } from '../core/presentation'
import type { GhostSample } from '../core/types'
import { ATMOSPHERE_GLSL, type AtmosphereUniforms } from './atmosphere'
import { buildAircraft } from './aircraft/models'
import { createRibbon, type Ribbon } from './ribbon'

/** Trail keeps one ghost sample in TRAIL_STRIDE (10 Hz → 2 Hz, ~75 m spacing at cruise). */
const TRAIL_STRIDE = 5

interface GhostEntry {
  readonly root: THREE.Group
  readonly body: THREE.Mesh
  readonly material: THREE.ShaderMaterial
  readonly beacon: THREE.Points
  readonly beaconMat: THREE.PointsMaterial
  readonly beaconGeo: THREE.BufferGeometry
  readonly trail: Ribbon | null
}

export interface GhostLayer {
  readonly group: THREE.Group
  set(ghosts: readonly GhostVisual[]): void
  update(poses: readonly GhostSample[]): void
  setPixelAngle(a: number): void
  dispose(): void
}

function ghostMaterial(atmosphere: AtmosphereUniforms, color: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...atmosphere, uColor: { value: color } },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      ${ATMOSPHERE_GLSL}
      uniform vec3 uColor;
      varying vec3 vNormal;
      varying vec3 vWorld;
      void main() {
        vec3 v = normalize(uCamPos - vWorld);
        float rim = pow(1.0 - abs(dot(normalize(vNormal), v)), 2.0);
        vec3 tr = fogTransmittance(vWorld);
        float a = (0.12 + 0.8 * rim) * mix(1.0, dot(tr, vec3(0.333)), 0.6);
        gl_FragColor = vec4(uColor * (0.35 + 1.1 * rim), a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  })
}

export function createGhostLayer(atmosphere: AtmosphereUniforms, glow: THREE.Texture): GhostLayer {
  const group = new THREE.Group()
  let entries: GhostEntry[] = []
  let pixelAngle = 0.0008
  /** Airframes built for the current ghost set, shared per class and size. */
  let airframes = new Map<string, THREE.BufferGeometry>()

  const clear = (): void => {
    for (const e of entries) {
      group.remove(e.root)
      e.material.dispose()
      e.beaconMat.dispose()
      e.beaconGeo.dispose()
      if (e.trail) {
        group.remove(e.trail.mesh)
        e.trail.dispose()
      }
    }
    entries = []
    for (const g of airframes.values()) g.dispose()
    airframes = new Map()
  }

  return {
    group,
    set(ghosts) {
      clear()
      entries = ghosts.map((g) => {
        const key = `${g.spec.class}:${g.spec.lengthM}`
        let airframe = airframes.get(key)
        if (!airframe) {
          airframe = buildAircraft(g.spec.class, g.spec.lengthM, '#ffffff').geometry
          airframes.set(key, airframe)
        }
        const color = new THREE.Color(g.color)
        const root = new THREE.Group()
        const material = ghostMaterial(atmosphere, color)
        const body = new THREE.Mesh(airframe, material)
        body.renderOrder = 35
        root.add(body)
        const beaconGeo = new THREE.BufferGeometry()
        beaconGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3))
        // Findable from far away: a soft glow that ignores the tiny real-scale airframe.
        const beaconMat = new THREE.PointsMaterial({ size: 22, sizeAttenuation: false, map: glow, color: color.clone().multiplyScalar(0.9), transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending })
        const beacon = new THREE.Points(beaconGeo, beaconMat)
        beacon.frustumCulled = false
        beacon.renderOrder = 36
        root.add(beacon)
        group.add(root)

        let trail: Ribbon | null = null
        if (g.showTrail && g.ghost.samples.length > 1) {
          const samples = g.ghost.samples
          const n = Math.ceil(samples.length / TRAIL_STRIDE) + 1
          const pts = new Float32Array(n * 3)
          const stamps = new Float32Array(n)
          let k = 0
          for (let i = 0; i < samples.length; i += TRAIL_STRIDE) {
            const s = samples[i]!
            pts.set([s.pos.x, s.pos.y, s.pos.z], k * 3)
            stamps[k++] = s.t
          }
          const last = samples[samples.length - 1]!
          if ((samples.length - 1) % TRAIL_STRIDE !== 0) {
            pts.set([last.pos.x, last.pos.y, last.pos.z], k * 3)
            stamps[k++] = last.t
          }
          trail = createRibbon(atmosphere, n, {
            color, opacity: 0.4, halfWidth: 2, growth: 0, life: 0, minPx: 1.1, additive: true, haze: 0.55, lit: false, nearFade: 2500,
          })
          trail.set(pts, stamps, k)
          trail.setPixelAngle(pixelAngle)
          group.add(trail.mesh)
        }
        return { root, body, material, beacon, beaconMat, beaconGeo, trail }
      })
    },
    update(poses) {
      entries.forEach((e, i) => {
        const p = poses[i]
        e.root.visible = !!p
        if (!p) return
        e.root.position.set(p.pos.x, p.pos.y, p.pos.z)
        e.root.quaternion.set(p.orientation.x, p.orientation.y, p.orientation.z, p.orientation.w)
        e.trail?.setTime(p.t, p.t)
      })
    },
    setPixelAngle(a) {
      pixelAngle = a
      for (const e of entries) e.trail?.setPixelAngle(a)
    },
    dispose() {
      clear()
    },
  }
}
