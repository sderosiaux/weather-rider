// Ground data baked on the CPU into camera-centred, toroidally addressed textures (a texture clipmap).
// Terrain is an analytic function, not an asset: sampling it is the cost, so each level keeps a window of
// blocks around the camera and only bakes the blocks that enter it. The shader samples a level with
// RepeatWrapping at uv = world / (texel × size), which is exactly where bakeBlock() wrote it.
//
// Channel layout (shared with shader.ts):
//   t0 (RGBA half): ground height (m), water, beach, city
//   t1 (RGBA u8):   fields, forest, rock, snow — grass is whatever weight is left (1 − Σ)
// Per texel: the share of each class over its sub-samples (one-hot when coverSamples = 1). Filtering
// turns those into smooth blend weights.
import { DataUtils } from 'three'
import type { Terrain, TerrainCover } from '../../core/types'

/** Texels per block side. Every level size is a multiple of it. */
export const BLOCK = 32
const NONE = -0x7fffffff
/** Scratch: share per channel index + 1 (index 0 = grass). */
const shares = new Float64Array(9)

export interface LevelSpec {
  /** Meters per texel. */
  readonly texel: number
  /** Texels per side. */
  readonly size: number
  /**
   * Cover samples per texel side (1 or 2). With 2, each texel stores the coverage of each class over a
   * 2×2 sub-grid: borders land between texels instead of snapping to them. Costs 4 coverAt per texel.
   */
  readonly coverSamples?: number
}

export interface ClipLevel extends LevelSpec {
  /** Blocks per side. */
  readonly blocks: number
  readonly t0: Uint16Array
  readonly t1: Uint8Array
  /** World block coordinates held by each toroidal slot (NONE = empty). */
  readonly slotX: Int32Array
  readonly slotZ: Int32Array
}

/** World-space rectangle (m). Empty when minX ≥ maxX. */
export interface Rect {
  minX: number
  minZ: number
  maxX: number
  maxZ: number
}

export interface BlockTask {
  readonly level: number
  readonly bx: number
  readonly bz: number
  /** Priority: Chebyshev ring around the camera block, relative to the level's half window (0 = under the camera). */
  readonly ring: number
}

export function createLevel(spec: LevelSpec): ClipLevel {
  if (spec.size % BLOCK !== 0 || (spec.size / BLOCK) % 2 !== 0) throw new Error(`level size ${spec.size} must be an even number of ${BLOCK}-texel blocks`)
  const blocks = spec.size / BLOCK
  const level: ClipLevel = {
    ...spec,
    blocks,
    t0: new Uint16Array(spec.size * spec.size * 4),
    t1: new Uint8Array(spec.size * spec.size * 4),
    slotX: new Int32Array(blocks * blocks),
    slotZ: new Int32Array(blocks * blocks),
  }
  resetLevel(level)
  return level
}

export function resetLevel(level: ClipLevel): void {
  level.slotX.fill(NONE)
  level.slotZ.fill(NONE)
}

const mod = (a: number, n: number): number => ((a % n) + n) % n
const blockSpan = (level: ClipLevel): number => level.texel * BLOCK
export const cameraBlock = (level: ClipLevel, x: number): number => Math.floor(x / blockSpan(level))
const slotOf = (level: ClipLevel, bx: number, bz: number): number => mod(bz, level.blocks) * level.blocks + mod(bx, level.blocks)

export function isBaked(level: ClipLevel, bx: number, bz: number): boolean {
  const s = slotOf(level, bx, bz)
  return level.slotX[s] === bx && level.slotZ[s] === bz
}

/** Blocks of the window centred on the camera block: [c − blocks/2, c + blocks/2). */
const inWindow = (level: ClipLevel, b: number, c: number): boolean => b >= c - level.blocks / 2 && b < c + level.blocks / 2

/** Blocks of the camera window that still need baking, nearest first. */
export function missingBlocks(level: ClipLevel, levelIndex: number, camX: number, camZ: number, out: BlockTask[]): void {
  const cx = cameraBlock(level, camX)
  const cz = cameraBlock(level, camZ)
  const half = level.blocks / 2
  for (let bz = cz - half; bz < cz + half; bz++) {
    for (let bx = cx - half; bx < cx + half; bx++) {
      if (isBaked(level, bx, bz)) continue
      out.push({ level: levelIndex, bx, bz, ring: Math.max(Math.abs(bx - cx), Math.abs(bz - cz)) / half })
    }
  }
}

