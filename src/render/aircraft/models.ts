// Procedural low-poly aircraft, one silhouette per class. Built in body frame (+x nose, +y up, +z right wing)
// with the fuselage length normalised to 1, then scaled to spec.lengthM.
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { AircraftClass } from '../../core/types'

export interface AircraftModel {
  /** Merged, vertex-coloured airframe (meters, body frame). */
  readonly geometry: THREE.BufferGeometry
  /** Propeller hubs: position + disc radius (turboprop only). */
  readonly props: readonly { readonly pos: THREE.Vector3; readonly radius: number }[]
  /** Exhaust points, outermost first: contrail sources. */
  readonly exhausts: readonly THREE.Vector3[]
  readonly navLeft: THREE.Vector3
  readonly navRight: THREE.Vector3
  readonly navTail: THREE.Vector3
  readonly beacon: THREE.Vector3
  readonly span: number
}

interface Paint {
  readonly livery: THREE.Color
  readonly body: THREE.Color
  readonly belly: THREE.Color
  readonly wing: THREE.Color
  readonly engine: THREE.Color
  readonly glass: THREE.Color
  readonly windows: THREE.Color
}

function colorize(geo: THREE.BufferGeometry, color: THREE.Color | ((p: THREE.Vector3) => THREE.Color)): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo
  g.deleteAttribute('uv')
  g.deleteAttribute('normal')
  const pos = g.getAttribute('position')
  const colors = new Float32Array(pos.count * 3)
  const p = new THREE.Vector3()
  const tri = new THREE.Vector3()
  for (let i = 0; i < pos.count; i += 3) {
    // Colour per triangle (centroid) so livery splits stay crisp on a low-poly mesh.
    tri.set(0, 0, 0)
    for (let k = 0; k < 3; k++) tri.add(p.fromBufferAttribute(pos, i + k))
    tri.multiplyScalar(1 / 3)
    const c = typeof color === 'function' ? color(tri) : color
    for (let k = 0; k < 3; k++) c.toArray(colors, (i + k) * 3)
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return g
}

/**
 * Fuselage as a lathe along +x. profile: [x, radius] pairs from nose to tail (x in [-0.5, 0.5]).
 * tailUp lifts the aft section (upswept tail cone). squash scales y (<1 = flattened body).
 */
function fuselage(profile: readonly (readonly [number, number])[], segments: number, tailUp = 0, squash = 1, widen = 1): THREE.BufferGeometry {
  const pts = profile.map(([x, r]) => new THREE.Vector2(Math.max(r, 1e-4), -x))
  const geo = new THREE.LatheGeometry(pts, segments)
  // Lathe axis is y; profile y = -x so rotating +90° about z maps it back to +x.
  geo.rotateZ(Math.PI / 2)
  const pos = geo.getAttribute('position')
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const lift = x < -0.2 ? ((-0.2 - x) / 0.3) * tailUp : 0
    pos.setY(i, pos.getY(i) * squash + lift)
    pos.setZ(i, pos.getZ(i) * widen)
  }
  return geo
}

interface WingSpec {
  /** Root leading edge x, root chord, tip chord, semi-span, tip leading-edge sweep back (x), dihedral (rad), thickness. */
  readonly x: number
  readonly y: number
  readonly z0?: number
  readonly root: number
  readonly tip: number
  readonly span: number
  readonly sweep: number
  readonly dihedral: number
  readonly thick: number
}

/** Tapered slab for one side (+z); vertical=true builds a fin rising along +y instead. */
function slab(w: WingSpec, side: 1 | -1, vertical = false): THREE.BufferGeometry {
  const z0 = w.z0 ?? 0
  const tipX = w.x - w.sweep
  const rise = Math.tan(w.dihedral) * w.span
  const rootLE = [w.x, w.y, z0]
  const rootTE = [w.x - w.root, w.y, z0]
  const tipLE = [tipX, w.y + rise, z0 + w.span]
  const tipTE = [tipX - w.tip, w.y + rise, z0 + w.span]
  const quad = [rootLE, tipLE, tipTE, rootTE].map(([x, y, z]) => (vertical ? [x!, y! + (z! - z0), z0] : [x!, y!, z! * side]))
  const ht = w.thick / 2
  const tt = (w.thick * w.tip) / w.root / 2
  const up = (i: number): number[] => {
    const [x, y, z] = quad[i]!
    const t = i === 0 || i === 3 ? ht : tt
    return vertical ? [x!, y!, z! + t] : [x!, y! + t, z!]
  }
  const dn = (i: number): number[] => {
    const [x, y, z] = quad[i]!
    const t = i === 0 || i === 3 ? ht : tt
    return vertical ? [x!, y!, z! - t] : [x!, y! - t, z!]
  }
  const v = [up(0), up(1), up(2), up(3), dn(0), dn(1), dn(2), dn(3)]
  const faces = [
    [0, 1, 2], [0, 2, 3], // top
    [4, 6, 5], [4, 7, 6], // bottom
    [0, 4, 5], [0, 5, 1], // leading edge
    [3, 2, 6], [3, 6, 7], // trailing edge
    [1, 5, 6], [1, 6, 2], // tip
    [0, 3, 7], [0, 7, 4], // root
  ]
  const flip = !vertical && side === -1
  const arr: number[] = []
  for (const f of faces) {
    const order = flip ? [f[0]!, f[2]!, f[1]!] : f
    for (const i of order) arr.push(...v[i]!)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3))
  return geo
}

