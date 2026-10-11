// CDLOD patch selection (Strugar 2009): one instanced grid patch, many square nodes of a quadtree laid
// on a fixed world lattice. Each node is drawn at its own level and its vertices morph towards the next
// coarser grid as they near the level's range, so neighbours meet without cracks or popping.
//
// Crack-freeness rests on two inequalities, both checked by quadtree.test.ts:
//  - a node next to a coarser one is fully morphed on the shared edge (metric ≥ range of its level);
//  - a node next to a finer one is not morphed at all on the shared edge (metric ≤ its morph start).
// With range = LOD_RANGE × node size, both hold when LOD_RANGE > 2√2 and the morph starts at
// (LOD_RANGE / 2 + √2) × size. The vertex shader must use the exact same metric as nodeMetric().

/** Quads per patch side. Even, so morphing odd vertices onto even ones lands on the coarser grid. */
export const PATCH_GRID = 32
export const LOD_RANGE = 4
export const MORPH_START = LOD_RANGE / 2 + Math.SQRT2
/** Floats per emitted patch: x, z, size, morph start, morph end. */
export const PATCH_STRIDE = 5
/** Morph range of the top level: never morphs (nothing coarser to meet). */
const NEVER = 1e12

export interface LodConfig {
  /** Side (m) of a level-0 node. Vertex spacing near the camera = leafSize / PATCH_GRID. */
  readonly leafSize: number
  /** Number of levels; the top level's nodes tile a 3×3 block around the camera. */
  readonly levels: number
}

/** Is the node's box (with the terrain's height range) worth drawing? Frustum test in production. */
export type NodeVisible = (minX: number, minZ: number, size: number) => boolean

/**
 * Distance used for LOD: horizontal distance to the node's square, combined with the camera height above
 * the highest ground (dy). A lower bound of the true 3D distance to any vertex of the node.
 */
export function nodeMetric(camX: number, camZ: number, dy: number, minX: number, minZ: number, size: number): number {
  const dx = Math.max(minX - camX, 0, camX - minX - size)
  const dz = Math.max(minZ - camZ, 0, camZ - minZ - size)
  return Math.sqrt(dx * dx + dz * dz + dy * dy)
}

export const levelSize = (cfg: LodConfig, level: number): number => cfg.leafSize * 2 ** level
export const morphStart = (cfg: LodConfig, level: number): number => (level >= cfg.levels - 1 ? NEVER : MORPH_START * levelSize(cfg, level))
export const morphEnd = (cfg: LodConfig, level: number): number => (level >= cfg.levels - 1 ? 2 * NEVER : LOD_RANGE * levelSize(cfg, level))

/**
 * Writes the selected patches into `out` (PATCH_STRIDE floats each) and returns how many were written.
 * Allocation-free; stops silently when `out` is full.
 */
export function selectPatches(cfg: LodConfig, camX: number, camZ: number, dy: number, visible: NodeVisible, out: Float32Array): number {
  const capacity = Math.floor(out.length / PATCH_STRIDE)
  let count = 0
  const visit = (x: number, z: number, level: number): void => {
    if (count >= capacity) return
    const size = levelSize(cfg, level)
    if (!visible(x, z, size)) return
    if (level === 0 || nodeMetric(camX, camZ, dy, x, z, size) > LOD_RANGE * levelSize(cfg, level - 1)) {
      const o = count * PATCH_STRIDE
      out[o] = x
      out[o + 1] = z
      out[o + 2] = size
      out[o + 3] = morphStart(cfg, level)
      out[o + 4] = morphEnd(cfg, level)
      count++
      return
    }
    const h = size / 2
    visit(x, z, level - 1)
    visit(x + h, z, level - 1)
    visit(x, z + h, level - 1)
    visit(x + h, z + h, level - 1)
  }
  const top = cfg.levels - 1
  const s = levelSize(cfg, top)
  const cx = Math.floor(camX / s)
  const cz = Math.floor(camZ / s)
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) visit((cx + i) * s, (cz + j) * s, top)
  return count
}
