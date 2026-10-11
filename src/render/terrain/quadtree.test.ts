import { describe, expect, it } from 'vitest'
import { LOD_RANGE, nodeMetric, PATCH_STRIDE, selectPatches, type LodConfig } from './quadtree'

const cfg: LodConfig = { leafSize: 768, levels: 10 }
const all = (): boolean => true

interface Patch { x: number; z: number; size: number; ms: number; me: number }
function select(camX: number, camZ: number, dy: number): Patch[] {
  const out = new Float32Array(20_000 * PATCH_STRIDE)
  const n = selectPatches(cfg, camX, camZ, dy, all, out)
  return Array.from({ length: n }, (_, i) => {
    const o = i * PATCH_STRIDE
    return { x: out[o]!, z: out[o + 1]!, size: out[o + 2]!, ms: out[o + 3]!, me: out[o + 4]! }
  })
}
const morphAt = (p: Patch, m: number): number => Math.min(1, Math.max(0, (m - p.ms) / (p.me - p.ms)))
const metric = (camX: number, camZ: number, dy: number, x: number, z: number): number => Math.hypot(x - camX, z - camZ, dy)

const CAMERAS: readonly [number, number, number][] = [
  [0, 0, 0],
  [12_345, -6_789, 0],
  [101_000, 3_000, 2_500],
  [-40_000, 77_000, 9_000],
  [383, 1_151, 400],
]

describe('selectPatches', () => {
  it('tiles the ground without gaps or overlaps (areas add up to the 3×3 top-level block)', () => {
    for (const [x, z, dy] of CAMERAS) {
      const patches = select(x, z, dy)
      const top = cfg.leafSize * 2 ** (cfg.levels - 1)
      const area = patches.reduce((a, p) => a + p.size * p.size, 0)
      expect(area).toBeCloseTo(9 * top * top, -3)
      for (const p of patches) {
        expect(p.x / p.size).toBe(Math.floor(p.x / p.size))
        expect(p.z / p.size).toBe(Math.floor(p.z / p.size))
      }
    }
  })

  it('is fine under the camera and coarse far away', () => {
    const patches = select(5000, 5000, 0)
    const under = patches.find((p) => 5000 >= p.x && 5000 < p.x + p.size && 5000 >= p.z && 5000 < p.z + p.size)!
    expect(under.size).toBe(cfg.leafSize)
    const far = patches.filter((p) => nodeMetric(5000, 5000, 0, p.x, p.z, p.size) > 200_000)
    expect(Math.min(...far.map((p) => p.size))).toBeGreaterThan(cfg.leafSize * 32)
  })

  it('never puts nodes more than one level apart side by side, and shared edges match after morphing', () => {
    for (const [cx, cz, dy] of CAMERAS) {
      const patches = select(cx, cz, dy)
      // Edge-adjacent pairs: walk each patch's right and bottom edge and find who is across.
      const find = (x: number, z: number): Patch | undefined => patches.find((p) => x >= p.x && x < p.x + p.size && z >= p.z && z < p.z + p.size)
      for (const p of patches) {
        for (let k = 0; k < 4; k++) {
          const along = p.size * (k + 0.5) / 4
          for (const [ex, ez] of [[p.x + p.size, p.z + along], [p.x + along, p.z + p.size]] as const) {
            const q = find(ex + 1e-3, ez + 1e-3)
            if (!q || q === p) continue
            const ratio = Math.max(p.size, q.size) / Math.min(p.size, q.size)
            expect(ratio).toBeLessThanOrEqual(2)
            if (ratio === 2) {
              const [fine, coarse] = p.size < q.size ? [p, q] : [q, p]
              const m = metric(cx, cz, dy, ex, ez)
              // The finer side has fully become the coarser grid; the coarser side has not started morphing.
              expect(morphAt(fine, m)).toBe(1)
              expect(morphAt(coarse, m)).toBe(0)
            }
          }
        }
      }
    }
  })

  it('morph ranges satisfy the crack-free inequalities', () => {
    expect(LOD_RANGE).toBeGreaterThan(2 * Math.SQRT2)
  })

  it('respects the visibility test and the output capacity', () => {
    const out = new Float32Array(10 * PATCH_STRIDE)
    expect(selectPatches(cfg, 0, 0, 0, all, out)).toBe(10)
    expect(selectPatches(cfg, 0, 0, 0, () => false, out)).toBe(0)
  })
})