const pair = (w: WingSpec, color: THREE.Color): THREE.BufferGeometry[] => [colorize(slab(w, 1), color), colorize(slab(w, -1), color)]

function nacelle(x: number, y: number, z: number, len: number, r: number, color: THREE.Color, lip: THREE.Color): THREE.BufferGeometry[] {
  const body = new THREE.CylinderGeometry(r * 0.85, r, len, 12, 1, false)
  body.rotateZ(Math.PI / 2)
  body.translate(x - len / 2, y, z)
  const intake = new THREE.CylinderGeometry(r * 0.95, r * 0.95, len * 0.08, 12, 1, false)
  intake.rotateZ(Math.PI / 2)
  intake.translate(x - len * 0.04, y, z)
  return [colorize(body, color), colorize(intake, lip)]
}

function pylon(x: number, y0: number, y1: number, z: number, len: number, color: THREE.Color): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(len, Math.abs(y1 - y0), 0.006)
  g.translate(x - len / 2, (y0 + y1) / 2, z)
  return colorize(g, color)
}

function cockpit(x: number, y: number, r: number, glass: THREE.Color): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2)
  g.scale(1.8, 0.5, 1.1)
  g.translate(x, y, 0)
  return colorize(g, glass)
}

/** Livery on the upper body; white elsewhere, grey belly (blended-wing and odd shapes). */
const bodyPaint = (paint: Paint, splitY: number) => (p: THREE.Vector3): THREE.Color =>
  p.y > splitY + 0.012 ? paint.livery : p.y < -splitY * 0.6 ? paint.belly : paint.body

/**
 * Airliner livery on a tube of radius r: white crown, a row of windows, a livery cheat-line along the
 * side, grey belly, livery tail cone. Rows follow the lathe facets (FUSELAGE_SEGMENTS around).
 */
const tubePaint = (paint: Paint, r: number) => (p: THREE.Vector3): THREE.Color => {
  if (p.x < -0.38) return paint.livery
  const yr = p.y / r
  const cabin = p.x < 0.36 && p.x > -0.3
  if (yr > 0.3 && yr < 0.6 && cabin) return paint.windows
  if (yr > 0.02 && yr <= 0.3) return paint.livery
  if (yr < -0.4) return paint.belly
  return paint.body
}

const FUSELAGE_SEGMENTS = 20

interface Built {
  parts: THREE.BufferGeometry[]
  props: { pos: THREE.Vector3; radius: number }[]
  exhausts: THREE.Vector3[]
  tailTop: THREE.Vector3
  beacon: THREE.Vector3
}

function tube(noseLen: number, r: number, tailStart: number, tailR: number): (readonly [number, number])[] {
  const nose: [number, number][] = []
  for (let i = 0; i <= 6; i++) {
    const t = i / 6
    // Tip first (radius 0 at x = 0.5), growing to the full tube radius noseLen behind it.
    nose.push([0.5 - noseLen * t, r * Math.sin((t * Math.PI) / 2) ** 0.7])
  }
  return [...nose, [tailStart, r], [-0.44, (r + tailR) / 2], [-0.5, tailR]]
}

