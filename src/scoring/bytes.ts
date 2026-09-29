// Byte/bit-level helpers for the ghost codec: varints, Exp-Golomb, float64, UTF-8, base64url.
// Integer coders use arithmetic (not 32-bit bitwise ops) so values up to 2^53 survive.

const zigzag = (n: number): number => (n < 0 ? -2 * n - 1 : 2 * n)
const unzigzag = (u: number): number => (u % 2 === 0 ? u / 2 : -(u + 1) / 2)

export class ByteWriter {
  private buf = new Uint8Array(1024)
  private len = 0

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + n))
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
  }

  byte(b: number): void {
    this.ensure(1)
    this.buf[this.len++] = b
  }

  uvarint(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`ghost codec: cannot encode ${n} as uvarint`)
    let v = n
    while (v >= 0x80) {
      this.byte((v % 0x80) + 0x80)
      v = Math.floor(v / 0x80)
    }
    this.byte(v)
  }

  raw(b: Uint8Array): void {
    this.ensure(b.length)
    this.buf.set(b, this.len)
    this.len += b.length
  }

  f64(x: number): void {
    this.ensure(8)
    new DataView(this.buf.buffer).setFloat64(this.len, x, true)
    this.len += 8
  }

  str(s: string): void {
    const b = new TextEncoder().encode(s)
    this.uvarint(b.length)
    this.ensure(b.length)
    this.buf.set(b, this.len)
    this.len += b.length
  }

  bytes(): Uint8Array {
    return this.buf.slice(0, this.len)
  }
}

export class ByteReader {
  private pos = 0
  private readonly view: DataView

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  }

  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw new Error('ghost codec: truncated data')
  }

  byte(): number {
    this.need(1)
    return this.buf[this.pos++]!
  }

  uvarint(): number {
    let result = 0
    let mul = 1
    for (let i = 0; i < 8; i++) {
      const b = this.byte()
      result += (b & 0x7f) * mul
      if (b < 0x80) return result
      mul *= 0x80
    }
    throw new Error('ghost codec: varint too long')
  }

  /** Everything not read yet; the reader is then exhausted. */
  rest(): Uint8Array {
    const r = this.buf.subarray(this.pos)
    this.pos = this.buf.length
    return r
  }

  f64(): number {
    this.need(8)
    const x = this.view.getFloat64(this.pos, true)
    this.pos += 8
    return x
  }

  str(): string {
    const n = this.uvarint()
    this.need(n)
    const s = new TextDecoder('utf-8', { fatal: true }).decode(this.buf.subarray(this.pos, this.pos + n))
    this.pos += n
    return s
  }

  get remaining(): number {
    return this.buf.length - this.pos
  }
}

/**
 * Signed Exp-Golomb (order 0) over zigzag: 0 → 1 bit, ±1 → 3 bits, ±2..3 → 5 bits.
 * Fits second-order residuals of smooth tracks, which are almost always tiny.
 */
export class BitWriter {
  private readonly out: number[] = []
  private cur = 0
  private n = 0

  private bit(b: number): void {
    this.cur = (this.cur << 1) | b
    if (++this.n === 8) {
      this.out.push(this.cur)
      this.cur = 0
      this.n = 0
    }
  }

  sgolomb(v: number): void {
    const x = zigzag(v) + 1
    if (!Number.isSafeInteger(x)) throw new Error(`ghost codec: cannot encode ${v}`)
    const width = Math.floor(Math.log2(x)) + 1
    for (let i = 1; i < width; i++) this.bit(0)
    for (let i = width - 1; i >= 0; i--) this.bit(Math.floor(x / 2 ** i) % 2)
  }

  /** Flushes with zero padding. */
  bytes(): Uint8Array {
    const out = [...this.out]
    if (this.n > 0) out.push(this.cur << (8 - this.n))
    return Uint8Array.from(out)
  }
}

export class BitReader {
  private pos = 0

  constructor(private readonly buf: Uint8Array) {}

  private bit(): number {
    const byte = this.pos >> 3
    if (byte >= this.buf.length) throw new Error('ghost codec: truncated data')
    const b = (this.buf[byte]! >> (7 - (this.pos & 7))) & 1
    this.pos++
    return b
  }

  sgolomb(): number {
    let zeros = 0
    while (this.bit() === 0) {
      if (++zeros > 52) throw new Error('ghost codec: corrupt Exp-Golomb code')
    }
    let x = 1
    for (let i = 0; i < zeros; i++) x = x * 2 + this.bit()
    return unzigzag(x - 1)
  }

  /** Throws unless only zero padding is left. */
  end(): void {
    const used = Math.ceil(this.pos / 8)
    if (used !== this.buf.length) throw new Error('ghost codec: trailing data')
    const pad = this.pos & 7
    if (pad !== 0 && (this.buf[used - 1]! & ((1 << (8 - pad)) - 1)) !== 0) throw new Error('ghost codec: trailing data')
  }
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const LOOKUP = new Int16Array(128).fill(-1)
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i

/** RFC 4648 §5 base64url, no padding. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out += ALPHABET[n >> 18]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i]! << 16
    out += ALPHABET[n >> 18]! + ALPHABET[(n >> 12) & 63]!
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out += ALPHABET[n >> 18]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]!
  }
  return out
}

export function fromBase64Url(s: string): Uint8Array {
  if (s.length % 4 === 1) throw new Error('ghost codec: invalid base64url length')
  const out = new Uint8Array(Math.floor((s.length * 3) / 4))
  let acc = 0
  let bits = 0
  let o = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    const v = c < 128 ? LOOKUP[c]! : -1
    if (v < 0) throw new Error(`ghost codec: invalid base64url character at ${i}`)
    acc = ((acc << 6) | v) & 0xffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 0xff
    }
  }
  return out
}