/** Per-cover channel: 0..3 → t0.gba (water, beach, city), 4..7 → t1.rgba; −1 = grass (implicit). */
const CHANNEL: Readonly<Record<TerrainCover, number>> = {
  sea: 1,
  lake: 1,
  river: 1,
  beach: 2,
  city: 3,
  fields: 4,
  forest: 5,
  rock: 6,
  snow: 7,
  grass: -1,
}

/**
 * Samples the terrain at the texel centres of world block (bx, bz) into the block's toroidal slot.
 * Returns the slot's texel origin (sx, sz) so the caller can upload just those rows, and the block's highest ground.
 */
export function bakeBlock(level: ClipLevel, terrain: Terrain, bx: number, bz: number): { sx: number; sz: number; maxHeight: number } {
  const { texel, size, t0, t1 } = level
  const n = level.coverSamples ?? 1
  const inv = 1 / (n * n)
  const sx = mod(bx, level.blocks) * BLOCK
  const sz = mod(bz, level.blocks) * BLOCK
  let maxHeight = -Infinity
  for (let j = 0; j < BLOCK; j++) {
    const z = ((bz * BLOCK + j) + 0.5) * texel
    let o = ((sz + j) * size + sx) * 4
    for (let i = 0; i < BLOCK; i++, o += 4) {
      const x = ((bx * BLOCK + i) + 0.5) * texel
      const h = terrain.heightAt(x, z)
      if (h > maxHeight) maxHeight = h
      t0[o] = DataUtils.toHalfFloat(h)
      shares.fill(0)
      if (n === 1) {
        shares[CHANNEL[terrain.coverAt(x, z)] + 1]! += 1
      } else {
        for (let sj = 0; sj < n; sj++) {
          for (let si = 0; si < n; si++) {
            shares[CHANNEL[terrain.coverAt(x + ((si + 0.5) / n - 0.5) * texel, z + ((sj + 0.5) / n - 0.5) * texel)] + 1]! += inv
          }
        }
      }
      // shares[0] is grass (implicit), 2..4 → t0.gba, 5..8 → t1.rgba.
      t0[o + 1] = shares[2] ? DataUtils.toHalfFloat(shares[2]) : 0
      t0[o + 2] = shares[3] ? DataUtils.toHalfFloat(shares[3]) : 0
      t0[o + 3] = shares[4] ? DataUtils.toHalfFloat(shares[4]) : 0
      for (let k = 0; k < 4; k++) t1[o + k] = Math.round(shares[5 + k]! * 255)
    }
  }
  const s = slotOf(level, bx, bz)
  level.slotX[s] = bx
  level.slotZ[s] = bz
  return { sx, sz, maxHeight }
}

/**
 * The rectangle the shader may sample: grown greedily from the camera block over baked blocks of the
 * window, minus a 2-texel margin (bilinear taps and the normal's central differences reach 1.5 texels).
 */
export function validRect(level: ClipLevel, camX: number, camZ: number, out: Rect): Rect {
  const cx = cameraBlock(level, camX)
  const cz = cameraBlock(level, camZ)
  out.minX = out.minZ = 0
  out.maxX = out.maxZ = -1
  if (!isBaked(level, cx, cz)) return out
  let x0 = cx, x1 = cx, z0 = cz, z1 = cz
  const column = (bx: number): boolean => {
    if (!inWindow(level, bx, cx)) return false
    for (let bz = z0; bz <= z1; bz++) if (!isBaked(level, bx, bz)) return false
    return true
  }
  const row = (bz: number): boolean => {
    if (!inWindow(level, bz, cz)) return false
    for (let bx = x0; bx <= x1; bx++) if (!isBaked(level, bx, bz)) return false
    return true
  }
  for (let grew = true; grew; ) {
    grew = false
    if (column(x1 + 1)) { x1++; grew = true }
    if (column(x0 - 1)) { x0--; grew = true }
    if (row(z1 + 1)) { z1++; grew = true }
    if (row(z0 - 1)) { z0--; grew = true }
  }
  const span = blockSpan(level)
  const margin = level.texel * 2
  out.minX = x0 * span + margin
  out.minZ = z0 * span + margin
  out.maxX = (x1 + 1) * span - margin
  out.maxZ = (z1 + 1) * span - margin
  return out
}
