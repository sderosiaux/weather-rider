// Trail ribbon shaders. One instance = one segment between ring slots s and s+1 of one particle;
// the base quad has 4 corners: position.x = end (0 = older record A, 1 = newer record B), position.y = side (-1 | 1).
//
// Visual language (sRGB colors, per dominant feature code, see params.KIND_CODE):
//   none      thin slate dust, faint: shows mean flow without cluttering the sky
//   updraft   warm amber filaments; downdraft cool indigo ones
//   thermal   soft wide peach haze
//   jetstream wide feathered aurora ribbons, teal → violet drifting along the flow
//   shear     teal ribbons riding a coherent standing wave
//   wake      thin lilac threads (the spiral comes from the field itself)
//   storm     magenta-plum, strong wobble and flicker
// Vertical wind also tints any kind warm/cool, so a real field richer than its `dominant` label still reads.
// Normal (not additive) blending: additive light vanishes on a bright sky and on white clouds.

export const trailVertexShader = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>

attribute vec3 aPosA;
attribute vec3 aVelA;
attribute vec4 aInfoA; // stamp, birth, turbulence, kind
attribute vec2 aExtA;  // seed, cloud
attribute vec3 aPosB;
attribute vec3 aVelB;
attribute vec4 aInfoB;
attribute vec2 aExtB;

uniform float uClock;      // push counter + fraction
uniform float uTrail;      // ring depth in pushes
uniform float uTime;       // real seconds, for flicker only
uniform vec2 uViewport;    // drawing buffer px
uniform float uMinPx;      // minimum ribbon half-width in px
uniform float uFar;
uniform float uIntensity;

varying vec4 vColor;
varying float vSide;
varying float vHalfPx;
varying float vSoft;

// rgb = sRGB color, a = base alpha
const vec4 KIND_COLOR[8] = vec4[8](
  vec4(0.36, 0.45, 0.58, 0.20),
  vec4(1.00, 0.50, 0.14, 0.75),
  vec4(0.22, 0.30, 0.86, 0.72),
  vec4(1.00, 0.62, 0.36, 0.60),
  vec4(0.08, 0.80, 0.72, 0.50),
  vec4(0.10, 0.62, 0.72, 0.55),
  vec4(0.58, 0.48, 0.92, 0.60),
  vec4(0.60, 0.14, 0.48, 0.72)
);
// x = world half-width (m) near the camera, y = edge feather (fraction of half-width), z = turbulence wobble (m)
const vec3 KIND_SHAPE[8] = vec3[8](
  vec3(0.6, 0.5, 5.0),
  vec3(1.4, 0.5, 4.0),
  vec3(1.4, 0.5, 4.0),
  vec3(4.0, 1.0, 3.0),
  vec3(6.0, 0.85, 3.0),
  vec3(1.6, 0.7, 4.0),
  vec3(0.7, 0.5, 3.0),
  vec3(1.2, 0.5, 10.0)
);

