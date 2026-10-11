// Clouds render at half resolution into an HDR target, then get composited into the main pass.
// Soft puffs lose nothing at half res, and overdraw (near storms, under anvils) is the frame's
// dominant cost: this divides it by four.
// The composite has no depth, so the ground first writes its camera distance into a half-res target of
// its own; puffs read it and fade out where they sink behind a ridge or into a hillside (soft occlusion).
import * as THREE from 'three'

export const CLOUD_RESOLUTION_SCALE = 0.5
/** Distance target clear value (km): nothing in the way. */
const NO_OCCLUDER_KM = 10_000

export interface CloudPass {
  /** Fullscreen quad drawn inside the main scene, among the transparents. */
  readonly composite: THREE.Mesh
  /** Camera distance (km) of the nearest occluder, per half-res pixel. Sampled by the cloud material. */
  readonly occluderDistance: THREE.Texture
  setSize(drawingWidth: number, drawingHeight: number): void
  /** `occluders` (the ground, distance material) render first; null = open sky all the way down. */
  render(renderer: THREE.WebGLRenderer, clouds: THREE.Scene, occluders: THREE.Scene | null, camera: THREE.Camera): void
  dispose(): void
}

export function createCloudPass(): CloudPass {
  const target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  })
  const distance = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    depthBuffer: true,
    // Float depth: reversed-Z only keeps its precision over 100 km with a floating-point buffer.
    depthTexture: new THREE.DepthTexture(1, 1, THREE.FloatType),
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  })
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3))
  const material = new THREE.ShaderMaterial({
    uniforms: { uClouds: { value: target.texture } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = position.xy * 0.5 + 0.5;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uClouds;
      varying vec2 vUv;
      void main() {
        vec4 c = texture2D(uClouds, vUv);
        if (c.a < 0.002) discard;
        // Target holds linear premultiplied HDR; tone-map the straight colour, blend by coverage.
        gl_FragColor = vec4(c.rgb / c.a, min(c.a, 1.0));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const composite = new THREE.Mesh(geometry, material)
  composite.frustumCulled = false
  composite.renderOrder = 10
  const clearColor = new THREE.Color()
  const farColor = new THREE.Color(NO_OCCLUDER_KM, 0, 0)

  return {
    composite,
    occluderDistance: distance.texture,
    setSize(w, h) {
      const tw = Math.max(1, Math.round(w * CLOUD_RESOLUTION_SCALE))
      const th = Math.max(1, Math.round(h * CLOUD_RESOLUTION_SCALE))
      target.setSize(tw, th)
      distance.setSize(tw, th)
    },
    render(renderer, clouds, occluders, camera) {
      const prevTarget = renderer.getRenderTarget()
      renderer.getClearColor(clearColor)
      const prevAlpha = renderer.getClearAlpha()
      renderer.setRenderTarget(distance)
      renderer.setClearColor(farColor, 1)
      renderer.clear(true, true, false)
      if (occluders) renderer.render(occluders, camera)
      renderer.setRenderTarget(target)
      renderer.setClearColor(0x000000, 0)
      renderer.clear(true, false, false)
      renderer.render(clouds, camera)
      renderer.setRenderTarget(prevTarget)
      renderer.setClearColor(clearColor, prevAlpha)
    },
    dispose() {
      target.dispose()
      distance.depthTexture?.dispose()
      distance.dispose()
      geometry.dispose()
      material.dispose()
    },
  }
}