function turboprop(paint: Paint): Built {
  const r = 0.052
  const parts = [
    colorize(fuselage(tube(0.1, r, -0.22, 0.012), FUSELAGE_SEGMENTS, 0.03), tubePaint(paint, r)),
    cockpit(0.41, 0.028, 0.032, paint.glass),
    ...pair({ x: 0.08, y: r * 0.95, root: 0.1, tip: 0.06, span: 0.5, sweep: 0.01, dihedral: 0.02, thick: 0.014 }, paint.wing),
    // T-tail
    colorize(slab({ x: -0.3, y: 0.03, root: 0.13, tip: 0.08, span: 0.17, sweep: 0.12, dihedral: 0, thick: 0.012 }, 1, true), paint.livery),
    ...pair({ x: -0.43, y: 0.2, root: 0.07, tip: 0.04, span: 0.14, sweep: 0.03, dihedral: 0, thick: 0.008 }, paint.body),
  ]
  const props: Built['props'] = []
  for (const z of [-0.16, 0.16]) {
    parts.push(...nacelle(0.17, r * 0.8, z, 0.24, 0.025, paint.body, paint.engine))
    const spinner = new THREE.ConeGeometry(0.014, 0.04, 8)
    spinner.rotateZ(-Math.PI / 2)
    spinner.translate(0.19, r * 0.8, z)
    parts.push(colorize(spinner, paint.engine))
    props.push({ pos: new THREE.Vector3(0.178, r * 0.8, z), radius: 0.075 })
  }
  return { parts, props, exhausts: [new THREE.Vector3(-0.07, r * 0.8, -0.16), new THREE.Vector3(-0.07, r * 0.8, 0.16)], tailTop: new THREE.Vector3(-0.47, 0.21, 0), beacon: new THREE.Vector3(0.05, r + 0.005, 0) }
}

function regional(paint: Paint): Built {
  const r = 0.045
  const parts = [
    colorize(fuselage(tube(0.09, r, -0.2, 0.01), FUSELAGE_SEGMENTS, 0.02), tubePaint(paint, r)),
    cockpit(0.425, 0.022, 0.028, paint.glass),
    ...pair({ x: 0.08, y: -r * 0.6, root: 0.14, tip: 0.045, span: 0.36, sweep: 0.1, dihedral: 0.07, thick: 0.014 }, paint.wing),
    colorize(slab({ x: -0.28, y: 0.03, root: 0.15, tip: 0.1, span: 0.16, sweep: 0.13, dihedral: 0, thick: 0.012 }, 1, true), paint.livery),
    ...pair({ x: -0.42, y: 0.19, root: 0.08, tip: 0.04, span: 0.13, sweep: 0.05, dihedral: 0, thick: 0.008 }, paint.body),
  ]
  for (const z of [-1, 1]) {
    parts.push(...nacelle(-0.2, 0.03, z * (r + 0.03), 0.13, 0.022, paint.body, paint.livery))
    parts.push(pylon(-0.24, 0.03, 0.03, z * (r + 0.005), 0.06, paint.body))
  }
  return { parts, props: [], exhausts: [new THREE.Vector3(-0.34, 0.03, -(r + 0.03)), new THREE.Vector3(-0.34, 0.03, r + 0.03)], tailTop: new THREE.Vector3(-0.47, 0.2, 0), beacon: new THREE.Vector3(0.0, r + 0.005, 0) }
}

function airliner(paint: Paint, r: number, span: number, engines: number): Built {
  const parts = [
    colorize(fuselage(tube(0.08, r, -0.24, 0.012), FUSELAGE_SEGMENTS, 0.02), tubePaint(paint, r)),
    cockpit(0.43, r * 0.45, r * 0.55, paint.glass),
    ...pair({ x: 0.14, y: -r * 0.55, root: 0.2, tip: 0.05, span, sweep: span * 0.55, dihedral: 0.09, thick: 0.02 }, paint.wing),
    colorize(slab({ x: -0.3, y: r * 0.6, root: 0.18, tip: 0.07, span: 0.17, sweep: 0.15, dihedral: 0, thick: 0.012 }, 1, true), paint.livery),
    ...pair({ x: -0.34, y: r * 0.2, root: 0.11, tip: 0.04, span: 0.17, sweep: 0.1, dihedral: 0.1, thick: 0.01 }, paint.wing),
  ]
  // Livery winglets at the tips.
  const tipX = 0.14 - span * 0.55
  const tipY = -r * 0.55 + Math.tan(0.09) * span
  for (const side of [-1, 1]) parts.push(colorize(slab({ x: tipX, y: tipY, z0: side * span, root: 0.05, tip: 0.025, span: 0.045, sweep: 0.03, dihedral: 0, thick: 0.004 }, 1, true), paint.livery))
  const exhausts: THREE.Vector3[] = []
  const stations = engines === 4 ? [0.62, 0.33] : [0.34]
  const er = r * 0.55
  for (const s of stations) {
    for (const side of [-1, 1]) {
      const z = side * span * s
      const x = 0.14 - span * 0.55 * s + 0.07
      const y = -r * 0.55 + Math.tan(0.09) * span * s - er * 1.3
      parts.push(...nacelle(x, y, z, 0.1, er, paint.body, paint.livery))
      parts.push(pylon(x - 0.02, y, y + er * 1.3, z, 0.08, paint.wing))
      exhausts.push(new THREE.Vector3(x - 0.1, y, z))
    }
  }
  return { parts, props: [], exhausts, tailTop: new THREE.Vector3(-0.47, r * 0.6 + 0.17, 0), beacon: new THREE.Vector3(0.05, r + 0.005, 0) }
}

