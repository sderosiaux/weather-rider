// Sea far below: the altitude reference. Sky reflection + sun glitter path + cloud shadows, then aerial haze.
import * as THREE from 'three'
import { ATMOSPHERE_GLSL, PALETTE, type AtmosphereUniforms } from './atmosphere'

export const MAX_SEA_SHADOWS = 32

export interface Sea {
  readonly mesh: THREE.Mesh
  /** Soft shadow discs (x, z, radius, strength) under big clouds. */
  setShadows(discs: readonly (readonly [number, number, number, number])[]): void
  /** Keep the (finite) plane centred under the camera. */
  follow(camera: THREE.Camera): void
  dispose(): void
}

export function createSea(atmosphere: AtmosphereUniforms, noise: THREE.Texture): Sea {
  const size = 900_000
  const geometry = new THREE.PlaneGeometry(size, size, 1, 1)
  geometry.rotateX(-Math.PI / 2)
  const shadows = Array.from({ length: MAX_SEA_SHADOWS }, () => new THREE.Vector4())
  const material = new THREE.ShaderMaterial({
    uniforms: {
      ...atmosphere,
      uNoise: { value: noise },
      uDeep: { value: PALETTE.seaDeep.clone() },
      uShadows: { value: shadows },
      uShadowCount: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      ${ATMOSPHERE_GLSL}
      uniform sampler2D uNoise;
      uniform vec3 uDeep;
      uniform vec4 uShadows[${MAX_SEA_SHADOWS}];
      uniform int uShadowCount;
      varying vec3 vWorld;

      vec2 slope(vec2 p, float scale, vec2 drift) {
        return texture2D(uNoise, p / scale + drift).gb - 0.5;
      }

      void main() {
        vec3 toP = vWorld - uCamPos;
        float dist = length(toP);
        vec3 v = toP / dist;
        // Waves at three scales; detail fades with distance so the far sea turns into a calm mirror.
        float detail = 1.0 - smoothstep(4000.0, 60000.0, dist);
        vec2 s = slope(vWorld.xz, 1400.0, vec2(uTime * 0.004, uTime * 0.002)) * 1.0
               + slope(vWorld.xz, 380.0, vec2(-uTime * 0.006, uTime * 0.005)) * 0.6 * detail
               + slope(vWorld.xz, 6000.0, vec2(uTime * 0.001, 0.0)) * 0.8;
        vec3 n = normalize(vec3(-s.x * 0.22, 1.0, -s.y * 0.22));
        vec3 r = reflect(v, n);
        r.y = abs(r.y);
        float cosT = max(dot(-v, n), 0.0);
        float fresnel = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);

        float shadow = 0.0;
        for (int i = 0; i < ${MAX_SEA_SHADOWS}; i++) {
          if (i >= uShadowCount) break;
          vec4 c = uShadows[i];
          float d = length(vWorld.xz - c.xy) / c.z;
          shadow = max(shadow, c.w * (1.0 - smoothstep(0.35, 1.0, d)));
        }

        vec3 sky = skyColor(r);
        float sunDot = max(dot(r, uSunDir), 0.0);
        vec3 glint = uSunColor * (pow(sunDot, 2400.0) * 30.0 + pow(sunDot, 120.0) * 0.5) * (1.0 - shadow);
        vec3 body = uDeep + uSunColor * 0.02 * max(uSunDir.y, 0.0);
        vec3 col = mix(body, sky * (1.0 - 0.55 * shadow), fresnel) + glint;
        gl_FragColor = vec4(applyAerial(col, vWorld), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  mesh.renderOrder = -900

  return {
    mesh,
    setShadows(discs) {
      const n = Math.min(discs.length, MAX_SEA_SHADOWS)
      for (let i = 0; i < n; i++) {
        const d = discs[i]!
        shadows[i]!.set(d[0], d[1], d[2], d[3])
      }
      material.uniforms.uShadowCount!.value = n
    },
    follow(camera) {
      // Snap to a coarse grid so the wave texture doesn't swim with the camera.
      mesh.position.set(Math.round(camera.position.x / 10_000) * 10_000, 0, Math.round(camera.position.z / 10_000) * 10_000)
    },
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}
