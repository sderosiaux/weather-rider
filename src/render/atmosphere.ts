// One stylised atmosphere shared by every material: the sky shader and the aerial perspective applied to
// clouds, sea, trails and the gate call the same skyColor(), so distant things dissolve into exactly
// the sky behind them. That consistency is what makes the frame read as a painting.
// The day's light (sky.ts) only ever lands here, in shared uniforms: every material follows it for free.
import * as THREE from 'three'
import type { SkyLook } from './sky'

export interface AtmosphereUniforms {
  [name: string]: THREE.IUniform
  uSunDir: THREE.IUniform<THREE.Vector3>
  uSunColor: THREE.IUniform<THREE.Color>
  uSunGlow: THREE.IUniform<THREE.Color>
  /** Halo lobe weights around the sun: broad, medium, tight. */
  uHalo: THREE.IUniform<THREE.Vector3>
  uZenith: THREE.IUniform<THREE.Color>
  uMidSky: THREE.IUniform<THREE.Color>
  uHorizonSun: THREE.IUniform<THREE.Color>
  uHorizonAway: THREE.IUniform<THREE.Color>
  uBelowHorizon: THREE.IUniform<THREE.Color>
  uHorizonPow: THREE.IUniform<number>
  uInCloudColor: THREE.IUniform<THREE.Color>
  uCloudShadow: THREE.IUniform<THREE.Color>
  uCloudAmbient: THREE.IUniform<THREE.Color>
  uSeaDeep: THREE.IUniform<THREE.Color>
  uContrailShade: THREE.IUniform<THREE.Color>
  uCamPos: THREE.IUniform<THREE.Vector3>
  /** Height fog: density at sea level, scale height, and an altitude-independent floor. */
  uFog: THREE.IUniform<THREE.Vector3>
  /** 0..1, camera inside cloud (white-out). */
  uInCloud: THREE.IUniform<number>
  uTime: THREE.IUniform<number>
}

export function createAtmosphereUniforms(look: SkyLook): AtmosphereUniforms {
  const u: AtmosphereUniforms = {
    uSunDir: { value: new THREE.Vector3() },
    uSunColor: { value: new THREE.Color() },
    uSunGlow: { value: new THREE.Color() },
    uHalo: { value: new THREE.Vector3() },
    uZenith: { value: new THREE.Color() },
    uMidSky: { value: new THREE.Color() },
    uHorizonSun: { value: new THREE.Color() },
    uHorizonAway: { value: new THREE.Color() },
    uBelowHorizon: { value: new THREE.Color() },
    uHorizonPow: { value: 6 },
    uInCloudColor: { value: new THREE.Color() },
    uCloudShadow: { value: new THREE.Color() },
    uCloudAmbient: { value: new THREE.Color() },
    uSeaDeep: { value: new THREE.Color() },
    uContrailShade: { value: new THREE.Color() },
    uCamPos: { value: new THREE.Vector3() },
    uFog: { value: new THREE.Vector3() },
    uInCloud: { value: 0 },
    uTime: { value: 0 },
  }
  applyLook(u, look)
  return u
}

/** Copy a day's look into the shared uniforms (materials hold the same uniform objects). */
export function applyLook(u: AtmosphereUniforms, look: SkyLook): void {
  u.uSunDir.value.copy(look.sunDir)
  u.uSunColor.value.copy(look.sun)
  u.uSunGlow.value.copy(look.sunGlow)
  u.uHalo.value.copy(look.halo)
  u.uZenith.value.copy(look.zenith)
  u.uMidSky.value.copy(look.midSky)
  u.uHorizonSun.value.copy(look.horizonSun)
  u.uHorizonAway.value.copy(look.horizonAway)
  u.uBelowHorizon.value.copy(look.belowHorizon)
  u.uHorizonPow.value = look.horizonPow
  u.uInCloudColor.value.copy(look.inCloud)
  u.uCloudShadow.value.copy(look.cloudShadow)
  u.uCloudAmbient.value.copy(look.cloudAmbient)
  u.uSeaDeep.value.copy(look.seaDeep)
  u.uContrailShade.value.copy(look.contrailShade)
  u.uFog.value.copy(look.fog)
}

export const ATMOSPHERE_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSunGlow;
uniform vec3 uHalo;
uniform vec3 uZenith;
uniform vec3 uMidSky;
uniform vec3 uHorizonSun;
uniform vec3 uHorizonAway;
uniform vec3 uBelowHorizon;
uniform float uHorizonPow;
uniform vec3 uInCloudColor;
uniform vec3 uCamPos;
uniform vec3 uFog;
uniform float uInCloud;
uniform float uTime;

