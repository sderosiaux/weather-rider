// One stylised atmosphere shared by every material: the sky shader and the aerial perspective applied to
// clouds, sea, trails and the gate call the same skyColor(), so distant things dissolve into exactly
// the sky behind them. That consistency is what makes the frame read as a painting.
import * as THREE from 'three'

const deg = Math.PI / 180

/** Low golden sun, ahead-left of the eastbound route (north is -z). */
const SUN_ELEVATION = 8 * deg
const SUN_AZIMUTH = 70 * deg
export const SUN_DIR = new THREE.Vector3(
  Math.cos(SUN_ELEVATION) * Math.cos(SUN_AZIMUTH),
  Math.sin(SUN_ELEVATION),
  -Math.cos(SUN_ELEVATION) * Math.sin(SUN_AZIMUTH),
).normalize()

/** Scene palette, linear HDR. The single place to art-direct the world's light. */
export const PALETTE = {
  zenith: new THREE.Color(0.05, 0.13, 0.36),
  midSky: new THREE.Color(0.2, 0.36, 0.7),
  horizonSun: new THREE.Color(1.3, 0.78, 0.45),
  horizonAway: new THREE.Color(0.62, 0.66, 0.82),
  belowHorizon: new THREE.Color(0.3, 0.36, 0.5),
  sun: new THREE.Color(2.0, 1.25, 0.66),
  /** Blue-violet light filling cloud shadows. */
  cloudShadow: new THREE.Color(0.17, 0.2, 0.34),
  /** Ambient on sunlit cloud tops (sky dome contribution). */
  cloudAmbient: new THREE.Color(0.5, 0.58, 0.8),
  seaDeep: new THREE.Color(0.012, 0.045, 0.1),
  inCloud: new THREE.Color(0.78, 0.78, 0.82),
}

export interface AtmosphereUniforms {
  [name: string]: THREE.IUniform
  uSunDir: THREE.IUniform<THREE.Vector3>
  uSunColor: THREE.IUniform<THREE.Color>
  uZenith: THREE.IUniform<THREE.Color>
  uMidSky: THREE.IUniform<THREE.Color>
  uHorizonSun: THREE.IUniform<THREE.Color>
  uHorizonAway: THREE.IUniform<THREE.Color>
  uBelowHorizon: THREE.IUniform<THREE.Color>
  uInCloudColor: THREE.IUniform<THREE.Color>
  uCamPos: THREE.IUniform<THREE.Vector3>
  /** Height fog: density at sea level, scale height, and an altitude-independent floor. */
  uFog: THREE.IUniform<THREE.Vector3>
  /** 0..1, camera inside cloud (white-out). */
  uInCloud: THREE.IUniform<number>
  uTime: THREE.IUniform<number>
}

export function createAtmosphereUniforms(): AtmosphereUniforms {
  return {
    uSunDir: { value: SUN_DIR.clone() },
    uSunColor: { value: PALETTE.sun.clone() },
    uZenith: { value: PALETTE.zenith.clone() },
    uMidSky: { value: PALETTE.midSky.clone() },
    uHorizonSun: { value: PALETTE.horizonSun.clone() },
    uHorizonAway: { value: PALETTE.horizonAway.clone() },
    uBelowHorizon: { value: PALETTE.belowHorizon.clone() },
    uInCloudColor: { value: PALETTE.inCloud.clone() },
    uCamPos: { value: new THREE.Vector3() },
    uFog: { value: new THREE.Vector3(1.6e-4, 1300, 1.3e-5) },
    uInCloud: { value: 0 },
    uTime: { value: 0 },
  }
}

export const ATMOSPHERE_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uZenith;
uniform vec3 uMidSky;
uniform vec3 uHorizonSun;
uniform vec3 uHorizonAway;
uniform vec3 uBelowHorizon;
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
  col = mix(col, horizon, pow(1.0 - up, 6.0));
  // Below the horizon: the haze thickens into the sea-level murk.
  col = mix(col, mix(horizon, uBelowHorizon, 0.55), smoothstep(0.0, -0.18, y));
  float mu = max(dot(dir, uSunDir), 0.0);
  float glow = 0.1 * pow(mu, 4.0) + 0.45 * pow(mu, 32.0) + 1.2 * pow(mu, 600.0);
  col += uSunColor * vec3(1.0, 0.85, 0.7) * glow * (0.3 + 0.7 * pow(1.0 - up, 3.0));
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
