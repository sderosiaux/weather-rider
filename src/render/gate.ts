// Arrival gate: a luminous curtain of light whose bright band is the altitude window, fading into a
// faint pillar above and below; plus a sparse dotted corridor hint from start to gate.
import * as THREE from 'three'
import type { Route } from '../core/types'
import { ATMOSPHERE_GLSL, type AtmosphereUniforms } from './atmosphere'

export interface GateLayer {
  readonly group: THREE.Group
  set(route: Route): void
  dispose(): void
}

const GATE_COLOR = new THREE.Color(0.55, 0.95, 1.0)
const PILLAR_TOP = 14_000

export function createGateLayer(atmosphere: AtmosphereUniforms, glow: THREE.Texture): GateLayer {
  const group = new THREE.Group()
  const curtainMat = new THREE.ShaderMaterial({
    uniforms: {
      ...atmosphere,
      uColor: { value: GATE_COLOR.clone() },
      uWindow: { value: new THREE.Vector2(0, 1) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vAngle;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vAngle = atan(position.z, position.x);
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      ${ATMOSPHERE_GLSL}
      uniform vec3 uColor;
      uniform vec2 uWindow;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vAngle;
      void main() {
        vec3 toCam = uCamPos - vWorld;
        float dist = length(toCam);
        vec3 v = toCam / dist;
        // A filled column of light: brightest through its middle, dissolving at the silhouette.
        float facing = pow(abs(dot(normalize(vNormal), v)), 1.5);
        float y = vWorld.y;
        float inWindow = smoothstep(uWindow.x, uWindow.x + 300.0, y) * (1.0 - smoothstep(uWindow.y - 300.0, uWindow.y, y));
        // Window rims stay ~2 px wide at any distance.
        float lw = max(60.0, dist * 0.0015);
        float lip = exp(-pow((y - uWindow.x) / lw, 2.0)) + exp(-pow((y - uWindow.y) / lw, 2.0));
        float pillar = exp(-max(uWindow.x - y, 0.0) / 1500.0) * exp(-max(y - uWindow.y, 0.0) / 3000.0);
        float rays = 0.9 + 0.1 * sin(vAngle * 23.0 + y * 0.0015 - uTime * 0.4) * sin(vAngle * 9.0 - uTime * 0.15);
        float a = facing * (0.006 * pillar + 0.022 * inWindow) * rays + lip * 0.3 * (0.3 + facing);
        vec3 tr = fogTransmittance(vWorld);
        // Beacons must stay legible across the whole route: only part of the haze applies.
        float vis = mix(1.0, dot(tr, vec3(0.333)), 0.55);
        gl_FragColor = vec4(uColor * a * vis, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  })
  let curtain: THREE.Mesh | null = null
  const corridorGeo = new THREE.BufferGeometry()
  const corridorMat = new THREE.PointsMaterial({ size: 90, sizeAttenuation: true, map: glow, color: GATE_COLOR.clone().multiplyScalar(0.6), transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending })
  const corridor = new THREE.Points(corridorGeo, corridorMat)
  corridor.frustumCulled = false
  corridor.renderOrder = 31
  group.add(corridor)

  return {
    group,
    set(route) {
      if (curtain) {
        group.remove(curtain)
        curtain.geometry.dispose()
      }
      const height = PILLAR_TOP
      const geo = new THREE.CylinderGeometry(route.gateRadius, route.gateRadius, height, 128, 64, true)
      geo.translate(0, height / 2, 0)
      curtain = new THREE.Mesh(geo, curtainMat)
      curtain.position.set(route.gate.x, 0, route.gate.z)
      curtain.frustumCulled = false
      curtain.renderOrder = 32
      group.add(curtain)
      curtainMat.uniforms.uWindow!.value.set(route.gateMinAlt, route.gateMaxAlt)

      // Corridor: motes every 4 km on the straight line, easing into the middle of the gate window.
      const pts: number[] = []
      const dx = route.gate.x - route.start.x
      const dz = route.gate.z - route.start.z
      const len = Math.hypot(dx, dz)
      const midAlt = (route.gateMinAlt + route.gateMaxAlt) / 2
      for (let d = 4000; d < len - route.gateRadius; d += 4000) {
        const t = d / len
        pts.push(route.start.x + dx * t, route.start.y + (midAlt - route.start.y) * t * t * (3 - 2 * t), route.start.z + dz * t)
      }
      corridorGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
      corridorGeo.computeBoundingSphere()
    },
    dispose() {
      curtain?.geometry.dispose()
      curtainMat.dispose()
      corridorGeo.dispose()
      corridorMat.dispose()
    },
  }
}
