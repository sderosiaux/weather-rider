// Just enough PNG decoding (8-bit RGB/RGBA, non-interlaced: what Chrome screenshots are) to diff two frames.
import { inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const paeth = (a, b, c) => {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** @returns {{ width: number, height: number, channels: number, data: Buffer }} */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG')
  let width = 0
  let height = 0
  let header = null
  const idat = []
  for (let off = 8; off < buf.length; ) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('latin1', off + 4, off + 8)
    const body = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      header = { depth: body[8], color: body[9], interlace: body[12] }
    } else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (!header || header.depth !== 8 || header.interlace !== 0 || (header.color !== 2 && header.color !== 6))
    throw new Error(`unsupported PNG ${JSON.stringify(header)}`)
  const channels = header.color === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const data = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const row = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? data[row + x - channels] : 0
      const b = y > 0 ? data[row - stride + x] : 0
      const c = y > 0 && x >= channels ? data[row - stride + x - channels] : 0
      const pred = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth(a, b, c) : NaN
      if (Number.isNaN(pred)) throw new Error(`bad PNG filter ${filter}`)
      data[row + x] = (raw[src + x] + pred) & 0xff
    }
  }
  return { width, height, channels, data }
}

/** Share of pixels whose largest RGB channel difference exceeds `tolerance` (0..255). */
export function changedFraction(a, b, tolerance = 12) {
  if (a.width !== b.width || a.height !== b.height) return 1
  let changed = 0
  for (let i = 0, j = 0; i < a.data.length; i += a.channels, j += b.channels) {
    const d = Math.max(Math.abs(a.data[i] - b.data[j]), Math.abs(a.data[i + 1] - b.data[j + 1]), Math.abs(a.data[i + 2] - b.data[j + 2]))
    if (d > tolerance) changed++
  }
  return changed / (a.width * a.height)
}