function cargo(paint: Paint): Built {
  const r = 0.065
  const parts = [
    colorize(fuselage(tube(0.1, r, -0.18, 0.02), FUSELAGE_SEGMENTS, 0.07), tubePaint(paint, r)),
    cockpit(0.42, r * 0.55, 0.04, paint.glass),
    // High wing with anhedral
    ...pair({ x: 0.12, y: r * 0.9, root: 0.2, tip: 0.06, span: 0.52, sweep: 0.16, dihedral: -0.05, thick: 0.022 }, paint.wing),
    colorize(slab({ x: -0.25, y: r * 0.7, root: 0.2, tip: 0.13, span: 0.2, sweep: 0.15, dihedral: 0, thick: 0.014 }, 1, true), paint.livery),
    ...pair({ x: -0.4, y: r * 0.7 + 0.2, root: 0.1, tip: 0.05, span: 0.18, sweep: 0.08, dihedral: 0, thick: 0.01 }, paint.wing),
  ]
  const exhausts: THREE.Vector3[] = []
  for (const s of [0.55, 0.3]) {
    for (const side of [-1, 1]) {
      const z = side * 0.52 * s
      const x = 0.12 - 0.16 * s + 0.06
      const y = r * 0.9 - Math.tan(0.05) * 0.52 * s - 0.04
      parts.push(...nacelle(x, y, z, 0.1, 0.024, paint.body, paint.livery))
      parts.push(pylon(x - 0.02, y, y + 0.035, z, 0.07, paint.wing))
      exhausts.push(new THREE.Vector3(x - 0.1, y, z))
    }
  }
  return { parts, props: [], exhausts, tailTop: new THREE.Vector3(-0.47, r * 0.7 + 0.21, 0), beacon: new THREE.Vector3(0.1, r + 0.005, 0) }
}

function supersonic(paint: Paint): Built {
  const r = 0.024
  const profile: (readonly [number, number])[] = [[0.5, 0.0005], [0.44, r * 0.45], [0.36, r * 0.85], [0.28, r], [-0.35, r], [-0.46, r * 0.6], [-0.5, r * 0.3]]
  const parts = [
    colorize(fuselage(profile, FUSELAGE_SEGMENTS, 0), tubePaint(paint, r)),
    cockpit(0.33, r * 0.6, r * 0.7, paint.glass),
    // Ogival delta approximated by two slabs: long strake + main delta.
    ...pair({ x: 0.2, y: -r * 0.3, root: 0.62, tip: 0.36, span: 0.06, sweep: 0.2, dihedral: 0, thick: 0.014 }, paint.wing),
    ...pair({ x: -0.0, y: -r * 0.3, z0: 0.06, root: 0.42, tip: 0.06, span: 0.15, sweep: 0.3, dihedral: -0.02, thick: 0.012 }, paint.wing),
    colorize(slab({ x: -0.2, y: r * 0.5, root: 0.3, tip: 0.08, span: 0.12, sweep: 0.2, dihedral: 0, thick: 0.008 }, 1, true), paint.livery),
  ]
  const exhausts: THREE.Vector3[] = []
  for (const side of [-1, 1]) {
    const g = new THREE.BoxGeometry(0.18, 0.018, 0.05)
    g.translate(-0.33, -r * 0.3 - 0.012, side * 0.085)
    parts.push(colorize(g, paint.engine))
    exhausts.push(new THREE.Vector3(-0.43, -r * 0.3 - 0.012, side * 0.085))
  }
  return { parts, props: [], exhausts, tailTop: new THREE.Vector3(-0.44, r * 0.5 + 0.12, 0), beacon: new THREE.Vector3(0.0, r + 0.003, 0) }
}