void main() {
  bool isB = position.x > 0.5;
  vec3 p = isB ? aPosB : aPosA;
  vec3 vel = isB ? aVelB : aVelA;
  vec4 info = isB ? aInfoB : aInfoA;
  vec2 ext = isB ? aExtB : aExtA;

  // Same rule as particles.isSegmentValid: one push apart, same life. Else collapse off-clip.
  if (abs(aInfoB.x - aInfoA.x - 1.0) > 0.5 || abs(aInfoB.y - aInfoA.y) > 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vColor = vec4(0.0);
    return;
  }

  int kind = int(info.w + 0.5);
  vec4 base = KIND_COLOR[kind];
  vec3 shape = KIND_SHAPE[kind];
  float turb = info.z;
  float seed = ext.x;
  float stamp = info.x;

  float age = uClock - stamp;
  float ageN = clamp(age / uTrail, 0.0, 1.0);
  float speed = length(vel);

  vec3 col = base.rgb;
  if (kind == 4) {
    // Aurora: hue drifts along the ribbon and over time.
    // Hue follows world position so neighbouring ribbons share a band, like a curtain.
    float w = 0.5 + 0.5 * sin(p.x * 0.0007 + p.y * 0.003 + p.z * 0.0005 + uTime * 0.25);
    col = mix(vec3(0.05, 0.78, 0.62), vec3(0.50, 0.30, 0.95), w);
    col = mix(col, vec3(0.30, 0.55, 1.0), 0.35 * ageN);
  }
  // Vertical-wind tint for every kind: rising reads warm, sinking reads cool.
  float up = smoothstep(1.5, 9.0, vel.y);
  float down = smoothstep(1.5, 9.0, -vel.y);
  if (kind != 1 && kind != 2) {
    // Storms keep their own identity; everything else follows the vertical wind.
    float k = kind == 7 ? 0.3 : 0.7;
    col = mix(col, vec3(1.0, 0.55, 0.18), up * k);
    col = mix(col, vec3(0.22, 0.30, 0.86), down * k);
  }

  // Turbulence: smooth wobble along the trail (continuous in stamp) + a fine vibration + flicker.
  float ph = seed * 43.0;
  float agit = smoothstep(0.12, 0.8, turb);
  vec3 wob = vec3(sin(stamp * 0.37 + ph), sin(stamp * 0.53 + ph * 1.7), cos(stamp * 0.29 + ph * 2.3));
  p += wob * agit * shape.z * 1.3;
  p.y += sin(uTime * 17.0 + ph) * agit * shape.z * 0.3;
  // Shear: a coherent standing wave in world space (Kelvin-Helmholtz billows), shared by neighbouring trails.
  if (kind == 5) p.y += sin(p.x * 0.014 + p.z * 0.005 - uTime * 0.8) * 32.0;

  float alpha = base.a;
  alpha *= kind == 0 ? (1.0 - ageN) * (1.0 - ageN) : 1.0 - ageN; // fade along the trail; calm air shorter
  alpha *= smoothstep(0.0, 2.0, stamp - info.y);        // fade in after spawn
  alpha *= 0.65 + 0.35 * smoothstep(4.0, 30.0, speed) + 0.3 * max(up, down);
  alpha *= 1.0 - agit * 0.55 * (0.5 + 0.5 * sin(uTime * (11.0 + seed * 9.0) + stamp * 1.7));
  alpha *= 1.0 - 0.3 * ext.y;                           // inside clouds: let the cloud speak, a little
  float dist = distance(p, cameraPosition);
  alpha *= smoothstep(uFar, uFar * 0.8, dist) * smoothstep(40.0, 250.0, dist);
  // Near filaments are big and many (importance spawning packs them inside features): calm them down;
  // far ones are thin: push them so a column kilometres away still reads.
  alpha *= mix(0.6, 1.2, smoothstep(400.0, 4000.0, dist));
  alpha *= uIntensity;

  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  vec4 clip = projectionMatrix * mvPosition;
  vec3 dir = speed > 1e-3 ? vel / speed : normalize((aPosB - aPosA) + vec3(0.0, 1e-4, 0.0));
  vec4 clip2 = projectionMatrix * modelViewMatrix * vec4(p + dir, 1.0);
  vec2 sdir = (clip2.xy / max(clip2.w, 1e-3) - clip.xy / max(clip.w, 1e-3)) * uViewport;
  if (dot(sdir, sdir) < 1e-8) sdir = vec2(1.0, 0.0);
  vec2 n = normalize(vec2(-sdir.y, sdir.x));

  // Grows with distance so a column 5 km out still reads; near filaments stay fine.
  // Pointed head, thinner tail.
  float halfW = shape.x * (1.0 - 0.45 * ageN) * mix(0.15, 1.0, smoothstep(0.0, 1.5, age)) * (1.0 + 0.5 * turb) * (1.0 + dist / 800.0);
  float halfPx = halfW * projectionMatrix[1][1] * 0.5 * uViewport.y / max(clip.w, 1e-3);
  float drawPx = max(halfPx, uMinPx);
  alpha *= clamp(halfPx / drawPx, 0.25, 1.0);         // sub-pixel: keep coverage honest

  clip.xy += n * position.y * drawPx * 2.0 / uViewport * clip.w;
  gl_Position = clip;

  vColor = vec4(col, alpha);
  vSide = position.y;
  vHalfPx = drawPx;
  vSoft = shape.y;

  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`

export const trailFragmentShader = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>

varying vec4 vColor;
varying float vSide;
varying float vHalfPx;
varying float vSoft;

void main() {
  #include <logdepthbuf_fragment>
  if (vColor.a <= 0.002) discard;
  float e = 1.0 - abs(vSide);
  // Feather: at least ~1px of antialiasing, up to the full half-width for aurora ribbons.
  float feather = max(vSoft, min(1.0, 1.0 / max(vHalfPx, 1e-3)));
  float a = vColor.a * smoothstep(0.0, feather, e);
  gl_FragColor = vec4(sRGBTransferEOTF(vec4(vColor.rgb, 1.0)).rgb, a);
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`
