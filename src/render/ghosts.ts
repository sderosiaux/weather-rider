// Ghosts: translucent glowing airframes + optional full-route trail line, tinted by the air the ghost
// flew through so its decisions read from the chase view (SPEC §7).
import * as THREE from 'three'
import type { GhostVisual } from '../core/presentation'
import type { GhostSample, WeatherField } from '../core/types'
import { ATMOSPHERE_GLSL, type AtmosphereUniforms } from './atmosphere'
import { buildAircraft } from './aircraft/models'
import { createRibbon, type Ribbon } from './ribbon'
import { airTints } from './trailAir'

/** Trail keeps one ghost sample in TRAIL_STRIDE (10 Hz → 2 Hz, ~75 m spacing at cruise). */
const TRAIL_STRIDE = 5
/** Calm stretches of a trail: the ghost's colour washed toward white, so the air's hues own the saturation. */
const CALM_WASH = 0.45

interface Trail {
  readonly ribbon: Ribbon
  readonly points: Float32Array
  readonly stamps: Float32Array
  readonly count: number
}

interface GhostEntry {
  readonly root: THREE.Group
  readonly body: THREE.Mesh
  readonly material: THREE.ShaderMaterial
  readonly beacon: THREE.Points
  readonly beaconMat: THREE.PointsMaterial
  readonly beaconGeo: THREE.BufferGeometry
  readonly trail: Trail | null
}

export interface GhostLayer {
  readonly group: THREE.Group
  /** weather: the field the trails are read against (null = not known yet: calm trails until setWeather). */
  set(ghosts: readonly GhostVisual[], weather: WeatherField | null): void
  setWeather(weather: WeatherField): void
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
        group.remove(e.trail.ribbon.mesh)
        e.trail.ribbon.dispose()
      }
    }
    entries = []
    for (const g of airframes.values()) g.dispose()
    airframes = new Map()
  }

  const tint = (trail: Trail, weather: WeatherField | null): void => {
    trail.ribbon.setTints(weather ? airTints(trail.points, trail.stamps, trail.count, weather) : new Float32Array(trail.count * 4), trail.count)
  }

  return {
    group,
    set(ghosts, weather) {
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

        let trail: Trail | null = null
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
          const calm = color.clone().lerp(new THREE.Color(1, 1, 1), CALM_WASH)
          const ribbon = createRibbon(atmosphere, n, {
            color: calm, opacity: 0.4, halfWidth: 2, growth: 0, life: 0, minPx: 1.1, ink: 0.15, haze: 0.55, lit: false, nearFade: 2500,
          })
          ribbon.set(pts, stamps, k)
          ribbon.setPixelAngle(pixelAngle)
          group.add(ribbon.mesh)
          trail = { ribbon, points: pts, stamps, count: k }
          tint(trail, weather)
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
        e.trail?.ribbon.setTime(p.t, p.t)
      })
    },
    setWeather(weather) {
      for (const e of entries) if (e.trail) tint(e.trail, weather)
    },
    setPixelAngle(a) {
      pixelAngle = a
      for (const e of entries) e.trail?.ribbon.setPixelAngle(a)
    },
    dispose() {
      clear()
    },
  }
}
