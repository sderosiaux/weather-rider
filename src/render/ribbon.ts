// Camera-facing ribbons with a minimum on-screen width: contrails (age-driven width/fade) and ghost
// trails ("best routes stay visible as lines in the sky", tinted by the air they crossed).
import * as THREE from 'three'
import { ATMOSPHERE_GLSL, type AtmosphereUniforms } from './atmosphere'

export interface RibbonOptions {
  readonly color: THREE.Color
  readonly opacity: number
  /** World half width at birth (m). */
  readonly halfWidth: number
  /** Extra half width per second of age (contrail spreading). */
  readonly growth: number
  /** Seconds until fully faded (0 = never). */
  readonly life: number
  /** Minimum half width on screen (px). */
  readonly minPx: number
  /**
   * 0 = pure light added to the frame (a glowing thread), 1 = paint laid over it. Light vanishes on a
   * bright sky and on white clouds; paint keeps its hue there.
   */
  readonly ink: number
  /** How much aerial haze applies (1 = physical, lower = the line stays legible far away). */
  readonly haze: number
  /** Lit by the sun (contrail) vs self-luminous (trail). */
  readonly lit: boolean
  /** Distance (m) under which the ribbon fades out (so it never smears across the lens). */
  readonly nearFade: number
}

export interface Ribbon {
  readonly mesh: THREE.Mesh
  /** points: xyz triplets; stamps: per-point time (contrail birth time or ghost sample time). */
  set(points: Float32Array, stamps: Float32Array, count: number): void
  /**
   * Trails only, per point: linear rgb of the air crossed there, a = how strongly the air acted (0 = calm:
   * the ribbon keeps its own colour). Strong air widens the line and turns it from light into paint.
   */
  setTints(tints: Float32Array, count: number): void
  /** now: current time for age; head: ghost time to highlight (trails). */
  setTime(now: number, head: number): void
  setPixelAngle(radPerPx: number): void
  setOpacity(opacity: number): void
  dispose(): void
}

/** Trails: how much bolder (alpha, width) a segment gets where the air acted at full strength. */
const AIR_ALPHA = 2.2
const AIR_WIDEN = 1.0
const AIR_INK = 0.85

