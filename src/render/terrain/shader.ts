// Ground shaders. The baked clipmap gives height and cover at tens to hundreds of meters per texel; every
// detail finer than that (field patchwork, canopy, street grid, ripples) is procedural in world space and
// fades out by pixel footprint before it can shimmer. Light is stylised for the low golden sun: wrapped
// sun term so flat land stays lit and slopes model strongly, blue-violet ambient like the cloud bellies,
// then the shared aerial perspective so distant land dissolves into exactly the sky behind it.
import { ATMOSPHERE_GLSL } from '../atmosphere'
import { PATCH_GRID } from './quadtree'

export const MAX_GROUND_SHADOWS = 32
export const MAX_CITIES = 16
/** Ground height assumed beyond every baked level: open sea. */
export const SEA_FLOOR = -200

/** Per-level uniform declarations and sampling helpers, fine (0) to coarse (n − 1). */
function levelGlsl(levels: number): string {
  const decl = Array.from({ length: levels }, (_, i) => `uniform sampler2D uT0_${i};\nuniform sampler2D uT1_${i};`).join('\n')
  return /* glsl */ `
    ${decl}
    // x: 1 / (texel × size), y: texel (m), z: fade width (m), w: 1 / size
    uniform vec4 uLev[${levels}];
    // Valid (baked) world rectangle: minX, minZ, maxX, maxZ.
    uniform vec4 uRect[${levels}];
    float levelWeight(vec2 p, int i) {
      vec4 r = uRect[i];
      float d = min(min(p.x - r.x, r.z - p.x), min(p.y - r.y, r.w - p.y));
      return smoothstep(0.0, uLev[i].z, d);
    }
  `
}

/** Height only (vertex shader): finest valid level wins, blended across each level's fade band. */
function heightGlsl(levels: number): string {
  const steps = Array.from({ length: levels }, (_, i) => /* glsl */ `
    w = levelWeight(p, ${i}) * rem;
    if (w > 0.0) { h += w * textureLod(uT0_${i}, p * uLev[${i}].x, 0.0).r; rem -= w; }`).join('')
  return /* glsl */ `
    float groundHeight(vec2 p) {
      float h = 0.0, rem = 1.0, w;
      ${steps}
      return h + rem * ${SEA_FLOOR.toFixed(1)};
    }
  `
}

/** Full ground sample (fragment shader): height, gradient and cover weights, level picked by footprint too. */
function groundGlsl(levels: number): string {
  const add = Array.from({ length: levels }, (_, i) => /* glsl */ `
    void addLevel${i}(vec2 p, vec2 pc, float w, inout Ground g) {
      vec2 uv = p * uLev[${i}].x;
      float d = uLev[${i}].w;
      vec4 a0 = textureLod(uT0_${i}, uv, 0.0);
      vec4 a = textureLod(uT0_${i}, pc * uLev[${i}].x, 0.0);
      vec4 b = textureLod(uT1_${i}, pc * uLev[${i}].x, 0.0);
      float hx0 = textureLod(uT0_${i}, uv - vec2(d, 0.0), 0.0).r;
      float hx1 = textureLod(uT0_${i}, uv + vec2(d, 0.0), 0.0).r;
      float hz0 = textureLod(uT0_${i}, uv - vec2(0.0, d), 0.0).r;
      float hz1 = textureLod(uT0_${i}, uv + vec2(0.0, d), 0.0).r;
      g.h += w * a0.r;
      g.grad += w * vec2(hx1 - hx0, hz1 - hz0) / (2.0 * uLev[${i}].y);
      // Water stays where the terrain put it (banks and coasts are smooth); land covers take the warp.
      g.c0 += w * vec3(a0.g, a.ba);
      g.c1 += w * b;
    }`).join('\n')
  const steps = Array.from({ length: levels }, (_, i) => {
    // The coarsest level is never refused for being too fine.
    const footprint = i === levels - 1 ? '1.0' : `(1.0 - smoothstep(uLev[${i}].y, uLev[${i}].y * 2.5, fp))`
    return /* glsl */ `
    w = levelWeight(p, ${i}) * ${footprint} * rem;
    if (w > 0.001) { addLevel${i}(p, pc, w, g); rem -= w; }`
  }).join('')
  return /* glsl */ `
    struct Ground {
      float h;
      vec2 grad;
      vec3 c0; // water, beach, city
      vec4 c1; // fields, forest, rock, snow
    };
    ${add}
    // pc: where cover is read — p pushed around by noise so class borders never show the texel grid.
    Ground groundAt(vec2 p, vec2 pc, float fp) {
      Ground g = Ground(0.0, vec2(0.0), vec3(0.0), vec4(0.0));
      float rem = 1.0, w;
      ${steps}
      g.h += rem * ${SEA_FLOOR.toFixed(1)};
      g.c0.x += rem;
      return g;
    }
  `
}

