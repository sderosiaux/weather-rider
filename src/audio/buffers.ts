// Procedural sample data (noise beds, reverb impulse). Pure: returns plain Float32Arrays.

/** Small deterministic LCG so buffers are reproducible (no Math.random: easier to test, same sound every run). */
function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32 * 2 - 1
  }
}

/** Pink (−3 dB/oct) noise, peak-normalized to ±0.9, zero-mean. Paul Kellet's refined filter. */
export function pinkNoise(length: number, seed: number): Float32Array {
  const rnd = lcg(seed)
  const n = Math.min(2048, length >> 3)
  const out = new Float32Array(length + n)
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
  for (let i = 0; i < out.length; i++) {
    const w = rnd()
    b0 = 0.99886 * b0 + w * 0.0555179
    b1 = 0.99332 * b1 + w * 0.0750759
    b2 = 0.969 * b2 + w * 0.153852
    b3 = 0.8665 * b3 + w * 0.3104856
    b4 = 0.55 * b4 + w * 0.5329522
    b5 = -0.7616 * b5 - w * 0.016898
    out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362
    b6 = w * 0.115926
  }
  const looped = loopCrossfade(out, n)
  normalize(looped)
  return looped
}

/** Exponentially decaying noise; reverb impulse for a big, soft sky. */
export function impulseResponse(length: number, sampleRate: number, decayS: number, seed: number): Float32Array {
  const rnd = lcg(seed)
  const out = new Float32Array(length)
  const fadeIn = Math.floor(sampleRate * 0.01)
  let lp = 0
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate
    // One-pole lowpass: the tail darkens as it decays, like air absorbing highs.
    const k = 0.25 + 0.7 * Math.exp(-t / (decayS * 0.5))
    lp += k * (rnd() - lp)
    const env = Math.exp((-6.9 * t) / decayS) * Math.min(1, i / Math.max(1, fadeIn))
    out[i] = lp * env
  }
  normalize(out, 0.5)
  return out
}

function normalize(buf: Float32Array, peak = 0.9): void {
  let mean = 0
  for (let i = 0; i < buf.length; i++) mean += buf[i]!
  mean /= buf.length || 1
  let max = 0
  for (let i = 0; i < buf.length; i++) {
    buf[i] = buf[i]! - mean
    max = Math.max(max, Math.abs(buf[i]!))
  }
  if (max === 0) return
  const g = peak / max
  for (let i = 0; i < buf.length; i++) buf[i] = buf[i]! * g
}

/**
 * Seamless loop: drop the last n samples and fade them into the head, so the sample after the
 * buffer end (index 0) continues exactly where the dropped tail would have gone.
 */
function loopCrossfade(buf: Float32Array, n: number): Float32Array {
  const out = buf.slice(0, buf.length - n)
  for (let i = 0; i < n; i++) {
    const a = (i + 0.5) / n
    out[i] = buf[buf.length - n + i]! * Math.cos((a * Math.PI) / 2) + buf[i]! * Math.sin((a * Math.PI) / 2)
  }
  return out
}
