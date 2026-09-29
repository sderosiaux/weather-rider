import { describe, expect, it } from 'vitest'
import { impulseResponse, pinkNoise } from './buffers'
import { CUES, cueDuration, type CueKind } from './cues'

const KINDS: CueKind[] = ['arrived', 'crashed', 'overstressed', 'unlock', 'record']
const peakSum = (k: CueKind): number => CUES[k].notes.reduce((s, n) => s + n.gain, 0) + (CUES[k].noise?.gain ?? 0)

describe('cues', () => {
  it('every cue is short, quiet enough to sit over the bed, and well-formed', () => {
    for (const k of KINDS) {
      const c = CUES[k]
      expect(c.notes.length, k).toBeGreaterThan(0)
      expect(cueDuration(c), k).toBeLessThan(12)
      expect(peakSum(k), k).toBeLessThan(0.5)
      for (const n of c.notes) {
        expect(n.hz).toBeGreaterThan(20)
        expect(n.attack).toBeGreaterThan(0) // no instant onsets → no clicks
        expect(Math.abs(n.pan)).toBeLessThanOrEqual(1)
      }
    }
  })
  it('arrived resolves onto a major triad', () => {
    const last = Math.max(...CUES.arrived.notes.map((n) => n.at))
    const final = CUES.arrived.notes.filter((n) => n.at >= 1)
    expect(final.length).toBeGreaterThanOrEqual(3)
    expect(last).toBeGreaterThan(0)
    const root = Math.min(...final.map((n) => n.hz))
    const classes = new Set(final.map((n) => Math.round(12 * Math.log2(n.hz / root)) % 12))
    expect(classes.has(4)).toBe(true) // major third
    expect(classes.has(7)).toBe(true) // fifth
  })
  it('failure cues are softer than the arrival, and fall rather than blare', () => {
    expect(peakSum('crashed')).toBeLessThanOrEqual(peakSum('arrived'))
    expect(peakSum('overstressed')).toBeLessThan(peakSum('crashed'))
    for (const n of CUES.crashed.notes) {
      expect(n.hz).toBeLessThan(400)
      if (n.glideTo) expect(n.glideTo).toBeLessThan(n.hz)
    }
  })
  it('sparkles ascend', () => {
    for (const k of ['unlock', 'record'] as const) {
      const sparkle = CUES[k].notes.filter((n) => n.attack < 0.01)
      for (let i = 1; i < sparkle.length; i++) expect(sparkle[i]!.hz).toBeGreaterThan(sparkle[i - 1]!.hz)
    }
  })
})

describe('buffers', () => {
  it('pink noise: bounded, zero-mean, deterministic, seamless loop', () => {
    const a = pinkNoise(48_000, 1)
    expect(a).toEqual(pinkNoise(48_000, 1))
    let mean = 0
    let peak = 0
    let maxStep = 0
    for (let i = 0; i < a.length; i++) {
      mean += a[i]!
      peak = Math.max(peak, Math.abs(a[i]!))
      if (i) maxStep = Math.max(maxStep, Math.abs(a[i]! - a[i - 1]!))
    }
    expect(Math.abs(mean / a.length)).toBeLessThan(1e-3)
    expect(peak).toBeCloseTo(0.9, 5)
    // The wrap-around step is no bigger than an ordinary sample-to-sample step.
    expect(Math.abs(a[0]! - a[a.length - 1]!)).toBeLessThanOrEqual(maxStep)
  })
  it('impulse response decays', () => {
    const sr = 8000
    const ir = impulseResponse(sr * 3, sr, 2.5, 7)
    const energy = (from: number, to: number) => ir.slice(from, to).reduce((s, x) => s + x * x, 0)
    expect(energy(0, sr / 2)).toBeGreaterThan(20 * energy(sr * 2, sr * 2.5))
    expect(ir.every(Number.isFinite)).toBe(true)
  })
})