function experimental(paint: Paint): Built {
  // Blended wing body: a thick lifting centre section flowing into thin outer wings.
  const center = colorize(slab({ x: 0.5, y: 0, root: 1.0, tip: 0.42, span: 0.2, sweep: 0.36, dihedral: 0, thick: 0.1 }, 1), bodyPaint(paint, 0.03))
  const center2 = colorize(slab({ x: 0.5, y: 0, root: 1.0, tip: 0.42, span: 0.2, sweep: 0.36, dihedral: 0, thick: 0.1 }, -1), bodyPaint(paint, 0.03))
  const nose = colorize(fuselage([[0.5, 0.0005], [0.42, 0.05], [0.25, 0.08], [0.0, 0.085], [-0.3, 0.06], [-0.5, 0.01]], 12, 0, 0.55, 1.6), bodyPaint(paint, 0.01))
  const parts = [
    nose, center, center2,
    cockpit(0.36, 0.035, 0.03, paint.glass),
    ...pair({ x: 0.14, y: 0.0, z0: 0.2, root: 0.34, tip: 0.08, span: 0.34, sweep: 0.3, dihedral: 0.05, thick: 0.02 }, paint.wing),
  ]
  // Twin canted fins
  for (const side of [-1, 1]) {
    const fin = slab({ x: -0.28, y: 0.03, root: 0.18, tip: 0.08, span: 0.12, sweep: 0.1, dihedral: 0, thick: 0.01 }, 1, true)
    fin.rotateX(side * -0.35)
    fin.translate(0, 0, side * 0.13)
    parts.push(colorize(fin, paint.livery))
  }
  const exhausts: THREE.Vector3[] = []
  for (const z of [-0.07, 0, 0.07]) {
    parts.push(...nacelle(-0.1, 0.07, z, 0.16, 0.026, paint.engine, paint.body))
    exhausts.push(new THREE.Vector3(-0.26, 0.07, z))
  }
  return { parts, props: [], exhausts: [exhausts[0]!, exhausts[2]!], tailTop: new THREE.Vector3(-0.4, 0.15, 0), beacon: new THREE.Vector3(0.1, 0.05, 0) }
}

export function buildAircraft(cls: AircraftClass, lengthM: number, livery: string): AircraftModel {
  const liveryColor = new THREE.Color(livery)
  const paint: Paint = {
    livery: liveryColor,
    body: new THREE.Color(0.92, 0.92, 0.9),
    belly: new THREE.Color(0.62, 0.64, 0.66),
    wing: new THREE.Color(0.72, 0.74, 0.76),
    engine: new THREE.Color(0.32, 0.34, 0.37),
    glass: new THREE.Color(0.05, 0.07, 0.1),
    windows: new THREE.Color(0.32, 0.36, 0.42),
  }
  const built = ((): Built => {
    switch (cls) {
      case 'turboprop': return turboprop(paint)
      case 'regional': return regional(paint)
      case 'narrowbody': return airliner(paint, 0.057, 0.48, 2)
      case 'widebody': return airliner(paint, 0.05, 0.5, 2)
      case 'cargo': return cargo(paint)
      case 'supersonic': return supersonic(paint)
      case 'experimental': return experimental(paint)
    }
  })()
  const merged = mergeGeometries(built.parts, false)
  for (const p of built.parts) p.dispose()
  if (!merged) throw new Error(`aircraft geometry merge failed for ${cls}`)
  merged.scale(lengthM, lengthM, lengthM)
  merged.computeVertexNormals()
  merged.computeBoundingSphere()
  const s = (v: THREE.Vector3): THREE.Vector3 => v.clone().multiplyScalar(lengthM)
  // Wingtip = outermost vertex on the right side; nav lights sit there.
  const pos = merged.getAttribute('position')
  const tip = new THREE.Vector3(0, 0, -Infinity)
  for (let i = 0; i < pos.count; i++) if (pos.getZ(i) > tip.z) tip.fromBufferAttribute(pos, i)
  return {
    geometry: merged,
    props: built.props.map((p) => ({ pos: s(p.pos), radius: p.radius * lengthM })),
    exhausts: built.exhausts.map(s),
    navLeft: new THREE.Vector3(tip.x, tip.y, -tip.z),
    navRight: tip,
    navTail: s(built.tailTop),
    beacon: s(built.beacon),
    span: tip.z * 2,
  }
}