export function terrainVertexShader(levels: number): string {
  return /* glsl */ `
    uniform vec3 uCamPos;
    /** Camera height above the highest ground: the LOD metric's vertical term (quadtree.ts nodeMetric). */
    uniform float uDy;
    attribute vec4 iPatch;   // origin x, origin z, size, morph start
    attribute float iMorphEnd;
    varying vec3 vWorld;
    ${levelGlsl(levels)}
    ${heightGlsl(levels)}
    void main() {
      vec2 g = position.xz;
      float cell = iPatch.z / ${PATCH_GRID.toFixed(1)};
      vec2 p0 = iPatch.xy + g * cell;
      float m = length(vec3(p0 - uCamPos.xz, uDy));
      float k = clamp((m - iPatch.w) / (iMorphEnd - iPatch.w), 0.0, 1.0);
      vec2 p = iPatch.xy + (g - fract(g * 0.5) * 2.0 * k) * cell;
      // Water surfaces are flat at sea level; lakes sit on the ground height the terrain gives them.
      vWorld = vec3(p.x, max(groundHeight(p), 0.0), p.y);
      gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
    }
  `
}

/** Distance to the camera in km, for the half-res cloud pass (soft occlusion of clouds by the ground). */
export const terrainDistanceFragmentShader = /* glsl */ `
  uniform vec3 uCamPos;
  varying vec3 vWorld;
  void main() {
    gl_FragColor = vec4(length(vWorld - uCamPos) * 0.001, 0.0, 0.0, 1.0);
  }
`

