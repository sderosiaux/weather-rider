// Procedural textures baked once on the CPU. No external assets.
import * as THREE from 'three'
import { createRng } from '../core/rng'

/** Tileable value noise on a period×period lattice. */
function makeValueNoise(period: number, seed: number): (x: number, y: number) => number {
  const rng = createRng(seed)
  const lattice = new Float32Array(period * period)
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng()
  const at = (ix: number, iy: number): number => lattice[(((iy % period) + period) % period) * period + (((ix % period) + period) % period)]!
  return (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y)
    const fx = x - ix, fy = y - iy
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy)
    const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1)
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
  }
}

/** fbm in [0,1], tileable over the unit square. */
function makeFbm(seed: number, baseFreq: number, octaves: number): (u: number, v: number) => number {
  const layers = Array.from({ length: octaves }, (_, o) => makeValueNoise(baseFreq << o, seed + o * 7919))
  let norm = 0
  for (let o = 0; o < octaves; o++) norm += 0.5 ** o
  return (u, v) => {
    let s = 0
    for (let o = 0; o < octaves; o++) s += layers[o]!(u * (baseFreq << o), v * (baseFreq << o)) * 0.5 ** o
    return s / norm
  }
}

const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

export const ATLAS_TILES = 2 // 2×2 grid
const TILE = 256

/**
 * Cloud puff atlas, 2×2 tiles. R = density, G/B = pseudo-normal xy (0.5-centered), A = thickness.
 * Tiles: 0/1 billows, 2 flat-bottomed billow, 3 fibrous wisp (long axis = v).
 * Density is exactly 0 outside the inscribed circle so tiles can be rotated freely.
 */
export function createPuffAtlas(): THREE.DataTexture {
  const size = TILE * ATLAS_TILES
  const data = new Uint8Array(size * size * 4)
  const fbm = makeFbm(11, 4, 5)
  const wispFbm = makeFbm(23, 3, 5)
  for (let tile = 0; tile < 4; tile++) {
    const rng = createRng(101 + tile * 31)
    const blobs = Array.from({ length: 7 }, () => {
      const a = rng() * Math.PI * 2
      const r = Math.sqrt(rng()) * 0.38
      return { x: Math.cos(a) * r, y: Math.sin(a) * r * 0.8, r: 0.28 + rng() * 0.22 }
    })
    blobs.push({ x: 0, y: 0, r: 0.5 })
    const field = new Float32Array(TILE * TILE)
    const thick = new Float32Array(TILE * TILE)
    for (let j = 0; j < TILE; j++) {
      for (let i = 0; i < TILE; i++) {
        const px = ((i + 0.5) / TILE) * 2 - 1
        const py = ((j + 0.5) / TILE) * 2 - 1
        const rr = Math.hypot(px, py)
        const window = 1 - smooth(0.78, 0.98, rr)
        let d: number
        let t: number
        if (tile === 3) {
          // Fibrous: noise stretched along v, soft elliptical envelope.
          const n = wispFbm(((px + 1) / 2) * 0.3 + 0.3, (py + 1) / 2 * 1.0)
          const ragged = wispFbm(0.7, (py + 1) / 2) * 0.5
          // Ends fray with noise instead of closing into a capsule.
          const along = 1 - smooth(0.15 + ragged * 0.6, 0.97, Math.abs(py))
          const across = 1 - smooth(0.05, 0.9, Math.abs(px + (n - 0.5) * 0.35))
          const env = along * across
          d = smooth(0.3, 0.8, n * env + env * 0.2) * window
          t = env
        } else {
          // Smooth union of blobs: billows merge instead of showing seams.
          let acc = 0
          for (const b of blobs) {
            const q = 1 - Math.hypot(px - b.x, py - b.y) / b.r
            acc += Math.exp(q * 8)
          }
          let shape = Math.log(acc) / 8
          if (tile === 2) shape = Math.min(shape, (py + 0.42) * 3) // v grows upward: cut a flat base
          const n = fbm((px + 1) / 2 + tile * 0.37, (py + 1) / 2 + tile * 0.61)
          const eroded = shape - (1 - n) * 0.28
          d = smooth(-0.02, 0.45, eroded) * (0.8 + 0.2 * n) * window
          t = Math.max(0, shape) * window
        }
        field[j * TILE + i] = d
        thick[j * TILE + i] = t
      }
    }
    const ox = (tile % ATLAS_TILES) * TILE
    const oy = Math.floor(tile / ATLAS_TILES) * TILE
    for (let j = 0; j < TILE; j++) {
      for (let i = 0; i < TILE; i++) {
        const f = (x: number, y: number): number => {
          const k = Math.min(TILE - 1, Math.max(0, y)) * TILE + Math.min(TILE - 1, Math.max(0, x))
          return field[k]! * 0.6 + thick[k]! * 0.4
        }
        // Gradient of the noisy density: cauliflower detail under directional light.
        const gx = (f(i + 3, j) - f(i - 3, j)) * 3
        const gy = (f(i, j + 3) - f(i, j - 3)) * 3
        const o = ((oy + j) * size + ox + i) * 4
        data[o] = Math.round(field[j * TILE + i]! * 255)
        data[o + 1] = Math.round(Math.min(1, Math.max(0, 0.5 - gx)) * 255)
        data[o + 2] = Math.round(Math.min(1, Math.max(0, 0.5 - gy)) * 255)
        data[o + 3] = Math.round(Math.min(1, thick[j * TILE + i]!) * 255)
      }
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.colorSpace = THREE.NoColorSpace
  tex.needsUpdate = true
  return tex
}

/**
 * Tileable noise for sea waves and sky cirrus: R = fbm height, G/B = height gradient (0.5-centered), A = second fbm.
 */
export function createNoiseTexture(size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4)
  const h = makeFbm(7, 8, 4)
  const h2 = makeFbm(13, 4, 5)
  const height = new Float32Array(size * size)
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) height[j * size + i] = h(i / size, j / size)
  const at = (x: number, y: number): number => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)]!
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const o = (j * size + i) * 4
      data[o] = Math.round(at(i, j) * 255)
      data[o + 1] = Math.round(Math.min(1, Math.max(0, 0.5 + (at(i + 1, j) - at(i - 1, j)) * 8)) * 255)
      data[o + 2] = Math.round(Math.min(1, Math.max(0, 0.5 + (at(i, j + 1) - at(i, j - 1)) * 8)) * 255)
      data[o + 3] = Math.round(h2(i / size, j / size) * 255)
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.colorSpace = THREE.NoColorSpace
  tex.needsUpdate = true
  return tex
}

/** Soft round dot for point sprites (nav lights, glows). */
export function createGlowTexture(size = 64): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4)
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const r = Math.hypot((i + 0.5) / size - 0.5, (j + 0.5) / size - 0.5) * 2
      const core = Math.exp(-r * r * 18)
      const halo = Math.exp(-r * r * 3.5) * 0.35
      const a = Math.min(1, core + halo) * (1 - smooth(0.85, 1, r))
      const o = (j * size + i) * 4
      data[o] = data[o + 1] = data[o + 2] = 255
      data[o + 3] = Math.round(a * 255)
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  return tex
}
