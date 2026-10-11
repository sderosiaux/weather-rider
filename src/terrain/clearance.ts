// Playability ceilings: the ground must stay well under the start, the gate window and the straight line between
// them. Mountains still cross the route, through passes; the dramatic peaks stand on the sides.
import type { TerrainParams } from '../core/types'

/** Below the start altitude within this radius. */
export const START_RADIUS = 15_000
export const START_CLEARANCE = 800
/** Below the gate window floor within this radius. */
export const GATE_RADIUS = 6_000
export const GATE_CLEARANCE = 500
/** Below min(startAlt, gateMinAlt + CORRIDOR_ALLOWANCE) − CORRIDOR_CLEARANCE within this half-width of the line. */
export const CORRIDOR_HALF_WIDTH = 4_000
export const CORRIDOR_ALLOWANCE = 1_000
export const CORRIDOR_CLEARANCE = 500
/** Hard ceiling of the whole land. */
export const MAX_GROUND = 2_790

/** Extra metres kept under every ceiling, and how far the flat ceiling extends past its zone before it relaxes. */
const MARGIN = 120
const BUFFER = 600
/** Ceiling rise per metre away from a zone: gentle, so the clamp never draws a visible terrace. */
const RELAX_SLOPE = 0.3
/** Soft-clamp knee (m): heights approach the ceiling asymptotically instead of being cut flat. */
export const KNEE = 160
export const GLOBAL_KNEE = 220

export interface Clearance {
  /** Highest ground allowed at (x, z) (already includes the safety margin). */
  capAt(x: number, z: number): number
}

export function createClearance(p: TerrainParams): Clearance {
  const sx = p.start.x
  const sz = p.start.z
  const gx = p.gate.x
  const gz = p.gate.z
  const startCap = p.startAlt - START_CLEARANCE - MARGIN
  const gateCap = p.gateMinAlt - GATE_CLEARANCE - MARGIN
  const lineCap = Math.min(p.startAlt, p.gateMinAlt + CORRIDOR_ALLOWANCE) - CORRIDOR_CLEARANCE - MARGIN
  const ldx = gx - sx
  const ldz = gz - sz
  const len2 = ldx * ldx + ldz * ldz
  const invLen2 = len2 > 0 ? 1 / len2 : 0
  const startEdge = START_RADIUS + BUFFER
  const gateEdge = GATE_RADIUS + BUFFER
  const lineEdge = CORRIDOR_HALF_WIDTH + BUFFER
  return {
    capAt(x, z) {
      let dx = x - sx
      let dz = z - sz
      let d = Math.sqrt(dx * dx + dz * dz)
      let cap = startCap + (d > startEdge ? (d - startEdge) * RELAX_SLOPE : 0)
      dx = x - gx
      dz = z - gz
      d = Math.sqrt(dx * dx + dz * dz)
      let c = gateCap + (d > gateEdge ? (d - gateEdge) * RELAX_SLOPE : 0)
      if (c < cap) cap = c
      let t = ((x - sx) * ldx + (z - sz) * ldz) * invLen2
      t = t < 0 ? 0 : t > 1 ? 1 : t
      dx = x - (sx + ldx * t)
      dz = z - (sz + ldz * t)
      d = Math.sqrt(dx * dx + dz * dz)
      c = lineCap + (d > lineEdge ? (d - lineEdge) * RELAX_SLOPE : 0)
      return c < cap ? c : cap
    },
  }
}

/** Smooth ceiling: identity well below `cap`, C¹, never reaches `cap`. */
export const softCap = (h: number, cap: number, knee: number): number => {
  const u = h - (cap - knee)
  return u > 0 ? cap - knee * Math.exp(-u / knee) : h
}