export function terrainFragmentShader(levels: number): string {
  return /* glsl */ `
    ${ATMOSPHERE_GLSL}
    ${levelGlsl(levels)}
    ${groundGlsl(levels)}
    uniform sampler2D uNoise;
    uniform vec3 uDeep;
    uniform vec4 uShadows[${MAX_GROUND_SHADOWS}];
    uniform int uShadowCount;
    // x, z, radius, street-grid angle
    uniform vec4 uCities[${MAX_CITIES}];
    uniform int uCityCount;
    varying vec3 vWorld;
    const float GROUND_HAZE = 0.7;

    uint pcg(uint v) {
      uint s = v * 747796405u + 2891336453u;
      uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
      return (w >> 22u) ^ w;
    }
    float hash(vec2 id) {
      uvec2 u = uvec2(ivec2(floor(id)) + ivec2(1 << 20));
      return float(pcg(u.x ^ pcg(u.y)) >> 8u) / 16777216.0;
    }
    mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }

    // Anti-aliased thin line: \`dist\` (m) to the line centre, half width hw, pixel footprint fp.
    float aaLine(float dist, float hw, float fp) {
      return (1.0 - smoothstep(hw - 0.5 * fp, hw + 0.5 * fp, dist)) * clamp(2.0 * hw / fp, 0.0, 1.0);
    }

    // Patchwork of fields: farm regions with their own grid orientation, rows offset, some fields split
    // into strips; hedgerows between them. Averages to the region tone once fields are a few pixels.
    vec3 fieldsAlbedo(vec2 p, float fp, vec2 regionWarp, float mottle) {
      vec2 rp = p / 5200.0 + (regionWarp - 0.5) * 1.6;
      vec2 rid = floor(rp);
      vec2 q = rot(hash(rid) * 3.14159) * p;
      vec2 cell = mix(vec2(300.0, 170.0), vec2(620.0, 290.0), hash(rid + 3.1));
      vec2 c = q / cell;
      c.x += hash(vec2(floor(c.y), rid.x + rid.y * 17.0));
      vec2 id = floor(c);
      vec2 f = fract(c);
      float hs = hash(id + rid * 131.0);
      if (hs > 0.55) {
        float n = hs > 0.8 ? 3.0 : 2.0;
        float k = floor(f.y * n);
        f.y = fract(f.y * n);
        cell.y /= n;
        id.y = id.y * 4.0 + k;
        hs = hash(id + rid * 131.0 + 7.0);
      }
      vec3 col;
      if (hs < 0.22) col = vec3(0.40, 0.30, 0.11);       // ripe wheat
      else if (hs < 0.36) col = vec3(0.50, 0.42, 0.22);  // stubble
      else if (hs < 0.56) col = vec3(0.11, 0.20, 0.05);  // young crop
      else if (hs < 0.70) col = vec3(0.18, 0.26, 0.07);  // meadow
      else if (hs < 0.86) col = vec3(0.19, 0.12, 0.07);  // ploughed
      else if (hs < 0.93) col = vec3(0.11, 0.08, 0.05);  // dark soil
      else col = vec3(0.50, 0.44, 0.05);                 // rapeseed
      col *= (0.85 + 0.3 * hash(id + 51.0)) * (0.88 + 0.24 * mottle);
      // Furrows along the strip, only while a few pixels wide.
      col *= 1.0 - 0.12 * (0.5 + 0.5 * sin(f.y * cell.y * 0.7)) * (1.0 - smoothstep(1.5, 5.0, fp));
      vec2 e = min(f, 1.0 - f) * cell;
      col = mix(col, vec3(0.04, 0.07, 0.025), aaLine(min(e.x, e.y), 4.0, fp) * 0.8);
      return mix(col, vec3(0.24, 0.21, 0.10), smoothstep(70.0, 260.0, fp));
    }

    // City fabric on the city's own street grid: blocks of lots, avenues every fifth street. Districts of
    // 5×5 blocks give it texture: tiled houses, apartment blocks, industry and parks out of the centre, all
    // greener toward the edge; downtown darker and denser (towers shade each other), glass glints toward the sun.
    vec3 cityAlbedo(vec2 p, float fp, vec4 city, vec3 v, out float glint) {
      vec2 d = p - city.xy;
      float r = length(d) / city.z;
      vec2 q = rot(city.w) * d;
      // Block size, falloff and lot split must match buildings.ts (CITY_BLOCK, downtownAt, lotsPerBlock).
      float block = 120.0;
      vec2 g = q / block;
      vec2 id = floor(g);
      vec2 f = fract(g);
      vec2 e = min(f, 1.0 - f) * block;
      float hs = hash(id + city.xy * 0.01);
      float downtown = 1.0 - smoothstep(0.08, 0.45, length((id + 0.5) * block) / city.z);
      // Outside the building zone (buildings.ts MIN_DOWNTOWN) districts may change the lot pattern.
      float kind = downtown < 0.12 ? hash(floor(id / 5.0) + city.xy * 0.013) : 0.0;
      bool industry = kind > 0.78 && kind < 0.9;
      bool park = kind >= 0.9;
      vec2 lotN = downtown > 0.5 ? vec2(2.0) : industry ? vec2(2.0, 1.0) : vec2(4.0, 3.0);
      vec2 lot = floor(f * lotN);
      float hl = hash(id * 7.0 + lot + 17.0);
      vec3 roof;
      if (industry) roof = hl < 0.6 ? vec3(0.44, 0.43, 0.41) : vec3(0.17, 0.17, 0.18);
      else if (kind > 0.5) roof = hl < 0.5 ? vec3(0.31, 0.29, 0.27) : hl < 0.85 ? vec3(0.40, 0.37, 0.32) : vec3(0.13, 0.13, 0.14);
      else if (hl < 0.55) roof = mix(vec3(0.36, 0.15, 0.08), vec3(0.24, 0.23, 0.23), downtown);
      else if (hl < 0.8) roof = vec3(0.30, 0.27, 0.24);
      else if (hl < 0.93) roof = vec3(0.42, 0.38, 0.32);
      else roof = vec3(0.12, 0.12, 0.13);
      vec2 le = min(fract(f * lotN), 1.0 - fract(f * lotN)) * block / lotN;
      // Gardens between houses (wider toward the edge), shade between towers downtown.
      vec3 gap = mix(vec3(0.09, 0.15, 0.045), vec3(0.06, 0.06, 0.07), downtown);
      float gardens = mix(4.0, 2.0, downtown) + (industry ? 0.0 : 9.0 * smoothstep(0.35, 1.0, r));
      vec3 col = mix(roof, gap, aaLine(min(le.x, le.y), gardens, fp) * 0.9);
      if (park || hs < 0.06 && downtown < 0.9) col = vec3(0.09, 0.16, 0.05) * (0.8 + 0.4 * hash(id + lot + 3.0));
      col *= 1.0 - 0.35 * downtown * hash(id + lot * 3.0 + 5.0);
      bool avenue = mod(id.x, 5.0) == 0.0 && f.x < 0.5 || mod(id.x + 1.0, 5.0) == 0.0 && f.x >= 0.5;
      float street = aaLine(min(e.x, e.y), 7.0, fp);
      float wide = aaLine(e.x, 13.0, fp) * (avenue ? 1.0 : 0.0);
      col = mix(col, vec3(0.08, 0.08, 0.085), max(street, wide) * 0.85);
      glint = step(0.93, hl) * downtown * (1.0 - smoothstep(4.0, 30.0, fp));
      vec3 far = mix(mix(vec3(0.25, 0.22, 0.19), vec3(0.14, 0.17, 0.09), smoothstep(0.5, 1.0, r) * 0.6), vec3(0.15, 0.15, 0.16), downtown);
      return mix(col, far, smoothstep(30.0, 140.0, fp));
    }

    void main() {
      vec2 p = vWorld.xz;
      vec3 toP = vWorld - uCamPos;
      float dist = length(toP);
      vec3 v = toP / dist;

      // Pixel footprint on the ground (m), anisotropy capped at 4: picks the clipmap level and fades detail.
      vec2 ddx = dFdx(p), ddy = dFdy(p);
      float la = length(ddx), lb = length(ddy);
      float fp = max(min(la, lb), max(la, lb) * 0.25);
      float fpPat = max(min(la, lb), max(la, lb) * 0.5);

      // Mipmapped noise, fetched in uniform control flow.
      vec4 nMacro = texture(uNoise, p / 9000.0);
      vec4 nMid = texture(uNoise, p / 1100.0);
      vec4 nFine = texture(uNoise, p / 310.0);
      vec4 nCanopy = texture(uNoise, p / 38.0);
      vec4 nRegion = texture(uNoise, p / 23000.0);
      vec4 nWave1 = texture(uNoise, p / 1400.0 + vec2(uTime * 0.004, uTime * 0.002));
      vec4 nWave2 = texture(uNoise, p / 380.0 + vec2(-uTime * 0.006, uTime * 0.005));

      vec2 warp = (nMid.gb - 0.5) * 220.0 + (nFine.gb - 0.5) * 70.0;
      Ground g = groundAt(p, p + warp, fp);
      float wWater = g.c0.x, wBeach = g.c0.y, wCity = g.c0.z;
      float wFields = g.c1.x, wForest = g.c1.y, wRock = g.c1.z, wSnow = g.c1.w;
      float wGrass = max(0.0, 1.0 - wWater - wBeach - wCity - wFields - wForest - wRock - wSnow);

      vec3 n = normalize(vec3(-g.grad.x, 1.0, -g.grad.y));
      // Steep ground sheds its soil and snow: cliffs read as rock whatever the cover says.
      float steep = smoothstep(0.82, 0.62, n.y) * (1.0 - wWater);
      wRock += steep * (wGrass + wForest + wFields + wSnow * 0.7);
      wGrass *= 1.0 - steep; wForest *= 1.0 - steep; wFields *= 1.0 - steep; wSnow *= 1.0 - 0.7 * steep;

      // Organic borders between land covers: noise pushes weights, then a soft max keeps one per pixel.
      float a = nMid.r - 0.5, b = nFine.a - 0.5;
      wForest += (a * 0.5 + b * 0.3) * step(0.001, wForest);
      wFields += (-a * 0.3 + b * 0.25) * step(0.001, wFields);
      wGrass += (b * -0.3 + a * 0.2) * step(0.001, wGrass);
      wRock += (a * 0.35 - b * 0.2) * step(0.001, wRock);
      wSnow += (b * 0.4 - a * 0.2) * step(0.001, wSnow);
      float band = 0.2 + 0.9 * smoothstep(40.0, 500.0, fp);
      float top = max(max(max(wWater, wBeach), max(wCity, wFields)), max(max(wForest, wRock), max(wSnow, wGrass)));
      float cut = top - band;
      wWater = max(wWater - cut, 0.0); wBeach = max(wBeach - cut, 0.0); wCity = max(wCity - cut, 0.0);
      wFields = max(wFields - cut, 0.0); wForest = max(wForest - cut, 0.0); wRock = max(wRock - cut, 0.0);
      wSnow = max(wSnow - cut, 0.0); wGrass = max(wGrass - cut, 0.0);
      float total = wWater + wBeach + wCity + wFields + wForest + wRock + wSnow + wGrass;
      float inv = 1.0 / max(total, 1e-4);

      // ─── Land albedo ───
      vec3 albedo = vec3(0.0);
      float glint = 0.0;
      float micro = 0.0;
      if (wGrass > 0.0) {
        vec3 grass = mix(vec3(0.11, 0.19, 0.045), vec3(0.25, 0.26, 0.08), nMacro.r) * (0.8 + 0.45 * nMid.a) * (0.85 + 0.3 * nCanopy.a);
        // Copses and hedgerow trees scattered over pasture.
        grass = mix(grass, vec3(0.035, 0.07, 0.03), smoothstep(0.62, 0.7, nFine.r * 0.7 + nCanopy.r * 0.3) * 0.85);
        albedo += wGrass * grass;
      }
      if (wFields > 0.0) albedo += wFields * fieldsAlbedo(p, fpPat, nRegion.gb, nCanopy.a * 0.5 + nFine.r * 0.5);
      if (wForest > 0.0) {
        // Clumps and clearings read from kilometres away; crowns only up close.
        float clumps = smoothstep(0.25, 0.75, nFine.r * 0.6 + nMid.a * 0.4);
        vec3 forest = mix(vec3(0.035, 0.075, 0.03), vec3(0.075, 0.11, 0.04), nMacro.a) * (0.55 + 0.6 * clumps) * (0.65 + 0.7 * nCanopy.r);
        albedo += wForest * forest;
        micro += wForest;
      }
      if (wRock > 0.0) {
        vec3 rock = mix(vec3(0.19, 0.17, 0.15), vec3(0.27, 0.23, 0.19), nFine.r) * (0.85 + 0.3 * sin(g.h / 45.0 + nMid.a * 4.0));
        albedo += wRock * rock;
        micro += wRock * 0.6;
      }
      if (wSnow > 0.0) albedo += wSnow * vec3(0.82, 0.86, 0.94) * (0.92 + 0.08 * nFine.r);
      if (wBeach > 0.0) albedo += wBeach * vec3(0.56, 0.47, 0.31) * (0.9 + 0.2 * nFine.a);
      if (wCity > 0.0) {
        vec4 city = vec4(0.0, 0.0, 1.0, 0.0);
        float best = 1e9;
        for (int i = 0; i < ${MAX_CITIES}; i++) {
          if (i >= uCityCount) break;
          float dn = length(p - uCities[i].xy) / uCities[i].z;
          if (dn < best) { best = dn; city = uCities[i]; }
        }
        float gl;
        albedo += wCity * cityAlbedo(p, fpPat, city, v, gl);
        glint += wCity * gl;
      }

      // ─── Light ───
      // Canopy / rock micro relief from the noise gradient: speckled light under the low sun.
      vec3 ln = normalize(n + vec3(nCanopy.g - 0.5, 0.0, nCanopy.b - 0.5) * 1.6 * micro);
      float shadow = 0.0;
      for (int i = 0; i < ${MAX_GROUND_SHADOWS}; i++) {
        if (i >= uShadowCount) break;
        vec4 c = uShadows[i];
        float d = length(p - c.xy) / c.z;
        shadow = max(shadow, c.w * (1.0 - smoothstep(0.35, 1.0, d)));
      }
      float sunLit = smoothstep(-0.2, 0.7, dot(ln, uSunDir)) * (1.0 - 0.85 * shadow);
      vec3 ambient = mix(vec3(0.10, 0.12, 0.21), vec3(0.34, 0.41, 0.62), 0.5 + 0.5 * ln.y);
      vec3 land = albedo * inv * (ambient + uSunColor * sunLit * 0.75);
      // Glass and roofs catching the sun: the city twinkles.
      vec3 r = reflect(v, vec3(0.0, 1.0, 0.0));
      land += uSunColor * glint * inv * pow(max(dot(r, uSunDir), 0.0), 6.0) * 1.5 * (1.0 - shadow);

      // ─── Water: sea, lakes and rivers mirror the sky ───
      vec3 col = land;
      float water = wWater * inv;
      if (water > 0.001) {
        float detail = 1.0 - smoothstep(4000.0, 60000.0, dist);
        vec2 s = (nWave1.gb - 0.5) + (nWave2.gb - 0.5) * 0.6 * detail;
        vec3 wn = normalize(vec3(-s.x * 0.22, 1.0, -s.y * 0.22));
        vec3 wr = reflect(v, wn);
        wr.y = abs(wr.y);
        float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(-v, wn), 0.0), 5.0);
        float sunDot = max(dot(wr, uSunDir), 0.0);
        vec3 glintW = uSunColor * (pow(sunDot, 2400.0) * 30.0 + pow(sunDot, 120.0) * 0.5) * (1.0 - shadow);
        float inland = smoothstep(0.5, 4.0, g.h);
        float shallow = (1.0 - smoothstep(-35.0, -2.0, g.h)) ;
        vec3 body = mix(mix(uDeep, vec3(0.03, 0.10, 0.10), 1.0 - shallow), vec3(0.02, 0.05, 0.04), inland);
        body += uSunColor * 0.02 * max(uSunDir.y, 0.0);
        vec3 wc = mix(body, skyColor(wr) * (1.0 - 0.55 * shadow), fresnel) + glintW;
        col = mix(land, wc, water);
      }

      // A little less haze than the air around it: the land is the subject below the horizon. Same sky colour.
      vec3 tr = exp(-fogDepth(vWorld) * GROUND_HAZE * vec3(0.85, 1.0, 1.2));
      col = col * tr + skyColor(v) * (1.0 - tr);
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `
}
