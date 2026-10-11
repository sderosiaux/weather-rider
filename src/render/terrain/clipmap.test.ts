import { DataUtils } from 'three'
import { describe, expect, it } from 'vitest'
import { createFixtureTerrain } from '../../core/fixtures'
import { bakeBlock, BLOCK, cameraBlock, createLevel, isBaked, missingBlocks, validRect, type BlockTask, type Rect } from './clipmap'

const terrain = createFixtureTerrain(1)
const rect = (): Rect => ({ minX: 0, minZ: 0, maxX: -1, maxZ: -1 })

function bakeAll(level: ReturnType<typeof createLevel>, x: number, z: number): void {
  const tasks: BlockTask[] = []
  missingBlocks(level, 0, x, z, tasks)
  for (const t of tasks) bakeBlock(level, terrain, t.bx, t.bz)
}

/** Value the shader reads at world (x, z): toroidal texel = world texel mod size. */
function texelAt(level: ReturnType<typeof createLevel>, x: number, z: number): { h: number; t0: number[]; t1: number[] } {
  const i = ((Math.floor(x / level.texel) % level.size) + level.size) % level.size
  const j = ((Math.floor(z / level.texel) % level.size) + level.size) % level.size
  const o = (j * level.size + i) * 4
  return {
    h: DataUtils.fromHalfFloat(level.t0[o]!),
    t0: [1, 2, 3].map((k) => DataUtils.fromHalfFloat(level.t0[o + k]!)),
    t1: [0, 1, 2, 3].map((k) => level.t1[o + k]! / 255),
  }
}

describe('clipmap level', () => {
  it('stores each world texel where the shader samples it, whatever the wrap', () => {
    const level = createLevel({ texel: 100, size: 128 })
    for (const [cx, cz] of [[0, 0], [37_000, -21_000], [-55_500, 90_100]] as const) {
      bakeAll(level, cx, cz)
      for (const [dx, dz] of [[0, 0], [2_000, -3_100], [-3_150, 3_000], [3_150, 3_150]] as const) {
        const x = Math.floor((cx + dx) / 100) * 100 + 50
        const z = Math.floor((cz + dz) / 100) * 100 + 50
        const got = texelAt(level, x, z)
        const h = terrain.heightAt(x, z)
        expect(got.h).toBeCloseTo(h, h > 1024 ? -1 : 0)
        // Exactly one cover channel is set (or none for grass).
        const sum = [...got.t0, ...got.t1].reduce((a, b) => a + b, 0)
        expect(sum).toBe(terrain.coverAt(x, z) === 'grass' ? 0 : 1)
      }
    }
  })

  it('is valid only where baked, grows from the camera block, and never exceeds the window', () => {
    const level = createLevel({ texel: 50, size: 256 })
    const r = rect()
    expect(validRect(level, 1000, 1000, r).maxX).toBeLessThan(r.minX)
    bakeBlock(level, terrain, cameraBlock(level, 1000), cameraBlock(level, 1000))
    validRect(level, 1000, 1000, r)
    const span = 50 * BLOCK
    expect(r.minX).toBeCloseTo(cameraBlock(level, 1000) * span + 100)
    expect(r.maxX - r.minX).toBeCloseTo(span - 200)
    bakeAll(level, 1000, 1000)
    validRect(level, 1000, 1000, r)
    expect(r.maxX - r.minX).toBeCloseTo(256 * 50 - 200)
    // Window centred on the camera block: at least half a window minus one block on each side.
    expect(r.minX).toBeLessThanOrEqual(1000 - 4800)
    expect(r.maxX).toBeGreaterThanOrEqual(1000 + 4800)
  })

  it('re-bakes only the blocks entering the window when the camera moves, and the old rect never covers stale slots', () => {
    const level = createLevel({ texel: 50, size: 256 })
    bakeAll(level, 0, 0)
    const span = 50 * BLOCK
    const tasks: BlockTask[] = []
    missingBlocks(level, 0, span, 0, tasks)
    expect(tasks).toHaveLength(level.blocks)
    expect(new Set(tasks.map((t) => t.bx)).size).toBe(1)
    // Before baking them, the valid rect stops short of the new column.
    const r = validRect(level, span, 0, rect())
    expect(r.maxX).toBeLessThanOrEqual(tasks[0]!.bx * span)
    for (const t of tasks) bakeBlock(level, terrain, t.bx, t.bz)
    expect(tasks.every((t) => isBaked(level, t.bx, t.bz))).toBe(true)
    // The column that fell out of the window was overwritten in the same slots.
    expect(isBaked(level, tasks[0]!.bx - level.blocks, 0)).toBe(false)
  })

  it('orders missing blocks nearest first', () => {
    const level = createLevel({ texel: 50, size: 256 })
    const tasks: BlockTask[] = []
    missingBlocks(level, 0, 0, 0, tasks)
    tasks.sort((a, b) => a.ring - b.ring)
    expect(tasks[0]!.ring).toBe(0)
    expect(tasks[0]!.bx).toBe(0)
    expect(tasks.at(-1)!.ring).toBe(1)
  })
})