// Sky radiance seen along dir (no sun disc).
vec3 skyColor(vec3 dir) {
  float y = dir.y;
  vec2 hz = normalize(dir.xz + vec2(1e-5));
  vec2 sz = normalize(uSunDir.xz);
  float sunSide = dot(hz, sz) * 0.5 + 0.5;
  vec3 horizon = mix(uHorizonAway, uHorizonSun, sunSide * sunSide * sunSide);
  float up = max(y, 0.0);
  vec3 col = mix(uMidSky, uZenith, smoothstep(0.1, 0.9, up));
  col = mix(col, horizon, pow(1.0 - up, uHorizonPow));
  // Below the horizon: the haze thickens into the sea-level murk.
  col = mix(col, mix(horizon, uBelowHorizon, 0.55), smoothstep(0.0, -0.18, y));
  float mu = max(dot(dir, uSunDir), 0.0);
  float glow = uHalo.x * pow(mu, 4.0) + uHalo.y * pow(mu, 32.0) + uHalo.z * pow(mu, 600.0);
  col += uSunGlow * glow * (0.3 + 0.7 * pow(1.0 - up, 3.0));
  return mix(col, uInCloudColor, uInCloud);
}

// Optical depth of exponential height fog between camera and p (analytic integral).
float fogDepth(vec3 p) {
  vec3 d = p - uCamPos;
  float dist = length(d);
  float h0 = max(uCamPos.y, 0.0);
  float k = d.y / uFog.y;
  float base = uFog.x * exp(-h0 / uFog.y);
  float integral = abs(k) > 1e-4 ? base * (1.0 - exp(-k)) / k : base;
  return (integral + uFog.z) * dist + uInCloud * dist * 2.5e-3;
}

// Transmittance per channel: blue fades first, so distance turns cool and pale.
vec3 fogTransmittance(vec3 p) {
  return exp(-fogDepth(p) * vec3(0.85, 1.0, 1.2));
}

vec3 applyAerial(vec3 col, vec3 p) {
  vec3 tr = fogTransmittance(p);
  return col * tr + skyColor(normalize(p - uCamPos)) * (1.0 - tr);
}
`

/** Full-screen sky pass, drawn first. */
export function createSky(atmosphere: AtmosphereUniforms, noise: THREE.Texture): THREE.Mesh {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3))
  const material = new THREE.ShaderMaterial({
    uniforms: {
      ...atmosphere,
      uNoise: { value: noise },
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
    },
    vertexShader: /* glsl */ `
      uniform mat4 uInvProj;
      uniform mat4 uCamWorld;
      varying vec3 vDir;
      void main() {
        vec4 view = uInvProj * vec4(position.xy, 1.0, 1.0);
        vDir = (uCamWorld * vec4(view.xyz / view.w, 0.0)).xyz;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${ATMOSPHERE_GLSL}
      uniform sampler2D uNoise;
      varying vec3 vDir;
      void main() {
        vec3 dir = normalize(vDir);
        vec3 col = skyColor(dir);
        float mu = dot(dir, uSunDir);
        col += uSunColor * 10.0 * smoothstep(0.99989, 0.99995, mu) * (1.0 - uInCloud);
        // High cirrus veil painted on the dome, brightest near the sun.
        if (dir.y > 0.0) {
          vec2 uv = dir.xz / (dir.y + 0.12) * 0.22 + vec2(uTime * 0.0006, 0.0);
          float n = texture2D(uNoise, uv * vec2(0.35, 1.6)).a;
          float wisps = smoothstep(0.52, 0.8, n) * smoothstep(0.0, 0.15, dir.y) * (1.0 - smoothstep(0.35, 0.8, dir.y));
          vec3 lit = mix(vec3(1.0), uSunColor, 0.6) * (0.9 + 1.4 * pow(max(mu, 0.0), 6.0));
          col = mix(col, lit * 0.95, wisps * 0.35 * (1.0 - uInCloud));
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    depthTest: false,
    depthWrite: false,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  mesh.renderOrder = -1000
  mesh.onBeforeRender = (_r, _s, camera) => {
    material.uniforms.uInvProj!.value.copy(camera.projectionMatrixInverse)
    material.uniforms.uCamWorld!.value.copy(camera.matrixWorld)
  }
  return mesh
}