export function createRibbon(atmosphere: AtmosphereUniforms, capacity: number, opts: RibbonOptions): Ribbon {
  const geometry = new THREE.BufferGeometry()
  const pos = new Float32Array(capacity * 2 * 3)
  const other = new Float32Array(capacity * 2 * 3)
  const side = new Float32Array(capacity * 2)
  const stamp = new Float32Array(capacity * 2)
  const tint = new Float32Array(capacity * 2 * 4)
  for (let i = 0; i < capacity; i++) {
    side[i * 2] = -1
    side[i * 2 + 1] = 1
  }
  const index: number[] = []
  for (let i = 0; i + 1 < capacity; i++) {
    const a = i * 2
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
  }
  const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage)
  const otherAttr = new THREE.BufferAttribute(other, 3).setUsage(THREE.DynamicDrawUsage)
  const stampAttr = new THREE.BufferAttribute(stamp, 1).setUsage(THREE.DynamicDrawUsage)
  const tintAttr = new THREE.BufferAttribute(tint, 4)
  geometry.setAttribute('position', posAttr)
  geometry.setAttribute('aOther', otherAttr)
  geometry.setAttribute('aSide', new THREE.BufferAttribute(side, 1))
  geometry.setAttribute('aStamp', stampAttr)
  geometry.setAttribute('aTint', tintAttr)
  geometry.setIndex(index)
  geometry.setDrawRange(0, 0)

  const material = new THREE.ShaderMaterial({
    uniforms: {
      ...atmosphere,
      uColor: { value: opts.color.clone() },
      uOpacity: { value: opts.opacity },
      uHalfWidth: { value: opts.halfWidth },
      uGrowth: { value: opts.growth },
      uLife: { value: opts.life },
      uMinPx: { value: opts.minPx },
      uPixelAngle: { value: 0.0008 },
      uNow: { value: 0 },
      uHead: { value: 0 },
      uHaze: { value: opts.haze },
      uLit: { value: opts.lit ? 1 : 0 },
      uNearFade: { value: opts.nearFade },
      uInk: { value: opts.ink },
    },
    vertexShader: /* glsl */ `
      ${ATMOSPHERE_GLSL}
      attribute vec3 aOther;
      attribute float aSide;
      attribute float aStamp;
      attribute vec4 aTint;
      uniform float uHalfWidth;
      uniform float uGrowth;
      uniform float uLife;
      uniform float uMinPx;
      uniform float uPixelAngle;
      uniform float uNow;
      uniform float uHead;
      uniform float uOpacity;
      uniform float uHaze;
      uniform float uNearFade;
      varying float vSide;
      varying float vAlpha;
      varying vec3 vFogTr;
      varying vec3 vFogCol;
      varying float vHead;
      varying float vLight;
      varying vec4 vTint;
      void main() {
        vec3 p = position;
        vec3 toCam = uCamPos - p;
        float dist = length(toCam);
        vec3 tangent = aOther - p;
        float tl = length(tangent);
        tangent = tl > 1e-3 ? tangent / tl : vec3(1.0, 0.0, 0.0);
        vec3 across = cross(tangent, toCam / max(dist, 1e-3));
        float al = length(across);
        across = al > 1e-4 ? across / al : vec3(0.0, 1.0, 0.0);
        float age = max(uNow - aStamp, 0.0);
        float widen = 1.0 + ${AIR_WIDEN.toFixed(2)} * aTint.a;
        float hw = (uHalfWidth + uGrowth * age) * widen;
        float minHw = dist * uPixelAngle * uMinPx * widen;
        float w = max(hw, minHw);
        p += across * aSide * w;
        vSide = aSide;
        float fade = uLife > 0.0 ? 1.0 - smoothstep(uLife * 0.35, uLife, age) : 1.0;
        // Width forced up by the pixel floor must not add ink: keep coverage constant.
        float coverage = clamp(hw / w, 0.15, 1.0);
        float nearFade = smoothstep(uNearFade * 0.1, uNearFade, dist);
        vAlpha = uOpacity * fade * mix(coverage, 1.0, 0.5) * nearFade;
        vHead = exp(-abs(aStamp - uHead) * 0.08);
        vLight = 0.6 + 0.4 * max(dot(normalize(toCam), uSunDir) * -1.0, 0.0);
        vTint = aTint;
        vec3 tr = fogTransmittance(p);
        vFogTr = mix(vec3(1.0), tr, uHaze);
        vFogCol = skyColor(normalize(p - uCamPos));
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform vec3 uSunColor;
      uniform vec3 uContrailShade;
      uniform float uLit;
      uniform float uInk;
      varying float vSide;
      varying float vAlpha;
      varying vec3 vFogTr;
      varying vec3 vFogCol;
      varying float vHead;
      varying float vLight;
      varying vec4 vTint;
      void main() {
        float profile = 1.0 - vSide * vSide;
        profile *= profile;
        vec3 col;
        float a;
        float ink = uInk;
        if (uLit > 0.5) {
          col = uColor * mix(uContrailShade, uSunColor * 0.7, vLight);
          col = col * vFogTr + vFogCol * (1.0 - vFogTr);
          a = vAlpha * profile;
        } else {
          // Self-luminous: haze only fades it (it has no colour of its own to hand to the sky).
          col = mix(uColor, vTint.rgb, vTint.a) * (1.0 + 0.8 * vHead) * vFogTr;
          a = vAlpha * profile * (0.55 + 0.45 * vHead) * mix(1.0, ${AIR_ALPHA.toFixed(2)}, vTint.a) * dot(vFogTr, vec3(0.333));
          ink = mix(uInk, ${AIR_INK.toFixed(2)}, vTint.a);
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        // Premultiplied: rgb·a is always added, ink decides how much of the frame behind it is covered.
        a = min(a, 1.0);
        gl_FragColor = vec4(gl_FragColor.rgb * a, a * ink);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    // Trails speak the wind-particle colour language (flow draws untonemapped): same hues on screen.
    toneMapped: opts.lit,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  mesh.renderOrder = opts.lit ? 20 : 30

  return {
    mesh,
    set(points, stamps, count) {
      const n = Math.min(count, capacity)
      for (let i = 0; i < n; i++) {
        const j = i + 1 < n ? i + 1 : i - 1
        const flip = i + 1 < n ? 1 : -1
        for (let s = 0; s < 2; s++) {
          const v = (i * 2 + s) * 3
          pos[v] = points[i * 3]!
          pos[v + 1] = points[i * 3 + 1]!
          pos[v + 2] = points[i * 3 + 2]!
          if (j < 0) {
            other[v] = pos[v]! + 1
            other[v + 1] = pos[v + 1]!
            other[v + 2] = pos[v + 2]!
          } else {
            // Last point mirrors its predecessor so the tangent keeps pointing forward.
            other[v] = pos[v]! + (points[j * 3]! - pos[v]!) * flip
            other[v + 1] = pos[v + 1]! + (points[j * 3 + 1]! - pos[v + 1]!) * flip
            other[v + 2] = pos[v + 2]! + (points[j * 3 + 2]! - pos[v + 2]!) * flip
          }
          stamp[i * 2 + s] = stamps[i]!
        }
      }
      posAttr.needsUpdate = true
      otherAttr.needsUpdate = true
      stampAttr.needsUpdate = true
      geometry.setDrawRange(0, Math.max(0, n - 1) * 6)
    },
    setTints(tints, count) {
      const n = Math.min(count, capacity)
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < 4; c++) tint[i * 8 + c] = tint[i * 8 + 4 + c] = tints[i * 4 + c]!
      }
      tint.fill(0, n * 8)
      tintAttr.needsUpdate = true
    },
    setTime(now, head) {
      material.uniforms.uNow!.value = now
      material.uniforms.uHead!.value = head
    },
    setOpacity(o) {
      material.uniforms.uOpacity!.value = o
    },
    setPixelAngle(a) {
      material.uniforms.uPixelAngle!.value = a
    },
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}
