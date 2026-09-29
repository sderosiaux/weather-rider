// Clouds as instanced camera-facing soft puffs. One draw call, per-vertex aerial perspective,
// per-fragment a single atlas fetch: cheap enough that overdraw of huge puffs is the only real cost.
import * as THREE from 'three'
import { ATMOSPHERE_GLSL, PALETTE, type AtmosphereUniforms } from '../atmosphere'
import { ATLAS_TILES } from '../textures'
import type { Puff } from './layout'

const STRIDE = 16
/** Flow particles reach 9 km (src/flow FAR_DISTANCE); cores beyond that never need to occlude them. */
const DEPTH_RANGE = 10_000

export interface CloudLayer {
  readonly mesh: THREE.Mesh
  /**
   * Depth-only twin for the main scene: writes the depth of dense cloud cores near the camera so
   * later transparents (flow particles, trails) are hidden behind clouds. Colour comes from `mesh`.
   */
  readonly depthMesh: THREE.Mesh
  setPuffs(puffs: readonly Puff[]): void
  /** Back-to-front sort and cull behind the camera. Call once per frame before rendering. */
  sort(camera: THREE.Camera): void
  dispose(): void
}

export function createCloudLayer(atmosphere: AtmosphereUniforms, atlas: THREE.Texture): CloudLayer {
  const quad = new THREE.PlaneGeometry(1, 1)
  const geometry = new THREE.InstancedBufferGeometry()
  geometry.index = quad.index
  geometry.setAttribute('position', quad.getAttribute('position'))
  geometry.setAttribute('uv', quad.getAttribute('uv'))

  let source = new Float32Array(0)
  let sorted = new Float32Array(0)
  let keys = new Float64Array(0)
  let count = 0
  let interleaved: THREE.InstancedInterleavedBuffer | null = null

  const material = new THREE.ShaderMaterial({
    uniforms: {
      ...atmosphere,
      uAtlas: { value: atlas },
      uShadowColor: { value: PALETTE.cloudShadow.clone() },
      uAmbient: { value: PALETTE.cloudAmbient.clone() },
      uDepthRange: { value: DEPTH_RANGE },
    },
    vertexShader: /* glsl */ `
      ${ATMOSPHERE_GLSL}
      attribute vec4 iPos;    // xyz, half width
      attribute vec4 iShape;  // half height, rotation, tile, opacity
      attribute vec4 iAxis;   // streak axis (0 = billboard), shade
      attribute vec4 iLight;  // dark, base, top, seed
      varying vec2 vUv;
      varying vec2 vTile;
      varying float vRot;
      varying vec3 vRight;
      varying vec3 vUp;
      varying vec3 vToCam;
      varying vec4 vLight;    // shade, dark, h, opacity
      varying vec3 vFogTr;
      varying vec3 vFogCol;
      varying float vPhase;
      varying vec3 vRel;
      varying float vEdge;
      uniform float uDepthRange;

      void main() {
        vec3 c = iPos.xyz;
        vec3 toCam = uCamPos - c;
        float camDist = length(toCam);
        toCam /= camDist;
        vec3 right;
        vec3 up;
        bool streak = dot(iAxis.xyz, iAxis.xyz) > 0.5;
        if (streak) {
          up = iAxis.xyz;
          right = cross(up, toCam);
          float l = length(right);
          right = l > 1e-3 ? right / l : vec3(0.0, 0.0, 1.0);
        } else {
          right = cross(vec3(0.0, 1.0, 0.0), toCam);
          float l = length(right);
          right = l > 1e-3 ? right / l : vec3(1.0, 0.0, 0.0);
          up = cross(toCam, right);
        }
        vec3 wp = c + right * position.x * 2.0 * iPos.w + up * position.y * 2.0 * iShape.x;
        // Pull the quad toward the viewer so it isn't sliced by the sea or by the camera near plane.
        wp += toCam * min(iPos.w, iShape.x) * 0.3;

        float tile = iShape.z;
        vTile = vec2(mod(tile, ${ATLAS_TILES}.0), floor(tile / ${ATLAS_TILES}.0)) / ${ATLAS_TILES}.0;
        vRot = iShape.y + (tile < 1.5 ? uTime * (fract(iLight.w * 7.13) - 0.5) * 0.02 : 0.0);
        vUv = uv;
        vRight = right;
        vUp = up;
        vToCam = toCam;
        float h = clamp((wp.y - iLight.y) / max(iLight.z - iLight.y, 1.0), 0.0, 1.0);

        // Fade puffs the camera is about to enter instead of letting them pop through the near plane.
        float radius = max(iPos.w, iShape.x);
        #ifdef DEPTH_ONLY
        // Depth is only needed where flow particles live: skip everything beyond the range.
        if (camDist - radius > uDepthRange) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        #endif
        float near = smoothstep(radius * 0.25, radius * 1.1, camDist);
        vLight = vec4(iAxis.w, iLight.x, h, iShape.w * near);

        vFogTr = fogTransmittance(wp);
        vFogCol = skyColor(normalize(wp - uCamPos));
        vPhase = dot(-toCam, uSunDir);
        vRel = wp - uCamPos;
        // Crisp silhouettes far away, soft up close (large near puffs otherwise read as hard discs).
        vEdge = mix(0.95, 0.55, smoothstep(4000.0, 20000.0, camDist));
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uAtlas;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uShadowColor;
      uniform vec3 uAmbient;
      uniform float uInCloud;
      varying vec2 vUv;
      varying vec2 vTile;
      varying float vRot;
      varying vec3 vRight;
      varying vec3 vUp;
      varying vec3 vToCam;
      varying vec4 vLight;
      varying vec3 vFogTr;
      varying vec3 vFogCol;
      varying float vPhase;
      varying vec3 vRel;
      varying float vEdge;
      uniform vec3 uCamPos;

      float hg(float mu, float g) {
        float g2 = g * g;
        return (1.0 - g2) / (4.0 * 3.14159 * pow(1.0 + g2 - 2.0 * g * mu, 1.5));
      }

      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        // Rotated quad corners would sample the neighbouring atlas tile: keep to the inscribed circle.
        if (dot(p, p) > 1.0) discard;
        float cs = cos(vRot), sn = sin(vRot);
        vec2 q = vec2(cs * p.x - sn * p.y, sn * p.x + cs * p.y);
        vec4 t = texture2D(uAtlas, vTile + (q * 0.5 + 0.5) / ${ATLAS_TILES}.0);
        // Firm silhouettes: big clouds must read as solid shapes against the sky, not haze.
        float density = smoothstep(0.02, vEdge, t.r);
        float alpha = density * vLight.w;
        if (alpha < 0.004) discard;
        #ifdef DEPTH_ONLY
        // Only dense cores occlude: soft edges keep showing what's behind them.
        if (alpha < 0.55) discard;
        gl_FragColor = vec4(0.0);
        return;
        #endif
        // No depth buffer in the cloud pass: occlude by the sea plane along the view ray instead.
        float dist = length(vRel);
        float dirY = vRel.y / dist;
        if (dirY < 0.0 && dist > uCamPos.y / -dirY) discard;

        // Soft pseudo-normal: only a hint of per-puff roundness. Cluster-level shade carries the volume,
        // otherwise every puff reads as its own bubble.
        vec2 g = (t.gb - 0.5) * 2.0;
        vec2 gr = vec2(cs * g.x + sn * g.y, -sn * g.x + cs * g.y);
        vec2 bulge = p * 0.12 + gr * 0.8;
        vec3 n = normalize(vRight * bulge.x + vUp * bulge.y + vToCam);

        float shade = vLight.x;
        float dark = vLight.y;
        float h = vLight.z;
        float lambert = dot(n, uSunDir) * 0.35 + 0.65;
        float sunVis = shade * lambert * (1.0 - 0.8 * dark);
        // Ambient: blue-violet in the belly, sky-lit on top.
        vec3 ambient = mix(uShadowColor * (1.0 - 0.5 * dark), uAmbient, smoothstep(0.0, 0.9, h) * (0.35 + 0.65 * shade));
        vec3 col = ambient + uSunColor * sunVis * 1.3;
        // Thin parts glow: light leaks through edges, strongest when looking toward the sun.
        float thin = 1.0 - smoothstep(0.05, 0.6, t.a);
        col += uSunColor * thin * hg(vPhase, 0.6) * 1.4 * shade * (1.0 - dark);

        col = col * vFogTr + vFogCol * (1.0 - vFogTr);
        gl_FragColor = vec4(col, alpha * (1.0 - 0.5 * uInCloud));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    // Rendered alone into a cleared target: accumulate premultiplied colour and proper coverage.
    blending: THREE.CustomBlending,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  mesh.renderOrder = 10

  const depthMaterial = new THREE.ShaderMaterial({
    uniforms: material.uniforms,
    vertexShader: material.vertexShader,
    fragmentShader: material.fragmentShader,
    defines: { DEPTH_ONLY: '' },
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
    transparent: true,
  })
  const depthMesh = new THREE.Mesh(geometry, depthMaterial)
  depthMesh.frustumCulled = false
  // After the cloud composite (10), before flow (12).
  depthMesh.renderOrder = 11

  const bind = (): void => {
    interleaved = new THREE.InstancedInterleavedBuffer(sorted, STRIDE)
    interleaved.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('iPos', new THREE.InterleavedBufferAttribute(interleaved, 4, 0))
    geometry.setAttribute('iShape', new THREE.InterleavedBufferAttribute(interleaved, 4, 4))
    geometry.setAttribute('iAxis', new THREE.InterleavedBufferAttribute(interleaved, 4, 8))
    geometry.setAttribute('iLight', new THREE.InterleavedBufferAttribute(interleaved, 4, 12))
    geometry.instanceCount = 0
  }

  const camPos = new THREE.Vector3()
  const camFwd = new THREE.Vector3()

  return {
    mesh,
    depthMesh,
    setPuffs(puffs) {
      // Sort keys carry the instance index in 16 bits.
      count = Math.min(puffs.length, 65_535)
      source = new Float32Array(Math.max(1, count) * STRIDE)
      sorted = new Float32Array(Math.max(1, count) * STRIDE)
      keys = new Float64Array(count)
      puffs.slice(0, count).forEach((p, i) => {
        source.set([p.x, p.y, p.z, p.sx, p.sy, p.rot, p.tile, p.opacity, p.ax, p.ay, p.az, p.shade, p.dark, p.base, p.top, (i * 0.618034) % 1], i * STRIDE)
      })
      // Geometry attributes changed size: drop the old GPU buffers.
      geometry.dispose()
      bind()
    },
    sort(camera) {
      if (!interleaved || count === 0) return
      camera.getWorldPosition(camPos)
      camera.getWorldDirection(camFwd)
      let visible = 0
      for (let i = 0; i < count; i++) {
        const o = i * STRIDE
        const dx = source[o]! - camPos.x, dy = source[o + 1]! - camPos.y, dz = source[o + 2]! - camPos.z
        const r = Math.max(source[o + 3]!, source[o + 4]!)
        if (dx * camFwd.x + dy * camFwd.y + dz * camFwd.z < -r) continue
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
        // Packed key: quantised distance in the high bits, index in the low 16 bits → native numeric sort.
        keys[visible++] = Math.min(Math.floor(dist * 0.5), 0x1fffffff) * 65536 + i
      }
      const view = keys.subarray(0, visible)
      view.sort()
      for (let k = 0; k < visible; k++) {
        const i = view[visible - 1 - k]! % 65536
        sorted.set(source.subarray(i * STRIDE, i * STRIDE + STRIDE), k * STRIDE)
      }
      interleaved.needsUpdate = true
      interleaved.clearUpdateRanges()
      interleaved.addUpdateRange(0, visible * STRIDE)
      geometry.instanceCount = visible
    },
    dispose() {
      geometry.dispose()
      quad.dispose()
      material.dispose()
      depthMaterial.dispose()
    },
  }
}
